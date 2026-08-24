use agenttab_protocol::{RpcError, RpcMethod, RuntimeState};
use parking_lot::{Condvar, Mutex};
use std::time::Duration;

#[derive(Debug)]
pub struct Admission<'a> {
    lifecycle: &'a Lifecycle,
}

#[derive(Debug)]
pub struct Lifecycle {
    state: Mutex<StateData>,
    changed: Condvar,
}

#[derive(Debug)]
struct StateData {
    state: RuntimeState,
    terminal_reason: Option<String>,
    active_admissions: usize,
}

impl Default for Lifecycle {
    fn default() -> Self {
        Self {
            state: Mutex::new(StateData {
                state: RuntimeState::Starting,
                terminal_reason: None,
                active_admissions: 0,
            }),
            changed: Condvar::new(),
        }
    }
}

impl Lifecycle {
    pub fn state(&self) -> RuntimeState {
        self.state.lock().state
    }

    pub fn begin_reconciliation(&self) {
        self.transition(RuntimeState::Reconciling, None);
    }

    pub fn complete_reconciliation(&self, paused: bool) {
        self.transition(
            if paused {
                RuntimeState::Paused
            } else {
                RuntimeState::Ready
            },
            None,
        );
    }

    pub fn set_paused(&self, paused: bool) {
        let mut data = self.state.lock();
        if matches!(data.state, RuntimeState::Ready | RuntimeState::Paused) {
            data.state = if paused {
                RuntimeState::Paused
            } else {
                RuntimeState::Ready
            };
            self.changed.notify_all();
        }
    }

    pub fn extension_disconnected(&self) {
        if self.state() != RuntimeState::Terminal {
            self.transition(RuntimeState::Reconciling, None);
        }
    }

    pub fn terminal(&self, reason: impl Into<String>) {
        self.transition(RuntimeState::Terminal, Some(reason.into()));
    }

    pub fn gate(&self, method: RpcMethod) -> Result<(), RpcError> {
        gate_state(&self.state.lock(), method)
    }

    pub fn admit(&self, method: RpcMethod) -> Result<Admission<'_>, RpcError> {
        let mut data = self.state.lock();
        gate_state(&data, method)?;
        data.active_admissions += 1;
        Ok(Admission { lifecycle: self })
    }

    pub fn wait_until_ready(&self, timeout: Duration) -> RuntimeState {
        let mut guard = self.state.lock();
        if matches!(
            guard.state,
            RuntimeState::Ready | RuntimeState::Paused | RuntimeState::Terminal
        ) {
            return guard.state;
        }
        self.changed.wait_for(&mut guard, timeout);
        guard.state
    }

    fn transition(&self, state: RuntimeState, terminal_reason: Option<String>) {
        let mut data = self.state.lock();
        if data.state == RuntimeState::Terminal && state != RuntimeState::Terminal {
            return;
        }
        data.state = state;
        if terminal_reason.is_some() {
            data.terminal_reason = terminal_reason;
        }
        self.changed.notify_all();
    }
}

impl Drop for Admission<'_> {
    fn drop(&mut self) {
        let mut data = self.lifecycle.state.lock();
        debug_assert!(data.active_admissions > 0);
        data.active_admissions = data.active_admissions.saturating_sub(1);
        self.lifecycle.changed.notify_all();
    }
}

fn gate_state(data: &StateData, method: RpcMethod) -> Result<(), RpcError> {
    match data.state {
        RuntimeState::Ready => Ok(()),
        RuntimeState::Paused => Err(RpcError::new(
            "automation_paused",
            "AgentTab is paused in Chrome",
        )
        .with_recovery("Resume AgentTab from the extension popup, then retry.")),
        RuntimeState::Starting | RuntimeState::Reconciling => Err(RpcError::new(
            "runtime_not_ready",
            format!("AgentTab is not ready for {method}"),
        )
        .with_recovery("Wait for the extension handshake and task reconciliation to finish.")),
        RuntimeState::Terminal => Err(RpcError::new(
            "runtime_terminal",
            data.terminal_reason
                .clone()
                .unwrap_or_else(|| "terminal protocol failure".into()),
        )
        .with_recovery("Update AgentTab so the host and extension use the same protocol version.")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn runtime_only_opens_after_reconciliation_and_terminal_is_sticky() {
        let lifecycle = Lifecycle::default();
        assert!(lifecycle.gate(RpcMethod::BrowserTabs).is_err());
        lifecycle.begin_reconciliation();
        assert_eq!(lifecycle.state(), RuntimeState::Reconciling);
        lifecycle.complete_reconciliation(false);
        assert!(lifecycle.gate(RpcMethod::BrowserTabs).is_ok());
        lifecycle.terminal("version mismatch");
        lifecycle.complete_reconciliation(false);
        assert_eq!(lifecycle.state(), RuntimeState::Terminal);
    }

    #[test]
    fn pause_blocks_standard_requests() {
        let lifecycle = Lifecycle::default();
        lifecycle.begin_reconciliation();
        lifecycle.complete_reconciliation(true);
        let error = lifecycle.gate(RpcMethod::BrowserSnapshot).unwrap_err();
        assert_eq!(error.code, "automation_paused");
    }

    #[test]
    fn pause_and_admission_have_one_linearization_point() {
        let lifecycle = Lifecycle::default();
        lifecycle.begin_reconciliation();
        lifecycle.complete_reconciliation(false);

        let admitted = lifecycle.admit(RpcMethod::BrowserAct).unwrap();
        lifecycle.set_paused(true);
        let error = lifecycle.admit(RpcMethod::BrowserSnapshot).unwrap_err();
        assert_eq!(error.code, "automation_paused");
        drop(admitted);
    }
}
