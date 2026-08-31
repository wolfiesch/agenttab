use crate::handoff::HandoffState;
use crate::lifecycle::Lifecycle;
use agenttab_protocol::{
    native_close_task, native_command, native_event_ack, native_event_ack_result, native_ready,
    read_frame, write_frame, NativeDisconnectEvent, NativeDisconnectRecovery, NativeEvent,
    NativeEventName, NativeEventPayload, NativeHandoff, NativeHello, NativeOriginPolicy,
    NativeResponse, NativeStagedCommit, NativeTab, Outcome, ProtocolError, RpcError, RuntimeState,
    EXTENSION_TO_HOST_MAX_BYTES, HOST_TO_EXTENSION_MAX_BYTES, NATIVE_PROTOCOL, PROTOCOL_VERSION,
};
use parking_lot::{Mutex, RwLock};
use serde_json::Value;
use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{self, SyncSender};
use std::sync::Arc;
use std::time::Duration;
use thiserror::Error;
use uuid::Uuid;

type PendingResponse = (Uuid, Uuid, SyncSender<Result<NativeResponse, NativeError>>);

#[derive(Debug, Error, Clone)]
pub enum NativeError {
    #[error("extension is disconnected")]
    Disconnected,
    #[error("extension response timed out")]
    Timeout,
    #[error("native protocol error: {0}")]
    Protocol(String),
    #[error("native transport error: {0}")]
    Transport(String),
}

struct SessionWriter {
    generation: u64,
    writer: Box<dyn Write + Send>,
}

#[derive(Debug, Clone)]
pub struct NativeEventResult {
    pub outcome: Outcome,
    pub result: Option<Value>,
    pub error: Option<RpcError>,
}
impl NativeEventResult {
    pub fn completed(result: Value) -> Self {
        Self {
            outcome: Outcome::Completed,
            result: Some(result),
            error: None,
        }
    }

    pub fn failure(outcome: Outcome, error: RpcError) -> Self {
        Self {
            outcome,
            result: None,
            error: Some(error),
        }
    }
}
pub trait NativeEventSink: Send + Sync {
    fn reconcile(
        &self,
        inventory: &[NativeTab],
        staged_commits: &[NativeStagedCommit],
        handoff: &NativeHandoff,
    ) -> Result<(), String>;
    fn handle(
        &self,
        payload: &NativeEventPayload,
        event_id: Option<&str>,
    ) -> Result<NativeEventResult, String>;
}
pub trait NativeTransport: Send + Sync {
    fn dispatch(
        &self,
        connection_id: Uuid,
        task_id: Uuid,
        method: &str,
        params: Value,
        origin_policy: Option<NativeOriginPolicy>,
        timeout: Duration,
    ) -> Result<NativeResponse, NativeError>;
    fn close_task(&self, _task_id: Uuid, _timeout: Duration) -> Result<(), NativeError> {
        Err(NativeError::Protocol(
            "native close_task lifecycle command is unsupported".into(),
        ))
    }
    fn cancel_connection(&self, _connection_id: Uuid) {}
    fn set_event_sink(&self, _sink: Arc<dyn NativeEventSink>) {}
    fn extension_version(&self) -> Option<String> {
        None
    }
}

pub struct StdioNative {
    writer: Mutex<Option<SessionWriter>>,
    pending: Mutex<HashMap<Uuid, PendingResponse>>,
    lifecycle: Arc<Lifecycle>,
    handoff: Arc<HandoffState>,
    event_sink: RwLock<Option<Arc<dyn NativeEventSink>>>,
    extension_version: RwLock<Option<String>>,
    disconnected: AtomicBool,
    generation: AtomicU64,
}

impl std::fmt::Debug for StdioNative {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("StdioNative")
            .field("lifecycle", &self.lifecycle.state())
            .field("disconnected", &self.disconnected.load(Ordering::Acquire))
            .finish_non_exhaustive()
    }
}

impl StdioNative {
    pub fn new<W: Write + Send + 'static>(
        writer: W,
        lifecycle: Arc<Lifecycle>,
        handoff: Arc<HandoffState>,
    ) -> Arc<Self> {
        Arc::new(Self {
            writer: Mutex::new(Some(SessionWriter {
                generation: 1,
                writer: Box::new(writer),
            })),
            pending: Mutex::new(HashMap::new()),
            lifecycle,
            handoff,
            event_sink: RwLock::new(None),
            extension_version: RwLock::new(None),
            disconnected: AtomicBool::new(true),
            generation: AtomicU64::new(1),
        })
    }

    pub fn reconnectable(lifecycle: Arc<Lifecycle>, handoff: Arc<HandoffState>) -> Arc<Self> {
        Arc::new(Self {
            writer: Mutex::new(None),
            pending: Mutex::new(HashMap::new()),
            lifecycle,
            handoff,
            event_sink: RwLock::new(None),
            disconnected: AtomicBool::new(true),
            generation: AtomicU64::new(0),
        })
    }

    pub(crate) fn attach_writer<W: Write + Send + 'static>(
        &self,
        writer: W,
    ) -> Result<u64, NativeError> {
        let mut active = self.writer.lock();
        if active.is_some() {
            return Err(NativeError::Transport(
                "an extension relay is already connected".into(),
            ));
        }
        let generation = self.generation.fetch_add(1, Ordering::AcqRel) + 1;
        *active = Some(SessionWriter {
            generation,
            writer: Box::new(writer),
        });
        self.disconnected.store(true, Ordering::Release);
        drop(active);
        self.lifecycle.begin_reconciliation();
        self.handoff.restore(true);
        self.fail_all(NativeError::Disconnected);
        Ok(generation)
    }

    pub fn reader_loop<R: Read>(self: &Arc<Self>, mut reader: R) -> Result<(), ProtocolError> {
        let generation = self
            .writer
            .lock()
            .as_ref()
            .map(|writer| writer.generation)
            .ok_or_else(|| {
                ProtocolError::Io(std::io::Error::new(
                    std::io::ErrorKind::NotConnected,
                    "extension relay is not connected",
                ))
            })?;
        loop {
            let value = match read_frame(&mut reader, EXTENSION_TO_HOST_MAX_BYTES) {
                Ok(Some(value)) => value,
                Ok(None) => {
                    self.disconnect_generation(generation, "native messaging stream closed", None);
                    return Ok(());
                }
                Err(error) => {
                    self.disconnect_generation(
                        generation,
                        "native messaging stream failed",
                        Some(error.to_string()),
                    );
                    return Err(error);
                }
            };
            if let Err(error) = self.handle_inbound_generation(generation, value) {
                self.disconnect_generation(
                    generation,
                    "native protocol failed",
                    Some(error.to_string()),
                );
                return Err(error);
            }
        }
    }

    pub(crate) fn receive_generation(
        self: &Arc<Self>,
        generation: u64,
        value: Value,
    ) -> Result<(), ProtocolError> {
        self.handle_inbound_generation(generation, value)
    }

    pub(crate) fn disconnect_generation(
        &self,
        generation: u64,
        reason: &str,
        terminal_error: Option<String>,
    ) {
        let removed = {
            let mut writer = self.writer.lock();
            if writer.as_ref().map(|writer| writer.generation) != Some(generation) {
                false
            } else {
                writer.take();
                true
            }
        };
        if !removed {
            return;
        }
        self.reconcile_extension_disconnect(reason);
        self.disconnected.store(true, Ordering::Release);
        if let Some(error) = terminal_error {
            self.lifecycle.terminal(error.clone());
            self.fail_all(NativeError::Protocol(error));
        } else {
            self.lifecycle.extension_disconnected();
            self.fail_all(NativeError::Disconnected);
        }
        self.handoff.restore(true);
    }

    fn reconcile_extension_disconnect(&self, reason: &str) {
        *self.extension_version.write() = None;
        if let Some(sink) = self.event_sink.read().clone() {
            let _ = sink.handle(
                &NativeEventPayload::ExtensionDisconnected(NativeDisconnectEvent {
                    reason: reason.into(),
                }),
                None,
            );
        }
    }
    #[cfg(test)]
    fn handle_inbound(self: &Arc<Self>, value: Value) -> Result<(), ProtocolError> {
        let generation = self
            .writer
            .lock()
            .as_ref()
            .map(|writer| writer.generation)
            .ok_or_else(|| {
                ProtocolError::Io(std::io::Error::new(
                    std::io::ErrorKind::NotConnected,
                    "extension relay is not connected",
                ))
            })?;
        self.handle_inbound_generation(generation, value)
    }

    fn handle_inbound_generation(
        self: &Arc<Self>,
        generation: u64,
        value: Value,
    ) -> Result<(), ProtocolError> {
        if self.writer.lock().as_ref().map(|writer| writer.generation) != Some(generation) {
            return Err(ProtocolError::Io(std::io::Error::new(
                std::io::ErrorKind::NotConnected,
                "extension relay generation is no longer active",
            )));
        }
        let protocol = value
            .get("protocol")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let version = value
            .get("version")
            .and_then(Value::as_u64)
            .unwrap_or_default() as u16;
        if protocol != NATIVE_PROTOCOL || version != PROTOCOL_VERSION {
            return Err(ProtocolError::UnsupportedProtocol {
                protocol: protocol.into(),
                version,
            });
        }
        match value.get("kind").and_then(Value::as_str) {
            Some("hello") => {
                let hello = NativeHello::parse(value)?;
                *self.extension_version.write() = Some(hello.extension_version.clone());
                self.lifecycle.begin_reconciliation();
                if let Some(sink) = self.event_sink.read().clone() {
                    sink.reconcile(&hello.inventory, &hello.staged_commits, &hello.handoff)
                        .map_err(ProtocolError::InvalidNativeEvent)?;
                }
                self.handoff.restore(hello.handoff.active);
                self.disconnected.store(false, Ordering::Release);
                self.lifecycle.complete_reconciliation(hello.paused);
                let state = if hello.paused {
                    RuntimeState::Paused
                } else {
                    RuntimeState::Ready
                };
                self.write_value_generation(generation, &native_ready(state))?;
            }
            Some("response") => {
                let response = NativeResponse::parse(value)?;
                let sender = self
                    .pending
                    .lock()
                    .remove(&response.request_id)
                    .map(|(_, _, sender)| sender);
                if let Some(sender) = sender {
                    let _ = sender.send(Ok(response));
                }
            }
            Some("event") => {
                let (event, payload) = NativeEvent::parse(value)?;
                if matches!(
                    &payload,
                    NativeEventPayload::PopupCommitApproved(_)
                        | NativeEventPayload::PopupCommitAbandoned(_)
                ) {
                    let native = Arc::clone(self);
                    std::thread::spawn(move || {
                        native.handle_popup_commit_event(generation, event, payload)
                    });
                    return Ok(());
                }
                let clear_handoff = matches!(
                    &payload,
                    NativeEventPayload::Handoff(NativeHandoff { active: false, .. })
                );
                if clear_handoff
                    && !matches!(
                        self.lifecycle.state(),
                        RuntimeState::Ready | RuntimeState::Paused
                    )
                {
                    return Err(ProtocolError::InvalidNativeEvent(
                        "handoff clear cannot be acknowledged before reconciliation".into(),
                    ));
                }
                let event_result = if let Some(sink) = self.event_sink.read().clone() {
                    Some(
                        sink.handle(&payload, event.event_id.as_deref())
                            .map_err(ProtocolError::InvalidNativeEvent)?,
                    )
                } else {
                    None
                };
                let applied = event_result.is_some();
                match payload {
                    NativeEventPayload::Pause(event) => {
                        self.lifecycle.set_paused(event.paused);
                    }
                    NativeEventPayload::Handoff(handoff) => {
                        self.handoff.restore(handoff.active);
                        if !handoff.active {
                            if !applied {
                                return Err(ProtocolError::InvalidNativeEvent(
                                    "handoff clear cannot be acknowledged without durable state"
                                        .into(),
                                ));
                            }
                            self.write_value_generation(generation, &native_event_ack(
                                NativeEventName::HandoffChanged,
                                event.event_id.as_deref().expect(
                                    "validated inactive handoff event must carry an event_id",
                                ),
                            ))?;
                        }
                    }
                    NativeEventPayload::ExtensionDisconnected(_) => {
                        self.handoff.restore(true);
                        self.lifecycle.extension_disconnected();
                        self.fail_all(NativeError::Disconnected);
                    }
                    NativeEventPayload::Inventory(_)
                    | NativeEventPayload::TaskTabs(_)
                    | NativeEventPayload::CommitExpired(_)
                    | NativeEventPayload::CommitAbandoned(_) => {}
                    NativeEventPayload::PopupCommitApproved(_)
                    | NativeEventPayload::PopupCommitAbandoned(_) => unreachable!(
                        "popup commit events are handled asynchronously to keep the native reader available"
                    ),
                }
            }
            Some("disconnect_recovery") => {
                let _ = NativeDisconnectRecovery::parse(value)?;
                self.disconnected.store(true, Ordering::Release);
                self.handoff.restore(true);
                self.lifecycle.begin_reconciliation();
                self.fail_all(NativeError::Disconnected);
            }
            Some(kind) => {
                return Err(ProtocolError::Json(serde_json::Error::io(
                    std::io::Error::new(
                        std::io::ErrorKind::InvalidData,
                        format!("unknown native message kind {kind:?}"),
                    ),
                )))
            }
            None => {
                return Err(ProtocolError::Json(serde_json::Error::io(
                    std::io::Error::new(
                        std::io::ErrorKind::InvalidData,
                        "native message is missing kind",
                    ),
                )))
            }
        }
        Ok(())
    }

    fn handle_popup_commit_event(
        &self,
        generation: u64,
        event: NativeEvent,
        payload: NativeEventPayload,
    ) {
        let event_id = event
            .event_id
            .as_deref()
            .expect("validated popup commit event must carry an event_id");
        let result = match self.event_sink.read().clone() {
            Some(sink) => sink
                .handle(&payload, Some(event_id))
                .unwrap_or_else(|error| {
                    NativeEventResult::failure(
                        Outcome::Unknown,
                        RpcError::new("native_event_failed", error),
                    )
                }),
            None => NativeEventResult::failure(
                Outcome::NotStarted,
                RpcError::new("runtime_unavailable", "AgentTab runtime is unavailable"),
            ),
        };
        let acknowledgement = native_event_ack_result(
            event.event,
            event_id,
            result.outcome,
            result.result,
            result.error,
        );
        if self
            .write_value_generation(generation, &acknowledgement)
            .is_err()
        {
            self.disconnect_generation(generation, "native event acknowledgement failed", None);
        }
    }

    fn active_generation(&self) -> Result<u64, ProtocolError> {
        self.writer
            .lock()
            .as_ref()
            .map(|writer| writer.generation)
            .ok_or_else(|| {
                ProtocolError::Io(std::io::Error::new(
                    std::io::ErrorKind::NotConnected,
                    "extension relay is not connected",
                ))
            })
    }

    fn write_value_generation(&self, generation: u64, value: &Value) -> Result<(), ProtocolError> {
        let mut active = self.writer.lock();
        let writer = active.as_mut().ok_or_else(|| {
            ProtocolError::Io(std::io::Error::new(
                std::io::ErrorKind::NotConnected,
                "extension relay is not connected",
            ))
        })?;
        if writer.generation != generation {
            return Err(ProtocolError::Io(std::io::Error::new(
                std::io::ErrorKind::NotConnected,
                "extension relay generation changed",
            )));
        }
        write_frame(&mut writer.writer, value, HOST_TO_EXTENSION_MAX_BYTES)
    }

    fn fail_all(&self, error: NativeError) {
        let mut pending = self.pending.lock();
        for (_, (_, _, sender)) in pending.drain() {
            let _ = sender.send(Err(error.clone()));
        }
    }
}

impl NativeTransport for StdioNative {
    fn dispatch(
        &self,
        connection_id: Uuid,
        task_id: Uuid,
        method: &str,
        params: Value,
        origin_policy: Option<NativeOriginPolicy>,
        timeout: Duration,
    ) -> Result<NativeResponse, NativeError> {
        if self.disconnected.load(Ordering::Acquire) {
            return Err(NativeError::Disconnected);
        }
        let generation = self
            .active_generation()
            .map_err(|_| NativeError::Disconnected)?;
        let request_id = Uuid::new_v4();
        let (sender, receiver) = mpsc::sync_channel(1);
        self.pending
            .lock()
            .insert(request_id, (connection_id, task_id, sender));
        if let Err(error) = self.write_value_generation(
            generation,
            &native_command(
                request_id,
                connection_id,
                task_id,
                method,
                params,
                origin_policy.as_ref(),
            ),
        ) {
            self.pending.lock().remove(&request_id);
            return Err(NativeError::Transport(error.to_string()));
        }
        match receiver.recv_timeout(timeout) {
            Ok(result) => result,
            Err(mpsc::RecvTimeoutError::Timeout) => {
                self.pending.lock().remove(&request_id);
                Err(NativeError::Timeout)
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => Err(NativeError::Disconnected),
        }
    }

    fn close_task(&self, task_id: Uuid, timeout: Duration) -> Result<(), NativeError> {
        if self.disconnected.load(Ordering::Acquire) {
            return Err(NativeError::Disconnected);
        }
        let generation = self
            .active_generation()
            .map_err(|_| NativeError::Disconnected)?;
        let request_id = Uuid::new_v4();
        let (sender, receiver) = mpsc::sync_channel(1);
        self.pending
            .lock()
            .insert(request_id, (Uuid::nil(), task_id, sender));
        if let Err(error) =
            self.write_value_generation(generation, &native_close_task(request_id, task_id))
        {
            self.pending.lock().remove(&request_id);
            return Err(NativeError::Transport(error.to_string()));
        }
        let response = match receiver.recv_timeout(timeout) {
            Ok(result) => result?,
            Err(mpsc::RecvTimeoutError::Timeout) => {
                self.pending.lock().remove(&request_id);
                return Err(NativeError::Timeout);
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => return Err(NativeError::Disconnected),
        };
        let result = response.result.as_ref().and_then(Value::as_object);
        let expected_task_id = task_id.to_string();
        let closed_tab_ids_are_valid = result
            .and_then(|value| value.get("closed_tab_ids"))
            .and_then(Value::as_array)
            .is_some_and(|tab_ids| tab_ids.iter().all(Value::is_u64));
        if response.outcome != Outcome::Completed
            || result.is_none_or(|value| {
                value.len() != 2
                    || value.get("task_id").and_then(Value::as_str)
                        != Some(expected_task_id.as_str())
                    || !closed_tab_ids_are_valid
            })
        {
            return Err(NativeError::Protocol(
                "native close_task cleanup was not confirmed by the extension".into(),
            ));
        }
        Ok(())
    }

    fn cancel_connection(&self, connection_id: Uuid) {
        let senders = {
            let mut pending = self.pending.lock();
            let request_ids = pending
                .iter()
                .filter_map(|(request_id, (pending_connection_id, _, _))| {
                    (*pending_connection_id == connection_id).then_some(*request_id)
                })
                .collect::<Vec<_>>();
            request_ids
                .into_iter()
                .filter_map(|request_id| pending.remove(&request_id).map(|(_, _, sender)| sender))
                .collect::<Vec<_>>()
        };
        for sender in senders {
            let _ = sender.send(Err(NativeError::Disconnected));
        }
    }

    fn set_event_sink(&self, sink: Arc<dyn NativeEventSink>) {
        *self.event_sink.write() = Some(sink);
    }

    fn extension_version(&self) -> Option<String> {
        self.extension_version.read().clone()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use agenttab_protocol::{write_frame, EXTENSION_TO_HOST_MAX_BYTES};
    use serde_json::json;
    use std::io::Cursor;

    struct PopupDispatchSink {
        native: std::sync::Weak<StdioNative>,
    }

    impl NativeEventSink for PopupDispatchSink {
        fn reconcile(
            &self,
            _inventory: &[NativeTab],
            _staged_commits: &[NativeStagedCommit],
            _handoff: &NativeHandoff,
        ) -> Result<(), String> {
            Ok(())
        }

        fn handle(
            &self,
            payload: &NativeEventPayload,
            _event_id: Option<&str>,
        ) -> Result<NativeEventResult, String> {
            if !matches!(payload, NativeEventPayload::PopupCommitApproved(_)) {
                return Ok(NativeEventResult::completed(json!({})));
            }
            let native = self
                .native
                .upgrade()
                .ok_or("native transport is unavailable")?;
            let response = native
                .dispatch(
                    Uuid::nil(),
                    Uuid::nil(),
                    "browser_commit",
                    json!({ "native_token": "host-owned-token" }),
                    None,
                    Duration::from_millis(250),
                )
                .map_err(|error| error.to_string())?;
            Ok(NativeEventResult::completed(
                response.result.unwrap_or_else(|| json!({})),
            ))
        }
    }
    #[derive(Default)]
    struct DurableHandoffSink {
        clear_event_ids: Mutex<Vec<String>>,
    }

    impl NativeEventSink for DurableHandoffSink {
        fn reconcile(
            &self,
            _inventory: &[NativeTab],
            _staged_commits: &[NativeStagedCommit],
            _handoff: &NativeHandoff,
        ) -> Result<(), String> {
            Ok(())
        }

        fn handle(
            &self,
            payload: &NativeEventPayload,
            event_id: Option<&str>,
        ) -> Result<NativeEventResult, String> {
            if matches!(
                payload,
                NativeEventPayload::Handoff(NativeHandoff { active: false, .. })
            ) {
                self.clear_event_ids
                    .lock()
                    .push(event_id.unwrap_or_default().to_owned());
            }
            Ok(NativeEventResult::completed(json!({})))
        }
    }

    fn hello(paused: bool) -> Value {
        json!({
            "protocol": NATIVE_PROTOCOL,
            "version": PROTOCOL_VERSION,
            "kind": "hello",
            "extension_version": "0.2.0",
            "inventory": [],
            "paused": paused,
            "handoff": {"active": false},
            "staged_commits": []
        })
    }

    #[test]
    fn hello_reconciles_before_ready_frame_is_emitted() {
        let lifecycle = Arc::new(Lifecycle::default());
        let handoff = Arc::new(HandoffState::default());
        let output = SharedWriter::default();
        let native = StdioNative::new(output.clone(), lifecycle.clone(), handoff.clone());
        let mut input = Vec::new();
        write_frame(&mut input, &hello(false), EXTENSION_TO_HOST_MAX_BYTES).unwrap();
        native.reader_loop(Cursor::new(input)).unwrap();
        assert_eq!(lifecycle.state(), RuntimeState::Reconciling);
        let bytes = output.bytes.lock().clone();
        let ready = read_frame(&mut bytes.as_slice(), HOST_TO_EXTENSION_MAX_BYTES)
            .unwrap()
            .unwrap();
        assert_eq!(ready["kind"], "ready");
    }

    #[test]
    fn extension_version_tracks_the_connected_native_hello() {
        let lifecycle = Arc::new(Lifecycle::default());
        let native = StdioNative::new(
            SharedWriter::default(),
            lifecycle,
            Arc::new(HandoffState::default()),
        );
        native
            .handle_inbound(json!({
                "protocol": NATIVE_PROTOCOL,
                "version": PROTOCOL_VERSION,
                "kind": "hello",
                "extension_version": "2.0.0",
                "inventory": [],
                "paused": false,
                "handoff": {"active": false},
                "staged_commits": []
            }))
            .unwrap();
        assert_eq!(native.extension_version().as_deref(), Some("2.0.0"));
        native.reconcile_extension_disconnect("test disconnect");
        assert!(native.extension_version().is_none());
    }

    #[test]
    fn reconnectable_transport_keeps_new_generation_after_stale_disconnect() {
        let lifecycle = Arc::new(Lifecycle::default());
        let handoff = Arc::new(HandoffState::default());
        let native = StdioNative::reconnectable(lifecycle.clone(), handoff);

        let first_output = SharedWriter::default();
        let first = native.attach_writer(first_output.clone()).unwrap();
        native.receive_generation(first, hello(false)).unwrap();
        assert_eq!(lifecycle.state(), RuntimeState::Ready);
        assert_eq!(
            read_frame(
                &mut first_output.bytes.lock().as_slice(),
                HOST_TO_EXTENSION_MAX_BYTES
            )
            .unwrap()
            .unwrap()["kind"],
            "ready"
        );

        native.disconnect_generation(first, "first relay closed", None);
        assert_eq!(lifecycle.state(), RuntimeState::Reconciling);

        let second_output = SharedWriter::default();
        let second = native.attach_writer(second_output.clone()).unwrap();
        assert!(second > first);
        native.receive_generation(second, hello(true)).unwrap();
        assert_eq!(lifecycle.state(), RuntimeState::Paused);

        native.disconnect_generation(first, "stale cleanup", None);
        assert_eq!(lifecycle.state(), RuntimeState::Paused);
        assert!(native.receive_generation(first, hello(false)).is_err());
        assert!(native.attach_writer(SharedWriter::default()).is_err());
        assert_eq!(native.active_generation().unwrap(), second);
    }
    #[test]
    fn handoff_clear_is_acknowledged_only_after_sink_applies_it() {
        let lifecycle = Arc::new(Lifecycle::default());
        lifecycle.begin_reconciliation();
        lifecycle.complete_reconciliation(false);
        let handoff = Arc::new(HandoffState::default());
        handoff.restore(true);
        let output = SharedWriter::default();
        let native = StdioNative::new(output.clone(), lifecycle, handoff.clone());
        let sink = Arc::new(DurableHandoffSink::default());
        native.set_event_sink(sink.clone());

        native
            .handle_inbound(json!({
                "protocol": NATIVE_PROTOCOL,
                "version": PROTOCOL_VERSION,
                "kind": "event",
                "event": "handoff_changed",
                "event_id": "handoff-clear-0001",
                "payload": {"active": false}
            }))
            .unwrap();

        assert!(!handoff.is_active());
        assert_eq!(
            sink.clear_event_ids.lock().clone(),
            vec!["handoff-clear-0001".to_owned()]
        );
        let bytes = output.bytes.lock().clone();
        assert_eq!(
            read_frame(&mut bytes.as_slice(), HOST_TO_EXTENSION_MAX_BYTES)
                .unwrap()
                .unwrap(),
            json!({
                "protocol": NATIVE_PROTOCOL,
                "version": PROTOCOL_VERSION,
                "kind": "event_ack",
                "event": "handoff_changed",
                "event_id": "handoff-clear-0001",
            })
        );
    }
    #[test]
    fn popup_approval_does_not_block_reader_before_extension_commit_response() {
        let lifecycle = Arc::new(Lifecycle::default());
        lifecycle.begin_reconciliation();
        lifecycle.complete_reconciliation(false);
        let output = SharedWriter::default();
        let native = StdioNative::new(output.clone(), lifecycle, Arc::new(HandoffState::default()));
        native.disconnected.store(false, Ordering::Release);
        native.set_event_sink(Arc::new(PopupDispatchSink {
            native: Arc::downgrade(&native),
        }));
        let event_id = Uuid::now_v7().to_string();
        native
            .handle_inbound(json!({
                "protocol": NATIVE_PROTOCOL,
                "version": PROTOCOL_VERSION,
                "kind": "event",
                "event": "popup_commit_approved",
                "event_id": event_id,
                "payload": {
                    "review_handle": "review-handle-opaque",
                    "task_id": Uuid::nil(),
                    "tab_id": 3,
                }
            }))
            .unwrap();

        let deadline = std::time::Instant::now() + Duration::from_secs(1);
        let command = loop {
            let bytes = output.bytes.lock().clone();
            if let Ok(Some(command)) =
                read_frame(&mut bytes.as_slice(), HOST_TO_EXTENSION_MAX_BYTES)
            {
                break command;
            }
            assert!(
                std::time::Instant::now() < deadline,
                "popup approval blocked the reader before native dispatch"
            );
            std::thread::sleep(Duration::from_millis(5));
        };
        assert_eq!(command["kind"], "command");
        assert_eq!(command["method"], "browser_commit");
        let request_id = command["request_id"].as_str().unwrap();
        native
            .handle_inbound(json!({
                "protocol": NATIVE_PROTOCOL,
                "version": PROTOCOL_VERSION,
                "kind": "response",
                "request_id": request_id,
                "outcome": "completed",
                "result": { "executed": true },
            }))
            .unwrap();

        let acknowledgement = loop {
            let bytes = output.bytes.lock().clone();
            let mut frames = bytes.as_slice();
            let _ = read_frame(&mut frames, HOST_TO_EXTENSION_MAX_BYTES);
            if let Ok(Some(acknowledgement)) = read_frame(&mut frames, HOST_TO_EXTENSION_MAX_BYTES)
            {
                break acknowledgement;
            }
            assert!(
                std::time::Instant::now() < deadline,
                "popup approval did not acknowledge after native commit response"
            );
            std::thread::sleep(Duration::from_millis(5));
        };
        assert_eq!(acknowledgement["kind"], "event_ack");
        assert_eq!(acknowledgement["event"], "popup_commit_approved");
        assert_eq!(acknowledgement["event_id"], event_id);
        assert_eq!(acknowledgement["outcome"], "completed");
    }

    #[test]
    fn version_mismatch_is_terminal() {
        let lifecycle = Arc::new(Lifecycle::default());
        let native = StdioNative::new(
            SharedWriter::default(),
            lifecycle.clone(),
            Arc::new(HandoffState::default()),
        );
        let mut input = Vec::new();
        write_frame(
            &mut input,
            &json!({"protocol": NATIVE_PROTOCOL, "version": 99, "kind": "hello"}),
            EXTENSION_TO_HOST_MAX_BYTES,
        )
        .unwrap();
        assert!(native.reader_loop(Cursor::new(input)).is_err());
        assert_eq!(lifecycle.state(), RuntimeState::Terminal);
    }

    #[derive(Clone, Default)]
    struct SharedWriter {
        bytes: Arc<Mutex<Vec<u8>>>,
    }

    impl Write for SharedWriter {
        fn write(&mut self, buffer: &[u8]) -> std::io::Result<usize> {
            self.bytes.lock().extend_from_slice(buffer);
            Ok(buffer.len())
        }

        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }
}
