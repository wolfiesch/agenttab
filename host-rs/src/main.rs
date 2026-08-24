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
                                &format!(
                                    "Ignoring malformed token line (expected name:token): {}",
                                    trimmed
                                ),
                            );
                        }
                    }
                }
            }
            Err(e) => {
                log_error(
                    logger,
                    &format!(
                        "Could not read tokens file {}: {}",
                        tokens_file.display(),
                        e
                    ),
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

fn confirmation_fingerprint(
    client: &str,
    action: &str,
    payload: &Value,
    targets: &[String],
) -> String {
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
        map.insert(
            token.clone(),
            Confirmation {
                fingerprint,
                expires_at,
                client: client.to_string(),
                action: action.to_string(),
                payload: payload.clone(),
                targets: targets.to_vec(),
            },
        );
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
        return Some((
            entry.client.clone(),
            entry.action.clone(),
            entry.payload.clone(),
        ));
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
fn handle_lease_action(
    action: &str,
    payload: Option<&Value>,
    client: &str,
    lease: &LeaseState,
) -> Option<Value> {
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
// While a waitForHandoff or credentialHandoff request is in flight through this
// host, the human is typing credentials/2FA codes into the real tab. Any
// observation action would capture that, so the host denies observation for the
// duration of the handoff -- for every client, including the one that started
// the handoff.
//
// Scope: a handoff whose payload carries a numeric tabId blacks out that tab
// only; a handoff with no tabId is resolved to the active tab by the extension,
// which the host cannot see, so it blacks out ALL tabs (GLOBAL). Symmetrically,
// an observation request with no tabId could land on the blacked-out tab, so it
// is denied by any live handoff. Fail-safe in both directions. Mirrors bridge.py.
// The set covers three families: one-shot observations, the *retrieval* actions
// of the long-lived collectors (console, network, interception, screencast), and
// the collector *start* actions. Denying retrieval keeps a collector that was
// already running before the handoff from handing the handoff interval back;
// denying start keeps a client from opening a fresh collector mid-handoff and
// reading it out afterwards. The extension additionally discards the target
// tab's buffered collector data before showing the handoff banner.
const HANDOFF_BLACKOUT_ACTIONS: [&str; 18] = [
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
    "observe",
    "navigateAndSnapshot",
    "networkRequests",
    "interceptedRequests",
    "startMonitoring",
    "startScreencast",
    "startInterception",
];
const HANDOFF_BLACKOUT_ERROR: &str = "handoff in progress";
// Actions whose forward opens a blackout window. credentialHandoff is the
// single-field narrowing of waitForHandoff and gets exactly the same treatment.
const HANDOFF_ACTIONS: [&str; 2] = ["waitForHandoff", "credentialHandoff"];

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
    payload
        .and_then(|p| p.get("tabId"))
        .and_then(|v| v.as_i64())
}

/// Register an in-flight handoff just before forwarding it. The returned handle
/// must be released on every exit path (see HandoffGuard).
fn register_handoff(handoffs: &Handoffs, tab_id: Option<i64>, client: &str) -> Option<u64> {
    let mut reg = handoffs.lock().ok()?;
    reg.next += 1;
    let handle = reg.next;
    reg.active.insert(
        handle,
        HandoffRecord {
            tab_id,
            started_at: now_ms(),
            client: client.to_string(),
        },
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
/// Composite actions are checked step by step as well: runBatch and
/// replayWorkflow dispatch their steps inside the extension, so a blacked-out
/// observation nested in one of them would otherwise never reach this gate.
fn handoff_blackout(handoffs: &Handoffs, action: &str, payload: Option<&Value>) -> bool {
    if action == "batch" || action == "replayWorkflow" {
        let steps = if action == "batch" {
            step_payloads(payload)
        } else {
            workflow_step_payloads(payload)
        };
        return steps
            .iter()
            .any(|(s_action, s_payload)| handoff_blackout(handoffs, s_action, Some(s_payload)));
    }
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

const COMPOSITE_HANDOFF_ERROR: &str = "handoff not allowed in a composite";

/// A handoff nested inside a composite can never be given a meaningful
/// blackout. runBatch and replayWorkflow dispatch every remaining step inside
/// the extension, so the steps AFTER the handoff never pass back through this
/// host: a batch of [credentialHandoff, screenshot] would capture the tab while
/// the human is still typing, with no gate in between. Registering the handoff
/// for the composite would not help, because the blackout is enforced per
/// request and there is only one request. The safe rule is that a handoff is a
/// TOP-LEVEL action only, so the whole composite is refused before anything is
/// forwarded. Nested composites are walked with the same step extractors used
/// everywhere else, so tabId defaulting/retargeting applies.
/// Returns the byte-stable denial reason, or None when no step is a handoff.
/// Mirrors bridge.py::composite_handoff_reason.
fn composite_handoff_reason(action: &str, payload: Option<&Value>) -> Option<String> {
    if action != "batch" && action != "replayWorkflow" {
        return None;
    }
    let (prefix, steps) = if action == "batch" {
        ("batch step", step_payloads(payload))
    } else {
        ("workflow step", workflow_step_payloads(payload))
    };
    for (i, (s_action, s_payload)) in steps.iter().enumerate() {
        if HANDOFF_ACTIONS.contains(&s_action.as_str()) {
            return Some(format!("{} {}: {}", prefix, i, COMPOSITE_HANDOFF_ERROR));
        }
        if let Some(nested) = composite_handoff_reason(s_action, Some(s_payload)) {
            return Some(format!("{} {}: {}", prefix, i, nested));
        }
    }
    None
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
        "getCookies",
        "storageState",
        "executeScript",
        "executeScriptCDP",
        "startInterception",
        "downloadUrl",
        "screencastFrames",
    ]
}

#[allow(dead_code)]
fn mutating_actions() -> &'static [&'static str] {
    &[
        "navigate",
        "navigateAndSnapshot",
        "click",
        "clickAt",
        "type",
        "fill",
        "insertRichText",
        "hover",
        "scroll",
        "press",
        "drag",
        "select",
        "uploadFile",
        "activateTab",
        "closeTab",
        "reload",
        "goBack",
        "goForward",
        "windowControl",
        "setViewport",
        "setGeolocation",
        "clearGeolocation",
        "setCpuThrottling",
        "setNetworkConditions",
        "clearNetworkConditions",
        "setColorScheme",
        "setUserAgent",
        "setCookie",
        "deleteCookie",
        "setStorageItem",
        "removeStorageItem",
        "clearStorage",
        "githubAttachUploadedFiles",
        "githubSubmitComment",
        "githubAttachPrBody",
        "startInterception",
        "stopInterception",
        "startMonitoring",
        "stopMonitoring",
        "startScreencast",
        "stopScreencast",
        "handleDialog",
        "downloadUrl",
        "batch",
        "createTaskSession",
        "navigateTaskSession",
        "updateTaskSessionState",
        "closeTaskSession",
    ]
}

#[allow(dead_code)]
fn destructive_actions() -> &'static [&'static str] {
    &[
        "executeScript",
        "executeScriptCDP",
        "startInterception",
        "downloadUrl",
        "getCookies",
        "storageState",
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
        "executeScript"
            | "executeScriptCDP"
            | "getCookies"
            | "storageState"
            | "setCookie"
            | "deleteCookie"
            | "setStorageItem"
            | "removeStorageItem"
            | "clearStorage"
            | "startScreencast"
            | "clickAt"
    )
}

/// Name-only tier: anything that changes browser/page/profile state plus the
/// high-risk reads in the non-skippable set. Mirrors
/// bridge.py::base_action_tier.
fn base_action_tier(action: &str) -> &'static str {
    if mutating_actions().contains(&action)
        || destructive_actions().contains(&action)
        || non_skippable_confirmation(action)
    {
        "mutating"
    } else {
        "read_only"
    }
}

/// Retained name-only predicate. Decisions use `effective_action_tier`, which
/// also accounts for state-changing payload flags and batch step contents.
/// Mirrors bridge.py::is_mutating_action.
#[allow(dead_code)]
fn is_mutating_action(action: &str) -> bool {
    base_action_tier(action) == "mutating"
}

// --- Payload-driven tier escalation ----------------------------------------
// A nominally read-only action is state-changing when its payload sets a flag
// that mutates extension-side state. The table is data, not scattered
// conditionals, so bridge.py and this host can be compared by eye.
//
// Entry: (action, flag, kind, enum values)
//   not_false     - the extension reads `flag !== false`, so the flag is ON
//                   unless the payload sets it to literal false (default ON).
//   enum          - string flag; escalates when its value is in the listed set.
//                   Absent means the extension's own default, never listed here.
//   nonempty_list - escalates when the flag is a non-empty array, because the
//                   extension merges caller-supplied entries into its own state.
// Mirrors bridge.py::ESCALATING_PAYLOAD_FLAGS.
const ESCALATING_PAYLOAD_FLAGS: [(&str, &str, &str, &[&str]); 3] = [
    // screencastFrames drains the frame buffer irrecoverably unless the caller
    // explicitly passes consume: false.
    ("screencastFrames", "consume", "not_false", &[]),
    // cacheSelectors op=list/export read; clear wipes the selector cache and
    // import merges caller-supplied entries into it.
    ("cacheSelectors", "op", "enum", &["clear", "import"]),
    // resolveCachedSelector imports caller-supplied cache entries before
    // resolving when payload.cache is a non-empty array.
    ("resolveCachedSelector", "cache", "nonempty_list", &[]),
];

/// True when a base read-only action's payload carries a state-changing flag
/// from ESCALATING_PAYLOAD_FLAGS. Mirrors bridge.py::payload_escalates_tier.
fn payload_escalates_tier(action: &str, payload: Option<&Value>) -> bool {
    for (f_action, flag, kind, values) in ESCALATING_PAYLOAD_FLAGS.iter() {
        if *f_action != action {
            continue;
        }
        let value = payload.and_then(|p| p.get(*flag));
        let hit = match *kind {
            "not_false" => value != Some(&Value::Bool(false)),
            "enum" => matches!(value.and_then(|v| v.as_str()), Some(s) if values.contains(&s)),
            "nonempty_list" => matches!(value.and_then(|v| v.as_array()), Some(a) if !a.is_empty()),
            _ => false,
        };
        if hit {
            return true;
        }
    }
    false
}

/// The tier every tier-dependent decision uses: "read_only" or "mutating",
/// computed from the payload, not the action name alone. batch/replayWorkflow
/// are the union over their steps: read_only only when every step resolves to
/// read_only. A base read-only action escalates to mutating when its payload
/// carries a state-changing flag. Mirrors bridge.py::effective_action_tier.
fn effective_action_tier(action: &str, payload: Option<&Value>) -> &'static str {
    if action == "batch" || action == "replayWorkflow" {
        let steps = if action == "batch" {
            step_payloads(payload)
        } else {
            workflow_step_payloads(payload)
        };
        for (s_action, s_payload) in steps {
            if effective_action_tier(&s_action, Some(&s_payload)) == "mutating" {
                return "mutating";
            }
        }
        return "read_only";
    }
    if base_action_tier(action) == "mutating" || payload_escalates_tier(action, payload) {
        "mutating"
    } else {
        "read_only"
    }
}

/// Origin-exempt actions: their policy target is NOT the live tab origin, so the
/// host must not do a tab-origin lookup for them. Mirrors bridge.py: every other
/// forwarded action is treated as tab-scoped and origin-checked (fail-safe).
fn origin_exempt_action(action: &str) -> bool {
    matches!(
        action,
        "ping"
            | "getTabs"
            | "navigate"
            | "navigateAndSnapshot"
            | "downloadUrl"
            | "getCookies"
            | "sessionStatus"
            | "createTaskSession"
            | "navigateTaskSession"
            | "getTaskSessions"
            | "updateTaskSessionState"
            | "closeTaskSession"
            | "batch"
            | "lease"
            | "release"
            | "leaseStatus"
            | "policyCheck"
            | "policyInfo"
    )
}

const TARGET_REQUIRED_ACTIONS: [&str; 5] = [
    "navigate",
    "navigateTaskSession",
    "navigateAndSnapshot",
    "downloadUrl",
    "getCookies",
];

/// Actions that make the browser issue a NEW outbound request to a host named in
/// the request payload, so the host can bound the destination before forwarding.
/// `setCookie` is included because it writes a cookie scoped to its `url`, which
/// the browser then attaches to its next request to that host, so it stages
/// egress even though the write itself is local.
///
/// Deliberately NOT here, because the host cannot see the destination and must
/// not imply coverage it does not have (see docs/security.md): in-page navigation
/// the agent causes by clicking a link or submitting a form; script-driven
/// requests (`executeScript`/`executeScriptCDP`); resource loads a page makes on
/// its own; `uploadFile`/`githubAttach*` (which post to the tab's own origin,
/// already governed by site policy); `startInterception` in `fulfill` mode (the
/// extension fulfills from the inline `body` and fetches nothing); and
/// `deleteCookie` (names a url but removes state and sends nothing).
/// Mirrors bridge.py::EGRESS_URL_ACTIONS.
const EGRESS_URL_ACTIONS: [&str; 5] = [
    "navigate",
    "navigateTaskSession",
    "navigateAndSnapshot",
    "downloadUrl",
    "setCookie",
];

// --- Data-loss-prevention channels (policy key `dlp`) -----------------------
// `dlp` is a map of CHANNEL -> MODE:
//   allow - default; current behavior, nothing is added.
//   audit - the action runs and exactly one `dlp_audit` audit event naming the
//           channel is written. The event carries no file contents, no file
//           paths, and no frame data -- only the channel name.
//   block - the action is denied with reason `dlp blocked` BEFORE it is
//           forwarded, so Chrome never opens the file.
// Merged as a map key (see POLICY_MAP_KEYS). Mirrors bridge.py DLP_CHANNELS.
const DLP_CHANNELS: [&str; 4] = ["clipboard", "upload", "download", "screenShare"];
const DLP_MODES: [&str; 3] = ["allow", "audit", "block"];
const DLP_BLOCKED_ERROR: &str = "dlp blocked";
const DLP_AUDIT_DECISION: &str = "dlp_audit";

/// The DLP channel an action belongs to, or None. Only chokepoints the bridge
/// itself owns appear here: the three actions that hand local file paths to CDP
/// `DOM.setFileInputFiles`, the one action that starts a browser download, and
/// the screencast start plus frame read. `clipboard` is DECLARED but has no
/// entry, because no bridge action reads or writes the clipboard and a
/// page-driven copy never crosses the bridge. Mirrors
/// bridge.py::DLP_ACTION_CHANNELS.
fn dlp_channel_for_action(action: &str) -> Option<&'static str> {
    match action {
        "uploadFile" | "githubAttachUploadedFiles" | "githubAttachPrBody" => Some("upload"),
        "downloadUrl" => Some("download"),
        "startScreencast" | "screencastFrames" => Some("screenShare"),
        _ => None,
    }
}

/// The mode governing `channel`, or None when `channel` is not a DLP channel.
/// Fail closed: a channel configured with anything outside DLP_MODES resolves to
/// `block` rather than being silently ignored, because a typo in a data-loss
/// control must not widen it. Mirrors bridge.py::resolve_dlp_mode.
fn resolve_dlp_mode(cp: &Value, channel: Option<&str>) -> Option<&'static str> {
    let channel = channel.filter(|c| DLP_CHANNELS.contains(c))?;
    let dlp = match cp.get("dlp") {
        None | Some(Value::Null) => return Some("allow"),
        Some(Value::Object(m)) => m,
        Some(_) => return Some("block"),
    };
    match dlp.get(channel) {
        None => Some("allow"),
        Some(Value::String(m)) => DLP_MODES
            .iter()
            .find(|known| **known == m.as_str())
            .copied()
            .or(Some("block")),
        Some(_) => Some("block"),
    }
}

/// The non-`allow` channel modes for this client, stamped onto a forwarded
/// request so the extension can refuse independently. Mirrors
/// bridge.py::dlp_modes_for_client.
fn dlp_modes_for_client(cp: &Value) -> serde_json::Map<String, Value> {
    let mut modes = serde_json::Map::new();
    for channel in DLP_CHANNELS.iter() {
        if let Some(mode) = resolve_dlp_mode(cp, Some(*channel)) {
            if mode != "allow" {
                modes.insert((*channel).to_string(), json!(mode));
            }
        }
    }
    modes
}

/// Channels resolving to `mode` for this request, recursing into composites so a
/// batch or replayWorkflow step is seen. Ordered by DLP_CHANNELS and
/// deduplicated. Mirrors bridge.py::dlp_channels_in_mode.
fn dlp_channels_in_mode(
    cp: &Value,
    action: &str,
    payload: Option<&Value>,
    mode: &str,
) -> Vec<String> {
    let mut found: Vec<&'static str> = Vec::new();
    dlp_walk_channels(cp, action, payload, mode, &mut found);
    DLP_CHANNELS
        .iter()
        .filter(|c| found.contains(*c))
        .map(|c| (*c).to_string())
        .collect()
}

fn dlp_walk_channels(
    cp: &Value,
    action: &str,
    payload: Option<&Value>,
    mode: &str,
    found: &mut Vec<&'static str>,
) {
    if action == "batch" || action == "replayWorkflow" {
        let steps = if action == "batch" {
            step_payloads(payload)
        } else {
            workflow_step_payloads(payload)
        };
        for (s_action, s_payload) in steps {
            dlp_walk_channels(cp, &s_action, Some(&s_payload), mode, found);
        }
        return;
    }
    if let Some(channel) = dlp_channel_for_action(action) {
        if resolve_dlp_mode(cp, Some(channel)) == Some(mode) && !found.contains(&channel) {
            found.push(channel);
        }
    }
}

/// (action, channel) of the first blocked chokepoint in this request, walking
/// composite steps in dispatch order so a denial can name the smuggled step's own
/// action rather than the enclosing `batch`. Mirrors
/// bridge.py::dlp_blocked_target.
fn dlp_blocked_target(
    cp: &Value,
    action: &str,
    payload: Option<&Value>,
) -> Option<(String, &'static str)> {
    if action == "batch" || action == "replayWorkflow" {
        let steps = if action == "batch" {
            step_payloads(payload)
        } else {
            workflow_step_payloads(payload)
        };
        for (s_action, s_payload) in steps {
            if let Some(hit) = dlp_blocked_target(cp, &s_action, Some(&s_payload)) {
                return Some(hit);
            }
        }
        return None;
    }
    let channel = dlp_channel_for_action(action)?;
    if resolve_dlp_mode(cp, Some(channel)) == Some("block") {
        Some((action.to_string(), channel))
    } else {
        None
    }
}

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
            // Where the agent may make the browser SEND traffic. Empty means
            // unconstrained, preserving behavior for policies that never set it.
            "egressAllowlist": [],
            "siteModes": {},
            // Per-channel data-loss-prevention modes (see DLP_CHANNELS). An
            // absent channel is "allow", preserving behavior for policies that
            // never set it.
            "dlp": {},
            "redactPatterns": [],
            "secretMaskFile": null,
            "traceDir": null,
            // Optional forwarder for audit events that were already written
            // locally. Null/absent disables export entirely.
            "auditExport": null,
            "redact": true,
            "audit": true
        },
        "clients": {}
    })
}

// --- Content-addressed org policy bundles (policy key `policyBundle`) ------
// Mirrors bridge.py. An org distributes one policy document out of band and
// pins it by digest:
//
//   "policyBundle": {"path": "/etc/chrome-bridge/org-policy.json",
//                    "lockfile": "/etc/chrome-bridge/org-policy.lock"}
//
// read from the ROOT of the local policy file (its `default` layer is also
// accepted). The bundle is applied ONLY when its sha256 equals the `sha256`
// recorded in the lockfile. Every other outcome -- unreadable bundle,
// unreadable or malformed lockfile, malformed bundle, digest mismatch,
// malformed policyBundle stanza -- fails closed to the BUILT-IN default policy
// (never the last verified bundle), is logged, and is audited as
// `policy_bundle_rejected` carrying both digests. The reload signature covers
// the bundle and lockfile mtimes, so a swapped bundle is re-verified on the
// next request and each rejection is audited once per change.
//
// Precedence for a VERIFIED bundle:
//   built-in default -> bundle default/clients -> local bridge_policy.json
// so a local operator can always tighten. A local layer can never LOOSEN the
// bundle. What "tighten" means is not the same for every key -- a longer allow
// list is looser while a longer deny list is tighter -- so composition is per
// key and monotonic, driven by POLICY_BUNDLE_COMPOSITION below rather than by
// a plain local override.

const POLICY_BUNDLE_DECISION: &str = "policy_bundle_rejected";
const POLICY_BUNDLE_MISCONFIGURED: &str = "policy bundle misconfigured";
const POLICY_BUNDLE_UNREADABLE: &str = "policy bundle unreadable";
const POLICY_BUNDLE_MALFORMED: &str = "policy bundle malformed";
const POLICY_BUNDLE_LOCK_UNREADABLE: &str = "policy bundle lockfile unreadable";
const POLICY_BUNDLE_LOCK_MALFORMED: &str = "policy bundle lockfile malformed";
const POLICY_BUNDLE_MISMATCH: &str = "policy bundle digest mismatch";
/// A composition conflict is a policy MISCONFIGURATION, not a tampered bundle,
/// but it fails closed on the same path and with the same audit decision: two
/// different nontrivial globs on one allow-list key have no intersection that
/// is representable as a pattern list. See bundle_intersect_lists.
const POLICY_BUNDLE_CONFLICT: &str = "policy bundle composition conflict";

/// How one policy key composes when a VERIFIED bundle is layered under the
/// local policy file. Every rule is monotonic: the composed value is at most as
/// permissive as the bundle's. Keys absent from this table keep plain
/// local-over-bundle precedence because they carry neither allow/deny authority
/// nor authority over what leaves the host (`traceDir`, `auditExport`, and the
/// local root keys). Kept as a flat table, mirroring bridge.py's
/// POLICY_BUNDLE_COMPOSITION field for field so the two hosts can be compared
/// by eye.
///
///   allow     Explicit INTERSECTION of two allow-list PATTERN lists. Every
///             entry is classified by bundle_pattern_kind as the bare wildcard
///             `*`, an exact literal (no `*`, `?` or `[`), or a nontrivial
///             glob, and only those three cases are composed:
///               * on the BUNDLE side the bundle does not constrain the list,
///                 so the local list stands; on the LOCAL side it can never
///                 widen a constrained bundle list.
///               A literal survives when the OTHER side's patterns permit it as
///                 a NAME -- the one direction in which matching a pattern
///                 against a string is sound.
///               Two IDENTICAL nontrivial globs compose to that glob. A BUNDLE
///                 glob the local list does not restate is dropped, which only
///                 ever tightens.
///             A LOCAL nontrivial glob with no identical counterpart, against a
///             bundle list carrying a nontrivial glob of its own, has no
///             representable intersection. Rather than guess, or silently keep
///             the broader side and drop the local narrowing, composition fails
///             closed: the bundle is REJECTED exactly like a bad digest, with
///             POLICY_BUNDLE_CONFLICT naming the key and both patterns. An
///             EMPTY allow list denies everything, so it is the tight end of
///             this rule, never "unconstrained".
///   egress    The same intersection, except that for `egressAllowlist` EMPTY
///             means unconstrained: an empty bundle list leaves the local list
///             alone, and an empty local list keeps the bundle's list rather
///             than silently lifting the constraint.
///   deny      UNION. More entries is tighter for these keys -- more denied
///             patterns, more confirmation-gated actions, more response-masking
///             regexes -- so an org baseline can add entries and a local layer
///             can add more, and a local `[]` can never erase the bundle's.
///   dlp       Per-channel STRICTEST mode by POLICY_BUNDLE_DLP_ORDER.
///   siteMode  Per-pattern STRICTEST mode by POLICY_BUNDLE_SITE_MODE_ORDER.
///   onlyTrue  Boolean whose `true` is the tight value: bundle true wins.
///   paths     UNION of the bundle's and the local layer's file paths, bundle
///             first, deduplicated, empties dropped. A single surviving path
///             composes to that bare string, so a plain string `secretMaskFile`
///             keeps working unchanged; two distinct paths compose to a LIST
///             and the loader reads every entry. A local layer can add its own
///             secrets, never drop the org's.
const POLICY_BUNDLE_COMPOSITION: [(&str, &str); 12] = [
    ("allowedActions", "allow"),
    ("allowedOrigins", "allow"),
    ("egressAllowlist", "egress"),
    ("deniedActions", "deny"),
    ("deniedOrigins", "deny"),
    ("requireConfirmation", "deny"),
    ("redactPatterns", "deny"),
    ("dlp", "dlp"),
    ("siteModes", "siteMode"),
    ("redact", "onlyTrue"),
    ("audit", "onlyTrue"),
    ("secretMaskFile", "paths"),
];

/// Strictest-first mode orders, with the rank an UNRECOGNISED value composes
/// at. Each unknown rank mirrors what that key's enforcement path already does
/// with a typo, so composition never makes a typo mean something it does not
/// mean at request time: resolve_dlp_mode fails an unknown channel mode closed
/// to `block` (rank 0), while resolve_site_mode ignores an unknown site mode,
/// which is identical in effect to `auto` (rank 1).
const POLICY_BUNDLE_DLP_ORDER: [&str; 3] = ["block", "audit", "allow"];
const POLICY_BUNDLE_DLP_UNKNOWN_RANK: usize = 0;
const POLICY_BUNDLE_SITE_MODE_ORDER: [&str; 3] = ["manual", "auto", "skip"];
const POLICY_BUNDLE_SITE_MODE_UNKNOWN_RANK: usize = 1;

/// policyInfo and the CLI report a truncated digest: enough to compare two
/// installs by eye, never enough to reconstruct any bundle content.
const POLICY_BUNDLE_DIGEST_CHARS: usize = 12;

#[derive(Clone, Default)]
struct PolicyBundleState {
    path: Option<String>,
    lockfile: Option<String>,
    verified: bool,
    digest: Option<String>,
}

static POLICY_BUNDLE_STATE: Mutex<Option<PolicyBundleState>> = Mutex::new(None);

fn policy_bundle_state() -> PolicyBundleState {
    match POLICY_BUNDLE_STATE.lock() {
        Ok(guard) => guard.as_ref().cloned().unwrap_or_default(),
        Err(_) => PolicyBundleState::default(),
    }
}

fn set_policy_bundle_state(state: PolicyBundleState) {
    if let Ok(mut guard) = POLICY_BUNDLE_STATE.lock() {
        *guard = Some(state);
    }
}

fn short_digest(digest: Option<&str>) -> Value {
    match digest {
        Some(d) if !d.is_empty() => {
            Value::String(d.chars().take(POLICY_BUNDLE_DIGEST_CHARS).collect())
        }
        _ => Value::Null,
    }
}

/// Expand a leading `~` like Python's os.path.expanduser, which the Python host
/// applies to both bundle paths.
fn expand_home(raw: &str) -> String {
    if raw == "~" {
        return std::env::var("HOME").unwrap_or_else(|_| raw.to_string());
    }
    match raw.strip_prefix("~/") {
        Some(rest) => match std::env::var("HOME") {
            Ok(home) => format!("{}/{}", home.trim_end_matches('/'), rest),
            Err(_) => raw.to_string(),
        },
        None => raw.to_string(),
    }
}

/// (path, lockfile) from the local policy document; ("", "") when the stanza is
/// present but unusable (fail closed); None when no bundle is configured.
fn policy_bundle_config(doc: &Value) -> Option<(String, String)> {
    let mut holders: Vec<&Value> = vec![doc];
    if let Some(layer) = doc.get("default") {
        if layer.is_object() {
            holders.push(layer);
        }
    }
    for holder in holders {
        let cfg = match holder.get("policyBundle") {
            None | Some(Value::Null) => continue,
            Some(v) => v,
        };
        if !cfg.is_object() {
            return Some((String::new(), String::new()));
        }
        let path = cfg
            .get("path")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .trim();
        let lockfile = cfg
            .get("lockfile")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .trim();
        if path.is_empty() || lockfile.is_empty() {
            return Some((String::new(), String::new()));
        }
        return Some((expand_home(path), expand_home(lockfile)));
    }
    None
}

/// (digest, reason). The lockfile is JSON: {"sha256": "<64 lowercase hex>"}.
/// Any other shape is malformed and therefore fails closed.
fn read_lock_digest(path: &str) -> (Option<String>, Option<&'static str>) {
    let raw = match std::fs::read_to_string(path) {
        Ok(s) => s,
        Err(_) => return (None, Some(POLICY_BUNDLE_LOCK_UNREADABLE)),
    };
    let data: Value = match serde_json::from_str(&raw) {
        Ok(v) => v,
        Err(_) => return (None, Some(POLICY_BUNDLE_LOCK_MALFORMED)),
    };
    if !data.is_object() {
        return (None, Some(POLICY_BUNDLE_LOCK_MALFORMED));
    }
    let digest = match data.get("sha256").and_then(|v| v.as_str()) {
        Some(s) => s.trim().to_lowercase(),
        None => return (None, Some(POLICY_BUNDLE_LOCK_MALFORMED)),
    };
    if digest.len() != 64
        || !digest
            .chars()
            .all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase())
    {
        return (None, Some(POLICY_BUNDLE_LOCK_MALFORMED));
    }
    (Some(digest), None)
}

/// (document, actualDigest, expectedDigest, reason). `reason` is None only when
/// the digest matched AND the bundle parsed as a JSON object. The digest is
/// compared BEFORE parsing so an unpinned document is never interpreted.
fn verify_policy_bundle(
    path: &str,
    lockfile: &str,
) -> (
    Option<Value>,
    Option<String>,
    Option<String>,
    Option<&'static str>,
) {
    if path.is_empty() || lockfile.is_empty() {
        return (None, None, None, Some(POLICY_BUNDLE_MISCONFIGURED));
    }
    let raw = match std::fs::read(path) {
        Ok(b) => b,
        Err(_) => return (None, None, None, Some(POLICY_BUNDLE_UNREADABLE)),
    };
    let actual = format!("{:x}", Sha256::digest(&raw));
    let (expected, reason) = read_lock_digest(lockfile);
    if let Some(reason) = reason {
        return (None, Some(actual), expected, Some(reason));
    }
    if Some(&actual) != expected.as_ref() {
        return (None, Some(actual), expected, Some(POLICY_BUNDLE_MISMATCH));
    }
    let text = match String::from_utf8(raw) {
        Ok(s) => s,
        Err(_) => return (None, Some(actual), expected, Some(POLICY_BUNDLE_MALFORMED)),
    };
    match serde_json::from_str::<Value>(&text) {
        Ok(v) if v.is_object() => (Some(v), Some(actual), expected, None),
        _ => (None, Some(actual), expected, Some(POLICY_BUNDLE_MALFORMED)),
    }
}

/// The usable file paths in a `paths` value: a bare string is one path, an array
/// is its string entries, in order, deduplicated with empties dropped.
fn bundle_path_list(value: Option<&Value>) -> Vec<String> {
    let raw: Vec<&Value> = match value {
        Some(Value::Array(arr)) => arr.iter().collect(),
        Some(v) => vec![v],
        None => Vec::new(),
    };
    let mut paths: Vec<String> = Vec::new();
    for entry in raw {
        if let Some(path) = entry.as_str() {
            if !path.is_empty() && !paths.iter().any(|p| p == path) {
                paths.push(path.to_string());
            }
        }
    }
    paths
}

/// Whether `value` has the shape `rule` can compose. A wrong-shaped local entry
/// is treated as absent so it can never dilute the bundle by accident.
fn bundle_value_usable(rule: &str, value: &Value) -> bool {
    match rule {
        "allow" | "egress" | "deny" => value.is_array(),
        "dlp" | "siteMode" => value.is_object(),
        "onlyTrue" => value.is_boolean(),
        "paths" => !bundle_path_list(Some(value)).is_empty(),
        _ => false,
    }
}

/// The local value this key composes against: the layer's own entry when it has
/// the shape the rule expects, else the local `default` layer's entry. That
/// fallback mirrors how a client layer inherits the default layer at
/// enforcement time, so a client-scoped bundle key is composed against the
/// local floor that would actually apply to that client.
fn bundle_local_value(
    key: &str,
    rule: &str,
    local_map: &serde_json::Map<String, Value>,
    local_default: &Value,
) -> Option<Value> {
    if let Some(v) = local_map.get(key) {
        if bundle_value_usable(rule, v) {
            return Some(v.clone());
        }
    }
    if let Some(v) = local_default.get(key) {
        if bundle_value_usable(rule, v) {
            return Some(v.clone());
        }
    }
    None
}

/// The glob metacharacters the matcher honours. A pattern free of all three
/// matches exactly one name, which is what makes an exact-literal intersection
/// decidable. Mirrors bridge.py's _BUNDLE_GLOB_METACHARS.
const BUNDLE_GLOB_METACHARS: [char; 3] = ['*', '?', '['];

#[derive(PartialEq, Eq)]
enum BundlePatternKind {
    Wildcard,
    Literal,
    Glob,
}

/// The one classification shared by the `allow` and `egress` rules, so the two
/// can never drift: the bare wildcard, an exact literal, or a nontrivial glob.
/// Mirrors bridge.py's _bundle_pattern_kind.
fn bundle_pattern_kind(pattern: &str) -> BundlePatternKind {
    if pattern == "*" {
        return BundlePatternKind::Wildcard;
    }
    if pattern.chars().any(|c| BUNDLE_GLOB_METACHARS.contains(&c)) {
        return BundlePatternKind::Glob;
    }
    BundlePatternKind::Literal
}

fn bundle_conflict_reason(key: &str, bundle_pattern: &str, local_pattern: &str) -> String {
    format!(
        "{}: {} bundle pattern \"{}\" and local pattern \"{}\" are different \
         globs with no representable intersection",
        POLICY_BUNDLE_CONFLICT, key, bundle_pattern, local_pattern
    )
}

/// The string entries of one pattern list, in order. A non-string entry is
/// skipped, exactly as the gates skip it at request time.
fn bundle_pattern_strings(list: &Value) -> Vec<&str> {
    match list.as_array() {
        Some(arr) => arr.iter().filter_map(|v| v.as_str()).collect(),
        None => Vec::new(),
    }
}

/// Whether any pattern in `constraint` permits `name`, using the same glob the
/// gates use. This is the only sound direction: `name` is a NAME, not a pattern.
fn bundle_permits_name(constraint: &[&str], name: &str) -> bool {
    constraint.iter().copied().any(|p| {
        glob::Pattern::new(p)
            .map(|g| g.matches(name))
            .unwrap_or(false)
    })
}

/// Explicit intersection of two allow-list PATTERN lists, bundle order first,
/// deduplicated. Testing one side's pattern STRING against the other side's
/// patterns would not be an intersection at all (matching "foo*" against "foo?"
/// succeeds both ways), so each entry is classified first:
///   wildcard  the bare `*`; survives only when the other side is also
///             unconstrained, so a local `*` never widens the bundle.
///   literal   survives when the other side permits it as a NAME.
///   glob      survives when the other side is unconstrained or restates the
///             identical glob. A BUNDLE glob the local list does not restate is
///             dropped (a tightening). A LOCAL glob the bundle does not restate,
///             against a bundle list that has a glob of its own, is a narrowing
///             that cannot be represented: Err rather than silently drop it or
///             keep the broader side. Mirrors bridge.py's
///             _bundle_intersect_lists.
fn bundle_intersect_lists(
    key: &str,
    bundle_list: &Value,
    local_list: &Value,
) -> Result<Value, String> {
    let bundle = bundle_pattern_strings(bundle_list);
    let local = bundle_pattern_strings(local_list);
    let mut out: Vec<&str> = Vec::new();
    for (source, constraint, local_side) in [(&bundle, &local, false), (&local, &bundle, true)] {
        let unconstrained = constraint.iter().any(|p| *p == "*");
        let constraint_globs: Vec<&str> = constraint
            .iter()
            .copied()
            .filter(|p| bundle_pattern_kind(p) == BundlePatternKind::Glob)
            .collect();
        for pattern in source.iter().copied() {
            let keep = match bundle_pattern_kind(pattern) {
                BundlePatternKind::Wildcard => unconstrained,
                BundlePatternKind::Literal => bundle_permits_name(constraint.as_slice(), pattern),
                BundlePatternKind::Glob => {
                    if unconstrained || constraint.contains(&pattern) {
                        true
                    } else {
                        if local_side {
                            if let Some(other) = constraint_globs.first() {
                                return Err(bundle_conflict_reason(key, other, pattern));
                            }
                        }
                        false
                    }
                }
            };
            if keep && !out.contains(&pattern) {
                out.push(pattern);
            }
        }
    }
    Ok(Value::Array(
        out.into_iter()
            .map(|s| Value::String(s.to_string()))
            .collect(),
    ))
}

fn bundle_mode_rank(order: &[&str; 3], unknown_rank: usize, mode: &Value) -> usize {
    match mode.as_str() {
        Some(s) => order.iter().position(|m| *m == s).unwrap_or(unknown_rank),
        None => unknown_rank,
    }
}

/// The stricter of the two raw values by `order` (tightest first); the bundle
/// wins a tie, so an equal local restatement is a no-op.
fn bundle_strictest_mode(
    order: &[&str; 3],
    unknown_rank: usize,
    bundle_mode: &Value,
    local_mode: &Value,
) -> Value {
    if bundle_mode_rank(order, unknown_rank, bundle_mode)
        <= bundle_mode_rank(order, unknown_rank, local_mode)
    {
        bundle_mode.clone()
    } else {
        local_mode.clone()
    }
}

/// The composed value for one key, or None when the bundle does not constrain
/// that key and the plain local-over-bundle result already stands. Err when the
/// two sides cannot be intersected (see bundle_intersect_lists); `key` is
/// carried only to name it.
fn compose_bundle_key(
    key: &str,
    rule: &str,
    bundle_value: Option<&Value>,
    local_value: Option<&Value>,
) -> Result<Option<Value>, String> {
    match rule {
        "deny" => {
            let mut union: Vec<Value> = Vec::new();
            for values in [bundle_value, local_value].into_iter().flatten() {
                if let Some(arr) = values.as_array() {
                    for value in arr {
                        if !union.contains(value) {
                            union.push(value.clone());
                        }
                    }
                }
            }
            if union.is_empty() {
                Ok(None)
            } else {
                Ok(Some(Value::Array(union)))
            }
        }
        "allow" | "egress" => {
            let bundle_arr = match bundle_value.and_then(|v| v.as_array()) {
                Some(a) => a,
                None => return Ok(None),
            };
            let bundle = match bundle_value {
                Some(v) => v,
                None => return Ok(None),
            };
            if rule == "egress" && bundle_arr.is_empty() {
                return Ok(None);
            }
            if rule == "allow" && bundle_arr.iter().any(|v| v.as_str() == Some("*")) {
                return Ok(None);
            }
            let local = match local_value.filter(|v| v.is_array()) {
                Some(v) => v,
                None => return Ok(Some(bundle.clone())),
            };
            if rule == "egress" && local.as_array().is_some_and(|a| a.is_empty()) {
                return Ok(Some(bundle.clone()));
            }
            Ok(Some(bundle_intersect_lists(key, bundle, local)?))
        }
        "dlp" | "siteMode" => {
            let bundle_map = match bundle_value.and_then(|v| v.as_object()) {
                Some(m) => m,
                None => return Ok(None),
            };
            let (order, unknown) = if rule == "dlp" {
                (&POLICY_BUNDLE_DLP_ORDER, POLICY_BUNDLE_DLP_UNKNOWN_RANK)
            } else {
                (
                    &POLICY_BUNDLE_SITE_MODE_ORDER,
                    POLICY_BUNDLE_SITE_MODE_UNKNOWN_RANK,
                )
            };
            let mut composed = local_value
                .and_then(|v| v.as_object())
                .cloned()
                .unwrap_or_default();
            for (name, mode) in bundle_map.iter() {
                let value = match composed.get(name) {
                    Some(local_mode) => bundle_strictest_mode(order, unknown, mode, local_mode),
                    None => mode.clone(),
                };
                composed.insert(name.clone(), value);
            }
            Ok(Some(Value::Object(composed)))
        }
        "onlyTrue" => {
            if bundle_value == Some(&Value::Bool(true)) {
                Ok(Some(Value::Bool(true)))
            } else {
                Ok(None)
            }
        }
        "paths" => {
            // Union of both sides' paths, bundle first: a local layer can add
            // its own secret dictionary but can never displace the bundle's.
            // One path stays a bare string so an unbundled policy is untouched.
            let mut union = bundle_path_list(bundle_value);
            for path in bundle_path_list(local_value) {
                if !union.contains(&path) {
                    union.push(path);
                }
            }
            match union.len() {
                0 => Ok(None),
                1 => Ok(Some(Value::String(union.remove(0)))),
                _ => Ok(Some(Value::Array(
                    union.into_iter().map(Value::String).collect(),
                ))),
            }
        }
        _ => Ok(None),
    }
}

/// Local layer keys override the bundle's, EXCEPT the keys named in
/// POLICY_BUNDLE_COMPOSITION, which compose monotonically so the local layer
/// can only tighten the org baseline. See that table for the per-key rule.
fn merge_bundle_layer(
    bundle_layer: Option<&Value>,
    local_layer: Option<&Value>,
    local_default: &Value,
) -> Result<Value, String> {
    let empty = serde_json::Map::new();
    let bundle_map = bundle_layer.and_then(|v| v.as_object()).unwrap_or(&empty);
    let local_map = local_layer.and_then(|v| v.as_object()).unwrap_or(&empty);
    let mut merged = bundle_map.clone();
    for (k, v) in local_map.iter() {
        merged.insert(k.clone(), v.clone());
    }
    for (key, rule) in POLICY_BUNDLE_COMPOSITION.iter() {
        let local_value = bundle_local_value(key, rule, local_map, local_default);
        if let Some(composed) =
            compose_bundle_key(key, rule, bundle_map.get(*key), local_value.as_ref())?
        {
            merged.insert((*key).to_string(), composed);
        }
    }
    Ok(Value::Object(merged))
}

/// A verified bundle supplies the baseline "default"/"clients" layers; the
/// local policy document is layered on top. Local root keys (including the
/// policyBundle stanza itself) are preserved.
fn compose_bundle_policy(bundle: &Value, local: &Value) -> Result<Value, String> {
    let empty = serde_json::Map::new();
    let local_map = local.as_object().unwrap_or(&empty);
    let local_default = local
        .get("default")
        .filter(|v| v.is_object())
        .cloned()
        .unwrap_or_else(|| json!({}));
    let mut composed = serde_json::Map::new();
    for (k, v) in local_map.iter() {
        if k != "default" && k != "clients" {
            composed.insert(k.clone(), v.clone());
        }
    }
    composed.insert(
        "default".to_string(),
        merge_bundle_layer(bundle.get("default"), local.get("default"), &local_default)?,
    );
    let bundle_clients = bundle
        .get("clients")
        .and_then(|v| v.as_object())
        .unwrap_or(&empty);
    let local_clients = local
        .get("clients")
        .and_then(|v| v.as_object())
        .unwrap_or(&empty);
    let mut names: Vec<String> = bundle_clients.keys().cloned().collect();
    for name in local_clients.keys() {
        if !names.contains(name) {
            names.push(name.clone());
        }
    }
    let mut clients = serde_json::Map::new();
    for name in names {
        clients.insert(
            name.clone(),
            merge_bundle_layer(
                bundle_clients.get(&name),
                local_clients.get(&name),
                &local_default,
            )?,
        );
    }
    composed.insert("clients".to_string(), Value::Object(clients));
    Ok(Value::Object(composed))
}

/// policyInfo view: path, verification result, truncated digest. Metadata only
/// -- bundle CONTENTS are never returned, matching the existing rule that
/// policyInfo discloses paths, not policy bodies.
fn policy_bundle_info() -> Value {
    let state = policy_bundle_state();
    match state.path {
        None => Value::Null,
        Some(path) => json!({
            "path": path,
            "verified": state.verified,
            "digest": short_digest(state.digest.as_deref()),
        }),
    }
}

fn audit_policy_bundle_rejected(
    host_dir: &Path,
    logger: &Arc<Logger>,
    path: &str,
    reason: &str,
    expected: Option<&str>,
    actual: Option<&str>,
) {
    let targets: Vec<String> = if path.is_empty() {
        Vec::new()
    } else {
        vec![path.to_string()]
    };
    write_audit_event(
        host_dir,
        logger,
        &json!({
            "ts": now_ms() as u64,
            "client": "host",
            "action": "policyBundle",
            "targets": targets,
            "decision": POLICY_BUNDLE_DECISION,
            "reason": reason,
            "requestId": Value::Null,
            "expectedDigest": expected,
            "actualDigest": actual,
        }),
    );
}

/// The local policy file only: fail-closed default and logs load errors.
fn load_local_policy(host_dir: &Path, logger: &Arc<Logger>) -> Value {
    let path = policy_file_path(host_dir);
    match std::fs::read_to_string(&path) {
        Ok(s) => match serde_json::from_str::<Value>(&s) {
            Ok(v) if v.is_object() => v,
            Ok(_) => {
                log_error(
                    logger,
                    &format!(
                        "Could not load policy file {}: root must be an object",
                        path.display()
                    ),
                );
                default_policy()
            }
            Err(e) => {
                log_error(
                    logger,
                    &format!("Could not load policy file {}: {}", path.display(), e),
                );
                default_policy()
            }
        },
        Err(e) => {
            log_error(
                logger,
                &format!("Could not load policy file {}: {}", path.display(), e),
            );
            default_policy()
        }
    }
}

/// The effective policy document: the local policy file, or -- when it names a
/// policyBundle -- the VERIFIED bundle with the local file layered on top.
fn load_policy(host_dir: &Path, logger: &Arc<Logger>) -> Value {
    let local = load_local_policy(host_dir, logger);
    let config = match policy_bundle_config(&local) {
        None => {
            set_policy_bundle_state(PolicyBundleState::default());
            return local;
        }
        Some(cfg) => cfg,
    };
    let (path, lockfile) = config;
    let (doc, actual, expected, reason) = verify_policy_bundle(&path, &lockfile);
    let mut reason: Option<String> = reason.map(|r| r.to_string());
    let mut composed: Option<Value> = None;
    if reason.is_none() {
        // A verified bundle can still be MISCONFIGURED against the local layer.
        // That rejection reuses this same path -- one log line, one audit event,
        // the built-in default served -- so it is reported once per change by the
        // mtime-based reload check rather than on every request.
        match doc {
            Some(bundle) => match compose_bundle_policy(&bundle, &local) {
                Ok(value) => composed = Some(value),
                Err(conflict) => reason = Some(conflict),
            },
            None => composed = Some(default_policy()),
        }
    }
    if let Some(reason) = reason {
        set_policy_bundle_state(PolicyBundleState {
            path: Some(path.clone()),
            lockfile: Some(lockfile.clone()),
            verified: false,
            digest: actual.clone(),
        });
        log_error(logger, &format!(
            "Rejected policy bundle {}: {} (expected {}, actual {}); serving built-in fail-closed default policy",
            if path.is_empty() { "<unset>" } else { path.as_str() },
            reason,
            expected.clone().unwrap_or_else(|| "none".to_string()),
            actual.clone().unwrap_or_else(|| "none".to_string()),
        ));
        audit_policy_bundle_rejected(
            host_dir,
            logger,
            &path,
            &reason,
            expected.as_deref(),
            actual.as_deref(),
        );
        return default_policy();
    }
    set_policy_bundle_state(PolicyBundleState {
        path: Some(path),
        lockfile: Some(lockfile),
        verified: true,
        digest: actual,
    });
    composed.unwrap_or_else(default_policy)
}

/// Every file the effective policy derives from, using the bundle paths the
/// last load resolved. A swapped bundle or lockfile changes the signature, so
/// its digest is re-verified instead of being trusted for the process's life.
#[derive(Clone, PartialEq, Eq)]
struct PolicySourceSig {
    policy_mtime: Option<SystemTime>,
    bundle_path: Option<String>,
    bundle_mtime: Option<SystemTime>,
    lock_path: Option<String>,
    lock_mtime: Option<SystemTime>,
}

fn policy_source_signature(host_dir: &Path) -> PolicySourceSig {
    let state = policy_bundle_state();
    PolicySourceSig {
        policy_mtime: file_mtime(&policy_file_path(host_dir)),
        bundle_mtime: state.path.as_ref().and_then(|p| file_mtime(Path::new(p))),
        bundle_path: state.path,
        lock_mtime: state
            .lockfile
            .as_ref()
            .and_then(|p| file_mtime(Path::new(p))),
        lock_path: state.lockfile,
    }
}

/// Shared policy value plus the signature of every file it derives from,
/// reloadable under a lock.
struct PolicyRegistry {
    value: Value,
    sources: PolicySourceSig,
}

type Policy = Arc<RwLock<PolicyRegistry>>;

/// Initial policy load. Secret masks are primed HERE, before the socket server
/// accepts its first connection: masking must be armed for the very first
/// request, including a denial whose reason or target quotes a secret. Waiting
/// for the first mtime reload or the first successful forward would leak the raw
/// value into that first audit event.
fn build_policy_registry(host_dir: &Path, logger: &Arc<Logger>) -> PolicyRegistry {
    let value = load_policy(host_dir, logger);
    prime_secret_masks(&value, host_dir, logger);
    prime_audit_export(&value, host_dir, logger);
    PolicyRegistry {
        value,
        // Computed AFTER the load: the load is what resolves the bundle paths
        // this signature has to cover.
        sources: policy_source_signature(host_dir),
    }
}

/// Cached-with-mtime read: reload when any policy source's mtime changes
/// (including absent -> present) so changes take effect without a restart.
fn current_policy(policy: &Policy, host_dir: &Path, logger: &Arc<Logger>) -> Value {
    let cur = policy_source_signature(host_dir);
    if let Ok(reg) = policy.read() {
        if cur == reg.sources {
            return reg.value.clone();
        }
    }
    if let Ok(mut reg) = policy.write() {
        if cur != reg.sources {
            reg.value = load_policy(host_dir, logger);
            reg.sources = policy_source_signature(host_dir);
            prime_secret_masks(&reg.value, host_dir, logger);
            prime_audit_export(&reg.value, host_dir, logger);
        }
        return reg.value.clone();
    }
    default_policy()
}

const POLICY_LIST_KEYS: [&str; 7] = [
    "allowedActions",
    "deniedActions",
    "allowedOrigins",
    "deniedOrigins",
    "requireConfirmation",
    "redactPatterns",
    "egressAllowlist",
];
const POLICY_BOOL_KEYS: [&str; 2] = ["redact", "audit"];
/// String-valued policy keys merged like bools: a later layer replaces the value.
const POLICY_STR_KEYS: [&str; 1] = ["traceDir"];
/// File-path policy keys merged like strings, except that the value may also be
/// a LIST of paths: bundle composition can compose the org's path with the local
/// one (see the `paths` rule in POLICY_BUNDLE_COMPOSITION). Mirrors bridge.py.
const POLICY_PATH_KEYS: [&str; 1] = ["secretMaskFile"];
/// Map-valued policy keys merged PER KEY: a later layer overrides only the
/// origin patterns it names and inherits the rest. Mirrors bridge.py.
const POLICY_MAP_KEYS: [&str; 3] = ["siteModes", "dlp", "auditExport"];

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
        for key in POLICY_PATH_KEYS.iter() {
            if let Some(v) = layer.get(*key) {
                if v.is_string() || v.is_array() {
                    merged[*key] = v.clone();
                }
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
    vec![
        format!("{}://{}", scheme, netloc),
        format!("*://{}", netloc),
    ]
}

/// Ordered list of normalized policy targets derived from a request payload.
fn targets_from_payload(action: &str, payload: Option<&Value>) -> Vec<String> {
    let payload = match payload {
        Some(p) if p.is_object() => p,
        _ => return Vec::new(),
    };
    match action {
        "navigate" | "navigateTaskSession" | "navigateAndSnapshot" | "downloadUrl" => payload
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
        // Replay reproduces its steps through the extension's dispatch table, so
        // the outer request's policy targets are the union of its steps'.
        "replayWorkflow" => {
            let mut targets = Vec::new();
            for (s_action, s_payload) in workflow_step_payloads(Some(payload)) {
                targets.extend(targets_from_payload(&s_action, Some(&s_payload)));
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

/// Normalized policy targets for the outbound destination an action would cause,
/// or [] when the action names no destination the host can see. batch and
/// replayWorkflow deliberately resolve to [] here: their steps are each evaluated
/// by evaluate_policy, so a smuggled step is reported with its own index instead
/// of being flattened into the composite's verdict.
/// Mirrors bridge.py::egress_targets.
fn egress_targets(action: &str, payload: Option<&Value>) -> Vec<String> {
    if !EGRESS_URL_ACTIONS.contains(&action) {
        return Vec::new();
    }
    match payload {
        Some(p) if p.is_object() => p
            .get("url")
            .and_then(|u| u.as_str())
            .map(normalize_url_targets)
            .unwrap_or_default(),
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
            let s_action = step
                .get("action")
                .and_then(|a| a.as_str())
                .unwrap_or("")
                .to_string();
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

/// Selector actions that replayWorkflow retargets at the caller's tabId even
/// when the recorded step carried none, because they need a tab to resolve
/// against. Mirrors CACHEABLE_SELECTOR_ACTIONS in background.js.
const WORKFLOW_SELECTOR_ACTIONS: [&str; 5] = ["click", "type", "fill", "select", "hover"];

/// Yield (action, effective_payload) for a replayWorkflow's steps, applying the
/// extension's replay retargeting: a top-level tabId REPLACES a step's own tabId
/// and supplies one for selector steps that carry none, so origin policy cannot
/// be bypassed either by hoisting tabId to the replay payload or by recording a
/// step against a different tab. Steps with no action are skipped because the
/// extension never dispatches them. Mirrors bridge.py::_workflow_step_payloads.
///
/// A version-2 step may carry an `expect` clause (T4-4). The extension evaluates
/// it against the step's effective tab, so it is enumerated here as a synthetic
/// `expect` step: a nested postcondition is then origin-checked like any other
/// tab-scoped action instead of riding in unexamined. `expect` is a non-mutating
/// assertion, so it appears in none of the mutating, sensitive, or destructive
/// sets and stays on the read-only side of the action classification.
fn workflow_step_payloads(payload: Option<&Value>) -> Vec<(String, Value)> {
    let mut out = Vec::new();
    let obj = match payload {
        Some(p) if p.is_object() => p,
        _ => return out,
    };
    let steps = match obj.get("workflow").and_then(|w| w.get("steps")) {
        Some(Value::Array(steps)) => steps,
        _ => return out,
    };
    let default_tab = obj.get("tabId").filter(|v| v.as_i64().is_some()).cloned();
    for step in steps {
        let s_action = step
            .get("action")
            .and_then(|a| a.as_str())
            .unwrap_or("")
            .to_string();
        if s_action.is_empty() {
            continue;
        }
        let mut s_payload = match step.get("payload") {
            Some(Value::Object(m)) => Value::Object(m.clone()),
            _ => json!({}),
        };
        if let (Some(dt), Value::Object(map)) = (&default_tab, &mut s_payload) {
            if map.contains_key("tabId") || WORKFLOW_SELECTOR_ACTIONS.contains(&s_action.as_str()) {
                map.insert("tabId".to_string(), dt.clone());
            }
        }
        let s_expect = step.get("expect").filter(|e| e.is_object()).cloned();
        let step_tab = s_payload.get("tabId").filter(|v| !v.is_null()).cloned();
        out.push((s_action, s_payload));
        if let Some(expect) = s_expect {
            let mut e_payload = serde_json::Map::new();
            if let Some(tab) = step_tab.or_else(|| default_tab.clone()) {
                e_payload.insert("tabId".to_string(), tab);
            }
            if let Some(mode) = expect.get("mode").filter(|m| m.is_string()) {
                e_payload.insert("mode".to_string(), mode.clone());
            }
            out.push(("expect".to_string(), Value::Object(e_payload)));
        }
    }
    out
}

/// The set of tabId keys whose live origin the host must resolve to apply site
/// policy. "" means the active tab. Empty for origin-exempt actions. Recurses
/// into batch steps with runBatch tabId defaulting and into replayWorkflow steps
/// with replay tabId retargeting.
fn tab_ids_needed(action: &str, payload: Option<&Value>) -> std::collections::BTreeSet<String> {
    let mut needed = std::collections::BTreeSet::new();
    if action == "batch" || action == "replayWorkflow" {
        let steps = if action == "batch" {
            step_payloads(payload)
        } else {
            workflow_step_payloads(payload)
        };
        for (s_action, s_payload) in steps {
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
                pattern.len() > bp.len() || (pattern.len() == bp.len() && pattern.as_str() < bp)
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
///
/// `manual` gates on the EFFECTIVE tier, so an all-read-only batch is not
/// force-gated while one carrying a single mutating step is, and a read-only
/// action whose payload sets a state-changing flag is.
fn apply_site_mode(
    site_mode: Option<&str>,
    action: &str,
    confirm: bool,
    payload: Option<&Value>,
) -> bool {
    match site_mode {
        Some("manual") if effective_action_tier(action, payload) == "mutating" => true,
        Some("skip")
            if confirm
                && !non_skippable_confirmation(action)
                && !payload_escalates_tier(action, payload) =>
        {
            false
        }
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
        return (
            false,
            Some(format!("action {} denied", action)),
            false,
            redact_enabled,
            audit_enabled,
            targets,
        );
    }
    if TARGET_REQUIRED_ACTIONS.contains(&action) && targets.is_empty() {
        return (
            false,
            Some("target unresolved".to_string()),
            false,
            redact_enabled,
            audit_enabled,
            targets,
        );
    }

    if action_matches(cp.get("deniedActions"), action) {
        return (
            false,
            Some(format!("action {} denied", action)),
            false,
            redact_enabled,
            audit_enabled,
            targets,
        );
    }
    if !action_matches(cp.get("allowedActions"), action) {
        return (
            false,
            Some(format!("action {} not allowed", action)),
            false,
            redact_enabled,
            audit_enabled,
            targets,
        );
    }
    // Data-loss-prevention channel gate. Placed after the action gates and before
    // anything that could forward, so a blocked channel is refused while the
    // request is still just JSON: no file is opened, no frame is read. batch and
    // replayWorkflow belong to no channel themselves; their steps are evaluated
    // recursively below and produce "<batch|workflow> step N: dlp blocked".
    // Mirrors bridge.py::evaluate_policy.
    if resolve_dlp_mode(&cp, dlp_channel_for_action(action)) == Some("block") {
        return (
            false,
            Some(DLP_BLOCKED_ERROR.to_string()),
            false,
            redact_enabled,
            audit_enabled,
            targets,
        );
    }
    // Per-site permission mode. Applied to the confirmation requirement only,
    // and only after the action gates: every deny path below returns
    // confirm=false explicitly, so a deny still outranks any mode.
    let confirm = apply_site_mode(
        resolve_site_mode(&cp, &targets).as_deref(),
        action,
        action_matches(cp.get("requireConfirmation"), action),
        payload,
    );

    if action == "batch" {
        // `batch` is origin-exempt for site policy because each step is checked
        // against its own origin. The `manual` gate still has to see the origins
        // the batch will act on, or hoisting actions into a batch would bypass a
        // manual origin. Resolve the mode from the union of the step origins, and
        // gate on the batch's EFFECTIVE tier so an all-read-only batch stays
        // ungated while one carrying a mutating step does not.
        let mut mode_targets = targets.clone();
        for tab_key in tab_ids_needed(action, payload) {
            if let Some(Some(origin)) = origins.get(&tab_key) {
                mode_targets.extend(origin_targets(Some(origin.as_str())));
            }
        }
        let confirm = apply_site_mode(
            resolve_site_mode(&cp, &mode_targets).as_deref(),
            action,
            confirm,
            payload,
        );
        if confirm {
            return (true, None, true, redact_enabled, audit_enabled, targets);
        }
        let mut step_confirm = false;
        for (i, (s_action, s_payload)) in step_payloads(payload).into_iter().enumerate() {
            let (s_allowed, s_reason, s_confirm, _, _, s_targets) =
                evaluate_policy(policy, name, &s_action, Some(&s_payload), origins);
            if !s_allowed {
                let reason = s_reason.unwrap_or_default();
                return (
                    false,
                    Some(format!("batch step {}: {}", i, reason)),
                    false,
                    redact_enabled,
                    audit_enabled,
                    s_targets,
                );
            }
            step_confirm = step_confirm || s_confirm;
        }
        return (
            true,
            None,
            step_confirm,
            redact_enabled,
            audit_enabled,
            targets,
        );
    }

    // replayWorkflow reproduces recorded mutating actions through the extension's
    // dispatch table, exactly like a batch, so its steps are evaluated here
    // before anything is forwarded. Two differences from batch:
    //  - Steps are inspected even when the replay action itself is
    //    confirmation-gated: an outer replay token approves "replay this
    //    workflow", never each nested action inside it.
    //  - There is no aggregate confirmation token for nested steps. A nested step
    //    that still requires confirmation after its own siteMode is applied fails
    //    the whole replay, because a single outer token cannot carry per-step
    //    approval and a half-run workflow has already mutated the page.
    // Mirrors bridge.py::evaluate_policy.
    if action == "replayWorkflow" {
        for (i, (s_action, s_payload)) in workflow_step_payloads(payload).into_iter().enumerate() {
            let (s_allowed, s_reason, s_confirm, _, _, s_targets) =
                evaluate_policy(policy, name, &s_action, Some(&s_payload), origins);
            if !s_allowed {
                let reason = s_reason.unwrap_or_default();
                return (
                    false,
                    Some(format!("workflow step {}: {}", i, reason)),
                    false,
                    redact_enabled,
                    audit_enabled,
                    s_targets,
                );
            }
            if s_confirm {
                return (
                    false,
                    Some(format!("workflow step {} requires confirmation", i)),
                    false,
                    redact_enabled,
                    audit_enabled,
                    s_targets,
                );
            }
        }
        return (true, None, confirm, redact_enabled, audit_enabled, targets);
    }

    if !targets.is_empty() && target_matches(cp.get("deniedOrigins"), &targets) {
        return (
            false,
            Some("target denied".to_string()),
            false,
            redact_enabled,
            audit_enabled,
            targets,
        );
    }
    if !targets.is_empty() && !target_matches(cp.get("allowedOrigins"), &targets) {
        return (
            false,
            Some("target not allowed".to_string()),
            false,
            redact_enabled,
            audit_enabled,
            targets,
        );
    }

    // Egress allowlist (`egressAllowlist`): where the agent may make the browser
    // SEND traffic, as opposed to which page it may act upon. Evaluated AFTER the
    // action and site-target gates, so a denied action or a denied / non-allowed
    // origin still wins and an egress grant can never widen site policy. Empty or
    // absent means unconstrained. Mirrors bridge.py::evaluate_policy.
    let egress_allow = cp.get("egressAllowlist");
    let egress_active = matches!(egress_allow, Some(Value::Array(a)) if !a.is_empty());
    if egress_active && EGRESS_URL_ACTIONS.contains(&action) {
        let e_targets = egress_targets(action, payload);
        // Fail closed: an egress-bearing action whose destination the host cannot
        // resolve is denied rather than forwarded unchecked.
        if e_targets.is_empty() || !target_matches(egress_allow, &e_targets) {
            let reported = if e_targets.is_empty() {
                targets
            } else {
                e_targets
            };
            return (
                false,
                Some("egress not allowed".to_string()),
                false,
                redact_enabled,
                audit_enabled,
                reported,
            );
        }
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
        // The tier the host actually enforces for this action+payload:
        // "read_only" or "mutating". Computed from the payload, so a batch of
        // reads is read_only and a read whose flag changes state is mutating.
        "effectiveTier": effective_action_tier(action, payload),
        // The resolved DLP mode for this action's channel, or null when the
        // action belongs to no DLP channel.
        "dlp": resolve_dlp_mode(&policy_for_client(policy, name), dlp_channel_for_action(action)),
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
fn policy_denial(
    reason: &str,
    action: &str,
    targets: &[String],
    name: &str,
    host_dir: &Path,
    policy: &Value,
    payload: Option<&Value>,
) -> Value {
    let policy_file = policy_file_path(host_dir).to_string_lossy().to_string();
    let sample = targets.first().cloned();
    // Strip a "batch step N: <inner>" wrapper so a denied batch step yields the
    // same structured remediation as the inner action. Mirrors bridge.py.
    let mut reason = reason.to_string();
    let mut action = action.to_string();
    let mut batch_step: Option<i64> = None;
    let step_prefixed = reason
        .strip_prefix("batch step ")
        .or_else(|| reason.strip_prefix("workflow step "))
        .map(|rest| rest.to_string());
    if let Some(rest) = step_prefixed {
        if let Some((num, inner)) = rest.split_once(": ") {
            if let Ok(n) = num.parse::<i64>() {
                batch_step = Some(n);
                reason = inner.to_string();
            }
        } else if let Some(num) = rest.strip_suffix(" requires confirmation") {
            // Carries no nested reason to unwrap, but the step index is still the
            // actionable part.
            if let Ok(n) = num.parse::<i64>() {
                batch_step = Some(n);
            }
        }
    }
    // For action-type reasons the real action is embedded in the reason text; the
    // outer action may be "batch"/"replayWorkflow" for a denied step, so trust
    // the reason.
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
    // DLP: resolve the blocked chokepoint before `action` is frozen, so a
    // composite denial names the smuggled step's own action rather than "batch".
    let mut dlp_channel: Option<&'static str> = None;
    if reason == DLP_BLOCKED_ERROR {
        if let Some((hit_action, channel)) =
            dlp_blocked_target(&policy_for_client(policy, name), &action, payload)
        {
            action = hit_action;
            dlp_channel = Some(channel);
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
        if has_client_list {
            format!("clients.{}", name)
        } else {
            "default".to_string()
        }
    };
    let (kind, remediation, suggested): (&str, String, Value) = if reason.starts_with("action ")
        && reason.ends_with("not allowed")
    {
        let section = section_for("allowedActions");
        (
            "action",
            format!(
                "Add '{}' to {}.allowedActions in {}",
                action, section, policy_file
            ),
            json!({"op": "add", "section": section, "list": "allowedActions", "value": action}),
        )
    } else if reason == "target not allowed" {
        let section = section_for("allowedOrigins");
        (
            "origin",
            match &sample {
                Some(s) => format!(
                    "Add an origin pattern covering '{}' to {}.allowedOrigins in {}",
                    s, section, policy_file
                ),
                None => format!(
                    "Add the request origin to {}.allowedOrigins in {}",
                    section, policy_file
                ),
            },
            match &sample {
                Some(_) => {
                    json!({"op": "add", "section": section, "list": "allowedOrigins", "value": sample})
                }
                None => Value::Null,
            },
        )
    } else if reason == "target denied" {
        let section = section_for("deniedOrigins");
        let cp = policy_for_client(policy, name);
        let matched: Vec<String> = cp
            .get("deniedOrigins")
            .and_then(|v| v.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|p| p.as_str())
                    .filter(|p| target_matches(Some(&json!([p])), targets))
                    .map(|p| p.to_string())
                    .collect()
            })
            .unwrap_or_default();
        (
            "origin",
            match &sample {
                Some(s) => format!(
                    "Remove or narrow the {}.deniedOrigins pattern(s) {:?} matching '{}' in {}",
                    section, matched, s, policy_file
                ),
                None => format!(
                    "Remove or narrow the matching {}.deniedOrigins pattern in {}",
                    section, policy_file
                ),
            },
            if matched.is_empty() {
                Value::Null
            } else {
                json!({"op": "removePattern", "section": section, "list": "deniedOrigins", "value": sample, "patterns": matched})
            },
        )
    } else if reason == "egress not allowed" {
        let section = section_for("egressAllowlist");
        (
            "egress",
            match &sample {
                Some(s) => format!(
                    "Add a host pattern covering '{}' to {}.egressAllowlist in {}",
                    s, section, policy_file
                ),
                None => format!(
                    "Add the destination host to {}.egressAllowlist in {}",
                    section, policy_file
                ),
            },
            match &sample {
                Some(_) => {
                    json!({"op": "add", "section": section, "list": "egressAllowlist", "value": sample})
                }
                None => Value::Null,
            },
        )
    } else if reason.starts_with("action ") && reason.ends_with("denied") {
        let section = section_for("deniedActions");
        let cp = policy_for_client(policy, name);
        let matched: Vec<String> = cp
            .get("deniedActions")
            .and_then(|v| v.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|p| p.as_str())
                    .filter(|p| action_matches(Some(&json!([p])), action))
                    .map(|p| p.to_string())
                    .collect()
            })
            .unwrap_or_default();
        (
            "action",
            format!(
                "Remove or narrow the {}.deniedActions pattern(s) {:?} matching '{}' in {}",
                section, matched, action, policy_file
            ),
            json!({"op": "removePattern", "section": section, "list": "deniedActions", "value": action, "patterns": matched}),
        )
    } else if reason == "target unresolved" || reason == "tab origin unresolved" {
        ("target",
             "The request carried no resolvable target origin; supply a valid url/domain/tabId so site policy can be evaluated".to_string(),
             Value::Null)
    } else if reason == DLP_BLOCKED_ERROR {
        // `dlp` is a MAP key, so section_for (which tests for a list) cannot
        // resolve it. It is also merged per channel, so a client layer only
        // governs the channel it names.
        let client_owns = dlp_channel
            .and_then(|channel| {
                policy
                    .get("clients")
                    .and_then(|c| c.get(name))
                    .and_then(|l| l.get("dlp"))
                    .and_then(|d| d.get(channel))
            })
            .is_some();
        let section = if client_owns {
            format!("clients.{}", name)
        } else {
            "default".to_string()
        };
        let channel_name = dlp_channel.unwrap_or("the requested");
        (
            "dlp",
            format!(
                "Set {}.dlp.{} to 'audit' or 'allow' in {} to permit '{}'",
                section, channel_name, policy_file, action
            ),
            match dlp_channel {
                Some(channel) => json!({"op": "setChannelMode", "section": section, "map": "dlp",
                                         "channel": channel, "value": "audit"}),
                None => Value::Null,
            },
        )
    } else {
        (
            "other",
            format!("Review default policy in {}", policy_file),
            Value::Null,
        )
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
        // The DLP channel that refused the request, or null for every other kind.
        "dlpChannel": dlp_channel,
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

/// Entries for the policy's secretMaskFile, which is either a single path or a
/// LIST of paths (bundle composition unions the org's path with the local one;
/// see the `paths` rule in POLICY_BUNDLE_COMPOSITION). The result is the union of
/// every path's entries, still ordered longest value first so an overlapping
/// shorter secret cannot pre-empt a longer one. Each path is loaded and cached
/// independently, so one missing file never disables the others.
fn load_secret_masks(
    paths: Option<&Value>,
    host_dir: &Path,
    logger: &Arc<Logger>,
) -> Vec<(String, String)> {
    let paths = bundle_path_list(paths);
    if paths.len() == 1 {
        return load_secret_mask_path(&paths[0], host_dir, logger);
    }
    let mut entries: Vec<(String, String)> = Vec::new();
    for path in paths.iter() {
        for entry in load_secret_mask_path(path, host_dir, logger) {
            if !entries.iter().any(|e| e.1 == entry.1) {
                entries.push(entry);
            }
        }
    }
    entries.sort_by(|a, b| b.1.len().cmp(&a.1.len()));
    entries
}

/// Parse `name=value` lines from one secretMaskFile path. Blank lines and `#`
/// comments are ignored; a missing/unreadable file disables masking for that
/// path after one warning. Cached by mtime like the policy itself, so edits
/// apply without a host restart.
fn load_secret_mask_path(
    path: &str,
    host_dir: &Path,
    logger: &Arc<Logger>,
) -> Vec<(String, String)> {
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
        state
            .cache
            .insert(path.to_string(), (mtime, entries.clone()));
    }
    // Emit outside the lock: write_audit_event masks with the same state.
    if let Some(reason) = warn_once {
        log_warn(
            logger,
            &format!("Could not load secretMaskFile {}: {}", path, reason),
        );
        write_audit_event(
            host_dir,
            logger,
            &json!({
                "ts": now_ms() as u64,
                "client": Value::Null,
                "action": "secretMaskFile",
                "targets": [path],
                "decision": "secret_mask_unavailable",
                "reason": reason,
                "requestId": Value::Null,
            }),
        );
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
/// (including audit masking) is armed before the first response arrives. A
/// composed value can be a LIST of paths (see the `paths` rule in
/// POLICY_BUNDLE_COMPOSITION); load_secret_masks primes every entry.
fn prime_secret_masks(policy: &Value, host_dir: &Path, logger: &Arc<Logger>) {
    let mut names: Vec<String> = vec!["default".to_string()];
    if let Some(Value::Object(clients)) = policy.get("clients") {
        names.extend(clients.keys().cloned());
    }
    for name in names {
        let cp = policy_for_client(policy, &name);
        load_secret_masks(cp.get("secretMaskFile"), host_dir, logger);
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
        Value::Array(arr) => Value::Array(
            arr.into_iter()
                .map(|v| mask_secrets_value(v, secrets))
                .collect(),
        ),
        other => other,
    }
}

static AUDIT_WRITE_LOCK: Mutex<()> = Mutex::new(());

/// Append one JSON line to the audit log. Never writes payload/response bodies,
/// and never any known secretMaskFile value (a denial reason can quote a
/// target). A write failure is logged but never blocks browser automation.
///
/// The local log is the source of truth and this append is synchronous. The
/// optional `auditExport` sink is a MIRROR of the line just committed here: the
/// already-masked event is handed to a bounded channel drained by one
/// background worker (see queue_audit_export), so export can never precede,
/// replace, or delay the local write, and a slow or dead collector can never
/// add latency to the request thread.
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
        Err(e) => Err(io::Error::other(format!(
            "audit write lock poisoned: {}",
            e
        ))),
    };
    if let Err(e) = result {
        log_error(
            logger,
            &format!("Could not write audit event to {}: {}", path.display(), e),
        );
        return;
    }
    queue_audit_export(host_dir, logger, event);
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

// --- Audit export forwarder (policy `auditExport`) -------------------------
//
// Mirrors bridge.py. An ADDITIONAL sink for audit events the local log already
// holds. Export never computes a new event and never adds a field: it
// re-encodes the exact masked object `write_audit_event` just committed, so no
// payload body, no response body, and no unmasked secret can reach a SIEM that
// the local log does not already carry.
//
// Configuration is the `auditExport` policy map, merged per key across the
// `default` and `clients.<name>` layers. `format` is jsonl, syslog, or cef;
// `destination` is a local file path (jsonl/cef) or udp://host:port,
// tcp://host:port, or a unix datagram socket path (syslog). Null or absent
// disables export entirely.
//
// Fail closed and loud: a malformed control block, or a sink that refuses a
// write, disables that sink for the life of the process after exactly one log
// line and exactly one `audit_export_unavailable` audit event.

const AUDIT_EXPORT_FORMATS: [&str; 3] = ["jsonl", "syslog", "cef"];

/// Bound on any network sink so a wedged collector cannot hold the export lock.
const AUDIT_EXPORT_TIMEOUT: Duration = Duration::from_secs(2);

/// RFC 5424 framing constants. Facility local0 (16); severity 4 (warning) for
/// the deny/blackout class, 6 (informational) for everything else.
const SYSLOG_FACILITY: u16 = 16;
const SYSLOG_SEVERITY_ALERT: u16 = 4;
const SYSLOG_SEVERITY_INFO: u16 = 6;
const SYSLOG_APP_NAME: &str = "chrome-bridge";
const SYSLOG_SD_ID: &str = "chromeBridge@0";

/// ArcSight CEF header constants. The version field is the audit-export SCHEMA
/// version, not the product version.
const CEF_VENDOR: &str = "ChromeBridge";
const CEF_PRODUCT: &str = "NativeHost";
const CEF_VERSION: &str = "1.0";
const CEF_SEVERITY_ALERT: u16 = 7;
const CEF_SEVERITY_INFO: u16 = 3;

/// Fixed field order for syslog structured data, so a Rust line and a Python
/// line for the same event are byte-identical.
const AUDIT_EXPORT_FIELDS: [&str; 6] = [
    "client",
    "action",
    "decision",
    "reason",
    "requestId",
    "targets",
];

/// Key for the base (built-in + `default`) export layer. Client names are
/// parsed from `name:token` lines, so a NUL can never collide with a real one.
const POLICY_BASE_LAYER: &str = "\u{0}";

#[derive(Clone)]
struct AuditExportConfig {
    format: String,
    destination: String,
    rotate_bytes: Option<u64>,
    retain_days: Option<f64>,
    key: String,
}

#[derive(Default)]
struct AuditExportState {
    layers: HashMap<String, Option<AuditExportConfig>>,
    disabled: std::collections::HashSet<String>,
}

/// Serializes every export write (and therefore every rotation) under the
/// thread-per-connection model, exactly like AUDIT_WRITE_LOCK does locally.
/// Separate from it on purpose: a slow sink must never delay the local append.
/// Held only by the export worker thread now, never by a request thread, so
/// rotation and retention pruning also run off the request path.
static AUDIT_EXPORT_LOCK: Mutex<()> = Mutex::new(());
static AUDIT_EXPORT_STATE: Mutex<Option<AuditExportState>> = Mutex::new(None);

/// Bounded hand-off from the request thread to the single export worker. One
/// FIFO channel drained by one worker, so events reach the sink in exactly the
/// order they were appended locally. Each queue entry is an immutable
/// `(event, config)` snapshot: the sink is resolved ONCE, on the request
/// thread, and the worker forwards to exactly that sink. A policy reload while
/// events are queued therefore can neither reroute an already-authorized event
/// to a destination configured later nor drop it. When the channel is full the
/// NEWEST event is dropped (the same choice the OTLP exporter makes) and
/// counted: the local audit log still holds every event, so a drop costs
/// completeness of the mirror, never of the record. The channel and its thread
/// are created on the first event that actually has a sink, so a host with no
/// auditExport starts no thread.
const AUDIT_EXPORT_QUEUE_MAX: usize = 1024;

/// One queued export: the event plus the sink snapshot that authorized it.
type QueuedAuditExport = (Value, AuditExportConfig);

static AUDIT_EXPORT_SENDER: Mutex<Option<std::sync::mpsc::SyncSender<QueuedAuditExport>>> =
    Mutex::new(None);
static AUDIT_EXPORT_DROPPED: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

/// Deny and blackout outcomes ride at the higher severity in both formats.
fn audit_export_alerting(decision: Option<&Value>) -> bool {
    let text = decision
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_lowercase();
    text.contains("deny") || text.contains("blackout") || text.contains("unavailable")
}

/// Render one audit field. Absent/null/empty is "-"; a non-string leaf is
/// rendered as compact JSON so both hosts agree byte for byte.
fn audit_export_scalar(value: Option<&Value>) -> String {
    match value {
        None | Some(Value::Null) => "-".to_string(),
        Some(Value::String(s)) => {
            if s.is_empty() {
                "-".to_string()
            } else {
                s.clone()
            }
        }
        Some(v) => serde_json::to_string(v).unwrap_or_else(|_| "-".to_string()),
    }
}

fn audit_export_field(event: &Value, key: &str) -> String {
    let value = event.get(key);
    if key == "targets" {
        return match value {
            Some(Value::Array(items)) if !items.is_empty() => items
                .iter()
                .map(|v| audit_export_scalar(Some(v)))
                .collect::<Vec<String>>()
                .join(","),
            _ => "-".to_string(),
        };
    }
    audit_export_scalar(value)
}

fn audit_export_epoch_ms(event: &Value) -> Option<i64> {
    let ts = event.get("ts")?;
    ts.as_i64().or_else(|| ts.as_f64().map(|f| f as i64))
}

fn syslog_timestamp(event: &Value) -> String {
    let ms = match audit_export_epoch_ms(event) {
        Some(ms) => ms,
        None => return "-".to_string(),
    };
    match chrono::DateTime::<chrono::Utc>::from_timestamp_millis(ms) {
        Some(dt) => dt.format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string(),
        None => "-".to_string(),
    }
}

/// RFC 5424 6.3.3: only these three characters are escaped in PARAM-VALUE.
fn syslog_escape(text: &str) -> String {
    text.replace('\\', "\\\\")
        .replace('"', "\\\"")
        .replace(']', "\\]")
}

/// MSGID is PRINTUSASCII, capped so a long action cannot unbalance the line.
fn syslog_msgid(event: &Value) -> String {
    let action = event.get("action").and_then(|v| v.as_str()).unwrap_or("");
    let safe: String = action
        .chars()
        .filter(|c| c.is_ascii_graphic())
        .take(32)
        .collect();
    if safe.is_empty() {
        "-".to_string()
    } else {
        safe
    }
}

fn cef_header_escape(text: &str) -> String {
    text.replace('\\', "\\\\")
        .replace('|', "\\|")
        .replace('\n', " ")
        .replace('\r', " ")
}

fn cef_value_escape(text: &str) -> String {
    text.replace('\\', "\\\\")
        .replace('=', "\\=")
        .replace('\n', "\\n")
        .replace('\r', "\\n")
}

/// One export line for one audit event, without a trailing newline. Reads only
/// fields the audit log already carries.
fn format_audit_export_line(format: &str, event: &Value) -> Result<String, String> {
    if format == "jsonl" {
        return serde_json::to_string(event).map_err(|e| e.to_string());
    }
    let field = |key: &str| audit_export_field(event, key);
    let alerting = audit_export_alerting(event.get("decision"));
    if format == "syslog" {
        let pri = SYSLOG_FACILITY * 8
            + if alerting {
                SYSLOG_SEVERITY_ALERT
            } else {
                SYSLOG_SEVERITY_INFO
            };
        let data = AUDIT_EXPORT_FIELDS
            .iter()
            .copied()
            .map(|key| format!("{}=\"{}\"", key, syslog_escape(&field(key))))
            .collect::<Vec<String>>()
            .join(" ");
        return Ok(format!(
            "<{}>1 {} - {} - {} [{} {}]",
            pri,
            syslog_timestamp(event),
            SYSLOG_APP_NAME,
            syslog_msgid(event),
            SYSLOG_SD_ID,
            data
        ));
    }
    if format == "cef" {
        let rt = match audit_export_epoch_ms(event) {
            Some(ms) => ms.to_string(),
            None => "-".to_string(),
        };
        let header = format!(
            "CEF:0|{}|{}|{}|{}|{}|{}",
            CEF_VENDOR,
            CEF_PRODUCT,
            CEF_VERSION,
            cef_header_escape(&field("decision")),
            cef_header_escape(&field("action")),
            if alerting {
                CEF_SEVERITY_ALERT
            } else {
                CEF_SEVERITY_INFO
            }
        );
        let extension = format!(
            "rt={} suser={} act={} outcome={} externalId={} reason={} cs1Label=targets cs1={}",
            cef_value_escape(&rt),
            cef_value_escape(&field("client")),
            cef_value_escape(&field("action")),
            cef_value_escape(&field("decision")),
            cef_value_escape(&field("requestId")),
            cef_value_escape(&field("reason")),
            cef_value_escape(&field("targets"))
        );
        return Ok(format!("{}|{}", header, extension));
    }
    Err(format!("unknown auditExport format {}", format))
}

/// Ok(config) or Err(reason). Fail closed: anything present but malformed
/// returns an error and disables export rather than falling back to a looser
/// sink.
fn normalize_audit_export(config: Option<&Value>) -> Result<Option<AuditExportConfig>, String> {
    let config = match config {
        None | Some(Value::Null) => return Ok(None),
        Some(v) => v,
    };
    if !config.is_object() {
        return Err("auditExport must be an object".to_string());
    }
    let format = config.get("format");
    let destination = config.get("destination");
    let absent = |v: Option<&Value>| matches!(v, None | Some(Value::Null));
    if absent(format) && absent(destination) {
        return Ok(None);
    }
    let format = match format.and_then(|v| v.as_str()) {
        Some(f) if AUDIT_EXPORT_FORMATS.contains(&f) => f.to_string(),
        _ => {
            return Err(format!(
                "auditExport.format must be one of {}",
                AUDIT_EXPORT_FORMATS.join(", ")
            ))
        }
    };
    let destination = match destination.and_then(|v| v.as_str()).map(|s| s.trim()) {
        Some(d) if !d.is_empty() => d.to_string(),
        _ => return Err("auditExport.destination must be a non-empty string".to_string()),
    };
    let rotate_bytes = match config.get("rotateBytes") {
        None | Some(Value::Null) => None,
        Some(Value::Number(n)) if n.as_u64().is_some_and(|v| v > 0) => n.as_u64(),
        _ => return Err("auditExport.rotateBytes must be a positive integer".to_string()),
    };
    let retain_days = match config.get("retainDays") {
        None | Some(Value::Null) => None,
        Some(Value::Number(n)) if n.as_f64().is_some_and(|v| v > 0.0) => n.as_f64(),
        _ => return Err("auditExport.retainDays must be a positive number".to_string()),
    };
    let key = format!("{}|{}", format, destination);
    Ok(Some(AuditExportConfig {
        format,
        destination,
        rotate_bytes,
        retain_days,
        key,
    }))
}

/// Resolve the merged auditExport for the base layer and every named client at
/// policy load time. Sinks already disabled stay disabled: a reload must not
/// silently re-arm a destination that already failed this process.
fn prime_audit_export(policy: &Value, host_dir: &Path, logger: &Arc<Logger>) {
    let mut names: Vec<String> = vec![POLICY_BASE_LAYER.to_string()];
    if let Some(Value::Object(clients)) = policy.get("clients") {
        names.extend(clients.keys().cloned());
    }
    let mut layers: HashMap<String, Option<AuditExportConfig>> = HashMap::new();
    let mut errors: Vec<(String, String)> = Vec::new();
    for name in names {
        let cp = policy_for_client(policy, &name);
        match normalize_audit_export(cp.get("auditExport")) {
            Ok(config) => {
                layers.insert(name, config);
            }
            Err(reason) => {
                layers.insert(name.clone(), None);
                errors.push((name, reason));
            }
        }
    }
    if let Ok(mut guard) = AUDIT_EXPORT_STATE.lock() {
        let state = guard.get_or_insert_with(AuditExportState::default);
        state.layers = layers;
    }
    for (name, reason) in errors {
        let label = if name == POLICY_BASE_LAYER {
            "default"
        } else {
            name.as_str()
        };
        let key = format!("config|{}", label);
        match AUDIT_EXPORT_STATE.lock() {
            Ok(mut guard) => {
                let state = guard.get_or_insert_with(AuditExportState::default);
                if !state.disabled.insert(key) {
                    continue;
                }
            }
            Err(_) => continue,
        }
        log_error(
            logger,
            &format!(
                "Disabling auditExport for policy layer {}: {}",
                label, reason
            ),
        );
        let client = if name == POLICY_BASE_LAYER {
            Value::Null
        } else {
            json!(label)
        };
        write_audit_event(
            host_dir,
            logger,
            &json!({
                "ts": now_ms() as u64,
                "client": client,
                "action": "auditExport",
                "targets": [label],
                "decision": "audit_export_unavailable",
                "reason": reason,
                "requestId": Value::Null,
            }),
        );
    }
}

/// The sink for the client this event is attributed to, falling back to the
/// base layer for host-level events that name no client.
fn audit_export_sink(client: Option<&str>) -> Option<AuditExportConfig> {
    let guard = AUDIT_EXPORT_STATE.lock().ok()?;
    let state = guard.as_ref()?;
    if let Some(name) = client {
        if let Some(entry) = state.layers.get(name) {
            return entry.clone();
        }
    }
    state.layers.get(POLICY_BASE_LAYER).cloned().flatten()
}

fn audit_export_disabled(key: &str) -> bool {
    match AUDIT_EXPORT_STATE.lock() {
        Ok(guard) => guard.as_ref().is_some_and(|s| s.disabled.contains(key)),
        Err(_) => true,
    }
}

/// Single-generation rotation, no compression. retainDays prunes an existing
/// <destination>.1 older than the window before the new one replaces it, so a
/// rotated generation never outlives the retention window.
fn audit_export_rotate(config: &AuditExportConfig, pending: u64) -> io::Result<()> {
    let rotate = match config.rotate_bytes {
        Some(r) => r,
        None => return Ok(()),
    };
    let path = PathBuf::from(&config.destination);
    let size = match std::fs::metadata(&path) {
        Ok(m) => m.len(),
        Err(_) => return Ok(()),
    };
    if size + pending <= rotate {
        return Ok(());
    }
    let rotated = PathBuf::from(format!("{}.1", config.destination));
    if let Some(days) = config.retain_days {
        if let Some(mtime) = file_mtime(&rotated) {
            if let Ok(age) = SystemTime::now().duration_since(mtime) {
                if age.as_secs_f64() > days * 86400.0 {
                    let _ = std::fs::remove_file(&rotated);
                }
            }
        }
    }
    std::fs::rename(&path, &rotated)
}

fn audit_export_syslog(destination: &str, line: &str) -> io::Result<()> {
    let data = line.as_bytes();
    for scheme in ["udp", "tcp"] {
        let prefix = format!("{}://", scheme);
        let rest = match destination.strip_prefix(&prefix) {
            Some(r) => r,
            None => continue,
        };
        let (host, port) = rest.rsplit_once(':').ok_or_else(|| {
            io::Error::other(format!("syslog destination must be {}host:port", prefix))
        })?;
        let host = host.trim_start_matches('[').trim_end_matches(']');
        if host.is_empty() {
            return Err(io::Error::other(format!(
                "syslog destination must be {}host:port",
                prefix
            )));
        }
        let port: u16 = port
            .parse()
            .map_err(|_| io::Error::other("syslog destination port must be a number"))?;
        let target = std::net::ToSocketAddrs::to_socket_addrs(&(host, port))?
            .next()
            .ok_or_else(|| io::Error::other("syslog destination did not resolve"))?;
        if scheme == "udp" {
            let bind: std::net::SocketAddr = if target.is_ipv4() {
                ([0u8, 0, 0, 0], 0).into()
            } else {
                (std::net::Ipv6Addr::UNSPECIFIED, 0).into()
            };
            let sock = std::net::UdpSocket::bind(bind)?;
            sock.set_write_timeout(Some(AUDIT_EXPORT_TIMEOUT))?;
            sock.send_to(data, target)?;
        } else {
            // RFC 6587 non-transparent framing: one LF-delimited message.
            let mut stream = TcpStream::connect_timeout(&target, AUDIT_EXPORT_TIMEOUT)?;
            stream.set_write_timeout(Some(AUDIT_EXPORT_TIMEOUT))?;
            stream.write_all(data)?;
            stream.write_all(b"\n")?;
        }
        return Ok(());
    }
    audit_export_unix_syslog(destination, data)
}

#[cfg(unix)]
fn audit_export_unix_syslog(destination: &str, data: &[u8]) -> io::Result<()> {
    let sock = std::os::unix::net::UnixDatagram::unbound()?;
    sock.set_write_timeout(Some(AUDIT_EXPORT_TIMEOUT))?;
    sock.send_to(data, destination)?;
    Ok(())
}

#[cfg(not(unix))]
fn audit_export_unix_syslog(_destination: &str, _data: &[u8]) -> io::Result<()> {
    Err(io::Error::other(
        "unix socket syslog destinations are unsupported on this platform",
    ))
}

fn audit_export_emit(config: &AuditExportConfig, line: &str) -> io::Result<()> {
    if config.format == "syslog" {
        return audit_export_syslog(&config.destination, line);
    }
    let mut data = line.as_bytes().to_vec();
    data.push(b'\n');
    audit_export_rotate(config, data.len() as u64)?;
    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&config.destination)?;
    file.write_all(&data)
}

/// Hand one already-written, already-masked audit event to the export worker.
/// Runs on the REQUEST thread, so it must never do I/O: the only work here is
/// resolving the sink and a non-blocking send. The resolved config travels WITH
/// the event, so the worker never re-resolves the sink and a policy reload
/// cannot reroute a queued event. The nested `audit_export_unavailable` write
/// re-enters this function from the worker, but the sink is already marked
/// disabled by then, so it returns at the disabled check and nothing recurses.
fn queue_audit_export(host_dir: &Path, logger: &Arc<Logger>, event: Value) {
    let config = match audit_export_sink(event.get("client").and_then(|v| v.as_str())) {
        Some(c) => c,
        None => return,
    };
    if audit_export_disabled(&config.key) {
        return;
    }
    let mut guard = match AUDIT_EXPORT_SENDER.lock() {
        Ok(g) => g,
        Err(_) => return,
    };
    if guard.is_none() {
        // One worker draining one FIFO channel: sink order equals local append
        // order.
        let (tx, rx) = std::sync::mpsc::sync_channel::<QueuedAuditExport>(AUDIT_EXPORT_QUEUE_MAX);
        let worker_logger = Arc::clone(logger);
        let worker_dir = host_dir.to_path_buf();
        std::thread::spawn(move || {
            for (queued, queued_config) in rx {
                forward_audit_export(&worker_dir, &worker_logger, &queued, &queued_config);
            }
        });
        *guard = Some(tx);
    }
    if let Some(tx) = guard.as_ref() {
        if tx.try_send((event, config)).is_err()
            && AUDIT_EXPORT_DROPPED.fetch_add(1, std::sync::atomic::Ordering::Relaxed) == 0
        {
            log_error(
                logger,
                &format!(
                    "auditExport queue full ({} events); dropping the newest events \
                     (further drops silent). The local audit log still holds every event.",
                    AUDIT_EXPORT_QUEUE_MAX
                ),
            );
        }
    }
}

/// Mirror one already-written, already-masked audit event to the sink that was
/// in force when the event was produced. `config` is the snapshot the request
/// thread enqueued, never a freshly resolved sink: an event is delivered to the
/// destination that authorized it, or not at all. Runs on the export worker
/// thread, only AFTER the local append succeeded, so every blocking step below
/// is off the request path.
fn forward_audit_export(
    host_dir: &Path,
    logger: &Arc<Logger>,
    event: &Value,
    config: &AuditExportConfig,
) {
    if audit_export_disabled(&config.key) {
        return;
    }
    let mut failure: Option<String> = None;
    match format_audit_export_line(&config.format, event) {
        Err(reason) => failure = Some(reason),
        Ok(line) => match AUDIT_EXPORT_LOCK.lock() {
            Ok(_guard) => {
                if audit_export_disabled(&config.key) {
                    return;
                }
                if let Err(e) = audit_export_emit(config, &line) {
                    failure = Some(e.to_string());
                }
            }
            Err(e) => failure = Some(format!("audit export lock poisoned: {}", e)),
        },
    }
    let reason = match failure {
        Some(r) => r,
        None => return,
    };
    match AUDIT_EXPORT_STATE.lock() {
        Ok(mut guard) => {
            let state = guard.get_or_insert_with(AuditExportState::default);
            if !state.disabled.insert(config.key.clone()) {
                return;
            }
        }
        Err(_) => return,
    }
    log_error(
        logger,
        &format!(
            "Disabling auditExport sink {} -> {}: {}",
            config.format, config.destination, reason
        ),
    );
    // The sink is already marked dead, so this event's own forward is a no-op:
    // exactly one audit_export_unavailable per sink, never a recursion.
    write_audit_event(
        host_dir,
        logger,
        &json!({
            "ts": now_ms() as u64,
            "client": event.get("client").cloned().unwrap_or(Value::Null),
            "action": "auditExport",
            "targets": [config.destination.clone()],
            "decision": "audit_export_unavailable",
            "reason": reason,
            "requestId": Value::Null,
        }),
    );
}

// --- Session trace artifacts (policy `traceDir`) ---------------------------
//
// Mirrors bridge.py: when a policy layer sets `traceDir`, exactly one JSONL
// event per trace-eligible request is appended to <traceDir>/<traceId>.jsonl
// after the request is fully processed (success, host denial, extension error,
// timeout). The artifact is metadata only -- decision, timing, tab ids, and
// content hashes -- never a payload body, a response body, or a token.

const TRACE_SESSION_ACTIONS: [&str; 4] = [
    "createTaskSession",
    "navigateTaskSession",
    "navigateAndSnapshot",
    "closeTaskSession",
];
/// Response keys whose array values are an observe snapshot (or its diff).
const TRACE_SNAPSHOT_KEYS: [&str; 4] = ["nodes", "snapshot", "diff", "observe"];
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
    let raw = cp
        .get("traceDir")
        .and_then(|v| v.as_str())?
        .trim()
        .to_string();
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
    if action == "replayWorkflow" {
        for (_, step) in workflow_step_payloads(payload) {
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
    for source in [response.get("result"), Some(response)]
        .into_iter()
        .flatten()
    {
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
        Err(e) => Err(io::Error::other(format!(
            "trace write lock poisoned: {}",
            e
        ))),
    };
    if let Err(e) = result {
        log_error(
            logger,
            &format!("Could not write trace event to {}: {}", path.display(), e),
        );
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
    let dir = trace_dir_for(policy, client, host_dir);
    // The session trace id is also the span's `bridge.trace_id`, so it is
    // resolved when either sink is active.
    let trace_id = if dir.is_some() || OTEL_CONFIG.enabled {
        trace_id_for(action, payload, response)
    } else {
        None
    };
    let otel = otel_finish_request(
        logger,
        client,
        action,
        payload,
        response,
        decision,
        request_id,
        trace_id.as_deref(),
    );
    let (dir, trace_id) = match (dir, trace_id) {
        (Some(d), Some(t)) => (d, t),
        _ => return,
    };
    let secrets = known_secret_masks();
    let safe_response = mask_secrets_value(response.clone(), &secrets);
    let snapshot = trace_snapshot_subobject(&safe_response);
    let mut event = json!({
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
    if let (Some((otel_trace_id, otel_span_id)), Value::Object(map)) = (otel, &mut event) {
        map.insert("otelTraceId".to_string(), Value::String(otel_trace_id));
        map.insert("otelSpanId".to_string(), Value::String(otel_span_id));
    }
    write_trace_event(&dir, &trace_id, logger, &event);
}

// --- OpenTelemetry spans (opt-in, process-level configuration) --------------
//
// Mirrors bridge.py: the same env vars, the same span names, the same attribute
// keys, and the same OTLP/HTTP JSON document. Off by default and inert -- with
// BRIDGE_OTEL_ENABLED unset nothing here allocates, opens a file, or creates a
// socket. This is process-level configuration, NOT policy: a policy layer
// cannot switch tracing on for one client, and tracing can never change a
// policy decision.
//
// A span carries the action, client, host decision, effective action tier,
// duration, tab-id count, success, request id, and session trace id. It never
// carries a payload, a response body, page content, cookies, storage values,
// tokens, credential values, selectors, or URLs, and every string attribute is
// masked with the same secretMaskFile values the audit log uses.
//
// Transport scope: this host builds the identical OTLP/HTTP JSON document but
// posts it with a minimal std::net HTTP/1.1 writer, so only a cleartext
// http:// endpoint is supported. An https:// endpoint is refused with one log
// line rather than linking a TLS stack into the host; the local file sink
// (BRIDGE_OTEL_FILE) works identically for both hosts.

struct OtelConfig {
    enabled: bool,
    endpoint: String,
    file: String,
    service_name: String,
}

fn otel_env(name: &str) -> String {
    std::env::var(name).unwrap_or_default().trim().to_string()
}

/// Read once at first use. Configuration is fixed for the process lifetime, so
/// a request never re-reads the environment.
static OTEL_CONFIG: std::sync::LazyLock<OtelConfig> = std::sync::LazyLock::new(|| {
    let service_name = otel_env("BRIDGE_OTEL_SERVICE_NAME");
    OtelConfig {
        enabled: matches!(
            otel_env("BRIDGE_OTEL_ENABLED").to_lowercase().as_str(),
            "1" | "true" | "yes" | "on"
        ),
        endpoint: otel_env("BRIDGE_OTEL_ENDPOINT"),
        file: otel_env("BRIDGE_OTEL_FILE"),
        service_name: if service_name.is_empty() {
            "chrome-bridge".to_string()
        } else {
            service_name
        },
    }
});

/// OTLP enum values, inlined so no SDK is needed to emit a valid document.
const OTEL_KIND_INTERNAL: i64 = 1;
const OTEL_KIND_SERVER: i64 = 2;
const OTEL_STATUS_OK: i64 = 1;
const OTEL_STATUS_ERROR: i64 = 2;
const OTEL_EXPORT_TIMEOUT: Duration = Duration::from_secs(2);
const OTEL_EXPORT_QUEUE_MAX: usize = 256;

struct OtelRequest {
    trace_id: String,
    span_id: String,
    parent_span_id: Option<String>,
    start_ns: u128,
    children: Vec<(&'static str, u128, u128)>,
}

// One connection is served by one thread, so a thread local scopes the request
// span without threading a context object through the request pipeline.
thread_local! {
    static OTEL_REQUEST: std::cell::RefCell<Option<OtelRequest>> =
        std::cell::RefCell::new(None);
}

static OTEL_FILE_LOCK: Mutex<()> = Mutex::new(());
static OTEL_EXPORT_DISABLED: std::sync::atomic::AtomicBool =
    std::sync::atomic::AtomicBool::new(false);
static OTEL_SENDER: Mutex<Option<std::sync::mpsc::SyncSender<String>>> = Mutex::new(None);

fn otel_now_ns() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0)
}

fn otel_id(hex_len: usize) -> String {
    let mut out = uuid::Uuid::new_v4().to_string().replace('-', "");
    out.truncate(hex_len);
    out
}

/// (trace_id, parent_span_id) from a W3C traceparent, or None when absent or
/// malformed. An unparsable value starts a fresh trace rather than failing the
/// request. Mirrors bridge.py::parse_traceparent.
fn parse_traceparent(value: Option<&str>) -> Option<(String, String)> {
    let raw = value?.trim().to_lowercase();
    let parts: Vec<&str> = raw.split('-').collect();
    if parts.len() != 4 {
        return None;
    }
    let hex = |s: &str, n: usize| s.len() == n && s.chars().all(|c| c.is_ascii_hexdigit());
    if !hex(parts[0], 2) || !hex(parts[1], 32) || !hex(parts[2], 16) || !hex(parts[3], 2) {
        return None;
    }
    if parts[0] == "ff" || parts[1].chars().all(|c| c == '0') || parts[2].chars().all(|c| c == '0')
    {
        return None;
    }
    Some((parts[1].to_string(), parts[2].to_string()))
}

/// Open the request span for this thread, continuing the caller's trace when it
/// sent a traceparent and starting a new root trace otherwise.
fn otel_begin_request(traceparent: Option<&str>) {
    if !OTEL_CONFIG.enabled {
        return;
    }
    let (trace_id, parent_span_id) = match parse_traceparent(traceparent) {
        Some((trace_id, parent)) => (trace_id, Some(parent)),
        None => (otel_id(32), None),
    };
    let request = OtelRequest {
        trace_id,
        span_id: otel_id(16),
        parent_span_id,
        start_ns: otel_now_ns(),
        children: Vec::new(),
    };
    OTEL_REQUEST.with(|slot| *slot.borrow_mut() = Some(request));
}

/// Start time for a child span, or 0 when telemetry is off so the disabled path
/// is a single flag read and the recorder below does nothing.
fn otel_child_start() -> u128 {
    if OTEL_CONFIG.enabled {
        otel_now_ns()
    } else {
        0
    }
}

fn otel_child_end(name: &'static str, start_ns: u128) {
    if start_ns == 0 {
        return;
    }
    let end_ns = otel_now_ns();
    OTEL_REQUEST.with(|slot| {
        if let Some(ctx) = slot.borrow_mut().as_mut() {
            ctx.children.push((name, start_ns, end_ns));
        }
    });
}

fn otel_attr(key: &str, value: Value) -> Value {
    let wrapped = match &value {
        Value::Bool(b) => json!({"boolValue": b}),
        Value::Number(n) if n.is_f64() => json!({"doubleValue": n}),
        Value::Number(n) => json!({"intValue": n.to_string()}),
        Value::String(s) => json!({"stringValue": s}),
        other => json!({"stringValue": other.to_string()}),
    };
    json!({"key": key, "value": wrapped})
}

/// Drop absent attributes and mask every string before it leaves the host.
fn otel_attrs(pairs: Vec<(&str, Option<Value>)>, secrets: &[(String, String)]) -> Value {
    let mut out: Vec<Value> = Vec::with_capacity(pairs.len());
    for (key, value) in pairs {
        let value = match value {
            Some(Value::String(s)) => Value::String(mask_secret_text(&s, secrets)),
            Some(other) => other,
            None => continue,
        };
        out.push(otel_attr(key, value));
    }
    Value::Array(out)
}

/// Close the request span, emit it with its children, and return
/// (traceId, spanId) so the session trace artifact can name the same span.
/// Returns None when telemetry is off, which keeps the artifact and the
/// response byte-identical to an untraced host.
#[allow(clippy::too_many_arguments)]
fn otel_finish_request(
    logger: &Arc<Logger>,
    client: &str,
    action: &str,
    payload: Option<&Value>,
    response: &Value,
    decision: &str,
    request_id: Option<&str>,
    session_trace_id: Option<&str>,
) -> Option<(String, String)> {
    if !OTEL_CONFIG.enabled {
        return None;
    }
    let ctx = OTEL_REQUEST.with(|slot| slot.borrow_mut().take())?;
    let end_ns = otel_now_ns();
    let secrets = known_secret_masks();
    let success = response
        .get("success")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    let targets = trace_targets(action, payload, response);
    // OpenTelemetry GenAI tool-execution convention for the span name and the
    // gen_ai.* attributes; everything host-specific lives under bridge.*.
    let span_name = if action.is_empty() {
        "execute_tool".to_string()
    } else {
        format!("execute_tool {}", action)
    };
    let status_code = if success {
        OTEL_STATUS_OK
    } else {
        OTEL_STATUS_ERROR
    };
    let mut span = json!({
        "traceId": &ctx.trace_id,
        "spanId": &ctx.span_id,
        "name": span_name,
        "kind": OTEL_KIND_SERVER,
        "startTimeUnixNano": ctx.start_ns.to_string(),
        "endTimeUnixNano": end_ns.to_string(),
        "attributes": otel_attrs(vec![
            ("gen_ai.tool.name", Some(json!(action))),
            ("gen_ai.tool.type", Some(json!("extension"))),
            ("bridge.action", Some(json!(action))),
            ("bridge.client", Some(json!(client))),
            ("bridge.decision", Some(json!(decision))),
            ("bridge.effective_tier", Some(json!(effective_action_tier(action, payload)))),
            ("bridge.duration_ms",
             Some(json!((end_ns.saturating_sub(ctx.start_ns) / 1_000_000) as u64))),
            ("bridge.tab_id_count", Some(json!(targets.len() as u64))),
            ("bridge.success", Some(json!(success))),
            ("bridge.request_id", request_id.map(|v| json!(v))),
            ("bridge.trace_id", session_trace_id.map(|v| json!(v))),
            ("bridge.host", Some(json!("rust"))),
        ], &secrets),
        "status": {"code": status_code},
    });
    if let (Some(parent), Value::Object(map)) = (ctx.parent_span_id.as_ref(), &mut span) {
        map.insert("parentSpanId".to_string(), json!(parent));
    }
    let mut spans = vec![span];
    for (name, start_ns, child_end_ns) in &ctx.children {
        spans.push(json!({
            "traceId": &ctx.trace_id,
            "spanId": otel_id(16),
            "parentSpanId": &ctx.span_id,
            "name": name,
            "kind": OTEL_KIND_INTERNAL,
            "startTimeUnixNano": start_ns.to_string(),
            "endTimeUnixNano": child_end_ns.to_string(),
            "attributes": otel_attrs(vec![
                ("bridge.action", Some(json!(action))),
                ("bridge.duration_ms",
                 Some(json!((child_end_ns.saturating_sub(*start_ns) / 1_000_000) as u64))),
            ], &secrets),
            "status": {"code": OTEL_STATUS_OK},
        }));
    }
    otel_export(logger, spans);
    Some((ctx.trace_id, ctx.span_id))
}

/// Best effort, exactly like an audit-log write failure: one log line, then the
/// request continues. A broken sink is disabled for the rest of the process so
/// it cannot cost every later request a retry.
fn otel_export(logger: &Arc<Logger>, spans: Vec<Value>) {
    let cfg = &*OTEL_CONFIG;
    if spans.is_empty() || OTEL_EXPORT_DISABLED.load(std::sync::atomic::Ordering::Relaxed) {
        return;
    }
    let document = json!({"resourceSpans": [{
        "resource": {"attributes": [
            otel_attr("service.name", json!(cfg.service_name)),
            otel_attr("telemetry.sdk.name", json!("chrome-bridge")),
            otel_attr("telemetry.sdk.language", json!("rust")),
        ]},
        "scopeSpans": [{"scope": {"name": "chrome-bridge.host"}, "spans": spans}]
    }]});
    let encoded = match serde_json::to_string(&document) {
        Ok(s) => s,
        Err(_) => return,
    };
    if !cfg.file.is_empty() {
        let result = match OTEL_FILE_LOCK.lock() {
            Ok(_guard) => OpenOptions::new()
                .create(true)
                .append(true)
                .open(&cfg.file)
                .and_then(|mut f| writeln!(f, "{}", encoded)),
            Err(e) => Err(io::Error::other(format!("otel file lock poisoned: {}", e))),
        };
        if let Err(e) = result {
            OTEL_EXPORT_DISABLED.store(true, std::sync::atomic::Ordering::Relaxed);
            log_error(
                logger,
                &format!("OpenTelemetry export disabled after failure: {}", e),
            );
            return;
        }
    }
    if !cfg.endpoint.is_empty() {
        otel_enqueue(logger, encoded);
    }
}

/// The OTLP POST runs on a background thread, so a slow or dead collector can
/// never add latency to a browser request. A full queue drops the document.
fn otel_enqueue(logger: &Arc<Logger>, encoded: String) {
    let mut guard = match OTEL_SENDER.lock() {
        Ok(g) => g,
        Err(_) => return,
    };
    if guard.is_none() {
        let (tx, rx) = std::sync::mpsc::sync_channel::<String>(OTEL_EXPORT_QUEUE_MAX);
        let worker_logger = Arc::clone(logger);
        std::thread::spawn(move || {
            let mut logged = false;
            for document in rx {
                if let Err(e) = otel_post(&document) {
                    if !logged {
                        logged = true;
                        log_error(
                            &worker_logger,
                            &format!(
                                "OpenTelemetry OTLP export failed (further failures silent): {}",
                                e
                            ),
                        );
                    }
                }
            }
        });
        *guard = Some(tx);
    }
    if let Some(tx) = guard.as_ref() {
        let _ = tx.try_send(encoded);
    }
}

/// Minimal OTLP/HTTP POST over std::net. Cleartext http:// only; see the scope
/// note above.
fn otel_post(encoded: &str) -> io::Result<()> {
    let cfg = &*OTEL_CONFIG;
    let mut url = cfg.endpoint.clone();
    if !url.contains("/v1/traces") {
        url = format!("{}/v1/traces", url.trim_end_matches('/'));
    }
    let parsed = url::Url::parse(&url)
        .map_err(|e| io::Error::other(format!("invalid BRIDGE_OTEL_ENDPOINT: {}", e)))?;
    if parsed.scheme() != "http" {
        return Err(io::Error::other(format!(
            "the Rust host posts OTLP over cleartext http only, not {}; \
             use BRIDGE_OTEL_FILE or a local http collector",
            parsed.scheme()
        )));
    }
    let host = parsed
        .host_str()
        .ok_or_else(|| io::Error::other("BRIDGE_OTEL_ENDPOINT has no host"))?
        .to_string();
    let port = parsed.port().unwrap_or(80);
    let mut path = parsed.path().to_string();
    if let Some(query) = parsed.query() {
        path.push('?');
        path.push_str(query);
    }
    let mut stream = TcpStream::connect((host.as_str(), port))?;
    stream.set_write_timeout(Some(OTEL_EXPORT_TIMEOUT))?;
    stream.set_read_timeout(Some(OTEL_EXPORT_TIMEOUT))?;
    let head = format!(
        "POST {} HTTP/1.1\r\nHost: {}:{}\r\nContent-Type: application/json\r\n\
         Content-Length: {}\r\nConnection: close\r\n\r\n",
        path,
        host,
        port,
        encoded.len()
    );
    stream.write_all(head.as_bytes())?;
    stream.write_all(encoded.as_bytes())?;
    stream.flush()?;
    // Drain the status line so the collector sees a well-behaved client; the
    // body is never inspected.
    let mut buf = [0u8; 512];
    let _ = stream.read(&mut buf);
    Ok(())
}

const REDACT_KEY_SUBSTRINGS: [&str; 7] = [
    "token", "secret", "password", "cookie", "session", "csrf", "auth",
];

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
        Value::Array(arr) => Value::Array(
            arr.into_iter()
                .map(|v| redact_content_value(v, compiled))
                .collect(),
        ),
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
            let step_payload = steps.get(i).and_then(|s| s.get("payload"));
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
            | "observe"
            | "getCurrentState"
            | "navigateAndSnapshot"
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
                let _ = write_line(
                    &mut stream,
                    &json!({"success": false, "error": "unauthorized"}),
                );
                return;
            }
        };

        // Never forward secrets, host-only confirmation fields, the
        // request-level dry-run flag, or the caller's W3C trace context to the
        // extension.
        let mut dry_run = false;
        let mut traceparent: Option<String> = None;
        let mut confirmation_token = if let Value::Object(map) = &mut cmd {
            map.remove("token");
            dry_run = map
                .remove("dryRun")
                .and_then(|v| v.as_bool())
                .unwrap_or(false);
            traceparent = map
                .remove("traceparent")
                .and_then(|v| v.as_str().map(|s| s.to_string()));
            map.remove("confirmationToken")
                .and_then(|v| v.as_str().map(|s| s.to_string()))
        } else {
            None
        };

        let mut action = cmd
            .get("action")
            .and_then(|a| a.as_str())
            .unwrap_or("")
            .to_string();
        let mut payload = cmd.get("payload").cloned();
        // Start of the traced window: every exit below emits at most one trace
        // event, measured from here.
        let trace_started = now_ms();
        otel_begin_request(traceparent.as_deref());

        // Dry run stops before any state change: no confirmation resume, no
        // lease acquisition, no interactive origin approval, no tab-origin
        // lookup (that is itself an extension round-trip), and no forward. It
        // reports the verdict the request would meet right now. Mirrors
        // bridge.py.
        if dry_run {
            if reserved_action(&action) {
                log_warn(
                    logger,
                    &format!("Rejected reserved action from client: {}", action),
                );
                let policy_value = current_policy(policy, host_dir, logger);
                let cp = policy_for_client(&policy_value, &client_name);
                let audit_enabled = cp.get("audit").and_then(|v| v.as_bool()).unwrap_or(true);
                audit(
                    host_dir,
                    logger,
                    audit_enabled,
                    &client_name,
                    &action,
                    &[],
                    "deny",
                    Some("unknown action"),
                    None,
                );
                let resp =
                    json!({"success": false, "error": format!("unknown action: {}", action)});
                trace_request(
                    host_dir,
                    logger,
                    &policy_value,
                    &client_name,
                    &action,
                    payload.as_ref(),
                    &resp,
                    "deny",
                    Some("unknown action"),
                    None,
                    trace_started,
                );
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
            // A handoff nested in a composite is refused outright, so the dry
            // run must report the same verdict the real request meets.
            if let Some(reason) = composite_handoff_reason(&action, payload.as_ref()) {
                verdict["allowed"] = Value::Bool(false);
                verdict["reason"] = Value::String(reason);
            }
            // Host-answered actions resolve without Chrome, so they would never
            // forward even when fully allowed.
            let host_side = matches!(
                action.as_str(),
                "lease" | "release" | "leaseStatus" | "policyCheck" | "policyInfo" | "confirm"
            );
            let would_forward = verdict
                .get("allowed")
                .and_then(|v| v.as_bool())
                .unwrap_or(false)
                && !verdict
                    .get("confirmationRequired")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(false)
                && !host_side;
            let audit_enabled = verdict
                .get("audit")
                .and_then(|v| v.as_bool())
                .unwrap_or(true);
            let reason = verdict
                .get("reason")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string());
            audit(
                host_dir,
                logger,
                audit_enabled,
                &client_name,
                &action,
                &targets,
                "dry_run",
                reason.as_deref(),
                None,
            );
            let resp = json!({
                "success": true,
                "dryRun": true,
                "wouldForward": would_forward,
                "action": action,
                "targets": targets,
                "verdict": verdict,
            });
            trace_request(
                host_dir,
                logger,
                &policy_value,
                &client_name,
                &action,
                payload.as_ref(),
                &resp,
                "dry_run",
                reason.as_deref(),
                None,
                trace_started,
            );
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
                    audit(
                        host_dir,
                        logger,
                        audit_enabled,
                        &requester_name,
                        "confirm",
                        &[],
                        "confirmation_resume",
                        None,
                        None,
                    );
                }
                None => {
                    let policy_value = current_policy(policy, host_dir, logger);
                    let cp = policy_for_client(&policy_value, &client_name);
                    let audit_enabled = cp.get("audit").and_then(|v| v.as_bool()).unwrap_or(true);
                    audit(
                        host_dir,
                        logger,
                        audit_enabled,
                        &client_name,
                        "confirm",
                        &[],
                        "confirmation_deny",
                        Some("invalid or expired confirmation token"),
                        None,
                    );
                    let resp = json!({
                        "success": false,
                        "error": "invalid or expired confirmation token"
                    });
                    trace_request(
                        host_dir,
                        logger,
                        &policy_value,
                        &client_name,
                        &action,
                        payload.as_ref(),
                        &resp,
                        "confirmation_deny",
                        Some("invalid or expired confirmation token"),
                        None,
                        trace_started,
                    );
                    let _ = write_line(&mut stream, &resp);
                    continue;
                }
            }
        }

        // Reserved host-internal actions (e.g. __tabOrigin) are never reachable
        // from socket clients; reject as unknown so the internal surface cannot
        // be driven or probed externally.
        if reserved_action(&action) {
            log_warn(
                logger,
                &format!("Rejected reserved action from client: {}", action),
            );
            let policy_value = current_policy(policy, host_dir, logger);
            let cp = policy_for_client(&policy_value, &client_name);
            let audit_enabled = cp.get("audit").and_then(|v| v.as_bool()).unwrap_or(true);
            audit(
                host_dir,
                logger,
                audit_enabled,
                &client_name,
                &action,
                &[],
                "deny",
                Some("unknown action"),
                None,
            );
            let resp = json!({"success": false, "error": format!("unknown action: {}", action)});
            trace_request(
                host_dir,
                logger,
                &policy_value,
                &client_name,
                &action,
                payload.as_ref(),
                &resp,
                "deny",
                Some("unknown action"),
                None,
                trace_started,
            );
            let _ = write_line(&mut stream, &resp);
            continue;
        }

        // Lease verbs are answered host-side with no extension round-trip.
        if let Some(resp) = handle_lease_action(&action, payload.as_ref(), &client_name, lease) {
            let policy_value = current_policy(policy, host_dir, logger);
            let cp = policy_for_client(&policy_value, &client_name);
            let audit_enabled = cp.get("audit").and_then(|v| v.as_bool()).unwrap_or(true);
            let success = resp
                .get("success")
                .and_then(|v| v.as_bool())
                .unwrap_or(false);
            let decision = if success { "lease_allow" } else { "lease_deny" };
            let reason = resp.get("error").and_then(|v| v.as_str());
            audit(
                host_dir,
                logger,
                audit_enabled,
                &client_name,
                &action,
                &[],
                decision,
                reason,
                None,
            );
            trace_request(
                host_dir,
                logger,
                &policy_value,
                &client_name,
                &action,
                payload.as_ref(),
                &resp,
                decision,
                reason,
                None,
                trace_started,
            );
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
                    audit(
                        host_dir,
                        logger,
                        audit_enabled,
                        &client_name,
                        "policyCheck",
                        &[],
                        "deny",
                        Some(&reason),
                        None,
                    );
                    let resp = json!({"success": false, "error": reason});
                    trace_request(
                        host_dir,
                        logger,
                        &policy_value,
                        &client_name,
                        &action,
                        Some(&pc),
                        &resp,
                        "deny",
                        Some(&reason),
                        None,
                        trace_started,
                    );
                    let _ = write_line(&mut stream, &resp);
                    continue;
                }
                let steps = plan_step_verdicts(&policy_value, &client_name, plan);
                audit(
                    host_dir,
                    logger,
                    audit_enabled,
                    &client_name,
                    "policyCheck",
                    &[],
                    "allow",
                    None,
                    None,
                );
                let resp = json!({"success": true, "result": {"plan": steps}});
                trace_request(
                    host_dir,
                    logger,
                    &policy_value,
                    &client_name,
                    &action,
                    Some(&pc),
                    &resp,
                    "allow",
                    None,
                    None,
                    trace_started,
                );
                if write_line(&mut stream, &resp).is_err() {
                    return;
                }
                continue;
            }
            let target_action = pc.get("action").and_then(|a| a.as_str()).unwrap_or("");
            let target_payload = pc.get("payload");
            let no_origins = std::collections::BTreeMap::new();
            let (allowed, reason, confirm, redact_enabled, audit_enabled, targets) =
                evaluate_policy(
                    &policy_value,
                    &client_name,
                    target_action,
                    target_payload,
                    &no_origins,
                );
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
                "effectiveTier": effective_action_tier(target_action, target_payload),
                "dlp": resolve_dlp_mode(
                    &policy_for_client(&policy_value, &client_name),
                    dlp_channel_for_action(target_action)),
            }});
            audit(
                host_dir,
                logger,
                audit_enabled,
                &client_name,
                "policyCheck",
                &targets,
                "allow",
                None,
                None,
            );
            trace_request(
                host_dir,
                logger,
                &policy_value,
                &client_name,
                &action,
                Some(&pc),
                &resp,
                "allow",
                None,
                None,
                trace_started,
            );
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
                "policyBundle": policy_bundle_info(),
                "traceDir": trace_dir,
                "client": client_name,
            }});
            audit(
                host_dir,
                logger,
                audit_enabled,
                &client_name,
                "policyInfo",
                &[],
                "allow",
                None,
                None,
            );
            trace_request(
                host_dir,
                logger,
                &policy_value,
                &client_name,
                &action,
                payload.as_ref(),
                &resp,
                "allow",
                None,
                None,
                trace_started,
            );
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
            audit(
                host_dir,
                logger,
                audit_enabled,
                &client_name,
                &action,
                &[],
                "handoff_blackout",
                Some(HANDOFF_BLACKOUT_ERROR),
                None,
            );
            let resp = json!({
                "success": false,
                "error": HANDOFF_BLACKOUT_ERROR,
                "blackout": true
            });
            trace_request(
                host_dir,
                logger,
                &policy_value,
                &client_name,
                &action,
                payload.as_ref(),
                &resp,
                "handoff_blackout",
                Some(HANDOFF_BLACKOUT_ERROR),
                None,
                trace_started,
            );
            let _ = write_line(&mut stream, &resp);
            continue;
        }

        // A handoff nested in a composite is refused outright (see
        // composite_handoff_reason): the composite's later steps run inside the
        // extension, so no blackout could cover them. Denied here, before policy
        // evaluation, so nothing is forwarded.
        if let Some(reason) = composite_handoff_reason(&action, payload.as_ref()) {
            let cp = policy_for_client(&policy_value, &client_name);
            let audit_enabled = cp.get("audit").and_then(|v| v.as_bool()).unwrap_or(true);
            audit(
                host_dir,
                logger,
                audit_enabled,
                &client_name,
                &action,
                &[],
                "deny",
                Some(&reason),
                None,
            );
            let resp = json!({
                "success": false,
                "error": format!("policy denied: {}", reason),
                "policyDenial": policy_denial(&reason, &action, &[], &client_name, host_dir, &policy_value, payload.as_ref()),
            });
            trace_request(
                host_dir,
                logger,
                &policy_value,
                &client_name,
                &action,
                payload.as_ref(),
                &resp,
                "deny",
                Some(&reason),
                None,
                trace_started,
            );
            let _ = write_line(&mut stream, &resp);
            continue;
        }

        let empty_origins = std::collections::BTreeMap::new();

        // Phase 1: action-level and payload-target checks needing no extension
        // round-trip. These run before the lease gate, preserving prior
        // precedence (policy denial wins over a lease for payload targets).
        let otel_policy_started = otel_child_start();
        let (allowed, _reason, _confirm, redact_enabled, audit_enabled, targets) = evaluate_policy(
            &policy_value,
            &client_name,
            &action,
            payload.as_ref(),
            &empty_origins,
        );
        otel_child_end("bridge.policy_evaluate", otel_policy_started);
        if !allowed {
            let reason = _reason.unwrap_or_default();
            audit(
                host_dir,
                logger,
                audit_enabled,
                &client_name,
                &action,
                &targets,
                "deny",
                Some(&reason),
                None,
            );
            let resp = json!({"success": false, "error": format!("policy denied: {}", reason), "policyDenial": policy_denial(&reason, &action, &targets, &client_name, host_dir, &policy_value, payload.as_ref())});
            trace_request(
                host_dir,
                logger,
                &policy_value,
                &client_name,
                &action,
                payload.as_ref(),
                &resp,
                "deny",
                Some(&reason),
                None,
                trace_started,
            );
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
                audit(
                    host_dir,
                    logger,
                    audit_enabled,
                    &client_name,
                    &action,
                    &targets,
                    "lease_deny",
                    reason,
                    None,
                );
                trace_request(
                    host_dir,
                    logger,
                    &policy_value,
                    &client_name,
                    &action,
                    payload.as_ref(),
                    &blocked,
                    "lease_deny",
                    reason,
                    None,
                    trace_started,
                );
                if write_line(&mut stream, &blocked).is_err() {
                    return;
                }
                continue;
            }
            let origins = resolve_origins(&needed, pending, stdout, logger, resp_timeout);
            // Fail closed when any needed tab resolves to no usable origin
            // target (lookup failure, no such tab, opaque origin): under an
            // origin-constraining policy such a request must not proceed.
            if needed
                .iter()
                .any(|k| origin_targets(origins.get(k).and_then(|o| o.as_deref())).is_empty())
            {
                let mut t = targets.clone();
                t.push("<unresolved-origin>".to_string());
                audit(
                    host_dir,
                    logger,
                    audit_enabled,
                    &client_name,
                    &action,
                    &t,
                    "deny",
                    Some("tab origin unresolved"),
                    None,
                );
                let resp = json!({"success": false, "error": "policy denied: tab origin unresolved", "policyDenial": policy_denial("tab origin unresolved", &action, &t, &client_name, host_dir, &policy_value, payload.as_ref())});
                trace_request(
                    host_dir,
                    logger,
                    &policy_value,
                    &client_name,
                    &action,
                    payload.as_ref(),
                    &resp,
                    "deny",
                    Some("tab origin unresolved"),
                    None,
                    trace_started,
                );
                let _ = write_line(&mut stream, &resp);
                continue;
            }
            let (allowed, reason, confirm, _, _, targets) = evaluate_policy(
                &policy_value,
                &client_name,
                &action,
                payload.as_ref(),
                &origins,
            );
            if !allowed {
                let reason = reason.unwrap_or_default();
                audit(
                    host_dir,
                    logger,
                    audit_enabled,
                    &client_name,
                    &action,
                    &targets,
                    "deny",
                    Some(&reason),
                    None,
                );
                let resp = json!({"success": false, "error": format!("policy denied: {}", reason), "policyDenial": policy_denial(&reason, &action, &targets, &client_name, host_dir, &policy_value, payload.as_ref())});
                trace_request(
                    host_dir,
                    logger,
                    &policy_value,
                    &client_name,
                    &action,
                    payload.as_ref(),
                    &resp,
                    "deny",
                    Some(&reason),
                    None,
                    trace_started,
                );
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
                audit(
                    host_dir,
                    logger,
                    audit_enabled,
                    &client_name,
                    &action,
                    &targets,
                    "confirmation_waived",
                    Some("siteMode skip"),
                    None,
                );
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
                audit(
                    host_dir,
                    logger,
                    audit_enabled,
                    &client_name,
                    &action,
                    &targets,
                    "confirmation_accepted",
                    None,
                    None,
                );
            } else {
                let (token, expires_at) = issue_confirmation(
                    confirmations,
                    &client_name,
                    &action,
                    &confirm_payload,
                    &targets,
                );
                audit(
                    host_dir,
                    logger,
                    audit_enabled,
                    &client_name,
                    &action,
                    &targets,
                    "confirmation_required",
                    None,
                    None,
                );
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
                trace_request(
                    host_dir,
                    logger,
                    &policy_value,
                    &client_name,
                    &action,
                    payload.as_ref(),
                    &resp,
                    "confirmation_required",
                    None,
                    None,
                    trace_started,
                );
                let _ = write_line(&mut stream, &resp);
                continue;
            }
        }

        // A live lease held by another client blocks every other action.
        if let Some(blocked) = lease_gate(&client_name, lease) {
            let reason = blocked.get("error").and_then(|v| v.as_str());
            audit(
                host_dir,
                logger,
                audit_enabled,
                &client_name,
                &action,
                &targets,
                "lease_deny",
                reason,
                None,
            );
            trace_request(
                host_dir,
                logger,
                &policy_value,
                &client_name,
                &action,
                payload.as_ref(),
                &blocked,
                "lease_deny",
                reason,
                None,
                trace_started,
            );
            if write_line(&mut stream, &blocked).is_err() {
                return;
            }
            continue;
        }

        // Audit "allow" with the generated id before the action is forwarded.
        let client_policy = policy_for_client(&policy_value, &client_name);
        let redact_patterns = client_policy.get("redactPatterns").cloned();
        let secrets = load_secret_masks(client_policy.get("secretMaskFile"), host_dir, logger);

        // DLP: record the permitted channels and stamp the enforcing modes on the
        // envelope. Runs once, here, after every gate and before the forward, so a
        // request that never reaches Chrome never claims an audited transfer and
        // one request writes at most one dlp_audit event. Mirrors bridge.py.
        let dlp_audited = dlp_channels_in_mode(&client_policy, &action, payload.as_ref(), "audit");
        if !dlp_audited.is_empty() {
            // Channel names only: never a file name, a path, or frame data.
            let dlp_channels = dlp_audited.join(",");
            audit(
                host_dir,
                logger,
                audit_enabled,
                &client_name,
                &action,
                &targets,
                DLP_AUDIT_DECISION,
                Some(dlp_channels.as_str()),
                None,
            );
        }
        // The extension refuses a blocked channel independently (see background.js
        // dlpRefusal), so the host always overwrites this field: a client cannot
        // loosen it by supplying its own.
        let dlp_modes = dlp_modes_for_client(&client_policy);
        if let Value::Object(envelope) = &mut cmd {
            if dlp_modes.is_empty() {
                envelope.remove("dlp");
            } else {
                envelope.insert("dlp".to_string(), Value::Object(dlp_modes));
            }
        }
        let (req_id, response) = {
            let h = host_dir;
            let l = logger;
            let ce = client_name.clone();
            let ac = action.clone();
            let tg = targets.clone();
            // A handoff forward (see HANDOFF_ACTIONS) opens a blackout for the whole
            // time the human is interacting with the tab; the guard drops it on
            // every exit path (response, extension error, or timeout).
            let _handoff_guard = HandoffGuard {
                handoffs,
                handle: if HANDOFF_ACTIONS.contains(&action.as_str()) {
                    register_handoff(handoffs, handoff_tab_id(payload.as_ref()), &client_name)
                } else {
                    None
                },
            };
            let otel_forward_started = otel_child_start();
            let forwarded =
                forward_to_extension(cmd, pending, stdout, logger, resp_timeout, |rid| {
                    audit(h, l, audit_enabled, &ce, &ac, &tg, "allow", None, Some(rid));
                });
            otel_child_end("bridge.extension_forward", otel_forward_started);
            forwarded
        };
        match response {
            Some(response) => {
                let success = response
                    .get("success")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(false);
                let ext_decision = if success {
                    "extension_success"
                } else {
                    "extension_error"
                };
                let reason = response.get("error").and_then(|v| v.as_str());
                audit(
                    host_dir,
                    logger,
                    audit_enabled,
                    &client_name,
                    &action,
                    &targets,
                    ext_decision,
                    reason,
                    Some(&req_id),
                );
                let response = redact_response(
                    &action,
                    response,
                    redact_enabled,
                    redact_patterns.as_ref(),
                    payload.as_ref(),
                    &secrets,
                );
                // Trace the response the client actually receives: already
                // redacted and secret-masked, so the hash covers no raw content.
                let reason = response
                    .get("error")
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string());
                trace_request(
                    host_dir,
                    logger,
                    &policy_value,
                    &client_name,
                    &action,
                    payload.as_ref(),
                    &response,
                    ext_decision,
                    reason.as_deref(),
                    Some(&req_id),
                    trace_started,
                );
                if write_line(&mut stream, &response).is_err() {
                    return;
                }
            }
            None => {
                log_error(
                    logger,
                    &format!("Timed out waiting for extension response to {}.", req_id),
                );
                audit(
                    host_dir,
                    logger,
                    audit_enabled,
                    &client_name,
                    &action,
                    &targets,
                    "extension_error",
                    Some("extension response timeout"),
                    Some(&req_id),
                );
                let resp = json!({"success": false, "error": "extension response timeout"});
                trace_request(
                    host_dir,
                    logger,
                    &policy_value,
                    &client_name,
                    &action,
                    payload.as_ref(),
                    &resp,
                    "extension_error",
                    Some("extension response timeout"),
                    Some(&req_id),
                    trace_started,
                );
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
                    handle_socket_client(
                        stream,
                        &host_dir,
                        &tokens,
                        &pending,
                        &lease,
                        &confirmations,
                        &handoffs,
                        &policy,
                        &stdout,
                        &logger,
                    );
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
    let logger = Arc::new(Logger::new(&log_path(&host_dir)).unwrap_or_else(|e| {
        eprintln!("could not open log file: {}", e);
        std::process::exit(1);
    }));

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
            socket_server_loop(
                host_dir,
                tokens,
                pending,
                lease,
                confirmations,
                handoffs,
                policy,
                stdout,
                logger,
            );
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

        let msg_id = msg
            .get("id")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());

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
