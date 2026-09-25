//! Desktop's authenticated Account reads belong to the existing Core driver.
use super::*;
use crate::{auth_http::AuthenticatedOutcome, Incarnation};
use std::{future::Future, pin::Pin, task::Poll};

const METADATA_INTERVAL_MS: u64 = 60_000;
const VALIDATION_INTERVAL_MS: u64 = 300_000;

#[cfg(not(target_arch = "wasm32"))]
type RefreshFuture<'a> = Pin<Box<dyn Future<Output = ()> + Send + 'a>>;
#[cfg(target_arch = "wasm32")]
type RefreshFuture<'a> = Pin<Box<dyn Future<Output = ()> + 'a>>;

struct DriverLease<'a>(&'a AtomicBool);
impl Drop for DriverLease<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::SeqCst);
    }
}

impl Runtime {
    pub(super) async fn run_account_refresh(&self) {
        if !self
            .auth_client_config
            .as_ref()
            .is_some_and(|config| matches!(config.platform, crate::ClientPlatform::Desktop))
            || self.account_refresh_active.swap(true, Ordering::SeqCst)
        {
            return;
        }
        let _lease = DriverLease(&self.account_refresh_active);
        let mut tasks: Vec<(AccountId, Incarnation, RefreshFuture<'_>)> = Vec::new();
        loop {
            let mut wake = std::pin::pin!(self.dispatch_wake.notified());
            wake.as_mut().enable();
            if self.is_closed() {
                return;
            }
            for snapshot in self.replica.snapshots() {
                if !self.refresh_eligible(&snapshot.account_id, &snapshot.incarnation)
                    || tasks.iter().any(|(id, incarnation, _)| {
                        id == &snapshot.account_id && incarnation == &snapshot.incarnation
                    })
                {
                    continue;
                }
                let id = snapshot.account_id.clone();
                let incarnation = snapshot.incarnation.clone();
                tasks.push((
                    snapshot.account_id,
                    snapshot.incarnation,
                    Box::pin(async move {
                        self.run_account_refresh_scope(id, incarnation).await;
                    }),
                ));
            }
            tokio::select! {
                () = wake => {},
                index = std::future::poll_fn(|context| {
                    for (index, (_, _, task)) in tasks.iter_mut().enumerate() {
                        if task.as_mut().poll(context).is_ready() { return Poll::Ready(index); }
                    }
                    Poll::Pending
                }) => { drop(tasks.swap_remove(index)); }
            }
        }
    }

    fn refresh_eligible(&self, account_id: &AccountId, incarnation: &Incarnation) -> bool {
        !self.is_closed()
            && self.ready.load(Ordering::SeqCst)
            && !self.account_teardown_is_pending(account_id)
            && self.replica.snapshot(account_id).is_some_and(|snapshot| {
                snapshot.incarnation == *incarnation && snapshot.failure.is_none()
            })
            && matches!(
                self.account_access
                    .lock()
                    .expect("Account access lock poisoned")
                    .get(account_id),
                Some(AccountAccessState::Locked | AccountAccessState::Unlocked)
            )
            && self
                .waiting_reasons
                .lock()
                .expect("waiting reasons lock poisoned")
                .get(account_id)
                != Some(&AccountWaitingReason::ReauthenticationRequired)
    }

    async fn run_account_refresh_scope(&self, account_id: AccountId, incarnation: Incarnation) {
        let mut validation_due = 0;
        let mut metadata_due = 0;
        loop {
            let mut wake = std::pin::pin!(self.dispatch_wake.notified());
            wake.as_mut().enable();
            if !self.refresh_eligible(&account_id, &incarnation) {
                return;
            }
            let now = match self.clock.now_ms() {
                Ok(now) => now,
                Err(_) => {
                    tokio::select! { () = wake => {}, () = self.device_timer.sleep_ms(METADATA_INTERVAL_MS) => {} }
                    continue;
                }
            };
            let unlocked = self
                .account_access
                .lock()
                .expect("Account access lock poisoned")
                .get(&account_id)
                == Some(&AccountAccessState::Unlocked);
            let due = if unlocked {
                validation_due.min(metadata_due)
            } else {
                validation_due
            };
            if due <= now {
                // One finite attempt fulfils both schedules. Failures never spin or reset ownership.
                validation_due = now.saturating_add(VALIDATION_INTERVAL_MS);
                if unlocked {
                    metadata_due = now.saturating_add(METADATA_INTERVAL_MS);
                }
                let _ = self
                    .refresh_account_identity(&account_id, &incarnation, unlocked)
                    .await;
                continue;
            }
            tokio::select! { () = wake => {}, () = self.device_timer.sleep_ms(due.saturating_sub(now)) => {} }
        }
    }

    fn refresh_scope_current(&self, snapshot: &ReplicaSnapshot, unlocked: bool) -> bool {
        self.refresh_eligible(&snapshot.account_id, &snapshot.incarnation)
            && !self.account_access_retirement_is_pending(&snapshot.account_id)
            && self
                .replica
                .snapshot(&snapshot.account_id)
                .is_some_and(|current| current.lock_epoch == snapshot.lock_epoch)
            && (self
                .account_access
                .lock()
                .expect("Account access lock poisoned")
                .get(&snapshot.account_id)
                == Some(&AccountAccessState::Unlocked))
                == unlocked
    }

    async fn refresh_account_identity(
        &self,
        account_id: &AccountId,
        incarnation: &Incarnation,
        unlocked: bool,
    ) -> Result<(), RuntimeError> {
        let snapshot = self.require_snapshot(account_id)?;
        if snapshot.incarnation != *incarnation || !self.refresh_scope_current(&snapshot, unlocked)
        {
            return Ok(());
        }
        let cancellation = RequestCancellation::new();
        let _lifetime =
            self.foreground_attachments
                .register(account_id, incarnation, cancellation.clone())?;
        let execution = self.account_execution_lock(account_id)?;
        let _execution = tokio::select! {
            biased;
            () = cancellation.cancelled() => return Ok(()),
            guard = execution.lock() => guard,
        };
        if !self.refresh_scope_current(&snapshot, unlocked) {
            return Ok(());
        }
        let Some(metadata) = self
            .platform_storage
            .load_account_metadata(account_id, incarnation)
            .await?
        else {
            return Ok(());
        };
        let Some(session) = self
            .platform_storage
            .load_current_session(account_id, incarnation)
            .await?
        else {
            return Ok(());
        };
        if !self.refresh_scope_current(&snapshot, unlocked) {
            return Ok(());
        }
        let http = AuthHttpClient::new(
            &self.http_transport,
            &metadata.normalized_server_url,
            metadata.insecure_transport_confirmed,
            self.auth_client_config.clone().expect("configured refresh"),
        )?;
        drop(_execution);
        let mut session = session;
        let mut renewed = false;
        loop {
            let answer = tokio::select! {
                biased;
                () = cancellation.cancelled() => return Ok(()),
                answer = http.account_identity(session.token.as_ref(), cancellation.clone()) => answer?,
            };
            let execution_guard = tokio::select! {
                biased;
                () = cancellation.cancelled() => return Ok(()),
                guard = execution.lock() => guard,
            };
            if !self
                .refresh_session_current(&snapshot, unlocked, &session)
                .await?
            {
                return Ok(());
            }
            match answer {
                AuthenticatedOutcome::Ok(identity) => {
                    if identity.id != snapshot.user_id {
                        return Err(RuntimeError::new(
                            RuntimeErrorCode::AuthenticationUnavailable,
                            "Account refresh returned another User",
                        ));
                    }
                    if unlocked && metadata.team_avatar_url != identity.team_avatar_url {
                        // Another foreground command may have changed policy during the HTTP read.
                        let Some(mut current) = self
                            .platform_storage
                            .load_account_metadata(account_id, incarnation)
                            .await?
                        else {
                            return Ok(());
                        };
                        if !self.refresh_scope_current(&snapshot, unlocked) {
                            return Ok(());
                        }
                        current.team_avatar_url = identity.team_avatar_url;
                        current.team_name = identity.team_name;
                        self.platform_storage
                            .store_account_metadata(&current)
                            .await?;
                        if !self.refresh_scope_current(&snapshot, unlocked) {
                            return Ok(());
                        }
                        let _publication =
                            self.publication.lock().expect("publication lock poisoned");
                        self.account_display_identities
                            .lock()
                            .expect("Account display identity lock poisoned")
                            .insert(account_id.clone(), account_presentation(&current));
                        self.device_revision.fetch_add(1, Ordering::SeqCst);
                        drop(_publication);
                        self.publish_all_unless_closed();
                    }
                    return Ok(());
                }
                AuthenticatedOutcome::Transient => return Ok(()),
                AuthenticatedOutcome::ReauthenticationRequired if !renewed => {
                    drop(execution_guard);
                    let refresh = tokio::select! {
                        biased;
                        () = cancellation.cancelled() => return Ok(()),
                        result = http.refresh_session(session.token.as_ref(), cancellation.clone()) => result?,
                    };
                    let execution_guard = tokio::select! {
                        biased;
                        () = cancellation.cancelled() => return Ok(()),
                        guard = execution.lock() => guard,
                    };
                    if !self
                        .refresh_session_current(&snapshot, unlocked, &session)
                        .await?
                    {
                        return Ok(());
                    }
                    match refresh {
                        AuthenticatedOutcome::Ok(refreshed) => {
                            session = self.store_renewed_session(&session, refreshed).await?;
                            if !self.refresh_scope_current(&snapshot, unlocked) {
                                return Ok(());
                            }
                            self.note_session_available(account_id);
                            renewed = true;
                            drop(execution_guard);
                            continue;
                        }
                        AuthenticatedOutcome::Transient => return Ok(()),
                        AuthenticatedOutcome::ReauthenticationRequired => {
                            drop(execution_guard);
                            break;
                        }
                    }
                }
                AuthenticatedOutcome::ReauthenticationRequired => {
                    drop(execution_guard);
                    break;
                }
            }
        }
        // Lifecycle must never drain the very read scope waiting for that lifecycle to finish.
        drop(_lifetime);
        loop {
            match self
                .retire_refused_session(&session, snapshot.lock_epoch)
                .await
            {
                Ok(_) => break,
                Err(error)
                    if error.code == RuntimeErrorCode::StorageUnavailable && !self.is_closed() =>
                {
                    // The refusal is already visible and live keys are retired. Keep its exact
                    // scoped cleanup here even though ordinary refresh is now ineligible. Other
                    // Accounts continue independently; no authentication HTTP is repeated.
                    let due = self.clock.now_ms()?.saturating_add(1_000);
                    loop {
                        let mut wake = std::pin::pin!(self.dispatch_wake.notified());
                        wake.as_mut().enable();
                        if self.is_closed() {
                            return Ok(());
                        }
                        let now = self.clock.now_ms()?;
                        if now >= due {
                            break;
                        }
                        tokio::select! { () = wake => {}, () = self.device_timer.sleep_ms(due.saturating_sub(now)) => {} }
                    }
                }
                Err(error) => return Err(error),
            }
        }
        Ok(())
    }

    async fn refresh_session_current(
        &self,
        snapshot: &ReplicaSnapshot,
        unlocked: bool,
        expected: &crate::platform_storage::CurrentSessionDocument,
    ) -> Result<bool, RuntimeError> {
        if !self.refresh_scope_current(snapshot, unlocked) {
            return Ok(false);
        }
        let current = self
            .platform_storage
            .load_current_session(&snapshot.account_id, &snapshot.incarnation)
            .await?;
        // Lock registers intent without waiting for storage or the execution fence. Recheck
        // after the primitive answers, before admitting more HTTP or a credential write.
        Ok(current.as_ref() == Some(expected) && self.refresh_scope_current(snapshot, unlocked))
    }
}
