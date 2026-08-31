use agenttab_protocol::{NativeHandoff, RpcError};
use parking_lot::RwLock;
use uuid::Uuid;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum HandoffStatus {
    Inactive,
    Scoped { task_id: Uuid, tab_id: u64 },
    Unknown,
}

#[derive(Debug)]
pub struct HandoffState {
    status: RwLock<HandoffStatus>,
}

impl Default for HandoffState {
    fn default() -> Self {
        Self {
            status: RwLock::new(HandoffStatus::Inactive),
        }
    }
}

impl HandoffState {
    pub fn is_active(&self) -> bool {
        !matches!(*self.status.read(), HandoffStatus::Inactive)
    }

    pub fn restore(&self, handoff: &NativeHandoff) {
        *self.status.write() = if handoff.active {
            match (handoff.task_id, handoff.tab_id) {
                (Some(task_id), Some(tab_id)) => HandoffStatus::Scoped { task_id, tab_id },
                _ => HandoffStatus::Unknown,
            }
        } else {
            HandoffStatus::Inactive
        };
    }

    pub fn block_all_until_reconciled(&self) {
        *self.status.write() = HandoffStatus::Unknown;
    }

    pub fn begin(&self, task_id: Uuid, tab_id: u64) -> Result<(), RpcError> {
        let mut status = self.status.write();
        if !matches!(*status, HandoffStatus::Inactive) {
            return Err(RpcError::new(
                "handoff_in_progress",
                "Another AgentTab credential handoff is already active",
            ));
        }
        *status = HandoffStatus::Scoped { task_id, tab_id };
        Ok(())
    }

    pub fn clear(&self) {
        *self.status.write() = HandoffStatus::Inactive;
    }

    pub fn observation_gate(&self, task_id: Uuid, tab_id: Option<u64>) -> Result<(), RpcError> {
        let blocked = match *self.status.read() {
            HandoffStatus::Inactive => false,
            HandoffStatus::Unknown => true,
            HandoffStatus::Scoped {
                task_id: handoff_task,
                tab_id: handoff_tab,
            } => task_id == handoff_task && tab_id.map_or(true, |tab_id| tab_id == handoff_tab),
        };
        if blocked {
            Err(RpcError::new(
                "handoff_blackout",
                "Automation is disabled while the human controls this tab",
            )
            .with_recovery("Wait for the human to finish or cancel this tab's active handoff."))
        } else {
            Ok(())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn blackout_is_scoped_to_the_handoff_tab() {
        let state = HandoffState::default();
        let task = Uuid::new_v4();
        let other_task = Uuid::new_v4();
        state.begin(task, 7).unwrap();
        assert!(state.observation_gate(task, Some(7)).is_err());
        assert!(state.observation_gate(task, Some(8)).is_ok());
        assert!(state.observation_gate(other_task, Some(7)).is_ok());
        assert!(state.begin(other_task, 9).is_err());
        state.clear();
        assert!(state.observation_gate(task, Some(7)).is_ok());
    }

    #[test]
    fn unknown_disconnect_state_fails_closed_until_reconciliation() {
        let state = HandoffState::default();
        state.block_all_until_reconciled();
        assert!(state.observation_gate(Uuid::new_v4(), Some(1)).is_err());
        state.restore(&NativeHandoff {
            active: false,
            task_id: None,
            tab_id: None,
            started_at_ms: None,
        });
        assert!(!state.is_active());
    }
}
