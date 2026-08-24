use agenttab_protocol::{Outcome, RpcError, RpcMethod};
use parking_lot::Mutex;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::BTreeSet;
use std::fs::{self, File, OpenOptions};
use std::io::{self, Write};
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};
use url::Url;
use uuid::Uuid;

#[derive(Debug)]
pub struct AuditLog {
    file: Option<Mutex<File>>,
}

#[derive(Debug)]
pub struct AuditEntry<'a> {
    pub connection_id: Uuid,
    pub task_id: Option<Uuid>,
    pub started_at_ms: u128,
    pub request_id: &'a str,
    pub method: RpcMethod,
    pub params: &'a Value,
    pub outcome: Outcome,
    pub result: Option<&'a Value>,
    pub error: Option<&'a RpcError>,
    pub duration_ms: u128,
    pub replayed: bool,
}

impl AuditLog {
    pub fn open(path: &Path, enabled: bool) -> io::Result<Self> {
        if !enabled {
            return Ok(Self { file: None });
        }
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }
        let file = OpenOptions::new().create(true).append(true).open(path)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(path, fs::Permissions::from_mode(0o600))?;
        }
        Ok(Self {
            file: Some(Mutex::new(file)),
        })
    }

    pub fn record(&self, entry: AuditEntry<'_>) -> io::Result<()> {
        let Some(file) = &self.file else {
            return Ok(());
        };
        let completed_at_ms = now_ms();
        let record = json!({
            "schema_version": 1,
            "started_at_ms": entry.started_at_ms,
            "completed_at_ms": completed_at_ms,
            "connection_id": entry.connection_id,
            "task_id": entry.task_id,
            "request_id": entry.request_id,
            "method": entry.method,
            "outcome": entry.outcome,
            "duration_ms": entry.duration_ms,
            "replayed": entry.replayed,
            "target_origins": target_origins(entry.params),
            "argument_summary": summarize(entry.params),
            "argument_digest": digest(entry.params),
            "result_summary": entry.result.map(summarize),
            "error_code": entry.error.map(|error| error.code.as_str()),
            "recovery": entry.error.and_then(|error| error.recovery.as_deref()),
        });
        let mut line = serde_json::to_vec(&record)?;
        line.push(b'\n');
        let mut file = file.lock();
        file.write_all(&line)?;
        file.sync_data()?;
        Ok(())
    }
}

fn summarize(value: &Value) -> Value {
    match value {
        Value::Null => json!({"type": "null"}),
        Value::Bool(_) => json!({"type": "boolean"}),
        Value::Number(_) => json!({"type": "number"}),
        Value::String(text) => json!({"type": "string", "characters": text.chars().count()}),
        Value::Array(values) => json!({
            "type": "array",
            "items": values.len(),
            "item_types": values.iter().map(type_name).collect::<Vec<_>>()
        }),
        Value::Object(object) => json!({
            "type": "object",
            "keys": object.keys().collect::<Vec<_>>(),
        }),
    }
}

fn type_name(value: &Value) -> &'static str {
    match value {
        Value::Null => "null",
        Value::Bool(_) => "boolean",
        Value::Number(_) => "number",
        Value::String(_) => "string",
        Value::Array(_) => "array",
        Value::Object(_) => "object",
    }
}

fn digest(value: &Value) -> String {
    let encoded = serde_json::to_vec(&canonicalize(value)).expect("JSON value serializes");
    format!("{:x}", Sha256::digest(encoded))
}
fn target_origins(value: &Value) -> Vec<String> {
    fn collect(value: &Value, origins: &mut BTreeSet<String>) {
        match value {
            Value::Object(object) => {
                for (key, value) in object {
                    if key == "url" {
                        if let Some(raw) = value.as_str() {
                            if let Ok(url) = Url::parse(raw) {
                                let origin = if url.scheme() == "about" {
                                    "about:".to_string()
                                } else {
                                    url.origin().ascii_serialization()
                                };
                                origins.insert(origin);
                            }
                        }
                    } else {
                        collect(value, origins);
                    }
                }
            }
            Value::Array(values) => {
                for value in values {
                    collect(value, origins);
                }
            }
            _ => {}
        }
    }

    let mut origins = BTreeSet::new();
    collect(value, &mut origins);
    origins.into_iter().collect()
}

pub fn canonicalize(value: &Value) -> Value {
    match value {
        Value::Object(object) => {
            let mut keys = object.keys().collect::<Vec<_>>();
            keys.sort_unstable();
            let mut canonical = serde_json::Map::new();
            for key in keys {
                canonical.insert(key.clone(), canonicalize(&object[key]));
            }
            Value::Object(canonical)
        }
        Value::Array(array) => Value::Array(array.iter().map(canonicalize).collect()),
        _ => value.clone(),
    }
}

pub(crate) fn now_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("system clock is before Unix epoch")
        .as_millis()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn audit_contains_metadata_and_never_argument_values() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("audit.jsonl");
        let audit = AuditLog::open(&path, true).unwrap();
        let params = json!({
            "password": "never-log-me",
            "actions": [{"kind": "navigate", "url": "https://example.com/private"}]
        });
        audit
            .record(AuditEntry {
                connection_id: Uuid::new_v4(),
                task_id: Some(Uuid::now_v7()),
                started_at_ms: now_ms(),
                request_id: "request-1",
                method: RpcMethod::BrowserAct,
                params: &params,
                outcome: Outcome::Completed,
                result: Some(&json!({"text": "also-private"})),
                error: None,
                duration_ms: 4,
                replayed: false,
            })
            .unwrap();
        let written = fs::read_to_string(path).unwrap();
        assert!(!written.contains("never-log-me"));
        assert!(!written.contains("/private"));
        assert!(!written.contains("also-private"));
        assert!(written.contains("argument_digest"));
        assert!(written.contains("browser_act"));
        assert!(written.contains("https://example.com"));
        assert!(written.contains("started_at_ms"));
    }

    #[test]
    fn canonical_digest_ignores_object_insertion_order() {
        assert_eq!(
            digest(&json!({"a": 1, "b": 2})),
            digest(&json!({"b": 2, "a": 1}))
        );
    }
}
