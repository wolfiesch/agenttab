use std::collections::HashMap;
use std::fs::OpenOptions;
use std::io::{self, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::mpsc::Sender;
use std::sync::{Arc, Mutex, RwLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use socket2::{Domain, Protocol, Socket, Type};

/// Directory of the current executable; base for default token/log paths.
fn host_dir() -> PathBuf {
    std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|d| d.to_path_buf()))
        .unwrap_or_else(|| PathBuf::from("."))
}

/// Mutex-guarded file logger. Never writes to stdout.
struct Logger {
    file: Mutex<std::fs::File>,
}

impl Logger {
    fn new(path: &PathBuf) -> io::Result<Logger> {
        let file = OpenOptions::new().append(true).create(true).open(path)?;
        Ok(Logger {
            file: Mutex::new(file),
        })
    }

    fn log(&self, level: &str, msg: &str) {
        let line = format!(
            "{} - {} - {}",
            chrono::Local::now().format("%Y-%m-%d %H:%M:%S,%3f"),
            level,
            msg
        );
        if let Ok(mut f) = self.file.lock() {
            let _ = writeln!(f, "{}", line);
            let _ = f.flush();
        }
    }
}

fn log_info(logger: &Arc<Logger>, msg: &str) {
    logger.log("INFO", msg);
}

fn log_warn(logger: &Arc<Logger>, msg: &str) {
    logger.log("WARNING", msg);
}

fn log_error(logger: &Arc<Logger>, msg: &str) {
    logger.log("ERROR", msg);
}

fn log_path(host_dir: &Path) -> PathBuf {
    match std::env::var("BRIDGE_LOG_FILE") {
        Ok(p) => PathBuf::from(p),
        Err(_) => host_dir.join("bridge_debug.log"),
    }
}

/// Path of the legacy single-token file (BRIDGE_TOKEN_FILE or <host_dir>/bridge_token.txt).
fn token_file_path(host_dir: &Path) -> PathBuf {
    match std::env::var("BRIDGE_TOKEN_FILE") {
        Ok(p) => PathBuf::from(p),
        Err(_) => host_dir.join("bridge_token.txt"),
    }
}

/// Path of the named-token file (BRIDGE_TOKENS_FILE or <host_dir>/bridge_tokens.txt).
fn tokens_file_path(host_dir: &Path) -> PathBuf {
    match std::env::var("BRIDGE_TOKENS_FILE") {
        Ok(p) => PathBuf::from(p),
        Err(_) => host_dir.join("bridge_tokens.txt"),
    }
}

/// Last-modified time of a path, or None when the file is missing/unreadable.
fn file_mtime(path: &Path) -> Option<SystemTime> {
    std::fs::metadata(path).and_then(|m| m.modified()).ok()
}

/// Read BRIDGE_TOKEN_FILE env or <host_dir>/bridge_token.txt, trimmed.
fn load_token(host_dir: &Path, logger: &Arc<Logger>) -> Option<String> {
    let token_file = token_file_path(host_dir);
    match std::fs::read_to_string(&token_file) {
        Ok(s) => Some(s.trim().to_string()),
        Err(e) => {
            log_error(
                logger,
                &format!("Could not read token file {}: {}", token_file.display(), e),
            );
            None
        }
    }
}

/// Build a token -> client-name registry.
///
/// The legacy single token (BRIDGE_TOKEN_FILE, default <host_dir>/bridge_token.txt)
/// is registered under the name `default`. If BRIDGE_TOKENS_FILE (default
/// <host_dir>/bridge_tokens.txt) exists, each non-empty, non-`#` line is parsed
/// as `name:token` (split on the first ':') and added to the registry.
fn load_tokens(host_dir: &Path, logger: &Arc<Logger>) -> HashMap<String, String> {
    let mut tokens: HashMap<String, String> = HashMap::new();

    if let Some(legacy) = load_token(host_dir, logger) {
        if !legacy.is_empty() {
            tokens.insert(legacy, "default".to_string());
        }
    }

    let tokens_file = tokens_file_path(host_dir);
    if tokens_file.exists() {
        match std::fs::read_to_string(&tokens_file) {
            Ok(contents) => {
                for line in contents.lines() {
                    let trimmed = line.trim();
                    if trimmed.is_empty() || trimmed.starts_with('#') {
                        continue;
                    }
                    match trimmed.split_once(':') {
                        Some((name, tok)) => {
                            let name = name.trim();
                            let tok = tok.trim();
                            if !name.is_empty() && !tok.is_empty() {
                                tokens.insert(tok.to_string(), name.to_string());
                            }
                        }
                        None => {
                            log_warn(
                                logger,
                                &format!("Ignoring malformed token line (expected name:token): {}", trimmed),
                            );
                        }
                    }
                }
            }
            Err(e) => {
                log_error(
                    logger,
                    &format!("Could not read tokens file {}: {}", tokens_file.display(), e),
                );
            }
        }
    }

    tokens
}

/// Framed stdout writer: native-endian u32 length prefix + JSON bytes.
fn write_message(stdout: &Arc<Mutex<io::Stdout>>, logger: &Arc<Logger>, message: &Value) {
    let encoded = serde_json::to_vec(message).unwrap_or_else(|_| b"{}".to_vec());
    let id = message.get("id");
    let action = message.get("action");
    log_info(
        logger,
        &format!(
            "Forwarding to extension: id={} action={} ({} bytes)",
            value_field(id),
            value_field(action),
            encoded.len()
        ),
    );
    if let Ok(mut out) = stdout.lock() {
        let _ = out.write_all(&(encoded.len() as u32).to_ne_bytes());
        let _ = out.write_all(&encoded);
        let _ = out.flush();
    }
}

/// Render an optional JSON field roughly like Python's str(message.get(k)).
fn value_field(v: Option<&Value>) -> String {
    match v {
        None | Some(Value::Null) => "None".to_string(),
        Some(Value::String(s)) => s.clone(),
        Some(other) => other.to_string(),
    }
}

/// Per-request channel registry: in-flight request id -> Sender the handler
/// thread blocks on for the extension's response. The stdin reader routes
/// responses here.
type Pending = Arc<Mutex<HashMap<String, Sender<Value>>>>;

#[derive(Clone)]
struct Confirmation {
    fingerprint: String,
    expires_at: u128,
    client: String,
    action: String,
    payload: Value,
    targets: Vec<String>,
}

type Confirmations = Arc<Mutex<HashMap<String, Confirmation>>>;

/// token -> client name registry plus the recorded mtimes of the two token
/// files, shared across connections and reloadable under a write lock.
struct TokenRegistry {
    map: HashMap<String, String>,
    token_file_mtime: Option<SystemTime>,
    tokens_file_mtime: Option<SystemTime>,
}

type Tokens = Arc<RwLock<TokenRegistry>>;

/// Build the registry: load the map and record both files' current mtimes.
fn build_registry(host_dir: &Path, logger: &Arc<Logger>) -> TokenRegistry {
    TokenRegistry {
        map: load_tokens(host_dir, logger),
        token_file_mtime: file_mtime(&token_file_path(host_dir)),
        tokens_file_mtime: file_mtime(&tokens_file_path(host_dir)),
    }
}

/// Resolve a request token to a client name. On a miss, reload the registry if
/// either token file's mtime advanced (or an absent file became present) and
/// re-lookup; only a still-absent token is unresolved.
fn resolve_client(
    tokens: &Tokens,
    host_dir: &Path,
    logger: &Arc<Logger>,
    token: &str,
) -> Option<String> {
    if let Ok(reg) = tokens.read() {
        if let Some(name) = reg.map.get(token) {
            return Some(name.clone());
        }
    }

    let cur_token = file_mtime(&token_file_path(host_dir));
    let cur_tokens = file_mtime(&tokens_file_path(host_dir));

    if let Ok(mut reg) = tokens.write() {
        if cur_token != reg.token_file_mtime || cur_tokens != reg.tokens_file_mtime {
            reg.map = load_tokens(host_dir, logger);
            reg.token_file_mtime = cur_token;
            reg.tokens_file_mtime = cur_tokens;
        }
        return reg.map.get(token).cloned();
    }

    None
}

/// Cooperative single-holder lease over the shared Chrome profile.
struct Lease {
    owner: Option<String>,
    expires_at: Option<u128>,
}

type LeaseState = Arc<Mutex<Lease>>;

/// Current wall-clock time in epoch milliseconds.
fn now_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
}

/// Idle read timeout for a persistent connection (BRIDGE_SOCKET_IDLE_TIMEOUT, default 300s).
fn socket_idle_timeout() -> Duration {
    let secs = std::env::var("BRIDGE_SOCKET_IDLE_TIMEOUT")
        .ok()
        .and_then(|s| s.trim().parse::<f64>().ok())
        .filter(|s| *s > 0.0)
        .unwrap_or(300.0);
    Duration::from_secs_f64(secs)
}

fn confirmation_ttl_ms() -> u128 {
    std::env::var("BRIDGE_CONFIRMATION_TTL_MS")
        .ok()
        .and_then(|s| s.trim().parse::<u128>().ok())
        .unwrap_or(60_000)
}

fn confirmation_fingerprint(client: &str, action: &str, payload: &Value, targets: &[String]) -> String {
    let data = json!({
        "client": client,
        "action": action,
        "payload": payload,
        "targets": targets,
    });
    let encoded = serde_json::to_vec(&data).unwrap_or_default();
    let digest = Sha256::digest(&encoded);
    format!("{:x}", digest)
}

fn prune_confirmations_locked(map: &mut HashMap<String, Confirmation>, now: u128) {
    map.retain(|_, entry| entry.expires_at > now);
}

fn issue_confirmation(
    confirmations: &Confirmations,
    client: &str,
    action: &str,
    payload: &Value,
    targets: &[String],
) -> (String, u128) {
    let expires_at = now_ms() + confirmation_ttl_ms();
    let token = uuid::Uuid::new_v4().to_string();
    let fingerprint = confirmation_fingerprint(client, action, payload, targets);
    if let Ok(mut map) = confirmations.lock() {
        prune_confirmations_locked(&mut map, now_ms());
        map.insert(token.clone(), Confirmation {
            fingerprint,
            expires_at,
            client: client.to_string(),
            action: action.to_string(),
            payload: payload.clone(),
            targets: targets.to_vec(),
        });
    }
    (token, expires_at)
}

fn resume_confirmation(
    confirmations: &Confirmations,
    token: Option<&str>,
) -> Option<(String, String, Value)> {
    let token = token.filter(|t| !t.is_empty())?;
    if let Ok(mut map) = confirmations.lock() {
        prune_confirmations_locked(&mut map, now_ms());
        let entry = map.get(token)?;
        // Keep these fields in the pending entry so the normal fingerprint
        // check still binds token/client/action/payload/live targets.
        let _targets = &entry.targets;
        return Some((entry.client.clone(), entry.action.clone(), entry.payload.clone()));
    }
    None
}

fn consume_confirmation(
    confirmations: &Confirmations,
    token: Option<&str>,
    client: &str,
    action: &str,
    payload: &Value,
    targets: &[String],
) -> bool {
    let token = match token {
        Some(t) if !t.is_empty() => t,
        _ => return false,
    };
    let fingerprint = confirmation_fingerprint(client, action, payload, targets);
    if let Ok(mut map) = confirmations.lock() {
        prune_confirmations_locked(&mut map, now_ms());
        if map.get(token).map(|entry| entry.fingerprint.as_str()) == Some(fingerprint.as_str()) {
            map.remove(token);
            return true;
        }
    }
    false
}

/// Resolve the live lease owner, clearing the lease in place if its TTL expired.
fn live_owner(lease: &mut Lease, now: u128) -> Option<String> {
    match lease.expires_at {
        Some(exp) if now < exp => lease.owner.clone(),
        _ => {
            lease.owner = None;
            lease.expires_at = None;
            None
        }
    }
}

/// Handle lease/release/leaseStatus host-side. Returns None if `action` is not
/// a lease verb (caller should forward to the extension instead).
fn handle_lease_action(action: &str, payload: Option<&Value>, client: &str, lease: &LeaseState) -> Option<Value> {
    let now = now_ms();
    match action {
        "lease" => {
            let ttl = payload
                .and_then(|p| p.get("ttlMs"))
                .and_then(|v| v.as_u64())
                .unwrap_or(300_000) as u128;
            let resp = if let Ok(mut g) = lease.lock() {
                match live_owner(&mut g, now) {
                    Some(o) if o != client => {
                        json!({"success": false, "error": format!("leased by {}", o)})
                    }
                    _ => {
                        let expires = now + ttl;
                        g.owner = Some(client.to_string());
                        g.expires_at = Some(expires);
                        json!({"success": true, "result": {
                            "owner": client,
                            "expiresAt": expires as u64,
                            "ttlMs": ttl as u64
                        }})
                    }
                }
            } else {
                json!({"success": false, "error": "lease state unavailable"})
            };
            Some(resp)
        }
        "release" => {
            let resp = if let Ok(mut g) = lease.lock() {
                match live_owner(&mut g, now) {
                    Some(o) if o != client => {
                        json!({"success": false, "error": "not lease owner"})
                    }
                    Some(_) => {
                        g.owner = None;
                        g.expires_at = None;
                        json!({"success": true, "result": {"released": true}})
                    }
                    None => json!({"success": true, "result": {"released": false}}),
                }
            } else {
                json!({"success": false, "error": "lease state unavailable"})
            };
            Some(resp)
        }
        "leaseStatus" => {
            let resp = if let Ok(mut g) = lease.lock() {
                let owner = live_owner(&mut g, now);
                json!({"success": true, "result": {
                    "owner": owner,
                    "expiresAt": g.expires_at.map(|e| e as u64),
                    "now": now as u64
                }})
            } else {
                json!({"success": false, "error": "lease state unavailable"})
            };
            Some(resp)
        }
        _ => None,
    }
}

/// Enforcement gate for non-lease actions: if another client holds a live lease,
/// block with `leased by <owner>`. Returns Some(blocked_response) when blocked.
fn lease_gate(client: &str, lease: &LeaseState) -> Option<Value> {
    let now = now_ms();
    if let Ok(mut g) = lease.lock() {
        if let Some(o) = live_owner(&mut g, now) {
            if o != client {
                return Some(json!({"success": false, "error": format!("leased by {}", o)}));
            }
        }
    }
    None
}

// --- Handoff telemetry blackout --------------------------------------------
// While a waitForHandoff request is in flight through this host, the human is
// typing credentials/2FA codes into the real tab. Any observation action would
// capture that, so the host denies observation for the duration of the handoff
// -- for every client, including the one that started the handoff.
//
// Scope: a handoff whose payload carries a numeric tabId blacks out that tab
// only; a handoff with no tabId is resolved to the active tab by the extension,
// which the host cannot see, so it blacks out ALL tabs (GLOBAL). Symmetrically,
// an observation request with no tabId could land on the blacked-out tab, so it
// is denied by any live handoff. Fail-safe in both directions. Mirrors bridge.py.
const HANDOFF_BLACKOUT_ACTIONS: [&str; 11] = [
    "screenshot",
    "extractText",
    "getHTML",
    "storageState",
    "printToPDF",
    "searchTabs",
    "getCurrentState",
    "screencastFrames",
    "extractStructured",
    "scanPromptInjection",
    "consoleMessages",
];
const HANDOFF_BLACKOUT_ERROR: &str = "handoff in progress";

/// One in-flight handoff. `tab_id` None means GLOBAL (extension resolves the
/// active tab, which the host cannot see).
struct HandoffRecord {
    tab_id: Option<i64>,
    #[allow(dead_code)]
    started_at: u128,
    #[allow(dead_code)]
    client: String,
}

#[derive(Default)]
struct HandoffRegistry {
    next: u64,
    active: HashMap<u64, HandoffRecord>,
}

type Handoffs = Arc<Mutex<HandoffRegistry>>;

/// The numeric tabId a request targets, or None for "the active tab", which
/// only the extension can resolve.
fn handoff_tab_id(payload: Option<&Value>) -> Option<i64> {
    payload.and_then(|p| p.get("tabId")).and_then(|v| v.as_i64())
}

/// Register an in-flight handoff just before forwarding it. The returned handle
/// must be released on every exit path (see HandoffGuard).
fn register_handoff(handoffs: &Handoffs, tab_id: Option<i64>, client: &str) -> Option<u64> {
    let mut reg = handoffs.lock().ok()?;
    reg.next += 1;
    let handle = reg.next;
    reg.active.insert(
        handle,
        HandoffRecord { tab_id, started_at: now_ms(), client: client.to_string() },
    );
    Some(handle)
}

/// Drop-scoped release, giving the Python `finally` semantics: the blackout is
/// cleared whether the forward returns a response, an error, or a timeout.
struct HandoffGuard<'a> {
    handoffs: &'a Handoffs,
    handle: Option<u64>,
}

impl Drop for HandoffGuard<'_> {
    fn drop(&mut self) {
        if let Some(handle) = self.handle {
            if let Ok(mut reg) = self.handoffs.lock() {
                reg.active.remove(&handle);
            }
        }
    }
}

/// True when an in-flight handoff must suppress this observation request.
fn handoff_blackout(handoffs: &Handoffs, action: &str, payload: Option<&Value>) -> bool {
    if !HANDOFF_BLACKOUT_ACTIONS.contains(&action) {
        return false;
    }
    let tab_id = handoff_tab_id(payload);
    match handoffs.lock() {
        Ok(reg) => reg
            .active
            .values()
            .any(|record| record.tab_id.is_none() || tab_id.is_none() || record.tab_id == tab_id),
        Err(_) => false,
    }
}

// --- Host-enforced guardrails: policy, audit, redaction --------------------
// Mirrors bridge.py so the Rust native host governs every local client path
// (raw TCP/CLI, MCP) with the same policy/audit/redaction behavior.

/// Action classifications. Advisory tags mirroring bridge.py for policy authors
/// and the default redaction set; deny/allow/confirmation are driven by the
/// policy file, not these sets.
#[allow(dead_code)]
fn sensitive_actions() -> &'static [&'static str] {
    &[
        "getCookies", "storageState", "executeScript", "executeScriptCDP",
        "startInterception", "downloadUrl", "screencastFrames",
    ]
}

#[allow(dead_code)]
fn mutating_actions() -> &'static [&'static str] {
    &[
        "navigate", "click", "clickAt", "type", "fill", "hover", "scroll", "press", "drag",
        "select", "uploadFile", "activateTab", "closeTab", "reload", "goBack",
        "goForward", "windowControl", "setViewport", "setGeolocation", "clearGeolocation",
        "setCpuThrottling", "setNetworkConditions", "clearNetworkConditions",
        "setColorScheme", "setUserAgent",
        "setCookie", "deleteCookie", "setStorageItem", "removeStorageItem", "clearStorage",
        "githubAttachUploadedFiles", "githubSubmitComment", "githubAttachPrBody",
        "startInterception", "stopInterception",
        "startMonitoring", "stopMonitoring", "startScreencast", "stopScreencast",
        "handleDialog", "downloadUrl", "batch",
        "createTaskSession", "navigateTaskSession", "updateTaskSessionState", "closeTaskSession",
    ]
}

#[allow(dead_code)]
fn destructive_actions() -> &'static [&'static str] {
    &[
        "executeScript", "executeScriptCDP", "startInterception", "downloadUrl",
        "getCookies", "storageState",
    ]
}

// --- Per-site permission modes (policy key `siteModes`) ---------------------
// A site mode is attached to an origin pattern, not to an action:
//   manual - every mutating or high-risk action on a matching origin requires a
//            confirmation token, even when the action is not in
//            `requireConfirmation`.
//   auto   - no change; `requireConfirmation` alone decides.
//   skip   - pre-approve the confirmation gate for a matching origin.
// Modes never widen the action or origin gates. Mirrors bridge.py.
const SITE_MODES: [&str; 3] = ["manual", "auto", "skip"];

/// Confirmation gates that `skip` may never waive: script execution, cookie and
/// web-storage reads/writes, continuous capture, and coordinate clicks that have
/// no auditable element identity. Mirrors bridge.py::NON_SKIPPABLE_CONFIRMATIONS.
fn non_skippable_confirmation(action: &str) -> bool {
    matches!(
        action,
        "executeScript" | "executeScriptCDP" | "getCookies" | "storageState"
            | "setCookie" | "deleteCookie" | "setStorageItem" | "removeStorageItem"
            | "clearStorage" | "startScreencast" | "clickAt"
    )
}

/// What `manual` gates: anything that changes browser/page/profile state plus
/// the high-risk reads in the non-skippable set. Mirrors
/// bridge.py::is_mutating_action.
fn is_mutating_action(action: &str) -> bool {
    mutating_actions().contains(&action)
        || destructive_actions().contains(&action)
        || non_skippable_confirmation(action)
}

/// Origin-exempt actions: their policy target is NOT the live tab origin, so the
/// host must not do a tab-origin lookup for them. Mirrors bridge.py: every other
/// forwarded action is treated as tab-scoped and origin-checked (fail-safe).
fn origin_exempt_action(action: &str) -> bool {
    matches!(
        action,
        "ping" | "getTabs" | "navigate" | "downloadUrl" | "getCookies"
            | "sessionStatus" | "createTaskSession" | "navigateTaskSession"
            | "getTaskSessions" | "updateTaskSessionState" | "closeTaskSession"
            | "batch" | "lease" | "release" | "leaseStatus"
            | "policyCheck" | "policyInfo"
    )
}

const TARGET_REQUIRED_ACTIONS: [&str; 4] = ["navigate", "navigateTaskSession", "downloadUrl", "getCookies"];

/// Actions reserved for host-internal use (tab-origin lookup). A socket client
/// may never invoke these; they are rejected as unknown.
fn reserved_action(action: &str) -> bool {
    matches!(action, "__tabOrigin")
}

/// Path of the policy file (BRIDGE_POLICY_FILE or <host_dir>/bridge_policy.json).
fn policy_file_path(host_dir: &Path) -> PathBuf {
    match std::env::var("BRIDGE_POLICY_FILE") {
        Ok(p) => PathBuf::from(p),
        Err(_) => host_dir.join("bridge_policy.json"),
    }
}

/// Path of the audit log (BRIDGE_AUDIT_LOG_FILE or <host_dir>/bridge_audit.jsonl).
fn audit_log_path(host_dir: &Path) -> PathBuf {
    match std::env::var("BRIDGE_AUDIT_LOG_FILE") {
        Ok(p) => PathBuf::from(p),
        Err(_) => host_dir.join("bridge_audit.jsonl"),
    }
}

/// Built-in fail-closed default. A policy file must explicitly opt into browser
/// automation beyond host-side liveness/policy/lease operations.
fn default_policy() -> Value {
    json!({
        "default": {
            "allowedActions": ["ping", "policyCheck", "policyInfo", "lease", "release", "leaseStatus"],
            "deniedActions": [],
            "allowedOrigins": [],
            "deniedOrigins": [
                "file://*", "chrome://*", "chrome-extension://*",
                "*://localhost", "*://localhost:*",
                "*://127.0.0.1", "*://127.0.0.1:*",
                "*://0.0.0.0", "*://0.0.0.0:*",
                "*://*.local", "*://*.local:*",
                "*://[[]::1[]]", "*://[[]::1[]]:*"
            ],
            "requireConfirmation": [],
            "siteModes": {},
            "redactPatterns": [],
            "secretMaskFile": null,
            "traceDir": null,
            "redact": true,
            "audit": true
        },
        "clients": {}
    })
}
fn load_policy(host_dir: &Path, logger: &Arc<Logger>) -> Value {
    let path = policy_file_path(host_dir);
    match std::fs::read_to_string(&path) {
        Ok(s) => match serde_json::from_str::<Value>(&s) {
            Ok(v) if v.is_object() => v,
            Ok(_) => {
                log_error(logger, &format!("Could not load policy file {}: root must be an object", path.display()));
                default_policy()
            }
            Err(e) => {
                log_error(logger, &format!("Could not load policy file {}: {}", path.display(), e));
                default_policy()
            }
        },
        Err(e) if e.kind() == io::ErrorKind::NotFound => {
            log_error(logger, &format!("Could not load policy file {}: {}", path.display(), e));
            default_policy()
        },
        Err(e) => {
            log_error(logger, &format!("Could not load policy file {}: {}", path.display(), e));
            default_policy()
        }
    }
}

/// Shared policy value plus the recorded policy-file mtime, reloadable under a lock.
struct PolicyRegistry {
    value: Value,
    policy_file_mtime: Option<SystemTime>,
}

type Policy = Arc<RwLock<PolicyRegistry>>;

fn build_policy_registry(host_dir: &Path, logger: &Arc<Logger>) -> PolicyRegistry {
    PolicyRegistry {
        value: load_policy(host_dir, logger),
        policy_file_mtime: file_mtime(&policy_file_path(host_dir)),
    }
}

/// Cached-with-mtime read: reload when the policy file's mtime changes
/// (including absent -> present) so changes take effect without a restart.
fn current_policy(policy: &Policy, host_dir: &Path, logger: &Arc<Logger>) -> Value {
    let cur = file_mtime(&policy_file_path(host_dir));
    if let Ok(reg) = policy.read() {
        if cur == reg.policy_file_mtime {
            return reg.value.clone();
        }
    }
    if let Ok(mut reg) = policy.write() {
        if cur != reg.policy_file_mtime {
            reg.value = load_policy(host_dir, logger);
            reg.policy_file_mtime = cur;
            prime_secret_masks(&reg.value, host_dir, logger);
        }
        return reg.value.clone();
    }
    default_policy()
}

const POLICY_LIST_KEYS: [&str; 6] = [
    "allowedActions", "deniedActions", "allowedOrigins", "deniedOrigins",
    "requireConfirmation", "redactPatterns",
];
const POLICY_BOOL_KEYS: [&str; 2] = ["redact", "audit"];
/// String-valued policy keys merged like bools: a later layer replaces the value.
const POLICY_STR_KEYS: [&str; 2] = ["secretMaskFile", "traceDir"];
/// Map-valued policy keys merged PER KEY: a later layer overrides only the
/// origin patterns it names and inherits the rest. Mirrors bridge.py.
const POLICY_MAP_KEYS: [&str; 1] = ["siteModes"];

/// Merge: built-in default -> policy["default"] -> policy["clients"][name].
fn policy_for_client(policy: &Value, name: &str) -> Value {
    let mut merged = default_policy()
        .get("default")
        .cloned()
        .unwrap_or_else(|| json!({}));
    let layers = [
        policy.get("default"),
        policy.get("clients").and_then(|c| c.get(name)),
    ];
    for layer in layers.iter().flatten() {
        if !layer.is_object() {
            continue;
        }
        for key in POLICY_LIST_KEYS.iter() {
            if let Some(v) = layer.get(*key) {
                if v.is_array() {
                    merged[*key] = v.clone();
                }
            }
        }
        for key in POLICY_BOOL_KEYS.iter() {
            if let Some(Value::Bool(b)) = layer.get(*key) {
                merged[*key] = Value::Bool(*b);
            }
        }
        for key in POLICY_STR_KEYS.iter() {
            if let Some(Value::String(s)) = layer.get(*key) {
                merged[*key] = Value::String(s.clone());
            }
        }
        for key in POLICY_MAP_KEYS.iter() {
            if let Some(Value::Object(over)) = layer.get(*key) {
                let mut base = match merged.get(*key) {
                    Some(Value::Object(m)) => m.clone(),
                    _ => serde_json::Map::new(),
                };
                for (k, v) in over.iter() {
                    base.insert(k.clone(), v.clone());
                }
                merged[*key] = Value::Object(base);
            }
        }
    }
    merged
}

/// Extract an explicit `:port` from a URL's authority, matching Python's
/// `urlparse().port` which preserves even default ports (e.g. `:443`). The
/// `url` crate normalizes default ports to `None`, so we read the raw string.
/// The caller has already validated `raw_url` via `Url::parse`, so any present
/// port is well-formed.
fn explicit_port(raw_url: &str) -> Option<u16> {
    let after_scheme = raw_url.splitn(2, "://").nth(1)?;
    let authority = after_scheme.split(['/', '?', '#']).next()?;
    let authority = authority.rsplit('@').next()?;
    let host_port = if let Some(idx) = authority.find(']') {
        // IPv6 literal: port follows the closing bracket.
        &authority[idx + 1..]
    } else {
        authority
    };
    let port_str = host_port.rsplit_once(':').map(|(_, p)| p)?;
    port_str.parse::<u16>().ok()
}

/// Lowercase scheme/host, preserve explicit port, strip path/query/fragment.
/// Returns [scheme://host[:port], *://host[:port]] or [] for invalid URLs.
fn normalize_url_targets(raw_url: &str) -> Vec<String> {
    let parsed = match url::Url::parse(raw_url) {
        Ok(u) => u,
        Err(_) => return Vec::new(),
    };
    let scheme = parsed.scheme().to_lowercase();
    let host = match parsed.host_str() {
        Some(h) => h.to_lowercase(),
        None => return Vec::new(),
    };
    if scheme.is_empty() || host.is_empty() {
        return Vec::new();
    }
    let host_part = if host.contains(':') && !host.starts_with('[') {
        format!("[{}]", host)
    } else {
        host
    };
    let netloc = match explicit_port(raw_url) {
        Some(p) => format!("{}:{}", host_part, p),
        None => host_part,
    };
    vec![format!("{}://{}", scheme, netloc), format!("*://{}", netloc)]
}

/// Ordered list of normalized policy targets derived from a request payload.
fn targets_from_payload(action: &str, payload: Option<&Value>) -> Vec<String> {
    let payload = match payload {
        Some(p) if p.is_object() => p,
        _ => return Vec::new(),
    };
    match action {
        "navigate" | "navigateTaskSession" | "downloadUrl" => payload
            .get("url")
            .and_then(|u| u.as_str())
            .map(normalize_url_targets)
            .unwrap_or_default(),
        "getCookies" => match payload.get("domain").and_then(|d| d.as_str()) {
            Some(d) => {
                let mut domain = d.trim().to_string();
                while domain.starts_with('.') {
                    domain = domain[1..].trim().to_string();
                }
                domain = domain.to_lowercase();
                if domain.is_empty()
                    || domain.chars().any(|ch| ch.is_whitespace())
                    || domain.chars().any(|ch| matches!(ch, '/' | '\\' | ':'))
                {
                    return Vec::new();
                }
                let parsed = match url::Url::parse(&format!("https://{}", domain)) {
                    Ok(u) => u,
                    Err(_) => return Vec::new(),
                };
                if parsed.host_str().map(|h| h.to_lowercase()) != Some(domain.clone()) {
                    return Vec::new();
                }
                vec![format!("*://{}", domain)]
            }
            _ => Vec::new(),
        },
        "batch" => {
            let mut targets = Vec::new();
            if let Some(Value::Array(steps)) = payload.get("steps") {
                for step in steps {
                    if step.is_object() {
                        let s_action = step.get("action").and_then(|a| a.as_str()).unwrap_or("");
                        targets.extend(targets_from_payload(s_action, step.get("payload")));
                    }
                }
            }
            targets
        }
        _ => Vec::new(),
    }
}

/// Convert a tab origin ("https://host[:port]") into policy target strings
/// using the same normalizer as URLs. Empty/opaque origins -> [].
fn origin_targets(origin: Option<&str>) -> Vec<String> {
    match origin {
        Some(o) if !o.is_empty() => normalize_url_targets(o),
        _ => Vec::new(),
    }
}

/// Stable map key for a tabId: the integer as a string, or "" for the active
/// tab (tabId absent/null). Mirrors Python's dict keyed by tabId|None.
fn tabid_key(payload: Option<&Value>) -> String {
    match payload.and_then(|p| p.get("tabId")) {
        Some(Value::Number(n)) => n.to_string(),
        _ => String::new(),
    }
}

/// Yield (action, effective_payload) for a batch's steps, applying runBatch
/// tabId defaulting: a top-level batch tabId fills steps that omit one.
fn step_payloads(payload: Option<&Value>) -> Vec<(String, Value)> {
    let mut out = Vec::new();
    let obj = match payload {
        Some(p) if p.is_object() => p,
        _ => return out,
    };
    let default_tab = obj.get("tabId").filter(|v| !v.is_null()).cloned();
    if let Some(Value::Array(steps)) = obj.get("steps") {
        for step in steps {
            let s_action = step.get("action").and_then(|a| a.as_str()).unwrap_or("").to_string();
            let mut s_payload = match step.get("payload") {
                Some(Value::Object(m)) => Value::Object(m.clone()),
                _ => json!({}),
            };
            if let (Some(dt), Value::Object(map)) = (&default_tab, &mut s_payload) {
                let missing = map.get("tabId").map(|v| v.is_null()).unwrap_or(true);
                if missing {
                    map.insert("tabId".to_string(), dt.clone());
                }
            }
            out.push((s_action, s_payload));
        }
    }
    out
}

/// The set of tabId keys whose live origin the host must resolve to apply site
/// policy. "" means the active tab. Empty for origin-exempt actions. Recurses
/// into batch steps with runBatch tabId defaulting.
fn tab_ids_needed(action: &str, payload: Option<&Value>) -> std::collections::BTreeSet<String> {
    let mut needed = std::collections::BTreeSet::new();
    if action == "batch" {
        for (s_action, s_payload) in step_payloads(payload) {
            needed.extend(tab_ids_needed(&s_action, Some(&s_payload)));
        }
        return needed;
    }
    if origin_exempt_action(action) {
        return needed;
    }
    needed.insert(tabid_key(payload));
    needed
}

/// True when the client's site policy is non-trivial, i.e. it could allow or
/// deny based on a tab's origin. Lets the host skip the tab-origin round-trip
/// when policy is origin-permissive (deniedOrigins empty, allowedOrigins ["*"]).
fn policy_constrains_origins(policy: &Value, name: &str) -> bool {
    let cp = policy_for_client(policy, name);
    let denied_nonempty = matches!(cp.get("deniedOrigins"), Some(Value::Array(a)) if !a.is_empty());
    if denied_nonempty {
        return true;
    }
    let allowed_is_star = matches!(
        cp.get("allowedOrigins"),
        Some(Value::Array(a)) if a.len() == 1 && a[0].as_str() == Some("*")
    );
    if !allowed_is_star {
        return true;
    }
    // Site modes are origin-keyed, so a configured siteModes map makes the live
    // tab origin decision-relevant even under an otherwise permissive policy.
    matches!(cp.get("siteModes"), Some(Value::Object(m)) if !m.is_empty())
}

fn action_matches(patterns: Option<&Value>, action: &str) -> bool {
    match patterns {
        Some(Value::Array(arr)) => arr.iter().any(|p| {
            p.as_str()
                .and_then(|pat| glob::Pattern::new(pat).ok())
                .map(|g| g.matches(action))
                .unwrap_or(false)
        }),
        _ => false,
    }
}

fn target_matches(patterns: Option<&Value>, targets: &[String]) -> bool {
    let arr = match patterns {
        Some(Value::Array(arr)) => arr,
        _ => return false,
    };
    for target in targets {
        for p in arr {
            if let Some(pat) = p.as_str() {
                if let Ok(g) = glob::Pattern::new(pat) {
                    if g.matches(target) {
                        return true;
                    }
                }
            }
        }
    }
    false
}

/// The site mode governing `targets`, or None when no configured pattern
/// matches (identical in effect to "auto").
///
/// Specificity, so overlapping patterns are deterministic in both hosts: among
/// all matching patterns pick the LONGEST pattern string, breaking a length tie
/// by the lexicographically smallest pattern. Values outside SITE_MODES are
/// ignored, so a typo cannot silently pre-approve. Mirrors
/// bridge.py::resolve_site_mode.
fn resolve_site_mode(cp: &Value, targets: &[String]) -> Option<String> {
    if targets.is_empty() {
        return None;
    }
    let modes = match cp.get("siteModes") {
        Some(Value::Object(m)) => m,
        _ => return None,
    };
    let mut best: Option<(&str, &str)> = None;
    for (pattern, mode) in modes.iter() {
        let mode = match mode.as_str() {
            Some(m) if SITE_MODES.contains(&m) => m,
            _ => continue,
        };
        if !target_matches(Some(&json!([pattern])), targets) {
            continue;
        }
        let better = match best {
            None => true,
            Some((bp, _)) => {
                pattern.len() > bp.len()
                    || (pattern.len() == bp.len() && pattern.as_str() < bp)
            }
        };
        if better {
            best = Some((pattern.as_str(), mode));
        }
    }
    best.map(|(_, mode)| mode.to_string())
}

/// Fold the site mode into the confirmation requirement. `manual` adds a gate,
/// `skip` removes one, `auto`/None leave requireConfirmation alone. Neither mode
/// touches the action or origin gates, and `skip` can never waive a
/// non-skippable action. Mirrors bridge.py::apply_site_mode.
fn apply_site_mode(site_mode: Option<&str>, action: &str, confirm: bool) -> bool {
    match site_mode {
        Some("manual") if is_mutating_action(action) => true,
        Some("skip") if confirm && !non_skippable_confirmation(action) => false,
        _ => confirm,
    }
}

/// Returns (allowed, reason, confirmation_required, redact_enabled,
/// audit_enabled, targets). Precedence: denied action -> allowed action ->
/// denied target -> allowed target -> confirmation requirement, with the
/// matching origin's site mode (`siteModes`) folded into that last step.
/// ``origins`` maps a tabId key (integer string, or "" for the active tab) to
/// that tab's live origin; for tab-scoped actions the matching origin is folded
/// into the site-policy targets so policy applies even with no URL in payload.
fn evaluate_policy(
    policy: &Value,
    name: &str,
    action: &str,
    payload: Option<&Value>,
    origins: &std::collections::BTreeMap<String, Option<String>>,
) -> (bool, Option<String>, bool, bool, bool, Vec<String>) {
    let cp = policy_for_client(policy, name);
    let redact_enabled = cp.get("redact").and_then(|v| v.as_bool()).unwrap_or(true);
    let audit_enabled = cp.get("audit").and_then(|v| v.as_bool()).unwrap_or(true);
    let mut targets = targets_from_payload(action, payload);
    if !origin_exempt_action(action) {
        if let Some(Some(origin)) = origins.get(&tabid_key(payload)) {
            targets.extend(origin_targets(Some(origin.as_str())));
        }
    }

    // Reserved host-internal actions are never client-invokable, including as a
    // batch step (runBatch would otherwise dispatch them). Deny centrally here.
    if reserved_action(action) {
        return (false, Some(format!("action {} denied", action)), false, redact_enabled, audit_enabled, targets);
    }
    if TARGET_REQUIRED_ACTIONS.contains(&action) && targets.is_empty() {
        return (false, Some("target unresolved".to_string()), false, redact_enabled, audit_enabled, targets);
    }


    if action_matches(cp.get("deniedActions"), action) {
        return (false, Some(format!("action {} denied", action)), false, redact_enabled, audit_enabled, targets);
    }
    if !action_matches(cp.get("allowedActions"), action) {
        return (false, Some(format!("action {} not allowed", action)), false, redact_enabled, audit_enabled, targets);
    }
    // Per-site permission mode. Applied to the confirmation requirement only,
    // and only after the action gates: every deny path below returns
    // confirm=false explicitly, so a deny still outranks any mode.
    let confirm = apply_site_mode(
        resolve_site_mode(&cp, &targets).as_deref(),
        action,
        action_matches(cp.get("requireConfirmation"), action),
    );

    if action == "batch" {
        if confirm {
            return (true, None, true, redact_enabled, audit_enabled, targets);
        }
        let mut step_confirm = false;
        for (i, (s_action, s_payload)) in step_payloads(payload).into_iter().enumerate() {
            let (s_allowed, s_reason, s_confirm, _, _, s_targets) =
                evaluate_policy(policy, name, &s_action, Some(&s_payload), origins);
            if !s_allowed {
                let reason = s_reason.unwrap_or_default();
                return (false, Some(format!("batch step {}: {}", i, reason)), false,
                        redact_enabled, audit_enabled, s_targets);
            }
            step_confirm = step_confirm || s_confirm;
        }
        return (true, None, step_confirm, redact_enabled, audit_enabled, targets);
    }

    if !targets.is_empty() && target_matches(cp.get("deniedOrigins"), &targets) {
        return (false, Some("target denied".to_string()), false, redact_enabled, audit_enabled, targets);
    }
    if !targets.is_empty() && !target_matches(cp.get("allowedOrigins"), &targets) {
        return (false, Some("target not allowed".to_string()), false, redact_enabled, audit_enabled, targets);
    }
    (true, None, confirm, redact_enabled, audit_enabled, targets)
}

/// Upper bound on a policyCheck plan preflight, so one request cannot make the
/// host evaluate an unbounded step list. Mirrors bridge.py.
const PLAN_PREVIEW_MAX_STEPS: usize = 50;

/// The verdict object shared by policyCheck (single and plan forms) and by
/// dry-run responses. `origin` is an optional hypothetical tab origin: when
/// given, tab-scoped actions are evaluated against it and the verdict is no
/// longer origin-dependent, since the caller has already supplied the origin the
/// real request would carry. Mirrors bridge.py::policy_verdict.
fn policy_verdict(
    policy: &Value,
    name: &str,
    action: &str,
    payload: Option<&Value>,
    origin: Option<&str>,
) -> (Value, Vec<String>) {
    let needed = tab_ids_needed(action, payload);
    let mut origins = std::collections::BTreeMap::new();
    if let Some(o) = origin.filter(|o| !o.is_empty()) {
        for key in needed.iter() {
            origins.insert(key.clone(), Some(o.to_string()));
        }
    }
    let supplied = !origins.is_empty();
    let (allowed, reason, confirm, redact_enabled, audit_enabled, targets) =
        evaluate_policy(policy, name, action, payload, &origins);
    let verdict = json!({
        "allowed": allowed,
        "reason": reason,
        "confirmationRequired": confirm,
        "redact": redact_enabled,
        "audit": audit_enabled,
        "originDependent": !needed.is_empty()
            && policy_constrains_origins(policy, name)
            && !supplied,
        // The origin's resolved site mode, or null when no origin is known yet
        // (no target resolved) or no configured pattern matches it.
        "siteMode": resolve_site_mode(&policy_for_client(policy, name), &targets),
    });
    (verdict, targets)
}

/// Evaluate each preflight step exactly like a single policyCheck, tagged with
/// its index. A non-object step evaluates as the empty action, which the action
/// gate denies, so a malformed plan reports per-step instead of failing the
/// whole request. Mirrors bridge.py::plan_step_verdicts.
fn plan_step_verdicts(policy: &Value, name: &str, plan: &[Value]) -> Vec<Value> {
    plan.iter()
        .enumerate()
        .map(|(i, step)| {
            let action = step.get("action").and_then(|a| a.as_str()).unwrap_or("");
            let origin = step.get("origin").and_then(|o| o.as_str());
            let (verdict, _targets) =
                policy_verdict(policy, name, action, step.get("payload"), origin);
            let mut entry = serde_json::Map::new();
            entry.insert("step".to_string(), json!(i));
            entry.insert("action".to_string(), json!(action));
            if let Value::Object(fields) = verdict {
                entry.extend(fields);
            }
            Value::Object(entry)
        })
        .collect()
}

/// Structured, actionable companion to the opaque "policy denied: <reason>"
/// error string. The error string itself stays byte-stable for API and
/// contract compatibility; this object tells a client exactly what to grant, in
/// which list, and in which file. Mirrors bridge.py::policy_denial.
fn policy_denial(reason: &str, action: &str, targets: &[String], name: &str, host_dir: &Path, policy: &Value) -> Value {
    let policy_file = policy_file_path(host_dir).to_string_lossy().to_string();
    let sample = targets.first().cloned();
    // Strip a "batch step N: <inner>" wrapper so a denied batch step yields the
    // same structured remediation as the inner action. Mirrors bridge.py.
    let mut reason = reason.to_string();
    let mut action = action.to_string();
    let mut batch_step: Option<i64> = None;
    if let Some(rest) = reason.strip_prefix("batch step ") {
        if let Some((num, inner)) = rest.split_once(": ") {
            if let Ok(n) = num.parse::<i64>() {
                batch_step = Some(n);
                reason = inner.to_string();
            }
        }
    }
    // For action-type reasons the real action is embedded in the reason text;
    // the outer action may be "batch" for a denied step, so trust the reason.
    if let Some(inner) = reason.strip_prefix("action ") {
        let act = inner
            .strip_suffix(" not allowed")
            .or_else(|| inner.strip_suffix(" denied"));
        if let Some(a) = act {
            if !a.contains(' ') {
                action = a.to_string();
            }
        }
    }
    let reason = reason.as_str();
    let action = action.as_str();
    // policy_for_client replaces an inherited list when the client layer defines
    // its own, so a fix must edit the section that actually governs this client:
    // clients.<name>.<list> when present, else default.<list>.
    let section_for = |list_key: &str| -> String {
        let has_client_list = policy
            .get("clients")
            .and_then(|c| c.get(name))
            .and_then(|l| l.get(list_key))
            .map(|v| v.is_array())
            .unwrap_or(false);
        if has_client_list { format!("clients.{}", name) } else { "default".to_string() }
    };
    let (kind, remediation, suggested): (&str, String, Value) =
        if reason.starts_with("action ") && reason.ends_with("not allowed") {
            let section = section_for("allowedActions");
            ("action",
             format!("Add '{}' to {}.allowedActions in {}", action, section, policy_file),
             json!({"op": "add", "section": section, "list": "allowedActions", "value": action}))
        } else if reason == "target not allowed" {
            let section = section_for("allowedOrigins");
            ("origin",
             match &sample {
                 Some(s) => format!("Add an origin pattern covering '{}' to {}.allowedOrigins in {}", s, section, policy_file),
                 None => format!("Add the request origin to {}.allowedOrigins in {}", section, policy_file),
             },
             match &sample {
                 Some(_) => json!({"op": "add", "section": section, "list": "allowedOrigins", "value": sample}),
                 None => Value::Null,
             })
        } else if reason == "target denied" {
            let section = section_for("deniedOrigins");
            let cp = policy_for_client(policy, name);
            let matched: Vec<String> = cp.get("deniedOrigins")
                .and_then(|v| v.as_array())
                .map(|arr| arr.iter()
                    .filter_map(|p| p.as_str())
                    .filter(|p| target_matches(Some(&json!([p])), targets))
                    .map(|p| p.to_string())
                    .collect())
                .unwrap_or_default();
            ("origin",
             match &sample {
                 Some(s) => format!("Remove or narrow the {}.deniedOrigins pattern(s) {:?} matching '{}' in {}", section, matched, s, policy_file),
                 None => format!("Remove or narrow the matching {}.deniedOrigins pattern in {}", section, policy_file),
             },
             if matched.is_empty() { Value::Null }
             else { json!({"op": "removePattern", "section": section, "list": "deniedOrigins", "value": sample, "patterns": matched}) })
        } else if reason.starts_with("action ") && reason.ends_with("denied") {
            let section = section_for("deniedActions");
            let cp = policy_for_client(policy, name);
            let matched: Vec<String> = cp.get("deniedActions")
                .and_then(|v| v.as_array())
                .map(|arr| arr.iter()
                    .filter_map(|p| p.as_str())
                    .filter(|p| action_matches(Some(&json!([p])), action))
                    .map(|p| p.to_string())
                    .collect())
                .unwrap_or_default();
            ("action",
             format!("Remove or narrow the {}.deniedActions pattern(s) {:?} matching '{}' in {}", section, matched, action, policy_file),
             json!({"op": "removePattern", "section": section, "list": "deniedActions", "value": action, "patterns": matched}))
        } else if reason == "target unresolved" || reason == "tab origin unresolved" {
            ("target",
             "The request carried no resolvable target origin; supply a valid url/domain/tabId so site policy can be evaluated".to_string(),
             Value::Null)
        } else {
            ("other", format!("Review default policy in {}", policy_file), Value::Null)
        };
    json!({
        "kind": kind,
        "action": action,
        "targets": targets,
        "policyFile": policy_file,
        "client": name,
        "remediation": remediation,
        "suggestedPatch": suggested,
        "batchStep": batch_step,
        "cli": "chrome-bridge policy doctor",
    })
}

// --- Secret masking (policy `secretMaskFile`) -----------------------------
//
// A local file of `name=value` lines (mode 600 expected) whose values are
// literally masked out of every outbound response string and every audit event,
// so a credential the agent typed into a page can never be echoed back to the
// client or persisted to the audit log. Mirrors bridge.py.
#[derive(Default)]
struct SecretMaskState {
    /// secretMaskFile path -> (mtime at load, entries longest value first)
    cache: HashMap<String, (Option<SystemTime>, Vec<(String, String)>)>,
    /// Paths already warned about, so a missing file warns exactly once.
    warned: std::collections::BTreeSet<String>,
    /// Union of everything ever loaded; audit events have no client context.
    known: Vec<(String, String)>,
}

static SECRET_MASKS: Mutex<Option<SecretMaskState>> = Mutex::new(None);

/// Parse `name=value` lines from the policy's secretMaskFile. Blank lines and
/// `#` comments are ignored; a missing/unreadable file disables masking for that
/// path after one warning. Cached by mtime like the policy itself, so edits
/// apply without a host restart. Entries are ordered longest value first so an
/// overlapping shorter secret cannot pre-empt a longer one.
fn load_secret_masks(
    path: Option<&str>,
    host_dir: &Path,
    logger: &Arc<Logger>,
) -> Vec<(String, String)> {
    let path = match path {
        Some(p) if !p.is_empty() => p,
        _ => return Vec::new(),
    };
    let mtime = file_mtime(Path::new(path));
    if let Ok(mut guard) = SECRET_MASKS.lock() {
        let state = guard.get_or_insert_with(SecretMaskState::default);
        if let Some((cached_mtime, entries)) = state.cache.get(path) {
            if *cached_mtime == mtime {
                return entries.clone();
            }
        }
    }
    let (entries, failure) = match std::fs::read_to_string(path) {
        Ok(text) => {
            let mut entries: Vec<(String, String)> = Vec::new();
            for line in text.lines() {
                let line = line.trim();
                if line.is_empty() || line.starts_with('#') {
                    continue;
                }
                let Some((name, value)) = line.split_once('=') else {
                    continue;
                };
                let (name, value) = (name.trim(), value.trim());
                if name.is_empty() || value.is_empty() {
                    continue;
                }
                entries.push((name.to_string(), value.to_string()));
            }
            entries.sort_by(|a, b| b.1.len().cmp(&a.1.len()));
            (entries, None)
        }
        Err(e) => (Vec::new(), Some(e.to_string())),
    };
    let mut warn_once = None;
    if let Ok(mut guard) = SECRET_MASKS.lock() {
        let state = guard.get_or_insert_with(SecretMaskState::default);
        match &failure {
            Some(reason) => {
                if state.warned.insert(path.to_string()) {
                    warn_once = Some(reason.clone());
                }
            }
            None => {
                state.warned.remove(path);
                for entry in entries.iter() {
                    if !state.known.iter().any(|k| k.1 == entry.1) {
                        state.known.push(entry.clone());
                    }
                }
                state.known.sort_by(|a, b| b.1.len().cmp(&a.1.len()));
            }
        }
        state.cache.insert(path.to_string(), (mtime, entries.clone()));
    }
    // Emit outside the lock: write_audit_event masks with the same state.
    if let Some(reason) = warn_once {
        log_warn(logger, &format!("Could not load secretMaskFile {}: {}", path, reason));
        write_audit_event(host_dir, logger, &json!({
            "ts": now_ms() as u64,
            "client": Value::Null,
            "action": "secretMaskFile",
            "targets": [path],
            "decision": "secret_mask_unavailable",
            "reason": reason,
            "requestId": Value::Null,
        }));
    }
    entries
}

/// Every (name, value) pair loaded so far, longest value first.
fn known_secret_masks() -> Vec<(String, String)> {
    match SECRET_MASKS.lock() {
        Ok(guard) => guard.as_ref().map(|s| s.known.clone()).unwrap_or_default(),
        Err(_) => Vec::new(),
    }
}

/// Load every configured secretMaskFile at policy load time so masking
/// (including audit masking) is armed before the first response arrives.
fn prime_secret_masks(policy: &Value, host_dir: &Path, logger: &Arc<Logger>) {
    let mut names: Vec<String> = vec!["default".to_string()];
    if let Some(Value::Object(clients)) = policy.get("clients") {
        names.extend(clients.keys().cloned());
    }
    for name in names {
        let cp = policy_for_client(policy, &name);
        load_secret_masks(cp.get("secretMaskFile").and_then(|v| v.as_str()), host_dir, logger);
    }
}

fn mask_secret_text(text: &str, secrets: &[(String, String)]) -> String {
    let mut out = text.to_string();
    for (name, value) in secrets {
        if !value.is_empty() && out.contains(value.as_str()) {
            out = out.replace(value.as_str(), &format!("<masked:{}>", name));
        }
    }
    out
}

/// Recursively replace every exact secret occurrence in string leaves.
fn mask_secrets_value(value: Value, secrets: &[(String, String)]) -> Value {
    if secrets.is_empty() {
        return value;
    }
    match value {
        Value::String(s) => Value::String(mask_secret_text(&s, secrets)),
        Value::Object(map) => Value::Object(
            map.into_iter()
                .map(|(k, v)| (k, mask_secrets_value(v, secrets)))
                .collect(),
        ),
        Value::Array(arr) => {
            Value::Array(arr.into_iter().map(|v| mask_secrets_value(v, secrets)).collect())
        }
        other => other,
    }
}

static AUDIT_WRITE_LOCK: Mutex<()> = Mutex::new(());


/// Append one JSON line to the audit log. Never writes payload/response bodies,
/// and never any known secretMaskFile value (a denial reason can quote a
/// target). A write failure is logged but never blocks browser automation.
fn write_audit_event(host_dir: &Path, logger: &Arc<Logger>, event: &Value) {
    let path = audit_log_path(host_dir);
    let event = mask_secrets_value(event.clone(), &known_secret_masks());
    let line = serde_json::to_string(&event).unwrap_or_else(|_| "{}".to_string());
    let result = match AUDIT_WRITE_LOCK.lock() {
        Ok(_guard) => OpenOptions::new()
            .create(true)
            .append(true)
            .open(&path)
            .and_then(|mut f| writeln!(f, "{}", line)),
        Err(e) => Err(io::Error::other(format!("audit write lock poisoned: {}", e))),
    };
    if let Err(e) = result {
        log_error(logger, &format!("Could not write audit event to {}: {}", path.display(), e));
    }
}

/// Emit an audit event when audit is enabled for the client.
#[allow(clippy::too_many_arguments)]
fn audit(
    host_dir: &Path,
    logger: &Arc<Logger>,
    audit_enabled: bool,
    client: &str,
    action: &str,
    targets: &[String],
    decision: &str,
    reason: Option<&str>,
    request_id: Option<&str>,
) {
    if !audit_enabled {
        return;
    }
    let event = json!({
        "ts": now_ms() as u64,
        "client": client,
        "action": action,
        "targets": targets,
        "decision": decision,
        "reason": reason,
        "requestId": request_id,
    });
    write_audit_event(host_dir, logger, &event);
}

// --- Session trace artifacts (policy `traceDir`) ---------------------------
//
// Mirrors bridge.py: when a policy layer sets `traceDir`, exactly one JSONL
// event per trace-eligible request is appended to <traceDir>/<traceId>.jsonl
// after the request is fully processed (success, host denial, extension error,
// timeout). The artifact is metadata only -- decision, timing, tab ids, and
// content hashes -- never a payload body, a response body, or a token.

const TRACE_SESSION_ACTIONS: [&str; 3] =
    ["createTaskSession", "navigateTaskSession", "closeTaskSession"];
/// Response keys whose array values are an observe snapshot (or its diff).
const TRACE_SNAPSHOT_KEYS: [&str; 3] = ["nodes", "snapshot", "diff"];
const TRACE_ID_MAX: usize = 80;

static TRACE_WRITE_LOCK: Mutex<()> = Mutex::new(());

/// The trace this request belongs to, or None when it is not trace-eligible.
/// Priority: explicit traceId, the session the request names, the session a
/// response just minted, then the session verb itself.
fn trace_id_for(action: &str, payload: Option<&Value>, response: &Value) -> Option<String> {
    for key in ["traceId", "sessionId", "taskSessionId"] {
        if let Some(v) = payload.and_then(|p| p.get(key)).and_then(|v| v.as_str()) {
            if !v.is_empty() {
                return Some(v.to_string());
            }
        }
    }
    if let Some(v) = response
        .get("result")
        .and_then(|r| r.get("sessionId"))
        .and_then(|v| v.as_str())
    {
        if !v.is_empty() {
            return Some(v.to_string());
        }
    }
    if TRACE_SESSION_ACTIONS.contains(&action) {
        return Some(action.to_string());
    }
    None
}

/// Trace file names come from caller-supplied ids, so everything outside
/// `[A-Za-z0-9._-]` collapses to `_` and the name is capped: a traceId can
/// never escape traceDir or grow into an unbounded path component.
fn sanitize_trace_id(trace_id: &str) -> String {
    let cleaned: String = trace_id
        .chars()
        .take(TRACE_ID_MAX)
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '.' || c == '_' || c == '-' {
                c
            } else {
                '_'
            }
        })
        .collect();
    if cleaned.is_empty() {
        "_".to_string()
    } else {
        cleaned
    }
}

/// Resolve the client's traceDir. A relative path resolves against the host
/// install directory, matching the policy and audit paths.
fn trace_dir_for(policy: &Value, name: &str, host_dir: &Path) -> Option<PathBuf> {
    let cp = policy_for_client(policy, name);
    let raw = cp.get("traceDir").and_then(|v| v.as_str())?.trim().to_string();
    if raw.is_empty() {
        return None;
    }
    let expanded = match raw.strip_prefix("~/") {
        Some(rest) => match std::env::var("HOME") {
            Ok(home) => PathBuf::from(home).join(rest),
            Err(_) => PathBuf::from(&raw),
        },
        None => PathBuf::from(&raw),
    };
    if expanded.is_absolute() {
        Some(expanded)
    } else {
        Some(host_dir.join(expanded))
    }
}

fn push_trace_tab_ids(source: &Value, out: &mut Vec<i64>) {
    if let Some(v) = source.get("tabId").and_then(|v| v.as_i64()) {
        if !out.contains(&v) {
            out.push(v);
        }
    }
    if let Some(list) = source.get("tabIds").and_then(|v| v.as_array()) {
        for item in list {
            if let Some(v) = item.as_i64() {
                if !out.contains(&v) {
                    out.push(v);
                }
            }
        }
    }
}

/// Tab ids only: a trace records which tabs an action touched, never their
/// URLs or titles.
fn trace_targets(action: &str, payload: Option<&Value>, response: &Value) -> Vec<i64> {
    let mut out: Vec<i64> = Vec::new();
    if let Some(p) = payload {
        push_trace_tab_ids(p, &mut out);
    }
    if action == "batch" {
        for (_, step) in step_payloads(payload) {
            push_trace_tab_ids(&step, &mut out);
        }
    }
    if let Some(result) = response.get("result") {
        push_trace_tab_ids(result, &mut out);
    }
    out.sort_unstable();
    out
}

fn trace_hash(value: &Value) -> String {
    let encoded = serde_json::to_vec(value).unwrap_or_default();
    format!("{:x}", Sha256::digest(&encoded))
}

fn trace_snapshot_subobject(response: &Value) -> Option<Value> {
    for source in [response.get("result"), Some(response)].into_iter().flatten() {
        let mut sub = serde_json::Map::new();
        for key in TRACE_SNAPSHOT_KEYS {
            if let Some(v) = source.get(key) {
                if v.is_array() {
                    sub.insert(key.to_string(), v.clone());
                }
            }
        }
        if !sub.is_empty() {
            return Some(Value::Object(sub));
        }
    }
    None
}

/// Append one JSON line under the same write-lock discipline as the audit log.
/// A write failure is logged but never blocks browser automation.
fn write_trace_event(dir: &Path, trace_id: &str, logger: &Arc<Logger>, event: &Value) {
    let path = dir.join(format!("{}.jsonl", sanitize_trace_id(trace_id)));
    let line = serde_json::to_string(event).unwrap_or_else(|_| "{}".to_string());
    let result = match TRACE_WRITE_LOCK.lock() {
        Ok(_guard) => std::fs::create_dir_all(dir).and_then(|_| {
            OpenOptions::new()
                .create(true)
                .append(true)
                .open(&path)
                .and_then(|mut f| writeln!(f, "{}", line))
        }),
        Err(e) => Err(io::Error::other(format!("trace write lock poisoned: {}", e))),
    };
    if let Err(e) = result {
        log_error(logger, &format!("Could not write trace event to {}: {}", path.display(), e));
    }
}

/// Exactly one event per fully-processed, trace-eligible request. Secret
/// masking is applied before hashing and before anything is written, so a known
/// credential cannot reach the artifact even as a hash preimage.
#[allow(clippy::too_many_arguments)]
fn trace_request(
    host_dir: &Path,
    logger: &Arc<Logger>,
    policy: &Value,
    client: &str,
    action: &str,
    payload: Option<&Value>,
    response: &Value,
    decision: &str,
    reason: Option<&str>,
    request_id: Option<&str>,
    started_ms: u128,
) {
    let dir = match trace_dir_for(policy, client, host_dir) {
        Some(d) => d,
        None => return,
    };
    let trace_id = match trace_id_for(action, payload, response) {
        Some(t) => t,
        None => return,
    };
    let secrets = known_secret_masks();
    let safe_response = mask_secrets_value(response.clone(), &secrets);
    let snapshot = trace_snapshot_subobject(&safe_response);
    let event = json!({
        "ts": now_ms() as u64,
        "client": client,
        "action": action,
        "decision": decision,
        "reason": reason.map(|r| mask_secret_text(r, &secrets)),
        "requestId": request_id,
        "durationMs": now_ms().saturating_sub(started_ms) as u64,
        "targets": trace_targets(action, payload, &safe_response),
        "traceId": trace_id,
        "responseHash": trace_hash(&safe_response),
        "snapshotHash": snapshot.as_ref().map(trace_hash),
        "success": safe_response.get("success").and_then(|v| v.as_bool()).unwrap_or(false),
    });
    write_trace_event(&dir, &trace_id, logger, &event);
}

const REDACT_KEY_SUBSTRINGS: [&str; 7] =
    ["token", "secret", "password", "cookie", "session", "csrf", "auth"];

fn redact_storage_value(value: Value) -> Value {
    match value {
        Value::Object(map) => {
            if map
                .get("name")
                .and_then(|n| n.as_str())
                .map(|name| {
                    let lower = name.to_lowercase();
                    REDACT_KEY_SUBSTRINGS.iter().any(|s| lower.contains(s))
                })
                .unwrap_or(false)
                && map.contains_key("value")
            {
                let mut out = map;
                out.insert("value".to_string(), Value::String("<redacted>".to_string()));
                return Value::Object(out);
            }
            let mut out = serde_json::Map::new();
            for (k, v) in map {
                let lower = k.to_lowercase();
                if REDACT_KEY_SUBSTRINGS.iter().any(|s| lower.contains(s)) {
                    out.insert(k, Value::String("<redacted>".to_string()));
                } else {
                    out.insert(k, redact_storage_value(v));
                }
            }
            Value::Object(out)
        }
        Value::Array(arr) => Value::Array(arr.into_iter().map(redact_storage_value).collect()),
        other => other,
    }
}

fn redact_cookie_list(list: &[Value]) -> Vec<Value> {
    list.iter()
        .map(|c| {
            if let Value::Object(map) = c {
                let mut m = map.clone();
                if m.contains_key("value") {
                    m.insert("value".to_string(), Value::String("<redacted>".to_string()));
                }
                Value::Object(m)
            } else {
                c.clone()
            }
        })
        .collect()
}

/// Compile policy redactPatterns into regexes, skipping invalid ones. Patterns
/// match case-sensitively; authors use inline flags (e.g. (?i)).
fn compile_patterns(patterns: Option<&Value>) -> Vec<regex::Regex> {
    let mut out = Vec::new();
    if let Some(Value::Array(arr)) = patterns {
        for p in arr {
            if let Some(s) = p.as_str() {
                if !s.is_empty() {
                    if let Ok(rx) = regex::Regex::new(s) {
                        out.push(rx);
                    }
                }
            }
        }
    }
    out
}

fn mask_text(text: &str, compiled: &[regex::Regex]) -> String {
    let mut s = text.to_string();
    for rx in compiled {
        s = rx.replace_all(&s, "<redacted>").into_owned();
    }
    s
}

/// Recursively mask redact patterns in string leaves of a content value.
fn redact_content_value(value: Value, compiled: &[regex::Regex]) -> Value {
    match value {
        Value::String(s) => Value::String(mask_text(&s, compiled)),
        Value::Object(map) => Value::Object(
            map.into_iter()
                .map(|(k, v)| (k, redact_content_value(v, compiled)))
                .collect(),
        ),
        Value::Array(arr) => {
            Value::Array(arr.into_iter().map(|v| redact_content_value(v, compiled)).collect())
        }
        other => other,
    }
}

/// Response fields carrying page-derived content, subject to redactPatterns.
const CONTENT_REDACT_FIELDS: [&str; 5] = ["html", "text", "val", "value", "result"];

/// Redact sensitive response values before returning them to socket clients,
/// then mask literal secretMaskFile values in every remaining string. Secret
/// masking is independent of the policy `redact` toggle: those values are known
/// credentials and must never leave the host, redaction on or off.
fn redact_response(
    action: &str,
    response: Value,
    redact_enabled: bool,
    patterns: Option<&Value>,
    payload: Option<&Value>,
    secrets: &[(String, String)],
) -> Value {
    let out = redact_response_patterns(action, response, redact_enabled, patterns, payload);
    mask_secrets_value(out, secrets)
}

fn redact_response_patterns(
    action: &str,
    response: Value,
    redact_enabled: bool,
    patterns: Option<&Value>,
    payload: Option<&Value>,
) -> Value {
    if !redact_enabled {
        return response;
    }
    let mut obj = match response {
        Value::Object(m) => m,
        other => return other,
    };
    if action == "batch" {
        let steps = payload
            .and_then(|p| p.get("steps"))
            .and_then(|s| s.as_array());
        let result = obj.get("result").and_then(|r| r.as_array());
        let Some(result) = result else {
            return Value::Object(obj);
        };
        let fallback_patterns = compile_patterns(patterns);
        let redact_unknown_batch_item =
            |item: &Value| redact_content_value(item.clone(), &fallback_patterns);
        let Some(steps) = steps else {
            let redacted = result.iter().map(redact_unknown_batch_item).collect();
            obj.insert("result".to_string(), Value::Array(redacted));
            return Value::Object(obj);
        };
        let mut redacted = Vec::with_capacity(result.len());
        for (i, item) in result.iter().enumerate() {
            let Some(step_action) = steps
                .get(i)
                .and_then(|s| s.get("action"))
                .and_then(|a| a.as_str())
            else {
                redacted.push(redact_unknown_batch_item(item));
                continue;
            };
            let step_payload = steps
                .get(i)
                .and_then(|s| s.get("payload"));
            let wrapped = redact_response_patterns(
                step_action,
                json!({ "result": item.clone() }),
                redact_enabled,
                patterns,
                step_payload,
            );
            let unwrapped = wrapped
                .get("result")
                .cloned()
                .unwrap_or_else(|| item.clone());
            redacted.push(unwrapped);
        }
        obj.insert("result".to_string(), Value::Array(redacted));
        return Value::Object(obj);
    }
    if action == "getCookies" {
        // result.cookies (object) | result (array) | response.cookies (array)
        if let Some(Value::Object(result)) = obj.get("result") {
            if let Some(Value::Array(cookies)) = result.get("cookies") {
                let redacted = redact_cookie_list(cookies);
                let mut new_result = result.clone();
                new_result.insert("cookies".to_string(), Value::Array(redacted));
                obj.insert("result".to_string(), Value::Object(new_result));
                return Value::Object(obj);
            }
        }
        if let Some(Value::Array(cookies)) = obj.get("result") {
            let redacted = redact_cookie_list(cookies);
            obj.insert("result".to_string(), Value::Array(redacted));
            return Value::Object(obj);
        }
        if let Some(Value::Array(cookies)) = obj.get("cookies") {
            let redacted = redact_cookie_list(cookies);
            obj.insert("cookies".to_string(), Value::Array(redacted));
            return Value::Object(obj);
        }
        return Value::Object(obj);
    }
    if action == "storageState" {
        if let Some(result) = obj.remove("result") {
            obj.insert("result".to_string(), redact_storage_value(result));
        }
        return Value::Object(obj);
    }
    if matches!(
        action,
        "getHTML"
            | "extractText"
            | "executeScript"
            | "executeScriptCDP"
            | "searchTabs"
            | "extractStructured"
            | "scanPromptInjection"
            | "consoleMessages"
    ) {
        let compiled = compile_patterns(patterns);
        if compiled.is_empty() {
            return Value::Object(obj);
        }
        for field in CONTENT_REDACT_FIELDS.iter() {
            if let Some(v) = obj.remove(*field) {
                obj.insert((*field).to_string(), redact_content_value(v, &compiled));
            }
        }
        return Value::Object(obj);
    }
    Value::Object(obj)
}

/// Write a single newline-delimited JSON response line to the client socket.
fn write_line(stream: &mut TcpStream, value: &Value) -> io::Result<()> {
    let mut out = serde_json::to_vec(value).unwrap_or_default();
    out.push(b'\n');
    stream.write_all(&out)?;
    stream.flush()
}

/// Forward one command to the extension and block until its response or timeout.
/// Returns (req_id, Some(response)) or (req_id, None) on timeout. ``on_registered``
/// runs after the request id is registered but before write_message, so callers
/// can audit "allow" with the generated id before the action is forwarded. Used
/// for normal forwards and host-internal lookups (e.g. __tabOrigin).
fn forward_to_extension(
    mut cmd: Value,
    pending: &Pending,
    stdout: &Arc<Mutex<io::Stdout>>,
    logger: &Arc<Logger>,
    resp_timeout: Duration,
    on_registered: impl FnOnce(&str),
) -> (String, Option<Value>) {
    let req_id = uuid::Uuid::new_v4().to_string();
    if let Value::Object(map) = &mut cmd {
        map.insert("id".to_string(), Value::String(req_id.clone()));
    }
    let (tx, rx) = std::sync::mpsc::channel::<Value>();
    if let Ok(mut p) = pending.lock() {
        p.insert(req_id.clone(), tx);
    }
    on_registered(&req_id);
    write_message(stdout, logger, &cmd);
    match rx.recv_timeout(resp_timeout) {
        Ok(response) => (req_id, Some(response)),
        Err(_) => {
            if let Ok(mut p) = pending.lock() {
                p.remove(&req_id);
            }
            (req_id, None)
        }
    }
}

/// Resolve each needed tabId key ("" = active tab) to its live origin via the
/// reserved __tabOrigin extension action. A failed/timed-out/blank lookup maps
/// to None, which is fail-closed under an origin-constraining policy.
fn resolve_origins(
    needed: &std::collections::BTreeSet<String>,
    pending: &Pending,
    stdout: &Arc<Mutex<io::Stdout>>,
    logger: &Arc<Logger>,
    resp_timeout: Duration,
) -> std::collections::BTreeMap<String, Option<String>> {
    let mut origins = std::collections::BTreeMap::new();
    for key in needed {
        let payload = if key.is_empty() {
            json!({})
        } else if let Ok(n) = key.parse::<i64>() {
            json!({ "tabId": n })
        } else {
            json!({})
        };
        let cmd = json!({ "action": "__tabOrigin", "payload": payload });
        let (_, resp) = forward_to_extension(cmd, pending, stdout, logger, resp_timeout, |_| {});
        // Prefer the full tab url over origin: JS URL.origin strips explicit
        // default ports, but normalize_url_targets() preserves them.
        let origin = resp
            .as_ref()
            .filter(|r| r.get("success").and_then(|v| v.as_bool()).unwrap_or(false))
            .and_then(|r| r.get("result"))
            .and_then(|res| res.get("url").or_else(|| res.get("origin")))
            .and_then(|o| o.as_str())
            .map(|s| s.to_string());
        origins.insert(key.clone(), origin);
    }
    origins
}

fn handle_socket_client(
    mut stream: TcpStream,
    host_dir: &Path,
    tokens: &Tokens,
    pending: &Pending,
    lease: &LeaseState,
    confirmations: &Confirmations,
    handoffs: &Handoffs,
    policy: &Policy,
    stdout: &Arc<Mutex<io::Stdout>>,
    logger: &Arc<Logger>,
) {
    let idle = socket_idle_timeout();
    let _ = stream.set_read_timeout(Some(idle));

    // Serve many newline-delimited requests on one connection. The residual
    // buffer carries bytes past the consumed line across iterations (TCP may
    // split/coalesce frames).
    let mut buffer: Vec<u8> = Vec::new();
    let mut chunk = [0u8; 65536];

    loop {
        // Read until we have at least one complete line.
        while !buffer.contains(&b'\n') {
            match stream.read(&mut chunk) {
                Ok(0) => return, // client closed
                Ok(n) => buffer.extend_from_slice(&chunk[..n]),
                Err(_) => return, // idle timeout or other IO error: drop connection
            }
        }

        let nl = match buffer.iter().position(|&b| b == b'\n') {
            Some(i) => i,
            None => continue,
        };
        let line: Vec<u8> = buffer.drain(..=nl).take(nl).collect();

        if line.iter().all(|b| b.is_ascii_whitespace()) {
            continue; // tolerate blank keep-alive lines
        }

        let mut cmd: Value = match serde_json::from_slice(&line) {
            Ok(v) => v,
            Err(e) => {
                log_error(logger, &format!("Error handling socket client: {}", e));
                return;
            }
        };

        // Reject any request whose token is missing or not in the registry.
        // On a miss, resolve_client mtime-checks the token files and reloads
        // before giving up, so newly added tokens resolve without a restart.
        let client_name = cmd
            .get("token")
            .and_then(|t| t.as_str())
            .and_then(|t| resolve_client(tokens, host_dir, logger, t));
        let mut client_name = match client_name {
            Some(name) => name,
            None => {
                log_warn(logger, "Rejected unauthenticated/invalid-token request.");
                let _ = write_line(&mut stream, &json!({"success": false, "error": "unauthorized"}));
                return;
            }
        };

        // Never forward secrets, host-only confirmation fields, or the
        // request-level dry-run flag to the extension.
        let mut dry_run = false;
        let mut confirmation_token = if let Value::Object(map) = &mut cmd {
            map.remove("token");
            dry_run = map.remove("dryRun").and_then(|v| v.as_bool()).unwrap_or(false);
            map.remove("confirmationToken")
                .and_then(|v| v.as_str().map(|s| s.to_string()))
        } else {
            None
        };

        let mut action = cmd.get("action").and_then(|a| a.as_str()).unwrap_or("").to_string();
        let mut payload = cmd.get("payload").cloned();
        // Start of the traced window: every exit below emits at most one trace
        // event, measured from here.
        let trace_started = now_ms();

        // Dry run stops before any state change: no confirmation resume, no
        // lease acquisition, no interactive origin approval, no tab-origin
        // lookup (that is itself an extension round-trip), and no forward. It
        // reports the verdict the request would meet right now. Mirrors
        // bridge.py.
        if dry_run {
            if reserved_action(&action) {
                log_warn(logger, &format!("Rejected reserved action from client: {}", action));
                let policy_value = current_policy(policy, host_dir, logger);
                let cp = policy_for_client(&policy_value, &client_name);
                let audit_enabled = cp.get("audit").and_then(|v| v.as_bool()).unwrap_or(true);
                audit(host_dir, logger, audit_enabled, &client_name, &action, &[], "deny", Some("unknown action"), None);
                let resp = json!({"success": false, "error": format!("unknown action: {}", action)});
                trace_request(host_dir, logger, &policy_value, &client_name, &action, payload.as_ref(),
                              &resp, "deny", Some("unknown action"), None, trace_started);
                let _ = write_line(&mut stream, &resp);
                continue;
            }
            let policy_value = current_policy(policy, host_dir, logger);
            let (mut verdict, targets) =
                policy_verdict(&policy_value, &client_name, &action, payload.as_ref(), None);
            if let Some(blocked) = lease_gate(&client_name, lease) {
                verdict["allowed"] = Value::Bool(false);
                verdict["reason"] = blocked.get("error").cloned().unwrap_or(Value::Null);
            }
            // A live handoff blackout outranks policy and lease: the request
            // would be denied before policy evaluation, so say so here.
            if handoff_blackout(handoffs, &action, payload.as_ref()) {
                verdict["allowed"] = Value::Bool(false);
                verdict["reason"] = Value::String(HANDOFF_BLACKOUT_ERROR.to_string());
                verdict["blackout"] = Value::Bool(true);
            }
            // Host-answered actions resolve without Chrome, so they would never
            // forward even when fully allowed.
            let host_side = matches!(
                action.as_str(),
                "lease" | "release" | "leaseStatus" | "policyCheck" | "policyInfo" | "confirm"
            );
            let would_forward = verdict.get("allowed").and_then(|v| v.as_bool()).unwrap_or(false)
                && !verdict.get("confirmationRequired").and_then(|v| v.as_bool()).unwrap_or(false)
                && !host_side;
            let audit_enabled = verdict.get("audit").and_then(|v| v.as_bool()).unwrap_or(true);
            let reason = verdict.get("reason").and_then(|v| v.as_str()).map(|s| s.to_string());
            audit(host_dir, logger, audit_enabled, &client_name, &action, &targets, "dry_run", reason.as_deref(), None);
            let resp = json!({
                "success": true,
                "dryRun": true,
                "wouldForward": would_forward,
                "action": action,
                "targets": targets,
                "verdict": verdict,
            });
            trace_request(host_dir, logger, &policy_value, &client_name, &action, payload.as_ref(),
                          &resp, "dry_run", reason.as_deref(), None, trace_started);
            if write_line(&mut stream, &resp).is_err() {
                return;
            }
            continue;
        }

        // Token-only confirmation resume. Recover the exact short-lived action
        // and payload, then run the complete policy/origin/lease/confirmation
        // path again. The token is not consumed until just before forwarding.
        if action == "confirm" {
            let resume_token = payload
                .as_ref()
                .and_then(|p| p.get("confirmationToken"))
                .and_then(|v| v.as_str())
                .map(|s| s.to_string());
            match resume_confirmation(confirmations, resume_token.as_deref()) {
                Some((resumed_client, resumed_action, resumed_payload)) => {
                    let requester_name = client_name.clone();
                    confirmation_token = resume_token;
                    client_name = resumed_client;
                    action = resumed_action;
                    payload = Some(resumed_payload.clone());
                    cmd = json!({"action": action, "payload": resumed_payload});
                    let policy_value = current_policy(policy, host_dir, logger);
                    let cp = policy_for_client(&policy_value, &requester_name);
                    let audit_enabled = cp.get("audit").and_then(|v| v.as_bool()).unwrap_or(true);
                    audit(host_dir, logger, audit_enabled, &requester_name, "confirm", &[], "confirmation_resume", None, None);
                }
                None => {
                    let policy_value = current_policy(policy, host_dir, logger);
                    let cp = policy_for_client(&policy_value, &client_name);
                    let audit_enabled = cp.get("audit").and_then(|v| v.as_bool()).unwrap_or(true);
                    audit(host_dir, logger, audit_enabled, &client_name, "confirm", &[], "confirmation_deny", Some("invalid or expired confirmation token"), None);
                    let resp = json!({
                        "success": false,
                        "error": "invalid or expired confirmation token"
                    });
                    trace_request(host_dir, logger, &policy_value, &client_name, &action, payload.as_ref(),
                                  &resp, "confirmation_deny", Some("invalid or expired confirmation token"),
                                  None, trace_started);
                    let _ = write_line(&mut stream, &resp);
                    continue;
                }
            }
        }

        // Reserved host-internal actions (e.g. __tabOrigin) are never reachable
        // from socket clients; reject as unknown so the internal surface cannot
        // be driven or probed externally.
        if reserved_action(&action) {
            log_warn(logger, &format!("Rejected reserved action from client: {}", action));
            let policy_value = current_policy(policy, host_dir, logger);
            let cp = policy_for_client(&policy_value, &client_name);
            let audit_enabled = cp.get("audit").and_then(|v| v.as_bool()).unwrap_or(true);
            audit(host_dir, logger, audit_enabled, &client_name, &action, &[], "deny", Some("unknown action"), None);
            let resp = json!({"success": false, "error": format!("unknown action: {}", action)});
            trace_request(host_dir, logger, &policy_value, &client_name, &action, payload.as_ref(),
                          &resp, "deny", Some("unknown action"), None, trace_started);
            let _ = write_line(&mut stream, &resp);
            continue;
        }

        // Lease verbs are answered host-side with no extension round-trip.
        if let Some(resp) = handle_lease_action(&action, payload.as_ref(), &client_name, lease) {
            let policy_value = current_policy(policy, host_dir, logger);
            let cp = policy_for_client(&policy_value, &client_name);
            let audit_enabled = cp.get("audit").and_then(|v| v.as_bool()).unwrap_or(true);
            let success = resp.get("success").and_then(|v| v.as_bool()).unwrap_or(false);
            let decision = if success { "lease_allow" } else { "lease_deny" };
            let reason = resp.get("error").and_then(|v| v.as_str());
            audit(host_dir, logger, audit_enabled, &client_name, &action, &[], decision, reason, None);
            trace_request(host_dir, logger, &policy_value, &client_name, &action, payload.as_ref(),
                          &resp, decision, reason, None, trace_started);
            if write_line(&mut stream, &resp).is_err() {
                return;
            }
            continue;
        }

        let policy_value = current_policy(policy, host_dir, logger);

        // policyCheck is host-side: report what the policy would decide for a
        // target action/payload without forwarding it to the extension.
        if action == "policyCheck" {
            let pc = payload.unwrap_or(json!({}));
            // Plan preflight: one verdict per proposed step, evaluated
            // independently against the current policy. Nothing is forwarded and
            // no state changes, so an agent can price a whole plan before
            // touching the browser.
            if let Some(plan) = pc.get("plan").and_then(|p| p.as_array()) {
                let cp = policy_for_client(&policy_value, &client_name);
                let audit_enabled = cp.get("audit").and_then(|v| v.as_bool()).unwrap_or(true);
                if plan.len() > PLAN_PREVIEW_MAX_STEPS {
                    let reason = format!("plan exceeds {} steps", PLAN_PREVIEW_MAX_STEPS);
                    audit(host_dir, logger, audit_enabled, &client_name, "policyCheck", &[], "deny", Some(&reason), None);
                    let resp = json!({"success": false, "error": reason});
                    trace_request(host_dir, logger, &policy_value, &client_name, &action, Some(&pc),
                                  &resp, "deny", Some(&reason), None, trace_started);
                    let _ = write_line(&mut stream, &resp);
                    continue;
                }
                let steps = plan_step_verdicts(&policy_value, &client_name, plan);
                audit(host_dir, logger, audit_enabled, &client_name, "policyCheck", &[], "allow", None, None);
                let resp = json!({"success": true, "result": {"plan": steps}});
                trace_request(host_dir, logger, &policy_value, &client_name, &action, Some(&pc),
                              &resp, "allow", None, None, trace_started);
                if write_line(&mut stream, &resp).is_err() {
                    return;
                }
                continue;
            }
            let target_action = pc.get("action").and_then(|a| a.as_str()).unwrap_or("");
            let target_payload = pc.get("payload");
            let no_origins = std::collections::BTreeMap::new();
            let (allowed, reason, confirm, redact_enabled, audit_enabled, targets) = evaluate_policy(
                &policy_value, &client_name, target_action, target_payload, &no_origins);
            // Without forwarding, the host cannot see the live tab origin, so for
            // an origin-constrained policy a tab-scoped action's verdict is
            // provisional: report originDependent so callers don't trust an
            // "allowed" that origin policy may still deny.
            let origin_dependent = !tab_ids_needed(target_action, target_payload).is_empty()
                && policy_constrains_origins(&policy_value, &client_name);
            let resp = json!({"success": true, "result": {
                "allowed": allowed,
                "reason": reason,
                "confirmationRequired": confirm,
                "redact": redact_enabled,
                "audit": audit_enabled,
                "originDependent": origin_dependent,
                "siteMode": resolve_site_mode(
                    &policy_for_client(&policy_value, &client_name), &targets),
            }});
            audit(host_dir, logger, audit_enabled, &client_name, "policyCheck", &targets, "allow", None, None);
            trace_request(host_dir, logger, &policy_value, &client_name, &action, Some(&pc),
                          &resp, "allow", None, None, trace_started);
            if write_line(&mut stream, &resp).is_err() {
                return;
            }
            continue;
        }

        // policyInfo is host-side and always answerable (handled before the
        // action gate, like policyCheck) so a client can always discover the
        // active policy file path even when the current policy would deny
        // everything else. It deliberately returns ONLY the path and its
        // existence -- never policy contents -- so a token holder cannot use it
        // to enumerate allowed/denied origins. Mirrors bridge.py.
        if action == "policyInfo" {
            let cp = policy_for_client(&policy_value, &client_name);
            let audit_enabled = cp.get("audit").and_then(|v| v.as_bool()).unwrap_or(true);
            let policy_file = policy_file_path(host_dir);
            let audit_log = audit_log_path(host_dir);
            let trace_dir = trace_dir_for(&policy_value, &client_name, host_dir)
                .map(|p| p.to_string_lossy().to_string());
            let resp = json!({"success": true, "result": {
                "policyFile": policy_file.to_string_lossy(),
                "policyFileExists": policy_file.exists(),
                "auditLogFile": audit_log.to_string_lossy(),
                "traceDir": trace_dir,
                "client": client_name,
            }});
            audit(host_dir, logger, audit_enabled, &client_name, "policyInfo", &[], "allow", None, None);
            trace_request(host_dir, logger, &policy_value, &client_name, &action, payload.as_ref(),
                          &resp, "allow", None, None, trace_started);
            if write_line(&mut stream, &resp).is_err() {
                return;
            }
            continue;
        }

        // Handoff telemetry blackout runs BEFORE policy evaluation: while a
        // human is completing a login/2FA/captcha step, no client may observe
        // the tab, no matter what policy would otherwise allow.
        if handoff_blackout(handoffs, &action, payload.as_ref()) {
            let cp = policy_for_client(&policy_value, &client_name);
            let audit_enabled = cp.get("audit").and_then(|v| v.as_bool()).unwrap_or(true);
            audit(host_dir, logger, audit_enabled, &client_name, &action, &[], "handoff_blackout", Some(HANDOFF_BLACKOUT_ERROR), None);
            let resp = json!({
                "success": false,
                "error": HANDOFF_BLACKOUT_ERROR,
                "blackout": true
            });
            trace_request(host_dir, logger, &policy_value, &client_name, &action, payload.as_ref(),
                          &resp, "handoff_blackout", Some(HANDOFF_BLACKOUT_ERROR), None, trace_started);
            let _ = write_line(&mut stream, &resp);
            continue;
        }

        let empty_origins = std::collections::BTreeMap::new();

        // Phase 1: action-level and payload-target checks needing no extension
        // round-trip. These run before the lease gate, preserving prior
        // precedence (policy denial wins over a lease for payload targets).
        let (allowed, _reason, _confirm, redact_enabled, audit_enabled, targets) =
            evaluate_policy(&policy_value, &client_name, &action, payload.as_ref(), &empty_origins);
        if !allowed {
            let reason = _reason.unwrap_or_default();
            audit(host_dir, logger, audit_enabled, &client_name, &action, &targets, "deny", Some(&reason), None);
            let resp = json!({"success": false, "error": format!("policy denied: {}", reason), "policyDenial": policy_denial(&reason, &action, &targets, &client_name, host_dir, &policy_value)});
            trace_request(host_dir, logger, &policy_value, &client_name, &action, payload.as_ref(),
                          &resp, "deny", Some(&reason), None, trace_started);
            let _ = write_line(&mut stream, &resp);
            continue;
        }

        // Cover long waits/human-handoff that carry a payload timeoutMs.
        let resp_timeout = payload
            .as_ref()
            .and_then(|p| p.get("timeoutMs"))
            .and_then(|t| t.as_f64())
            .filter(|ms| *ms > 0.0)
            .map(|ms| idle.max(Duration::from_millis(ms as u64 + 30000)))
            .unwrap_or(idle);

        // Phase 2: tab-origin policy for tab-scoped actions. The live origin
        // comes from a host-internal __tabOrigin lookup, so the lease gate runs
        // first (a non-owner must trigger no extension round-trip), then
        // origin-aware re-evaluation runs before the confirm check so a denied
        // origin wins over a confirmation requirement.
        let needed = if policy_constrains_origins(&policy_value, &client_name) {
            tab_ids_needed(&action, payload.as_ref())
        } else {
            std::collections::BTreeSet::new()
        };
        let (confirm, targets) = if !needed.is_empty() {
            if let Some(blocked) = lease_gate(&client_name, lease) {
                let reason = blocked.get("error").and_then(|v| v.as_str());
                audit(host_dir, logger, audit_enabled, &client_name, &action, &targets, "lease_deny", reason, None);
                trace_request(host_dir, logger, &policy_value, &client_name, &action, payload.as_ref(),
                              &blocked, "lease_deny", reason, None, trace_started);
                if write_line(&mut stream, &blocked).is_err() {
                    return;
                }
                continue;
            }
            let origins = resolve_origins(&needed, pending, stdout, logger, resp_timeout);
            // Fail closed when any needed tab resolves to no usable origin
            // target (lookup failure, no such tab, opaque origin): under an
            // origin-constraining policy such a request must not proceed.
            if needed.iter().any(|k| origin_targets(origins.get(k).and_then(|o| o.as_deref())).is_empty()) {
                let mut t = targets.clone();
                t.push("<unresolved-origin>".to_string());
                audit(host_dir, logger, audit_enabled, &client_name, &action, &t, "deny", Some("tab origin unresolved"), None);
                let resp = json!({"success": false, "error": "policy denied: tab origin unresolved", "policyDenial": policy_denial("tab origin unresolved", &action, &t, &client_name, host_dir, &policy_value)});
                trace_request(host_dir, logger, &policy_value, &client_name, &action, payload.as_ref(),
                              &resp, "deny", Some("tab origin unresolved"), None, trace_started);
                let _ = write_line(&mut stream, &resp);
                continue;
            }
            let (allowed, reason, confirm, _, _, targets) =
                evaluate_policy(&policy_value, &client_name, &action, payload.as_ref(), &origins);
            if !allowed {
                let reason = reason.unwrap_or_default();
                audit(host_dir, logger, audit_enabled, &client_name, &action, &targets, "deny", Some(&reason), None);
                let resp = json!({"success": false, "error": format!("policy denied: {}", reason), "policyDenial": policy_denial(&reason, &action, &targets, &client_name, host_dir, &policy_value)});
                trace_request(host_dir, logger, &policy_value, &client_name, &action, payload.as_ref(),
                              &resp, "deny", Some(&reason), None, trace_started);
                let _ = write_line(&mut stream, &resp);
                continue;
            }
            (confirm, targets)
        } else {
            (_confirm, targets)
        };

        // A confirmation that a `skip` site mode waived is still recorded: under
        // an unattended pre-approval the audit log is the only place a human
        // later sees that no confirmation was asked for. Mirrors bridge.py.
        if !confirm {
            let cp = policy_for_client(&policy_value, &client_name);
            if action_matches(cp.get("requireConfirmation"), &action)
                && resolve_site_mode(&cp, &targets).as_deref() == Some("skip")
            {
                audit(host_dir, logger, audit_enabled, &client_name, &action, &targets,
                      "confirmation_waived", Some("siteMode skip"), None);
            }
        }

        if confirm {
            let confirm_payload = payload.clone().unwrap_or_else(|| json!({}));
            if consume_confirmation(
                confirmations,
                confirmation_token.as_deref(),
                &client_name,
                &action,
                &confirm_payload,
                &targets,
            ) {
                audit(host_dir, logger, audit_enabled, &client_name, &action, &targets, "confirmation_accepted", None, None);
            } else {
                let (token, expires_at) = issue_confirmation(
                    confirmations,
                    &client_name,
                    &action,
                    &confirm_payload,
                    &targets,
                );
                audit(host_dir, logger, audit_enabled, &client_name, &action, &targets, "confirmation_required", None, None);
                let resp = json!({
                    "success": false,
                    "error": "confirmation required",
                    "confirmationRequired": true,
                    "action": action,
                    "targets": targets,
                    "confirmationToken": token,
                    "expiresAt": expires_at,
                    "resumeCommand": format!("chrome-bridge confirm {}", token)
                });
                trace_request(host_dir, logger, &policy_value, &client_name, &action, payload.as_ref(),
                              &resp, "confirmation_required", None, None, trace_started);
                let _ = write_line(&mut stream, &resp);
                continue;
            }
        }

        // A live lease held by another client blocks every other action.
        if let Some(blocked) = lease_gate(&client_name, lease) {
            let reason = blocked.get("error").and_then(|v| v.as_str());
            audit(host_dir, logger, audit_enabled, &client_name, &action, &targets, "lease_deny", reason, None);
            trace_request(host_dir, logger, &policy_value, &client_name, &action, payload.as_ref(),
                          &blocked, "lease_deny", reason, None, trace_started);
            if write_line(&mut stream, &blocked).is_err() {
                return;
            }
            continue;
        }

        // Audit "allow" with the generated id before the action is forwarded.
        let client_policy = policy_for_client(&policy_value, &client_name);
        let redact_patterns = client_policy.get("redactPatterns").cloned();
        let secrets = load_secret_masks(
            client_policy.get("secretMaskFile").and_then(|v| v.as_str()),
            host_dir,
            logger,
        );
        let (req_id, response) = {
            let h = host_dir;
            let l = logger;
            let ce = client_name.clone();
            let ac = action.clone();
            let tg = targets.clone();
            // A waitForHandoff forward opens a telemetry blackout for the whole
            // time the human is interacting with the tab; the guard drops it on
            // every exit path (response, extension error, or timeout).
            let _handoff_guard = HandoffGuard {
                handoffs,
                handle: if action == "waitForHandoff" {
                    register_handoff(handoffs, handoff_tab_id(payload.as_ref()), &client_name)
                } else {
                    None
                },
            };
            forward_to_extension(cmd, pending, stdout, logger, resp_timeout, |rid| {
                audit(h, l, audit_enabled, &ce, &ac, &tg, "allow", None, Some(rid));
            })
        };
        match response {
            Some(response) => {
                let success = response.get("success").and_then(|v| v.as_bool()).unwrap_or(false);
                let ext_decision = if success { "extension_success" } else { "extension_error" };
                let reason = response.get("error").and_then(|v| v.as_str());
                audit(host_dir, logger, audit_enabled, &client_name, &action, &targets, ext_decision, reason, Some(&req_id));
                let response = redact_response(&action, response, redact_enabled, redact_patterns.as_ref(), payload.as_ref(), &secrets);
                // Trace the response the client actually receives: already
                // redacted and secret-masked, so the hash covers no raw content.
                let reason = response.get("error").and_then(|v| v.as_str()).map(|s| s.to_string());
                trace_request(host_dir, logger, &policy_value, &client_name, &action, payload.as_ref(),
                              &response, ext_decision, reason.as_deref(), Some(&req_id), trace_started);
                if write_line(&mut stream, &response).is_err() {
                    return;
                }
            }
            None => {
                log_error(
                    logger,
                    &format!("Timed out waiting for extension response to {}.", req_id),
                );
                audit(host_dir, logger, audit_enabled, &client_name, &action, &targets, "extension_error", Some("extension response timeout"), Some(&req_id));
                let resp = json!({"success": false, "error": "extension response timeout"});
                trace_request(host_dir, logger, &policy_value, &client_name, &action, payload.as_ref(),
                              &resp, "extension_error", Some("extension response timeout"), Some(&req_id), trace_started);
                let _ = write_line(&mut stream, &resp);
                return;
            }
        }
    }
}

fn socket_server_loop(
    host_dir: PathBuf,
    tokens: Tokens,
    pending: Pending,
    lease: LeaseState,
    confirmations: Confirmations,
    handoffs: Handoffs,
    policy: Policy,
    stdout: Arc<Mutex<io::Stdout>>,
    logger: Arc<Logger>,
) {
    let port: u16 = std::env::var("BRIDGE_PORT")
        .ok()
        .and_then(|p| p.parse().ok())
        .unwrap_or(9223);

    // SO_REUSEADDR before bind, matching Python (SOL_SOCKET/SO_REUSEADDR=1). Avoids
    // transient bind failures against a TIME_WAIT port during rapid host replacement.
    let addr: std::net::SocketAddr = (std::net::Ipv4Addr::LOCALHOST, port).into();
    let bind_result = (|| -> io::Result<TcpListener> {
        let socket = Socket::new(Domain::IPV4, Type::STREAM, Some(Protocol::TCP))?;
        socket.set_reuse_address(true)?;
        socket.bind(&addr.into())?;
        socket.listen(128)?;
        Ok(socket.into())
    })();
    let listener = match bind_result {
        Ok(l) => l,
        Err(e) => {
            log_error(
                &logger,
                &format!(
                    "FATAL: could not bind 127.0.0.1:{} ({}). Another bridge host is \
                     likely already running. Disable the duplicate Chrome extension so only \
                     one host owns this port. This host will not accept CLI commands.",
                    port, e
                ),
            );
            std::process::exit(1);
        }
    };

    log_info(
        &logger,
        &format!("TCP socket server listening on 127.0.0.1:{}", port),
    );

    for incoming in listener.incoming() {
        match incoming {
            Ok(stream) => {
                let addr = stream
                    .peer_addr()
                    .map(|a| a.to_string())
                    .unwrap_or_else(|_| "<unknown>".to_string());
                log_info(&logger, &format!("Accepted connection from {}", addr));
                let host_dir = host_dir.clone();
                let tokens = Arc::clone(&tokens);
                let pending = Arc::clone(&pending);
                let lease = Arc::clone(&lease);
                let confirmations = Arc::clone(&confirmations);
                let handoffs = Arc::clone(&handoffs);
                let policy = Arc::clone(&policy);
                let stdout = Arc::clone(&stdout);
                let logger = Arc::clone(&logger);
                std::thread::spawn(move || {
                    handle_socket_client(stream, &host_dir, &tokens, &pending, &lease, &confirmations, &handoffs, &policy, &stdout, &logger);
                });
            }
            Err(e) => {
                log_error(&logger, &format!("Error in socket server accept: {}", e));
            }
        }
    }
}

fn main() {
    let host_dir = host_dir();
    let logger = Arc::new(
        Logger::new(&log_path(&host_dir)).unwrap_or_else(|e| {
            eprintln!("could not open log file: {}", e);
            std::process::exit(1);
        }),
    );

    log_info(&logger, "Native Messaging Host started.");

    let tokens: Tokens = Arc::new(RwLock::new(build_registry(&host_dir, &logger)));
    let stdout: Arc<Mutex<io::Stdout>> = Arc::new(Mutex::new(io::stdout()));
    let pending: Pending = Arc::new(Mutex::new(HashMap::new()));
    let lease: LeaseState = Arc::new(Mutex::new(Lease {
        owner: None,
        expires_at: None,
    }));
    let confirmations: Confirmations = Arc::new(Mutex::new(HashMap::new()));
    let handoffs: Handoffs = Arc::new(Mutex::new(HandoffRegistry::default()));
    let policy: Policy = Arc::new(RwLock::new(build_policy_registry(&host_dir, &logger)));

    {
        let host_dir = host_dir.clone();
        let tokens = Arc::clone(&tokens);
        let pending = Arc::clone(&pending);
        let lease = Arc::clone(&lease);
        let confirmations = Arc::clone(&confirmations);
        let handoffs = Arc::clone(&handoffs);
        let policy = Arc::clone(&policy);
        let stdout = Arc::clone(&stdout);
        let logger = Arc::clone(&logger);
        std::thread::spawn(move || {
            socket_server_loop(host_dir, tokens, pending, lease, confirmations, handoffs, policy, stdout, logger);
        });
    }

    let stdin = io::stdin();
    let mut handle = stdin.lock();

    loop {
        // Read 4-byte native-endian length prefix.
        let mut len_buf = [0u8; 4];
        match read_exact_or_eof(&mut handle, &mut len_buf) {
            Ok(true) => {}
            Ok(false) => {
                log_info(&logger, "Extension disconnected (empty read).");
                std::process::exit(0);
            }
            Err(e) => {
                log_error(&logger, &format!("Error in main loop: {}", e));
                break;
            }
        }

        let message_length = u32::from_ne_bytes(len_buf) as usize;
        let mut body = vec![0u8; message_length];
        if let Err(e) = handle.read_exact(&mut body) {
            log_error(&logger, &format!("Error in main loop: {}", e));
            break;
        }

        log_info(
            &logger,
            &format!("Read message from extension ({} bytes)", message_length),
        );

        let msg: Value = match serde_json::from_slice(&body) {
            Ok(v) => v,
            Err(e) => {
                log_error(&logger, &format!("Error in main loop: {}", e));
                break;
            }
        };

        let msg_id = msg.get("id").and_then(|v| v.as_str()).map(|s| s.to_string());

        match msg_id {
            Some(id) => {
                let sender = pending.lock().ok().and_then(|mut p| p.remove(&id));
                match sender {
                    Some(tx) => match tx.send(msg) {
                        Ok(()) => {
                            log_info(
                                &logger,
                                &format!(
                                    "Routed response for request ID {} to its socket handler.",
                                    id
                                ),
                            );
                        }
                        Err(e) => {
                            log_error(
                                &logger,
                                &format!("Error sending response to socket handler: {}", e),
                            );
                        }
                    },
                    None => {
                        log_info(
                            &logger,
                            &format!(
                                "Received message with ID {} but no pending request was found.",
                                id
                            ),
                        );
                    }
                }
            }
            None => {
                log_info(
                    &logger,
                    &format!("Received message from Chrome with no ID: {}", msg),
                );
            }
        }
    }
}

/// Read exactly buf.len() bytes. Returns Ok(false) on clean EOF before any byte,
/// Ok(true) on success, Err on partial/other IO error.
fn read_exact_or_eof<R: Read>(reader: &mut R, buf: &mut [u8]) -> io::Result<bool> {
    let mut filled = 0;
    while filled < buf.len() {
        match reader.read(&mut buf[filled..]) {
            Ok(0) => {
                if filled == 0 {
                    return Ok(false);
                }
                return Err(io::Error::new(
                    io::ErrorKind::UnexpectedEof,
                    "unexpected eof reading length prefix",
                ));
            }
            Ok(n) => filled += n,
            Err(e) if e.kind() == io::ErrorKind::Interrupted => continue,
            Err(e) => return Err(e),
        }
    }
    Ok(true)
}
