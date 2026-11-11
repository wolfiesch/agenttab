//! Secret capture: copies one secret a page displays, such as a newly created
//! API key, into the owner's configured secret store. The value arrives from
//! the extension over the private native channel and leaves only on the sink's
//! standard input; requests, results, audit, and errors carry the destination
//! name, length, and a short digest prefix.

use agenttab_protocol::Outcome;
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::io::Write;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

const NAME_PLACEHOLDER: &str = "{name}";
const DEFAULT_TIMEOUT_MS: u64 = 60_000;
/// Keeps the page read (30 s) plus the sink inside adapters' 120 s
/// browser_credentials deadline.
const MAX_TIMEOUT_MS: u64 = 85_000;
/// Sink exit status meaning "a secret with this name already exists".
const EXIT_NAME_EXISTS: i32 = 3;
pub const MIN_SECRET_CHARS: usize = 16;
pub const MAX_SECRET_CHARS: usize = 4096;
const FINGERPRINT_HEX_CHARS: usize = 12;

#[derive(Debug, Clone, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct SecretCapturePolicy {
    pub enabled: bool,
    /// Absolute path of the sink program.
    pub executable: Option<PathBuf>,
    /// Sink arguments for a new secret; exactly one item is `{name}`.
    pub arguments: Vec<String>,
    /// Sink arguments that replace an existing secret. Absent: overwrite is refused.
    pub overwrite_arguments: Option<Vec<String>>,
    pub timeout_ms: u64,
}

impl Default for SecretCapturePolicy {
    fn default() -> Self {
        Self {
            enabled: false,
            executable: None,
            arguments: Vec::new(),
            overwrite_arguments: None,
            timeout_ms: DEFAULT_TIMEOUT_MS,
        }
    }
}

impl SecretCapturePolicy {
    pub fn validate(&self) -> Result<(), String> {
        if !self.enabled {
            return Ok(());
        }
        if !self
            .executable
            .as_ref()
            .is_some_and(|executable| executable.is_absolute())
        {
            return Err("executable must be an absolute path".into());
        }
        let placeholder_count = |arguments: &[String]| {
            arguments
                .iter()
                .filter(|argument| *argument == NAME_PLACEHOLDER)
                .count()
        };
        if placeholder_count(&self.arguments) != 1 {
            return Err("arguments must contain exactly one \"{name}\" item".into());
        }
        if self
            .overwrite_arguments
            .as_ref()
            .is_some_and(|arguments| placeholder_count(arguments) != 1)
        {
            return Err("overwrite_arguments must contain exactly one \"{name}\" item".into());
        }
        if !(1_000..=MAX_TIMEOUT_MS).contains(&self.timeout_ms) {
            return Err(format!(
                "timeout_ms must be between 1000 and {MAX_TIMEOUT_MS}"
            ));
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SinkError {
    OverwriteUnsupported,
    NameExists,
    Unavailable,
    Failed,
    Timeout,
}

impl SinkError {
    pub fn code(self) -> &'static str {
        match self {
            Self::OverwriteUnsupported => "secret_capture_overwrite_unsupported",
            Self::NameExists => "secret_capture_name_exists",
            Self::Unavailable => "secret_capture_sink_unavailable",
            Self::Failed => "secret_capture_sink_failed",
            Self::Timeout => "secret_capture_sink_timeout",
        }
    }

    pub fn message(self) -> &'static str {
        match self {
            Self::OverwriteUnsupported => {
                "The configured secret store does not allow AgentTab to replace secrets"
            }
            Self::NameExists => "The secret store already holds a secret with this name",
            Self::Unavailable => "AgentTab could not start the configured secret store",
            Self::Failed => "The secret store reported a failure while storing the secret",
            Self::Timeout => "The secret store did not finish before the capture timeout",
        }
    }

    pub fn recovery(self) -> &'static str {
        match self {
            Self::OverwriteUnsupported => {
                "Choose a new secret_name, or configure secret_capture.overwrite_arguments."
            }
            Self::NameExists => "Choose a new secret_name, or retry with overwrite: true.",
            Self::Unavailable => {
                "Check secret_capture.executable in AgentTab's managed local policy."
            }
            Self::Failed | Self::Timeout => {
                "Check the secret store before retrying; it may hold a partial or complete copy."
            }
        }
    }

    /// Failures after the sink received the value may have stored it.
    pub fn outcome(self) -> Outcome {
        match self {
            Self::OverwriteUnsupported | Self::NameExists | Self::Unavailable => {
                Outcome::NotStarted
            }
            Self::Failed | Self::Timeout => Outcome::Unknown,
        }
    }
}

/// One printable ASCII token without whitespace, the shape of API keys and
/// access tokens. The lower bound keeps the digest prefix from identifying
/// short guessable values.
pub fn is_capturable(value: &str) -> bool {
    (MIN_SECRET_CHARS..=MAX_SECRET_CHARS).contains(&value.len())
        && value.bytes().all(|byte| matches!(byte, b'!'..=b'~'))
}

/// Leading hex of the value's SHA-256, for comparing against the stored copy.
pub fn fingerprint(value: &str) -> String {
    let mut digest = format!("{:x}", Sha256::digest(value.as_bytes()));
    digest.truncate(FINGERPRINT_HEX_CHARS);
    digest
}

/// Runs the sink with the value on standard input. Output is discarded so
/// nothing the sink prints can carry the value back.
pub fn store(
    policy: &SecretCapturePolicy,
    name: &str,
    value: &str,
    overwrite: bool,
) -> Result<(), SinkError> {
    let template = if overwrite {
        policy
            .overwrite_arguments
            .as_ref()
            .ok_or(SinkError::OverwriteUnsupported)?
    } else {
        &policy.arguments
    };
    let executable = policy.executable.as_ref().ok_or(SinkError::Unavailable)?;
    let arguments = template.iter().map(|argument| {
        if argument == NAME_PLACEHOLDER {
            name
        } else {
            argument.as_str()
        }
    });
    let mut child = Command::new(executable)
        .args(arguments)
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|_| SinkError::Unavailable)?;
    // A sink that exits before reading reports its own status below.
    if let Some(mut stdin) = child.stdin.take() {
        let _ = stdin.write_all(value.as_bytes());
    }
    let deadline = Instant::now() + Duration::from_millis(policy.timeout_ms);
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if Instant::now() < deadline => thread::sleep(Duration::from_millis(25)),
            Ok(None) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(SinkError::Timeout);
            }
            Err(_) => return Err(SinkError::Failed),
        }
    };
    match status.code() {
        Some(0) => Ok(()),
        Some(EXIT_NAME_EXISTS) => Err(SinkError::NameExists),
        _ => Err(SinkError::Failed),
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    const VALUE: &str = "tok-test-0123456789abcdef";

    /// A sink that appends `name=value` to `store`, refusing an existing name
    /// unless invoked with `--force`.
    fn sink(dir: &std::path::Path) -> SecretCapturePolicy {
        let script = dir.join("sink.sh");
        std::fs::write(
            &script,
            format!(
                "#!/bin/sh\nstore='{}'\nif [ \"$1\" != --force ] && grep -q \"^$2=\" \"$store\" 2>/dev/null; then exit 3; fi\nprintf '%s=%s\\n' \"$2\" \"$(cat)\" >> \"$store\"\n",
                dir.join("store").display()
            ),
        )
        .unwrap();
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o700)).unwrap();
        SecretCapturePolicy {
            enabled: true,
            executable: Some(script),
            arguments: vec!["--new".into(), "{name}".into()],
            overwrite_arguments: Some(vec!["--force".into(), "{name}".into()]),
            timeout_ms: 5_000,
        }
    }

    #[test]
    fn value_reaches_the_sink_on_stdin_and_existing_names_need_overwrite() {
        let dir = tempfile::tempdir().unwrap();
        let policy = sink(dir.path());
        store(&policy, "API_KEY", VALUE, false).unwrap();
        assert_eq!(
            store(&policy, "API_KEY", VALUE, false),
            Err(SinkError::NameExists)
        );
        let rotated = "rotated-fixture-value"; // gitleaks:allow
        store(&policy, "API_KEY", rotated, true).unwrap();
        assert_eq!(
            std::fs::read_to_string(dir.path().join("store")).unwrap(),
            format!("API_KEY={VALUE}\nAPI_KEY={rotated}\n")
        );
    }

    #[test]
    fn overwrite_without_configured_arguments_never_runs_the_sink() {
        let dir = tempfile::tempdir().unwrap();
        let mut policy = sink(dir.path());
        policy.overwrite_arguments = None;
        assert_eq!(
            store(&policy, "API_KEY", VALUE, true),
            Err(SinkError::OverwriteUnsupported)
        );
        assert!(!dir.path().join("store").exists());
    }

    #[test]
    fn sink_failures_and_timeouts_are_unknown_outcomes() {
        let dir = tempfile::tempdir().unwrap();
        let mut policy = sink(dir.path());
        // `sh -c 'exit 1' NAME`: a sink failure that is not "name exists".
        policy.executable = Some(PathBuf::from("/bin/sh"));
        policy.arguments = vec!["-c".into(), "exit 1".into(), "{name}".into()];
        let failed = store(&policy, "API_KEY", VALUE, false).unwrap_err();
        assert_eq!(
            (failed, failed.outcome()),
            (SinkError::Failed, Outcome::Unknown)
        );
        // `sh -c 'sleep 5' NAME` ignores the name, which becomes `$0`.
        policy.executable = Some(PathBuf::from("/bin/sh"));
        policy.arguments = vec!["-c".into(), "sleep 5".into(), "{name}".into()];
        policy.timeout_ms = 1_000;
        let timed_out = store(&policy, "API_KEY", VALUE, false).unwrap_err();
        assert_eq!(
            (timed_out, timed_out.outcome()),
            (SinkError::Timeout, Outcome::Unknown)
        );
    }

    #[test]
    fn enabled_policy_requires_an_absolute_sink_and_one_name_placeholder() {
        let dir = tempfile::tempdir().unwrap();
        let valid = sink(dir.path());
        assert!(valid.validate().is_ok());
        let mut relative = valid.clone();
        relative.executable = Some(PathBuf::from("secret-cli"));
        let mut unnamed = valid.clone();
        unnamed.arguments = vec!["set".into()];
        let mut doubled = valid.clone();
        doubled.overwrite_arguments = Some(vec!["{name}".into(), "{name}".into()]);
        for policy in [relative, unnamed, doubled] {
            assert!(policy.validate().is_err(), "{policy:?}");
        }
        assert!(SecretCapturePolicy::default().validate().is_ok());
    }

    #[test]
    fn capturable_values_are_bounded_printable_tokens() {
        assert!(is_capturable(VALUE));
        for value in [
            "short-token",
            "has a space 0123456789",
            "tab\tseparated0123456789",
        ] {
            assert!(!is_capturable(value), "{value}");
        }
        assert!(!is_capturable(&"k".repeat(MAX_SECRET_CHARS + 1)));
        assert_eq!(fingerprint(VALUE).len(), FINGERPRINT_HEX_CHARS);
    }
}
