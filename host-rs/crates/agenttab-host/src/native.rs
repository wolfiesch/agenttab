use crate::handoff::HandoffState;
use crate::lifecycle::Lifecycle;
use agenttab_protocol::{
    native_close_task, native_command, native_event_ack, native_ready, read_frame, write_frame,
    NativeDisconnectRecovery, NativeEvent, NativeEventName, NativeEventPayload, NativeHandoff,
    NativeHello, NativeOriginPolicy, NativeResponse, NativeStagedCommit, NativeTab, Outcome,
    ProtocolError, RuntimeState, EXTENSION_TO_HOST_MAX_BYTES, HOST_TO_EXTENSION_MAX_BYTES,
    NATIVE_PROTOCOL, PROTOCOL_VERSION,
};
use parking_lot::{Mutex, RwLock};
use serde_json::Value;
use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::atomic::{AtomicBool, Ordering};
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
pub trait NativeEventSink: Send + Sync {
    fn reconcile(
        &self,
        inventory: &[NativeTab],
        staged_commits: &[NativeStagedCommit],
        handoff: &NativeHandoff,
    ) -> Result<(), String>;
    fn handle(&self, payload: &NativeEventPayload, event_id: Option<&str>) -> Result<(), String>;
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
}

pub struct StdioNative {
    writer: Mutex<Box<dyn Write + Send>>,
    pending: Mutex<HashMap<Uuid, PendingResponse>>,
    lifecycle: Arc<Lifecycle>,
    handoff: Arc<HandoffState>,
    event_sink: RwLock<Option<Arc<dyn NativeEventSink>>>,
    disconnected: AtomicBool,
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
            writer: Mutex::new(Box::new(writer)),
            pending: Mutex::new(HashMap::new()),
            lifecycle,
            handoff,
            event_sink: RwLock::new(None),
            disconnected: AtomicBool::new(true),
        })
    }

    pub fn reader_loop<R: Read>(&self, mut reader: R) -> Result<(), ProtocolError> {
        loop {
            let value = match read_frame(&mut reader, EXTENSION_TO_HOST_MAX_BYTES) {
                Ok(Some(value)) => value,
                Ok(None) => {
                    self.disconnected.store(true, Ordering::Release);
                    self.lifecycle.extension_disconnected();
                    self.handoff.restore(true);
                    self.fail_all(NativeError::Disconnected);
                    return Ok(());
                }
                Err(error) => {
                    self.disconnected.store(true, Ordering::Release);
                    self.lifecycle.terminal(error.to_string());
                    self.handoff.restore(true);
                    self.fail_all(NativeError::Protocol(error.to_string()));
                    return Err(error);
                }
            };
            if let Err(error) = self.handle_inbound(value) {
                self.disconnected.store(true, Ordering::Release);
                self.lifecycle.terminal(error.to_string());
                self.handoff.restore(true);
                self.fail_all(NativeError::Protocol(error.to_string()));
                return Err(error);
            }
        }
    }

    fn handle_inbound(&self, value: Value) -> Result<(), ProtocolError> {
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
                self.write_value(&native_ready(state))?;
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
                let applied = if let Some(sink) = self.event_sink.read().clone() {
                    sink.handle(&payload, event.event_id.as_deref())
                        .map_err(ProtocolError::InvalidNativeEvent)?;
                    true
                } else {
                    false
                };
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
                            self.write_value(&native_event_ack(
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
                    | NativeEventPayload::CommitExpired(_) => {}
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

    fn write_value(&self, value: &Value) -> Result<(), ProtocolError> {
        let mut writer = self.writer.lock();
        write_frame(&mut *writer, value, HOST_TO_EXTENSION_MAX_BYTES)
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
        let request_id = Uuid::new_v4();
        let (sender, receiver) = mpsc::sync_channel(1);
        self.pending
            .lock()
            .insert(request_id, (connection_id, task_id, sender));
        if let Err(error) = self.write_value(&native_command(
            request_id,
            connection_id,
            task_id,
            method,
            params,
            origin_policy.as_ref(),
        )) {
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
        let request_id = Uuid::new_v4();
        let (sender, receiver) = mpsc::sync_channel(1);
        self.pending
            .lock()
            .insert(request_id, (Uuid::nil(), task_id, sender));
        if let Err(error) = self.write_value(&native_close_task(request_id, task_id)) {
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
        let (mut task_ids, senders) = {
            let mut pending = self.pending.lock();
            let request_ids = pending
                .iter()
                .filter_map(|(request_id, (pending_connection_id, _, _))| {
                    (*pending_connection_id == connection_id).then_some(*request_id)
                })
                .collect::<Vec<_>>();
            let mut task_ids = Vec::with_capacity(request_ids.len());
            let mut senders = Vec::with_capacity(request_ids.len());
            for request_id in request_ids {
                if let Some((_, task_id, sender)) = pending.remove(&request_id) {
                    task_ids.push(task_id);
                    senders.push(sender);
                }
            }
            (task_ids, senders)
        };
        for sender in senders {
            let _ = sender.send(Err(NativeError::Disconnected));
        }
        task_ids.sort_unstable();

        task_ids.dedup();
        for task_id in task_ids {
            let _ = self.write_value(&native_command(
                Uuid::new_v4(),
                connection_id,
                task_id,
                "cancel_connection",
                serde_json::json!({}),
                None,
            ));
        }
    }

    fn set_event_sink(&self, sink: Arc<dyn NativeEventSink>) {
        *self.event_sink.write() = Some(sink);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use agenttab_protocol::{write_frame, EXTENSION_TO_HOST_MAX_BYTES};
    use serde_json::json;
    use std::io::Cursor;
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
        ) -> Result<(), String> {
            if matches!(
                payload,
                NativeEventPayload::Handoff(NativeHandoff { active: false, .. })
            ) {
                self.clear_event_ids
                    .lock()
                    .push(event_id.unwrap_or_default().to_owned());
            }
            Ok(())
        }
    }

    #[test]
    fn hello_reconciles_before_ready_frame_is_emitted() {
        let lifecycle = Arc::new(Lifecycle::default());
        let handoff = Arc::new(HandoffState::default());
        let output = SharedWriter::default();
        let native = StdioNative::new(output.clone(), lifecycle.clone(), handoff.clone());
        let hello = json!({
            "protocol": NATIVE_PROTOCOL,
            "version": PROTOCOL_VERSION,
            "kind": "hello",
            "extension_version": "0.2.0",
            "inventory": [],
            "paused": false,
            "handoff": {"active": false},
            "staged_commits": []
        });
        let mut input = Vec::new();
        write_frame(&mut input, &hello, EXTENSION_TO_HOST_MAX_BYTES).unwrap();
        native.reader_loop(Cursor::new(input)).unwrap();
        assert_eq!(lifecycle.state(), RuntimeState::Reconciling);
        let bytes = output.bytes.lock().clone();
        let ready = read_frame(&mut bytes.as_slice(), HOST_TO_EXTENSION_MAX_BYTES)
            .unwrap()
            .unwrap();
        assert_eq!(ready["kind"], "ready");
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
