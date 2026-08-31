use crate::journal::{Journal, JournalError, TaskLease};
use agenttab_protocol::{
    ConnectedKind, ConnectionAck, ConnectionInit, ResumeCapabilityConfirm,
    ResumeCapabilityConfirmed, ResumeCapabilityConfirmedKind, RuntimeState, PROTOCOL_VERSION,
    RPC_PROTOCOL,
};
use parking_lot::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use uuid::Uuid;

#[derive(Debug)]
struct ConnectionTaskState {
    lease: Option<TaskLease>,
    capability_pending: bool,
    capability_in_flight: bool,
    capability_confirmation_pending: bool,
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
        let features = init.negotiated_features();
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
            features,
        };
        let context = Arc::new(Self {
            connection_id: ack.connection_id,
            conversation_id: init.conversation_id,
            task: Mutex::new(ConnectionTaskState {
                lease: resumed_lease,
                capability_pending: false,
                capability_in_flight: false,
                capability_confirmation_pending: false,
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

    pub fn reserve_new_capability(&self) -> Result<Option<TaskLease>, JournalError> {
        let mut state = self.task.lock();
        if !state.capability_pending
            || state.capability_in_flight
            || state.capability_confirmation_pending
        {
            return Ok(None);
        }
        state.capability_in_flight = true;
        Ok(state.lease.clone())
    }

    pub fn finish_new_capability_delivery(&self, delivered: bool) {
        let mut state = self.task.lock();
        if !state.capability_in_flight {
            return;
        }
        if delivered {
            state.capability_confirmation_pending = true;
        }
        state.capability_in_flight = false;
    }

    pub fn undelivered_new_task_id(&self) -> Option<Uuid> {
        let state = self.task.lock();
        state
            .capability_pending
            .then(|| state.lease.as_ref().map(|lease| lease.task_id))
            .flatten()
    }

    pub fn resume_confirmation_required(&self) -> bool {
        let state = self.task.lock();
        state.resume_rotation_pending
            || state.capability_confirmation_pending
            || state.capability_in_flight
    }

    pub fn confirm_resume_capability(
        &self,
        confirmation: &ResumeCapabilityConfirm,
        journal: &Journal,
    ) -> Result<ResumeCapabilityConfirmed, JournalError> {
        let mut state = self.task.lock();
        if confirmation.connection_id != self.connection_id {
            return Err(JournalError::ResumeRotationLost);
        }
        let lease = state.lease.as_ref().ok_or(JournalError::MissingTask)?;
        if confirmation.resume_capability != lease.resume_capability {
            return Err(JournalError::ResumeRotationLost);
        }
        if state.resume_rotation_pending {
            journal.acknowledge_resume_capability(lease.task_id, &lease.resume_capability)?;
            state.resume_rotation_pending = false;
        } else if state.capability_confirmation_pending
            || (state.capability_pending && state.capability_in_flight)
        {
            state.capability_pending = false;
            state.capability_in_flight = false;
            state.capability_confirmation_pending = false;
        } else {
            return Err(JournalError::ResumeRotationLost);
        }
        Ok(ResumeCapabilityConfirmed {
            protocol: RPC_PROTOCOL.into(),
            version: PROTOCOL_VERSION,
            kind: ResumeCapabilityConfirmedKind::ResumeConfirmed,
            connection_id: self.connection_id,
        })
    }

    pub fn rollback_resume_capability(&self, journal: &Journal) -> Result<(), JournalError> {
        let mut state = self.task.lock();
        if !state.resume_rotation_pending {
            return Ok(());
        }
        let lease = state.lease.as_ref().ok_or(JournalError::MissingTask)?;
        journal.rollback_resume_capability(lease.task_id, &lease.resume_capability)?;
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
    use agenttab_protocol::{ConnectKind, ConnectionInit, ResumeCapabilityConfirmKind};

    fn init(capability: Option<String>) -> ConnectionInit {
        ConnectionInit {
            protocol: RPC_PROTOCOL.into(),
            version: PROTOCOL_VERSION,
            kind: ConnectKind::Connect,
            conversation_id: Some("conversation".into()),
            resume_capability: capability,
            supported_versions: None,
            supported_features: None,
        }
    }

    fn confirmation(connection_id: Uuid, capability: String) -> ResumeCapabilityConfirm {
        ResumeCapabilityConfirm {
            protocol: RPC_PROTOCOL.into(),
            version: PROTOCOL_VERSION,
            kind: ResumeCapabilityConfirmKind::ResumeConfirm,
            connection_id,
            resume_capability: capability,
        }
    }

    #[test]
    fn task_capability_remains_pending_until_confirmation_succeeds() {
        let temp = tempfile::tempdir().unwrap();
        let journal = Arc::new(Journal::open(&temp.path().join("state.sqlite3")).unwrap());
        let (connection, ack) =
            ConnectionContext::negotiate(init(None), &journal, RuntimeState::Starting).unwrap();
        assert!(!ack.resumed);
        assert!(ack.task_id.is_none());
        let task_id = connection.ensure_task(&journal).unwrap();
        assert_eq!(connection.ensure_task(&journal).unwrap(), task_id);

        let first = connection.reserve_new_capability().unwrap().unwrap();
        assert_eq!(first.task_id, task_id);
        assert!(connection.reserve_new_capability().unwrap().is_none());
        assert_eq!(connection.undelivered_new_task_id(), Some(task_id));

        connection.finish_new_capability_delivery(false);
        let delivered = connection.reserve_new_capability().unwrap().unwrap();
        connection.finish_new_capability_delivery(true);
        assert!(connection.resume_confirmation_required());
        assert_eq!(connection.undelivered_new_task_id(), Some(task_id));
        assert!(matches!(
            connection.confirm_resume_capability(
                &confirmation(connection.connection_id, "x".repeat(32)),
                &journal
            ),
            Err(JournalError::ResumeRotationLost)
        ));
        connection
            .confirm_resume_capability(
                &confirmation(connection.connection_id, delivered.resume_capability),
                &journal,
            )
            .unwrap();
        assert!(!connection.resume_confirmation_required());
        assert!(connection.reserve_new_capability().unwrap().is_none());
        assert_eq!(connection.undelivered_new_task_id(), None);
    }

    #[test]
    fn resume_rotates_only_after_same_connection_candidate_confirmation() {
        let temp = tempfile::tempdir().unwrap();
        let journal = Arc::new(Journal::open(&temp.path().join("state.sqlite3")).unwrap());
        let created = journal.create_task(None).unwrap();
        let (connection, ack) = ConnectionContext::negotiate(
            init(Some(created.resume_capability.clone())),
            &journal,
            RuntimeState::Ready,
        )
        .unwrap();
        let candidate = ack.resume_capability.unwrap();

        assert!(ack.resumed);
        assert_eq!(ack.task_id, Some(created.task_id));
        assert!(connection.resume_confirmation_required());
        assert!(journal
            .resume_task(&created.resume_capability)
            .unwrap()
            .is_none());
        assert!(matches!(
            connection.confirm_resume_capability(
                &confirmation(Uuid::new_v4(), candidate.clone()),
                &journal
            ),
            Err(JournalError::ResumeRotationLost)
        ));
        assert!(matches!(
            connection.confirm_resume_capability(
                &confirmation(connection.connection_id, created.resume_capability.clone()),
                &journal
            ),
            Err(JournalError::ResumeRotationLost)
        ));

        let confirmed = connection
            .confirm_resume_capability(
                &confirmation(connection.connection_id, candidate.clone()),
                &journal,
            )
            .unwrap();
        assert_eq!(confirmed.connection_id, connection.connection_id);
        assert!(!connection.resume_confirmation_required());
        assert!(journal
            .resume_task(&created.resume_capability)
            .unwrap()
            .is_none());
        assert!(journal.resume_task(&candidate).unwrap().is_some());
    }

    #[test]
    fn disconnect_rollback_keeps_the_old_capability_recoverable() {
        let temp = tempfile::tempdir().unwrap();
        let journal = Arc::new(Journal::open(&temp.path().join("state.sqlite3")).unwrap());
        let created = journal.create_task(None).unwrap();
        let (connection, _) = ConnectionContext::negotiate(
            init(Some(created.resume_capability.clone())),
            &journal,
            RuntimeState::Ready,
        )
        .unwrap();

        connection.rollback_resume_capability(&journal).unwrap();
        assert!(journal
            .resume_task(&created.resume_capability)
            .unwrap()
            .is_some());
    }
}
