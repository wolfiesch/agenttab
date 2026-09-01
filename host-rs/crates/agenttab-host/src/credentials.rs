use crate::guardrails::OnePasswordPolicy;
use parking_lot::Mutex;
use rand::RngCore;
use serde_json::Value;
use std::collections::HashMap;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use url::Url;
use uuid::Uuid;

const ATTEMPT_TTL: Duration = Duration::from_secs(5 * 60);
const MAX_PROVIDER_OUTPUT_BYTES: usize = 8 * 1024 * 1024;
const MAX_PROVIDER_ERROR_BYTES: usize = 32 * 1024;

#[derive(Debug, Clone)]
struct Candidate {
    id: String,
    title: String,
    urls: Vec<String>,
}

#[derive(Debug)]
struct Attempt {
    task_id: Uuid,
    tab_id: u64,
    host: String,
    candidates: Vec<Candidate>,
    current: usize,
    used: usize,
    current_started: bool,
    expires_at: Instant,
}

#[derive(Clone)]
pub struct CredentialMaterial {
    pub username: Option<String>,
    pub password: Option<String>,
    pub otp: Option<String>,
}

impl std::fmt::Debug for CredentialMaterial {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("CredentialMaterial")
            .field("has_username", &self.username.is_some())
            .field("has_password", &self.password.is_some())
            .field("has_otp", &self.otp.is_some())
            .finish()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NeedsUserReason {
    NoMatch,
    Ambiguous,
    Exhausted,
    ProviderTimeout,
    ProviderUnavailable,
    UnsupportedCredential,
}

impl NeedsUserReason {
    pub fn status(self) -> &'static str {
        match self {
            Self::NoMatch => "no_match",
            Self::Ambiguous => "ambiguous",
            Self::Exhausted => "attempts_exhausted",
            Self::ProviderTimeout => "provider_timeout",
            Self::ProviderUnavailable => "provider_unavailable",
            Self::UnsupportedCredential => "unsupported_credential",
        }
    }

    pub fn recovery(self) -> &'static str {
        match self {
            Self::NoMatch => "Sign in manually or save a matching Login item in 1Password.",
            Self::Ambiguous => "Choose the intended 1Password item manually; AgentTab will not guess among more than three matches.",
            Self::Exhausted => "Sign in manually or remove stale matching Login items before retrying.",
            Self::ProviderTimeout => "Approve the 1Password biometric prompt, then prepare credentials again.",
            Self::ProviderUnavailable => "Unlock 1Password, verify its CLI app integration, and verify one_password.executable is available to the native host before retrying.",
            Self::UnsupportedCredential => "Use the site's passkey or security-key flow with 1Password, or sign in manually.",
        }
    }
}

#[derive(Debug)]
pub enum PrepareResult {
    Ready {
        credential_token: String,
        candidate_count: usize,
        expires_at_ms: u128,
    },
    NeedsUser {
        reason: NeedsUserReason,
        candidate_count: usize,
    },
}

#[derive(Debug)]
pub enum SelectResult {
    Ready {
        material: CredentialMaterial,
        attempt_number: usize,
        remaining_attempts: usize,
    },
    NeedsUser {
        reason: NeedsUserReason,
    },
}

#[derive(Debug, thiserror::Error)]
pub enum BrokerError {
    #[error("credential token is invalid or expired")]
    InvalidToken,
    #[error("credential token is bound to another task, tab, or origin")]
    BindingMismatch,
    #[error("the next credential can only be selected after the current one was tried")]
    NextBeforeFill,
}

trait CredentialProvider: Send + Sync {
    fn candidates(&self, host: &str) -> Result<Vec<Candidate>, ProviderError>;
    fn material(
        &self,
        candidate: &Candidate,
        host: &str,
        include_otp: bool,
    ) -> Result<CredentialMaterial, ProviderError>;
}

#[derive(Debug, Clone, Copy)]
enum ProviderError {
    Timeout,
    Unavailable,
}

pub struct CredentialBroker {
    policy: OnePasswordPolicy,
    provider: Arc<dyn CredentialProvider>,
    attempts: Mutex<HashMap<String, Attempt>>,
}

impl std::fmt::Debug for CredentialBroker {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("CredentialBroker")
            .field("enabled", &self.policy.enabled)
            .field("attempt_count", &self.attempts.lock().len())
            .finish()
    }
}

impl CredentialBroker {
    pub fn new(policy: OnePasswordPolicy) -> Self {
        let provider = Arc::new(OnePasswordProvider::new(policy.clone()));
        Self {
            policy,
            provider,
            attempts: Mutex::new(HashMap::new()),
        }
    }

    #[cfg(test)]
    fn with_provider(policy: OnePasswordPolicy, provider: Arc<dyn CredentialProvider>) -> Self {
        Self {
            policy,
            provider,
            attempts: Mutex::new(HashMap::new()),
        }
    }

    pub fn prepare(&self, task_id: Uuid, tab_id: u64, host: &str) -> PrepareResult {
        self.prune_expired();
        let candidates = match self.provider.candidates(host) {
            Ok(candidates) => candidates,
            Err(ProviderError::Timeout) => {
                return PrepareResult::NeedsUser {
                    reason: NeedsUserReason::ProviderTimeout,
                    candidate_count: 0,
                }
            }
            Err(ProviderError::Unavailable) => {
                return PrepareResult::NeedsUser {
                    reason: NeedsUserReason::ProviderUnavailable,
                    candidate_count: 0,
                }
            }
        };
        let candidate_count = candidates.len();
        if candidate_count == 0 {
            return PrepareResult::NeedsUser {
                reason: NeedsUserReason::NoMatch,
                candidate_count,
            };
        }
        if candidate_count > self.policy.max_candidates {
            return PrepareResult::NeedsUser {
                reason: NeedsUserReason::Ambiguous,
                candidate_count,
            };
        }

        let credential_token = random_token();
        let expires_at_ms = now_ms() + ATTEMPT_TTL.as_millis();
        self.attempts.lock().insert(
            credential_token.clone(),
            Attempt {
                task_id,
                tab_id,
                host: host.to_string(),
                candidates,
                current: 0,
                used: 0,
                current_started: false,
                expires_at: Instant::now() + ATTEMPT_TTL,
            },
        );
        PrepareResult::Ready {
            credential_token,
            candidate_count,
            expires_at_ms,
        }
    }

    #[allow(clippy::too_many_arguments)]
    pub fn select(
        &self,
        credential_token: &str,
        task_id: Uuid,
        tab_id: u64,
        host: &str,
        next: bool,
        include_otp: bool,
    ) -> Result<SelectResult, BrokerError> {
        self.prune_expired();
        let (candidate, attempt_number, remaining_attempts) = {
            let mut attempts = self.attempts.lock();
            let attempt = attempts
                .get_mut(credential_token)
                .ok_or(BrokerError::InvalidToken)?;
            if attempt.task_id != task_id || attempt.tab_id != tab_id || attempt.host != host {
                return Err(BrokerError::BindingMismatch);
            }
            if next {
                if !attempt.current_started {
                    return Err(BrokerError::NextBeforeFill);
                }
                attempt.current += 1;
                attempt.current_started = false;
            }
            if attempt.current >= attempt.candidates.len()
                || attempt.used >= self.policy.max_attempts
            {
                return Ok(SelectResult::NeedsUser {
                    reason: NeedsUserReason::Exhausted,
                });
            }
            if !attempt.current_started {
                attempt.current_started = true;
                attempt.used += 1;
            }
            (
                attempt.candidates[attempt.current].clone(),
                attempt.used,
                self.policy.max_attempts.saturating_sub(attempt.used),
            )
        };

        let material = match self.provider.material(&candidate, host, include_otp) {
            Ok(material) => material,
            Err(ProviderError::Timeout) => {
                return Ok(SelectResult::NeedsUser {
                    reason: NeedsUserReason::ProviderTimeout,
                })
            }
            Err(ProviderError::Unavailable) => {
                return Ok(SelectResult::NeedsUser {
                    reason: NeedsUserReason::ProviderUnavailable,
                })
            }
        };
        if material.username.is_none() && material.password.is_none() && material.otp.is_none() {
            return Ok(SelectResult::NeedsUser {
                reason: NeedsUserReason::UnsupportedCredential,
            });
        }
        Ok(SelectResult::Ready {
            material,
            attempt_number,
            remaining_attempts,
        })
    }

    fn prune_expired(&self) {
        self.attempts
            .lock()
            .retain(|_, attempt| attempt.expires_at > Instant::now());
    }
}

#[derive(Debug)]
struct OnePasswordProvider {
    executable: PathBuf,
    account: Option<String>,
    timeout: Duration,
}

impl OnePasswordProvider {
    fn new(policy: OnePasswordPolicy) -> Self {
        Self {
            executable: policy.executable.unwrap_or_else(|| PathBuf::from("op")),
            account: policy.account,
            timeout: Duration::from_millis(policy.auth_timeout_ms),
        }
    }

    fn run_json(&self, arguments: &[&str]) -> Result<Value, ProviderError> {
        let mut owned = arguments
            .iter()
            .map(|value| value.to_string())
            .collect::<Vec<_>>();
        if let Some(account) = &self.account {
            owned.push("--account".into());
            owned.push(account.clone());
        }
        let output = run_op(&self.executable, &owned, self.timeout)?;
        serde_json::from_slice(&output).map_err(|_| ProviderError::Unavailable)
    }

    fn run_text(&self, arguments: &[&str]) -> Result<String, ProviderError> {
        let mut owned = arguments
            .iter()
            .map(|value| value.to_string())
            .collect::<Vec<_>>();
        if let Some(account) = &self.account {
            owned.push("--account".into());
            owned.push(account.clone());
        }
        let output = run_op(&self.executable, &owned, self.timeout)?;
        String::from_utf8(output)
            .map(|value| value.trim().to_string())
            .map_err(|_| ProviderError::Unavailable)
    }
}

impl CredentialProvider for OnePasswordProvider {
    fn candidates(&self, host: &str) -> Result<Vec<Candidate>, ProviderError> {
        let value = self.run_json(&[
            "item",
            "list",
            "--categories",
            "Login",
            "--long",
            "--format",
            "json",
        ])?;
        let items = value.as_array().ok_or(ProviderError::Unavailable)?;
        let mut candidates = items
            .iter()
            .filter_map(parse_candidate)
            .filter(|candidate| candidate_matches_host(candidate, host))
            .collect::<Vec<_>>();
        candidates.sort_by(|left, right| left.title.cmp(&right.title).then(left.id.cmp(&right.id)));
        candidates.dedup_by(|left, right| left.id == right.id);
        Ok(candidates)
    }

    fn material(
        &self,
        candidate: &Candidate,
        host: &str,
        include_otp: bool,
    ) -> Result<CredentialMaterial, ProviderError> {
        let value =
            self.run_json(&["item", "get", &candidate.id, "--reveal", "--format", "json"])?;
        let detail_urls = extract_urls(&value);
        if !detail_urls.is_empty() && !detail_urls.iter().any(|url| host_matches_url(host, url)) {
            return Err(ProviderError::Unavailable);
        }
        let mut username = None;
        let mut password = None;
        if let Some(fields) = value.get("fields").and_then(Value::as_array) {
            for field in fields {
                let Some(field_value) = field.get("value").and_then(Value::as_str) else {
                    continue;
                };
                let purpose = field.get("purpose").and_then(Value::as_str).unwrap_or("");
                let id = field.get("id").and_then(Value::as_str).unwrap_or("");
                let label = field.get("label").and_then(Value::as_str).unwrap_or("");
                let field_type = field.get("type").and_then(Value::as_str).unwrap_or("");
                if username.is_none()
                    && (purpose.eq_ignore_ascii_case("USERNAME")
                        || id.eq_ignore_ascii_case("username")
                        || is_username_label(label))
                {
                    username = Some(field_value.to_string());
                } else if password.is_none()
                    && (purpose.eq_ignore_ascii_case("PASSWORD")
                        || id.eq_ignore_ascii_case("password")
                        || (field_type.eq_ignore_ascii_case("CONCEALED")
                            && label.eq_ignore_ascii_case("password")))
                {
                    password = Some(field_value.to_string());
                }
            }
        }
        let otp = if include_otp {
            self.run_text(&["item", "get", &candidate.id, "--otp"])
                .ok()
                .filter(|value| !value.is_empty())
        } else {
            None
        };
        Ok(CredentialMaterial {
            username,
            password,
            otp,
        })
    }
}

fn run_op(
    executable: &Path,
    arguments: &[String],
    timeout: Duration,
) -> Result<Vec<u8>, ProviderError> {
    let mut child = Command::new(executable)
        .args(arguments)
        .env("OP_BIOMETRIC_UNLOCK_ENABLED", "true")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|_| ProviderError::Unavailable)?;
    let stdout = child.stdout.take().ok_or(ProviderError::Unavailable)?;
    let stderr = child.stderr.take().ok_or(ProviderError::Unavailable)?;
    let stdout_reader = thread::spawn(move || read_bounded(stdout, MAX_PROVIDER_OUTPUT_BYTES));
    let stderr_reader = thread::spawn(move || read_bounded(stderr, MAX_PROVIDER_ERROR_BYTES));
    let deadline = Instant::now() + timeout;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if Instant::now() < deadline => thread::sleep(Duration::from_millis(25)),
            Ok(None) => {
                let _ = child.kill();
                let _ = child.wait();
                let _ = stdout_reader.join();
                let _ = stderr_reader.join();
                return Err(ProviderError::Timeout);
            }
            Err(_) => return Err(ProviderError::Unavailable),
        }
    };
    let stdout = stdout_reader
        .join()
        .map_err(|_| ProviderError::Unavailable)??;
    let _ = stderr_reader.join();
    if !status.success() {
        return Err(ProviderError::Unavailable);
    }
    Ok(stdout)
}

fn read_bounded(mut reader: impl Read, maximum: usize) -> Result<Vec<u8>, ProviderError> {
    let mut kept = Vec::new();
    let mut buffer = [0_u8; 8192];
    let mut overflow = false;
    loop {
        let count = reader
            .read(&mut buffer)
            .map_err(|_| ProviderError::Unavailable)?;
        if count == 0 {
            break;
        }
        let remaining = maximum.saturating_sub(kept.len());
        kept.extend_from_slice(&buffer[..count.min(remaining)]);
        overflow |= count > remaining;
    }
    if overflow {
        Err(ProviderError::Unavailable)
    } else {
        Ok(kept)
    }
}

fn parse_candidate(value: &Value) -> Option<Candidate> {
    let id = value
        .get("id")
        .or_else(|| value.get("ID"))
        .and_then(Value::as_str)?
        .to_string();
    let title = value
        .get("title")
        .or_else(|| value.get("Title"))
        .and_then(Value::as_str)?
        .to_string();
    Some(Candidate {
        id,
        title,
        urls: extract_urls(value),
    })
}

fn extract_urls(value: &Value) -> Vec<String> {
    let mut urls = Vec::new();
    for key in ["urls", "URLs", "website", "websites"] {
        if let Some(candidate) = value.get(key) {
            collect_url_values(candidate, &mut urls);
        }
    }
    if let Some(fields) = value.get("fields").and_then(Value::as_array) {
        for field in fields {
            if field
                .get("type")
                .and_then(Value::as_str)
                .is_some_and(|kind| kind.eq_ignore_ascii_case("URL"))
            {
                if let Some(url) = field.get("value").and_then(Value::as_str) {
                    urls.push(url.to_string());
                }
            }
        }
    }
    urls.sort();
    urls.dedup();
    urls
}

fn collect_url_values(value: &Value, urls: &mut Vec<String>) {
    match value {
        Value::String(url) => urls.push(url.clone()),
        Value::Array(values) => values
            .iter()
            .for_each(|value| collect_url_values(value, urls)),
        Value::Object(object) => {
            for key in ["href", "url", "value", "primary"] {
                if let Some(value) = object.get(key) {
                    collect_url_values(value, urls);
                }
            }
        }
        _ => {}
    }
}

fn candidate_matches_host(candidate: &Candidate, host: &str) -> bool {
    candidate.urls.iter().any(|url| host_matches_url(host, url))
}

fn host_matches_url(host: &str, value: &str) -> bool {
    let Ok(url) = Url::parse(value) else {
        return false;
    };
    let Some(candidate_host) = url.host_str() else {
        return false;
    };
    same_host_family(host, candidate_host)
}

fn same_host_family(left: &str, right: &str) -> bool {
    let normalize = |host: &str| {
        let host = host.trim_end_matches('.').to_ascii_lowercase();
        let mut labels = host.split('.').collect::<Vec<_>>();
        while labels.len() > 2
            && matches!(
                labels.first().copied(),
                Some("www" | "login" | "auth" | "signin" | "account" | "accounts" | "id" | "sso")
            )
        {
            labels.remove(0);
        }
        labels.join(".")
    };
    normalize(left) == normalize(right)
}

fn is_username_label(label: &str) -> bool {
    matches!(
        label.to_ascii_lowercase().as_str(),
        "username" | "email" | "email address" | "login"
    )
}

fn random_token() -> String {
    let mut bytes = [0_u8; 32];
    rand::thread_rng().fill_bytes(&mut bytes);
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn now_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Debug)]
    struct FakeProvider {
        candidates: Vec<Candidate>,
        material: CredentialMaterial,
    }

    impl CredentialProvider for FakeProvider {
        fn candidates(&self, _host: &str) -> Result<Vec<Candidate>, ProviderError> {
            Ok(self.candidates.clone())
        }

        fn material(
            &self,
            _candidate: &Candidate,
            _host: &str,
            _include_otp: bool,
        ) -> Result<CredentialMaterial, ProviderError> {
            Ok(self.material.clone())
        }
    }

    fn candidate(id: &str) -> Candidate {
        Candidate {
            id: id.into(),
            title: "Example".into(),
            urls: vec!["https://example.com".into()],
        }
    }

    #[cfg(unix)]
    #[test]
    fn configured_one_password_executable_is_used_without_process_path() {
        use std::os::unix::fs::PermissionsExt;

        let temp = tempfile::tempdir().unwrap();
        let executable = temp.path().join("op-fixture");
        std::fs::write(&executable, "#!/bin/sh\nprintf '[]'\n").unwrap();
        std::fs::set_permissions(&executable, std::fs::Permissions::from_mode(0o700)).unwrap();
        let provider = OnePasswordProvider::new(OnePasswordPolicy {
            enabled: true,
            executable: Some(executable),
            ..OnePasswordPolicy::default()
        });

        assert!(provider.candidates("example.com").unwrap().is_empty());
    }

    #[test]
    fn refuses_more_than_three_matching_items_without_exposing_identity() {
        let provider = Arc::new(FakeProvider {
            candidates: vec![
                candidate("a"),
                candidate("b"),
                candidate("c"),
                candidate("d"),
            ],
            material: CredentialMaterial {
                username: None,
                password: None,
                otp: None,
            },
        });
        let policy = OnePasswordPolicy {
            enabled: true,
            ..OnePasswordPolicy::default()
        };
        let broker = CredentialBroker::with_provider(policy, provider);
        assert!(matches!(
            broker.prepare(Uuid::now_v7(), 7, "example.com"),
            PrepareResult::NeedsUser {
                reason: NeedsUserReason::Ambiguous,
                candidate_count: 4
            }
        ));
    }

    #[test]
    fn token_is_bound_and_attempts_are_candidate_bounded() {
        let provider = Arc::new(FakeProvider {
            candidates: vec![candidate("a"), candidate("b")],
            material: CredentialMaterial {
                username: Some("person".into()),
                password: Some("secret".into()),
                otp: None,
            },
        });
        let policy = OnePasswordPolicy {
            enabled: true,
            ..OnePasswordPolicy::default()
        };
        let broker = CredentialBroker::with_provider(policy, provider);
        let task_id = Uuid::now_v7();
        let PrepareResult::Ready {
            credential_token, ..
        } = broker.prepare(task_id, 7, "example.com")
        else {
            panic!("expected ready credential token");
        };
        assert!(matches!(
            broker.select(
                &credential_token,
                Uuid::now_v7(),
                7,
                "example.com",
                false,
                false
            ),
            Err(BrokerError::BindingMismatch)
        ));
        assert!(matches!(
            broker.select(&credential_token, task_id, 7, "example.com", false, false),
            Ok(SelectResult::Ready {
                attempt_number: 1,
                remaining_attempts: 2,
                ..
            })
        ));
        assert!(matches!(
            broker.select(&credential_token, task_id, 7, "example.com", true, false),
            Ok(SelectResult::Ready {
                attempt_number: 2,
                remaining_attempts: 1,
                ..
            })
        ));
        assert!(matches!(
            broker.select(&credential_token, task_id, 7, "example.com", true, false),
            Ok(SelectResult::NeedsUser {
                reason: NeedsUserReason::Exhausted
            })
        ));
    }

    #[test]
    fn host_matching_accepts_known_auth_subdomains_without_title_fallback() {
        assert!(host_matches_url(
            "login.example.com",
            "https://example.com/signin"
        ));
        assert!(host_matches_url(
            "auth.example.com",
            "https://www.example.com/signin"
        ));
        assert!(!host_matches_url(
            "secure.example.com",
            "https://example.com/signin"
        ));
        assert!(!host_matches_url(
            "example.com",
            "https://unrelated.example/signin"
        ));
        assert!(!candidate_matches_host(
            &Candidate {
                id: "title-only".into(),
                title: "Example".into(),
                urls: Vec::new(),
            },
            "example.com",
        ));
    }

    #[test]
    fn credential_debug_output_never_contains_material() {
        let material = CredentialMaterial {
            username: Some("private-user".into()),
            password: Some("private-password".into()),
            otp: Some("123456".into()),
        };
        let debug = format!("{material:?}");
        assert!(!debug.contains("private-user"));
        assert!(!debug.contains("private-password"));
        assert!(!debug.contains("123456"));
        assert!(debug.contains("has_username: true"));
        assert!(debug.contains("has_password: true"));
        assert!(debug.contains("has_otp: true"));
    }
}
