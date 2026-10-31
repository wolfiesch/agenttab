//! Brokered email verification codes.
//!
//! The broker resolves one exact managed grant (origin, URL pathname,
//! recipient, purpose) before it touches the mailbox, then reads exactly one
//! caller-named Gmail message through the configured, already-authenticated
//! `gws` CLI. The message must be fresh, authenticated by Gmail's own
//! `Authentication-Results`, sent by a configured sender domain (directly or
//! through an exact trusted relay), and addressed to the exact recipient. The
//! extracted code stays in host memory; every failure is a fixed, sanitized
//! error that never carries provider output, message content, or the code.

use crate::credentials::{run_provider_process, ProviderError};
use base64::alphabet;
use base64::engine::general_purpose::{GeneralPurpose, GeneralPurposeConfig};
use base64::engine::DecodePaddingMode;
use base64::Engine;
use regex::{Regex, RegexBuilder};
use serde::Deserialize;
use serde_json::{json, Value};
use std::net::IpAddr;
use std::path::PathBuf;
use std::sync::{Arc, LazyLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use url::{Host, Url};

pub const EMAIL_CODE_PURPOSES: [&str; 2] = ["signup", "email_sign_in"];

const DEFAULT_MAX_AGE_MS: u64 = 600_000;
const MIN_MAX_AGE_MS: u64 = 30_000;
const MAX_MAX_AGE_MS: u64 = 900_000;
const DEFAULT_TIMEOUT_MS: u64 = 30_000;
const MIN_TIMEOUT_MS: u64 = 5_000;
const MAX_TIMEOUT_MS: u64 = 120_000;
/// Gmail `internalDate` may lead the host clock slightly; more than this is
/// treated as a materially future (untrustworthy) timestamp.
const MAX_FUTURE_SKEW_MS: u64 = 120_000;

const MAX_GRANTS: usize = 64;
const MAX_GRANT_LIST_ITEMS: usize = 32;
const MAX_PATH_CHARS: usize = 2048;
const MAX_PATTERN_CHARS: usize = 512;
const PATTERN_SIZE_LIMIT: usize = 256 * 1024;
const MIN_CODE_CHARS: usize = 4;
const MAX_CODE_CHARS: usize = 12;
const MAX_MESSAGE_ID_CHARS: usize = 128;
const MIN_EMAIL_CHARS: usize = 3;
const MAX_EMAIL_CHARS: usize = 320;
const MAX_LOCAL_PART_CHARS: usize = 64;
const MAX_DOMAIN_CHARS: usize = 253;
const MAX_MIME_DEPTH: usize = 16;
const MAX_MIME_PARTS: usize = 256;
const MAX_DECODED_TEXT_BYTES: usize = 4 * 1024 * 1024;

const GMAIL_AUTHSERV_ID: &str = "mx.google.com";
/// Drafts, sent, or trashed mail are not delivered verification messages.
/// Spam classification does not replace the sender-authentication checks.
const INELIGIBLE_LABELS: [&str; 3] = ["TRASH", "DRAFT", "SENT"];
/// Headers that name the envelope or visible recipient of a message.
const RECIPIENT_HEADERS: [&str; 4] = ["to", "cc", "delivered-to", "x-original-to"];

/// Path tokens that designate MFA, authenticator, or hardware-key flows.
/// Email-code grants never cover those flows.
const SECOND_FACTOR_PATH_TOKENS: &[&str] = &[
    "mfa",
    "2fa",
    "tfa",
    "2sv",
    "totp",
    "authenticator",
    "authenticators",
    "otpauth",
    "twofactor",
    "multifactor",
    "webauthn",
    "passkey",
    "passkeys",
    "securitykey",
    "securitykeys",
    "u2f",
    "fido",
    "fido2",
];
/// Compact (alphanumeric-only) phrases that designate the same flows when
/// written with separators, such as `two-factor` or `second_factor`.
const SECOND_FACTOR_PATH_PHRASES: &[&str] = &[
    "twofactor",
    "multifactor",
    "twostep",
    "2step",
    "secondfactor",
    "authenticator",
    "securitykey",
    "passkey",
];

const GMAIL_BASE64: GeneralPurpose = GeneralPurpose::new(
    &alphabet::URL_SAFE,
    GeneralPurposeConfig::new().with_decode_padding_mode(DecodePaddingMode::Indifferent),
);
const MIME_BASE64: GeneralPurpose = GeneralPurpose::new(
    &alphabet::STANDARD,
    GeneralPurposeConfig::new().with_decode_padding_mode(DecodePaddingMode::Indifferent),
);

#[derive(Clone, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct EmailCodePolicy {
    pub enabled: bool,
    pub executable: Option<PathBuf>,
    pub mailbox: Option<String>,
    pub max_age_ms: u64,
    pub timeout_ms: u64,
    pub grants: Vec<EmailCodeGrant>,
}

impl Default for EmailCodePolicy {
    fn default() -> Self {
        Self {
            enabled: false,
            executable: None,
            mailbox: None,
            max_age_ms: DEFAULT_MAX_AGE_MS,
            timeout_ms: DEFAULT_TIMEOUT_MS,
            grants: Vec::new(),
        }
    }
}

impl std::fmt::Debug for EmailCodePolicy {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("EmailCodePolicy")
            .field("enabled", &self.enabled)
            .field("has_executable", &self.executable.is_some())
            .field("has_mailbox", &self.mailbox.is_some())
            .field("max_age_ms", &self.max_age_ms)
            .field("timeout_ms", &self.timeout_ms)
            .field("grants", &self.grants)
            .finish()
    }
}

#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct EmailCodeGrant {
    pub origin: String,
    pub paths: Vec<String>,
    pub recipient: String,
    pub purposes: Vec<String>,
    pub sender_domains: Vec<String>,
    #[serde(default)]
    pub relay_senders: Vec<String>,
    pub code_pattern: String,
}

impl std::fmt::Debug for EmailCodeGrant {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("EmailCodeGrant")
            .field("origin", &self.origin)
            .field("path_count", &self.paths.len())
            .field("purposes", &self.purposes)
            .field("sender_domain_count", &self.sender_domains.len())
            .field("relay_sender_count", &self.relay_senders.len())
            .finish()
    }
}

impl EmailCodePolicy {
    /// Validates the whole policy, including disabled grants. Messages name
    /// the failing field by index and never echo configured values.
    pub fn validate(&self) -> Result<(), String> {
        if !(MIN_MAX_AGE_MS..=MAX_MAX_AGE_MS).contains(&self.max_age_ms) {
            return Err(format!(
                "max_age_ms must be between {MIN_MAX_AGE_MS} and {MAX_MAX_AGE_MS}"
            ));
        }
        if !(MIN_TIMEOUT_MS..=MAX_TIMEOUT_MS).contains(&self.timeout_ms) {
            return Err(format!(
                "timeout_ms must be between {MIN_TIMEOUT_MS} and {MAX_TIMEOUT_MS}"
            ));
        }
        if let Some(executable) = &self.executable {
            if !executable.is_absolute() {
                return Err("executable must be an absolute path to the gws CLI".into());
            }
        }
        if let Some(mailbox) = &self.mailbox {
            if normalize_email(mailbox).is_none() {
                return Err("mailbox must be one valid email address".into());
            }
        }
        if self.enabled {
            if self.executable.is_none() {
                return Err("executable is required when email_codes is enabled".into());
            }
            if self.mailbox.is_none() {
                return Err("mailbox is required when email_codes is enabled".into());
            }
            if self.grants.is_empty() {
                return Err("at least one grant is required when email_codes is enabled".into());
            }
        }
        if self.grants.len() > MAX_GRANTS {
            return Err(format!("grants must contain at most {MAX_GRANTS} items"));
        }
        for (index, grant) in self.grants.iter().enumerate() {
            validate_grant(grant).map_err(|reason| format!("grants[{index}]: {reason}"))?;
        }
        for (index, grant) in self.grants.iter().enumerate() {
            for (other_index, other) in self.grants.iter().enumerate().skip(index + 1) {
                let overlaps = grant.origin == other.origin
                    && grant.recipient.eq_ignore_ascii_case(&other.recipient)
                    && grant.paths.iter().any(|path| other.paths.contains(path))
                    && grant
                        .purposes
                        .iter()
                        .any(|purpose| other.purposes.contains(purpose));
                if overlaps {
                    return Err(format!(
                        "grants[{index}] and grants[{other_index}] overlap on origin, path, recipient, and purpose"
                    ));
                }
            }
        }
        Ok(())
    }
}

fn validate_grant(grant: &EmailCodeGrant) -> Result<(), String> {
    let origin = canonical_secure_origin(&grant.origin)
        .ok_or("origin must be one exact HTTPS origin or explicit loopback HTTP origin")?;
    if grant.paths.is_empty() || grant.paths.len() > MAX_GRANT_LIST_ITEMS {
        return Err(format!(
            "paths must contain 1 to {MAX_GRANT_LIST_ITEMS} exact URL pathnames"
        ));
    }
    for (index, path) in grant.paths.iter().enumerate() {
        if !is_exact_pathname(&origin, path) {
            return Err(format!(
                "paths[{index}] must be one exact canonical URL pathname without query, fragment, or wildcard"
            ));
        }
        if designates_second_factor(path) {
            return Err(format!(
                "paths[{index}] designates an MFA, authenticator, or security-key flow"
            ));
        }
        if grant.paths[..index].contains(path) {
            return Err(format!("paths[{index}] is a duplicate"));
        }
    }
    if normalize_email(&grant.recipient).is_none() {
        return Err("recipient must be one valid email address".into());
    }
    if grant.purposes.is_empty() || grant.purposes.len() > EMAIL_CODE_PURPOSES.len() {
        return Err("purposes must contain signup and/or email_sign_in".into());
    }
    for (index, purpose) in grant.purposes.iter().enumerate() {
        if !EMAIL_CODE_PURPOSES.contains(&purpose.as_str()) {
            return Err(format!("purposes[{index}] must be signup or email_sign_in"));
        }
        if grant.purposes[..index].contains(purpose) {
            return Err(format!("purposes[{index}] is a duplicate"));
        }
    }
    if grant.sender_domains.is_empty() || grant.sender_domains.len() > MAX_GRANT_LIST_ITEMS {
        return Err(format!(
            "sender_domains must contain 1 to {MAX_GRANT_LIST_ITEMS} exact domains"
        ));
    }
    for (index, domain) in grant.sender_domains.iter().enumerate() {
        if !is_valid_domain(domain) || domain.bytes().any(|byte| byte.is_ascii_uppercase()) {
            return Err(format!(
                "sender_domains[{index}] must be one exact lowercase domain"
            ));
        }
        if grant.sender_domains[..index].contains(domain) {
            return Err(format!("sender_domains[{index}] is a duplicate"));
        }
    }
    if grant.relay_senders.len() > MAX_GRANT_LIST_ITEMS {
        return Err(format!(
            "relay_senders must contain at most {MAX_GRANT_LIST_ITEMS} addresses"
        ));
    }
    for (index, sender) in grant.relay_senders.iter().enumerate() {
        if normalize_email(sender).as_deref() != Some(sender.as_str()) {
            return Err(format!(
                "relay_senders[{index}] must be one exact lowercase email address"
            ));
        }
        if grant.relay_senders[..index].contains(sender) {
            return Err(format!("relay_senders[{index}] is a duplicate"));
        }
    }
    compile_code_pattern(&grant.code_pattern)?;
    Ok(())
}

fn compile_code_pattern(pattern: &str) -> Result<Regex, String> {
    if pattern.is_empty() || pattern.chars().count() > MAX_PATTERN_CHARS {
        return Err(format!(
            "code_pattern must contain 1 to {MAX_PATTERN_CHARS} characters"
        ));
    }
    let regex = RegexBuilder::new(pattern)
        .size_limit(PATTERN_SIZE_LIMIT)
        .dfa_size_limit(PATTERN_SIZE_LIMIT)
        .build()
        .map_err(|_| "code_pattern must be a valid bounded regular expression".to_string())?;
    if regex.captures_len() != 2 {
        return Err("code_pattern must contain exactly one capture group".into());
    }
    Ok(regex)
}

/// Returns the canonical origin when `origin` is already exactly that
/// canonical HTTPS (or loopback HTTP) origin: no path, slash, userinfo,
/// default port, wildcard, or case variation.
fn canonical_secure_origin(origin: &str) -> Option<Url> {
    let url = Url::parse(origin).ok()?;
    let secure = match url.scheme() {
        "https" => true,
        "http" => is_loopback_host(&url),
        _ => false,
    };
    (secure
        && url.host_str().is_some_and(|host| !host.contains('*'))
        && url.origin().ascii_serialization() == origin)
        .then_some(url)
}

fn is_loopback_host(url: &Url) -> bool {
    match url.host() {
        Some(Host::Domain(domain)) => domain == "localhost",
        Some(Host::Ipv4(address)) => IpAddr::V4(address).is_loopback(),
        Some(Host::Ipv6(address)) => IpAddr::V6(address).is_loopback(),
        None => false,
    }
}

fn is_exact_pathname(origin: &Url, path: &str) -> bool {
    if !path.starts_with('/')
        || path.starts_with("//")
        || path.chars().count() > MAX_PATH_CHARS
        || path.chars().any(|character| {
            character.is_control()
                || character.is_whitespace()
                || matches!(character, '?' | '#' | '*' | '\\')
        })
    {
        return false;
    }
    origin
        .join(path)
        .is_ok_and(|joined| joined.path() == path && joined.origin() == origin.origin())
}

fn designates_second_factor(path: &str) -> bool {
    let decoded = percent_decode_lossy(path).to_ascii_lowercase();
    let token_match = decoded
        .split(|character: char| !character.is_ascii_alphanumeric())
        .any(|token| SECOND_FACTOR_PATH_TOKENS.contains(&token));
    let compact = decoded
        .chars()
        .filter(char::is_ascii_alphanumeric)
        .collect::<String>();
    token_match
        || SECOND_FACTOR_PATH_PHRASES
            .iter()
            .any(|phrase| compact.contains(phrase))
}

fn percent_decode_lossy(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' && index + 2 < bytes.len() {
            if let (Some(high), Some(low)) =
                (hex_value(bytes[index + 1]), hex_value(bytes[index + 2]))
            {
                decoded.push((high << 4) | low);
                index += 3;
                continue;
            }
        }
        decoded.push(bytes[index]);
        index += 1;
    }
    String::from_utf8_lossy(&decoded).into_owned()
}

fn hex_value(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        _ => None,
    }
}

/// Non-secret routing metadata for one email-code resolution. The host
/// derives `origin` and `path` from the verified tab URL.
#[derive(Clone, Copy)]
pub struct EmailCodeRequest<'a> {
    pub origin: &'a str,
    pub path: &'a str,
    pub recipient: &'a str,
    pub purpose: &'a str,
    pub message_id: &'a str,
}

/// Fixed, sanitized failures. No variant carries provider output, message
/// content, addresses, or code material.
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum EmailCodeError {
    #[error("email code policy failed validation")]
    PolicyInvalid,
    #[error("email verification code filling is disabled by AgentTab policy")]
    Disabled,
    #[error("email code request is invalid")]
    InvalidRequest,
    #[error("no managed email code grant matches this origin, path, recipient, and purpose")]
    GrantNotFound,
    #[error("the mailbox provider is unavailable")]
    ProviderUnavailable,
    #[error("the mailbox provider timed out")]
    ProviderTimeout,
    #[error("the authenticated mailbox does not match the managed mailbox")]
    MailboxMismatch,
    #[error("the requested message is unavailable or malformed")]
    MessageUnavailable,
    #[error("the requested message is not eligible as a verification code source")]
    MessageIneligible,
    #[error("the requested message is not fresh")]
    MessageNotFresh,
    #[error("the message sender is not trusted by the managed grant")]
    SenderUntrusted,
    #[error("the message sender is not authenticated by Gmail")]
    SenderUnauthenticated,
    #[error("the message is not addressed to the requested recipient")]
    RecipientMismatch,
    #[error("the message does not contain one valid verification code")]
    CodeNotFound,
    #[error("the message contains more than one candidate verification code")]
    CodeAmbiguous,
}

impl EmailCodeError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::PolicyInvalid => "email_code_policy_invalid",
            Self::Disabled => "email_code_provider_disabled",
            Self::InvalidRequest => "email_code_request_invalid",
            Self::GrantNotFound => "email_code_grant_not_found",
            Self::ProviderUnavailable => "email_code_provider_unavailable",
            Self::ProviderTimeout => "email_code_provider_timeout",
            Self::MailboxMismatch => "email_code_mailbox_mismatch",
            Self::MessageUnavailable => "email_code_message_unavailable",
            Self::MessageIneligible => "email_code_message_ineligible",
            Self::MessageNotFresh => "email_code_message_stale",
            Self::SenderUntrusted => "email_code_sender_untrusted",
            Self::SenderUnauthenticated => "email_code_sender_unauthenticated",
            Self::RecipientMismatch => "email_code_recipient_mismatch",
            Self::CodeNotFound => "email_code_not_found",
            Self::CodeAmbiguous => "email_code_ambiguous",
        }
    }

    pub fn recovery(&self) -> &'static str {
        match self {
            Self::PolicyInvalid => "Correct email_codes in AgentTab's managed local policy, then restart the native host.",
            Self::Disabled => "Enable email_codes with an exact grant in AgentTab's managed local policy, or enter the code manually.",
            Self::InvalidRequest => "Provide one Gmail message ID, the exact recipient address, and purpose signup or email_sign_in.",
            Self::GrantNotFound => "Add an exact managed grant for this verification page, recipient, and purpose, or enter the code manually.",
            Self::ProviderUnavailable => "Verify the configured gws CLI is installed and already authenticated for the managed mailbox, and that the message ID exists.",
            Self::ProviderTimeout => "Check the gws CLI and network connectivity, then retry.",
            Self::MailboxMismatch => "Authenticate gws to the managed mailbox yourself, or correct email_codes.mailbox.",
            Self::MessageUnavailable => "Use the message ID of the delivered verification email, or enter the code manually.",
            Self::MessageIneligible => "Use a delivered inbox message; spam, drafts, sent, and trashed mail are refused.",
            Self::MessageNotFresh => "Request a new verification email and use its message ID.",
            Self::SenderUntrusted => "Use a verification email from a sender configured for this grant, or enter the code manually.",
            Self::SenderUnauthenticated => "Gmail did not authenticate this sender with aligned DKIM and DMARC; enter the code manually.",
            Self::RecipientMismatch => "Use the verification email sent to the requested recipient address.",
            Self::CodeNotFound => "Check the grant's code_pattern against the verification email, or enter the code manually.",
            Self::CodeAmbiguous => "Tighten the grant's code_pattern, or enter the code manually.",
        }
    }
}

trait MailProvider: Send + Sync {
    fn profile(&self, deadline: Instant) -> Result<Value, ProviderError>;
    fn message(&self, message_id: &str, deadline: Instant) -> Result<Value, ProviderError>;
}

/// Reads Gmail through the configured `gws` CLI. It never configures auth,
/// searches, or mutates the mailbox: only `users.getProfile` and one
/// `users.messages.get` for the exact requested ID.
struct GwsProvider {
    executable: Option<PathBuf>,
}

impl GwsProvider {
    fn new(policy: &EmailCodePolicy) -> Self {
        Self {
            executable: policy.executable.clone(),
        }
    }

    fn run(&self, arguments: Vec<String>, deadline: Instant) -> Result<Value, ProviderError> {
        let executable = self.executable.as_ref().ok_or(ProviderError::Unavailable)?;
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Err(ProviderError::Timeout);
        }
        let output = run_provider_process(executable, &arguments, &[], remaining)?;
        let value: Value =
            serde_json::from_slice(&output).map_err(|_| ProviderError::Unavailable)?;
        if !value.is_object() || value.get("error").is_some() {
            return Err(ProviderError::Unavailable);
        }
        Ok(value)
    }
}

impl MailProvider for GwsProvider {
    fn profile(&self, deadline: Instant) -> Result<Value, ProviderError> {
        self.run(
            vec![
                "gmail".into(),
                "users".into(),
                "getProfile".into(),
                "--params".into(),
                json!({ "userId": "me" }).to_string(),
            ],
            deadline,
        )
    }

    fn message(&self, message_id: &str, deadline: Instant) -> Result<Value, ProviderError> {
        self.run(
            vec![
                "gmail".into(),
                "users".into(),
                "messages".into(),
                "get".into(),
                "--params".into(),
                json!({ "userId": "me", "id": message_id, "format": "full" }).to_string(),
            ],
            deadline,
        )
    }
}

struct CompiledGrant {
    origin: String,
    paths: Vec<String>,
    recipient: String,
    purposes: Vec<String>,
    sender_domains: Vec<String>,
    relay_senders: Vec<String>,
    code_pattern: Regex,
}

struct BrokerConfig {
    enabled: bool,
    mailbox_key: Option<String>,
    max_age_ms: u64,
    timeout: Duration,
    grants: Vec<CompiledGrant>,
}

impl BrokerConfig {
    fn compile(policy: &EmailCodePolicy) -> Option<Self> {
        policy.validate().ok()?;
        let grants = policy
            .grants
            .iter()
            .map(|grant| {
                Some(CompiledGrant {
                    origin: grant.origin.clone(),
                    paths: grant.paths.clone(),
                    recipient: normalize_email(&grant.recipient)?,
                    purposes: grant.purposes.clone(),
                    sender_domains: grant.sender_domains.clone(),
                    relay_senders: grant.relay_senders.clone(),
                    code_pattern: compile_code_pattern(&grant.code_pattern).ok()?,
                })
            })
            .collect::<Option<Vec<_>>>()?;
        Some(Self {
            enabled: policy.enabled,
            mailbox_key: policy.mailbox.as_deref().and_then(mailbox_key),
            max_age_ms: policy.max_age_ms,
            timeout: Duration::from_millis(policy.timeout_ms),
            grants,
        })
    }

    fn grant_for(&self, request: &EmailCodeRequest<'_>, recipient: &str) -> Option<&CompiledGrant> {
        self.grants.iter().find(|grant| {
            grant.origin == request.origin
                && grant.paths.iter().any(|path| path == request.path)
                && grant.recipient == recipient
                && grant
                    .purposes
                    .iter()
                    .any(|purpose| purpose == request.purpose)
        })
    }
}

pub struct EmailCodeBroker {
    config: Option<BrokerConfig>,
    provider: Arc<dyn MailProvider>,
    now_ms: fn() -> u64,
}

impl std::fmt::Debug for EmailCodeBroker {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("EmailCodeBroker")
            .field("policy_valid", &self.config.is_some())
            .field(
                "enabled",
                &self.config.as_ref().is_some_and(|config| config.enabled),
            )
            .field(
                "grant_count",
                &self.config.as_ref().map_or(0, |config| config.grants.len()),
            )
            .finish()
    }
}

impl EmailCodeBroker {
    pub fn new(policy: EmailCodePolicy) -> Self {
        let provider = Arc::new(GwsProvider::new(&policy));
        Self {
            config: BrokerConfig::compile(&policy),
            provider,
            now_ms: system_now_ms,
        }
    }

    #[cfg(test)]
    fn with_parts(
        policy: EmailCodePolicy,
        provider: Arc<dyn MailProvider>,
        now_ms: fn() -> u64,
    ) -> Self {
        Self {
            config: BrokerConfig::compile(&policy),
            provider,
            now_ms,
        }
    }

    /// Resolves the verification code for one exact grant and message. The
    /// returned code must stay in host memory.
    pub fn resolve(&self, request: EmailCodeRequest<'_>) -> Result<String, EmailCodeError> {
        let config = self.config.as_ref().ok_or(EmailCodeError::PolicyInvalid)?;
        if !config.enabled {
            return Err(EmailCodeError::Disabled);
        }
        if !is_message_id(request.message_id) || !EMAIL_CODE_PURPOSES.contains(&request.purpose) {
            return Err(EmailCodeError::InvalidRequest);
        }
        let recipient = normalize_email(request.recipient).ok_or(EmailCodeError::InvalidRequest)?;
        let grant = config
            .grant_for(&request, &recipient)
            .ok_or(EmailCodeError::GrantNotFound)?;
        let expected_mailbox = config
            .mailbox_key
            .as_deref()
            .ok_or(EmailCodeError::PolicyInvalid)?;

        let deadline = Instant::now() + config.timeout;
        let profile = self.provider.profile(deadline).map_err(provider_error)?;
        let authenticated = profile
            .get("emailAddress")
            .and_then(Value::as_str)
            .and_then(mailbox_key)
            .ok_or(EmailCodeError::MailboxMismatch)?;
        if authenticated != expected_mailbox {
            return Err(EmailCodeError::MailboxMismatch);
        }

        let message = self
            .provider
            .message(request.message_id, deadline)
            .map_err(provider_error)?;
        verify_and_extract(
            &message,
            request.message_id,
            grant,
            config.max_age_ms,
            (self.now_ms)(),
        )
    }
}

fn provider_error(error: ProviderError) -> EmailCodeError {
    match error {
        ProviderError::Timeout => EmailCodeError::ProviderTimeout,
        ProviderError::Unavailable => EmailCodeError::ProviderUnavailable,
    }
}

fn system_now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .try_into()
        .unwrap_or(u64::MAX)
}

fn is_message_id(value: &str) -> bool {
    (1..=MAX_MESSAGE_ID_CHARS).contains(&value.len())
        && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

enum SenderRoute {
    Direct,
    Relay,
}

fn verify_and_extract(
    message: &Value,
    message_id: &str,
    grant: &CompiledGrant,
    max_age_ms: u64,
    now_ms: u64,
) -> Result<String, EmailCodeError> {
    let returned_id = message
        .get("id")
        .and_then(Value::as_str)
        .ok_or(EmailCodeError::MessageUnavailable)?;
    if !returned_id.eq_ignore_ascii_case(message_id) {
        return Err(EmailCodeError::MessageUnavailable);
    }
    if let Some(labels) = message.get("labelIds") {
        let labels = labels
            .as_array()
            .ok_or(EmailCodeError::MessageUnavailable)?;
        if labels.iter().any(|label| {
            label
                .as_str()
                .is_some_and(|label| INELIGIBLE_LABELS.contains(&label))
        }) {
            return Err(EmailCodeError::MessageIneligible);
        }
    }

    let internal_date = match message.get("internalDate") {
        Some(Value::String(value)) => value.parse::<u64>().ok(),
        Some(Value::Number(value)) => value.as_u64(),
        _ => None,
    }
    .ok_or(EmailCodeError::MessageUnavailable)?;
    if internal_date > now_ms.saturating_add(MAX_FUTURE_SKEW_MS)
        || now_ms.saturating_sub(internal_date) > max_age_ms
    {
        return Err(EmailCodeError::MessageNotFresh);
    }

    let payload = message
        .get("payload")
        .filter(|payload| payload.is_object())
        .ok_or(EmailCodeError::MessageUnavailable)?;
    let headers = part_headers(payload)?;

    let from = single_header(&headers, "from")?
        .and_then(parse_single_address)
        .ok_or(EmailCodeError::MessageUnavailable)?;
    let from_domain = address_domain(&from);

    let route = if grant.relay_senders.iter().any(|sender| *sender == from) {
        let original_sender = single_header(&headers, "reply-to")
            .ok()
            .flatten()
            .and_then(parse_single_address)
            .ok_or(EmailCodeError::SenderUntrusted)?;
        if !grant
            .sender_domains
            .iter()
            .any(|domain| domain == address_domain(&original_sender))
        {
            return Err(EmailCodeError::SenderUntrusted);
        }
        SenderRoute::Relay
    } else if grant
        .sender_domains
        .iter()
        .any(|domain| domain == from_domain)
    {
        SenderRoute::Direct
    } else {
        return Err(EmailCodeError::SenderUntrusted);
    };

    if !gmail_authenticates_sender(&headers, from_domain) {
        return Err(EmailCodeError::SenderUnauthenticated);
    }

    let subject = match single_header(&headers, "subject")? {
        Some(subject) => normalize_text(
            &decode_encoded_words(subject).ok_or(EmailCodeError::MessageUnavailable)?,
        ),
        None => String::new(),
    };
    let mut texts = MessageTexts::default();
    collect_text_parts(payload, 0, &mut texts)?;

    let addressed_in_headers = headers
        .iter()
        .filter(|(name, _)| RECIPIENT_HEADERS.contains(&name.as_str()))
        .filter_map(|(_, value)| parse_address_list(value))
        .flatten()
        .any(|address| address == grant.recipient);
    let addressed = match route {
        SenderRoute::Direct => addressed_in_headers,
        SenderRoute::Relay => {
            addressed_in_headers
                || contains_address_token(&subject, &grant.recipient)
                || texts
                    .plain
                    .iter()
                    .chain(texts.html.iter())
                    .any(|text| contains_address_token(text, &grant.recipient))
        }
    };
    if !addressed {
        return Err(EmailCodeError::RecipientMismatch);
    }

    extract_code(&grant.code_pattern, &subject, &texts)
}

/// Prefers the Subject and text/plain parts; visible HTML text is consulted
/// only when neither yields a candidate. Raw HTML markup is never scanned.
fn extract_code(
    pattern: &Regex,
    subject: &str,
    texts: &MessageTexts,
) -> Result<String, EmailCodeError> {
    let mut codes = Vec::new();
    collect_codes(pattern, subject, false, &mut codes)?;
    for text in &texts.plain {
        collect_codes(pattern, text, false, &mut codes)?;
    }
    if codes.is_empty() {
        for text in &texts.html {
            collect_codes(pattern, text, true, &mut codes)?;
        }
    }
    match codes.len() {
        0 => Err(EmailCodeError::CodeNotFound),
        1 => Ok(codes.remove(0)),
        _ => Err(EmailCodeError::CodeAmbiguous),
    }
}

fn collect_codes(
    pattern: &Regex,
    text: &str,
    from_html: bool,
    codes: &mut Vec<String>,
) -> Result<(), EmailCodeError> {
    for captures in pattern.captures_iter(text) {
        let capture = captures.get(1).ok_or(EmailCodeError::CodeNotFound)?;
        // A '#'-prefixed token in HTML-derived text is a color or anchor
        // reference, never a verification code.
        if from_html && text[..capture.start()].ends_with('#') {
            continue;
        }
        let code = capture.as_str();
        if !(MIN_CODE_CHARS..=MAX_CODE_CHARS).contains(&code.len())
            || !code.bytes().all(|byte| byte.is_ascii_alphanumeric())
        {
            return Err(EmailCodeError::CodeNotFound);
        }
        if !codes.iter().any(|existing| existing == code) {
            codes.push(code.to_string());
        }
    }
    Ok(())
}

#[derive(Default)]
struct MessageTexts {
    plain: Vec<String>,
    html: Vec<String>,
    decoded_bytes: usize,
}

fn part_headers(part: &Value) -> Result<Vec<(String, String)>, EmailCodeError> {
    let Some(headers) = part.get("headers") else {
        return Ok(Vec::new());
    };
    headers
        .as_array()
        .ok_or(EmailCodeError::MessageUnavailable)?
        .iter()
        .map(|header| {
            let name = header.get("name").and_then(Value::as_str);
            let value = header.get("value").and_then(Value::as_str);
            match (name, value) {
                (Some(name), Some(value)) => Ok((name.to_ascii_lowercase(), value.to_string())),
                _ => Err(EmailCodeError::MessageUnavailable),
            }
        })
        .collect()
}

/// Returns the only header with `name`, `None` when absent, and an error when
/// the header is duplicated (a classic spoofing vector).
fn single_header<'a>(
    headers: &'a [(String, String)],
    name: &str,
) -> Result<Option<&'a str>, EmailCodeError> {
    let mut matches = headers.iter().filter(|(header, _)| header == name);
    let first = matches.next().map(|(_, value)| value.as_str());
    if matches.next().is_some() {
        return Err(EmailCodeError::MessageUnavailable);
    }
    Ok(first)
}

fn collect_text_parts(
    part: &Value,
    depth: usize,
    texts: &mut MessageTexts,
) -> Result<(), EmailCodeError> {
    if depth > MAX_MIME_DEPTH {
        return Err(EmailCodeError::MessageUnavailable);
    }
    let mut part_count = 0;
    collect_text_parts_inner(part, depth, texts, &mut part_count)
}

fn collect_text_parts_inner(
    part: &Value,
    depth: usize,
    texts: &mut MessageTexts,
    part_count: &mut usize,
) -> Result<(), EmailCodeError> {
    *part_count += 1;
    if depth > MAX_MIME_DEPTH || *part_count > MAX_MIME_PARTS {
        return Err(EmailCodeError::MessageUnavailable);
    }
    if let Some(parts) = part.get("parts") {
        for child in parts.as_array().ok_or(EmailCodeError::MessageUnavailable)? {
            collect_text_parts_inner(child, depth + 1, texts, part_count)?;
        }
        return Ok(());
    }
    let mime_type = part
        .get("mimeType")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_ascii_lowercase();
    let is_plain = mime_type == "text/plain";
    let is_html = mime_type == "text/html";
    if !is_plain && !is_html {
        return Ok(());
    }
    let headers = part_headers(part)?;
    let is_attachment = part
        .get("filename")
        .and_then(Value::as_str)
        .is_some_and(|filename| !filename.is_empty())
        || headers.iter().any(|(name, value)| {
            name == "content-disposition"
                && value
                    .trim_start()
                    .get(..10)
                    .is_some_and(|prefix| prefix.eq_ignore_ascii_case("attachment"))
        });
    if is_attachment {
        return Ok(());
    }
    let body = part.get("body");
    let Some(data) = body
        .and_then(|body| body.get("data"))
        .and_then(Value::as_str)
    else {
        // Inline text that Gmail moved out of line cannot be inspected, and
        // skipping it could hide a conflicting candidate: fail closed.
        if body.and_then(|body| body.get("attachmentId")).is_some() {
            return Err(EmailCodeError::MessageUnavailable);
        }
        return Ok(());
    };
    let bytes = GMAIL_BASE64
        .decode(data)
        .map_err(|_| EmailCodeError::MessageUnavailable)?;
    texts.decoded_bytes += bytes.len();
    if texts.decoded_bytes > MAX_DECODED_TEXT_BYTES {
        return Err(EmailCodeError::MessageUnavailable);
    }
    let charset = headers
        .iter()
        .find(|(name, _)| name == "content-type")
        .and_then(|(_, value)| content_type_charset(value));
    let text =
        decode_charset(&bytes, charset.as_deref()).ok_or(EmailCodeError::MessageUnavailable)?;
    if is_plain {
        texts.plain.push(normalize_text(&text));
    } else {
        texts.html.push(normalize_text(&html_to_text(&text)));
    }
    Ok(())
}

fn content_type_charset(value: &str) -> Option<String> {
    for parameter in split_top_level(value, ';').into_iter().skip(1) {
        let Some((name, raw)) = parameter.split_once('=') else {
            continue;
        };
        if name.trim().eq_ignore_ascii_case("charset") {
            return Some(raw.trim().trim_matches('"').to_ascii_lowercase());
        }
    }
    None
}

/// Strict charset decoding. Unknown charsets fail closed rather than
/// exposing undecoded bytes to the code pattern.
fn decode_charset(bytes: &[u8], charset: Option<&str>) -> Option<String> {
    match charset.unwrap_or("utf-8") {
        "utf-8" | "utf8" | "us-ascii" | "ascii" => String::from_utf8(bytes.to_vec()).ok(),
        "iso-8859-1" | "iso8859-1" | "latin1" | "latin-1" | "l1" | "windows-1252" | "cp1252" => {
            Some(bytes.iter().map(|byte| char::from(*byte)).collect())
        }
        _ => None,
    }
}

/// Removes invisible characters that only split visible tokens and maps
/// non-breaking spaces to spaces.
fn normalize_text(text: &str) -> String {
    text.chars()
        .filter(|character| {
            !matches!(
                character,
                '\u{00AD}' | '\u{200B}' | '\u{200C}' | '\u{200D}' | '\u{2060}' | '\u{FEFF}'
            )
        })
        .map(|character| {
            if character == '\u{00A0}' {
                ' '
            } else {
                character
            }
        })
        .collect()
}

/// Decodes RFC 2047 encoded words in an unstructured header. Returns `None`
/// for an encoded word in an unsupported charset or with invalid encoding.
fn decode_encoded_words(value: &str) -> Option<String> {
    static ENCODED_WORD: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(r"=\?([^?\s]+)\?([BbQq])\?([^?\s]*)\?=").expect("static encoded-word pattern")
    });
    let pattern = &*ENCODED_WORD;
    let mut decoded = String::with_capacity(value.len());
    let mut cursor = 0;
    let mut previous_was_word = false;
    for captures in pattern.captures_iter(value) {
        let whole = captures.get(0)?;
        let gap = &value[cursor..whole.start()];
        if !(previous_was_word && gap.chars().all(char::is_whitespace)) {
            decoded.push_str(gap);
        }
        let charset = captures[1].split('*').next()?.to_ascii_lowercase();
        let text = &captures[3];
        let bytes = if captures[2].eq_ignore_ascii_case("b") {
            MIME_BASE64.decode(text).ok()?
        } else {
            decode_q_encoding(text)?
        };
        decoded.push_str(&decode_charset(&bytes, Some(charset.as_str()))?);
        cursor = whole.end();
        previous_was_word = true;
    }
    decoded.push_str(&value[cursor..]);
    Some(decoded)
}

fn decode_q_encoding(text: &str) -> Option<Vec<u8>> {
    let bytes = text.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        match bytes[index] {
            b'_' => {
                decoded.push(b' ');
                index += 1;
            }
            b'=' => {
                let high = hex_value(*bytes.get(index + 1)?)?;
                let low = hex_value(*bytes.get(index + 2)?)?;
                decoded.push((high << 4) | low);
                index += 3;
            }
            byte => {
                decoded.push(byte);
                index += 1;
            }
        }
    }
    Some(decoded)
}

/// Converts HTML to its visible text without executing or fetching anything:
/// comments, declarations, and the contents of non-rendered elements are
/// dropped, every tag (and so every attribute or inline style) is removed,
/// block boundaries become newlines, and character references are decoded.
fn html_to_text(html: &str) -> String {
    const SKIPPED_ELEMENTS: &[&str] = &[
        "script", "style", "head", "title", "noscript", "template", "svg", "math", "object",
        "iframe", "xml",
    ];
    const BLOCK_ELEMENTS: &[&str] = &[
        "address",
        "article",
        "aside",
        "blockquote",
        "br",
        "center",
        "dd",
        "div",
        "dl",
        "dt",
        "footer",
        "form",
        "h1",
        "h2",
        "h3",
        "h4",
        "h5",
        "h6",
        "header",
        "hr",
        "li",
        "main",
        "nav",
        "ol",
        "p",
        "pre",
        "section",
        "table",
        "tbody",
        "td",
        "tfoot",
        "th",
        "thead",
        "tr",
        "ul",
        "caption",
        "img",
    ];
    let lower = html.to_ascii_lowercase();
    let bytes = html.as_bytes();
    let mut text = String::with_capacity(html.len().min(MAX_DECODED_TEXT_BYTES));
    let mut index = 0;
    let mut text_start = 0;
    while index < bytes.len() {
        if bytes[index] != b'<' {
            index += 1;
            continue;
        }
        let rest = &lower[index..];
        let name_offset = usize::from(rest.as_bytes().get(1) == Some(&b'/')) + 1;
        let name_bytes = &rest.as_bytes()[name_offset..];
        let name_length = if name_bytes.first().is_some_and(u8::is_ascii_alphabetic) {
            name_bytes
                .iter()
                .take_while(|byte| byte.is_ascii_alphanumeric())
                .count()
        } else {
            0
        };
        let is_markup = rest.starts_with("<!") || rest.starts_with("<?") || name_length > 0;
        if !is_markup {
            index += 1;
            continue;
        }
        text.push_str(&decode_html_entities(&html[text_start..index]));
        if rest.starts_with("<!--") {
            index = rest[4..]
                .find("-->")
                .map_or(bytes.len(), |end| index + 4 + end + 3);
        } else if name_length == 0 {
            index = rest.find('>').map_or(bytes.len(), |end| index + end + 1);
        } else {
            let closing = name_offset == 2;
            let name = &rest[name_offset..name_offset + name_length];
            let tag_end = find_tag_end(&bytes[index..]).map_or(bytes.len(), |end| index + end + 1);
            let self_closing = lower[index..tag_end].trim_end_matches('>').ends_with('/');
            index = tag_end;
            if !closing && !self_closing && SKIPPED_ELEMENTS.contains(&name) {
                let closing_tag = format!("</{name}");
                index = lower[index..]
                    .find(&closing_tag)
                    .map_or(bytes.len(), |start| {
                        let after = index + start;
                        lower[after..]
                            .find('>')
                            .map_or(bytes.len(), |end| after + end + 1)
                    });
            } else if BLOCK_ELEMENTS.contains(&name) {
                text.push('\n');
            }
        }
        text_start = index;
    }
    if text_start < bytes.len() {
        text.push_str(&decode_html_entities(&html[text_start..]));
    }
    text
}

/// Finds the closing `>` of a tag, ignoring `>` inside quoted attributes.
fn find_tag_end(bytes: &[u8]) -> Option<usize> {
    let mut quote = None;
    for (offset, byte) in bytes.iter().enumerate().skip(1) {
        match (quote, byte) {
            (Some(open), _) if *byte == open => quote = None,
            (Some(_), _) => {}
            (None, b'"' | b'\'') => quote = Some(*byte),
            (None, b'>') => return Some(offset),
            _ => {}
        }
    }
    None
}

fn decode_html_entities(text: &str) -> String {
    let mut decoded = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(start) = rest.find('&') {
        decoded.push_str(&rest[..start]);
        let candidate = &rest[start + 1..];
        let end = candidate
            .char_indices()
            .take(32)
            .find(|(_, character)| *character == ';')
            .map(|(offset, _)| offset);
        let replacement = end.and_then(|end| {
            let entity = &candidate[..end];
            let character = if let Some(number) = entity.strip_prefix('#') {
                let value = match number.strip_prefix(['x', 'X']) {
                    Some(hex) => u32::from_str_radix(hex, 16).ok(),
                    None => number.parse::<u32>().ok(),
                };
                value.and_then(char::from_u32)
            } else {
                match entity {
                    "amp" => Some('&'),
                    "lt" => Some('<'),
                    "gt" => Some('>'),
                    "quot" => Some('"'),
                    "apos" => Some('\''),
                    "nbsp" => Some('\u{00A0}'),
                    "zwnj" => Some('\u{200C}'),
                    "zwj" => Some('\u{200D}'),
                    "shy" => Some('\u{00AD}'),
                    _ => None,
                }
            };
            character.map(|character| (character, end))
        });
        match replacement {
            Some((character, end)) => {
                decoded.push(character);
                rest = &candidate[end + 1..];
            }
            None => {
                decoded.push('&');
                rest = candidate;
            }
        }
    }
    decoded.push_str(rest);
    decoded
}

/// Requires Gmail's own, topmost `Authentication-Results` (authserv-id
/// `mx.google.com`) to report a DKIM pass aligned with the From domain and a
/// DMARC pass for exactly that From domain. Lower `Authentication-Results`
/// headers were supplied by upstream hops or the sender and are ignored.
fn gmail_authenticates_sender(headers: &[(String, String)], from_domain: &str) -> bool {
    let Some(value) = headers
        .iter()
        .find(|(name, _)| name == "authentication-results")
        .map(|(_, value)| value)
    else {
        return false;
    };
    let Some(cleaned) = strip_comments(value) else {
        return false;
    };
    let mut segments = split_top_level(&cleaned, ';').into_iter();
    let authserv_id = segments.next().and_then(|segment| {
        segment
            .split_whitespace()
            .next()
            .map(str::to_ascii_lowercase)
    });
    if authserv_id.as_deref() != Some(GMAIL_AUTHSERV_ID) {
        return false;
    }
    let mut dkim_aligned = false;
    let mut dmarc_seen = false;
    let mut dmarc_pass = true;
    for segment in segments {
        let mut tokens = segment.split_whitespace();
        let Some((method, result)) = tokens.next().and_then(|token| token.split_once('=')) else {
            continue;
        };
        let method = method
            .split('/')
            .next()
            .unwrap_or_default()
            .to_ascii_lowercase();
        let result = result.to_ascii_lowercase();
        let property = |key: &str| {
            segment
                .split_whitespace()
                .skip(1)
                .filter_map(|token| token.split_once('='))
                .find(|(name, _)| name.eq_ignore_ascii_case(key))
                .map(|(_, value)| value.trim_matches('"').to_ascii_lowercase())
        };
        match method.as_str() {
            "dkim" if result == "pass" => {
                let signing_domain = property("header.d").or_else(|| {
                    property("header.i").and_then(|identity| {
                        identity
                            .rsplit_once('@')
                            .map(|(_, domain)| domain.to_string())
                    })
                });
                if signing_domain.is_some_and(|domain| dkim_domain_aligned(&domain, from_domain)) {
                    dkim_aligned = true;
                }
            }
            "dmarc" => {
                dmarc_seen = true;
                if result != "pass" || property("header.from").as_deref() != Some(from_domain) {
                    dmarc_pass = false;
                }
            }
            _ => {}
        }
    }
    dkim_aligned && dmarc_seen && dmarc_pass
}

fn dkim_domain_aligned(signing_domain: &str, from_domain: &str) -> bool {
    signing_domain == from_domain
        || (signing_domain.contains('.')
            && from_domain
                .strip_suffix(signing_domain)
                .is_some_and(|prefix| prefix.ends_with('.')))
}

/// Removes RFC 5322 comments outside quoted strings. Returns `None` for
/// unbalanced comments or quotes.
fn strip_comments(value: &str) -> Option<String> {
    let mut cleaned = String::with_capacity(value.len());
    let mut depth = 0_usize;
    let mut in_quote = false;
    let mut escaped = false;
    for character in value.chars() {
        if escaped {
            if depth == 0 {
                cleaned.push(character);
            }
            escaped = false;
            continue;
        }
        match character {
            '\\' if in_quote || depth > 0 => {
                escaped = true;
                if depth == 0 {
                    cleaned.push(character);
                }
            }
            '"' if depth == 0 => {
                in_quote = !in_quote;
                cleaned.push(character);
            }
            '(' if !in_quote => depth += 1,
            ')' if !in_quote => {
                depth = depth.checked_sub(1)?;
                if depth == 0 {
                    cleaned.push(' ');
                }
            }
            _ if depth == 0 => cleaned.push(character),
            _ => {}
        }
    }
    (depth == 0 && !in_quote).then_some(cleaned)
}

/// Splits on `separator` outside quoted strings and angle brackets.
fn split_top_level(value: &str, separator: char) -> Vec<&str> {
    let mut parts = Vec::new();
    let mut start = 0;
    let mut in_quote = false;
    let mut escaped = false;
    let mut angle = 0_usize;
    for (offset, character) in value.char_indices() {
        if escaped {
            escaped = false;
            continue;
        }
        match character {
            '\\' if in_quote => escaped = true,
            '"' => in_quote = !in_quote,
            '<' if !in_quote => angle += 1,
            '>' if !in_quote => angle = angle.saturating_sub(1),
            _ if character == separator && !in_quote && angle == 0 => {
                parts.push(&value[start..offset]);
                start = offset + character.len_utf8();
            }
            _ => {}
        }
    }
    parts.push(&value[start..]);
    parts
}

/// Parses an RFC 5322 address list into normalized (lowercase) addresses.
/// Returns `None` when any member is malformed.
fn parse_address_list(value: &str) -> Option<Vec<String>> {
    let cleaned = strip_comments(value)?;
    let mut addresses = Vec::new();
    for member in split_top_level(&cleaned, ',') {
        let member = match split_top_level(member, ':').as_slice() {
            [_, after] => *after,
            [only] => *only,
            _ => return None,
        };
        let member = member.trim().trim_end_matches(';').trim();
        if member.is_empty() {
            continue;
        }
        let address = match outside_quotes_find(member, '<') {
            Some(open) => {
                let inner = &member[open + 1..];
                let close = inner.find('>')?;
                if !inner[close + 1..].trim().is_empty() {
                    return None;
                }
                &inner[..close]
            }
            None => member,
        };
        addresses.push(normalize_email(address.trim())?);
    }
    Some(addresses)
}

fn outside_quotes_find(value: &str, needle: char) -> Option<usize> {
    let mut in_quote = false;
    let mut escaped = false;
    for (offset, character) in value.char_indices() {
        if escaped {
            escaped = false;
            continue;
        }
        match character {
            '\\' if in_quote => escaped = true,
            '"' => in_quote = !in_quote,
            _ if character == needle && !in_quote => return Some(offset),
            _ => {}
        }
    }
    None
}

fn parse_single_address(value: &str) -> Option<String> {
    match parse_address_list(value)?.as_slice() {
        [address] => Some(address.clone()),
        _ => None,
    }
}

fn address_domain(address: &str) -> &str {
    address.rsplit_once('@').map_or("", |(_, domain)| domain)
}

/// Validates one bounded dot-atom email address and returns it lowercased.
fn normalize_email(value: &str) -> Option<String> {
    if !(MIN_EMAIL_CHARS..=MAX_EMAIL_CHARS).contains(&value.len()) {
        return None;
    }
    let (local, domain) = value.split_once('@')?;
    if local.is_empty()
        || local.len() > MAX_LOCAL_PART_CHARS
        || local.starts_with('.')
        || local.ends_with('.')
        || local.contains("..")
        || !local
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b".!#$%&'*+/=?^_`{|}~-".contains(&byte))
        || !is_valid_domain(&domain.to_ascii_lowercase())
    {
        return None;
    }
    Some(value.to_ascii_lowercase())
}

fn is_valid_domain(domain: &str) -> bool {
    let labels = domain.split('.').collect::<Vec<_>>();
    !domain.is_empty()
        && domain.len() <= MAX_DOMAIN_CHARS
        && labels.len() >= 2
        && labels.iter().all(|label| {
            !label.is_empty()
                && label.len() <= 63
                && !label.starts_with('-')
                && !label.ends_with('-')
                && label
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
        })
}

/// Mailbox identity key: lowercase, with Gmail's dot-insensitive local part
/// collapsed only for gmail.com and googlemail.com.
fn mailbox_key(value: &str) -> Option<String> {
    let address = normalize_email(value)?;
    let (local, domain) = address.split_once('@')?;
    if matches!(domain, "gmail.com" | "googlemail.com") {
        Some(format!("{}@{domain}", local.replace('.', "")))
    } else {
        Some(address)
    }
}

/// True when `address` (lowercase) appears in `text` as a whole address, not
/// as part of a longer local part or domain.
fn contains_address_token(text: &str, address: &str) -> bool {
    let haystack = text.to_ascii_lowercase();
    haystack.match_indices(address).any(|(start, _)| {
        let before_ok = haystack[..start]
            .chars()
            .next_back()
            .is_none_or(|character| {
                !(character.is_ascii_alphanumeric() || ".!#$%&'*+/=?^_`{|}~-".contains(character))
            });
        let mut after = haystack[start + address.len()..].chars();
        let after_ok = match after.next() {
            None => true,
            Some('.') => after
                .next()
                .is_none_or(|character| !(character.is_ascii_alphanumeric() || character == '-')),
            Some(character) => {
                !(character.is_ascii_alphanumeric() || matches!(character, '-' | '_' | '@'))
            }
        };
        before_ok && after_ok
    })
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use base64::engine::general_purpose::URL_SAFE_NO_PAD;
    use parking_lot::Mutex;

    const NOW_MS: u64 = 1_800_000_000_000;
    pub(crate) const MESSAGE_ID: &str = "18c0ffee0000abcd";
    pub(crate) const ORIGIN: &str = "https://id.service.example";
    pub(crate) const PATH: &str = "/signup/verify-email/otp";
    pub(crate) const MAILBOX: &str = "synthetic.owner@gmail.com";
    pub(crate) const DIRECT_RECIPIENT: &str = "synthetic.owner+svc@gmail.com";
    const RELAY_RECIPIENT: &str = "member-alias@relay.example";
    const RELAY_SENDER: &str = "forwarder@relay.example";
    const CODE_PATTERN: &str = r"(?i:code)(?: is)?:?\s+([A-Z0-9]{6})\b";
    const AUTH_PASS_SERVICE: &str = "mx.google.com; dkim=pass header.i=@service.example header.s=s1 header.b=AbCdEf; spf=pass (google.com: domain of bounce@service.example designates 192.0.2.1 as permitted sender; extra) smtp.mailfrom=bounce@service.example; dmarc=pass (p=REJECT sp=REJECT dis=NONE) header.from=service.example";
    const AUTH_PASS_RELAY: &str = "mx.google.com; dkim=pass header.i=@relay.example header.s=s1 header.b=XyZ; spf=pass smtp.mailfrom=bounce@relay.example; dmarc=pass (p=QUARANTINE) header.from=relay.example";
    /// Absolute on every platform so policy validation accepts it on Windows too.
    pub(crate) const FIXTURE_GWS: &str = if cfg!(windows) {
        r"C:\fixture\bin\gws.exe"
    } else {
        "/opt/fixture/bin/gws"
    };

    fn fixed_now() -> u64 {
        NOW_MS
    }

    #[derive(Default)]
    pub(crate) struct FakeProvider {
        profile: Option<Value>,
        message: Option<Value>,
        pub(crate) calls: Mutex<Vec<String>>,
    }

    impl MailProvider for FakeProvider {
        fn profile(&self, _deadline: Instant) -> Result<Value, ProviderError> {
            self.calls.lock().push("profile".into());
            self.profile.clone().ok_or(ProviderError::Unavailable)
        }

        fn message(&self, message_id: &str, _deadline: Instant) -> Result<Value, ProviderError> {
            self.calls.lock().push(format!("message:{message_id}"));
            self.message.clone().ok_or(ProviderError::Unavailable)
        }
    }

    pub(crate) fn grant() -> EmailCodeGrant {
        EmailCodeGrant {
            origin: ORIGIN.into(),
            paths: vec![PATH.into()],
            recipient: DIRECT_RECIPIENT.into(),
            purposes: vec!["signup".into()],
            sender_domains: vec!["service.example".into()],
            relay_senders: Vec::new(),
            code_pattern: CODE_PATTERN.into(),
        }
    }

    fn relay_grant() -> EmailCodeGrant {
        EmailCodeGrant {
            recipient: RELAY_RECIPIENT.into(),
            relay_senders: vec![RELAY_SENDER.into()],
            ..grant()
        }
    }

    pub(crate) fn policy(grants: Vec<EmailCodeGrant>) -> EmailCodePolicy {
        EmailCodePolicy {
            enabled: true,
            executable: Some(PathBuf::from(FIXTURE_GWS)),
            mailbox: Some(MAILBOX.into()),
            grants,
            ..EmailCodePolicy::default()
        }
    }

    fn request(recipient: &str) -> EmailCodeRequest<'_> {
        EmailCodeRequest {
            origin: ORIGIN,
            path: PATH,
            recipient,
            purpose: "signup",
            message_id: MESSAGE_ID,
        }
    }

    fn encode(text: &str) -> String {
        URL_SAFE_NO_PAD.encode(text)
    }

    fn text_part(mime_type: &str, body: &str) -> Value {
        json!({
            "mimeType": mime_type,
            "filename": "",
            "headers": [{ "name": "Content-Type", "value": format!("{mime_type}; charset=\"UTF-8\"") }],
            "body": { "size": body.len(), "data": encode(body) }
        })
    }

    fn message_with(headers: &[(&str, &str)], parts: Vec<Value>, internal_date: u64) -> Value {
        let headers = headers
            .iter()
            .map(|(name, value)| json!({ "name": name, "value": value }))
            .collect::<Vec<_>>();
        json!({
            "id": MESSAGE_ID,
            "threadId": MESSAGE_ID,
            "labelIds": ["INBOX", "UNREAD"],
            "internalDate": internal_date.to_string(),
            "payload": {
                "mimeType": "multipart/alternative",
                "filename": "",
                "headers": headers,
                "body": { "size": 0 },
                "parts": parts
            }
        })
    }

    fn direct_headers<'a>(subject: &'a str, to: &'a str) -> Vec<(&'a str, &'a str)> {
        vec![
            ("Delivered-To", MAILBOX),
            ("Authentication-Results", AUTH_PASS_SERVICE),
            ("From", "\"Service Accounts\" <noreply@service.example>"),
            ("To", to),
            ("Subject", subject),
        ]
    }

    pub(crate) fn direct_message(subject: &str, plain: &str) -> Value {
        message_with(
            &direct_headers(subject, DIRECT_RECIPIENT),
            vec![
                text_part("text/plain", plain),
                text_part(
                    "text/html",
                    "<html><head><style>.c{color:#A1B2C3}</style></head><body><p>Your code is <b>QX7K2M</b></p></body></html>",
                ),
            ],
            NOW_MS - 60_000,
        )
    }

    fn relay_message(subject: &str, reply_to: &str, authentication: &str) -> Value {
        message_with(
            &[
                ("Delivered-To", MAILBOX),
                ("Authentication-Results", authentication),
                ("From", "\"Service via Relay\" <forwarder@relay.example>"),
                ("Reply-To", reply_to),
                ("To", MAILBOX),
                ("Subject", subject),
            ],
            vec![text_part("text/plain", "Your verification code is QX7K2M")],
            NOW_MS - 60_000,
        )
    }

    pub(crate) fn broker_with(
        policy: EmailCodePolicy,
        provider: Arc<FakeProvider>,
    ) -> EmailCodeBroker {
        EmailCodeBroker::with_parts(policy, provider, fixed_now)
    }

    pub(crate) fn provider_for(message: Value) -> Arc<FakeProvider> {
        Arc::new(FakeProvider {
            profile: Some(json!({ "emailAddress": MAILBOX, "messagesTotal": 3 })),
            message: Some(message),
            calls: Mutex::new(Vec::new()),
        })
    }

    fn resolve_direct(message: Value) -> Result<String, EmailCodeError> {
        broker_with(policy(vec![grant()]), provider_for(message)).resolve(request(DIRECT_RECIPIENT))
    }

    fn resolve_relay(message: Value) -> Result<String, EmailCodeError> {
        broker_with(policy(vec![relay_grant()]), provider_for(message))
            .resolve(request(RELAY_RECIPIENT))
    }

    #[test]
    fn policy_is_disabled_by_default_and_enabling_requires_complete_configuration() {
        let defaults = EmailCodePolicy::default();
        assert!(!defaults.enabled);
        assert!(defaults.validate().is_ok());

        assert!(policy(vec![grant()]).validate().is_ok());
        for broken in [
            EmailCodePolicy {
                executable: None,
                ..policy(vec![grant()])
            },
            EmailCodePolicy {
                executable: Some(PathBuf::from("gws")),
                ..policy(vec![grant()])
            },
            EmailCodePolicy {
                mailbox: None,
                ..policy(vec![grant()])
            },
            EmailCodePolicy {
                mailbox: Some("not-an-address".into()),
                ..policy(vec![grant()])
            },
            EmailCodePolicy {
                max_age_ms: 29_999,
                ..policy(vec![grant()])
            },
            EmailCodePolicy {
                max_age_ms: 900_001,
                ..policy(vec![grant()])
            },
            EmailCodePolicy {
                timeout_ms: 4_999,
                ..policy(vec![grant()])
            },
            EmailCodePolicy {
                timeout_ms: 120_001,
                ..policy(vec![grant()])
            },
            policy(Vec::new()),
        ] {
            assert!(broken.validate().is_err(), "{broken:?}");
        }

        let unknown = serde_json::from_value::<EmailCodePolicy>(
            json!({ "enabled": false, "query": "in:inbox" }),
        );
        assert!(unknown.is_err());
        let unknown_grant = serde_json::from_value::<EmailCodePolicy>(json!({
            "grants": [{
                "origin": ORIGIN, "paths": [PATH], "recipient": DIRECT_RECIPIENT,
                "purposes": ["signup"], "sender_domains": ["service.example"],
                "code_pattern": CODE_PATTERN, "path_prefix": "/"
            }]
        }));
        assert!(unknown_grant.is_err());
    }

    #[test]
    fn grant_validation_requires_exact_secure_origins_and_paths() {
        let invalid_origins = [
            "https://*.service.example",
            "https://id.service.example/",
            "https://id.service.example/signup",
            "https://user@id.service.example",
            "https://ID.service.example",
            "https://id.service.example:443",
            "http://id.service.example",
            "ftp://id.service.example",
            "id.service.example",
        ];
        for origin in invalid_origins {
            let candidate = EmailCodeGrant {
                origin: origin.into(),
                ..grant()
            };
            assert!(policy(vec![candidate]).validate().is_err(), "{origin}");
        }
        for origin in [
            "http://127.0.0.1:8080",
            "http://localhost:3000",
            "http://[::1]:9000",
        ] {
            let candidate = EmailCodeGrant {
                origin: origin.into(),
                ..grant()
            };
            assert!(policy(vec![candidate]).validate().is_ok(), "{origin}");
        }

        let invalid_paths = [
            "",
            "signup/verify-email/otp",
            "/signup/*",
            "/signup/verify-email/otp?step=1",
            "/signup/verify-email/otp#code",
            "/signup/../verify-email/otp",
            "//evil.example/otp",
            "/signup/verify email",
        ];
        for path in invalid_paths {
            let candidate = EmailCodeGrant {
                paths: vec![path.into()],
                ..grant()
            };
            assert!(policy(vec![candidate]).validate().is_err(), "{path:?}");
        }
        let duplicate = EmailCodeGrant {
            paths: vec![PATH.into(), PATH.into()],
            ..grant()
        };
        assert!(policy(vec![duplicate]).validate().is_err());
    }

    #[test]
    fn grant_validation_refuses_second_factor_paths_but_allows_email_otp_pages() {
        for path in [
            "/login/mfa/verify",
            "/account/2fa",
            "/two-factor/challenge",
            "/security/two_factor",
            "/auth/authenticator",
            "/verify/totp",
            "/login/2-step",
            "/webauthn/assert",
            "/security-key/verify",
            "/login/%6Dfa",
        ] {
            let candidate = EmailCodeGrant {
                paths: vec![path.into()],
                ..grant()
            };
            let error = policy(vec![candidate]).validate().unwrap_err();
            assert!(error.contains("MFA"), "{path}: {error}");
        }
        for path in [PATH, "/login/email-code", "/verify/email"] {
            let candidate = EmailCodeGrant {
                paths: vec![path.into()],
                ..grant()
            };
            assert!(policy(vec![candidate]).validate().is_ok(), "{path}");
        }
    }

    #[test]
    fn grant_validation_bounds_purposes_senders_patterns_and_overlap() {
        let cases = [
            EmailCodeGrant {
                purposes: Vec::new(),
                ..grant()
            },
            EmailCodeGrant {
                purposes: vec!["password_reset".into()],
                ..grant()
            },
            EmailCodeGrant {
                purposes: vec!["signup".into(), "signup".into()],
                ..grant()
            },
            EmailCodeGrant {
                sender_domains: Vec::new(),
                ..grant()
            },
            EmailCodeGrant {
                sender_domains: vec!["Service.example".into()],
                ..grant()
            },
            EmailCodeGrant {
                sender_domains: vec!["*.service.example".into()],
                ..grant()
            },
            EmailCodeGrant {
                sender_domains: vec!["example".into()],
                ..grant()
            },
            EmailCodeGrant {
                relay_senders: vec!["Forwarder@relay.example".into()],
                ..grant()
            },
            EmailCodeGrant {
                relay_senders: vec!["relay.example".into()],
                ..grant()
            },
            EmailCodeGrant {
                recipient: "no-at-sign".into(),
                ..grant()
            },
            EmailCodeGrant {
                recipient: "a\r\nb@service.example".into(),
                ..grant()
            },
            EmailCodeGrant {
                code_pattern: r"[A-Z0-9]{6}".into(),
                ..grant()
            },
            EmailCodeGrant {
                code_pattern: r"([A-Z]{3})([0-9]{3})".into(),
                ..grant()
            },
            EmailCodeGrant {
                code_pattern: r"([A-Z".into(),
                ..grant()
            },
            EmailCodeGrant {
                code_pattern: "x".repeat(MAX_PATTERN_CHARS + 1),
                ..grant()
            },
        ];
        for candidate in cases {
            assert!(
                policy(vec![candidate.clone()]).validate().is_err(),
                "{candidate:?}"
            );
        }
        let overlapping = EmailCodeGrant {
            recipient: DIRECT_RECIPIENT.to_ascii_uppercase(),
            purposes: vec!["email_sign_in".into(), "signup".into()],
            ..grant()
        };
        assert!(policy(vec![grant(), overlapping]).validate().is_err());
        let distinct_purpose = EmailCodeGrant {
            purposes: vec!["email_sign_in".into()],
            ..grant()
        };
        assert!(policy(vec![grant(), distinct_purpose]).validate().is_ok());
    }

    #[test]
    fn invalid_or_disabled_policy_never_invokes_the_provider() {
        let provider = provider_for(direct_message("Your code is QX7K2M", "Your code is QX7K2M"));
        let disabled = EmailCodePolicy {
            enabled: false,
            ..policy(vec![grant()])
        };
        assert_eq!(
            broker_with(disabled, provider.clone()).resolve(request(DIRECT_RECIPIENT)),
            Err(EmailCodeError::Disabled)
        );
        let invalid = EmailCodePolicy {
            timeout_ms: 1,
            ..policy(vec![grant()])
        };
        assert_eq!(
            broker_with(invalid, provider.clone()).resolve(request(DIRECT_RECIPIENT)),
            Err(EmailCodeError::PolicyInvalid)
        );
        assert!(provider.calls.lock().is_empty());
    }

    #[test]
    fn only_exact_grants_resolve_before_any_mailbox_access() {
        let provider = provider_for(direct_message("Your code is QX7K2M", "Your code is QX7K2M"));
        let broker = broker_with(policy(vec![grant()]), provider.clone());
        let denied = [
            EmailCodeRequest {
                origin: "https://service.example",
                ..request(DIRECT_RECIPIENT)
            },
            EmailCodeRequest {
                origin: "https://id.service.example.evil",
                ..request(DIRECT_RECIPIENT)
            },
            EmailCodeRequest {
                origin: "http://id.service.example",
                ..request(DIRECT_RECIPIENT)
            },
            EmailCodeRequest {
                path: "/signup/verify-email",
                ..request(DIRECT_RECIPIENT)
            },
            EmailCodeRequest {
                path: "/signup/verify-email/otp/",
                ..request(DIRECT_RECIPIENT)
            },
            EmailCodeRequest {
                path: "/signup/verify-email/otp/extra",
                ..request(DIRECT_RECIPIENT)
            },
            EmailCodeRequest {
                path: "/SIGNUP/verify-email/otp",
                ..request(DIRECT_RECIPIENT)
            },
            EmailCodeRequest {
                purpose: "email_sign_in",
                ..request(DIRECT_RECIPIENT)
            },
            request("synthetic.owner+other@gmail.com"),
            request("syntheticowner+svc@gmail.com"),
        ];
        for candidate in denied {
            assert_eq!(
                broker.resolve(candidate),
                Err(EmailCodeError::GrantNotFound)
            );
        }
        for invalid in [
            EmailCodeRequest {
                message_id: "",
                ..request(DIRECT_RECIPIENT)
            },
            EmailCodeRequest {
                message_id: "not-hex!",
                ..request(DIRECT_RECIPIENT)
            },
            EmailCodeRequest {
                message_id: "in:inbox",
                ..request(DIRECT_RECIPIENT)
            },
            EmailCodeRequest {
                purpose: "password_reset",
                ..request(DIRECT_RECIPIENT)
            },
            request("no-address"),
        ] {
            assert_eq!(broker.resolve(invalid), Err(EmailCodeError::InvalidRequest));
        }
        let long_id = "a".repeat(MAX_MESSAGE_ID_CHARS + 1);
        assert_eq!(
            broker.resolve(EmailCodeRequest {
                message_id: &long_id,
                ..request(DIRECT_RECIPIENT)
            }),
            Err(EmailCodeError::InvalidRequest)
        );
        assert!(provider.calls.lock().is_empty());

        assert_eq!(
            broker.resolve(request(&DIRECT_RECIPIENT.to_ascii_uppercase())),
            Ok("QX7K2M".into())
        );
        assert_eq!(
            *provider.calls.lock(),
            vec!["profile".to_string(), format!("message:{MESSAGE_ID}")]
        );
    }

    #[test]
    fn authenticated_mailbox_must_match_before_the_message_is_read() {
        let message = direct_message("Your code is QX7K2M", "Your code is QX7K2M");
        for (address, accepted) in [
            ("synthetic.owner@gmail.com", true),
            ("syntheticowner@gmail.com", true),
            ("Synthetic.Owner@Gmail.com", true),
            ("synthetic.owner+x@gmail.com", false),
            ("synthetic.owner@googlemail.com", false),
            ("other.owner@gmail.com", false),
        ] {
            let provider = Arc::new(FakeProvider {
                profile: Some(json!({ "emailAddress": address })),
                message: Some(message.clone()),
                calls: Mutex::new(Vec::new()),
            });
            let result = broker_with(policy(vec![grant()]), provider.clone())
                .resolve(request(DIRECT_RECIPIENT));
            if accepted {
                assert_eq!(result, Ok("QX7K2M".into()), "{address}");
            } else {
                assert_eq!(result, Err(EmailCodeError::MailboxMismatch), "{address}");
                assert_eq!(*provider.calls.lock(), vec!["profile".to_string()]);
            }
        }

        let dotted_workspace = EmailCodePolicy {
            mailbox: Some("first.last@workspace.example".into()),
            ..policy(vec![grant()])
        };
        let provider = Arc::new(FakeProvider {
            profile: Some(json!({ "emailAddress": "firstlast@workspace.example" })),
            message: Some(message.clone()),
            calls: Mutex::new(Vec::new()),
        });
        assert_eq!(
            broker_with(dotted_workspace, provider).resolve(request(DIRECT_RECIPIENT)),
            Err(EmailCodeError::MailboxMismatch)
        );

        let missing_profile = Arc::new(FakeProvider {
            profile: Some(json!({ "historyId": "1" })),
            message: Some(message),
            calls: Mutex::new(Vec::new()),
        });
        assert_eq!(
            broker_with(policy(vec![grant()]), missing_profile).resolve(request(DIRECT_RECIPIENT)),
            Err(EmailCodeError::MailboxMismatch)
        );
        let unavailable = Arc::new(FakeProvider::default());
        assert_eq!(
            broker_with(policy(vec![grant()]), unavailable).resolve(request(DIRECT_RECIPIENT)),
            Err(EmailCodeError::ProviderUnavailable)
        );
    }

    #[test]
    fn message_identity_labels_and_freshness_fail_closed() {
        let mut other_id = direct_message("Your code is QX7K2M", "Your code is QX7K2M");
        other_id["id"] = json!("18c0ffee0000abce");
        assert_eq!(
            resolve_direct(other_id),
            Err(EmailCodeError::MessageUnavailable)
        );

        for (label, eligible) in [
            ("INBOX", true),
            ("SPAM", true),
            ("TRASH", false),
            ("DRAFT", false),
            ("SENT", false),
        ] {
            let mut message = direct_message("Your code is QX7K2M", "Your code is QX7K2M");
            message["labelIds"] = json!([label]);
            let expected = if eligible {
                Ok("QX7K2M".into())
            } else {
                Err(EmailCodeError::MessageIneligible)
            };
            assert_eq!(resolve_direct(message), expected, "{label}");
        }

        let max_age = DEFAULT_MAX_AGE_MS;
        for (internal_date, fresh) in [
            (NOW_MS - max_age, true),
            (NOW_MS - max_age - 1, false),
            (NOW_MS + MAX_FUTURE_SKEW_MS, true),
            (NOW_MS + MAX_FUTURE_SKEW_MS + 1, false),
        ] {
            let mut message = direct_message("Your code is QX7K2M", "Your code is QX7K2M");
            message["internalDate"] = json!(internal_date.to_string());
            let result = resolve_direct(message);
            if fresh {
                assert_eq!(result, Ok("QX7K2M".into()));
            } else {
                assert_eq!(result, Err(EmailCodeError::MessageNotFresh));
            }
        }
        let mut undated = direct_message("Your code is QX7K2M", "Your code is QX7K2M");
        undated["internalDate"] = json!("yesterday");
        assert_eq!(
            resolve_direct(undated),
            Err(EmailCodeError::MessageUnavailable)
        );
    }

    #[test]
    fn direct_sender_domain_must_match_exactly() {
        for from in [
            "noreply@evil-service.example",
            "noreply@service.example.evil",
            "noreply@mail.service.example",
            "\"noreply@service.example\" <attacker@evil.example>",
        ] {
            let mut headers = direct_headers("Your code is QX7K2M", DIRECT_RECIPIENT);
            headers[2] = ("From", from);
            let message = message_with(
                &headers,
                vec![text_part("text/plain", "Your code is QX7K2M")],
                NOW_MS - 1_000,
            );
            assert_eq!(
                resolve_direct(message),
                Err(EmailCodeError::SenderUntrusted),
                "{from}"
            );
        }
        let mut headers = direct_headers("Your code is QX7K2M", DIRECT_RECIPIENT);
        headers.push(("From", "noreply@service.example"));
        let duplicate_from = message_with(
            &headers,
            vec![text_part("text/plain", "Your code is QX7K2M")],
            NOW_MS - 1_000,
        );
        assert_eq!(
            resolve_direct(duplicate_from),
            Err(EmailCodeError::MessageUnavailable)
        );
        let mut headers = direct_headers("Your code is QX7K2M", DIRECT_RECIPIENT);
        headers[2] = ("From", "noreply@service.example, second@service.example");
        let two_authors = message_with(&headers, Vec::new(), NOW_MS - 1_000);
        assert_eq!(
            resolve_direct(two_authors),
            Err(EmailCodeError::MessageUnavailable)
        );
    }

    #[test]
    fn only_gmails_topmost_authentication_results_are_trusted() {
        let cases = [
            // Gmail's own result fails; a forged passing header lower down must not rescue it.
            vec![
                ("Authentication-Results", "mx.google.com; dkim=fail header.i=@service.example; dmarc=fail header.from=service.example"),
                ("Authentication-Results", AUTH_PASS_SERVICE),
            ],
            // A forged mx.google.com result is ignored when it is not topmost.
            vec![
                ("Authentication-Results", "relay.other.example; dkim=pass header.d=service.example; dmarc=pass header.from=service.example"),
                ("Authentication-Results", AUTH_PASS_SERVICE),
            ],
            vec![("Authentication-Results", "mx.google.com.evil.example; dkim=pass header.d=service.example; dmarc=pass header.from=service.example")],
            vec![("Authentication-Results", "mx.google.com; dkim=pass header.i=@service.example; dmarc=fail header.from=service.example")],
            vec![("Authentication-Results", "mx.google.com; dkim=pass header.i=@service.example; spf=pass smtp.mailfrom=service.example")],
            vec![("Authentication-Results", "mx.google.com; dkim=pass header.i=@unrelated.example; dmarc=pass header.from=service.example")],
            vec![("Authentication-Results", "mx.google.com; dkim=pass header.i=@service.example; dmarc=pass header.from=other.example")],
            vec![("Authentication-Results", "mx.google.com; dkim=pass header.d=example; dmarc=pass header.from=service.example")],
            vec![("Authentication-Results", "mx.google.com; dkim=neutral header.i=@service.example; dmarc=pass header.from=service.example")],
            vec![("Authentication-Results", "mx.google.com (dkim=pass; dmarc=pass header.from=service.example); spf=pass smtp.mailfrom=service.example")],
            vec![("ARC-Authentication-Results", AUTH_PASS_SERVICE)],
            Vec::new(),
        ];
        for authentication in cases {
            let mut headers = authentication.clone();
            headers.extend([
                ("From", "noreply@service.example"),
                ("To", DIRECT_RECIPIENT),
                ("Subject", "Your code is QX7K2M"),
            ]);
            let message = message_with(&headers, Vec::new(), NOW_MS - 1_000);
            assert_eq!(
                resolve_direct(message),
                Err(EmailCodeError::SenderUnauthenticated),
                "{authentication:?}"
            );
        }
        let subdomain_signature = message_with(
            &[
                ("Authentication-Results", "mx.google.com; dkim=pass header.i=@service.example; dmarc=pass header.from=service.example"),
                ("From", "noreply@service.example"),
                ("To", DIRECT_RECIPIENT),
                ("Subject", "Your code is QX7K2M"),
            ],
            Vec::new(),
            NOW_MS - 1_000,
        );
        assert_eq!(resolve_direct(subdomain_signature), Ok("QX7K2M".into()));
    }

    #[test]
    fn direct_mail_must_be_addressed_to_the_exact_recipient_in_headers() {
        for to in [
            "synthetic.owner+svc2@gmail.com",
            "xsynthetic.owner+svc@gmail.com",
            "synthetic.owner@gmail.com",
            "undisclosed-recipients:;",
        ] {
            let message = message_with(
                &direct_headers("Your code is QX7K2M", to),
                vec![text_part(
                    "text/plain",
                    &format!("Sent to {DIRECT_RECIPIENT}. Your code is QX7K2M"),
                )],
                NOW_MS - 1_000,
            );
            assert_eq!(
                resolve_direct(message),
                Err(EmailCodeError::RecipientMismatch),
                "{to}"
            );
        }
        for to in [
            "Owner <Synthetic.Owner+svc@gmail.com>",
            "Team: other@service.example, synthetic.owner+svc@gmail.com;",
        ] {
            let message = message_with(
                &direct_headers("Your code is QX7K2M", to),
                Vec::new(),
                NOW_MS - 1_000,
            );
            assert_eq!(resolve_direct(message), Ok("QX7K2M".into()), "{to}");
        }
    }

    #[test]
    fn relay_requires_exact_relay_sender_original_domain_and_recipient() {
        let subject = format!("[{RELAY_RECIPIENT}] Verify your email");
        assert_eq!(
            resolve_relay(relay_message(
                &subject,
                "Service <noreply@service.example>",
                AUTH_PASS_RELAY
            )),
            Ok("QX7K2M".into())
        );

        for reply_to in [
            "noreply@service.example.evil",
            "noreply@sub.service.example",
            "noreply@service.example, other@service.example",
        ] {
            assert_eq!(
                resolve_relay(relay_message(&subject, reply_to, AUTH_PASS_RELAY)),
                Err(EmailCodeError::SenderUntrusted),
                "{reply_to}"
            );
        }
        let mut missing_reply_to =
            relay_message(&subject, "noreply@service.example", AUTH_PASS_RELAY);
        missing_reply_to["payload"]["headers"]
            .as_array_mut()
            .unwrap()
            .retain(|header| header["name"] != "Reply-To");
        assert_eq!(
            resolve_relay(missing_reply_to),
            Err(EmailCodeError::SenderUntrusted)
        );

        // Gmail authenticated the original domain, not the relay that is the actual From.
        assert_eq!(
            resolve_relay(relay_message(
                &subject,
                "noreply@service.example",
                AUTH_PASS_SERVICE
            )),
            Err(EmailCodeError::SenderUnauthenticated)
        );

        for subject in [
            "[x-member-alias@relay.example] Verify your email".to_string(),
            "[member-alias@relay.example.evil] Verify your email".to_string(),
            "[member-alias@relay.examples] Verify your email".to_string(),
            "Verify your email".to_string(),
        ] {
            assert_eq!(
                resolve_relay(relay_message(
                    &subject,
                    "noreply@service.example",
                    AUTH_PASS_RELAY
                )),
                Err(EmailCodeError::RecipientMismatch),
                "{subject}"
            );
        }
        assert_eq!(
            resolve_relay(relay_message(
                &format!("Verify {RELAY_RECIPIENT}."),
                "noreply@service.example",
                AUTH_PASS_RELAY
            )),
            Ok("QX7K2M".into())
        );

        // A relay-shaped message from a sender not listed in relay_senders is
        // judged as direct mail, and the relay domain is not a sender domain.
        let other_relay = relay_message(&subject, "noreply@service.example", AUTH_PASS_RELAY);
        assert_eq!(
            resolve_direct(other_relay),
            Err(EmailCodeError::SenderUntrusted)
        );
    }

    #[test]
    fn code_extraction_prefers_subject_and_plain_text_and_fails_on_ambiguity() {
        assert_eq!(
            resolve_direct(direct_message("Your code is QX7K2M", "Your code is QX7K2M")),
            Ok("QX7K2M".into())
        );
        assert_eq!(
            resolve_direct(direct_message("Your code is QX7K2M", "Your code is ZZ9P4B")),
            Err(EmailCodeError::CodeAmbiguous)
        );
        assert_eq!(
            resolve_direct(direct_message(
                "Verify your email",
                "Code: AB12CD then code: AB12CE"
            )),
            Err(EmailCodeError::CodeAmbiguous)
        );
        // Plain text wins; the HTML part's different code is not consulted.
        assert_eq!(
            resolve_direct(direct_message("Verify your email", "Your code is ZZ9P4B")),
            Ok("ZZ9P4B".into())
        );
        // Without subject or plain candidates, visible HTML text is used.
        assert_eq!(
            resolve_direct(direct_message("Verify your email", "Welcome")),
            Ok("QX7K2M".into())
        );
        let html_only = message_with(
            &direct_headers("Verify your email", DIRECT_RECIPIENT),
            vec![text_part(
                "text/html",
                "<style>p { color: #C0DE12 } code is ABCDEF</style><script>var code = 'code is SCR1PT';</script><!-- code is HIDDEN --><p style=\"x:'code is ATTR12'\" data-x=\"code is ATTR34\">Your code is <span>Q</span><span>X7K2M</span></p><p>Code: #A1B2C3</p>",
            )],
            NOW_MS - 1_000,
        );
        assert_eq!(resolve_direct(html_only), Ok("QX7K2M".into()));
        let styles_only = message_with(
            &direct_headers("Verify your email", DIRECT_RECIPIENT),
            vec![text_part(
                "text/html",
                "<html><head><style>.code is A1B2C3 { color: #A1B2C3 }</style></head><body bgcolor=\"#FFAA00\"><p>Code: #FFAA00</p></body></html>",
            )],
            NOW_MS - 1_000,
        );
        assert_eq!(
            resolve_direct(styles_only),
            Err(EmailCodeError::CodeNotFound)
        );
        assert_eq!(
            resolve_direct(direct_message("Verify your email", "Welcome").pipe_without_html()),
            Err(EmailCodeError::CodeNotFound)
        );
    }

    trait WithoutHtml {
        fn pipe_without_html(self) -> Value;
    }

    impl WithoutHtml for Value {
        fn pipe_without_html(mut self) -> Value {
            self["payload"]["parts"]
                .as_array_mut()
                .unwrap()
                .retain(|part| part["mimeType"] != "text/html");
            self
        }
    }

    #[test]
    fn captured_codes_must_be_bounded_ascii_alphanumerics() {
        let loose = EmailCodeGrant {
            code_pattern: r"code is (\S+)".into(),
            ..grant()
        };
        for (plain, expected) in [
            ("Your code is AB1", Err(EmailCodeError::CodeNotFound)),
            (
                "Your code is ABCDEFGHIJKLM",
                Err(EmailCodeError::CodeNotFound),
            ),
            ("Your code is AB-123", Err(EmailCodeError::CodeNotFound)),
            ("Your code is AB12", Ok("AB12".to_string())),
            ("Your code is ABCDEFGHIJKL", Ok("ABCDEFGHIJKL".to_string())),
        ] {
            let message = direct_message("Verify your email", plain).pipe_without_html();
            let result = broker_with(policy(vec![loose.clone()]), provider_for(message))
                .resolve(request(DIRECT_RECIPIENT));
            assert_eq!(result, expected, "{plain}");
        }
        let optional = EmailCodeGrant {
            code_pattern: r"code is (?:([A-Z0-9]{6})|pending)".into(),
            ..grant()
        };
        let message =
            direct_message("Verify your email", "Your code is pending").pipe_without_html();
        assert_eq!(
            broker_with(policy(vec![optional]), provider_for(message))
                .resolve(request(DIRECT_RECIPIENT)),
            Err(EmailCodeError::CodeNotFound)
        );
    }

    #[test]
    fn mime_decoding_handles_encoded_subjects_nesting_and_attachments() {
        let message = message_with(
            &direct_headers(
                "=?UTF-8?B?WW91ciBjb2RlIGlz?= =?utf-8?Q?_QX7K2M?=",
                DIRECT_RECIPIENT,
            ),
            vec![
                json!({
                    "mimeType": "multipart/alternative",
                    "headers": [],
                    "body": { "size": 0 },
                    "parts": [text_part("text/plain", "Thanks for signing up\u{00A0}")]
                }),
                json!({
                    "mimeType": "text/plain",
                    "filename": "previous-code.txt",
                    "headers": [{ "name": "Content-Disposition", "value": "attachment; filename=previous-code.txt" }],
                    "body": { "size": 20, "data": encode("Your code is OLD999") }
                }),
                json!({
                    "mimeType": "text/plain",
                    "headers": [{ "name": "Content-Disposition", "value": "ATTACHMENT" }],
                    "body": { "size": 20, "data": encode("Your code is OLD998") }
                }),
            ],
            NOW_MS - 1_000,
        );
        assert_eq!(resolve_direct(message), Ok("QX7K2M".into()));

        let latin1 = message_with(
            &direct_headers("Verify your email", DIRECT_RECIPIENT),
            vec![json!({
                "mimeType": "text/plain",
                "headers": [{ "name": "Content-Type", "value": "text/plain; charset=ISO-8859-1" }],
                "body": { "data": URL_SAFE_NO_PAD.encode(b"Votre code is QX7K2M \xe9") }
            })],
            NOW_MS - 1_000,
        );
        assert_eq!(resolve_direct(latin1), Ok("QX7K2M".into()));

        for broken in [
            json!({ "mimeType": "text/plain", "headers": [], "body": { "data": "%%%not-base64%%%" } }),
            json!({ "mimeType": "text/plain", "headers": [], "body": { "size": 90000, "attachmentId": "ANGjdJ" } }),
            json!({
                "mimeType": "text/plain",
                "headers": [{ "name": "Content-Type", "value": "text/plain; charset=koi8-r" }],
                "body": { "data": encode("Your code is QX7K2M") }
            }),
            json!({ "mimeType": "text/plain", "headers": [], "body": { "data": URL_SAFE_NO_PAD.encode(b"code is QX7K2M \xff") } }),
        ] {
            let message = message_with(
                &direct_headers("Verify your email", DIRECT_RECIPIENT),
                vec![broken.clone()],
                NOW_MS - 1_000,
            );
            assert_eq!(
                resolve_direct(message),
                Err(EmailCodeError::MessageUnavailable),
                "{broken}"
            );
        }
        let unsupported_subject = message_with(
            &direct_headers("=?koi8-r?B?UVg3SzJN?=", DIRECT_RECIPIENT),
            Vec::new(),
            NOW_MS - 1_000,
        );
        assert_eq!(
            resolve_direct(unsupported_subject),
            Err(EmailCodeError::MessageUnavailable)
        );
        let mut headers = direct_headers("Your code is QX7K2M", DIRECT_RECIPIENT);
        headers.push(("Subject", "Your code is ZZ9P4B"));
        let duplicate_subject = message_with(&headers, Vec::new(), NOW_MS - 1_000);
        assert_eq!(
            resolve_direct(duplicate_subject),
            Err(EmailCodeError::MessageUnavailable)
        );

        let mut nested = text_part("text/plain", "Your code is QX7K2M");
        for _ in 0..=MAX_MIME_DEPTH {
            nested = json!({ "mimeType": "multipart/mixed", "headers": [], "parts": [nested] });
        }
        let deep = message_with(
            &direct_headers("Verify your email", DIRECT_RECIPIENT),
            vec![nested],
            NOW_MS - 1_000,
        );
        assert_eq!(
            resolve_direct(deep),
            Err(EmailCodeError::MessageUnavailable)
        );
    }

    #[test]
    fn errors_and_debug_output_never_carry_mail_content_addresses_or_codes() {
        let secret_message = direct_message("Your code is QX7K2M", "Your code is ZZ9P4B");
        let error = resolve_direct(secret_message).unwrap_err();
        let all_errors = [
            EmailCodeError::PolicyInvalid,
            EmailCodeError::Disabled,
            EmailCodeError::InvalidRequest,
            EmailCodeError::GrantNotFound,
            EmailCodeError::ProviderUnavailable,
            EmailCodeError::ProviderTimeout,
            EmailCodeError::MailboxMismatch,
            EmailCodeError::MessageUnavailable,
            EmailCodeError::MessageIneligible,
            EmailCodeError::MessageNotFresh,
            EmailCodeError::SenderUntrusted,
            EmailCodeError::SenderUnauthenticated,
            EmailCodeError::RecipientMismatch,
            EmailCodeError::CodeNotFound,
            EmailCodeError::CodeAmbiguous,
        ];
        assert!(all_errors.contains(&error));
        let mut codes = all_errors
            .iter()
            .map(EmailCodeError::code)
            .collect::<Vec<_>>();
        codes.sort_unstable();
        codes.dedup();
        assert_eq!(codes.len(), all_errors.len());
        for error in all_errors {
            let rendered = format!("{error} {error:?} {} {}", error.code(), error.recovery());
            for secret in [
                "QX7K2M",
                "ZZ9P4B",
                "synthetic",
                "service.example",
                MESSAGE_ID,
            ] {
                assert!(!rendered.contains(secret), "{rendered}");
            }
        }

        let broker = broker_with(
            policy(vec![relay_grant()]),
            Arc::new(FakeProvider::default()),
        );
        let rendered = format!("{broker:?} {:?}", policy(vec![relay_grant()]));
        for private in [
            MAILBOX,
            RELAY_RECIPIENT,
            RELAY_SENDER,
            FIXTURE_GWS,
            CODE_PATTERN,
        ] {
            assert!(!rendered.contains(private), "{rendered}");
        }
        assert!(rendered.contains("grant_count: 1"));
    }

    #[test]
    fn helper_boundaries_for_addresses_and_tokens() {
        assert_eq!(
            parse_address_list("\"Doe, Jane (x)\" <Jane@Example.com> (comment), b@c.example")
                .unwrap(),
            vec!["jane@example.com".to_string(), "b@c.example".to_string()]
        );
        assert!(parse_address_list("Jane <jane@example.com> trailing").is_none());
        assert!(parse_address_list("not an address").is_none());
        assert!(parse_single_address("a@b.example, c@d.example").is_none());

        let address = "alias@relay.example";
        assert!(contains_address_token("To: alias@relay.example", address));
        assert!(contains_address_token("<ALIAS@relay.example>", address));
        assert!(contains_address_token(
            "sent to alias@relay.example.",
            address
        ));
        assert!(!contains_address_token("my.alias@relay.example", address));
        assert!(!contains_address_token("x+alias@relay.example", address));
        assert!(!contains_address_token("alias@relay.example.org", address));
        assert!(!contains_address_token(
            "alias@relay.example-two.org",
            address
        ));
        assert!(!contains_address_token("alias@relay.examples", address));

        assert_eq!(
            mailbox_key("First.Last@GoogleMail.com").as_deref(),
            Some("firstlast@googlemail.com")
        );
        assert_eq!(
            mailbox_key("first.last@example.com").as_deref(),
            Some("first.last@example.com")
        );
        assert!(normalize_email("a\nb@example.com").is_none());
        assert!(normalize_email("a@@example.com").is_none());
        assert!(normalize_email(".a@example.com").is_none());
    }

    #[cfg(unix)]
    fn write_fixture_gws(directory: &std::path::Path, name: &str, body: &str) -> PathBuf {
        use std::os::unix::fs::PermissionsExt;
        let executable = directory.join(name);
        std::fs::write(&executable, format!("#!/bin/sh\n{body}\n")).unwrap();
        std::fs::set_permissions(&executable, std::fs::Permissions::from_mode(0o700)).unwrap();
        executable
    }

    #[cfg(unix)]
    #[test]
    fn gws_provider_reads_only_the_profile_and_exact_message_with_argument_vectors() {
        let temp = tempfile::tempdir().unwrap();
        let log = temp.path().join("argv.log");
        let message_file = temp.path().join("message.json");
        std::fs::write(
            &message_file,
            serde_json::to_vec(&direct_message(
                "Your code is QX7K2M",
                "Your code is QX7K2M",
            ))
            .unwrap(),
        )
        .unwrap();
        let executable = write_fixture_gws(
            temp.path(),
            "gws-reader",
            &format!(
                "printf '%s|' \"$@\" >> '{log}'\nprintf '\\n' >> '{log}'\ncase \"$3\" in\n  getProfile) printf '%s' '{{\"emailAddress\":\"{MAILBOX}\"}}' ;;\n  messages) cat '{message}' ;;\n  *) exit 3 ;;\nesac",
                log = log.display(),
                message = message_file.display(),
            ),
        );
        let fixture_policy = EmailCodePolicy {
            executable: Some(executable),
            ..policy(vec![grant()])
        };
        let provider = Arc::new(GwsProvider::new(&fixture_policy));
        let broker = EmailCodeBroker::with_parts(fixture_policy, provider, fixed_now);
        assert_eq!(
            broker.resolve(request(DIRECT_RECIPIENT)),
            Ok("QX7K2M".into())
        );
        let calls = std::fs::read_to_string(&log).unwrap();
        let calls = calls
            .lines()
            .map(|line| line.trim_end_matches('|').split('|').collect::<Vec<_>>())
            .collect::<Vec<_>>();
        assert_eq!(calls.len(), 2);
        assert_eq!(calls[0][..4], ["gmail", "users", "getProfile", "--params"]);
        assert_eq!(
            serde_json::from_str::<Value>(calls[0][4]).unwrap(),
            json!({ "userId": "me" })
        );
        assert_eq!(calls[0].len(), 5);
        assert_eq!(
            calls[1][..5],
            ["gmail", "users", "messages", "get", "--params"]
        );
        assert_eq!(
            serde_json::from_str::<Value>(calls[1][5]).unwrap(),
            json!({ "userId": "me", "id": MESSAGE_ID, "format": "full" })
        );
        assert_eq!(calls[1].len(), 6);
    }

    #[cfg(unix)]
    #[test]
    fn gws_provider_failures_are_sanitized_and_bounded_by_the_deadline() {
        let temp = tempfile::tempdir().unwrap();
        let failing = write_fixture_gws(
            temp.path(),
            "gws-failing",
            "printf '%s' '{\"error\":{\"message\":\"token QX7K2M leaked\"}}'\nprintf 'stderr secret QX7K2M' >&2\nexit 1",
        );
        let fixture_policy = EmailCodePolicy {
            executable: Some(failing),
            ..policy(vec![grant()])
        };
        let error = EmailCodeBroker::new(fixture_policy)
            .resolve(request(DIRECT_RECIPIENT))
            .unwrap_err();
        assert_eq!(error, EmailCodeError::ProviderUnavailable);
        assert!(!format!("{error} {error:?} {}", error.recovery()).contains("QX7K2M"));

        let error_body = write_fixture_gws(
            temp.path(),
            "gws-error-body",
            "printf '%s' '{\"error\":{\"code\":404}}'",
        );
        let provider = GwsProvider {
            executable: Some(error_body),
        };
        assert!(matches!(
            provider.message(MESSAGE_ID, Instant::now() + Duration::from_secs(5)),
            Err(ProviderError::Unavailable)
        ));

        let slow = write_fixture_gws(temp.path(), "gws-slow", "exec sleep 5");
        let provider = GwsProvider {
            executable: Some(slow),
        };
        let started = Instant::now();
        assert!(matches!(
            provider.profile(Instant::now() + Duration::from_millis(200)),
            Err(ProviderError::Timeout)
        ));
        assert!(started.elapsed() < Duration::from_secs(4));
        assert!(matches!(
            provider.profile(Instant::now()),
            Err(ProviderError::Timeout)
        ));

        let missing = GwsProvider { executable: None };
        assert!(matches!(
            missing.profile(Instant::now() + Duration::from_secs(1)),
            Err(ProviderError::Unavailable)
        ));
    }
}
