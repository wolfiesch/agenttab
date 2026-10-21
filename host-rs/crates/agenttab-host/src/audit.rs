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
        let mut record = json!({
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
        if let Some(challenge) = challenge_summary(&entry) {
            record["challenge"] = challenge;
        }
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

/// Builds the explicit `challenge` audit member from a Core result or error details.
///
/// Only catalog constants, enums, integers, and an origin are copied, each validated
/// against the event schema shape. Any malformed or partial event omits the whole
/// member so audit writing and the request itself never fail on it.
fn challenge_summary(entry: &AuditEntry<'_>) -> Option<Value> {
    let event = entry
        .result
        .and_then(|result| result.get("challenge"))
        .or_else(|| {
            entry
                .error
                .and_then(|error| error.details.as_ref())
                .and_then(|details| details.get("challenge"))
        })?
        .as_object()?;
    let challenge_id = event.get("challenge_id")?.as_str()?;
    let id_tail = challenge_id.strip_prefix("chl_")?;
    if id_tail.len() != 20
        || !id_tail
            .bytes()
            .all(|byte| byte.is_ascii_digit() || byte.is_ascii_lowercase())
    {
        return None;
    }
    let vendor = catalog_identifier(event.get("vendor")?, 32)?;
    let product = catalog_identifier(event.get("product")?, 48)?;
    let kind = enum_value(
        event.get("kind")?,
        &["interstitial", "widget", "puzzle", "block", "rate_limit"],
    )?;
    let interaction = enum_value(event.get("interaction")?, &["automatic", "human", "none"])?;
    let state = enum_value(event.get("state")?, &["active", "cleared", "superseded"])?;
    let confidence = enum_value(event.get("confidence")?, &["high", "medium", "low"])?;
    let page_origin = http_origin(event.get("page_origin")?)?;
    let first_detected_at_ms = event.get("first_detected_at_ms")?.as_u64()?;
    let detected_at_ms = event.get("detected_at_ms")?.as_u64()?;
    let elapsed_ms = detected_at_ms.checked_sub(first_detected_at_ms)?;
    let mut summary = json!({
        "challenge_id": challenge_id,
        "vendor": vendor,
        "product": product,
        "kind": kind,
        "interaction": interaction,
        "state": state,
        "confidence": confidence,
        "page_origin": page_origin,
        "elapsed_ms": elapsed_ms,
    });
    if state != "active" {
        summary["resolved_by"] = json!(resolved_by(entry, state));
    }
    Some(summary)
}

fn resolved_by(entry: &AuditEntry<'_>, state: &str) -> &'static str {
    let wait_kind = entry
        .params
        .get("condition")
        .and_then(|condition| condition.get("kind"))
        .and_then(Value::as_str);
    let operation = entry.params.get("operation").and_then(Value::as_str);
    if entry.method == RpcMethod::BrowserWait && wait_kind == Some("challenge_cleared") {
        "wait"
    } else if entry.method == RpcMethod::BrowserHandoff && operation == Some("resolve") {
        "handoff"
    } else if state == "superseded" {
        "navigation"
    } else {
        "observed"
    }
}

fn catalog_identifier(value: &Value, max_len: usize) -> Option<&str> {
    let text = value.as_str()?;
    let mut bytes = text.bytes();
    let valid = text.len() <= max_len
        && bytes.next().is_some_and(|byte| byte.is_ascii_lowercase())
        && bytes.all(|byte| byte.is_ascii_digit() || byte.is_ascii_lowercase() || byte == b'_');
    valid.then_some(text)
}

fn enum_value<'a>(value: &'a Value, allowed: &[&str]) -> Option<&'a str> {
    let text = value.as_str()?;
    allowed.contains(&text).then_some(text)
}

/// Accepts only a canonical `http` or `https` origin: no path, query, fragment, or userinfo.
fn http_origin(value: &Value) -> Option<&str> {
    let text = value.as_str()?;
    let url = Url::parse(text).ok()?;
    let canonical = matches!(url.scheme(), "http" | "https")
        && url.origin().ascii_serialization() == text
        && text.len() <= 2048;
    canonical.then_some(text)
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

    fn challenge_event(state: &str) -> Value {
        json!({
            "spec_version": 1,
            "challenge_id": "chl_3k9w2m7q8x1v5b0n4c6z",
            "tab_id": 77,
            "page_revision": 9,
            "first_page_revision": 8,
            "first_detected_at_ms": 1_000,
            "detected_at_ms": 5_100,
            "page_origin": "https://shop.example",
            "vendor": "cloudflare",
            "product": "challenge_page",
            "kind": "interstitial",
            "interaction": "automatic",
            "state": state,
            "confidence": "high",
            "surface": {"scope": "document", "visible": true, "frame_id": "frame-leak-1"},
            "token_present": true,
            "signals": ["cloudflare.signal_leak_1"],
            "next": if state == "active" { "wait" } else { "none" },
            "wait_budget_ms": 20_000,
            "notice_id": "notice-leak-1",
            "detector": {"catalog_version": "2026.10.1", "probe": "debugger"}
        })
    }

    fn audit_line(
        method: RpcMethod,
        params: Value,
        outcome: Outcome,
        result: Option<Value>,
        error: Option<RpcError>,
    ) -> (String, Value) {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("audit.jsonl");
        let audit = AuditLog::open(&path, true).unwrap();
        audit
            .record(AuditEntry {
                connection_id: Uuid::new_v4(),
                task_id: Some(Uuid::now_v7()),
                started_at_ms: now_ms(),
                request_id: "request-challenge",
                method,
                params: &params,
                outcome,
                result: result.as_ref(),
                error: error.as_ref(),
                duration_ms: 1,
                replayed: false,
            })
            .unwrap();
        let written = fs::read_to_string(path).unwrap();
        let parsed = serde_json::from_str(written.trim_end()).unwrap();
        (written, parsed)
    }

    fn snapshot_line(event: Value) -> (String, Value) {
        audit_line(
            RpcMethod::BrowserSnapshot,
            json!({"tab_id": 77}),
            Outcome::Completed,
            Some(json!({"challenge": event})),
            None,
        )
    }

    #[test]
    fn audit_records_active_challenge_without_resolved_by() {
        let (_, line) = snapshot_line(challenge_event("active"));
        assert_eq!(
            line["challenge"],
            json!({
                "challenge_id": "chl_3k9w2m7q8x1v5b0n4c6z",
                "vendor": "cloudflare",
                "product": "challenge_page",
                "kind": "interstitial",
                "interaction": "automatic",
                "state": "active",
                "confidence": "high",
                "page_origin": "https://shop.example",
                "elapsed_ms": 4_100,
            })
        );
    }

    #[test]
    fn audit_challenge_resolved_by_follows_observing_operation() {
        let wait = audit_line(
            RpcMethod::BrowserWait,
            json!({
                "tab_id": 77,
                "condition": {"kind": "challenge_cleared", "challenge_id": "chl_3k9w2m7q8x1v5b0n4c6z"}
            }),
            Outcome::Completed,
            Some(json!({"challenge": challenge_event("cleared")})),
            None,
        );
        assert_eq!(wait.1["challenge"]["resolved_by"], "wait");

        let handoff = audit_line(
            RpcMethod::BrowserHandoff,
            json!({"operation": "resolve", "notice_id": "notice-leak-1"}),
            Outcome::Completed,
            Some(json!({"challenge": challenge_event("cleared")})),
            None,
        );
        assert_eq!(handoff.1["challenge"]["resolved_by"], "handoff");

        let navigation = snapshot_line(challenge_event("superseded"));
        assert_eq!(navigation.1["challenge"]["resolved_by"], "navigation");
        assert_eq!(navigation.1["challenge"]["state"], "superseded");

        let observed = snapshot_line(challenge_event("cleared"));
        assert_eq!(observed.1["challenge"]["resolved_by"], "observed");

        let other_wait = audit_line(
            RpcMethod::BrowserWait,
            json!({"tab_id": 77, "condition": {"kind": "load"}}),
            Outcome::Completed,
            Some(json!({"challenge": challenge_event("cleared")})),
            None,
        );
        assert_eq!(other_wait.1["challenge"]["resolved_by"], "observed");
    }

    #[test]
    fn audit_records_challenge_from_error_details() {
        let mut error = RpcError::new("wait_timeout", "condition not met");
        let mut details = serde_json::Map::new();
        details.insert("challenge".to_string(), challenge_event("active"));
        error.details = Some(details);
        let (_, line) = audit_line(
            RpcMethod::BrowserWait,
            json!({
                "tab_id": 77,
                "condition": {"kind": "challenge_cleared", "challenge_id": "chl_3k9w2m7q8x1v5b0n4c6z"}
            }),
            Outcome::NotStarted,
            None,
            Some(error),
        );
        assert_eq!(line["error_code"], "wait_timeout");
        assert_eq!(line["challenge"]["state"], "active");
        assert_eq!(line["challenge"]["elapsed_ms"], 4_100);
        assert!(line["challenge"].get("resolved_by").is_none());
    }

    #[test]
    fn audit_omits_malformed_challenge_events() {
        let mut cases = Vec::new();
        for (key, bad) in [
            ("challenge_id", json!("chl_SHORT")),
            ("challenge_id", json!(42)),
            ("vendor", json!("Cloud Flare")),
            ("product", json!("x".repeat(49))),
            ("kind", json!("invented")),
            ("interaction", json!(null)),
            ("state", json!("done")),
            ("confidence", json!(["high"])),
            ("page_origin", json!("https://shop.example/path?q=secret")),
            ("page_origin", json!("javascript:alert(1)")),
            ("detected_at_ms", json!("5100")),
            ("detected_at_ms", json!(-1)),
            ("first_detected_at_ms", json!(1.5)),
            ("detected_at_ms", json!(500)),
        ] {
            let mut event = challenge_event("active");
            event[key] = bad;
            cases.push(event);
        }
        for key in [
            "challenge_id",
            "vendor",
            "product",
            "kind",
            "interaction",
            "state",
            "confidence",
            "page_origin",
            "first_detected_at_ms",
            "detected_at_ms",
        ] {
            let mut event = challenge_event("active");
            event.as_object_mut().unwrap().remove(key);
            cases.push(event);
        }
        cases.push(json!("not an object"));
        cases.push(json!(null));
        for event in cases {
            let (written, line) = snapshot_line(event.clone());
            assert!(line.get("challenge").is_none(), "recorded: {event}");
            assert!(!written.contains("secret"));
        }
    }

    #[test]
    fn audit_challenge_records_no_other_event_field() {
        let (written, line) = snapshot_line(challenge_event("cleared"));
        let mut keys = line["challenge"]
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect::<Vec<_>>();
        keys.sort_unstable();
        assert_eq!(
            keys,
            [
                "challenge_id",
                "confidence",
                "elapsed_ms",
                "interaction",
                "kind",
                "page_origin",
                "product",
                "resolved_by",
                "state",
                "vendor",
            ]
        );
        for leaked_value in [
            "frame-leak-1",
            "signal_leak_1",
            "notice-leak-1",
            "2026.10.1",
        ] {
            assert!(
                !written.contains(leaked_value),
                "audit line leaked {leaked_value}"
            );
        }
        let challenge_json = line["challenge"].to_string();
        for leaked_field in [
            "token_present",
            "signals",
            "surface",
            "tab_id",
            "notice_id",
            "detector",
        ] {
            assert!(
                !challenge_json.contains(leaked_field),
                "challenge member carries {leaked_field}"
            );
        }
    }

    #[test]
    fn canonical_digest_ignores_object_insertion_order() {
        assert_eq!(
            digest(&json!({"a": 1, "b": 2})),
            digest(&json!({"b": 2, "a": 1}))
        );
    }
}
