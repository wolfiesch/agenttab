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

    pub fn observation_gate(&self) -> Result<(), RpcError> {
        if self.is_active() {
            Err(RpcError::new(
                "handoff_blackout",
                "Browser observations are disabled during credential handoff",
            )
            .with_recovery("Wait for the human to finish or cancel the active handoff."))
        } else {
            Ok(())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn blackout_remains_until_native_completion_is_reconciled() {
        let state = HandoffState::default();
        state.begin().unwrap();
        assert!(state.observation_gate().is_err());
        assert!(state.begin().is_err());
        state.restore(false);
        assert!(state.observation_gate().is_ok());
    }
}
