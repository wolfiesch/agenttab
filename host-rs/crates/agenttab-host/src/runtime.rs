use crate::audit::{canonicalize, now_ms, AuditEntry, AuditLog};
use crate::guardrails::{GuardrailLoadError, Guardrails};
use crate::handoff::HandoffState;
use crate::journal::{
    BeginDecision, InventoryReconciliation, Journal, JournalError, StagedCommitApproval,
    StagedCommitConsumption, StagedReplayResolution,
};
use crate::lifecycle::Lifecycle;
use crate::native::{NativeError, NativeEventResult, NativeEventSink, NativeTransport};
use crate::paths::AgentTabPaths;
use crate::task::ConnectionContext;
use agenttab_protocol::{
    BrowserAction, BrowserCommitParams, BrowserHandoffParams, BrowserSnapshotParams,
    BrowserWaitParams, ConnectionAck, ConnectionInit, MethodParams, NativeEventPayload,
    NativeHandoff, NativePopupCommitEvent, NativeResponse, NativeStagedCommit, NativeTab, Outcome,
    ResumeCapabilityConfirm, ResumeCapabilityConfirmed, RpcError, RpcMethod, RpcRequest,
    RpcResponse, TaskBinding, WaitCondition, HOST_TO_CLIENT_MAX_BYTES, PROTOCOL_VERSION,
};
use parking_lot::{Mutex, RwLock};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Weak};
use std::time::{Duration, Instant};
use thiserror::Error;
use uuid::Uuid;
const RESPONSE_TASK_BINDING_RESERVE: usize = 512;
const CLOSE_TASK_TIMEOUT: Duration = Duration::from_secs(5);
const CLOSE_TAB_STAGED_EFFECT: &str = "Close an AgentTab-owned browser tab";

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
    runtime: Mutex<Weak<Runtime>>,
}
impl JournalNativeEventSink {
    fn cleanup_uploads(paths: Vec<PathBuf>) -> Result<(), String> {
        Guardrails::cleanup_staged_uploads(&paths)
            .map_err(|error| format!("{}: {}", error.code, error.message))
    }
}

impl NativeEventSink for JournalNativeEventSink {
    fn reconcile(
        &self,
        inventory: &[NativeTab],
        staged_commits: &[NativeStagedCommit],
        handoff: &NativeHandoff,
    ) -> Result<(), String> {
        let inventory_reconciliation = self
            .journal
            .reconcile_inventory(inventory)
            .map_err(|error| error.to_string())?;
        if inventory_reconciliation == InventoryReconciliation::Applied {
            replace_inventory_urls(&self.tab_urls, inventory);
        }
        let removed_uploads = self
            .journal
            .reconcile_staged_commits(staged_commits)
            .map_err(|error| error.to_string())?;
        Self::cleanup_uploads(removed_uploads)?;
        self.journal
            .reconcile_handoff(handoff)
            .map_err(|error| error.to_string())
    }

    fn handle(
        &self,
        payload: &NativeEventPayload,
        event_id: Option<&str>,
    ) -> Result<NativeEventResult, String> {
        match payload {
            NativeEventPayload::CommitExpired(event)
            | NativeEventPayload::CommitAbandoned(event) => {
                let removed_uploads = self
                    .journal
                    .expire_staged_commit(&event.native_token)
                    .map_err(|error| error.to_string())?;
                Self::cleanup_uploads(removed_uploads)?;
                Ok(NativeEventResult::completed(json!({ "cleared": true })))
            }
            NativeEventPayload::PopupCommitApproved(event) => {
                let runtime = self
                    .runtime
                    .lock()
                    .upgrade()
                    .ok_or("runtime is unavailable")?;
                Ok(runtime.commit_popup_review(
                    event,
                    event_id.ok_or("popup approval is missing its idempotency event_id")?,
                ))
            }
            NativeEventPayload::PopupCommitAbandoned(event) => {
                let runtime = self
                    .runtime
                    .lock()
                    .upgrade()
                    .ok_or("runtime is unavailable")?;
                Ok(runtime.abandon_popup_review(
                    event,
                    event_id.ok_or("popup abandonment is missing its idempotency event_id")?,
                ))
            }
            NativeEventPayload::Inventory(event) => {
                let reconciliation = self
                    .journal
                    .reconcile_inventory(&event.inventory)
                    .map_err(|error| error.to_string())?;
                if reconciliation == InventoryReconciliation::Applied {
                    replace_inventory_urls(&self.tab_urls, &event.inventory);
                }
                Ok(NativeEventResult::completed(json!({
                    "ignored_stale": reconciliation == InventoryReconciliation::IgnoredStale,
                })))
            }
            NativeEventPayload::TaskTabs(event) => {
                self.journal
                    .update_task_tab_count(event.task_id, event.tab_count)
                    .map_err(|error| error.to_string())?;
                Ok(NativeEventResult::completed(json!({})))
            }
            NativeEventPayload::Handoff(handoff) => {
                self.journal
                    .apply_handoff_event(handoff, event_id)
                    .map_err(|error| error.to_string())?;
                Ok(NativeEventResult::completed(json!({})))
            }
            NativeEventPayload::Pause(_) => Ok(NativeEventResult::completed(json!({}))),
            NativeEventPayload::ExtensionDisconnected(_) => {
                let paths = self
                    .journal
                    .abandon_all_staged_commits()
                    .map_err(|error| error.to_string())?;
                Self::cleanup_uploads(paths)?;
                Ok(NativeEventResult::completed(json!({})))
            }
        }
    }
}

fn replace_inventory_urls(tab_urls: &RwLock<HashMap<u64, String>>, inventory: &[NativeTab]) {
    let mut urls = tab_urls.write();
    urls.clear();
    urls.extend(inventory.iter().map(|tab| (tab.tab_id, tab.url.clone())));
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
    upload_staging_dir: PathBuf,
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
        if journal.handoff_active()? {
            handoff.restore(true);
        }
        let tab_urls = Arc::new(RwLock::new(HashMap::new()));
        let sink = Arc::new(JournalNativeEventSink {
            journal: journal.clone(),
            tab_urls: tab_urls.clone(),
            runtime: Mutex::new(Weak::new()),
        });
        native.set_event_sink(sink.clone());
        let guardrails = Arc::new(Guardrails::load(&paths.policy_file)?);
        let audit = Arc::new(AuditLog::open(
            &paths.audit_log,
            guardrails.audit_enabled(),
        )?);
        let runtime = Arc::new(Self {
            lifecycle,
            journal,
            guardrails,
            audit,
            native,
            handoff,
            task_locks: Mutex::new(HashMap::new()),
            global_gate: RwLock::new(()),
            tab_urls,
            upload_staging_dir: paths.upload_staging_dir.clone(),
        });
        *sink.runtime.lock() = Arc::downgrade(&runtime);
        Ok(runtime)
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

    fn commit_popup_review(
        &self,
        event: &NativePopupCommitEvent,
        event_id: &str,
    ) -> NativeEventResult {
        let key = match Uuid::parse_str(event_id) {
            Ok(key) => key,
            Err(_) => {
                return NativeEventResult::failure(
                    Outcome::NotStarted,
                    RpcError::new("invalid_request", "popup approval event_id is not a UUID"),
                )
            }
        };
        let params = json!({
            "popup_event": "approved",
            "review_handle": event.review_handle,
            "tab_id": event.tab_id,
        });
        let input_hash = request_hash(RpcMethod::BrowserCommit, &params);
        let replayed = match self.journal.lookup_mutation(
            event.task_id,
            key,
            RpcMethod::BrowserCommit,
            &input_hash,
        ) {
            Ok(Some(BeginDecision::Cached(response))) => {
                return native_event_result(existing_mutation_response(
                    event_id,
                    BeginDecision::Cached(response),
                ))
            }
            Ok(Some(BeginDecision::Unknown)) => true,
            Ok(Some(BeginDecision::Dispatch)) => unreachable!("lookup never dispatches"),
            Ok(None) => {
                match self.journal.begin_mutation(
                    event.task_id,
                    key,
                    RpcMethod::BrowserCommit,
                    &input_hash,
                ) {
                    Ok(BeginDecision::Dispatch) => {}
                    Ok(decision) => {
                        return native_event_result(existing_mutation_response(event_id, decision))
                    }
                    Err(error) => {
                        return NativeEventResult::failure(
                            Outcome::NotStarted,
                            journal_rpc_error(error),
                        )
                    }
                }
                false
            }
            Err(error) => {
                return NativeEventResult::failure(Outcome::NotStarted, journal_rpc_error(error))
            }
        };

        let started_at_ms = now_ms();
        let started = Instant::now();
        let mut response = match self.journal.approve_popup_staged_commit(
            event.task_id,
            event.tab_id,
            &event.review_handle,
        ) {
            Ok(StagedCommitApproval::Approved) => RpcResponse::success(
                event_id,
                Outcome::Completed,
                json!({"approved": true, "tab_id": event.tab_id}),
            ),
            Ok(StagedCommitApproval::Expired(paths)) => {
                staged_commit_terminal_response(event_id, paths)
            }
            Err(error) => {
                let rpc_error = journal_rpc_error(error);
                match self.journal.abandon_popup_staged_commit(
                    event.task_id,
                    event.tab_id,
                    &event.review_handle,
                ) {
                    Ok(paths) => match Guardrails::cleanup_staged_uploads(&paths) {
                        Ok(()) => RpcResponse::failure(event_id, Outcome::NotStarted, rpc_error),
                        Err(cleanup_error) => {
                            RpcResponse::failure(event_id, Outcome::Unknown, cleanup_error)
                        }
                    },
                    Err(_) => RpcResponse::failure(event_id, Outcome::NotStarted, rpc_error),
                }
            }
        };
        if let Err(error) = self.audit.record(AuditEntry {
            connection_id: Uuid::nil(),
            task_id: Some(event.task_id),
            started_at_ms,
            request_id: event_id,
            method: RpcMethod::BrowserCommit,
            params: &params,
            outcome: response.outcome,
            result: response.result.as_ref(),
            error: response.error.as_ref(),
            duration_ms: started.elapsed().as_millis(),
            replayed,
        }) {
            response = self.audit_failure(event_id, error);
        }
        if let Err(error) = self
            .journal
            .complete_mutation(event.task_id, key, &response.value())
        {
            response = RpcResponse::failure(
                event_id,
                Outcome::Unknown,
                RpcError::new(
                    "journal_completion_failed",
                    format!("Popup approval may have run but its result was not durable: {error}"),
                ),
            );
        }
        native_event_result(response)
    }

    fn abandon_popup_review(
        &self,
        event: &NativePopupCommitEvent,
        event_id: &str,
    ) -> NativeEventResult {
        let key = match Uuid::parse_str(event_id) {
            Ok(key) => key,
            Err(_) => {
                return NativeEventResult::failure(
                    Outcome::NotStarted,
                    RpcError::new(
                        "invalid_request",
                        "popup abandonment event_id is not a UUID",
                    ),
                )
            }
        };
        let params = json!({
            "popup_event": "abandoned",
            "review_handle": event.review_handle,
            "tab_id": event.tab_id,
        });
        let input_hash = request_hash(RpcMethod::BrowserCommit, &params);
        match self.journal.lookup_mutation(
            event.task_id,
            key,
            RpcMethod::BrowserCommit,
            &input_hash,
        ) {
            Ok(Some(decision)) => {
                return native_event_result(existing_mutation_response(event_id, decision));
            }
            Ok(None) => {}
            Err(error) => {
                return NativeEventResult::failure(Outcome::NotStarted, journal_rpc_error(error));
            }
        }
        match self
            .journal
            .begin_mutation(event.task_id, key, RpcMethod::BrowserCommit, &input_hash)
        {
            Ok(BeginDecision::Dispatch) => {}
            Ok(decision) => {
                return native_event_result(existing_mutation_response(event_id, decision))
            }
            Err(error) => {
                return NativeEventResult::failure(Outcome::NotStarted, journal_rpc_error(error));
            }
        }

        let started_at_ms = now_ms();
        let started = Instant::now();
        let mut response = match self.journal.abandon_popup_staged_commit(
            event.task_id,
            event.tab_id,
            &event.review_handle,
        ) {
            Ok(paths) => match Guardrails::cleanup_staged_uploads(&paths) {
                Ok(()) => {
                    RpcResponse::success(event_id, Outcome::Completed, json!({ "abandoned": true }))
                }
                Err(error) => RpcResponse::failure(event_id, Outcome::Unknown, error),
            },
            Err(error) => {
                RpcResponse::failure(event_id, Outcome::NotStarted, journal_rpc_error(error))
            }
        };
        if let Err(error) = self.audit.record(AuditEntry {
            connection_id: Uuid::nil(),
            task_id: Some(event.task_id),
            started_at_ms,
            request_id: event_id,
            method: RpcMethod::BrowserCommit,
            params: &params,
            outcome: response.outcome,
            result: response.result.as_ref(),
            error: response.error.as_ref(),
            duration_ms: started.elapsed().as_millis(),
            replayed: false,
        }) {
            response = self.audit_failure(event_id, error);
        }
        if let Err(error) = self
            .journal
            .complete_mutation(event.task_id, key, &response.value())
        {
            response = RpcResponse::failure(
                event_id,
                Outcome::Unknown,
                RpcError::new(
                    "journal_completion_failed",
                    format!("Popup abandonment may have completed but its result was not durable: {error}"),
                ),
            );
        }
        native_event_result(response)
    }
    pub fn confirm_resume_capability(
        &self,
        connection: &ConnectionContext,
        confirmation: &ResumeCapabilityConfirm,
    ) -> Result<ResumeCapabilityConfirmed, JournalError> {
        connection.confirm_resume_capability(confirmation, &self.journal)
    }

    pub fn handle(&self, connection: &Arc<ConnectionContext>, raw: Value) -> Value {
        let fallback_request_id = raw
            .get("request_id")
            .and_then(Value::as_str)
            .filter(|request_id| !request_id.is_empty() && request_id.len() <= 128)
            .unwrap_or("invalid-request")
            .to_string();
        if connection.resume_confirmation_required() {
            return RpcResponse::failure(
                fallback_request_id,
                Outcome::NotStarted,
                RpcError::new(
                    "resume_confirmation_required",
                    "Persist the replacement resume capability, then confirm it on this connection.",
                ),
            )
            .value();
        }
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
        let input_hash = request_hash(request.method, &params_value);
        let key = request.idempotency_key;
        if let (Some(task_id), Some(key)) = (connection.task_id().ok().flatten(), key) {
            match self
                .journal
                .lookup_mutation(task_id, key, request.method, &input_hash)
            {
                Ok(Some(decision)) => {
                    if request.method == RpcMethod::BrowserAct {
                        if let BeginDecision::Cached(cached) = &decision {
                            if let Some(staged_token) = staged_token_from_cached_response(cached) {
                                let terminal_response =
                                    staged_commit_unavailable_response(&request.request_id);
                                match self.journal.resolve_staged_commit_replay(
                                    task_id,
                                    staged_token,
                                    key,
                                    &terminal_response.value(),
                                    true,
                                ) {
                                    Ok(StagedReplayResolution::Expired(paths)) => {
                                        let response = staged_commit_terminal_response(
                                            &request.request_id,
                                            paths,
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
                                    Ok(StagedReplayResolution::Unavailable) => {
                                        return self.audited_value(
                                            connection,
                                            Some(task_id),
                                            &request,
                                            &params_value,
                                            terminal_response,
                                            started_at_ms,
                                            started,
                                            true,
                                            true,
                                        );
                                    }
                                    Ok(StagedReplayResolution::Active) => {}
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
                                            true,
                                            true,
                                        );
                                    }
                                }
                            }
                        }
                    }
                    if let MethodParams::Commit(BrowserCommitParams { staged_token }) = &params {
                        let terminal_response =
                            staged_commit_unavailable_response(&request.request_id);
                        match self.journal.resolve_staged_commit_replay(
                            task_id,
                            staged_token,
                            key,
                            &terminal_response.value(),
                            false,
                        ) {
                            Ok(StagedReplayResolution::Expired(paths)) => {
                                let response =
                                    staged_commit_terminal_response(&request.request_id, paths);
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
                            Ok(
                                StagedReplayResolution::Active
                                | StagedReplayResolution::Unavailable,
                            ) => {}
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
                                    true,
                                    true,
                                );
                            }
                        }
                    }
                    let response = existing_mutation_response(&request.request_id, decision);
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
                Ok(None) => {}
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

        let early_error = self
            .lifecycle
            .gate(request.method)
            .err()
            .or_else(|| self.handoff_blackout_error())
            .or_else(|| self.guardrails.authorize(request.method, &params).err());
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
        if let Err(error) = self.validate_task_scope(task_id, &params) {
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
            let response = cancelled_response(request.request_id.clone());
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
        let _lifecycle_admission = match self.lifecycle.admit(request.method) {
            Ok(admission) => admission,
            Err(error) => {
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
        };
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
        if let Err(error) = self.validate_task_scope(task_id, &params) {
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
        if let Some(key) = key {
            match self
                .journal
                .begin_mutation(task_id, key, request.method, &input_hash)
            {
                Ok(BeginDecision::Dispatch) => {}
                Ok(decision) => {
                    let response = existing_mutation_response(&request.request_id, decision);
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
            key,
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
                let _ = self.record_audit(
                    connection,
                    Some(task_id),
                    &request,
                    &params_value,
                    &response,
                    started_at_ms,
                    started,
                    false,
                );
            }
        }
        // Task identity is journaled with the terminal response. The server adds any
        // pending plaintext resume capability immediately before delivery.
        response = self.attach_task_binding(connection, response);
        enforce_response_limit(response).value()
    }

    pub fn disconnect(&self, connection: &ConnectionContext) -> Result<(), JournalError> {
        if !connection.cancel() {
            return Ok(());
        }
        let rollback = connection.rollback_resume_capability(&self.journal);
        self.native.cancel_connection(connection.connection_id);
        if let Some(task_id) = connection.undelivered_new_task_id() {
            self.native
                .close_task(task_id, CLOSE_TASK_TIMEOUT)
                .map_err(|error| JournalError::NativeTaskCleanup(error.to_string()))?;
            self.journal.close_task(task_id)?;
        } else if let Some(task_id) = connection.task_id()? {
            self.journal.detach_connection(task_id)?;
        }
        rollback
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
    fn validate_task_scope(&self, task_id: Uuid, params: &MethodParams) -> Result<(), RpcError> {
        let Some((tab_id, expected_page_revision)) = requested_tab(params) else {
            return Ok(());
        };
        self.journal
            .verify_task_tab(task_id, tab_id, expected_page_revision)
            .map_err(journal_rpc_error)?;
        if is_tab_only_request(params) {
            return Ok(());
        }
        let tab_url = self.tab_urls.read().get(&tab_id).cloned();
        self.guardrails.authorize_current_tab(tab_url.as_deref())
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
            self.attach_task_binding(connection, response).value()
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
        idempotency_key: Option<Uuid>,
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

        let mut committed_uploads = Vec::new();
        let mut committed_native_token = None;
        let origin_policy =
            if let MethodParams::Commit(BrowserCommitParams { staged_token }) = params {
                let Some(idempotency_key) = idempotency_key else {
                    return RpcResponse::failure(
                        request_id,
                        Outcome::NotStarted,
                        RpcError::new(
                            "invalid_request",
                            "browser_commit requires an idempotency key",
                        ),
                    );
                };
                let staged =
                    match self
                        .journal
                        .consume_staged_commit(task_id, staged_token, idempotency_key)
                    {
                        Ok(StagedCommitConsumption::Ready(staged)) => staged,
                        Ok(StagedCommitConsumption::ApprovalRequired) => {
                            return RpcResponse::success(
                                request_id,
                                Outcome::CommitRequired,
                                json!({
                                    "staged_token": staged_token,
                                    "awaiting_human_approval": true,
                                }),
                            );
                        }
                        Ok(StagedCommitConsumption::Expired(paths)) => {
                            return staged_commit_terminal_response(request_id, paths);
                        }
                        Err(error) => {
                            return RpcResponse::failure(
                                request_id,
                                Outcome::NotStarted,
                                journal_rpc_error(error),
                            )
                        }
                    };
                if staged_commit_requires_verified_current_tab(&staged.effect) {
                    let tab_url = self.tab_urls.read().get(&staged.tab_id).cloned();
                    if let Err(error) = self.guardrails.authorize_current_tab(tab_url.as_deref()) {
                        let cleanup = Guardrails::cleanup_staged_uploads(&staged.upload_paths);
                        let finish = self.journal.finish_staged_commit(&staged.native_token);
                        return match (cleanup, finish) {
                            (Ok(()), Ok(())) => {
                                RpcResponse::failure(request_id, Outcome::NotStarted, error)
                            }
                            (Err(cleanup_error), _) => {
                                RpcResponse::failure(request_id, Outcome::Unknown, cleanup_error)
                            }
                            (_, Err(journal_error)) => RpcResponse::failure(
                                request_id,
                                Outcome::Unknown,
                                journal_rpc_error(journal_error),
                            ),
                        };
                    }
                }
                let origin_policy = self.guardrails.native_origin_policy(staged.tab_id);
                committed_native_token = Some(staged.native_token.clone());
                params_value = json!({"native_token": staged.native_token});
                committed_uploads = staged.upload_paths;
                origin_policy
            } else {
                match params {
                    MethodParams::Developer(developer) => developer
                        .params
                        .get("tab_id")
                        .and_then(Value::as_u64)
                        .and_then(|tab_id| self.guardrails.native_origin_policy(tab_id)),
                    _ => params_value
                        .get("tab_id")
                        .and_then(Value::as_u64)
                        .and_then(|tab_id| self.guardrails.native_origin_policy(tab_id)),
                }
            };
        let staged_uploads =
            match self
                .guardrails
                .stage_uploads(params, &mut params_value, &self.upload_staging_dir)
            {
                Ok(staged_uploads) => staged_uploads,
                Err(error) => return RpcResponse::failure(request_id, Outcome::NotStarted, error),
            };
        let native_result = self.native.dispatch(
            connection_id,
            task_id,
            &method.to_string(),
            params_value,
            origin_policy,
            timeout,
        );
        if let Err(error) = Guardrails::cleanup_staged_uploads(&committed_uploads) {
            let _ = Guardrails::cleanup_staged_uploads(&staged_uploads);
            return RpcResponse::failure(request_id, Outcome::Unknown, error);
        }
        if let Some(native_token) = committed_native_token {
            if let Err(error) = self.journal.finish_staged_commit(&native_token) {
                let _ = Guardrails::cleanup_staged_uploads(&staged_uploads);
                return RpcResponse::failure(
                    request_id,
                    Outcome::Unknown,
                    journal_rpc_error(error),
                );
            }
        }
        let native = match native_result {
            Ok(response) => response,
            Err(error) => {
                if let Err(cleanup_error) = Guardrails::cleanup_staged_uploads(&staged_uploads) {
                    return RpcResponse::failure(request_id, Outcome::Unknown, cleanup_error);
                }
                return native_failure(request_id, error);
            }
        };
        if method == RpcMethod::BrowserHandoff && native.outcome == Outcome::NotStarted {
            self.handoff.restore(false);
        }
        if native.outcome == Outcome::CommitRequired {
            let stage_error = match native.staged.as_ref() {
                None => Some(RpcError::new(
                    "invalid_commit_stage",
                    "Extension returned commit_required without a staged operation",
                )),
                Some(_) if method != RpcMethod::BrowserAct => Some(RpcError::new(
                    "invalid_commit_stage",
                    "Only browser_act may return a staged Standard operation",
                )),
                Some(staged)
                    if staged.task_id != task_id || !staged_matches_act(params, staged) =>
                {
                    Some(RpcError::new(
                        "commit_binding_mismatch",
                        "Extension staged an operation outside the requested task, tab, or page revision",
                    ))
                }
                Some(_) => None,
            };
            if let Some(error) = stage_error {
                if let Err(cleanup_error) = Guardrails::cleanup_staged_uploads(&staged_uploads) {
                    return RpcResponse::failure(request_id, Outcome::Unknown, cleanup_error);
                }
                return RpcResponse::failure(request_id, Outcome::Unknown, error);
            }
            let staged = native.staged.expect("validated staged response");
            return match self.journal.store_staged_commit(&staged, &staged_uploads) {
                Ok(handles) => {
                    let binding = self.native.dispatch(
                        connection_id,
                        task_id,
                        "commit_review_bind",
                        json!({
                            "native_token": staged.native_token,
                            "review_handle": handles.review_handle,
                            "tab_id": staged.tab_id,
                        }),
                        None,
                        timeout,
                    );
                    if !matches!(
                        binding,
                        Ok(NativeResponse {
                            outcome: Outcome::Completed,
                            error: None,
                            ..
                        })
                    ) {
                        if let Ok(paths) = self.journal.abandon_popup_staged_commit(
                            task_id,
                            staged.tab_id,
                            &handles.review_handle,
                        ) {
                            let _ = Guardrails::cleanup_staged_uploads(&paths);
                        }
                        let _ = self.native.dispatch(
                            connection_id,
                            task_id,
                            "commit_review_abandon",
                            json!({ "native_token": staged.native_token, "tab_id": staged.tab_id }),
                            None,
                            timeout,
                        );
                        return RpcResponse::failure(
                            request_id,
                            Outcome::Unknown,
                            RpcError::new(
                                "commit_review_binding_failed",
                                "Host could not durably bind the extension stage to the popup review",
                            ),
                        );
                    }
                    RpcResponse::success(
                        request_id,
                        Outcome::CommitRequired,
                        json!({
                            "staged_token": handles.staged_token,
                            "tab_id": staged.tab_id,
                            "page_revision": staged.page_revision,
                            "effect": staged.effect,
                            "fingerprint": staged.fingerprint,
                            "expires_at_ms": staged.expires_at_ms,
                        }),
                    )
                }
                Err(error) => {
                    if let Err(cleanup_error) = Guardrails::cleanup_staged_uploads(&staged_uploads)
                    {
                        return RpcResponse::failure(request_id, Outcome::Unknown, cleanup_error);
                    }
                    RpcResponse::failure(request_id, Outcome::Unknown, journal_rpc_error(error))
                }
            };
        }
        if let Err(error) = Guardrails::cleanup_staged_uploads(&staged_uploads) {
            return RpcResponse::failure(request_id, Outcome::Unknown, error);
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

    fn attach_task_binding(
        &self,
        connection: &ConnectionContext,
        mut response: RpcResponse,
    ) -> RpcResponse {
        if response.task.is_none() {
            let new_lease = connection.reserve_new_capability().ok().flatten();
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

fn requested_tab(params: &MethodParams) -> Option<(u64, Option<u64>)> {
    match params {
        MethodParams::Snapshot(
            BrowserSnapshotParams::Accessibility { tab_id, .. }
            | BrowserSnapshotParams::Text { tab_id, .. }
            | BrowserSnapshotParams::Html { tab_id, .. }
            | BrowserSnapshotParams::Screenshot { tab_id, .. },
        )
        | MethodParams::Wait(BrowserWaitParams { tab_id, .. }) => Some((*tab_id, None)),
        MethodParams::Act(params) => Some((params.tab_id, Some(params.expected_page_revision))),
        MethodParams::Handoff(params) => Some((params.tab_id, Some(params.expected_page_revision))),
        MethodParams::Open(_)
        | MethodParams::Tabs(_)
        | MethodParams::Commit(_)
        | MethodParams::Status(_)
        | MethodParams::Developer(_) => None,
    }
}
fn is_tab_only_request(params: &MethodParams) -> bool {
    match params {
        MethodParams::Act(params) => params.actions.iter().all(|action| {
            matches!(
                action,
                BrowserAction::Navigate { .. }
                    | BrowserAction::GoBack
                    | BrowserAction::GoForward
                    | BrowserAction::Reload { .. }
                    | BrowserAction::Close
            )
        }),
        MethodParams::Wait(params) => matches!(
            &params.condition,
            WaitCondition::Load | WaitCondition::Url { .. } | WaitCondition::Download
        ),
        MethodParams::Handoff(_) => true,
        _ => false,
    }
}
fn staged_commit_requires_verified_current_tab(effect: &str) -> bool {
    effect != CLOSE_TAB_STAGED_EFFECT
}

fn staged_matches_act(params: &MethodParams, staged: &NativeStagedCommit) -> bool {
    matches!(
        params,
        MethodParams::Act(action)
            if action.tab_id == staged.tab_id
                && action.expected_page_revision == staged.page_revision
    )
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

fn staged_token_from_cached_response(response: &Value) -> Option<&str> {
    if response.get("outcome").and_then(Value::as_str) != Some("commit_required") {
        return None;
    }
    response
        .get("result")
        .and_then(|result| result.get("staged_token"))
        .and_then(Value::as_str)
}

fn staged_commit_unavailable_response(request_id: &str) -> RpcResponse {
    RpcResponse::failure(
        request_id,
        Outcome::NotStarted,
        journal_rpc_error(JournalError::InvalidStagedToken),
    )
}

fn staged_commit_terminal_response(request_id: &str, upload_paths: Vec<PathBuf>) -> RpcResponse {
    match Guardrails::cleanup_staged_uploads(&upload_paths) {
        Ok(()) => staged_commit_unavailable_response(request_id),
        Err(error) => RpcResponse::failure(request_id, Outcome::Unknown, error),
    }
}
fn existing_mutation_response(request_id: &str, decision: BeginDecision) -> RpcResponse {
    match decision {
        BeginDecision::Cached(cached) => match serde_json::from_value(cached) {
            Ok(response) => {
                let mut response: RpcResponse = response;
                response.request_id = request_id.to_owned();
                enforce_response_limit(response)
            }
            Err(error) => RpcResponse::failure(
                request_id,
                Outcome::NotStarted,
                RpcError::new("journal_corrupt", error.to_string()),
            ),
        },
        BeginDecision::Unknown => RpcResponse::failure(
            request_id,
            Outcome::Unknown,
            RpcError::new(
                "idempotency_outcome_unknown",
                "A previous attempt started but no durable terminal response exists",
            )
            .with_recovery(
                "Inspect the task state before deciding whether to use a new UUIDv7 key.",
            ),
        ),
        BeginDecision::Dispatch => RpcResponse::failure(
            request_id,
            Outcome::Unknown,
            RpcError::new(
                "journal_corrupt",
                "Mutation lookup returned a new-dispatch decision",
            ),
        ),
    }
}

fn native_event_result(response: RpcResponse) -> NativeEventResult {
    match (response.result, response.error) {
        (Some(result), None) => NativeEventResult::completed(result),
        (None, Some(error)) => NativeEventResult::failure(response.outcome, error),
        _ => NativeEventResult::failure(
            Outcome::Unknown,
            RpcError::new(
                "invalid_native_response",
                "Host popup approval did not produce exactly one response branch",
            ),
        ),
    }
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
        RequestLockScope::Global => "global".into(),
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
            "Inspect the page, then request and review a new staged operation with a new UUIDv7 idempotency key.",
        ),
        JournalError::StaleStagedCommit | JournalError::InvalidStagedBinding => (
            "staged_token_stale",
            "Page state or task ownership changed; request and review a new staged operation.",
        ),
        JournalError::TabNotOwned { .. } => (
            "tab_not_owned",
            "Open a task tab or explicitly adopt the active tab before using it.",
        ),
        JournalError::StalePageRevision { .. } => (
            "stale_page_revision",
            "Take a new snapshot and use its current page_revision.",
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
        ConnectKind, NativeInventoryEvent, NativeOriginPolicy, NativeResponse, NativeResponseKind,
        NativeStagedCommit, NativeTab, ResumeCapabilityConfirm, ResumeCapabilityConfirmKind,
        RPC_PROTOCOL,
    };
    use parking_lot::Mutex;
    use serde_json::json;
    use std::sync::atomic::{AtomicUsize, Ordering};

    #[derive(Debug)]
    struct FakeNative {
        calls: AtomicUsize,
        staged: Mutex<bool>,
        staged_effect: Mutex<String>,
        sensitive_error: bool,
        close_task_error: bool,
        current_commit_origin: Mutex<Option<String>>,
        executed_commits: AtomicUsize,
        origin_policies: Mutex<Vec<Option<NativeOriginPolicy>>>,
        last_params: Mutex<Option<Value>>,
        last_act_params: Mutex<Option<Value>>,
        closed_tasks: Mutex<Vec<Uuid>>,
    }

    impl FakeNative {
        fn normal() -> Arc<Self> {
            Arc::new(Self {
                calls: AtomicUsize::new(0),
                staged: Mutex::new(false),
                staged_effect: Mutex::new("submit purchase".into()),
                sensitive_error: false,
                close_task_error: false,
                current_commit_origin: Mutex::new(None),
                executed_commits: AtomicUsize::new(0),
                origin_policies: Mutex::new(Vec::new()),
                last_params: Mutex::new(None),
                last_act_params: Mutex::new(None),
                closed_tasks: Mutex::new(Vec::new()),
            })
        }

        fn failing() -> Arc<Self> {
            Arc::new(Self {
                calls: AtomicUsize::new(0),
                staged: Mutex::new(false),
                sensitive_error: true,
                staged_effect: Mutex::new("submit purchase".into()),
                close_task_error: false,
                current_commit_origin: Mutex::new(None),
                executed_commits: AtomicUsize::new(0),
                origin_policies: Mutex::new(Vec::new()),
                last_params: Mutex::new(None),
                closed_tasks: Mutex::new(Vec::new()),
                last_act_params: Mutex::new(None),
            })
        }

        fn staging() -> Arc<Self> {
            Arc::new(Self {
                calls: AtomicUsize::new(0),
                staged: Mutex::new(true),
                sensitive_error: false,
                staged_effect: Mutex::new("submit purchase".into()),
                close_task_error: false,
                current_commit_origin: Mutex::new(None),
                executed_commits: AtomicUsize::new(0),
                origin_policies: Mutex::new(Vec::new()),
                last_params: Mutex::new(None),
                last_act_params: Mutex::new(None),
                closed_tasks: Mutex::new(Vec::new()),
            })
        }

        fn cleanup_fails() -> Arc<Self> {
            Arc::new(Self {
                calls: AtomicUsize::new(0),
                staged: Mutex::new(false),
                sensitive_error: false,
                staged_effect: Mutex::new("submit purchase".into()),
                close_task_error: true,
                current_commit_origin: Mutex::new(None),
                executed_commits: AtomicUsize::new(0),
                origin_policies: Mutex::new(Vec::new()),
                last_params: Mutex::new(None),
                last_act_params: Mutex::new(None),
                closed_tasks: Mutex::new(Vec::new()),
            })
        }
    }
    impl NativeTransport for FakeNative {
        fn dispatch(
            &self,
            _connection_id: Uuid,
            task_id: Uuid,
            method: &str,
            params: Value,
            origin_policy: Option<NativeOriginPolicy>,
            _timeout: Duration,
        ) -> Result<agenttab_protocol::NativeResponse, NativeError> {
            *self.last_params.lock() = Some(params.clone());
            if method == "browser_act" {
                *self.last_act_params.lock() = Some(params.clone());
            }
            self.origin_policies.lock().push(origin_policy.clone());
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
                        effect: self.staged_effect.lock().clone(),
                        fingerprint: "f".repeat(64),
                        expires_at_ms: current_time_ms() + 60_000,
                    }),
                });
            }
            if method == "browser_commit" {
                // This fixture models the extension's just-in-time origin recheck.
                let is_denied_current_origin = self.current_commit_origin.lock().as_deref()
                    == Some("https://private.example.com/path")
                    && origin_policy.as_ref().is_some_and(|policy| {
                        policy.tab_id == 3
                            && policy
                                .denied_origins
                                .iter()
                                .any(|pattern| pattern == "*.example.com")
                    });
                if is_denied_current_origin {
                    return Ok(NativeResponse {
                        protocol: agenttab_protocol::NATIVE_PROTOCOL.into(),
                        version: PROTOCOL_VERSION,
                        kind: NativeResponseKind::Response,
                        request_id: Uuid::new_v4(),
                        outcome: Outcome::NotStarted,
                        result: None,
                        error: Some(RpcError::new(
                            "origin_denied",
                            "The current tab origin is denied by managed policy",
                        )),
                        staged: None,
                    });
                }
                self.executed_commits.fetch_add(1, Ordering::Relaxed);
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
        fn close_task(&self, task_id: Uuid, _timeout: Duration) -> Result<(), NativeError> {
            self.closed_tasks.lock().push(task_id);
            if self.close_task_error {
                return Err(NativeError::Disconnected);
            }
            Ok(())
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
            _origin_policy: Option<NativeOriginPolicy>,
            _timeout: Duration,
        ) -> Result<NativeResponse, NativeError> {
            Err(NativeError::Timeout)
        }
    }

    #[derive(Debug)]
    struct OversizedNative;

    impl NativeTransport for OversizedNative {
        fn dispatch(
            &self,
            _connection_id: Uuid,
            _task_id: Uuid,
            _method: &str,
            _params: Value,
            _origin_policy: Option<NativeOriginPolicy>,
            _timeout: Duration,
        ) -> Result<NativeResponse, NativeError> {
            Ok(NativeResponse {
                protocol: agenttab_protocol::NATIVE_PROTOCOL.into(),
                version: PROTOCOL_VERSION,
                kind: NativeResponseKind::Response,
                request_id: Uuid::new_v4(),
                outcome: Outcome::Completed,
                result: Some(json!({"body": "x".repeat(HOST_TO_CLIENT_MAX_BYTES)})),
                error: None,
                staged: None,
            })
        }
    }
    #[derive(Debug)]
    struct RejectedHandoffNative;

    impl NativeTransport for RejectedHandoffNative {
        fn dispatch(
            &self,
            _connection_id: Uuid,
            _task_id: Uuid,
            _method: &str,
            _params: Value,
            _origin_policy: Option<NativeOriginPolicy>,
            _timeout: Duration,
        ) -> Result<NativeResponse, NativeError> {
            Ok(NativeResponse {
                protocol: agenttab_protocol::NATIVE_PROTOCOL.into(),
                version: PROTOCOL_VERSION,
                kind: NativeResponseKind::Response,
                request_id: Uuid::new_v4(),
                outcome: Outcome::NotStarted,
                result: None,
                error: Some(RpcError::new(
                    "handoff_declined",
                    "The handoff did not start",
                )),
                staged: None,
            })
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

    fn connected_runtime_with_policy(
        native: Arc<dyn NativeTransport>,
        policy: &str,
    ) -> (tempfile::TempDir, Arc<Runtime>, Arc<ConnectionContext>) {
        let temp = tempfile::tempdir().unwrap();
        let paths = AgentTabPaths::from_root(temp.path().join("agenttab"));
        paths.prepare().unwrap();
        std::fs::write(&paths.policy_file, policy).unwrap();
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

    fn connected_runtime_with_upload_root(
        native: Arc<dyn NativeTransport>,
    ) -> (
        tempfile::TempDir,
        Arc<Runtime>,
        Arc<ConnectionContext>,
        PathBuf,
    ) {
        let temp = tempfile::tempdir().unwrap();
        let upload_root = temp.path().join("allowed-uploads");
        std::fs::create_dir(&upload_root).unwrap();
        let paths = AgentTabPaths::from_root(temp.path().join("agenttab"));
        paths.prepare().unwrap();
        std::fs::write(
            &paths.policy_file,
            serde_json::to_vec(&json!({
                "dlp_allowed_roots": [upload_root],
            }))
            .unwrap(),
        )
        .unwrap();
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
        (temp, runtime, connection, upload_root)
    }
    #[test]
    fn invalid_request_uses_a_schema_valid_fallback_id() {
        let (_temp, runtime, connection) = connected_runtime(FakeNative::normal());
        let response = runtime.handle(
            &connection,
            json!({
                "protocol": RPC_PROTOCOL,
                "version": PROTOCOL_VERSION,
                "request_id": "x".repeat(129),
                "method": "unknown",
                "params": {}
            }),
        );
        assert_eq!(response["request_id"], "invalid-request");
        assert_eq!(response["error"]["code"], "invalid_request");
    }

    #[test]
    fn oversized_response_still_carries_the_initial_resume_capability() {
        let (_temp, runtime, connection) = connected_runtime(Arc::new(OversizedNative));
        let response = runtime.handle(
            &connection,
            json!({
                "protocol": RPC_PROTOCOL,
                "version": PROTOCOL_VERSION,
                "request_id": "oversized-tabs",
                "method": "browser_tabs",
                "params": {}
            }),
        );

        assert_eq!(response["error"]["code"], "response_too_large");
        assert!(response["task"]["resume_capability"].is_string());
        assert!(connection.resume_confirmation_required());
    }

    #[test]
    fn disconnect_closes_a_task_whose_capability_was_not_confirmed() {
        let native = FakeNative::normal();
        let (_temp, runtime, connection) = connected_runtime(native.clone());
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
        let capability = response["task"]["resume_capability"]
            .as_str()
            .unwrap()
            .to_string();
        let task_id = response["task"]["task_id"]
            .as_str()
            .unwrap()
            .parse::<Uuid>()
            .unwrap();
        connection.finish_new_capability_delivery(true);
        assert!(connection.resume_confirmation_required());

        runtime.disconnect(&connection).unwrap();

        assert_eq!(*native.closed_tasks.lock(), vec![task_id]);
        assert!(runtime.journal.resume_task(&capability).unwrap().is_none());
    }

    #[test]
    fn disconnect_keeps_an_undelivered_task_open_when_extension_cleanup_disconnects() {
        let native = FakeNative::cleanup_fails();
        let (_temp, runtime, connection) = connected_runtime(native.clone());
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
        let capability = response["task"]["resume_capability"]
            .as_str()
            .unwrap()
            .to_string();

        let error = runtime.disconnect(&connection).unwrap_err();

        assert!(matches!(error, JournalError::NativeTaskCleanup(_)));
        assert_eq!(native.closed_tasks.lock().len(), 1);
        assert!(runtime.journal.resume_task(&capability).unwrap().is_some());
    }

    fn confirm_new_capability(
        runtime: &Runtime,
        connection: &ConnectionContext,
        resume_capability: String,
    ) {
        connection.finish_new_capability_delivery(true);
        connection
            .confirm_resume_capability(
                &ResumeCapabilityConfirm {
                    protocol: RPC_PROTOCOL.into(),
                    version: PROTOCOL_VERSION,
                    kind: ResumeCapabilityConfirmKind::ResumeConfirm,
                    connection_id: connection.connection_id,
                    resume_capability,
                },
                &runtime.journal,
            )
            .unwrap();
    }

    fn own_tab(runtime: &Runtime, connection: &ConnectionContext, page_revision: u64) -> Uuid {
        let task_id = connection.ensure_task(&runtime.journal).unwrap();
        let capability = connection
            .reserve_new_capability()
            .unwrap()
            .expect("new task capability must be delivered before browser work");
        confirm_new_capability(runtime, connection, capability.resume_capability);
        runtime
            .journal
            .reconcile_inventory(&[NativeTab {
                tab_id: 3,
                window_id: 1,
                group_id: Some(9),
                url: "https://allowed.test/".into(),
                page_revision,
                task_id: Some(task_id),
            }])
            .unwrap();
        runtime
            .tab_urls
            .write()
            .insert(3, "https://allowed.test/".into());
        task_id
    }

    #[test]
    fn stale_inventory_event_is_ignored_without_regressing_runtime_state() {
        let native = FakeNative::normal();
        let (_temp, runtime, connection) = connected_runtime(native);
        let task_id = own_tab(&runtime, &connection, 10);
        let sink = JournalNativeEventSink {
            journal: runtime.journal.clone(),
            tab_urls: runtime.tab_urls.clone(),
            runtime: Mutex::new(Arc::downgrade(&runtime)),
        };

        let result = sink
            .handle(
                &NativeEventPayload::Inventory(NativeInventoryEvent {
                    inventory: vec![NativeTab {
                        tab_id: 3,
                        window_id: 1,
                        group_id: Some(9),
                        url: "https://stale.test/".into(),
                        page_revision: 9,
                        task_id: Some(task_id),
                    }],
                }),
                None,
            )
            .unwrap();

        assert_eq!(result.outcome, Outcome::Completed);
        assert_eq!(result.result, Some(json!({ "ignored_stale": true })));
        assert_eq!(
            runtime.tab_urls.read().get(&3).map(String::as_str),
            Some("https://allowed.test/")
        );
        assert_eq!(
            runtime
                .journal
                .verify_task_tab(task_id, 3, Some(10))
                .unwrap(),
            10
        );
    }

    #[test]
    fn completed_mutation_replays_through_pause_without_redispatch_or_plaintext_secrets() {
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
        let capability = first["task"]["resume_capability"]
            .as_str()
            .expect("first response must carry the new task capability")
            .to_string();
        assert!(!capability.is_empty());
        assert!(!first["result"]["body"]
            .as_str()
            .unwrap()
            .contains("123-45-6789"));
        confirm_new_capability(&runtime, &connection, capability);
        runtime.lifecycle.set_paused(true);
        let mut retry = request;
        retry["request_id"] = json!("retry");
        let second = runtime.handle(&connection, retry);
        assert_eq!(second["outcome"], first["outcome"]);
        assert_eq!(second["result"], first["result"]);
        assert_eq!(second["task"]["task_id"], first["task"]["task_id"]);
        assert!(second["task"].get("resume_capability").is_none());
        assert_eq!(native.calls.load(Ordering::Relaxed), 1);

        assert_eq!(second["request_id"], "retry");
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
    fn browser_global_requests_share_one_lock_across_tasks() {
        let first_task = Uuid::new_v4();
        let second_task = Uuid::new_v4();
        assert_eq!(
            request_lock_key(first_task, RpcMethod::BrowserOpen, &json!({})),
            request_lock_key(second_task, RpcMethod::BrowserOpen, &json!({}))
        );
        assert_ne!(
            request_lock_key(first_task, RpcMethod::BrowserAct, &json!({"tab_id": 7})),
            request_lock_key(second_task, RpcMethod::BrowserAct, &json!({"tab_id": 7}))
        );
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
            r#"{"developer_enabled":true,"denied_origins":["*.example.com"]}"#,
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
        own_tab(&runtime, &connection, 7);
        runtime.tab_urls.write().remove(&3);
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
        assert_eq!(
            native.origin_policies.lock().as_slice(),
            &[Some(NativeOriginPolicy {
                tab_id: 3,
                allowed_origins: Vec::new(),
                denied_origins: vec!["*.example.com".into()],
            })]
        );
        assert_eq!(allowed["outcome"], "completed");
        assert_eq!(native.calls.load(Ordering::Relaxed), 1);
        let developer = runtime.handle(
            &connection,
            json!({
                "protocol": RPC_PROTOCOL,
                "version": PROTOCOL_VERSION,
                "request_id": "developer",
                "idempotency_key": Uuid::now_v7(),
                "method": "browser_developer",
                "params": {
                    "action": "Runtime.evaluate",
                    "params": {"tab_id": 3, "expression": "document.title"}
                }
            }),
        );
        assert_eq!(developer["outcome"], "completed");
        assert_eq!(
            native.origin_policies.lock().last(),
            Some(&Some(NativeOriginPolicy {
                tab_id: 3,
                allowed_origins: Vec::new(),
                denied_origins: vec!["*.example.com".into()],
            }))
        );
        runtime
            .tab_urls
            .write()
            .insert(3, "chrome://settings/".into());
        let blocked_system_snapshot = runtime.handle(&connection, snapshot("system-snapshot"));
        assert_eq!(blocked_system_snapshot["error"]["code"], "scheme_denied");
        let navigate_away = runtime.handle(
            &connection,
            json!({
                "protocol": RPC_PROTOCOL,
                "version": PROTOCOL_VERSION,
                "request_id": "system-navigate",
                "idempotency_key": Uuid::now_v7(),
                "method": "browser_act",
                "params": {
                    "tab_id": 3,
                    "expected_page_revision": 7,
                    "actions": [{"kind": "navigate", "url": "https://allowed.test/recovered"}]
                }
            }),
        );
        assert_eq!(navigate_away["outcome"], "completed");
        let wait_for_system_url = runtime.handle(
            &connection,
            json!({
                "protocol": RPC_PROTOCOL,
                "version": PROTOCOL_VERSION,
                "request_id": "system-url-wait",
                "method": "browser_wait",
                "params": {
                    "tab_id": 3,
                    "condition": {"kind": "url", "value": "chrome://settings/"},
                    "timeout_ms": 100
                }
            }),
        );
        assert_eq!(wait_for_system_url["outcome"], "completed");
        let system_handoff = runtime.handle(
            &connection,
            json!({
                "protocol": RPC_PROTOCOL,
                "version": PROTOCOL_VERSION,
                "request_id": "system-handoff",
                "idempotency_key": Uuid::now_v7(),
                "method": "browser_handoff",
                "params": {
                    "tab_id": 3,
                    "expected_page_revision": 7,
                    "prompt": "Inspect browser settings",
                    "completion": {"kind": "manual_done"},
                    "timeout_ms": 1000
                }
            }),
        );
        assert_eq!(system_handoff["outcome"], "completed", "{system_handoff}");
    }
    #[test]
    fn commit_rechecks_staged_tab_policy_after_navigation() {
        let native = FakeNative::staging();
        let (_temp, runtime, connection) = connected_runtime_with_policy(
            native.clone(),
            r#"{"denied_origins":["*.example.com"]}"#,
        );
        let task_id = own_tab(&runtime, &connection, 7);

        let staged = runtime.handle(
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
        assert_eq!(staged["outcome"], "commit_required");
        let review_handle = native.last_params.lock().as_ref().unwrap()["review_handle"]
            .as_str()
            .unwrap()
            .to_owned();
        assert!(matches!(
            runtime
                .journal
                .approve_popup_staged_commit(task_id, 3, &review_handle),
            Ok(StagedCommitApproval::Approved)
        ));

        *native.staged.lock() = false;
        // The host's last inventory URL remains allowed; native sees the navigation that
        // happened before Commit execution and must recheck the forwarded tab policy.
        *native.current_commit_origin.lock() = Some("https://private.example.com/path".into());
        let committed = runtime.handle(
            &connection,
            json!({
                "protocol": RPC_PROTOCOL,
                "version": PROTOCOL_VERSION,
                "request_id": "commit",
                "idempotency_key": Uuid::now_v7(),
                "method": "browser_commit",
                "params": {"staged_token": staged["result"]["staged_token"]}
            }),
        );

        let expected_policy = Some(NativeOriginPolicy {
            tab_id: 3,
            allowed_origins: Vec::new(),
            denied_origins: vec!["*.example.com".into()],
        });
        assert_eq!(committed["outcome"], "not_started");
        assert_eq!(committed["error"]["code"], "origin_denied");
        assert_eq!(
            native.origin_policies.lock().as_slice(),
            &[expected_policy.clone(), None, expected_policy],
        );
        assert_eq!(native.executed_commits.load(Ordering::Relaxed), 0);
    }

    #[test]
    fn handoff_timeout_keeps_global_blackout_active() {
        let (_temp, runtime, connection) = connected_runtime(Arc::new(TimeoutNative));
        own_tab(&runtime, &connection, 7);
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
    fn rejected_handoff_releases_global_blackout() {
        let (_temp, runtime, connection) = connected_runtime(Arc::new(RejectedHandoffNative));
        own_tab(&runtime, &connection, 7);
        let response = runtime.handle(
            &connection,
            json!({
                "protocol": RPC_PROTOCOL,
                "version": PROTOCOL_VERSION,
                "request_id": "handoff-rejected",
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
        assert_eq!(response["outcome"], "not_started");
        assert_eq!(response["error"]["code"], "handoff_declined");
        assert!(!runtime.handoff.is_active());
    }

    #[test]
    fn popup_review_approves_then_public_commit_executes_once() {
        let native = FakeNative::staging();
        let (temp, runtime, connection) = connected_runtime(native.clone());
        let task_id = own_tab(&runtime, &connection, 7);
        let stage = runtime.handle(
            &connection,
            json!({
                "protocol": RPC_PROTOCOL,
                "version": PROTOCOL_VERSION,
                "request_id": "stage-popup",
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
        let staged_token = stage["result"]["staged_token"].as_str().unwrap().to_owned();
        let review_handle = native.last_params.lock().as_ref().unwrap()["review_handle"]
            .as_str()
            .unwrap()
            .to_owned();
        assert_ne!(review_handle, "native-token-123456");
        *native.staged.lock() = false;

        let waiting = runtime.handle(
            &connection,
            json!({
                "protocol": RPC_PROTOCOL,
                "version": PROTOCOL_VERSION,
                "request_id": "commit-before-approval",
                "idempotency_key": Uuid::now_v7(),
                "method": "browser_commit",
                "params": {"staged_token": staged_token}
            }),
        );
        assert_eq!(waiting["outcome"], "commit_required");
        assert_eq!(waiting["result"]["awaiting_human_approval"], true);
        assert_eq!(native.executed_commits.load(Ordering::Relaxed), 0);

        let event = NativePopupCommitEvent {
            review_handle,
            task_id,
            tab_id: 3,
        };
        let event_id = Uuid::now_v7().to_string();
        let approved = runtime.commit_popup_review(&event, &event_id);
        assert_eq!(approved.outcome, Outcome::Completed);
        assert_eq!(approved.result.as_ref().unwrap()["approved"], true);
        assert_eq!(native.executed_commits.load(Ordering::Relaxed), 0);
        let replayed = runtime.commit_popup_review(&event, &event_id);
        assert_eq!(replayed.outcome, Outcome::Completed);
        assert_eq!(native.executed_commits.load(Ordering::Relaxed), 0);

        let committed = runtime.handle(
            &connection,
            json!({
                "protocol": RPC_PROTOCOL,
                "version": PROTOCOL_VERSION,
                "request_id": "commit-after-approval",
                "idempotency_key": Uuid::now_v7(),
                "method": "browser_commit",
                "params": {"staged_token": staged_token}
            }),
        );
        assert_eq!(committed["outcome"], "completed");
        assert_eq!(native.executed_commits.load(Ordering::Relaxed), 1);
        assert_eq!(
            native.last_params.lock().as_ref(),
            Some(&json!({"native_token": "native-token-123456"})),
        );
        let audit = std::fs::read_to_string(temp.path().join("agenttab/audit.jsonl")).unwrap();
        assert!(audit.contains("\"method\":\"browser_commit\""));
        assert!(audit.contains(&event_id));
        assert!(!audit.contains(&event.review_handle));
        assert!(runtime
            .journal
            .approve_popup_staged_commit(task_id, 3, &event.review_handle)
            .is_err());
    }
    #[test]
    fn approved_close_commit_ignores_stale_denied_cached_url() {
        let native = FakeNative::staging();
        *native.staged_effect.lock() = CLOSE_TAB_STAGED_EFFECT.into();
        let (_temp, runtime, connection) = connected_runtime_with_policy(
            native.clone(),
            r#"{"denied_origins":["*.example.com"]}"#,
        );
        let task_id = own_tab(&runtime, &connection, 7);
        runtime
            .tab_urls
            .write()
            .insert(3, "https://private.example.com/stale".into());
        let stage = runtime.handle(
            &connection,
            json!({
                "protocol": RPC_PROTOCOL,
                "version": PROTOCOL_VERSION,
                "request_id": "stage-restricted-close",
                "idempotency_key": Uuid::now_v7(),
                "method": "browser_act",
                "params": {
                    "tab_id": 3,
                    "expected_page_revision": 7,
                    "actions": [{"kind": "close"}]
                }
            }),
        );
        assert_eq!(stage["outcome"], "commit_required");
        let staged_token = stage["result"]["staged_token"].as_str().unwrap().to_owned();
        let review_handle = native.last_params.lock().as_ref().unwrap()["review_handle"]
            .as_str()
            .unwrap()
            .to_owned();
        *native.staged.lock() = false;
        let approved = runtime.commit_popup_review(
            &NativePopupCommitEvent {
                review_handle,
                task_id,
                tab_id: 3,
            },
            &Uuid::now_v7().to_string(),
        );
        assert_eq!(approved.outcome, Outcome::Completed);

        let committed = runtime.handle(
            &connection,
            json!({
                "protocol": RPC_PROTOCOL,
                "version": PROTOCOL_VERSION,
                "request_id": "commit-restricted-close",
                "idempotency_key": Uuid::now_v7(),
                "method": "browser_commit",
                "params": {"staged_token": staged_token}
            }),
        );
        assert_eq!(committed["outcome"], "completed");
        assert_eq!(native.executed_commits.load(Ordering::Relaxed), 1);
        assert_eq!(
            native.origin_policies.lock().last(),
            Some(&Some(NativeOriginPolicy {
                tab_id: 3,
                allowed_origins: Vec::new(),
                denied_origins: vec!["*.example.com".into()],
            }))
        );
    }

    #[test]
    fn popup_review_rejects_mismatched_or_unknown_handles_without_execution() {
        let native = FakeNative::staging();
        let (_temp, runtime, connection) = connected_runtime(native.clone());
        let task_id = own_tab(&runtime, &connection, 7);
        let stage = runtime.handle(
            &connection,
            json!({
                "protocol": RPC_PROTOCOL,
                "version": PROTOCOL_VERSION,
                "request_id": "stage-popup-rejection",
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
        let staged_token = stage["result"]["staged_token"].as_str().unwrap().to_owned();
        let review_handle = native.last_params.lock().as_ref().unwrap()["review_handle"]
            .as_str()
            .unwrap()
            .to_owned();
        *native.staged.lock() = false;

        let mismatched = runtime.commit_popup_review(
            &NativePopupCommitEvent {
                review_handle: review_handle.clone(),
                task_id,
                tab_id: 4,
            },
            &Uuid::now_v7().to_string(),
        );
        assert_eq!(mismatched.outcome, Outcome::NotStarted);
        assert_eq!(native.executed_commits.load(Ordering::Relaxed), 0);
        let foreign_task = runtime.commit_popup_review(
            &NativePopupCommitEvent {
                review_handle: review_handle.clone(),
                task_id: Uuid::now_v7(),
                tab_id: 3,
            },
            &Uuid::now_v7().to_string(),
        );
        assert_eq!(foreign_task.outcome, Outcome::NotStarted);
        assert_eq!(native.executed_commits.load(Ordering::Relaxed), 0);

        let approved_event = NativePopupCommitEvent {
            review_handle: review_handle.clone(),
            task_id,
            tab_id: 3,
        };
        let approved_event_id = Uuid::now_v7().to_string();
        assert_eq!(
            runtime
                .commit_popup_review(&approved_event, &approved_event_id)
                .outcome,
            Outcome::Completed
        );
        assert_eq!(native.executed_commits.load(Ordering::Relaxed), 0);

        let unknown = runtime.commit_popup_review(
            &NativePopupCommitEvent {
                review_handle: "missing-review-handle".into(),
                task_id,
                tab_id: 3,
            },
            &Uuid::now_v7().to_string(),
        );
        assert_eq!(unknown.outcome, Outcome::NotStarted);
        assert_eq!(native.executed_commits.load(Ordering::Relaxed), 0);
        let conflicting_intent = runtime.abandon_popup_review(&approved_event, &approved_event_id);
        assert_eq!(conflicting_intent.outcome, Outcome::NotStarted);
        assert_eq!(native.executed_commits.load(Ordering::Relaxed), 0);
        let committed = runtime.handle(
            &connection,
            json!({
                "protocol": RPC_PROTOCOL,
                "version": PROTOCOL_VERSION,
                "request_id": "commit-approved-review",
                "idempotency_key": Uuid::now_v7(),
                "method": "browser_commit",
                "params": {"staged_token": staged_token}
            }),
        );
        assert_eq!(committed["outcome"], "completed");
        assert_eq!(native.executed_commits.load(Ordering::Relaxed), 1);
    }

    #[test]
    fn host_token_is_bound_and_native_commit_token_is_never_exposed() {
        let native = FakeNative::staging();
        let (_temp, runtime, connection) = connected_runtime(native.clone());
        let task_id = own_tab(&runtime, &connection, 7);
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
        let token = stage["result"]["staged_token"].as_str().unwrap().to_owned();
        let review_handle = native.last_params.lock().as_ref().unwrap()["review_handle"]
            .as_str()
            .unwrap()
            .to_owned();
        *native.staged.lock() = false;
        assert_eq!(
            runtime
                .commit_popup_review(
                    &NativePopupCommitEvent {
                        review_handle,
                        task_id,
                        tab_id: 3,
                    },
                    &Uuid::now_v7().to_string(),
                )
                .outcome,
            Outcome::Completed,
        );
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
        assert_eq!(
            native.last_params.lock().as_ref(),
            Some(&json!({"native_token": "native-token-123456"})),
        );
    }

    #[test]
    fn expired_staged_act_replay_replaces_the_cached_review_without_redispatch() {
        let native = FakeNative::staging();
        let (temp, runtime, connection, upload_root) =
            connected_runtime_with_upload_root(native.clone());
        let task_id = own_tab(&runtime, &connection, 7);
        let source = upload_root.join("expired-replay.txt");
        std::fs::write(&source, b"expired staged upload").unwrap();
        let action_key = Uuid::now_v7();
        let action_params = json!({
            "tab_id": 3,
            "expected_page_revision": 7,
            "actions": [{
                "kind": "upload_file",
                "ref": "e9",
                "files": [source],
            }]
        });
        let action = |request_id: &str| {
            json!({
                "protocol": RPC_PROTOCOL,
                "version": PROTOCOL_VERSION,
                "request_id": request_id,
                "idempotency_key": action_key,
                "method": "browser_act",
                "params": action_params.clone(),
            })
        };
        let staged = runtime.handle(&connection, action("stage-expired-replay"));
        assert_eq!(staged["outcome"], "commit_required");
        let staged_path = native.last_act_params.lock().as_ref().unwrap()["actions"][0]["files"][0]
            .as_str()
            .unwrap()
            .to_owned();
        let calls_before_replay = native.calls.load(Ordering::Relaxed);
        rusqlite::Connection::open(temp.path().join("agenttab/state.sqlite3"))
            .unwrap()
            .execute(
                "UPDATE staged_commits SET expires_at_ms = ?1 WHERE native_token = ?2",
                rusqlite::params![current_time_ms() - 1, "native-token-123456"],
            )
            .unwrap();
        let expired_uploads = runtime.journal.reconcile_staged_commits(&[]).unwrap();
        assert_eq!(
            expired_uploads,
            vec![std::path::PathBuf::from(&staged_path)]
        );
        JournalNativeEventSink::cleanup_uploads(expired_uploads).unwrap();
        assert!(!std::path::Path::new(&staged_path).exists());

        let expired = runtime.handle(&connection, action("stage-expired-recovery"));
        assert_eq!(expired["outcome"], "not_started");
        assert_eq!(expired["error"]["code"], "staged_token_invalid");
        assert!(expired["error"]["recovery"]
            .as_str()
            .unwrap()
            .contains("new UUIDv7 idempotency key"));
        assert_eq!(native.calls.load(Ordering::Relaxed), calls_before_replay);
        assert!(!std::path::Path::new(&staged_path).exists());

        let replayed = runtime.handle(&connection, action("stage-expired-recovery-again"));
        assert_eq!(replayed["outcome"], expired["outcome"]);
        assert_eq!(replayed["error"], expired["error"]);
        assert_eq!(native.calls.load(Ordering::Relaxed), calls_before_replay);
        let BeginDecision::Cached(cached) = runtime
            .journal
            .lookup_mutation(
                task_id,
                action_key,
                RpcMethod::BrowserAct,
                &request_hash(RpcMethod::BrowserAct, &action_params),
            )
            .unwrap()
            .unwrap()
        else {
            panic!("expired staged action must retain a terminal cached response");
        };
        assert_eq!(cached["outcome"], "not_started");
        assert_eq!(cached["error"]["code"], "staged_token_invalid");
    }

    #[test]
    fn consumed_staged_act_replay_never_replays_a_dead_review_token() {
        let native = FakeNative::staging();
        let (_temp, runtime, connection) = connected_runtime(native.clone());
        let task_id = own_tab(&runtime, &connection, 7);
        let action_key = Uuid::now_v7();
        let action_params = json!({
            "tab_id": 3,
            "expected_page_revision": 7,
            "actions": [{"kind": "click", "ref": "e9"}]
        });
        let action = |request_id: &str| {
            json!({
                "protocol": RPC_PROTOCOL,
                "version": PROTOCOL_VERSION,
                "request_id": request_id,
                "idempotency_key": action_key,
                "method": "browser_act",
                "params": action_params.clone(),
            })
        };
        let staged = runtime.handle(&connection, action("stage-consumed-replay"));
        assert_eq!(staged["outcome"], "commit_required");
        let staged_token = staged["result"]["staged_token"].as_str().unwrap();
        let review_handle = native.last_params.lock().as_ref().unwrap()["review_handle"]
            .as_str()
            .unwrap()
            .to_owned();
        assert!(matches!(
            runtime
                .journal
                .approve_popup_staged_commit(task_id, 3, &review_handle),
            Ok(StagedCommitApproval::Approved)
        ));
        assert!(matches!(
            runtime
                .journal
                .consume_staged_commit(task_id, staged_token, Uuid::now_v7()),
            Ok(StagedCommitConsumption::Ready(_))
        ));
        let calls_before_replay = native.calls.load(Ordering::Relaxed);

        let replayed = runtime.handle(&connection, action("stage-consumed-recovery"));
        assert_eq!(replayed["outcome"], "not_started");
        assert_eq!(replayed["error"]["code"], "staged_token_invalid");
        assert_eq!(native.calls.load(Ordering::Relaxed), calls_before_replay);
        let replayed_again = runtime.handle(&connection, action("stage-consumed-recovery-again"));
        assert_eq!(replayed_again["error"], replayed["error"]);
        assert_eq!(native.calls.load(Ordering::Relaxed), calls_before_replay);
    }

    #[test]
    fn expired_pending_commit_recovery_is_terminal_without_native_dispatch() {
        let native = FakeNative::staging();
        let (temp, runtime, connection) = connected_runtime(native.clone());
        let task_id = own_tab(&runtime, &connection, 7);
        let action_key = Uuid::now_v7();
        let stage = runtime.handle(
            &connection,
            json!({
                "protocol": RPC_PROTOCOL,
                "version": PROTOCOL_VERSION,
                "request_id": "stage-pending-commit",
                "idempotency_key": action_key,
                "method": "browser_act",
                "params": {
                    "tab_id": 3,
                    "expected_page_revision": 7,
                    "actions": [{"kind": "click", "ref": "e9"}]
                }
            }),
        );
        assert_eq!(stage["outcome"], "commit_required");
        let staged_token = stage["result"]["staged_token"].as_str().unwrap().to_owned();
        let review_handle = native.last_params.lock().as_ref().unwrap()["review_handle"]
            .as_str()
            .unwrap()
            .to_owned();
        assert!(matches!(
            runtime
                .journal
                .approve_popup_staged_commit(task_id, 3, &review_handle),
            Ok(StagedCommitApproval::Approved)
        ));
        let commit_key = Uuid::now_v7();
        let commit_params = json!({"staged_token": staged_token});
        runtime
            .journal
            .begin_mutation(
                task_id,
                commit_key,
                RpcMethod::BrowserCommit,
                &request_hash(RpcMethod::BrowserCommit, &commit_params),
            )
            .unwrap();
        assert!(matches!(
            runtime
                .journal
                .consume_staged_commit(task_id, &staged_token, commit_key),
            Ok(StagedCommitConsumption::Ready(_))
        ));
        rusqlite::Connection::open(temp.path().join("agenttab/state.sqlite3"))
            .unwrap()
            .execute(
                "UPDATE staged_commits SET expires_at_ms = ?1 WHERE native_token = ?2",
                rusqlite::params![current_time_ms() - 1, "native-token-123456"],
            )
            .unwrap();
        let calls_before_recovery = native.calls.load(Ordering::Relaxed);
        let action_recovered = runtime.handle(
            &connection,
            json!({
                "protocol": RPC_PROTOCOL,
                "version": PROTOCOL_VERSION,
                "request_id": "stage-pending-commit-recovery",
                "idempotency_key": action_key,
                "method": "browser_act",
                "params": {
                    "tab_id": 3,
                    "expected_page_revision": 7,
                    "actions": [{"kind": "click", "ref": "e9"}]
                }
            }),
        );
        assert_eq!(action_recovered["outcome"], "not_started");
        assert_eq!(action_recovered["error"]["code"], "staged_token_invalid");
        assert_eq!(native.calls.load(Ordering::Relaxed), calls_before_recovery);
        let BeginDecision::Cached(cached_action) = runtime
            .journal
            .lookup_mutation(
                task_id,
                action_key,
                RpcMethod::BrowserAct,
                &request_hash(
                    RpcMethod::BrowserAct,
                    &json!({
                        "tab_id": 3,
                        "expected_page_revision": 7,
                        "actions": [{"kind": "click", "ref": "e9"}]
                    }),
                ),
            )
            .unwrap()
            .unwrap()
        else {
            panic!("expired action replay must terminalize its cached review");
        };
        assert_eq!(cached_action["outcome"], "not_started");
        assert!(runtime
            .journal
            .reconcile_staged_commits(&[])
            .unwrap()
            .is_empty());
        let commit = |request_id: &str| {
            json!({
                "protocol": RPC_PROTOCOL,
                "version": PROTOCOL_VERSION,
                "request_id": request_id,
                "idempotency_key": commit_key,
                "method": "browser_commit",
                "params": commit_params.clone(),
            })
        };

        let recovered = runtime.handle(&connection, commit("pending-commit-recovery"));
        assert_eq!(recovered["outcome"], "not_started");
        assert_eq!(recovered["error"]["code"], "staged_token_invalid");
        assert_eq!(native.calls.load(Ordering::Relaxed), calls_before_recovery);
        assert_eq!(native.executed_commits.load(Ordering::Relaxed), 0);

        let replayed = runtime.handle(&connection, commit("pending-commit-recovery-again"));
        assert_eq!(replayed["outcome"], recovered["outcome"]);
        assert_eq!(replayed["error"], recovered["error"]);
        assert_eq!(native.calls.load(Ordering::Relaxed), calls_before_recovery);
        let BeginDecision::Cached(cached) = runtime
            .journal
            .lookup_mutation(
                task_id,
                commit_key,
                RpcMethod::BrowserCommit,
                &request_hash(RpcMethod::BrowserCommit, &commit_params),
            )
            .unwrap()
            .unwrap()
        else {
            panic!("expired pending commit must replace its unknown journal record");
        };
        assert_eq!(cached["outcome"], "not_started");
        assert_eq!(cached["error"]["code"], "staged_token_invalid");
    }

    #[test]
    fn staged_upload_survives_review_and_is_removed_after_commit() {
        let native = FakeNative::staging();
        let (_temp, runtime, connection, upload_root) =
            connected_runtime_with_upload_root(native.clone());
        let task_id = own_tab(&runtime, &connection, 7);
        let source = upload_root.join("fixture.txt");
        std::fs::write(&source, b"approved upload bytes").unwrap();
        let stage = runtime.handle(
            &connection,
            json!({
                "protocol": RPC_PROTOCOL,
                "version": PROTOCOL_VERSION,
                "request_id": "stage-upload",
                "idempotency_key": Uuid::now_v7(),
                "method": "browser_act",
                "params": {
                    "tab_id": 3,
                    "expected_page_revision": 7,
                    "actions": [{
                        "kind": "upload_file",
                        "ref": "e9",
                        "files": [source],
                    }]
                }
            }),
        );
        assert_eq!(stage["outcome"], "commit_required");
        let staged_path = native.last_act_params.lock().as_ref().unwrap()["actions"][0]["files"][0]
            .as_str()
            .unwrap()
            .to_string();
        assert_eq!(
            std::fs::read(&staged_path).unwrap(),
            b"approved upload bytes"
        );
        let review_handle = native.last_params.lock().as_ref().unwrap()["review_handle"]
            .as_str()
            .unwrap()
            .to_owned();
        assert!(matches!(
            runtime
                .journal
                .approve_popup_staged_commit(task_id, 3, &review_handle),
            Ok(StagedCommitApproval::Approved)
        ));

        *native.staged.lock() = false;
        let committed = runtime.handle(
            &connection,
            json!({
                "protocol": RPC_PROTOCOL,
                "version": PROTOCOL_VERSION,
                "request_id": "commit-upload",
                "idempotency_key": Uuid::now_v7(),
                "method": "browser_commit",
                "params": {"staged_token": stage["result"]["staged_token"]}
            }),
        );

        assert_eq!(committed["outcome"], "completed");
        assert!(!std::path::Path::new(&staged_path).exists());
    }

    #[test]
    fn popup_review_reconciles_staged_uploads_after_commit_abandon_and_failed_revalidation() {
        let native = FakeNative::staging();
        let (_temp, runtime, connection, upload_root) =
            connected_runtime_with_upload_root(native.clone());
        let task_id = own_tab(&runtime, &connection, 7);
        let sink = JournalNativeEventSink {
            journal: runtime.journal.clone(),
            tab_urls: runtime.tab_urls.clone(),
            runtime: Mutex::new(Arc::downgrade(&runtime)),
        };
        let stage_upload = |request_id: &str, contents: &[u8]| {
            let source = upload_root.join(format!("{request_id}.txt"));
            std::fs::write(&source, contents).unwrap();
            let stage = runtime.handle(
                &connection,
                json!({
                    "protocol": RPC_PROTOCOL,
                    "version": PROTOCOL_VERSION,
                    "request_id": request_id,
                    "idempotency_key": Uuid::now_v7(),
                    "method": "browser_act",
                    "params": {
                        "tab_id": 3,
                        "expected_page_revision": 7,
                        "actions": [{
                            "kind": "upload_file",
                            "ref": "e9",
                            "files": [source],
                        }]
                    }
                }),
            );
            assert_eq!(stage["outcome"], "commit_required");
            let staged_path = native.last_act_params.lock().as_ref().unwrap()["actions"][0]
                ["files"][0]
                .as_str()
                .unwrap()
                .to_owned();
            let review_handle = native.last_params.lock().as_ref().unwrap()["review_handle"]
                .as_str()
                .unwrap()
                .to_owned();
            let staged_token = stage["result"]["staged_token"].as_str().unwrap().to_owned();
            (review_handle, staged_token, staged_path)
        };

        let (success_handle, success_token, success_path) =
            stage_upload("popup-success", b"success");
        *native.staged.lock() = false;
        let success = sink
            .handle(
                &NativeEventPayload::PopupCommitApproved(NativePopupCommitEvent {
                    review_handle: success_handle.clone(),
                    task_id,
                    tab_id: 3,
                }),
                Some(&Uuid::now_v7().to_string()),
            )
            .unwrap();
        assert_eq!(success.outcome, Outcome::Completed);
        assert!(std::path::Path::new(&success_path).exists());
        let committed = runtime.handle(
            &connection,
            json!({
                "protocol": RPC_PROTOCOL,
                "version": PROTOCOL_VERSION,
                "request_id": "commit-popup-success",
                "idempotency_key": Uuid::now_v7(),
                "method": "browser_commit",
                "params": {"staged_token": success_token}
            }),
        );
        assert_eq!(committed["outcome"], "completed");
        assert!(!std::path::Path::new(&success_path).exists());
        assert!(runtime
            .journal
            .abandon_popup_staged_commit(task_id, 3, &success_handle)
            .is_err());

        *native.staged.lock() = true;
        let (abandon_handle, _, abandon_path) = stage_upload("popup-abandon", b"abandon");
        let abandon_event = NativePopupCommitEvent {
            review_handle: abandon_handle.clone(),
            task_id,
            tab_id: 3,
        };
        let abandon_event_id = Uuid::now_v7().to_string();
        let abandoned = sink
            .handle(
                &NativeEventPayload::PopupCommitAbandoned(abandon_event.clone()),
                Some(&abandon_event_id),
            )
            .unwrap();
        assert_eq!(abandoned.outcome, Outcome::Completed);
        assert!(!std::path::Path::new(&abandon_path).exists());
        let abandoned_retry = sink
            .handle(
                &NativeEventPayload::PopupCommitAbandoned(abandon_event),
                Some(&abandon_event_id),
            )
            .unwrap();
        assert_eq!(abandoned_retry.outcome, Outcome::Completed);
        assert!(runtime
            .journal
            .abandon_popup_staged_commit(task_id, 3, &abandon_handle)
            .is_err());

        let (failure_handle, _, failure_path) =
            stage_upload("popup-revalidation-failure", b"failure");
        runtime
            .journal
            .reconcile_inventory(&[NativeTab {
                tab_id: 3,
                window_id: 1,
                group_id: Some(9),
                url: "https://allowed.test/".into(),
                page_revision: 8,
                task_id: Some(task_id),
            }])
            .unwrap();
        let failed = sink
            .handle(
                &NativeEventPayload::PopupCommitApproved(NativePopupCommitEvent {
                    review_handle: failure_handle.clone(),
                    task_id,
                    tab_id: 3,
                }),
                Some(&Uuid::now_v7().to_string()),
            )
            .unwrap();
        assert_eq!(failed.outcome, Outcome::NotStarted);
        assert!(!std::path::Path::new(&failure_path).exists());
        assert!(runtime
            .journal
            .abandon_popup_staged_commit(task_id, 3, &failure_handle)
            .is_err());
    }
    fn current_time_ms() -> i64 {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis() as i64
    }
}
