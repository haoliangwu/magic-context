//! The in-process half of the host runner: runs the module has queued for a
//! claimant and is still waiting on.
//!
//! The durable half lives in the store (`mc_historian_pending_run` plus the
//! session's own historian state) and survives restarts. This half does not, and
//! does not need to: it exists only so the firing task that queued a run can be
//! woken by the report that answers it, the same way the in-module producer path
//! is woken by its own subscribe stream. A report that arrives with no waiter is
//! refused rather than half-applied — the run it belonged to is already over.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use tokio::sync::Notify;

use crate::historian_producer::ProducerOutput;

/// What a claimant reported for one run.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HostRunReport {
    /// The completion produced text. `length_capped` means the model stopped at
    /// its output ceiling, so the document may be cut mid-structure — the same
    /// signal the in-module producer reads off its own run terminal.
    Output(ProducerOutput),
    /// The completion did not happen. The code is the claimant's own vocabulary
    /// (`chain_exhausted`, `no_models`, …) and lands in the failure taxonomy the
    /// same way a producer error does.
    Failed { code: String, message: String },
}

/// Where one queued run stands, as far as its in-process waiter is concerned.
#[derive(Debug)]
enum HostRunSlotState {
    /// Registered, no report yet.
    Waiting,
    /// A report arrived and the waiter has not picked it up yet.
    Reported(HostRunReport),
    /// The waiter picked up its report. Later reports for the run are duplicates.
    Taken,
    /// The waiter stopped waiting without a report. The firing is being abandoned, so a
    /// report that arrives now has nobody to publish it.
    Closed,
}

#[derive(Debug)]
struct HostRunSlot {
    state: HostRunSlotState,
    ready: Arc<Notify>,
}

/// Why a report could not be handed to a waiter.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HostReportDeliveryError {
    /// No firing in this process is waiting for the named run. Either it was
    /// never queued here, or it already ended.
    NoWaiter,
    /// A report for this run has already been accepted. The module takes exactly
    /// one terminal report per claim; later duplicates are dropped rather than
    /// re-validated.
    AlreadyReported,
    /// The firing that queued the run stopped waiting for it (its budget ran out), so
    /// nothing will publish a report that arrives now. Answering "accepted" would tell
    /// the claimant its paid completion was kept when it is about to be discarded.
    Expired,
}

impl HostReportDeliveryError {
    pub fn as_wire_str(self) -> &'static str {
        match self {
            HostReportDeliveryError::NoWaiter => "no_waiter",
            HostReportDeliveryError::AlreadyReported => "already_reported",
            // The same answer the durable path gives a report for a run past its deadline.
            HostReportDeliveryError::Expired => "run_expired",
        }
    }
}

#[derive(Debug, Default)]
pub struct HostRunLedger {
    slots: Mutex<HashMap<String, HostRunSlot>>,
}

/// Removes a run from the ledger when the firing task that registered it ends,
/// however it ends. Without this a firing that failed before its report arrived
/// would leave a waiter nobody can ever satisfy.
pub struct HostRunRegistration {
    ledger: Arc<HostRunLedger>,
    run_id: String,
    ready: Arc<Notify>,
}

impl HostRunLedger {
    pub fn new() -> Self {
        Self::default()
    }

    /// Start waiting for a report on `run_id`.
    pub fn register(self: &Arc<Self>, run_id: &str) -> HostRunRegistration {
        let ready = Arc::new(Notify::new());
        let mut slots = self.slots.lock().expect("host run ledger mutex");
        slots.insert(
            run_id.to_string(),
            HostRunSlot {
                state: HostRunSlotState::Waiting,
                ready: Arc::clone(&ready),
            },
        );
        HostRunRegistration {
            ledger: Arc::clone(self),
            run_id: run_id.to_string(),
            ready,
        }
    }

    /// Hand a claimant's report to whoever is waiting for it.
    pub fn deliver(
        &self,
        run_id: &str,
        report: HostRunReport,
    ) -> Result<(), HostReportDeliveryError> {
        let mut slots = self.slots.lock().expect("host run ledger mutex");
        let Some(slot) = slots.get_mut(run_id) else {
            return Err(HostReportDeliveryError::NoWaiter);
        };
        match slot.state {
            HostRunSlotState::Waiting => {}
            HostRunSlotState::Reported(_) | HostRunSlotState::Taken => {
                return Err(HostReportDeliveryError::AlreadyReported);
            }
            HostRunSlotState::Closed => return Err(HostReportDeliveryError::Expired),
        }
        slot.state = HostRunSlotState::Reported(report);
        slot.ready.notify_waiters();
        Ok(())
    }

    /// Hand the waiter its report, if one has arrived. The slot remembers that the
    /// report was taken, so a second report for the same claim is refused as a
    /// duplicate instead of being accepted into a slot nobody reads again.
    ///
    /// With `close_if_empty`, a slot with no report is closed in the same critical
    /// section. The waiter passes it when its budget runs out: closing and checking
    /// under one lock means a report either lands before the close (and is returned
    /// here) or after it (and is refused), never accepted and then dropped.
    fn take(&self, run_id: &str, close_if_empty: bool) -> Option<HostRunReport> {
        let mut slots = self.slots.lock().expect("host run ledger mutex");
        let slot = slots.get_mut(run_id)?;
        match std::mem::replace(&mut slot.state, HostRunSlotState::Taken) {
            HostRunSlotState::Reported(report) => Some(report),
            HostRunSlotState::Waiting if close_if_empty => {
                slot.state = HostRunSlotState::Closed;
                None
            }
            other => {
                slot.state = other;
                None
            }
        }
    }

    fn forget(&self, run_id: &str) {
        let mut slots = self.slots.lock().expect("host run ledger mutex");
        slots.remove(run_id);
    }

    /// How many runs this process is waiting on. Diagnostics only.
    pub fn waiting_count(&self) -> usize {
        self.slots.lock().expect("host run ledger mutex").len()
    }
}

impl HostRunRegistration {
    /// Wait for the report, or give up at `budget`.
    ///
    /// The notify is subscribed BEFORE the stored report is checked, so a report
    /// that lands between the two is still seen by this waiter rather than
    /// waited past.
    pub async fn wait(&self, budget: std::time::Duration) -> Option<HostRunReport> {
        let deadline = tokio::time::Instant::now() + budget;
        loop {
            let notified = self.ready.notified();
            if let Some(report) = self.ledger.take(&self.run_id, false) {
                return Some(report);
            }
            if tokio::time::timeout_at(deadline, notified).await.is_err() {
                return self.ledger.take(&self.run_id, true);
            }
        }
    }

    pub fn run_id(&self) -> &str {
        &self.run_id
    }
}

impl Drop for HostRunRegistration {
    fn drop(&mut self) {
        self.ledger.forget(&self.run_id);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn output(text: &str) -> HostRunReport {
        HostRunReport::Output(ProducerOutput {
            text: text.to_string(),
            length_capped: false,
            usage: None,
        })
    }

    #[tokio::test]
    async fn a_report_wakes_the_waiter_that_queued_the_run() {
        let ledger = Arc::new(HostRunLedger::new());
        let registration = ledger.register("run-1");
        let deliverer = Arc::clone(&ledger);
        tokio::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_millis(5)).await;
            deliverer.deliver("run-1", output("<doc/>")).unwrap();
        });
        let report = registration
            .wait(std::time::Duration::from_secs(5))
            .await
            .expect("the queued run must receive its report");
        assert_eq!(report, output("<doc/>"));
    }

    #[test]
    fn a_report_for_a_run_nobody_queued_is_refused() {
        let ledger = Arc::new(HostRunLedger::new());
        assert_eq!(
            ledger.deliver("run-unknown", output("<doc/>")),
            Err(HostReportDeliveryError::NoWaiter)
        );
    }

    #[test]
    fn only_the_first_report_for_a_claim_is_accepted() {
        let ledger = Arc::new(HostRunLedger::new());
        let _registration = ledger.register("run-1");
        assert_eq!(ledger.deliver("run-1", output("<first/>")), Ok(()));
        assert_eq!(
            ledger.deliver("run-1", output("<second/>")),
            Err(HostReportDeliveryError::AlreadyReported)
        );
    }

    #[test]
    fn ending_a_firing_removes_its_waiter() {
        let ledger = Arc::new(HostRunLedger::new());
        {
            let _registration = ledger.register("run-1");
            assert_eq!(ledger.waiting_count(), 1);
        }
        assert_eq!(ledger.waiting_count(), 0);
        assert_eq!(
            ledger.deliver("run-1", output("<late/>")),
            Err(HostReportDeliveryError::NoWaiter)
        );
    }

    #[tokio::test]
    async fn a_report_after_the_waiter_took_one_is_refused_as_a_duplicate() {
        let ledger = Arc::new(HostRunLedger::new());
        let registration = ledger.register("run-1");
        ledger.deliver("run-1", output("<first/>")).unwrap();
        let report = registration.wait(std::time::Duration::from_secs(5)).await;
        assert_eq!(report, Some(output("<first/>")));
        // The registration is still alive (the firing is validating and publishing),
        // so the slot exists. A second report must not be accepted into it.
        assert_eq!(
            ledger.deliver("run-1", output("<second/>")),
            Err(HostReportDeliveryError::AlreadyReported)
        );
    }

    #[tokio::test]
    async fn a_report_after_the_waiter_gave_up_is_refused_not_accepted_and_dropped() {
        let ledger = Arc::new(HostRunLedger::new());
        let registration = ledger.register("run-1");
        assert_eq!(
            registration
                .wait(std::time::Duration::from_millis(10))
                .await,
            None
        );
        // The firing is now abandoning the run, but its registration has not been
        // dropped yet. A report arriving in this window was answered "accepted" and
        // then discarded with the registration.
        assert_eq!(
            ledger.deliver("run-1", output("<late/>")),
            Err(HostReportDeliveryError::Expired)
        );
        assert_eq!(
            HostReportDeliveryError::Expired.as_wire_str(),
            "run_expired"
        );
    }

    #[tokio::test]
    async fn a_waiter_that_runs_out_of_budget_reports_nothing() {
        let ledger = Arc::new(HostRunLedger::new());
        let registration = ledger.register("run-1");
        assert_eq!(
            registration
                .wait(std::time::Duration::from_millis(10))
                .await,
            None
        );
    }
}
