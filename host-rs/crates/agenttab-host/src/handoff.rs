use agenttab_protocol::RpcError;
use std::sync::atomic::{AtomicBool, Ordering};

#[derive(Debug, Default)]
pub struct HandoffState {
    active: AtomicBool,
}

impl HandoffState {
    pub fn is_active(&self) -> bool {
        self.active.load(Ordering::Acquire)
    }

    pub fn restore(&self, active: bool) {
        self.active.store(active, Ordering::Release);
    }

    pub fn begin(&self) -> Result<(), RpcError> {
        self.active
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .map(|_| ())
            .map_err(|_| {
                RpcError::new(
                    "handoff_in_progress",
                    "Another AgentTab credential handoff is already active",
                )
            })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn active_state_rejects_only_another_handoff() {
        let state = HandoffState::default();
        state.begin().unwrap();
        assert!(state.begin().is_err());
        state.restore(false);
        assert!(!state.is_active());
    }
}
