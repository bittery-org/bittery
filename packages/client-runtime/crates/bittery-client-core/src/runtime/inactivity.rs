//! Inactivity is Device policy. Hosts report scoped input; the existing Runtime driver owns time.
use super::*;
use crate::Incarnation;

#[derive(Clone, PartialEq, Eq)]
struct Activity {
    account_id: AccountId,
    incarnation: Incarnation,
    received_at_ms: u64,
    revision: u64,
}
#[derive(Default)]
pub(super) struct InactivityState {
    activity: Mutex<Option<Activity>>,
    receipt_sequence: AtomicU64,
    pub(super) wake: tokio::sync::Notify,
}

impl Runtime {
    /// The native status projection observes Core's existing selection and receipt revision.
    /// It never creates a second inactivity owner or infers a UI Active Account.
    pub(super) fn inactivity_status_selection(&self) -> Option<(AccountId, Incarnation, u64)> {
        self.inactivity
            .activity
            .lock()
            .expect("activity lock poisoned")
            .as_ref()
            .map(|activity| {
                (
                    activity.account_id.clone(),
                    activity.incarnation.clone(),
                    activity.revision,
                )
            })
    }

    pub(super) async fn request_local_security(
        &self,
        request: RuntimeRequest,
        cancellation: RequestCancellation,
    ) -> Result<RuntimeResponse, RuntimeError> {
        let account_id = request
            .account_id()
            .expect("local security command is Account scoped")
            .clone();
        self.ensure_open()?;
        let expected = self.require_snapshot(&account_id)?;
        let receipt = if matches!(&request, RuntimeRequest::RecordActivity { .. }) {
            Some((
                self.clock.now_ms()?,
                self.inactivity
                    .receipt_sequence
                    .fetch_add(1, Ordering::SeqCst),
            ))
        } else {
            None
        };
        let _admission = self.teardown_admission.read().await;
        let execution = self.account_execution_lock(&account_id)?;
        let _execution = execution.lock().await;
        self.ensure_open()?;
        self.reject_request_during_pending_teardown(&request)?;
        let snapshot = self.require_snapshot(&account_id)?;
        if expected.incarnation != snapshot.incarnation {
            return Err(RuntimeError::new(
                RuntimeErrorCode::AuthenticationRequired,
                "Local security input belongs to a retired Account generation",
            ));
        }
        if cancellation.is_cancelled() {
            return Err(activity_cancelled());
        }
        match request {
            RuntimeRequest::RecordActivity { .. } => {
                let (received_at_ms, revision) =
                    receipt.expect("activity receipt captured before lifecycle waits");
                let mut current = self
                    .inactivity
                    .activity
                    .lock()
                    .expect("activity lock poisoned");
                if current
                    .as_ref()
                    .is_some_and(|activity| activity.revision > revision)
                {
                    return Ok(RuntimeResponse::ActivityRecorded);
                }
                *current = Some(Activity {
                    account_id,
                    incarnation: snapshot.incarnation,
                    received_at_ms,
                    revision,
                });
                drop(current);
                self.inactivity.wake.notify_waiters();
                Ok(RuntimeResponse::ActivityRecorded)
            }
            RuntimeRequest::SetInactivityTimeout { timeout_ms, .. } => {
                self.platform_storage
                    .store_inactivity_timeout(&account_id, timeout_ms)
                    .await?;
                self.inactivity.wake.notify_waiters();
                self.local_security_settings(account_id).await
            }
            RuntimeRequest::LocalSecuritySettings { .. } => {
                self.local_security_settings(account_id).await
            }
            _ => unreachable!("only local security commands are routed here"),
        }
    }

    async fn local_security_settings(
        &self,
        account_id: AccountId,
    ) -> Result<RuntimeResponse, RuntimeError> {
        Ok(RuntimeResponse::LocalSecuritySettings {
            inactivity_timeout_ms: self
                .platform_storage
                .load_inactivity_timeout(&account_id)
                .await?,
            master_password_reentry_period_ms: self
                .platform_storage
                .load_local_security()
                .await?
                .map_or(30 * 24 * 60 * 60 * 1000, |value| {
                    value.master_password_reentry_period_ms
                }),
            account_id,
        })
    }

    pub(super) fn reset_inactivity_after_unlock(&self, account_id: &AccountId) {
        // Ticket 67 moves Desktop's policy. Other applications still have their existing activity
        // owners and must explicitly migrate those inputs before automatic activation here.
        if !self
            .auth_client_config
            .as_ref()
            .is_some_and(|config| matches!(config.platform, crate::ClientPlatform::Desktop))
        {
            return;
        }
        let Some(snapshot) = self.replica.snapshot(account_id) else {
            return;
        };
        let mut state = self
            .inactivity
            .activity
            .lock()
            .expect("activity lock poisoned");
        let replace = state.as_ref().is_none_or(|activity| {
            &activity.account_id == account_id
                || self.replica.snapshot(&activity.account_id).is_none()
        });
        if replace {
            let revision = self
                .inactivity
                .receipt_sequence
                .fetch_add(1, Ordering::SeqCst);
            // A clock error makes the next policy evaluation fail closed; it cannot grant grace.
            let received_at_ms = self.clock.now_ms().unwrap_or(0);
            *state = Some(Activity {
                account_id: account_id.clone(),
                incarnation: snapshot.incarnation,
                received_at_ms,
                revision,
            });
        }
        drop(state);
        self.inactivity.wake.notify_waiters();
    }

    pub(super) async fn evaluate_inactivity(&self) -> Result<Option<u64>, RuntimeError> {
        self.ensure_open()?;
        let Some(expected) = self
            .inactivity
            .activity
            .lock()
            .expect("activity lock poisoned")
            .clone()
        else {
            return Ok(None);
        };
        let selected_is_current = self
            .replica
            .snapshot(&expected.account_id)
            .is_some_and(|snapshot| snapshot.incarnation == expected.incarnation)
            && !self.account_teardown_is_pending(&expected.account_id);
        if !self
            .account_access
            .lock()
            .expect("Account access lock poisoned")
            .values()
            .any(|access| *access == AccountAccessState::Unlocked)
        {
            return Ok(None);
        }
        let timeout = if selected_is_current {
            self.platform_storage
                .load_inactivity_timeout(&expected.account_id)
                .await
        } else {
            // Preserve the existing default when the selected Account disappears. Other Accounts
            // remain protected even when its renderer cannot report a new selection.
            Ok(600_000)
        };
        // Unreadable policy must never behave like Never. Retire access and return the error.
        let now = self.clock.now_ms();
        let failure = timeout
            .as_ref()
            .err()
            .cloned()
            .or_else(|| now.as_ref().err().cloned());
        let timeout = if failure.is_some() {
            0
        } else {
            timeout.unwrap_or(0)
        };
        if timeout < 0 {
            return Ok(None);
        }
        let elapsed = now
            .unwrap_or(expected.received_at_ms)
            .saturating_sub(expected.received_at_ms);
        let remaining = (timeout as u64).saturating_sub(elapsed);
        {
            let state = self
                .inactivity
                .activity
                .lock()
                .expect("activity lock poisoned");
            if state.as_ref() != Some(&expected) {
                return Ok(Some(0));
            }
            if remaining > 0 {
                return Ok(Some(remaining));
            }
        }
        let targets: Vec<_> = self
            .account_access
            .lock()
            .expect("Account access lock poisoned")
            .iter()
            .filter(|(_, access)| **access == AccountAccessState::Unlocked)
            .map(|(account, _)| account.clone())
            .collect();
        // Poll every existing retirement before waiting for one. A slow Account file drain cannot
        // defer registering the other Accounts' retirement intents.
        let mut retirements: Vec<_> = targets
            .iter()
            .map(|account| {
                Some(Box::pin(
                    self.retire_account_access(account, AccessRetirement::Lock),
                ))
            })
            .collect();
        let mut first_failure = failure;
        std::future::poll_fn(|cx| {
            let mut pending = false;
            for retirement in &mut retirements {
                let Some(future) = retirement else { continue };
                match std::future::Future::poll(future.as_mut(), cx) {
                    std::task::Poll::Ready(result) => {
                        if let Err(error) = result {
                            if first_failure.is_none() {
                                first_failure = Some(error)
                            }
                        }
                        *retirement = None;
                    }
                    std::task::Poll::Pending => pending = true,
                }
            }
            if pending {
                std::task::Poll::Pending
            } else {
                std::task::Poll::Ready(())
            }
        })
        .await;
        if let Some(error) = first_failure {
            return Err(error);
        }
        Ok(None)
    }

    pub(super) async fn run_inactivity(&self) {
        loop {
            if self.is_closed() {
                return;
            }
            let mut wake = std::pin::pin!(self.inactivity.wake.notified());
            wake.as_mut().enable();
            let delay = self.evaluate_inactivity().await.ok().flatten();
            if self.is_closed() {
                return;
            }
            match delay {
                Some(milliseconds) => {
                    tokio::select! { () = wake => {}, () = self.device_timer.sleep_ms(milliseconds.min(5_000)) => {} }
                }
                None => wake.await,
            }
        }
    }
}
fn activity_cancelled() -> RuntimeError {
    RuntimeError::new(
        RuntimeErrorCode::Cancelled,
        "Local security input was cancelled",
    )
}
