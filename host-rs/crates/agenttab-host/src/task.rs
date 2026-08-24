use crate::journal::{Journal, JournalError, TaskLease};
use agenttab_protocol::{
    ConnectedKind, ConnectionAck, ConnectionInit, RuntimeState, PROTOCOL_VERSION, RPC_PROTOCOL,
};
use parking_lot::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use uuid::Uuid;

#[derive(Debug)]
struct ConnectionTaskState {
    lease: Option<TaskLease>,
    capability_pending: bool,
    resume_rotation_pending: bool,
}

#[derive(Debug)]
pub struct ConnectionContext {
    pub connection_id: Uuid,
    conversation_id: Option<String>,
    task: Mutex<ConnectionTaskState>,
    cancelled: AtomicBool,
}

impl ConnectionContext {
    pub fn negotiate(
        init: ConnectionInit,
        journal: &Arc<Journal>,
        runtime_state: RuntimeState,
    ) -> Result<(Arc<Self>, ConnectionAck), JournalError> {
        let resumed_lease = match init.resume_capability.as_deref() {
            Some(capability) => journal.resume_task(capability)?,
            None => None,
        };
        let resumed = resumed_lease.is_some();
        let ack = ConnectionAck {
            protocol: RPC_PROTOCOL.into(),
            version: PROTOCOL_VERSION,
            kind: ConnectedKind::Connected,
            connection_id: Uuid::new_v4(),
            resumed,
            task_id: resumed_lease.as_ref().map(|lease| lease.task_id),
            resume_capability: resumed_lease
                .as_ref()
                .map(|lease| lease.resume_capability.clone()),
            state: runtime_state,
        };
        let context = Arc::new(Self {
            connection_id: ack.connection_id,
            conversation_id: init.conversation_id,
            task: Mutex::new(ConnectionTaskState {
                lease: resumed_lease,
                capability_pending: false,
                resume_rotation_pending: resumed,
            }),
            cancelled: AtomicBool::new(false),
        });
        Ok((context, ack))
    }

    pub fn ensure_task(&self, journal: &Journal) -> Result<Uuid, JournalError> {
        let mut state = self.task.lock();
        if let Some(lease) = &state.lease {
            return Ok(lease.task_id);
        }
        let lease = journal.create_task(self.conversation_id.as_deref())?;
        let task_id = lease.task_id;
        state.lease = Some(lease);
        state.capability_pending = true;
        Ok(task_id)
    }

    pub fn take_new_capability(&self) -> Result<Option<TaskLease>, JournalError> {
        let mut state = self.task.lock();
        if !state.capability_pending {
            return Ok(None);
        }
        state.capability_pending = false;
        Ok(state.lease.clone())
    }

    pub fn acknowledge_resume_capability(&self, journal: &Journal) -> Result<(), JournalError> {
        let mut state = self.task.lock();
        if !state.resume_rotation_pending {
            return Ok(());
        }
        let lease = state.lease.as_ref().ok_or(JournalError::MissingTask)?;
        journal.acknowledge_resume_capability(lease.task_id, &lease.resume_capability)?;
        state.resume_rotation_pending = false;
        Ok(())
    }

    pub fn task_id(&self) -> Result<Option<Uuid>, JournalError> {
        let state = self.task.lock();
        Ok(state.lease.as_ref().map(|lease| lease.task_id))
    }

    pub fn cancel(&self) -> bool {
        !self.cancelled.swap(true, Ordering::AcqRel)
    }

    pub fn is_cancelled(&self) -> bool {
        self.cancelled.load(Ordering::Acquire)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use agenttab_protocol::{ConnectKind, ConnectionInit};

    fn init(capability: Option<String>) -> ConnectionInit {
        ConnectionInit {
            protocol: RPC_PROTOCOL.into(),
            version: PROTOCOL_VERSION,
            kind: ConnectKind::Connect,
            conversation_id: Some("conversation".into()),
            resume_capability: capability,
        }
    }

    #[test]
    fn task_is_created_lazily_and_capability_is_returned_once() {
        let temp = tempfile::tempdir().unwrap();
        let journal = Arc::new(Journal::open(&temp.path().join("state.sqlite3")).unwrap());
        let (connection, ack) =
            ConnectionContext::negotiate(init(None), &journal, RuntimeState::Starting).unwrap();
        assert!(!ack.resumed);
        assert!(ack.task_id.is_none());
        let first = connection.ensure_task(&journal).unwrap();
        assert_eq!(connection.ensure_task(&journal).unwrap(), first);
        assert!(connection.take_new_capability().unwrap().is_some());
        assert!(connection.take_new_capability().unwrap().is_none());
    }

    #[test]
    fn resume_rotates_capability_in_connection_ack() {
        let temp = tempfile::tempdir().unwrap();
        let journal = Arc::new(Journal::open(&temp.path().join("state.sqlite3")).unwrap());
        let created = journal.create_task(None).unwrap();
        let (connection, ack) = ConnectionContext::negotiate(
            init(Some(created.resume_capability.clone())),
            &journal,
            RuntimeState::Ready,
        )
        .unwrap();
        assert!(ack.resumed);
        assert_eq!(ack.task_id, Some(created.task_id));
        assert_ne!(ack.resume_capability.unwrap(), created.resume_capability);
        connection
            .acknowledge_resume_capability(&journal)
            .unwrap();
        assert!(journal
            .resume_task(&created.resume_capability)
            .unwrap()
            .is_none());
    }
}
