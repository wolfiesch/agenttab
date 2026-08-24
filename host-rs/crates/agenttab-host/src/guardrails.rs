use agenttab_protocol::{
    BrowserAction, BrowserOpenParams, MethodParams, NativeOriginPolicy, RpcError, RpcMethod,
};
use regex::{Regex, RegexBuilder};
use serde::Deserialize;
use serde_json::Value;
use std::fs::{self, File, OpenOptions};
use std::io::{self, Read};
use std::path::{Path, PathBuf};
use thiserror::Error;
use url::Url;
use uuid::Uuid;

const MAX_POLICY_BYTES: u64 = 1024 * 1024;
const DEFAULT_DLP_MAX_FILE_BYTES: u64 = 10 * 1024 * 1024;

#[derive(Debug, Error)]
pub enum GuardrailLoadError {
    #[error("I/O error while loading policy: {0}")]
    Io(#[from] std::io::Error),
    #[error("policy file exceeds 1 MiB")]
    Oversize,
    #[error("invalid AgentTab policy: {0}")]
    InvalidPolicy(#[from] serde_json::Error),
    #[error("invalid redaction pattern {pattern:?}: {source}")]
    InvalidPattern {
        pattern: String,
        source: regex::Error,
    },
}

#[derive(Debug, Clone, Deserialize)]
#[serde(default, deny_unknown_fields)]
struct Policy {
    developer_enabled: bool,
    audit_enabled: bool,
    denied_origins: Vec<String>,
    allowed_origins: Vec<String>,
    dlp_allowed_roots: Vec<PathBuf>,
    dlp_max_file_bytes: u64,
    redact_patterns: Vec<String>,
}

impl Default for Policy {
    fn default() -> Self {
        Self {
            developer_enabled: false,
            audit_enabled: true,
            denied_origins: Vec::new(),
            allowed_origins: Vec::new(),
            dlp_allowed_roots: Vec::new(),
            dlp_max_file_bytes: DEFAULT_DLP_MAX_FILE_BYTES,
            redact_patterns: Vec::new(),
        }
    }
}

#[derive(Debug)]
pub struct Guardrails {
    policy: Policy,
    redaction_patterns: Vec<Regex>,
}

impl Guardrails {
    pub fn load(path: &Path) -> Result<Self, GuardrailLoadError> {
        let policy = match fs::metadata(path) {
            Ok(metadata) => {
                if metadata.len() > MAX_POLICY_BYTES {
                    return Err(GuardrailLoadError::Oversize);
                }
                serde_json::from_slice(&fs::read(path)?)?
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Policy::default(),
            Err(error) => return Err(error.into()),
        };
        Self::from_policy(policy)
    }

    #[cfg(test)]
    fn defaults() -> Self {
        Self::from_policy(Policy::default()).unwrap()
    }

    fn from_policy(policy: Policy) -> Result<Self, GuardrailLoadError> {
        let mut patterns = vec![
            r"(?i)\bbearer\s+[a-z0-9._~+/=-]{8,}\b".to_string(),
            r"\b\d{3}-\d{2}-\d{4}\b".to_string(),
            r"\b(?:\d[ -]*?){13,19}\b".to_string(),
        ];
        patterns.extend(policy.redact_patterns.iter().cloned());
        let redaction_patterns = patterns
            .into_iter()
            .map(|pattern| {
                RegexBuilder::new(&pattern)
                    .size_limit(1024 * 1024)
                    .build()
                    .map_err(|source| GuardrailLoadError::InvalidPattern { pattern, source })
            })
            .collect::<Result<Vec<_>, _>>()?;
        Ok(Self {
            policy,
            redaction_patterns,
        })
    }

    pub fn audit_enabled(&self) -> bool {
        self.policy.audit_enabled
    }

    pub fn authorize(&self, method: RpcMethod, params: &MethodParams) -> Result<(), RpcError> {
        if method == RpcMethod::BrowserDeveloper && !self.policy.developer_enabled {
            return Err(RpcError::new(
                "developer_mode_disabled",
                "browser_developer is disabled by AgentTab policy",
            )
            .with_recovery("Enable Developer mode in AgentTab's managed local policy."));
        }

        match params {
            MethodParams::Open(BrowserOpenParams::Create { url: Some(url), .. }) => {
                self.authorize_url(url)?;
            }
            MethodParams::Open(BrowserOpenParams::AdoptActive) if self.has_origin_constraints() => {
                return Err(RpcError::new(
                    "adopt_origin_unverified",
                    "AgentTab cannot adopt an active tab while origin policy is restricted",
                )
                .with_recovery(
                    "Open the URL through browser_open create, or remove the managed origin restriction.",
                ));
            }
            MethodParams::Act(params) => {
                for action in &params.actions {
                    match action {
                        BrowserAction::Navigate { url } => self.authorize_url(url)?,
                        BrowserAction::UploadFile { files, .. } => {
                            for file in files {
                                self.authorize_file(Path::new(file))?;
                            }
                        }
                        _ => {}
                    }
                }
            }
            _ => {}
        }
        Ok(())
    }
    pub fn authorize_current_tab(&self, tab_url: Option<&str>) -> Result<(), RpcError> {
        if !self.has_origin_constraints() {
            return Ok(());
        }
        let tab_url = tab_url.ok_or_else(|| {
            RpcError::new(
                "tab_origin_unverified",
                "AgentTab has no verified current origin for this tab",
            )
            .with_recovery("Wait for reconciliation and retry the operation.")
        })?;
        self.authorize_url(tab_url)
    }

    pub fn native_origin_policy(&self, tab_id: u64) -> Option<NativeOriginPolicy> {
        self.has_origin_constraints().then(|| NativeOriginPolicy {
            tab_id,
            allowed_origins: self.policy.allowed_origins.clone(),
            denied_origins: self.policy.denied_origins.clone(),
        })
    }

    fn has_origin_constraints(&self) -> bool {
        !self.policy.denied_origins.is_empty() || !self.policy.allowed_origins.is_empty()
    }

    pub fn redact(&self, value: &mut Value) {
        match value {
            Value::Object(object) => {
                for (key, child) in object {
                    if sensitive_key(key) {
                        *child = Value::String("[REDACTED]".into());
                    } else {
                        self.redact(child);
                    }
                }
            }
            Value::Array(array) => {
                for child in array {
                    self.redact(child);
                }
            }
            Value::String(text) => {
                let mut redacted = text.clone();
                for pattern in &self.redaction_patterns {
                    redacted = pattern.replace_all(&redacted, "[REDACTED]").into_owned();
                }
                *text = redacted;
            }
            _ => {}
        }
    }
    pub fn redact_error(&self, error: RpcError) -> RpcError {
        let code = error.code.clone();
        let mut value = match serde_json::to_value(error) {
            Ok(value) => value,
            Err(_) => return RpcError::new(code, "AgentTab redacted an invalid native error"),
        };
        self.redact(&mut value);
        match serde_json::from_value::<RpcError>(value) {
            Ok(mut redacted) => {
                redacted.code = code;
                redacted
            }
            Err(_) => RpcError::new(code, "AgentTab redacted an invalid native error"),
        }
    }

    fn authorize_url(&self, raw: &str) -> Result<(), RpcError> {
        let parsed = Url::parse(raw).map_err(|_| {
            RpcError::new("invalid_url", "URL is not valid")
                .with_recovery("Use an absolute http://, https://, or about: URL.")
        })?;
        if !matches!(parsed.scheme(), "http" | "https" | "about") {
            return Err(RpcError::new(
                "scheme_denied",
                format!(
                    "AgentTab Standard mode does not allow {} URLs",
                    parsed.scheme()
                ),
            ));
        }
        if parsed.scheme() == "about" {
            return Ok(());
        }
        let origin = parsed.origin().ascii_serialization();
        if self
            .policy
            .denied_origins
            .iter()
            .any(|pattern| origin_matches(pattern, &parsed, &origin))
        {
            return Err(RpcError::new(
                "origin_denied",
                format!("AgentTab policy denies {origin}"),
            ));
        }
        if !self.policy.allowed_origins.is_empty()
            && !self
                .policy
                .allowed_origins
                .iter()
                .any(|pattern| origin_matches(pattern, &parsed, &origin))
        {
            return Err(RpcError::new(
                "origin_not_allowed",
                format!("AgentTab policy does not allow {origin}"),
            ));
        }
        Ok(())
    }

    pub(crate) fn stage_uploads(
        &self,
        params: &MethodParams,
        params_value: &mut Value,
        staging_directory: &Path,
    ) -> Result<Vec<PathBuf>, RpcError> {
        let MethodParams::Act(action_params) = params else {
            return Ok(Vec::new());
        };
        let action_values = params_value
            .get_mut("actions")
            .and_then(Value::as_array_mut)
            .ok_or_else(|| {
                RpcError::new("invalid_request", "Upload actions were not serializable")
            })?;
        let mut staged_paths = Vec::new();
        let result = (|| {
            for (action, action_value) in action_params.actions.iter().zip(action_values.iter_mut())
            {
                let BrowserAction::UploadFile { files, .. } = action else {
                    continue;
                };
                let staged_values = action_value
                    .get_mut("files")
                    .and_then(Value::as_array_mut)
                    .ok_or_else(|| {
                        RpcError::new("invalid_request", "Upload files were not serializable")
                    })?;
                if staged_values.len() != files.len() {
                    return Err(RpcError::new(
                        "invalid_request",
                        "Upload file count changed during serialization",
                    ));
                }
                for (source, staged_value) in files.iter().zip(staged_values.iter_mut()) {
                    let staged_path = self.stage_file(Path::new(source), staging_directory)?;
                    *staged_value = Value::String(staged_path.display().to_string());
                    staged_paths.push(staged_path);
                }
            }
            Ok(())
        })();
        match result {
            Ok(()) => Ok(staged_paths),
            Err(error) => match Self::cleanup_staged_uploads(&staged_paths) {
                Ok(()) => Err(error),
                Err(cleanup_error) => Err(cleanup_error),
            },
        }
    }

    pub(crate) fn cleanup_staged_uploads(paths: &[PathBuf]) -> Result<(), RpcError> {
        let mut first_error = None;
        for path in paths {
            match fs::remove_file(path) {
                Ok(()) => {}
                Err(error) if error.kind() == io::ErrorKind::NotFound => {}
                Err(error) if first_error.is_none() => first_error = Some(error),
                Err(_) => {}
            }
        }
        match first_error {
            None => Ok(()),
            Some(error) => Err(RpcError::new(
                "upload_staging_cleanup_failed",
                format!("Cannot remove every AgentTab upload staging file: {error}"),
            )
            .with_recovery(
                "Remove the private AgentTab upload staging directory before retrying.",
            )),
        }
    }

    fn authorize_file(&self, path: &Path) -> Result<(), RpcError> {
        self.open_authorized_file(path).map(|_| ())
    }

    fn stage_file(&self, path: &Path, staging_directory: &Path) -> Result<PathBuf, RpcError> {
        let mut source = self.open_authorized_file(path)?;
        let staging_directory = staging_directory.canonicalize().map_err(|error| {
            RpcError::new(
                "upload_file_unavailable",
                format!("Cannot resolve private upload staging directory: {error}"),
            )
        })?;
        let staged_path = staging_directory.join(format!("{}.upload", Uuid::new_v4()));
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut staged = options.open(&staged_path).map_err(|error| {
            RpcError::new(
                "upload_file_unavailable",
                format!("Cannot create private upload staging file: {error}"),
            )
        })?;
        let copied = io::copy(
            &mut source
                .by_ref()
                .take(self.policy.dlp_max_file_bytes.saturating_add(1)),
            &mut staged,
        )
        .map_err(|error| {
            let _ = fs::remove_file(&staged_path);
            RpcError::new(
                "upload_file_unavailable",
                format!("Cannot stage upload file: {error}"),
            )
        })?;
        if copied > self.policy.dlp_max_file_bytes {
            let _ = fs::remove_file(&staged_path);
            return Err(RpcError::new(
                "upload_file_too_large",
                format!(
                    "Upload file exceeds policy limit of {} bytes",
                    self.policy.dlp_max_file_bytes
                ),
            ));
        }
        staged.sync_all().map_err(|error| {
            let _ = fs::remove_file(&staged_path);
            RpcError::new(
                "upload_file_unavailable",
                format!("Cannot finalize staged upload file: {error}"),
            )
        })?;
        Ok(staged_path)
    }

    fn open_authorized_file(&self, path: &Path) -> Result<File, RpcError> {
        let canonical = path.canonicalize().map_err(|error| {
            RpcError::new(
                "upload_file_unavailable",
                format!("Cannot resolve upload file: {error}"),
            )
        })?;
        let allowed = self.policy.dlp_allowed_roots.iter().any(|root| {
            root.canonicalize()
                .map(|allowed_root| canonical.starts_with(allowed_root))
                .unwrap_or(false)
        });
        if !allowed {
            return Err(RpcError::new(
                "upload_file_not_allowed",
                "Upload file is outside AgentTab policy dlp_allowed_roots",
            )
            .with_recovery("Add a narrow user-owned directory to dlp_allowed_roots."));
        }
        let mut options = OpenOptions::new();
        options.read(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.custom_flags(libc::O_NOFOLLOW);
        }
        let file = options.open(&canonical).map_err(|error| {
            RpcError::new(
                "upload_file_unavailable",
                format!("Cannot open upload file: {error}"),
            )
        })?;
        let metadata = file.metadata().map_err(|error| {
            RpcError::new(
                "upload_file_unavailable",
                format!("Cannot inspect upload file: {error}"),
            )
        })?;
        if !metadata.is_file() {
            return Err(RpcError::new(
                "upload_file_invalid",
                "Upload target must be a regular file",
            ));
        }
        if metadata.len() > self.policy.dlp_max_file_bytes {
            return Err(RpcError::new(
                "upload_file_too_large",
                format!(
                    "Upload file is {} bytes; policy limit is {} bytes",
                    metadata.len(),
                    self.policy.dlp_max_file_bytes
                ),
            ));
        }
        Ok(file)
    }
}

fn origin_matches(pattern: &str, url: &Url, origin: &str) -> bool {
    if pattern == origin {
        return true;
    }
    let Some(suffix) = pattern.strip_prefix("*.") else {
        return false;
    };
    let Some(host) = url.host_str() else {
        return false;
    };
    host != suffix && host.ends_with(&format!(".{suffix}"))
}

fn sensitive_key(key: &str) -> bool {
    let key = key.to_ascii_lowercase();
    [
        "authorization",
        "cookie",
        "password",
        "secret",
        "access_token",
        "refresh_token",
        "native_token",
    ]
    .iter()
    .any(|needle| key == *needle || key.ends_with(&format!("_{needle}")))
}

#[cfg(test)]
mod tests {
    use super::*;
    use agenttab_protocol::{BrowserDeveloperParams, BrowserOpenParams};
    use serde_json::{json, Map};

    #[test]
    fn developer_mode_and_unconfigured_uploads_fail_closed() {
        let guardrails = Guardrails::defaults();
        let developer = MethodParams::Developer(BrowserDeveloperParams {
            action: "raw_cdp".into(),
            params: Map::new(),
        });
        assert_eq!(
            guardrails
                .authorize(RpcMethod::BrowserDeveloper, &developer)
                .unwrap_err()
                .code,
            "developer_mode_disabled"
        );

        let upload = MethodParams::Act(agenttab_protocol::BrowserActParams {
            tab_id: 1,
            expected_page_revision: 2,
            actions: vec![BrowserAction::UploadFile {
                r#ref: "e1".into(),
                files: vec![std::env::current_exe().unwrap().display().to_string()],
            }],
        });
        assert_eq!(
            guardrails
                .authorize(RpcMethod::BrowserAct, &upload)
                .unwrap_err()
                .code,
            "upload_file_not_allowed"
        );
    }

    #[test]
    fn origins_and_redaction_are_enforced() {
        let guardrails = Guardrails::from_policy(Policy {
            denied_origins: vec!["*.example.com".into()],
            ..Policy::default()
        })
        .unwrap();
        let adopt = MethodParams::Open(BrowserOpenParams::AdoptActive);
        assert_eq!(
            guardrails
                .authorize(RpcMethod::BrowserOpen, &adopt)
                .unwrap_err()
                .code,
            "adopt_origin_unverified"
        );
        assert_eq!(
            guardrails.authorize_current_tab(None).unwrap_err().code,
            "tab_origin_unverified"
        );
        assert_eq!(
            guardrails
                .authorize_current_tab(Some("https://private.example.com/path"))
                .unwrap_err()
                .code,
            "origin_denied"
        );
        let open = MethodParams::Open(BrowserOpenParams::Create {
            url: Some("https://private.example.com/path".into()),
            background: true,
        });
        assert_eq!(
            guardrails
                .authorize(RpcMethod::BrowserOpen, &open)
                .unwrap_err()
                .code,
            "origin_denied"
        );

        let mut value = json!({
            "body": "SSN 123-45-6789 and Bearer abcdefghijklmnop",
            "cookie": "private",
            "safe": "visible"
        });
        guardrails.redact(&mut value);
        assert_eq!(value["cookie"], "[REDACTED]");
        assert!(!value["body"].as_str().unwrap().contains("123-45-6789"));
        assert_eq!(value["safe"], "visible");

        let mut error = RpcError::new(
            "native_failure",
            "SSN 123-45-6789 and Bearer abcdefghijklmnop",
        )
        .with_recovery("Never retry with Bearer abcdefghijklmnop");
        error.details = json!({"password": "private", "safe": "visible"})
            .as_object()
            .cloned();
        let error = guardrails.redact_error(error);
        assert_eq!(error.code, "native_failure");
        assert!(!error.message.contains("123-45-6789"));
        assert!(!error.recovery.unwrap().contains("abcdefghijklmnop"));
        assert_eq!(error.details.unwrap()["password"], "[REDACTED]");
    }
    #[cfg(unix)]
    #[test]
    fn upload_staging_binds_authorized_bytes_across_replacement_and_symlink_races() {
        use std::os::unix::fs::symlink;

        let temp = tempfile::tempdir().unwrap();
        let allowed_root = temp.path().join("allowed");
        let staging_directory = temp.path().join("staging");
        fs::create_dir(&allowed_root).unwrap();
        fs::create_dir(&staging_directory).unwrap();
        let original = allowed_root.join("original.txt");
        let replacement = allowed_root.join("replacement.txt");
        let link = allowed_root.join("upload.txt");
        fs::write(&original, b"authorized bytes").unwrap();
        fs::write(&replacement, b"replacement bytes").unwrap();
        symlink(&original, &link).unwrap();
        let guardrails = Guardrails::from_policy(Policy {
            dlp_allowed_roots: vec![allowed_root],
            dlp_max_file_bytes: 1024,
            ..Policy::default()
        })
        .unwrap();
        let params = MethodParams::Act(agenttab_protocol::BrowserActParams {
            tab_id: 7,
            expected_page_revision: 1,
            actions: vec![BrowserAction::UploadFile {
                r#ref: "e1".into(),
                files: vec![link.display().to_string()],
            }],
        });
        let mut serialized = params.value();
        let staged = guardrails
            .stage_uploads(&params, &mut serialized, &staging_directory)
            .unwrap();
        let staged_path = serialized["actions"][0]["files"][0]
            .as_str()
            .unwrap()
            .to_owned();
        assert_ne!(staged_path, link.display().to_string());
        fs::write(&original, b"replaced in place").unwrap();
        fs::remove_file(&link).unwrap();
        symlink(&replacement, &link).unwrap();
        assert_eq!(fs::read(&staged_path).unwrap(), b"authorized bytes");
        Guardrails::cleanup_staged_uploads(&staged).unwrap();
        assert!(!std::path::Path::new(&staged_path).exists());
    }
}
