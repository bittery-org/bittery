//! Sending accepted Operations, and surviving everything the network does to them.
//!
//! Nothing here may end an accepted Operation. A transport answer moves only two things: a
//! diagnostic attempt count and the next time this Device may try again. There is deliberately no
//! attempt limit, no discard, and no path that treats an HTTP status as a semantic result.

use super::*;
use crate::{
    auth_http::AuthenticatedOutcome,
    platform_storage::CurrentSessionDocument,
    replica::{OperationSchedulingState, ReplicaSnapshot},
    AccountId,
};
use std::collections::HashMap;

/// How long one local send may hold an Operation before another pass may try it again.
///
/// The value only trades wasted duplicate sends against how long a stalled attempt can delay a
/// retry. It is not a correctness bound, so it does not have to be right.
pub(crate) const DISPATCH_LEASE_MS: u64 = 30_000;

/// The first retry waits a second, and no retry ever waits more than five minutes.
const BASE_BACKOFF_MS: u64 = 1_000;
const MAX_BACKOFF_MS: u64 = 5 * 60 * 1_000;

/// Doubles per attempt up to the ceiling, and never overflows however long an Account is offline.
///
/// The delay is deliberately not randomized. One Device retrying its own accepted work is not a
/// thundering herd, and a reproducible schedule is worth more here than jitter.
fn backoff_ms(attempt_count: u64) -> u64 {
    let exponent = u32::try_from(attempt_count.saturating_sub(1).min(20)).unwrap_or(20);
    (BASE_BACKOFF_MS << exponent).min(MAX_BACKOFF_MS)
}

/// Suppresses duplicate sends inside one Runtime, and supplies nothing else.
///
/// It is in-memory and it expires. A crashed process leaves no lease behind, a stalled attempt
/// cannot pin work forever, and two holders at once change only how much network is wasted: the
/// Server's `(User, Operation ID)` table is what makes the effect happen once.
#[derive(Default)]
pub(crate) struct DispatchLeases {
    held: Mutex<HashMap<String, u64>>,
}

/// Releases its lease on drop, including on an unwind out of a dispatch attempt.
pub(crate) struct DispatchLease {
    leases: Arc<DispatchLeases>,
    operation_id: String,
}

impl DispatchLeases {
    pub(crate) fn acquire(
        self: &Arc<Self>,
        operation_id: &str,
        now_ms: u64,
    ) -> Option<DispatchLease> {
        let mut held = self.held.lock().expect("dispatch lease lock poisoned");
        held.retain(|_, expires_at| *expires_at > now_ms);
        if held.contains_key(operation_id) {
            return None;
        }
        held.insert(
            operation_id.to_owned(),
            now_ms.saturating_add(DISPATCH_LEASE_MS),
        );
        Some(DispatchLease {
            leases: Arc::clone(self),
            operation_id: operation_id.to_owned(),
        })
    }
}

impl Drop for DispatchLease {
    fn drop(&mut self) {
        self.leases
            .held
            .lock()
            .expect("dispatch lease lock poisoned")
            .remove(&self.operation_id);
    }
}

/// What one scan of every Account's accepted work decided to do next.
enum DispatchPass {
    /// Something was attempted or something durable moved. Read the Replica again.
    Progressed,
    /// Nothing is eligible and no clock can change that. Only an event can.
    Parked,
    /// Nothing is eligible yet, but Device time alone will make it eligible.
    WaitFor { milliseconds: u64 },
}

/// What one attempt at one Operation left behind.
enum AttemptOutcome {
    /// Backoff moved, or the Server answered. Either way the next scan sees new durable truth.
    Progressed,
    /// This Account needs reauthentication. The Operation stays; the scan skips the Account.
    Parked,
}

impl Runtime {
    /// The Runtime's only background loop: it owns every accepted Operation until an authoritative
    /// semantic outcome ends it, which is the next slice's work.
    ///
    /// It is a plain future rather than a spawned task because the crate has no scheduler and must
    /// not acquire one: a Worker host drives it with the same `spawn_local` it already uses for
    /// observation delivery, and a native host drives it from its own executor. It returns when
    /// the Runtime closes, so a host owns its lifetime by owning the future.
    #[doc(hidden)]
    pub async fn run_operation_dispatch(self: Arc<Self>) {
        if self.auth_client_config.is_none() {
            // Without Server identity there is no request to make, and that never changes.
            return;
        }
        loop {
            if self.is_closed() {
                return;
            }
            // Enabling the wake-up before reading the Replica is what makes the loop safe to park:
            // anything accepted, renewed, or closed during the scan is already registered here.
            let mut wake = std::pin::pin!(self.dispatch_wake.notified());
            wake.as_mut().enable();
            let pass = self.dispatch_eligible_operations().await;
            if self.is_closed() {
                return;
            }
            match pass {
                DispatchPass::Progressed => continue,
                DispatchPass::Parked => wake.await,
                DispatchPass::WaitFor { milliseconds } => {
                    tokio::select! {
                        () = wake => {}
                        () = self.device_timer.sleep_ms(milliseconds) => {}
                    }
                }
            }
        }
    }

    /// Wakes the dispatcher because something that can change eligibility happened.
    pub(super) fn wake_dispatch(&self) {
        self.dispatch_wake.notify_waiters();
    }

    /// A usable Session exists again, so parked work can resume immediately instead of waiting for
    /// a timer that a parked Operation deliberately does not set.
    pub(super) fn note_session_available(&self, account_id: &AccountId) {
        self.clear_waiting_reason(account_id);
        self.device_revision.fetch_add(1, Ordering::SeqCst);
        self.wake_dispatch();
        self.publish_all_unless_closed();
    }

    /// Finds the first Operation this Device may send right now, and says what to do afterwards.
    async fn dispatch_eligible_operations(&self) -> DispatchPass {
        let Ok(now_ms) = self.clock.now_ms() else {
            return DispatchPass::Parked;
        };
        let mut earliest: Option<u64> = None;
        let mut leased_elsewhere = false;
        for snapshot in self.replica.snapshots() {
            if snapshot.operations.is_empty() || snapshot.failure.is_some() {
                continue;
            }
            if self
                .waiting_reasons
                .lock()
                .expect("waiting reason lock poisoned")
                .get(&snapshot.account_id)
                == Some(&AccountWaitingReason::ReauthenticationRequired)
            {
                // Parked on a Session, not on a clock. Only `note_session_available` frees it.
                continue;
            }
            for operation in &snapshot.operations {
                if self
                    .awaiting_outcome
                    .lock()
                    .expect("awaiting outcome lock poisoned")
                    .contains(&operation.operation_id)
                {
                    continue;
                }
                if operation.scheduling.not_before_ms > now_ms {
                    earliest = Some(
                        earliest.map_or(operation.scheduling.not_before_ms, |current| {
                            current.min(operation.scheduling.not_before_ms)
                        }),
                    );
                    continue;
                }
                let Some(lease) = self
                    .dispatch_leases
                    .acquire(&operation.operation_id, now_ms)
                else {
                    leased_elsewhere = true;
                    continue;
                };
                let outcome = self.attempt_dispatch(&snapshot, operation).await;
                drop(lease);
                return match outcome {
                    AttemptOutcome::Progressed | AttemptOutcome::Parked => DispatchPass::Progressed,
                };
            }
        }
        match earliest {
            Some(deadline) => DispatchPass::WaitFor {
                milliseconds: deadline.saturating_sub(now_ms).max(1),
            },
            None if leased_elsewhere => DispatchPass::WaitFor {
                milliseconds: DISPATCH_LEASE_MS,
            },
            None => DispatchPass::Parked,
        }
    }

    /// Replays one Operation's immutable bytes against the Session that is current right now.
    ///
    /// Every exit either moves durable backoff, parks the Account on a Session, or records that
    /// the Server already holds an answer. That is what keeps the loop from spinning.
    async fn attempt_dispatch(
        &self,
        snapshot: &ReplicaSnapshot,
        operation: &OperationRecord,
    ) -> AttemptOutcome {
        let account_id = &snapshot.account_id;
        let Some(auth_config) = self.auth_client_config.clone() else {
            return AttemptOutcome::Parked;
        };
        let metadata = match self
            .platform_storage
            .load_account_metadata(account_id, &snapshot.incarnation)
            .await
        {
            Ok(Some(metadata)) => metadata,
            Ok(None) => {
                self.mark_reauthentication_required(account_id);
                return AttemptOutcome::Parked;
            }
            Err(_) => {
                self.persist_backoff(snapshot, operation).await;
                return AttemptOutcome::Progressed;
            }
        };
        let session = match self
            .platform_storage
            .load_current_session(account_id, &snapshot.incarnation)
            .await
        {
            Ok(Some(session)) => session,
            // No Session is the same answer as an unrenewable one: preserve the Operation and say
            // what the Account is waiting for.
            Ok(None) => {
                self.mark_reauthentication_required(account_id);
                return AttemptOutcome::Parked;
            }
            Err(_) => {
                self.persist_backoff(snapshot, operation).await;
                return AttemptOutcome::Progressed;
            }
        };
        let http = match AuthHttpClient::new(
            &self.http_transport,
            &metadata.normalized_server_url,
            metadata.insecure_transport_confirmed,
            auth_config,
        ) {
            Ok(http) => http,
            Err(_) => {
                self.persist_backoff(snapshot, operation).await;
                return AttemptOutcome::Progressed;
            }
        };
        self.send_with_session(snapshot, operation, &http, session)
            .await
    }

    async fn send_with_session(
        &self,
        snapshot: &ReplicaSnapshot,
        operation: &OperationRecord,
        http: &AuthHttpClient<'_>,
        session: CurrentSessionDocument,
    ) -> AttemptOutcome {
        let account_id = &snapshot.account_id;
        let cancellation = RequestCancellation::new();
        let mut answer = http
            .dispatch_operation(
                session.token.as_ref(),
                &operation.operation_id,
                &operation.request,
                cancellation.clone(),
            )
            .await;

        // One `401` is the renewable Session answer, and it is renewed exactly the way Bootstrap
        // renews it. A second `401` after a fresh Session is the reauthentication boundary.
        if matches!(answer, Ok(AuthenticatedOutcome::ReauthenticationRequired)) {
            match self
                .renew_session(account_id, &session, http, cancellation.clone())
                .await
            {
                Ok(renewed) => {
                    answer = http
                        .dispatch_operation(
                            renewed.token.as_ref(),
                            &operation.operation_id,
                            &operation.request,
                            cancellation,
                        )
                        .await;
                }
                Err(error) if error.code == RuntimeErrorCode::AuthenticationRequired => {
                    self.persist_backoff(snapshot, operation).await;
                    self.mark_reauthentication_required(account_id);
                    return AttemptOutcome::Parked;
                }
                Err(_) => {
                    self.persist_backoff(snapshot, operation).await;
                    return AttemptOutcome::Progressed;
                }
            }
        }

        match answer {
            // The Server holds an answer for these exact bytes. Reading it, verifying its
            // fingerprint, and reconciling authority belongs to the outcome slice, so the
            // Operation and its encrypted overlay stay exactly as they are.
            Ok(AuthenticatedOutcome::Ok(_)) => {
                self.awaiting_outcome
                    .lock()
                    .expect("awaiting outcome lock poisoned")
                    .insert(operation.operation_id.clone());
                AttemptOutcome::Progressed
            }
            Ok(AuthenticatedOutcome::ReauthenticationRequired) => {
                self.persist_backoff(snapshot, operation).await;
                self.mark_reauthentication_required(account_id);
                AttemptOutcome::Parked
            }
            Ok(AuthenticatedOutcome::Transient) | Err(_) => {
                self.persist_backoff(snapshot, operation).await;
                AttemptOutcome::Progressed
            }
        }
    }

    /// Moves the only two things an attempt is allowed to move.
    ///
    /// The whole record travels so the Replica can refuse any commit that would change the
    /// immutable half, and a rejected or fenced commit simply leaves the durable schedule alone.
    async fn persist_backoff(&self, snapshot: &ReplicaSnapshot, operation: &OperationRecord) {
        let Ok(now_ms) = self.clock.now_ms() else {
            return;
        };
        let attempt_count = operation.scheduling.attempt_count.saturating_add(1);
        let rescheduled = OperationRecord {
            scheduling: OperationSchedulingState {
                attempt_count,
                not_before_ms: now_ms.saturating_add(backoff_ms(attempt_count)),
            },
            ..operation.clone()
        };
        let result = self
            .replica
            .execute_recomputing(GuardedCommitPlan::new(
                snapshot.account_id.clone(),
                snapshot.incarnation.clone(),
                snapshot.revision,
                snapshot.lock_epoch,
                vec![PlanMutation::RescheduleOperation(rescheduled)],
            ))
            .await;
        if let Ok(RecomputedPlanResult::Applied { snapshot }) = result {
            let publication = self.publication.lock().expect("publication lock poisoned");
            self.replica.cache(snapshot);
            self.device_revision.fetch_add(1, Ordering::SeqCst);
            drop(publication);
            self.publish_all_unless_closed();
        }
    }

    /// Sends one Operation as if this Runtime held its lease, so a test can put two senders on the
    /// same accepted work and watch the Server, not the lease, decide what happens.
    #[cfg(test)]
    pub(crate) async fn dispatch_once_ignoring_lease(
        &self,
        account_id: &AccountId,
        operation_id: &str,
    ) {
        let Some(snapshot) = self.replica.snapshot(account_id) else {
            return;
        };
        let Some(operation) = snapshot
            .operations
            .iter()
            .find(|candidate| candidate.operation_id == operation_id)
            .cloned()
        else {
            return;
        };
        let _ = self.attempt_dispatch(&snapshot, &operation).await;
    }
}
