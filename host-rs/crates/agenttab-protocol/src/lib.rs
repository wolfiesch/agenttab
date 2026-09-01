use serde::{de::DeserializeOwned, Deserialize, Serialize};
use serde_json::{Map, Value};
use std::io::{self, Read, Write};
use thiserror::Error;
use uuid::Uuid;

pub const RPC_PROTOCOL: &str = "agenttab.rpc";
pub const NATIVE_PROTOCOL: &str = "agenttab.native";
pub const PROTOCOL_VERSION: u16 = 1;
pub const CLIENT_TO_HOST_MAX_BYTES: usize = 1024 * 1024;
pub const HOST_TO_CLIENT_MAX_BYTES: usize = 1024 * 1024;
pub const HOST_TO_EXTENSION_MAX_BYTES: usize = 1024 * 1024;
pub const EXTENSION_TO_HOST_MAX_BYTES: usize = 64 * 1024 * 1024;

const MAX_URL_CHARS: usize = 2_048;
const MAX_SELECTOR_CHARS: usize = 2_048;
const MAX_REF_CHARS: usize = 256;
const MAX_ACTIONS: usize = 64;
const MAX_ACTION_TEXT_CHARS: usize = 2_048;
const MAX_KEEP_TAB_IDS: usize = 256;
const MAX_ACTION_VALUE_CHARS: usize = 2_048;
const MAX_UPLOAD_FILES: usize = 4;
const MAX_UPLOAD_PATH_CHARS: usize = 512;
const MAX_WAIT_CONDITION_CHARS: usize = 2_048;
const MAX_HANDOFF_PROMPT_CHARS: usize = 2_000;
const MAX_HANDOFF_COMPLETION_CHARS: usize = 2_048;
const MAX_STAGED_TOKEN_CHARS: usize = 256;
const MAX_RESUME_CAPABILITY_CHARS: usize = 64;
const MAX_DEVELOPER_PARAMS: usize = 16;
const MAX_DEVELOPER_PARAM_KEY_CHARS: usize = 64;
const MAX_DEVELOPER_VALUE_CHARS: usize = 512;
const MAX_DEVELOPER_ARRAY_ITEMS: usize = 16;

pub const RPC_SCHEMA_ASSETS: &[(&str, &str)] = &[
    (
        "request",
        include_str!("../../../../schemas/rpc/v1/request.schema.json"),
    ),
    (
        "response",
        include_str!("../../../../schemas/rpc/v1/response.schema.json"),
    ),
    (
        "connection",
        include_str!("../../../../schemas/rpc/v1/connection.schema.json"),
    ),
    (
        "status",
        include_str!("../../../../schemas/rpc/v1/status.schema.json"),
    ),
    (
        "agenttab_finish",
        include_str!("../../../../schemas/rpc/v1/agenttab-finish.schema.json"),
    ),
    (
        "browser_open",
        include_str!("../../../../schemas/rpc/v1/browser-open.schema.json"),
    ),
    (
        "browser_snapshot",
        include_str!("../../../../schemas/rpc/v1/browser-snapshot.schema.json"),
    ),
    (
        "browser_act",
        include_str!("../../../../schemas/rpc/v1/browser-act.schema.json"),
    ),
    (
        "browser_wait",
        include_str!("../../../../schemas/rpc/v1/browser-wait.schema.json"),
    ),
    (
        "browser_tabs",
        include_str!("../../../../schemas/rpc/v1/browser-tabs.schema.json"),
    ),
    (
        "browser_handoff",
        include_str!("../../../../schemas/rpc/v1/browser-handoff.schema.json"),
    ),
    (
        "browser_commit",
        include_str!("../../../../schemas/rpc/v1/browser-commit.schema.json"),
    ),
    (
        "browser_developer",
        include_str!("../../../../schemas/rpc/v1/browser-developer.schema.json"),
    ),
];

pub const NATIVE_SCHEMA: &str = include_str!("../../../../schemas/native/v1/message.schema.json");

#[derive(Debug, Error)]
pub enum ProtocolError {
    #[error("I/O error: {0}")]
    Io(#[from] io::Error),
    #[error("invalid JSON: {0}")]
    Json(#[from] serde_json::Error),
    #[error("declared frame length {declared} exceeds limit {limit}")]
    Oversize { declared: usize, limit: usize },
    #[error("unsupported protocol {protocol:?} version {version}")]
    UnsupportedProtocol { protocol: String, version: u16 },
    #[error("request_id must contain 1 to 128 characters")]
    InvalidRequestId,
    #[error("method {0} requires a UUIDv7 idempotency_key")]
    MissingIdempotencyKey(RpcMethod),
    #[error("idempotency_key must be UUIDv7")]
    InvalidIdempotencyKey,
    #[error("invalid {method} parameters: {source}")]
    InvalidParams {
        method: RpcMethod,
        source: serde_json::Error,
    },
    #[error("invalid {method} parameters: {message}")]
    InvalidParamConstraint { method: RpcMethod, message: String },
    #[error("invalid connection negotiation: {0}")]
    InvalidConnection(String),
    #[error("native response outcome, payload, and staged-operation branches disagree")]
    InvalidNativeResponse,
    #[error("invalid native message: {0}")]
    InvalidNativeMessage(String),
    #[error("invalid native event payload: {0}")]
    InvalidNativeEvent(String),
}

pub fn read_frame<R: Read>(reader: &mut R, limit: usize) -> Result<Option<Value>, ProtocolError> {
    let mut header = [0_u8; 4];
    if !read_exact_or_eof(reader, &mut header)? {
        return Ok(None);
    }
    let declared = u32::from_le_bytes(header) as usize;
    if declared > limit {
        return Err(ProtocolError::Oversize { declared, limit });
    }
    let mut payload = vec![0_u8; declared];
    reader.read_exact(&mut payload)?;
    Ok(Some(serde_json::from_slice(&payload)?))
}

pub fn write_frame<W: Write>(
    writer: &mut W,
    value: &Value,
    limit: usize,
) -> Result<(), ProtocolError> {
    let payload = serde_json::to_vec(value)?;
    if payload.len() > limit || payload.len() > u32::MAX as usize {
        return Err(ProtocolError::Oversize {
            declared: payload.len(),
            limit,
        });
    }
    writer.write_all(&(payload.len() as u32).to_le_bytes())?;
    writer.write_all(&payload)?;
    writer.flush()?;
    Ok(())
}

fn read_exact_or_eof<R: Read>(reader: &mut R, buffer: &mut [u8]) -> io::Result<bool> {
    let mut offset = 0;
    while offset < buffer.len() {
        match reader.read(&mut buffer[offset..])? {
            0 if offset == 0 => return Ok(false),
            0 => {
                return Err(io::Error::new(
                    io::ErrorKind::UnexpectedEof,
                    "partial frame header",
                ))
            }
            count => offset += count,
        }
    }
    Ok(true)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RpcMethod {
    BrowserOpen,
    BrowserSnapshot,
    BrowserAct,
    BrowserWait,
    BrowserTabs,
    BrowserHandoff,
    BrowserCommit,
    BrowserCredentials,
    #[serde(rename = "agenttab.status")]
    AgenttabStatus,
    #[serde(rename = "agenttab.finish")]
    AgenttabFinish,
    #[serde(rename = "agenttab.close")]
    AgenttabClose,
    BrowserDeveloper,
}

impl RpcMethod {
    pub fn is_mutation(self) -> bool {
        matches!(
            self,
            Self::BrowserOpen
                | Self::BrowserAct
                | Self::BrowserHandoff
                | Self::BrowserCommit
                | Self::BrowserCredentials
                | Self::BrowserDeveloper
        )
    }
}

impl std::fmt::Display for RpcMethod {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let value = serde_json::to_value(self).map_err(|_| std::fmt::Error)?;
        formatter.write_str(value.as_str().ok_or(std::fmt::Error)?)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RpcRequest {
    pub protocol: String,
    pub version: u16,
    pub request_id: String,
    #[serde(default)]
    pub idempotency_key: Option<Uuid>,
    pub method: RpcMethod,
    pub params: Value,
}

impl RpcRequest {
    pub fn parse(value: Value) -> Result<(Self, MethodParams), ProtocolError> {
        validate_serialized_request_limit(&value)?;
        let explicit_null_idempotency = value.get("idempotency_key").is_some_and(Value::is_null);
        let request: Self = serde_json::from_value(value)?;
        if request.protocol != RPC_PROTOCOL || request.version != PROTOCOL_VERSION {
            return Err(ProtocolError::UnsupportedProtocol {
                protocol: request.protocol.clone(),
                version: request.version,
            });
        }
        if explicit_null_idempotency {
            return Err(ProtocolError::InvalidParamConstraint {
                method: request.method,
                message: "idempotency_key must be omitted rather than null".into(),
            });
        }
        if request.method != RpcMethod::BrowserDeveloper && contains_null(&request.params) {
            return Err(ProtocolError::InvalidParamConstraint {
                method: request.method,
                message: "explicit null is not valid in Standard RPC parameters".into(),
            });
        }
        if request.request_id.is_empty() || request.request_id.chars().count() > 128 {
            return Err(ProtocolError::InvalidRequestId);
        }
        if request.method.is_mutation() {
            let key = request
                .idempotency_key
                .ok_or(ProtocolError::MissingIdempotencyKey(request.method))?;
            if key.get_version_num() != 7 {
                return Err(ProtocolError::InvalidIdempotencyKey);
            }
        }
        let params = MethodParams::parse(request.method, request.params.clone())?;
        Ok((request, params))
    }
}

fn validate_serialized_request_limit(value: &Value) -> Result<(), ProtocolError> {
    let encoded = serde_json::to_vec(value)?;
    if encoded.len() > CLIENT_TO_HOST_MAX_BYTES {
        return Err(ProtocolError::Oversize {
            declared: encoded.len(),
            limit: CLIENT_TO_HOST_MAX_BYTES,
        });
    }
    Ok(())
}

fn contains_null(value: &Value) -> bool {
    match value {
        Value::Null => true,
        Value::Array(values) => values.iter().any(contains_null),
        Value::Object(values) => values.values().any(contains_null),
        _ => false,
    }
}

fn decode_params<T: DeserializeOwned>(method: RpcMethod, value: Value) -> Result<T, ProtocolError> {
    serde_json::from_value(value).map_err(|source| ProtocolError::InvalidParams { method, source })
}

#[derive(Debug, Clone)]
pub enum MethodParams {
    Open(BrowserOpenParams),
    Snapshot(BrowserSnapshotParams),
    Act(BrowserActParams),
    Wait(BrowserWaitParams),
    Tabs(BrowserTabsParams),
    Handoff(BrowserHandoffParams),
    Credentials(BrowserCredentialsParams),
    Commit(BrowserCommitParams),
    Status(BrowserTabsParams),
    Finish(AgenttabFinishParams),
    Close(BrowserTabsParams),
    Developer(BrowserDeveloperParams),
}

impl MethodParams {
    fn parse(method: RpcMethod, value: Value) -> Result<Self, ProtocolError> {
        let params = match method {
            RpcMethod::BrowserOpen => Self::Open(decode_params(method, value)?),
            RpcMethod::BrowserSnapshot => Self::Snapshot(decode_params(method, value)?),
            RpcMethod::BrowserAct => Self::Act(decode_params(method, value)?),
            RpcMethod::BrowserWait => Self::Wait(decode_params(method, value)?),
            RpcMethod::BrowserTabs => Self::Tabs(decode_params(method, value)?),
            RpcMethod::BrowserHandoff => Self::Handoff(decode_params(method, value)?),
            RpcMethod::BrowserCredentials => Self::Credentials(decode_params(method, value)?),
            RpcMethod::BrowserCommit => Self::Commit(decode_params(method, value)?),
            RpcMethod::AgenttabStatus => Self::Status(decode_params(method, value)?),
            RpcMethod::AgenttabFinish => Self::Finish(decode_params(method, value)?),
            RpcMethod::AgenttabClose => Self::Close(decode_params(method, value)?),
            RpcMethod::BrowserDeveloper => Self::Developer(decode_params(method, value)?),
        };
        params.validate(method)?;
        Ok(params)
    }

    pub fn value(&self) -> Value {
        match self {
            Self::Open(value) => serde_json::to_value(value),
            Self::Snapshot(value) => serde_json::to_value(value),
            Self::Act(value) => serde_json::to_value(value),
            Self::Wait(value) => serde_json::to_value(value),
            Self::Tabs(value) => serde_json::to_value(value),
            Self::Handoff(value) => serde_json::to_value(value),
            Self::Credentials(value) => serde_json::to_value(value),
            Self::Commit(value) => serde_json::to_value(value),
            Self::Status(value) => serde_json::to_value(value),
            Self::Finish(value) => serde_json::to_value(value),
            Self::Close(value) => serde_json::to_value(value),
            Self::Developer(value) => serde_json::to_value(value),
        }
        .expect("typed protocol parameters serialize")
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BrowserOpenPlacement {
    #[default]
    Task,
    NewWindow,
}

impl BrowserOpenPlacement {
    fn is_task(&self) -> bool {
        matches!(self, Self::Task)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "mode", rename_all = "snake_case", deny_unknown_fields)]
pub enum BrowserOpenParams {
    Create {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        url: Option<String>,
        #[serde(default = "default_true")]
        background: bool,
        #[serde(default, skip_serializing_if = "BrowserOpenPlacement::is_task")]
        placement: BrowserOpenPlacement,
    },
    AdoptActive,
}

fn default_true() -> bool {
    true
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "mode", rename_all = "snake_case", deny_unknown_fields)]
pub enum BrowserSnapshotParams {
    Accessibility {
        tab_id: u64,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        root_ref: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        max_depth: Option<u16>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        max_nodes: Option<u32>,
    },
    Text {
        tab_id: u64,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        selector: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        r#match: Option<SnapshotSelectorMatch>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        max_bytes: Option<u32>,
    },
    Html {
        tab_id: u64,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        selector: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        max_bytes: Option<u32>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        r#match: Option<SnapshotSelectorMatch>,
    },
    Screenshot {
        tab_id: u64,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        selector: Option<String>,
        #[serde(default)]
        full_page: bool,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        format: Option<ScreenshotFormat>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        quality: Option<u8>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        max_width: Option<u16>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        max_height: Option<u16>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        max_bytes: Option<u32>,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SnapshotSelectorMatch {
    First,
    Last,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ScreenshotFormat {
    Png,
    Jpeg,
    Webp,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct BrowserActParams {
    pub tab_id: u64,
    pub expected_page_revision: u64,
    pub actions: Vec<BrowserAction>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum BrowserAction {
    Click {
        r#ref: String,
    },
    Type {
        r#ref: String,
        text: String,
    },
    Fill {
        r#ref: String,
        text: String,
    },
    Select {
        r#ref: String,
        value: String,
    },
    Scroll {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        r#ref: Option<String>,
        delta_x: i64,
        delta_y: i64,
    },
    Drag {
        r#ref: String,
        target_ref: String,
    },
    Navigate {
        url: String,
    },
    GoBack,
    GoForward,
    Reload {
        #[serde(default)]
        bypass_cache: bool,
    },
    Close,
    Dialog {
        decision: DialogDecision,
    },
    UploadFile {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        r#ref: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        selector: Option<String>,
        files: Vec<String>,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DialogDecision {
    Accept,
    Dismiss,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct BrowserWaitParams {
    pub tab_id: u64,
    pub condition: WaitCondition,
    #[serde(default = "default_wait_timeout")]
    pub timeout_ms: u64,
}

fn default_wait_timeout() -> u64 {
    30_000
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum WaitCondition {
    Load,
    NetworkIdle,
    Download,
    Url { value: String },
    Text { value: String },
    Selector { value: String },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct BrowserTabsParams {}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FinishDisposition {
    Auto,
    Close,
    Keep,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AgenttabFinishParams {
    #[serde(default = "default_finish_disposition")]
    pub disposition: FinishDisposition,
    #[serde(default)]
    pub keep_tab_ids: Vec<u64>,
}

fn default_finish_disposition() -> FinishDisposition {
    FinishDisposition::Auto
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct BrowserHandoffParams {
    pub tab_id: u64,
    pub expected_page_revision: u64,
    pub prompt: String,
    pub completion: HandoffCompletion,
    #[serde(default = "default_handoff_timeout")]
    pub timeout_ms: u64,
}

fn default_handoff_timeout() -> u64 {
    300_000
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum HandoffCompletion {
    Navigation,
    ManualDone,
    Url { value: String },
    Selector { value: String },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "action", rename_all = "snake_case", deny_unknown_fields)]
pub enum BrowserCredentialsParams {
    Prepare {
        tab_id: u64,
        expected_page_revision: u64,
    },
    Fill {
        tab_id: u64,
        expected_page_revision: u64,
        credential_token: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        username_ref: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        password_ref: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        otp_ref: Option<String>,
    },
    Next {
        tab_id: u64,
        expected_page_revision: u64,
        credential_token: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        username_ref: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        password_ref: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        otp_ref: Option<String>,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct BrowserCommitParams {
    pub staged_token: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct BrowserDeveloperParams {
    pub action: String,
    pub params: Map<String, Value>,
}
impl MethodParams {
    fn validate(&self, method: RpcMethod) -> Result<(), ProtocolError> {
        match self {
            Self::Open(BrowserOpenParams::Create {
                url,
                background,
                placement,
            }) => {
                if let Some(url) = url {
                    require_len(method, url, 1, MAX_URL_CHARS, "url")?;
                    require(
                        method,
                        valid_url(url),
                        "url must use http, https, or about without whitespace",
                    )?;
                }
                if matches!(placement, BrowserOpenPlacement::NewWindow) {
                    require(
                        method,
                        *background,
                        "background must be true when placement is new_window",
                    )?;
                }
            }
            Self::Snapshot(BrowserSnapshotParams::Accessibility {
                root_ref,
                max_depth,
                max_nodes,
                ..
            }) => {
                if let Some(value) = root_ref {
                    require_len(method, value, 1, MAX_REF_CHARS, "root_ref")?;
                }
                if let Some(value) = max_depth {
                    require(
                        method,
                        (1..=200).contains(value),
                        "max_depth must be between 1 and 200",
                    )?;
                }
                if let Some(value) = max_nodes {
                    require(
                        method,
                        (1..=5_000).contains(value),
                        "max_nodes must be between 1 and 5000",
                    )?;
                }
            }
            Self::Snapshot(BrowserSnapshotParams::Text {
                selector,
                r#match,
                max_bytes,
                ..
            })
            | Self::Snapshot(BrowserSnapshotParams::Html {
                selector,
                r#match,
                max_bytes,
                ..
            }) => {
                if let Some(value) = selector {
                    require_len(method, value, 1, MAX_SELECTOR_CHARS, "selector")?;
                }
                require(
                    method,
                    r#match.is_none() || selector.is_some(),
                    "match requires selector",
                )?;
                if let Some(value) = max_bytes {
                    require(
                        method,
                        (1..=1_000_000).contains(value),
                        "max_bytes must be between 1 and 1000000",
                    )?;
                }
            }
            Self::Snapshot(BrowserSnapshotParams::Screenshot {
                selector,
                full_page,
                format,
                quality,
                max_width,
                max_height,
                max_bytes,
                ..
            }) => {
                if let Some(value) = selector {
                    require_len(method, value, 1, MAX_SELECTOR_CHARS, "selector")?;
                }
                require(
                    method,
                    selector.is_none() || !*full_page,
                    "screenshot cannot combine selector and full_page",
                )?;
                if let Some(value) = quality {
                    require(method, *value <= 100, "quality must be between 0 and 100")?;
                    require(
                        method,
                        matches!(
                            format,
                            Some(ScreenshotFormat::Jpeg | ScreenshotFormat::Webp)
                        ),
                        "quality requires format jpeg or webp",
                    )?;
                }
                for (field, value) in [("max_width", max_width), ("max_height", max_height)] {
                    if let Some(value) = value {
                        require(
                            method,
                            (1..=16_384).contains(value),
                            format!("{field} must be between 1 and 16384"),
                        )?;
                    }
                }
                if let Some(value) = max_bytes {
                    require(
                        method,
                        (1..=750_000).contains(value),
                        "max_bytes must be between 1 and 750000",
                    )?;
                }
            }
            Self::Act(params) => {
                require(
                    method,
                    (1..=MAX_ACTIONS).contains(&params.actions.len()),
                    format!("actions must contain 1 to {MAX_ACTIONS} items"),
                )?;
                for action in &params.actions {
                    validate_action(method, action)?;
                }
            }
            Self::Wait(params) => {
                require(
                    method,
                    (1..=120_000).contains(&params.timeout_ms),
                    "timeout_ms must be between 1 and 120000",
                )?;
                match &params.condition {
                    WaitCondition::Url { value }
                    | WaitCondition::Text { value }
                    | WaitCondition::Selector { value } => {
                        require_len(
                            method,
                            value,
                            1,
                            MAX_WAIT_CONDITION_CHARS,
                            "condition.value",
                        )?;
                    }
                    WaitCondition::Load | WaitCondition::NetworkIdle | WaitCondition::Download => {}
                }
            }
            Self::Handoff(params) => {
                require_len(
                    method,
                    &params.prompt,
                    1,
                    MAX_HANDOFF_PROMPT_CHARS,
                    "prompt",
                )?;
                require(
                    method,
                    (1_000..=900_000).contains(&params.timeout_ms),
                    "timeout_ms must be between 1000 and 900000",
                )?;
                match &params.completion {
                    HandoffCompletion::Url { value } | HandoffCompletion::Selector { value } => {
                        require_len(
                            method,
                            value,
                            1,
                            MAX_HANDOFF_COMPLETION_CHARS,
                            "completion.value",
                        )?;
                    }
                    HandoffCompletion::Navigation | HandoffCompletion::ManualDone => {}
                }
            }
            Self::Credentials(BrowserCredentialsParams::Prepare { .. }) => {}
            Self::Credentials(
                BrowserCredentialsParams::Fill {
                    credential_token,
                    username_ref,
                    password_ref,
                    otp_ref,
                    ..
                }
                | BrowserCredentialsParams::Next {
                    credential_token,
                    username_ref,
                    password_ref,
                    otp_ref,
                    ..
                },
            ) => {
                require_len(
                    method,
                    credential_token,
                    32,
                    MAX_STAGED_TOKEN_CHARS,
                    "credential_token",
                )?;
                require(
                    method,
                    username_ref.is_some() || password_ref.is_some() || otp_ref.is_some(),
                    "at least one credential field ref is required",
                )?;
                for (name, value) in [
                    ("username_ref", username_ref),
                    ("password_ref", password_ref),
                    ("otp_ref", otp_ref),
                ] {
                    if let Some(value) = value {
                        require_len(method, value, 1, MAX_REF_CHARS, name)?;
                    }
                }
            }
            Self::Commit(params) => {
                require_len(
                    method,
                    &params.staged_token,
                    32,
                    MAX_STAGED_TOKEN_CHARS,
                    "staged_token",
                )?;
            }
            Self::Finish(params) => {
                require(
                    method,
                    params.keep_tab_ids.len() <= MAX_KEEP_TAB_IDS,
                    format!("keep_tab_ids must contain at most {MAX_KEEP_TAB_IDS} items"),
                )?;
                for (index, tab_id) in params.keep_tab_ids.iter().enumerate() {
                    require(
                        method,
                        *tab_id > 0,
                        "keep_tab_ids must contain positive tab IDs",
                    )?;
                    require(
                        method,
                        !params.keep_tab_ids[..index].contains(tab_id),
                        "keep_tab_ids must not contain duplicates",
                    )?;
                }
            }
            Self::Developer(params) => {
                require_len(method, &params.action, 1, 128, "action")?;
                validate_developer_params(method, &params.params)?;
            }
            Self::Open(BrowserOpenParams::AdoptActive)
            | Self::Tabs(_)
            | Self::Status(_)
            | Self::Close(_) => {}
        }
        Ok(())
    }
}

fn validate_action(method: RpcMethod, action: &BrowserAction) -> Result<(), ProtocolError> {
    match action {
        BrowserAction::Click { r#ref } => require_ref(method, r#ref),
        BrowserAction::Type { r#ref, text } | BrowserAction::Fill { r#ref, text } => {
            require_ref(method, r#ref)?;
            require_len(method, text, 0, MAX_ACTION_TEXT_CHARS, "text")
        }
        BrowserAction::Select { r#ref, value } => {
            require_ref(method, r#ref)?;
            require_len(method, value, 0, MAX_ACTION_VALUE_CHARS, "value")
        }
        BrowserAction::Scroll {
            r#ref,
            delta_x,
            delta_y,
        } => {
            if let Some(value) = r#ref {
                require_ref(method, value)?;
            }
            require(
                method,
                delta_x.unsigned_abs() <= 100_000 && delta_y.unsigned_abs() <= 100_000,
                "scroll deltas must be between -100000 and 100000",
            )
        }
        BrowserAction::Drag { r#ref, target_ref } => {
            require_ref(method, r#ref)?;
            require_ref(method, target_ref)
        }
        BrowserAction::Navigate { url } => {
            require_len(method, url, 1, MAX_URL_CHARS, "url")?;
            require(
                method,
                valid_url(url),
                "url must use http, https, or about without whitespace",
            )
        }
        BrowserAction::Dialog { .. } => Ok(()),
        BrowserAction::UploadFile {
            r#ref,
            selector,
            files,
        } => {
            match (r#ref, selector) {
                (Some(value), None) => require_ref(method, value)?,
                (None, Some(value)) => {
                    require_len(method, value, 1, MAX_SELECTOR_CHARS, "selector")?
                }
                _ => {
                    return require(
                        method,
                        false,
                        "upload_file requires exactly one of ref or selector",
                    )
                }
            }
            require(
                method,
                (1..=MAX_UPLOAD_FILES).contains(&files.len()),
                format!("files must contain 1 to {MAX_UPLOAD_FILES} paths"),
            )?;
            for file in files {
                require_len(method, file, 1, MAX_UPLOAD_PATH_CHARS, "file path")?;
            }
            Ok(())
        }
        BrowserAction::GoBack
        | BrowserAction::GoForward
        | BrowserAction::Reload { .. }
        | BrowserAction::Close => Ok(()),
    }
}

fn validate_developer_params(
    method: RpcMethod,
    params: &Map<String, Value>,
) -> Result<(), ProtocolError> {
    require(
        method,
        params.len() <= MAX_DEVELOPER_PARAMS,
        format!("params must contain at most {MAX_DEVELOPER_PARAMS} entries"),
    )?;
    for (key, value) in params {
        require_len(method, key, 1, MAX_DEVELOPER_PARAM_KEY_CHARS, "params key")?;
        match value {
            Value::String(value) => {
                require_len(method, value, 0, MAX_DEVELOPER_VALUE_CHARS, "params string")?;
            }
            Value::Null | Value::Bool(_) | Value::Number(_) => {}
            Value::Array(values) => {
                require(
                    method,
                    values.len() <= MAX_DEVELOPER_ARRAY_ITEMS,
                    format!("params arrays must contain at most {MAX_DEVELOPER_ARRAY_ITEMS} items"),
                )?;
                for value in values {
                    match value {
                        Value::String(value) => {
                            require_len(
                                method,
                                value,
                                0,
                                MAX_DEVELOPER_VALUE_CHARS,
                                "params array string",
                            )?;
                        }
                        Value::Null | Value::Bool(_) | Value::Number(_) => {}
                        Value::Array(_) | Value::Object(_) => {
                            return Err(ProtocolError::InvalidParamConstraint {
                                method,
                                message: "params arrays may contain only scalar values".into(),
                            });
                        }
                    }
                }
            }
            Value::Object(_) => {
                return Err(ProtocolError::InvalidParamConstraint {
                    method,
                    message: "params values must be scalars or arrays of scalars".into(),
                });
            }
        }
    }
    Ok(())
}

fn require_ref(method: RpcMethod, value: &str) -> Result<(), ProtocolError> {
    require_len(method, value, 1, MAX_REF_CHARS, "ref")
}
fn require_len(
    method: RpcMethod,
    value: &str,
    minimum: usize,
    maximum: usize,
    name: &str,
) -> Result<(), ProtocolError> {
    let length = value.chars().count();
    require(
        method,
        (minimum..=maximum).contains(&length),
        format!("{name} must contain {minimum} to {maximum} characters"),
    )
}

fn require(
    method: RpcMethod,
    condition: bool,
    message: impl Into<String>,
) -> Result<(), ProtocolError> {
    if condition {
        Ok(())
    } else {
        Err(ProtocolError::InvalidParamConstraint {
            method,
            message: message.into(),
        })
    }
}

fn valid_url(value: &str) -> bool {
    !value.chars().any(char::is_whitespace)
        && ["http://", "https://", "about:"].iter().any(|prefix| {
            value
                .strip_prefix(prefix)
                .is_some_and(|rest| !rest.is_empty())
        })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Outcome {
    Completed,
    NotStarted,
    Unknown,
    CommitRequired,
    NeedsUser,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RpcError {
    pub code: String,
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub recovery: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub details: Option<Map<String, Value>>,
}

impl RpcError {
    pub fn new(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
            recovery: None,
            details: None,
        }
    }

    pub fn with_recovery(mut self, recovery: impl Into<String>) -> Self {
        self.recovery = Some(recovery.into());
        self
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TaskBinding {
    pub task_id: Uuid,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resume_capability: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RpcResponse {
    pub protocol: String,
    pub version: u16,
    pub request_id: String,
    pub ok: bool,
    pub outcome: Outcome,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub result: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<RpcError>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub task: Option<TaskBinding>,
}

impl RpcResponse {
    pub fn success(request_id: impl Into<String>, outcome: Outcome, result: Value) -> Self {
        Self {
            protocol: RPC_PROTOCOL.into(),
            version: PROTOCOL_VERSION,
            request_id: request_id.into(),
            ok: true,
            outcome,
            result: Some(result),
            error: None,
            task: None,
        }
    }

    pub fn failure(request_id: impl Into<String>, outcome: Outcome, error: RpcError) -> Self {
        Self {
            protocol: RPC_PROTOCOL.into(),
            version: PROTOCOL_VERSION,
            request_id: request_id.into(),
            outcome,
            ok: false,
            result: None,
            error: Some(error),
            task: None,
        }
    }

    pub fn with_task(mut self, task: TaskBinding) -> Self {
        self.task = Some(task);
        self
    }

    pub fn value(&self) -> Value {
        serde_json::to_value(self).expect("RPC response serializes")
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ConnectionInit {
    pub protocol: String,
    pub version: u16,
    pub kind: ConnectKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub conversation_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resume_capability: Option<String>,
}

impl ConnectionInit {
    pub fn parse(value: Value) -> Result<Self, ProtocolError> {
        validate_serialized_request_limit(&value)?;
        let message: Self = serde_json::from_value(value)?;
        if message.protocol != RPC_PROTOCOL || message.version != PROTOCOL_VERSION {
            return Err(ProtocolError::UnsupportedProtocol {
                protocol: message.protocol.clone(),
                version: message.version,
            });
        }
        if message
            .conversation_id
            .as_deref()
            .is_some_and(|value| !(1..=256).contains(&value.chars().count()))
        {
            return Err(ProtocolError::InvalidConnection(
                "conversation_id must contain 1 to 256 characters".into(),
            ));
        }
        if message.resume_capability.as_deref().is_some_and(|value| {
            !(32..=MAX_RESUME_CAPABILITY_CHARS).contains(&value.chars().count())
        }) {
            return Err(ProtocolError::InvalidConnection(format!(
                "resume_capability must contain 32 to {MAX_RESUME_CAPABILITY_CHARS} characters"
            )));
        }
        Ok(message)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ResumeCapabilityConfirm {
    pub protocol: String,
    pub version: u16,
    pub kind: ResumeCapabilityConfirmKind,
    pub connection_id: Uuid,
    pub resume_capability: String,
}

impl ResumeCapabilityConfirm {
    pub fn parse(value: Value) -> Result<Self, ProtocolError> {
        validate_serialized_request_limit(&value)?;
        let message: Self = serde_json::from_value(value)?;
        if message.protocol != RPC_PROTOCOL || message.version != PROTOCOL_VERSION {
            return Err(ProtocolError::UnsupportedProtocol {
                protocol: message.protocol.clone(),
                version: message.version,
            });
        }
        if !(32..=MAX_RESUME_CAPABILITY_CHARS).contains(&message.resume_capability.chars().count())
        {
            return Err(ProtocolError::InvalidConnection(format!(
                "resume_capability must contain 32 to {MAX_RESUME_CAPABILITY_CHARS} characters"
            )));
        }
        Ok(message)
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ResumeCapabilityConfirmKind {
    ResumeConfirm,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ConnectKind {
    Connect,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RuntimeState {
    Starting,
    Reconciling,
    Ready,
    Paused,
    Terminal,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ConnectionAck {
    pub protocol: String,
    pub version: u16,
    pub kind: ConnectedKind,
    pub connection_id: Uuid,
    pub resumed: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub task_id: Option<Uuid>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resume_capability: Option<String>,
    pub state: RuntimeState,
}

impl ConnectionAck {
    pub fn value(&self) -> Value {
        serde_json::to_value(self).expect("connection acknowledgement serializes")
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ConnectedKind {
    Connected,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ResumeCapabilityConfirmed {
    pub protocol: String,
    pub version: u16,
    pub kind: ResumeCapabilityConfirmedKind,
    pub connection_id: Uuid,
}

impl ResumeCapabilityConfirmed {
    pub fn value(&self) -> Value {
        serde_json::to_value(self).expect("resume confirmation acknowledgement serializes")
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ResumeCapabilityConfirmedKind {
    ResumeConfirmed,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct NativeTab {
    pub tab_id: u64,
    pub window_id: u64,
    pub group_id: Option<i64>,
    pub url: String,
    pub page_revision: u64,
    #[serde(default)]
    pub task_id: Option<Uuid>,
}
impl NativeTab {
    fn validate(&self) -> Result<(), ProtocolError> {
        if self.tab_id == 0 || self.window_id == 0 || self.url.is_empty() {
            return Err(ProtocolError::InvalidNativeMessage(
                "native tab id, window id, and URL must be present".into(),
            ));
        }
        if self.task_id.is_some() && self.group_id.is_none() {
            return Err(ProtocolError::InvalidNativeMessage(
                "task-owned native tabs must have a visible group".into(),
            ));
        }
        Ok(())
    }
}

fn validate_native_inventory(inventory: &[NativeTab]) -> Result<(), ProtocolError> {
    let mut tab_ids = std::collections::HashSet::with_capacity(inventory.len());
    for tab in inventory {
        tab.validate()?;
        if !tab_ids.insert(tab.tab_id) {
            return Err(ProtocolError::InvalidNativeMessage(
                "native inventory must not contain duplicate tab ids".into(),
            ));
        }
    }
    Ok(())
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct NativeHandoff {
    pub active: bool,
    #[serde(default)]
    pub task_id: Option<Uuid>,
    #[serde(default)]
    pub tab_id: Option<u64>,
    #[serde(default)]
    pub started_at_ms: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct NativeHello {
    pub protocol: String,
    pub version: u16,
    pub kind: NativeHelloKind,
    pub extension_version: String,
    pub inventory: Vec<NativeTab>,
    pub paused: bool,
    pub handoff: NativeHandoff,
    pub staged_commits: Vec<NativeStagedCommit>,
}
impl NativeHello {
    pub fn parse(value: Value) -> Result<Self, ProtocolError> {
        let hello: Self = serde_json::from_value(value)?;
        if hello.protocol != NATIVE_PROTOCOL || hello.version != PROTOCOL_VERSION {
            return Err(ProtocolError::UnsupportedProtocol {
                protocol: hello.protocol.clone(),
                version: hello.version,
            });
        }
        if hello.extension_version.is_empty() {
            return Err(ProtocolError::InvalidNativeMessage(
                "extension_version must not be empty".into(),
            ));
        }
        validate_native_inventory(&hello.inventory)?;
        validate_native_handoff(&hello.handoff)?;
        for staged in &hello.staged_commits {
            staged.validate()?;
        }
        Ok(hello)
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum NativeHelloKind {
    Hello,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct NativeDisconnectRecovery {
    pub protocol: String,
    pub version: u16,
    pub kind: NativeDisconnectRecoveryKind,
    pub reason: String,
    pub pending_outcome: Outcome,
}

impl NativeDisconnectRecovery {
    pub fn parse(value: Value) -> Result<Self, ProtocolError> {
        let recovery: Self = serde_json::from_value(value)?;
        if recovery.protocol != NATIVE_PROTOCOL || recovery.version != PROTOCOL_VERSION {
            return Err(ProtocolError::UnsupportedProtocol {
                protocol: recovery.protocol.clone(),
                version: recovery.version,
            });
        }
        if recovery.pending_outcome != Outcome::Unknown {
            return Err(ProtocolError::InvalidNativeEvent(
                "disconnect recovery pending_outcome must be unknown".into(),
            ));
        }
        if recovery.reason.is_empty() {
            return Err(ProtocolError::InvalidNativeMessage(
                "disconnect recovery reason must not be empty".into(),
            ));
        }
        Ok(recovery)
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum NativeDisconnectRecoveryKind {
    DisconnectRecovery,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct NativeCloseTask {
    pub protocol: String,
    pub version: u16,
    pub kind: NativeCloseTaskKind,
    pub request_id: Uuid,
    pub task_id: Uuid,
}

impl NativeCloseTask {
    pub fn parse(value: Value) -> Result<Self, ProtocolError> {
        let command: Self = serde_json::from_value(value)?;
        if command.protocol != NATIVE_PROTOCOL || command.version != PROTOCOL_VERSION {
            return Err(ProtocolError::UnsupportedProtocol {
                protocol: command.protocol.clone(),
                version: command.version,
            });
        }
        Ok(command)
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum NativeCloseTaskKind {
    CloseTask,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct NativeFinishTask {
    pub protocol: String,
    pub version: u16,
    pub kind: NativeFinishTaskKind,
    pub request_id: Uuid,
    pub task_id: Uuid,
    pub disposition: FinishDisposition,
    #[serde(default)]
    pub keep_tab_ids: Vec<u64>,
}

impl NativeFinishTask {
    pub fn parse(value: Value) -> Result<Self, ProtocolError> {
        let command: Self = serde_json::from_value(value)?;
        if command.protocol != NATIVE_PROTOCOL || command.version != PROTOCOL_VERSION {
            return Err(ProtocolError::UnsupportedProtocol {
                protocol: command.protocol.clone(),
                version: command.version,
            });
        }
        Ok(command)
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum NativeFinishTaskKind {
    FinishTask,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct NativeResponse {
    pub protocol: String,
    pub version: u16,
    pub kind: NativeResponseKind,
    pub request_id: Uuid,
    pub outcome: Outcome,
    #[serde(default)]
    pub result: Option<Value>,
    #[serde(default)]
    pub error: Option<RpcError>,
    #[serde(default)]
    pub staged: Option<NativeStagedCommit>,
}

impl NativeResponse {
    pub fn parse(value: Value) -> Result<Self, ProtocolError> {
        if value.pointer("/error/recovery").is_some_and(Value::is_null)
            || value.pointer("/error/details").is_some_and(Value::is_null)
        {
            return Err(ProtocolError::InvalidNativeMessage(
                "native error recovery and details must be omitted or non-null".into(),
            ));
        }
        let response: Self = serde_json::from_value(value)?;
        if response.protocol != NATIVE_PROTOCOL || response.version != PROTOCOL_VERSION {
            return Err(ProtocolError::UnsupportedProtocol {
                protocol: response.protocol.clone(),
                version: response.version,
            });
        }
        let succeeds = matches!(
            response.outcome,
            Outcome::Completed | Outcome::CommitRequired | Outcome::NeedsUser
        );
        if succeeds != response.result.is_some()
            || succeeds == response.error.is_some()
            || (response.outcome == Outcome::CommitRequired) != response.staged.is_some()
        {
            return Err(ProtocolError::InvalidNativeResponse);
        }
        if let Some(error) = &response.error {
            if error.code.is_empty() || error.message.is_empty() {
                return Err(ProtocolError::InvalidNativeMessage(
                    "native error code and message must not be empty".into(),
                ));
            }
        }
        if let Some(staged) = &response.staged {
            staged.validate()?;
        }
        Ok(response)
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum NativeResponseKind {
    Response,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct NativeStagedCommit {
    pub native_token: String,
    pub task_id: Uuid,
    pub tab_id: u64,
    pub page_revision: u64,
    pub effect: String,
    pub fingerprint: String,
    pub expires_at_ms: i64,
}
impl NativeStagedCommit {
    fn validate(&self) -> Result<(), ProtocolError> {
        if !(16..=256).contains(&self.native_token.chars().count())
            || self.tab_id == 0
            || self.effect.is_empty()
            || self.effect.chars().count() > 512
            || !(32..=256).contains(&self.fingerprint.chars().count())
            || self.expires_at_ms < 0
        {
            return Err(ProtocolError::InvalidNativeMessage(
                "staged operation violates native token, tab, effect, fingerprint, or expiry constraints"
                    .into(),
            ));
        }
        Ok(())
    }
}

fn validate_native_handoff(handoff: &NativeHandoff) -> Result<(), ProtocolError> {
    let complete_binding = handoff.task_id.is_some()
        && handoff.tab_id.is_some_and(|tab_id| tab_id != 0)
        && handoff.started_at_ms.is_some_and(|value| value >= 0);
    if handoff.active && !complete_binding {
        return Err(ProtocolError::InvalidNativeMessage(
            "active handoff must bind a task, tab, and non-negative start time".into(),
        ));
    }
    if !handoff.active
        && (handoff.task_id.is_some()
            || handoff.tab_id.is_some()
            || handoff.started_at_ms.is_some())
    {
        return Err(ProtocolError::InvalidNativeMessage(
            "inactive handoff must not retain task, tab, or start-time data".into(),
        ));
    }
    Ok(())
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct NativeEvent {
    pub protocol: String,
    pub version: u16,
    pub kind: NativeEventKind,
    pub event: NativeEventName,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub event_id: Option<String>,
    pub payload: Map<String, Value>,
}

#[derive(Debug, Clone)]
pub enum NativeEventPayload {
    Inventory(NativeInventoryEvent),
    TaskTabs(NativeTaskTabsEvent),
    Pause(NativePauseEvent),
    Handoff(NativeHandoff),
    CommitExpired(NativeCommitExpiredEvent),
    CommitAbandoned(NativeCommitExpiredEvent),
    PopupCommitApproved(NativePopupCommitEvent),
    PopupCommitAbandoned(NativePopupCommitEvent),
    ExtensionDisconnected(NativeDisconnectEvent),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct NativeInventoryEvent {
    pub inventory: Vec<NativeTab>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct NativeTaskTabsEvent {
    pub task_id: Uuid,
    pub tab_count: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct NativePauseEvent {
    pub paused: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct NativeCommitExpiredEvent {
    pub native_token: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct NativePopupCommitEvent {
    pub review_handle: String,
    pub task_id: Uuid,
    pub tab_id: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct NativeDisconnectEvent {
    pub reason: String,
}

impl NativeEvent {
    pub fn parse(value: Value) -> Result<(Self, NativeEventPayload), ProtocolError> {
        let event: Self = serde_json::from_value(value)?;
        if event.protocol != NATIVE_PROTOCOL || event.version != PROTOCOL_VERSION {
            return Err(ProtocolError::UnsupportedProtocol {
                protocol: event.protocol.clone(),
                version: event.version,
            });
        }
        if event.event_id.is_some()
            && !matches!(
                event.event,
                NativeEventName::HandoffChanged
                    | NativeEventName::PopupCommitApproved
                    | NativeEventName::PopupCommitAbandoned
            )
        {
            return Err(ProtocolError::InvalidNativeMessage(
                "event_id is only supported for acknowledged native events".into(),
            ));
        }
        let payload = match event.event {
            NativeEventName::Inventory => {
                NativeEventPayload::Inventory(decode_native_event_payload(event.payload.clone())?)
            }
            NativeEventName::OwnershipRevoked
            | NativeEventName::TabRemoved
            | NativeEventName::GroupMembershipChanged => {
                NativeEventPayload::TaskTabs(decode_native_event_payload(event.payload.clone())?)
            }
            NativeEventName::PauseChanged => {
                NativeEventPayload::Pause(decode_native_event_payload(event.payload.clone())?)
            }
            NativeEventName::HandoffChanged => {
                NativeEventPayload::Handoff(decode_native_event_payload(event.payload.clone())?)
            }
            NativeEventName::CommitExpired => NativeEventPayload::CommitExpired(
                decode_native_event_payload(event.payload.clone())?,
            ),
            NativeEventName::CommitAbandoned => NativeEventPayload::CommitAbandoned(
                decode_native_event_payload(event.payload.clone())?,
            ),
            NativeEventName::PopupCommitApproved => NativeEventPayload::PopupCommitApproved(
                decode_native_event_payload(event.payload.clone())?,
            ),
            NativeEventName::PopupCommitAbandoned => NativeEventPayload::PopupCommitAbandoned(
                decode_native_event_payload(event.payload.clone())?,
            ),
            NativeEventName::ExtensionDisconnected => NativeEventPayload::ExtensionDisconnected(
                decode_native_event_payload(event.payload.clone())?,
            ),
        };
        match &payload {
            NativeEventPayload::Handoff(handoff) => {
                validate_native_handoff(handoff)?;
                if !handoff.active && event.event_id.is_none() {
                    return Err(ProtocolError::InvalidNativeMessage(
                        "inactive handoff event must carry an event_id for durable acknowledgement"
                            .into(),
                    ));
                }
                if let Some(event_id) = &event.event_id {
                    if !(1..=128).contains(&event_id.chars().count()) {
                        return Err(ProtocolError::InvalidNativeMessage(
                            "event_id must contain 1 to 128 characters".into(),
                        ));
                    }
                }
            }
            NativeEventPayload::CommitExpired(event)
            | NativeEventPayload::CommitAbandoned(event)
                if !(16..=256).contains(&event.native_token.chars().count()) =>
            {
                return Err(ProtocolError::InvalidNativeMessage(
                    "native staged token must contain 16 to 256 characters".into(),
                ));
            }
            NativeEventPayload::PopupCommitApproved(popup)
            | NativeEventPayload::PopupCommitAbandoned(popup)
                if !(16..=256).contains(&popup.review_handle.chars().count())
                    || popup.tab_id == 0
                    || event
                        .event_id
                        .as_deref()
                        .and_then(|event_id| Uuid::parse_str(event_id).ok())
                        .filter(|event_id| event_id.get_version_num() == 7)
                        .is_none() =>
            {
                return Err(ProtocolError::InvalidNativeMessage(
                    "popup commit event must bind a review handle, task tab, and UUIDv7 event_id"
                        .into(),
                ));
            }
            NativeEventPayload::ExtensionDisconnected(event) if event.reason.is_empty() => {
                return Err(ProtocolError::InvalidNativeMessage(
                    "disconnect reason must not be empty".into(),
                ));
            }
            _ => {}
        }
        Ok((event, payload))
    }
}

fn decode_native_event_payload<T: DeserializeOwned>(
    payload: Map<String, Value>,
) -> Result<T, ProtocolError> {
    serde_json::from_value(Value::Object(payload))
        .map_err(|error| ProtocolError::InvalidNativeEvent(error.to_string()))
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum NativeEventKind {
    Event,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum NativeEventName {
    Inventory,
    OwnershipRevoked,
    TabRemoved,
    GroupMembershipChanged,
    PauseChanged,
    HandoffChanged,
    CommitExpired,
    CommitAbandoned,
    PopupCommitApproved,
    PopupCommitAbandoned,
    ExtensionDisconnected,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct NativeOriginPolicy {
    pub tab_id: u64,
    pub allowed_origins: Vec<String>,
    pub denied_origins: Vec<String>,
}

pub fn native_command(
    request_id: Uuid,

    connection_id: Uuid,
    task_id: Uuid,
    method: &str,
    params: Value,
    origin_policy: Option<&NativeOriginPolicy>,
) -> Value {
    let mut command = serde_json::json!({
        "protocol": NATIVE_PROTOCOL,
        "version": PROTOCOL_VERSION,
        "kind": "command",
        "request_id": request_id,
        "connection_id": connection_id,
        "task_id": task_id,
        "method": method,
        "params": params,
    });
    if let Some(origin_policy) = origin_policy {
        command["origin_policy"] = serde_json::json!(origin_policy);
    }
    command
}
pub fn native_close_task(request_id: Uuid, task_id: Uuid) -> Value {
    serde_json::json!({
        "protocol": NATIVE_PROTOCOL,
        "version": PROTOCOL_VERSION,
        "kind": "close_task",
        "request_id": request_id,
        "task_id": task_id,
    })
}

pub fn native_finish_task(
    request_id: Uuid,
    task_id: Uuid,
    disposition: FinishDisposition,
    keep_tab_ids: &[u64],
) -> Value {
    serde_json::json!({
        "protocol": NATIVE_PROTOCOL,
        "version": PROTOCOL_VERSION,
        "kind": "finish_task",
        "request_id": request_id,
        "task_id": task_id,
        "disposition": disposition,
        "keep_tab_ids": keep_tab_ids,
    })
}

pub fn native_event_ack(event: NativeEventName, event_id: &str) -> Value {
    serde_json::json!({
        "protocol": NATIVE_PROTOCOL,
        "version": PROTOCOL_VERSION,
        "kind": "event_ack",
        "event": event,
        "event_id": event_id,
    })
}

pub fn native_event_ack_result(
    event: NativeEventName,
    event_id: &str,
    outcome: Outcome,
    result: Option<Value>,
    error: Option<RpcError>,
) -> Value {
    let mut value = native_event_ack(event, event_id);
    let object = value
        .as_object_mut()
        .expect("native event acknowledgement is always an object");
    object.insert(
        "outcome".into(),
        serde_json::to_value(outcome).expect("outcome serializes"),
    );
    if let Some(result) = result {
        object.insert("result".into(), result);
    }
    if let Some(error) = error {
        object.insert(
            "error".into(),
            serde_json::to_value(error).expect("error serializes"),
        );
    }
    value
}

pub fn native_ready(state: RuntimeState) -> Value {
    serde_json::json!({
        "protocol": NATIVE_PROTOCOL,
        "version": PROTOCOL_VERSION,
        "kind": "ready",
        "host_version": env!("CARGO_PKG_VERSION"),
        "state": state,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    fn request(method: &str, params: Value, mutation: bool) -> Value {
        let mut value = json!({
            "protocol": RPC_PROTOCOL,
            "version": PROTOCOL_VERSION,
            "request_id": "constraint-test",
            "method": method,
            "params": params,
        });
        if mutation {
            value["idempotency_key"] = json!(Uuid::now_v7());
        }
        value
    }

    #[test]
    fn schema_assets_are_valid_json_and_cover_every_method() {
        for (name, schema) in RPC_SCHEMA_ASSETS {
            serde_json::from_str::<Value>(schema)
                .unwrap_or_else(|error| panic!("{name} schema is invalid: {error}"));
        }
        serde_json::from_str::<Value>(NATIVE_SCHEMA).unwrap();
        let names = RPC_SCHEMA_ASSETS
            .iter()
            .map(|(name, _)| *name)
            .collect::<Vec<_>>();
        for required in [
            "browser_open",
            "browser_snapshot",
            "browser_act",
            "browser_wait",
            "browser_tabs",
            "browser_handoff",
            "browser_commit",
            "browser_developer",
        ] {
            assert!(names.contains(&required));
        }
    }

    #[test]
    fn request_envelope_rejects_unknown_fields_and_non_v7_mutation_keys() {
        let unknown = json!({
            "protocol": RPC_PROTOCOL,
            "version": 1,
            "request_id": "r1",
            "method": "browser_tabs",
            "params": {},
            "extra": true
        });
        assert!(RpcRequest::parse(unknown).is_err());

        let wrong_key = json!({
            "protocol": RPC_PROTOCOL,
            "version": 1,
            "request_id": "r2",
            "idempotency_key": Uuid::new_v4(),
            "method": "browser_open",
            "params": {"mode": "create"}
        });
        assert!(matches!(
            RpcRequest::parse(wrong_key),
            Err(ProtocolError::InvalidIdempotencyKey)
        ));
    }

    #[test]
    fn standard_requests_reject_explicit_nulls_that_schemas_reject() {
        let mut envelope = request("browser_tabs", json!({}), false);
        envelope["idempotency_key"] = Value::Null;
        assert!(matches!(
            RpcRequest::parse(envelope),
            Err(ProtocolError::InvalidParamConstraint { .. })
        ));

        assert!(matches!(
            RpcRequest::parse(request(
                "browser_snapshot",
                json!({"mode": "text", "tab_id": 7, "selector": null}),
                false,
            )),
            Err(ProtocolError::InvalidParamConstraint { .. })
        ));
        assert!(RpcRequest::parse(request(
            "browser_developer",
            json!({"action": "Runtime.evaluate", "params": {"returnByValue": null}}),
            true,
        ))
        .is_ok());
    }

    #[test]
    fn dedicated_task_windows_are_background_only() {
        let (_, params) = RpcRequest::parse(request(
            "browser_open",
            json!({
                "mode": "create",
                "url": "https://example.com/workspace",
                "placement": "new_window"
            }),
            true,
        ))
        .unwrap();
        assert!(matches!(
            params,
            MethodParams::Open(BrowserOpenParams::Create {
                background: true,
                placement: BrowserOpenPlacement::NewWindow,
                ..
            })
        ));

        assert!(matches!(
            RpcRequest::parse(request(
                "browser_open",
                json!({
                    "mode": "create",
                    "placement": "new_window",
                    "background": false
                }),
                true,
            )),
            Err(ProtocolError::InvalidParamConstraint { .. })
        ));
    }

    #[test]
    fn typed_actions_require_revision_and_reject_unknown_fields() {
        let valid = json!({
            "protocol": RPC_PROTOCOL,
            "version": 1,
            "request_id": "r3",
            "idempotency_key": Uuid::now_v7(),
            "method": "browser_act",
            "params": {
                "tab_id": 7,
                "expected_page_revision": 11,
                "actions": [{"kind": "click", "ref": "e4"}]
            }
        });
        assert!(matches!(
            RpcRequest::parse(valid).unwrap().1,
            MethodParams::Act(_)
        ));

        let unknown_action_field = json!({
            "protocol": RPC_PROTOCOL,
            "version": 1,
            "request_id": "r4",
            "idempotency_key": Uuid::now_v7(),
            "method": "browser_act",
            "params": {
                "tab_id": 7,
                "expected_page_revision": 11,
                "actions": [{"kind": "click", "ref": "e4", "x": 1}]
            }
        });
        assert!(RpcRequest::parse(unknown_action_field).is_err());
    }
    #[test]
    fn standard_actions_reject_press() {
        let press = json!({
            "tab_id": 7,
            "expected_page_revision": 11,
            "actions": [{"kind": "press", "ref": "e4", "key": "Enter"}]
        });
        assert!(RpcRequest::parse(request("browser_act", press, true)).is_err());
    }

    #[test]
    fn runtime_constraints_match_action_schema_boundaries() {
        let history = request(
            "browser_act",
            json!({
                "tab_id": 7,
                "expected_page_revision": 11,
                "actions": [
                    {"kind": "go_back"},
                    {"kind": "select", "ref": "e1", "value": ""},
                    {"kind": "scroll", "delta_x": 100000, "delta_y": -100000}
                ]
            }),
            true,
        );
        assert!(RpcRequest::parse(history).is_ok());

        for params in [
            json!({"tab_id": 7, "expected_page_revision": 11, "actions": []}),
            json!({
                "tab_id": 7,
                "expected_page_revision": 11,
                "actions": [{"kind": "scroll", "delta_x": 100001, "delta_y": 0}]
            }),
            json!({
                "tab_id": 7,
                "expected_page_revision": 11,
                "actions": [{"kind": "click", "ref": ""}]
            }),
        ] {
            assert!(matches!(
                RpcRequest::parse(request("browser_act", params, true)),
                Err(ProtocolError::InvalidParamConstraint { .. })
            ));
        }
    }

    #[test]
    fn runtime_constraints_reject_schema_invalid_limits() {
        for (method, params, mutation) in [
            (
                "browser_open",
                json!({"mode": "create", "url": "file:///private"}),
                true,
            ),
            (
                "browser_snapshot",
                json!({"mode": "accessibility", "tab_id": 1, "max_nodes": 5001}),
                false,
            ),
            (
                "browser_wait",
                json!({"tab_id": 1, "condition": {"kind": "load"}, "timeout_ms": 0}),
                false,
            ),
            (
                "browser_handoff",
                json!({
                    "tab_id": 1,
                    "expected_page_revision": 1,
                    "prompt": "",
                    "completion": {"kind": "manual_done"}
                }),
                true,
            ),
            ("browser_commit", json!({"staged_token": "short"}), true),
            (
                "browser_developer",
                json!({"action": "", "params": {}}),
                true,
            ),
        ] {
            assert!(matches!(
                RpcRequest::parse(request(method, params, mutation)),
                Err(ProtocolError::InvalidParamConstraint { .. })
            ));
        }
    }

    #[test]
    fn screenshot_encoding_constraints_match_the_public_schema() {
        let (_, valid) = RpcRequest::parse(request(
            "browser_snapshot",
            json!({
                "mode": "screenshot",
                "tab_id": 7,
                "format": "webp",
                "quality": 72,
                "max_width": 1280,
                "max_height": 720,
                "max_bytes": 500000
            }),
            false,
        ))
        .unwrap();
        assert!(matches!(
            valid,
            MethodParams::Snapshot(BrowserSnapshotParams::Screenshot {
                format: Some(ScreenshotFormat::Webp),
                quality: Some(72),
                max_width: Some(1280),
                max_height: Some(720),
                max_bytes: Some(500000),
                ..
            })
        ));

        for params in [
            json!({"mode": "screenshot", "tab_id": 7, "format": "png", "quality": 80}),
            json!({"mode": "screenshot", "tab_id": 7, "max_bytes": 750001}),
            json!({"mode": "screenshot", "tab_id": 7, "max_width": 16385}),
            json!({"mode": "screenshot", "tab_id": 7, "selector": "main", "full_page": true}),
            json!({"mode": "html", "tab_id": 7, "max_bytes": 1000001}),
        ] {
            assert!(matches!(
                RpcRequest::parse(request("browser_snapshot", params, false)),
                Err(ProtocolError::InvalidParamConstraint { .. })
                    | Err(ProtocolError::InvalidParams { .. })
            ));
        }
    }

    #[test]
    fn selector_addressing_and_task_close_match_the_public_schema() {
        let (_, snapshot) = RpcRequest::parse(request(
            "browser_snapshot",
            json!({
                "mode": "html",
                "tab_id": 7,
                "selector": "[data-message-author-role=\"assistant\"]",
                "match": "last"
            }),
            false,
        ))
        .unwrap();
        assert!(matches!(
            snapshot,
            MethodParams::Snapshot(BrowserSnapshotParams::Html {
                r#match: Some(SnapshotSelectorMatch::Last),
                ..
            })
        ));
        assert!(matches!(
            RpcRequest::parse(request(
                "browser_snapshot",
                json!({"mode": "html", "tab_id": 7, "match": "last"}),
                false,
            )),
            Err(ProtocolError::InvalidParamConstraint { .. })
        ));

        let (_, upload) = RpcRequest::parse(request(
            "browser_act",
            json!({
                "tab_id": 7,
                "expected_page_revision": 1,
                "actions": [{
                    "kind": "upload_file",
                    "selector": "input[type=\"file\"]",
                    "files": ["/tmp/a.png"]
                }]
            }),
            true,
        ))
        .unwrap();
        assert!(matches!(
            upload,
            MethodParams::Act(BrowserActParams { actions, .. })
                if matches!(
                    actions.as_slice(),
                    [BrowserAction::UploadFile {
                        r#ref: None,
                        selector: Some(selector),
                        ..
                    }] if selector == "input[type=\"file\"]"
                )
        ));

        for action in [
            json!({"kind": "upload_file", "files": ["/tmp/a.png"]}),
            json!({
                "kind": "upload_file",
                "ref": "r1-2",
                "selector": "input[type=\"file\"]",
                "files": ["/tmp/a.png"]
            }),
        ] {
            assert!(RpcRequest::parse(request(
                "browser_act",
                json!({
                    "tab_id": 7,
                    "expected_page_revision": 1,
                    "actions": [action]
                }),
                true,
            ))
            .is_err());
        }

        let (_, close) = RpcRequest::parse(request("agenttab.close", json!({}), false)).unwrap();
        assert!(matches!(close, MethodParams::Close(_)));

        let (_, finish) = RpcRequest::parse(request(
            "agenttab.finish",
            json!({"disposition": "auto", "keep_tab_ids": [7, 9]}),
            false,
        ))
        .unwrap();
        assert!(matches!(
            finish,
            MethodParams::Finish(AgenttabFinishParams {
                disposition: FinishDisposition::Auto,
                keep_tab_ids,
            }) if keep_tab_ids == vec![7, 9]
        ));
        assert!(RpcRequest::parse(request(
            "agenttab.finish",
            json!({"disposition": "auto", "keep_tab_ids": [7, 7]}),
            false,
        ))
        .is_err());
    }

    #[test]
    fn connection_runtime_constraints_match_schema() {
        assert!(matches!(
            ConnectionInit::parse(json!({
                "protocol": RPC_PROTOCOL,
                "version": PROTOCOL_VERSION,
                "kind": "connect",
                "conversation_id": ""
            })),
            Err(ProtocolError::InvalidConnection(_))
        ));
        assert!(matches!(
            ConnectionInit::parse(json!({
                "protocol": RPC_PROTOCOL,
                "version": PROTOCOL_VERSION,
                "kind": "connect",
                "resume_capability": "short"
            })),
            Err(ProtocolError::InvalidConnection(_))
        ));
        let confirmation = ResumeCapabilityConfirm::parse(json!({
            "protocol": RPC_PROTOCOL,
            "version": PROTOCOL_VERSION,
            "kind": "resume_confirm",
            "connection_id": "018f22b2-4126-7c1a-8c31-3f45a783da42",
            "resume_capability": "a".repeat(32)
        }))
        .unwrap();
        assert_eq!(
            confirmation.connection_id,
            Uuid::parse_str("018f22b2-4126-7c1a-8c31-3f45a783da42").unwrap()
        );
        assert!(matches!(
            ResumeCapabilityConfirm::parse(json!({
                "protocol": RPC_PROTOCOL,
                "version": PROTOCOL_VERSION,
                "kind": "resume_confirm",
                "connection_id": "018f22b2-4126-7c1a-8c31-3f45a783da42",
                "resume_capability": "short"
            })),
            Err(ProtocolError::InvalidConnection(_))
        ));
        assert!(ResumeCapabilityConfirm::parse(json!({
            "protocol": RPC_PROTOCOL,
            "version": PROTOCOL_VERSION,
            "kind": "resume_confirm",
            "connection_id": "018f22b2-4126-7c1a-8c31-3f45a783da42",
            "resume_capability": "a".repeat(32),
            "task_id": Uuid::new_v4()
        }))
        .is_err());
        let confirmed = ResumeCapabilityConfirmed {
            protocol: RPC_PROTOCOL.into(),
            version: PROTOCOL_VERSION,
            kind: ResumeCapabilityConfirmedKind::ResumeConfirmed,
            connection_id: confirmation.connection_id,
        };
        assert_eq!(confirmed.value()["kind"], "resume_confirmed");
    }

    #[test]
    fn maximum_schema_bound_requests_fit_the_one_megabyte_client_frame() {
        let escaped = |count| "\0".repeat(count);
        let request_id = escaped(128);
        let ref_value = escaped(MAX_REF_CHARS);
        let action_cases = [
            json!({"kind": "type", "ref": ref_value, "text": escaped(MAX_ACTION_TEXT_CHARS)}),
            json!({"kind": "fill", "ref": escaped(MAX_REF_CHARS), "text": escaped(MAX_ACTION_TEXT_CHARS)}),
            json!({"kind": "select", "ref": escaped(MAX_REF_CHARS), "value": escaped(MAX_ACTION_VALUE_CHARS)}),
            json!({"kind": "dialog", "decision": "accept"}),
            json!({
                "kind": "upload_file",
                "ref": escaped(MAX_REF_CHARS),
                "files": vec![escaped(MAX_UPLOAD_PATH_CHARS); MAX_UPLOAD_FILES]
            }),
            json!({"kind": "navigate", "url": format!("https://{}", escaped(MAX_URL_CHARS - 8))}),
            json!({"kind": "drag", "ref": escaped(MAX_REF_CHARS), "target_ref": escaped(MAX_REF_CHARS)}),
        ];
        for action in action_cases {
            let mut value = request(
                "browser_act",
                json!({
                    "tab_id": u64::MAX,
                    "expected_page_revision": u64::MAX,
                    "actions": vec![action; MAX_ACTIONS],
                }),
                true,
            );
            value["request_id"] = json!(request_id.clone());
            assert!(
                serde_json::to_vec(&value).unwrap().len() <= CLIENT_TO_HOST_MAX_BYTES,
                "schema-valid request exceeded the client frame"
            );
            assert!(RpcRequest::parse(value).is_ok());
        }

        let developer_params = (0..MAX_DEVELOPER_PARAMS)
            .map(|index| {
                (
                    escaped(MAX_DEVELOPER_PARAM_KEY_CHARS - 2) + &format!("{index:02}"),
                    json!(vec![
                        escaped(MAX_DEVELOPER_VALUE_CHARS);
                        MAX_DEVELOPER_ARRAY_ITEMS
                    ]),
                )
            })
            .collect::<Map<_, _>>();
        let mut developer = request(
            "browser_developer",
            json!({
                "action": escaped(128),
                "params": developer_params,
            }),
            true,
        );
        developer["request_id"] = json!(request_id);
        assert!(serde_json::to_vec(&developer).unwrap().len() <= CLIENT_TO_HOST_MAX_BYTES);
        assert!(RpcRequest::parse(developer).is_ok());

        let action_schema = RPC_SCHEMA_ASSETS
            .iter()
            .find_map(|(name, schema)| (*name == "browser_act").then_some(schema))
            .unwrap();
        let action_schema: Value = serde_json::from_str(action_schema).unwrap();
        assert_eq!(
            action_schema.pointer("/$defs/type/properties/text/maxLength"),
            Some(&json!(MAX_ACTION_TEXT_CHARS))
        );
        assert_eq!(
            action_schema.pointer("/$defs/upload_file/properties/files/maxItems"),
            Some(&json!(MAX_UPLOAD_FILES))
        );
        assert_eq!(
            action_schema.pointer("/$defs/upload_file/properties/files/items/maxLength"),
            Some(&json!(MAX_UPLOAD_PATH_CHARS))
        );
        assert!(action_schema.pointer("/$defs/press").is_none());
        assert!(!action_schema["$defs"]["action"]["oneOf"]
            .as_array()
            .unwrap()
            .iter()
            .any(|entry| entry == &json!({"$ref": "#/$defs/press"})));
    }

    #[test]
    fn native_error_schema_and_parser_reject_empty_or_unknown_error_fields() {
        let native_schema: Value = serde_json::from_str(NATIVE_SCHEMA).unwrap();
        let error_schema = native_schema.pointer("/$defs/rpc_error").unwrap();
        assert_eq!(error_schema["required"], json!(["code", "message"]));
        assert_eq!(error_schema["properties"]["code"]["minLength"], json!(1));
        assert_eq!(error_schema["properties"]["message"]["minLength"], json!(1));
        assert_eq!(error_schema["additionalProperties"], json!(false));

        for error in [
            json!({"code": "", "message": "failed"}),
            json!({"code": "failed", "message": ""}),
            json!({"code": "failed", "message": "failed", "recovery": null}),
            json!({"code": "failed", "message": "failed", "details": null}),
            json!({"code": "failed", "message": "failed", "extra": true}),
        ] {
            assert!(NativeResponse::parse(json!({
                "protocol": NATIVE_PROTOCOL,
                "version": PROTOCOL_VERSION,
                "kind": "response",
                "request_id": Uuid::new_v4(),
                "outcome": "not_started",
                "error": error,
            }))
            .is_err());
        }
    }

    #[test]
    fn native_close_task_is_strict_and_versioned() {
        let request_id = Uuid::new_v4();
        let task_id = Uuid::new_v4();
        let message = native_close_task(request_id, task_id);
        let parsed = NativeCloseTask::parse(message.clone()).unwrap();
        assert_eq!(parsed.request_id, request_id);
        assert_eq!(parsed.task_id, task_id);

        let mut unknown = message;
        unknown["unexpected"] = json!(true);
        assert!(NativeCloseTask::parse(unknown).is_err());
    }

    #[test]
    fn native_finish_task_is_strict_and_versioned() {
        let request_id = Uuid::new_v4();
        let task_id = Uuid::new_v4();
        let message = native_finish_task(request_id, task_id, FinishDisposition::Auto, &[17]);
        let parsed = NativeFinishTask::parse(message.clone()).unwrap();
        assert_eq!(parsed.request_id, request_id);
        assert_eq!(parsed.task_id, task_id);
        assert_eq!(parsed.disposition, FinishDisposition::Auto);
        assert_eq!(parsed.keep_tab_ids, vec![17]);

        let mut unknown = message;
        unknown["unexpected"] = json!(true);
        assert!(NativeFinishTask::parse(unknown).is_err());
    }

    #[test]
    fn framing_is_little_endian_and_bounded_before_allocation() {
        let mut bytes = Vec::new();
        write_frame(&mut bytes, &json!({"ok": true}), 128).unwrap();
        assert_eq!(
            u32::from_le_bytes(bytes[..4].try_into().unwrap()) as usize,
            bytes.len() - 4
        );
        assert_eq!(
            read_frame(&mut bytes.as_slice(), 128).unwrap(),
            Some(json!({"ok": true}))
        );

        let mut oversized = (129_u32).to_le_bytes().to_vec();
        oversized.extend_from_slice(b"{}");
        assert!(matches!(
            read_frame(&mut oversized.as_slice(), 128),
            Err(ProtocolError::Oversize {
                declared: 129,
                limit: 128
            })
        ));
    }

    #[test]
    fn response_constructors_emit_exactly_one_payload_branch() {
        let success = RpcResponse::success("r", Outcome::Completed, json!({"ok": true}));
        assert!(success.ok);
        assert!(success.result.is_some());
        assert!(success.error.is_none());
        let failure = RpcResponse::failure(
            "r",
            Outcome::NotStarted,
            RpcError::new("invalid_request", "bad request"),
        );
        assert!(!failure.ok);
        assert!(failure.result.is_none());
        assert!(failure.error.is_some());
    }
    #[test]
    fn handoff_clear_event_requires_acknowledgement_id_and_preserves_it() {
        let clear = json!({
            "protocol": NATIVE_PROTOCOL,
            "version": PROTOCOL_VERSION,
            "kind": "event",
            "event": "handoff_changed",
            "payload": {"active": false}
        });
        assert!(matches!(
            NativeEvent::parse(clear),
            Err(ProtocolError::InvalidNativeMessage(_))
        ));

        let event_id = "handoff-clear-0001";
        let (event, payload) = NativeEvent::parse(json!({
            "protocol": NATIVE_PROTOCOL,
            "version": PROTOCOL_VERSION,
            "kind": "event",
            "event": "handoff_changed",
            "event_id": event_id,
            "payload": {"active": false}
        }))
        .unwrap();
        assert_eq!(event.event_id.as_deref(), Some(event_id));
        assert!(matches!(
            payload,
            NativeEventPayload::Handoff(NativeHandoff { active: false, .. })
        ));
        assert_eq!(
            native_event_ack(NativeEventName::HandoffChanged, event_id),
            json!({
                "protocol": NATIVE_PROTOCOL,
                "version": PROTOCOL_VERSION,
                "kind": "event_ack",
                "event": "handoff_changed",
                "event_id": event_id,
            })
        );
    }

    #[test]
    fn acknowledgement_ids_are_rejected_for_unacknowledged_events() {
        assert!(matches!(
            NativeEvent::parse(json!({
                "protocol": NATIVE_PROTOCOL,
                "version": PROTOCOL_VERSION,
                "kind": "event",
                "event": "pause_changed",
                "event_id": "not-allowed",
                "payload": {"paused": true}
            })),
            Err(ProtocolError::InvalidNativeMessage(_))
        ));
    }

    #[test]
    fn popup_commit_events_require_a_uuidv7_event_id_and_typed_binding() {
        let task_id = Uuid::now_v7();
        let valid = json!({
            "protocol": NATIVE_PROTOCOL,
            "version": PROTOCOL_VERSION,
            "kind": "event",
            "event": "popup_commit_approved",
            "event_id": Uuid::now_v7(),
            "payload": {
                "review_handle": "review-handle-000",
                "task_id": task_id,
                "tab_id": 3,
            }
        });
        assert!(matches!(
            NativeEvent::parse(valid),
            Ok((_, NativeEventPayload::PopupCommitApproved(NativePopupCommitEvent {
                task_id: parsed_task_id,
                tab_id: 3,
                ..
            }))) if parsed_task_id == task_id
        ));

        let invalid = json!({
            "protocol": NATIVE_PROTOCOL,
            "version": PROTOCOL_VERSION,
            "kind": "event",
            "event": "popup_commit_approved",
            "event_id": Uuid::new_v4(),
            "payload": {
                "review_handle": "review-handle-000",
                "task_id": task_id,
                "tab_id": 3,
            }
        });
        assert!(matches!(
            NativeEvent::parse(invalid),
            Err(ProtocolError::InvalidNativeMessage(_))
        ));
    }
}
