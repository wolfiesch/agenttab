use crate::audit::{canonicalize, now_ms, AuditEntry, AuditLog};
use crate::guardrails::{GuardrailLoadError, Guardrails};
use crate::handoff::HandoffState;
use crate::journal::{BeginDecision, Journal, JournalError};
use crate::lifecycle::Lifecycle;
use crate::native::{NativeError, NativeEventSink, NativeTransport};
use crate::paths::AgentTabPaths;
use crate::task::ConnectionContext;
use agenttab_protocol::{
    BrowserCommitParams, BrowserHandoffParams, BrowserWaitParams, ConnectionAck, ConnectionInit,
    MethodParams, NativeEventPayload, NativeStagedCommit, NativeTab, Outcome, RpcError, RpcMethod,
    RpcRequest, RpcResponse, TaskBinding, HOST_TO_CLIENT_MAX_BYTES, PROTOCOL_VERSION,
};
use parking_lot::{Mutex, RwLock};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::sync::{Arc, Weak};
use std::time::{Duration, Instant};
use thiserror::Error;
use uuid::Uuid;
const RESPONSE_TASK_BINDING_RESERVE: usize = 512;

#[derive(Debug, Error)]
pub enum RuntimeBuildError {
    #[error(transparent)]
    Journal(#[from] JournalError),
    #[error(transparent)]
    Guardrails(#[from] GuardrailLoadError),
    #[error("audit log error: {0}")]
    Audit(#[from] std::io::Error),
}

#[derive(Debug)]
struct JournalNativeEventSink {
    journal: Arc<Journal>,
    tab_urls: Arc<RwLock<HashMap<u64, String>>>,
}

impl NativeEventSink for JournalNativeEventSink {
    fn reconcile(
        &self,
        inventory: &[NativeTab],
        staged_commits: &[NativeStagedCommit],
    ) -> Result<(), String> {
        replace_inventory_urls(&self.tab_urls, inventory);
        self.journal
            .reconcile_inventory(&inventory_counts(inventory))
            .and_then(|()| self.journal.reconcile_staged_commits(staged_commits))
            .map_err(|error| error.to_string())
    }

    fn handle(&self, payload: &NativeEventPayload) -> Result<(), String> {
        let result = match payload {
            NativeEventPayload::Inventory(event) => {
                replace_inventory_urls(&self.tab_urls, &event.inventory);
                self.journal
                    .reconcile_inventory(&inventory_counts(&event.inventory))
            }
            NativeEventPayload::TaskTabs(event) => self
                .journal
                .update_task_tab_count(event.task_id, event.tab_count),
            NativeEventPayload::CommitExpired(event) => {
                self.journal.expire_staged_commit(&event.native_token)
            }
            NativeEventPayload::Pause(_)
            | NativeEventPayload::Handoff(_)
            | NativeEventPayload::ExtensionDisconnected(_) => Ok(()),
        };
        result.map_err(|error| error.to_string())
    }
}

fn replace_inventory_urls(tab_urls: &RwLock<HashMap<u64, String>>, inventory: &[NativeTab]) {
    let mut urls = tab_urls.write();
    urls.clear();
    urls.extend(inventory.iter().map(|tab| (tab.tab_id, tab.url.clone())));
}

fn inventory_counts(inventory: &[NativeTab]) -> Vec<(Uuid, u64)> {
    let mut counts = HashMap::new();
    for tab in inventory {
        if let Some(task_id) = tab.task_id {
            *counts.entry(task_id).or_insert(0) += 1;
        }
    }
    counts.into_iter().collect()
}

pub struct Runtime {
    lifecycle: Arc<Lifecycle>,
    journal: Arc<Journal>,
    guardrails: Arc<Guardrails>,
    audit: Arc<AuditLog>,
    native: Arc<dyn NativeTransport>,
    handoff: Arc<HandoffState>,
    task_locks: Mutex<HashMap<String, Weak<Mutex<()>>>>,
    global_gate: RwLock<()>,
    tab_urls: Arc<RwLock<HashMap<u64, String>>>,
}

impl std::fmt::Debug for Runtime {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("Runtime")
            .field("state", &self.lifecycle.state())
            .finish_non_exhaustive()
    }
}

impl Runtime {
    pub fn open(
        paths: &AgentTabPaths,
        lifecycle: Arc<Lifecycle>,
        native: Arc<dyn NativeTransport>,
        handoff: Arc<HandoffState>,
    ) -> Result<Arc<Self>, RuntimeBuildError> {
        paths.prepare()?;
        let journal = Arc::new(Journal::open(&paths.state_db)?);
        let tab_urls = Arc::new(RwLock::new(HashMap::new()));
        native.set_event_sink(Arc::new(JournalNativeEventSink {
            journal: journal.clone(),
            tab_urls: tab_urls.clone(),
        }));
        let guardrails = Arc::new(Guardrails::load(&paths.policy_file)?);
        let audit = Arc::new(AuditLog::open(
            &paths.audit_log,
            guardrails.audit_enabled(),
        )?);
        Ok(Arc::new(Self {
            lifecycle,
            journal,
            guardrails,
            audit,
            native,
            handoff,
            task_locks: Mutex::new(HashMap::new()),
            global_gate: RwLock::new(()),
            tab_urls,
        }))
    }

    #[cfg(test)]
    fn for_test(
        paths: &AgentTabPaths,
        lifecycle: Arc<Lifecycle>,
        native: Arc<dyn NativeTransport>,
        handoff: Arc<HandoffState>,
    ) -> Arc<Self> {
        Self::open(paths, lifecycle, native, handoff).unwrap()
    }

    pub fn connect(
        &self,
        init: ConnectionInit,
    ) -> Result<(Arc<ConnectionContext>, ConnectionAck), JournalError> {
        ConnectionContext::negotiate(init, &self.journal, self.lifecycle.state())
    }

    pub fn handle(&self, connection: &Arc<ConnectionContext>, raw: Value) -> Value {
        let fallback_request_id = raw
            .get("request_id")
            .and_then(Value::as_str)
            .unwrap_or("invalid-request")
            .to_string();
        let (request, params) = match RpcRequest::parse(raw) {
            Ok(parsed) => parsed,
            Err(error) => {
                return RpcResponse::failure(
                    fallback_request_id,
                    Outcome::NotStarted,
                    RpcError::new("invalid_request", error.to_string()),
                )
                .value()
            }
        };

        let params_value = params.value();
        let started_at_ms = now_ms();
        let started = Instant::now();
        if request.method == RpcMethod::AgenttabStatus {
            let response = self.status_response(&request, connection);
            return self.audited_value(
                connection,
                connection.task_id().ok().flatten(),
                &request,
                &params_value,
                response,
                started_at_ms,
                started,
                false,
                false,
            );
        }
        if connection.is_cancelled() {
            let response = cancelled_response(request.request_id.clone());
            return self.audited_value(
                connection,
                connection.task_id().ok().flatten(),
                &request,
                &params_value,
                response,
                started_at_ms,
                started,
                false,
                false,
            );
        }

        let early_error = self
            .lifecycle
            .gate(request.method)
            .err()
            .or_else(|| self.handoff_blackout_error())
            .or_else(|| self.guardrails.authorize(request.method, &params).err())
            .or_else(|| {
                let tab_id = params_value.get("tab_id").and_then(Value::as_u64)?;
                let tab_url = self.tab_urls.read().get(&tab_id).cloned();
                self.guardrails
                    .authorize_current_tab(tab_url.as_deref())
                    .err()
            });
        if let Some(error) = early_error {
            let response =
                RpcResponse::failure(request.request_id.clone(), Outcome::NotStarted, error);
            return self.audited_value(
                connection,
                connection.task_id().ok().flatten(),
                &request,
                &params_value,
                response,
                started_at_ms,
                started,
                false,
                false,
            );
        }

        let task_id = match connection.ensure_task(&self.journal) {
            Ok(task_id) => task_id,
            Err(error) => {
                let response = RpcResponse::failure(
                    request.request_id.clone(),
                    Outcome::NotStarted,
                    journal_rpc_error(error),
                );
                return self.audited_value(
                    connection,
                    connection.task_id().ok().flatten(),
                    &request,
                    &params_value,
                    response,
                    started_at_ms,
                    started,
                    false,
                    false,
                );
            }
        };
        let (_global_read, _global_write) = if request.method == RpcMethod::BrowserHandoff {
            (None, Some(self.global_gate.write()))
        } else {
            (Some(self.global_gate.read()), None)
        };
        let lock_key = request_lock_key(task_id, request.method, &params_value);
        let task_lock = {
            let mut locks = self.task_locks.lock();
            locks.retain(|_, lock| lock.strong_count() > 0);
            if let Some(lock) = locks.get(&lock_key).and_then(Weak::upgrade) {
                lock
            } else {
                let lock = Arc::new(Mutex::new(()));
                locks.insert(lock_key, Arc::downgrade(&lock));
                lock
            }
        };
        let _task_guard = task_lock.lock();
        if connection.is_cancelled() {
            return self
                .attach_new_capability(connection, cancelled_response(request.request_id))
                .value();
        }
        if let Err(error) = self.lifecycle.gate(request.method) {
            let response =
                RpcResponse::failure(request.request_id.clone(), Outcome::NotStarted, error);
            return self.audited_value(
                connection,
                Some(task_id),
                &request,
                &params_value,
                response,
                started_at_ms,
                started,
                false,
                true,
            );
        }
        if let Some(error) = self.handoff_blackout_error() {
            let response =
                RpcResponse::failure(request.request_id.clone(), Outcome::NotStarted, error);
            return self.audited_value(
                connection,
                Some(task_id),
                &request,
                &params_value,
                response,
                started_at_ms,
                started,
                false,
                true,
            );
        }
        let input_hash = request_hash(request.method, &params_value);
        let key = request.idempotency_key;
        if let Some(key) = key {
            match self
                .journal
                .begin_mutation(task_id, key, request.method, &input_hash)
            {
                Ok(BeginDecision::Dispatch) => {}
                Ok(BeginDecision::Cached(cached)) => {
                    let mut response: RpcResponse = match serde_json::from_value(cached) {
                        Ok(response) => response,
                        Err(error) => {
                            let response = RpcResponse::failure(
                                request.request_id.clone(),
                                Outcome::NotStarted,
                                RpcError::new("journal_corrupt", error.to_string()),
                            );
                            return self.audited_value(
                                connection,
                                Some(task_id),
                                &request,
                                &params_value,
                                response,
                                started_at_ms,
                                started,
                                true,
                                true,
                            );
                        }
                    };
                    response.request_id = request.request_id.clone();
                    response = enforce_response_limit(response);
                    return self.audited_value(
                        connection,
                        Some(task_id),
                        &request,
                        &params_value,
                        response,
                        started_at_ms,
                        started,
                        true,
                        true,
                    );
                }
                Ok(BeginDecision::Unknown) => {
                    let response = RpcResponse::failure(
                        request.request_id.clone(),
                        Outcome::Unknown,
                        RpcError::new(
                            "idempotency_outcome_unknown",
                            "A previous attempt started but no durable terminal response exists",
                        )
                        .with_recovery(
                            "Inspect the task state before deciding whether to use a new UUIDv7 key.",
                        ),
                    );
                    return self.audited_value(
                        connection,
                        Some(task_id),
                        &request,
                        &params_value,
                        response,
                        started_at_ms,
                        started,
                        true,
                        true,
                    );
                }
                Err(error) => {
                    let response = RpcResponse::failure(
                        request.request_id.clone(),
                        Outcome::NotStarted,
                        journal_rpc_error(error),
                    );
                    return self.audited_value(
                        connection,
                        Some(task_id),
                        &request,
                        &params_value,
                        response,
                        started_at_ms,
                        started,
                        false,
                        true,
                    );
                }
            }
        }

        let mut response = self.dispatch(
            connection.connection_id,
            task_id,
            &request.request_id,
            request.method,
            &params,
            params_value.clone(),
        );
        response = enforce_response_limit(response);

        if let Err(error) = self.record_audit(
            connection,
            Some(task_id),
            &request,
            &params_value,
            &response,
            started_at_ms,
            started,
            false,
        ) {
            response = self.audit_failure(request.request_id.clone(), error);
        }
        if let Some(key) = key {
            if let Err(error) = self
                .journal
                .complete_mutation(task_id, key, &response.value())
            {
                response = RpcResponse::failure(
                    request.request_id.clone(),
                    Outcome::Unknown,
                    RpcError::new(
                        "journal_completion_failed",
                        format!("Mutation may have run but its terminal response was not durable: {error}"),
                    )
                    .with_recovery("Inspect the task before deciding whether to use a new UUIDv7 key."),
                );
            }
        }
        // Resume capabilities are never part of the journaled response: only their hashes
        // are durable. Attach the one-time plaintext capability after terminal persistence.
        response = self.attach_new_capability(connection, response);
        enforce_response_limit(response).value()
    }

    pub fn disconnect(&self, connection: &ConnectionContext) -> Result<(), JournalError> {
        if !connection.cancel() {
            return Ok(());
        }
        self.native.cancel_connection(connection.connection_id);
        if let Some(task_id) = connection.task_id()? {
            self.journal.detach_connection(task_id)?;
        }
        Ok(())
    }

    fn status_response(&self, request: &RpcRequest, connection: &ConnectionContext) -> RpcResponse {
        let task_id = connection.task_id().ok().flatten();
        RpcResponse::success(
            request.request_id.clone(),
            Outcome::Completed,
            json!({
                "state": self.lifecycle.state(),
                "protocol_version": PROTOCOL_VERSION,
                "handoff_active": self.handoff.is_active(),
                "task_id": task_id,
            }),
        )
    }
    // Keeping the audit envelope explicit at each call site makes timing and replay semantics visible.
    #[allow(clippy::too_many_arguments)]
    fn record_audit(
        &self,
        connection: &ConnectionContext,
        task_id: Option<Uuid>,
        request: &RpcRequest,
        params: &Value,
        response: &RpcResponse,
        started_at_ms: u128,
        started: Instant,
        replayed: bool,
    ) -> std::io::Result<()> {
        self.audit.record(AuditEntry {
            connection_id: connection.connection_id,
            task_id,
            started_at_ms,
            request_id: &request.request_id,
            method: request.method,
            params,
            outcome: response.outcome,
            result: response.result.as_ref(),
            error: response.error.as_ref(),
            duration_ms: started.elapsed().as_millis(),
            replayed,
        })
    }
    // Early terminal paths share the same explicit audit envelope and capability decision.
    #[allow(clippy::too_many_arguments)]
    fn audited_value(
        &self,
        connection: &ConnectionContext,
        task_id: Option<Uuid>,
        request: &RpcRequest,
        params: &Value,
        mut response: RpcResponse,
        started_at_ms: u128,
        started: Instant,
        replayed: bool,
        attach_capability: bool,
    ) -> Value {
        if let Err(error) = self.record_audit(
            connection,
            task_id,
            request,
            params,
            &response,
            started_at_ms,
            started,
            replayed,
        ) {
            response = self.audit_failure(request.request_id.clone(), error);
        }
        if attach_capability {
            self.attach_new_capability(connection, response).value()
        } else {
            enforce_response_limit(response).value()
        }
    }

    fn audit_failure(&self, request_id: impl Into<String>, error: std::io::Error) -> RpcResponse {
        RpcResponse::failure(
            request_id,
            Outcome::Unknown,
            RpcError::new(
                "audit_write_failed",
                format!("AgentTab could not durably write its audit record: {error}"),
            )
            .with_recovery("Repair ~/.agenttab ownership or free disk space before retrying."),
        )
    }

    fn handoff_blackout_error(&self) -> Option<RpcError> {
        self.handoff.is_active().then(|| {
            RpcError::new(
                "handoff_blackout",
                "Automation is disabled while credential handoff is active",
            )
            .with_recovery("Wait for the human to finish or cancel the active handoff.")
        })
    }

    fn dispatch(
        &self,
        connection_id: Uuid,
        task_id: Uuid,
        request_id: &str,
        method: RpcMethod,
        params: &MethodParams,
        mut params_value: Value,
    ) -> RpcResponse {
        let timeout = dispatch_timeout(params);
        if method == RpcMethod::BrowserHandoff {
            if let Err(error) = self.handoff.begin() {
                return RpcResponse::failure(request_id, Outcome::NotStarted, error);
            }
        }

        if let MethodParams::Commit(BrowserCommitParams { staged_token }) = params {
            let staged = match self.journal.consume_staged_commit(task_id, staged_token) {
                Ok(staged) => staged,
                Err(error) => {
                    return RpcResponse::failure(
                        request_id,
                        Outcome::NotStarted,
                        journal_rpc_error(error),
                    )
                }
            };
            let tab_url = self.tab_urls.read().get(&staged.tab_id).cloned();
            if let Err(error) = self.guardrails.authorize_current_tab(tab_url.as_deref()) {
                return RpcResponse::failure(request_id, Outcome::NotStarted, error);
            }
            params_value = json!({
                "native_token": staged.native_token,
                "tab_id": staged.tab_id,
                "page_revision": staged.page_revision,
                "effect": staged.effect,
                "fingerprint": staged.fingerprint,
                "expires_at_ms": staged.expires_at_ms,
            });
        }

        let native = self.native.dispatch(
            connection_id,
            task_id,
            &method.to_string(),
            params_value,
            timeout,
        );
        let native = match native {
            Ok(response) => response,
            Err(error) => return native_failure(request_id, error),
        };
        if native.outcome == Outcome::CommitRequired {
            let Some(staged) = native.staged else {
                return RpcResponse::failure(
                    request_id,
                    Outcome::Unknown,
                    RpcError::new(
                        "invalid_commit_stage",
                        "Extension returned commit_required without a staged operation",
                    ),
                );
            };
            if staged.task_id != task_id {
                return RpcResponse::failure(
                    request_id,
                    Outcome::Unknown,
                    RpcError::new(
                        "commit_task_mismatch",
                        "Extension staged an operation for a different task",
                    ),
                );
            }
            return match self.journal.store_staged_commit(&staged) {
                Ok(staged_token) => RpcResponse::success(
                    request_id,
                    Outcome::CommitRequired,
                    json!({
                        "staged_token": staged_token,
                        "tab_id": staged.tab_id,
                        "page_revision": staged.page_revision,
                        "effect": staged.effect,
                        "fingerprint": staged.fingerprint,
                        "expires_at_ms": staged.expires_at_ms,
                    }),
                ),
                Err(error) => {
                    RpcResponse::failure(request_id, Outcome::Unknown, journal_rpc_error(error))
                }
            };
        }
        if native.staged.is_some() {
            return RpcResponse::failure(
                request_id,
                Outcome::Unknown,
                RpcError::new(
                    "unexpected_commit_stage",
                    "Extension returned staged commit data without commit_required",
                ),
            );
        }
        match (native.result, native.error) {
            (Some(mut result), None) => {
                self.guardrails.redact(&mut result);
                RpcResponse::success(request_id, native.outcome, result)
            }
            (None, Some(error)) => RpcResponse::failure(
                request_id,
                native.outcome,
                self.guardrails.redact_error(error),
            ),
            _ => RpcResponse::failure(
                request_id,
                Outcome::Unknown,
                RpcError::new(
                    "invalid_native_response",
                    "Extension response did not contain exactly one result branch",
                ),
            ),
        }
    }

    fn attach_new_capability(
        &self,
        connection: &ConnectionContext,
        mut response: RpcResponse,
    ) -> RpcResponse {
        if response.task.is_none() {
            let new_lease = connection.take_new_capability().ok().flatten();
            let task_id = new_lease
                .as_ref()
                .map(|lease| lease.task_id)
                .or_else(|| connection.task_id().ok().flatten());
            if let Some(task_id) = task_id {
                response.task = Some(TaskBinding {
                    task_id,
                    resume_capability: new_lease.map(|lease| lease.resume_capability),
                });
            }
        }
        enforce_response_limit(response)
    }
}

fn dispatch_timeout(params: &MethodParams) -> Duration {
    match params {
        MethodParams::Wait(BrowserWaitParams { timeout_ms, .. }) => {
            Duration::from_millis(timeout_ms.saturating_add(5_000))
        }
        MethodParams::Handoff(BrowserHandoffParams { timeout_ms, .. }) => {
            Duration::from_millis(timeout_ms.saturating_add(5_000))
        }
        _ => Duration::from_secs(30),
    }
}

fn request_hash(method: RpcMethod, params: &Value) -> String {
    let value = json!({"method": method, "params": canonicalize(params)});
    format!(
        "{:x}",
        Sha256::digest(serde_json::to_vec(&value).expect("request hash serializes"))
    )
}

fn native_failure(request_id: &str, error: NativeError) -> RpcResponse {
    let (code, recovery) = match error {
        NativeError::Disconnected => (
            "extension_disconnected",
            "Wait for Chrome to reconnect AgentTab, inspect task state, then retry safely.",
        ),

        NativeError::Timeout => (
            "extension_timeout",
            "Inspect task state before retrying a mutation with a new UUIDv7 key.",
        ),
        NativeError::Protocol(_) => (
            "native_protocol_error",
            "Update AgentTab so the host and extension protocol versions match.",
        ),
        NativeError::Transport(_) => (
            "native_transport_error",
            "Repair the AgentTab native host connection before retrying.",
        ),
    };
    RpcResponse::failure(
        request_id,
        Outcome::Unknown,
        RpcError::new(code, error.to_string()).with_recovery(recovery),
    )
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub(crate) enum RequestLockScope {
    Global,
    Tab(u64),
}

pub(crate) fn request_lock_scope(method: RpcMethod, params: &Value) -> RequestLockScope {
    if matches!(
        method,
        RpcMethod::BrowserSnapshot | RpcMethod::BrowserAct | RpcMethod::BrowserWait
    ) {
        if let Some(tab_id) = params.get("tab_id").and_then(Value::as_u64) {
            return RequestLockScope::Tab(tab_id);
        }
    }
    RequestLockScope::Global
}

fn request_lock_key(task_id: Uuid, method: RpcMethod, params: &Value) -> String {
    match request_lock_scope(method, params) {
        RequestLockScope::Global => format!("{task_id}:global"),
        RequestLockScope::Tab(tab_id) => format!("{task_id}:tab:{tab_id}"),
    }
}

fn journal_rpc_error(error: JournalError) -> RpcError {
    let (code, recovery) = match error {
        JournalError::ExpiredKey => (
            "idempotency_key_expired",
            "Generate a new UUIDv7 key after inspecting the task state.",
        ),
        JournalError::FutureKey => (
            "idempotency_key_future",
            "Correct the system clock and generate a new UUIDv7 key.",
        ),
        JournalError::IdempotencyConflict => (
            "idempotency_key_conflict",
            "Use the original inputs or a new UUIDv7 key.",
        ),
        JournalError::TaskCapacity => (
            "task_request_capacity",
            "Close or split the task after completed records become eligible for retention cleanup.",
        ),
        JournalError::InvalidStagedToken => (
            "staged_token_invalid",
            "Request a new staged operation and review its effect before committing.",
        ),
        _ => (
            "state_store_error",
            "Repair ~/.agenttab ownership or free disk space before retrying.",
        ),
    };
    RpcError::new(code, error.to_string()).with_recovery(recovery)
}

fn cancelled_response(request_id: impl Into<String>) -> RpcResponse {
    RpcResponse::failure(
        request_id,
        Outcome::NotStarted,
        RpcError::new(
            "connection_cancelled",
            "The Core RPC connection closed before this request was dispatched",
        )
        .with_recovery("Reconnect and retry with the same UUIDv7 idempotency key."),
    )
}

fn enforce_response_limit(response: RpcResponse) -> RpcResponse {
    if serde_json::to_vec(&response)
        .map(|encoded| {
            encoded.len() <= HOST_TO_CLIENT_MAX_BYTES.saturating_sub(RESPONSE_TASK_BINDING_RESERVE)
        })
        .unwrap_or(false)
    {
        response
    } else {
        RpcResponse::failure(
            response.request_id,
            Outcome::Unknown,
            RpcError::new(
                "response_too_large",
                format!(
                    "AgentTab response exceeds the {}-byte Core RPC limit",
                    HOST_TO_CLIENT_MAX_BYTES
                ),
            )
            .with_recovery("Request a narrower snapshot or lower max_bytes/max_nodes."),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use agenttab_protocol::{
        ConnectKind, NativeResponse, NativeResponseKind, NativeStagedCommit, RPC_PROTOCOL,
    };
    use parking_lot::Mutex;
    use serde_json::json;
    use std::sync::atomic::{AtomicUsize, Ordering};

    #[derive(Debug)]
    struct FakeNative {
        calls: AtomicUsize,
        staged: Mutex<bool>,
        sensitive_error: bool,
    }

    impl FakeNative {
        fn normal() -> Arc<Self> {
            Arc::new(Self {
                calls: AtomicUsize::new(0),
                staged: Mutex::new(false),
                sensitive_error: false,
            })
        }

        fn failing() -> Arc<Self> {
            Arc::new(Self {
                calls: AtomicUsize::new(0),
                staged: Mutex::new(false),
                sensitive_error: true,
            })
        }

        fn staging() -> Arc<Self> {
            Arc::new(Self {
                calls: AtomicUsize::new(0),
                staged: Mutex::new(true),
                sensitive_error: false,
            })
        }
    }

    impl NativeTransport for FakeNative {
        fn dispatch(
            &self,
            _connection_id: Uuid,
            task_id: Uuid,
            method: &str,
            _params: Value,
            _timeout: Duration,
        ) -> Result<agenttab_protocol::NativeResponse, NativeError> {
            self.calls.fetch_add(1, Ordering::Relaxed);
            if self.sensitive_error {
                let mut error = RpcError::new(
                    "native_failure",
                    "SSN 123-45-6789 and Bearer abcdefghijklmnop",
                )
                .with_recovery("Retry with Bearer abcdefghijklmnop");
                error.details = json!({"password": "private"}).as_object().cloned();
                return Ok(NativeResponse {
                    protocol: agenttab_protocol::NATIVE_PROTOCOL.into(),
                    version: PROTOCOL_VERSION,
                    kind: NativeResponseKind::Response,
                    request_id: Uuid::new_v4(),
                    outcome: Outcome::Unknown,
                    result: None,
                    error: Some(error),
                    staged: None,
                });
            }
            if method == "browser_act" && *self.staged.lock() {
                return Ok(NativeResponse {
                    protocol: agenttab_protocol::NATIVE_PROTOCOL.into(),
                    version: PROTOCOL_VERSION,
                    kind: NativeResponseKind::Response,
                    request_id: Uuid::new_v4(),
                    outcome: Outcome::CommitRequired,
                    result: Some(json!({"prepared": true})),
                    error: None,
                    staged: Some(NativeStagedCommit {
                        native_token: "native-token-123456".into(),
                        task_id,
                        tab_id: 3,
                        page_revision: 7,
                        effect: "submit purchase".into(),
                        fingerprint: "f".repeat(64),
                        expires_at_ms: current_time_ms() + 60_000,
                    }),
                });
            }
            Ok(NativeResponse {
                protocol: agenttab_protocol::NATIVE_PROTOCOL.into(),
                version: PROTOCOL_VERSION,
                kind: NativeResponseKind::Response,
                request_id: Uuid::new_v4(),
                outcome: Outcome::Completed,
                result: Some(json!({"ok": true, "body": "SSN 123-45-6789"})),
                error: None,
                staged: None,
            })
        }
    }

    #[derive(Debug)]
    struct TimeoutNative;

    impl NativeTransport for TimeoutNative {
        fn dispatch(
            &self,
            _connection_id: Uuid,
            _task_id: Uuid,
            _method: &str,
            _params: Value,
            _timeout: Duration,
        ) -> Result<NativeResponse, NativeError> {
            Err(NativeError::Timeout)
        }
    }

    fn connected_runtime(
        native: Arc<dyn NativeTransport>,
    ) -> (tempfile::TempDir, Arc<Runtime>, Arc<ConnectionContext>) {
        let temp = tempfile::tempdir().unwrap();
        let paths = AgentTabPaths::from_root(temp.path().join("agenttab"));
        let lifecycle = Arc::new(Lifecycle::default());
        lifecycle.begin_reconciliation();
        lifecycle.complete_reconciliation(false);
        let runtime =
            Runtime::for_test(&paths, lifecycle, native, Arc::new(HandoffState::default()));
        let (connection, _) = runtime
            .connect(ConnectionInit {
                protocol: RPC_PROTOCOL.into(),
                version: PROTOCOL_VERSION,
                kind: ConnectKind::Connect,
                conversation_id: None,
                resume_capability: None,
            })
            .unwrap();
        (temp, runtime, connection)
    }

    #[test]
    fn mutation_is_dispatched_once_and_cached_without_plaintext_capabilities_or_secrets() {
        let native = FakeNative::normal();
        let (_temp, runtime, connection) = connected_runtime(native.clone());
        let key = Uuid::now_v7();
        let params = json!({"mode": "create", "url": "https://example.com", "background": true});
        let request = json!({
            "protocol": RPC_PROTOCOL,
            "version": PROTOCOL_VERSION,
            "request_id": "first",
            "idempotency_key": key,
            "method": "browser_open",
            "params": params
        });
        let first = runtime.handle(&connection, request.clone());
        assert_eq!(first["outcome"], "completed");
        assert!(first["task"]["resume_capability"].as_str().is_some());
        assert!(!first["result"]["body"]
            .as_str()
            .unwrap()
            .contains("123-45-6789"));
        let second = runtime.handle(&connection, request);
        assert_eq!(second["outcome"], first["outcome"]);
        assert_eq!(second["result"], first["result"]);
        assert_eq!(second["task"]["task_id"], first["task"]["task_id"]);
        assert!(second["task"].get("resume_capability").is_none());
        assert_eq!(native.calls.load(Ordering::Relaxed), 1);

        let task_id = first["task"]["task_id"]
            .as_str()
            .unwrap()
            .parse::<Uuid>()
            .unwrap();
        let hash = request_hash(RpcMethod::BrowserOpen, &params);
        let BeginDecision::Cached(cached) = runtime
            .journal
            .begin_mutation(task_id, key, RpcMethod::BrowserOpen, &hash)
            .unwrap()
        else {
            panic!("completed mutation was not cached");
        };
        assert!(cached.pointer("/task/resume_capability").is_none());
    }

    #[test]
    fn native_error_fields_are_redacted_before_rpc_return() {
        let (_temp, runtime, connection) = connected_runtime(FakeNative::failing());
        let response = runtime.handle(
            &connection,
            json!({
                "protocol": RPC_PROTOCOL,
                "version": PROTOCOL_VERSION,
                "request_id": "tabs",
                "method": "browser_tabs",
                "params": {}
            }),
        );
        let encoded = serde_json::to_string(&response).unwrap();
        assert_eq!(response["error"]["code"], "native_failure");
        assert!(!encoded.contains("123-45-6789"));
        assert!(!encoded.contains("abcdefghijklmnop"));
        assert!(!encoded.contains("private"));
    }

    #[test]
    fn status_works_before_ready_without_creating_task() {
        let temp = tempfile::tempdir().unwrap();
        let paths = AgentTabPaths::from_root(temp.path().join("agenttab"));
        let lifecycle = Arc::new(Lifecycle::default());
        let native = FakeNative::normal();
        let runtime = Runtime::for_test(
            &paths,
            lifecycle,
            native.clone(),
            Arc::new(HandoffState::default()),
        );
        let (connection, _) = runtime
            .connect(ConnectionInit {
                protocol: RPC_PROTOCOL.into(),
                version: PROTOCOL_VERSION,
                kind: ConnectKind::Connect,
                conversation_id: None,
                resume_capability: None,
            })
            .unwrap();
        let response = runtime.handle(
            &connection,
            json!({
                "protocol": RPC_PROTOCOL,
                "version": PROTOCOL_VERSION,
                "request_id": "status",
                "method": "agenttab.status",
                "params": {}
            }),
        );
        assert_eq!(response["result"]["state"], "starting");
        assert!(response["result"]["task_id"].is_null());
        let rejected = runtime.handle(
            &connection,
            json!({
                "protocol": RPC_PROTOCOL,
                "version": PROTOCOL_VERSION,
                "request_id": "open",
                "idempotency_key": Uuid::now_v7(),
                "method": "browser_open",
                "params": {"mode": "create", "url": "https://example.com"}
            }),
        );
        assert_eq!(rejected["error"]["code"], "runtime_not_ready");
        assert!(rejected.get("task").is_none());
        assert!(connection.task_id().unwrap().is_none());
        assert_eq!(native.calls.load(Ordering::Relaxed), 0);
    }

    #[test]
    fn constrained_origin_policy_requires_verified_current_tab_url() {
        let temp = tempfile::tempdir().unwrap();
        let paths = AgentTabPaths::from_root(temp.path().join("agenttab"));
        paths.prepare().unwrap();
        std::fs::write(
            &paths.policy_file,
            r#"{"denied_origins":["*.example.com"]}"#,
        )
        .unwrap();
        let lifecycle = Arc::new(Lifecycle::default());
        lifecycle.begin_reconciliation();
        lifecycle.complete_reconciliation(false);
        let native = FakeNative::normal();
        let runtime = Runtime::for_test(
            &paths,
            lifecycle,
            native.clone(),
            Arc::new(HandoffState::default()),
        );
        let (connection, _) = runtime
            .connect(ConnectionInit {
                protocol: RPC_PROTOCOL.into(),
                version: PROTOCOL_VERSION,
                kind: ConnectKind::Connect,
                conversation_id: None,
                resume_capability: None,
            })
            .unwrap();
        let snapshot = |request_id: &str| {
            json!({
                "protocol": RPC_PROTOCOL,
                "version": PROTOCOL_VERSION,
                "request_id": request_id,
                "method": "browser_snapshot",
                "params": {"mode": "text", "tab_id": 3}
            })
        };

        let unverified = runtime.handle(&connection, snapshot("unverified"));
        assert_eq!(unverified["error"]["code"], "tab_origin_unverified");
        runtime
            .tab_urls
            .write()
            .insert(3, "https://private.example.com/path".into());
        let denied = runtime.handle(&connection, snapshot("denied"));
        assert_eq!(denied["error"]["code"], "origin_denied");
        runtime
            .tab_urls
            .write()
            .insert(3, "https://allowed.test/path".into());
        let allowed = runtime.handle(&connection, snapshot("allowed"));
        assert_eq!(allowed["outcome"], "completed");
        assert_eq!(native.calls.load(Ordering::Relaxed), 1);
    }

    #[test]
    fn handoff_timeout_keeps_global_blackout_active() {
        let (_temp, runtime, connection) = connected_runtime(Arc::new(TimeoutNative));
        let response = runtime.handle(
            &connection,
            json!({
                "protocol": RPC_PROTOCOL,
                "version": PROTOCOL_VERSION,
                "request_id": "handoff",
                "idempotency_key": Uuid::now_v7(),
                "method": "browser_handoff",
                "params": {
                    "tab_id": 3,
                    "expected_page_revision": 7,
                    "prompt": "Complete sign-in",
                    "completion": {"kind": "manual_done"},
                    "timeout_ms": 1000
                }
            }),
        );
        assert_eq!(response["error"]["code"], "extension_timeout");
        assert!(runtime.handoff.is_active());

        let blocked = runtime.handle(
            &connection,
            json!({
                "protocol": RPC_PROTOCOL,
                "version": PROTOCOL_VERSION,
                "request_id": "snapshot",
                "method": "browser_snapshot",
                "params": {"mode": "text", "tab_id": 3}
            }),
        );
        assert_eq!(blocked["error"]["code"], "handoff_blackout");
        runtime.handoff.restore(false);
    }

    #[test]
    fn host_token_is_bound_and_native_commit_token_is_never_exposed() {
        let native = FakeNative::staging();
        let (_temp, runtime, connection) = connected_runtime(native.clone());
        let stage = runtime.handle(
            &connection,
            json!({
                "protocol": RPC_PROTOCOL,
                "version": PROTOCOL_VERSION,
                "request_id": "stage",
                "idempotency_key": Uuid::now_v7(),
                "method": "browser_act",
                "params": {
                    "tab_id": 3,
                    "expected_page_revision": 7,
                    "actions": [{"kind": "click", "ref": "e9"}]
                }
            }),
        );
        assert_eq!(stage["outcome"], "commit_required");
        let encoded = serde_json::to_string(&stage).unwrap();
        assert!(!encoded.contains("native-token"));
        let token = stage["result"]["staged_token"].as_str().unwrap();
        *native.staged.lock() = false;
        let committed = runtime.handle(
            &connection,
            json!({
                "protocol": RPC_PROTOCOL,
                "version": PROTOCOL_VERSION,
                "request_id": "commit",
                "idempotency_key": Uuid::now_v7(),
                "method": "browser_commit",
                "params": {"staged_token": token}
            }),
        );
        assert_eq!(committed["outcome"], "completed");
    }

    fn current_time_ms() -> i64 {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis() as i64
    }
}
