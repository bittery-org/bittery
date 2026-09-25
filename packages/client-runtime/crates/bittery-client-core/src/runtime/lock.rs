use super::*;

struct PendingAccessRetirement {
    intent: Arc<Mutex<usize>>,
    active: bool,
}

impl PendingAccessRetirement {
    fn new(intent: Arc<Mutex<usize>>) -> Self {
        let mut pending = intent
            .lock()
            .expect("pending Account access retirement lock poisoned");
        *pending += 1;
        drop(pending);
        Self {
            intent,
            active: true,
        }
    }

    fn finish(mut self) {
        self.remove();
        self.active = false;
    }

    fn remove(&self) {
        let mut pending = self
            .intent
            .lock()
            .expect("pending Account access retirement lock poisoned");
        assert!(
            *pending > 0,
            "pending Account access retirement was registered"
        );
        *pending -= 1;
    }
}

impl Drop for PendingAccessRetirement {
    fn drop(&mut self) {
        if self.active {
            self.remove();
        }
    }
}

/// How far one request retires an Account's access on this Device.
///
/// Both forms destroy the same live material. They differ only in what the Device keeps: `Lock`
/// keeps the Quick Unlock material and Session that one master password reopens, while `SignOut`
/// forgets them and leaves the Account needing a full Sign-in. Neither touches the durable
/// Replica or its accepted Operations: sign-out is not a cancellation, and it cannot reverse a
/// Server effect that may already be committed.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum AccessRetirement {
    Lock,
    SignOut,
    RefusedSession,
}

impl AccessRetirement {
    fn resulting_access(self) -> AccountAccessState {
        match self {
            Self::Lock | Self::RefusedSession => AccountAccessState::Locked,
            Self::SignOut => AccountAccessState::SignedOut,
        }
    }
}

impl Runtime {
    #[cfg(test)]
    pub(crate) async fn unlock_account(&self, account_id: &AccountId) -> Result<(), RuntimeError> {
        let execution_lock = self.account_execution_lock(account_id)?;
        let _execution_guard = execution_lock.lock().await;
        self.ensure_open()?;
        if self
            .lock_epoch_pending
            .lock()
            .expect("pending lock epoch lock poisoned")
            .contains_key(account_id)
        {
            return Err(RuntimeError::new(
                RuntimeErrorCode::InvariantViolation,
                "Account lock epoch persistence is pending",
            ));
        }
        let snapshot = self.replica.snapshot(account_id).ok_or_else(|| {
            RuntimeError::new(RuntimeErrorCode::AccountMissing, "account is not installed")
        })?;
        if snapshot.lock_epoch == u64::MAX {
            return Err(RuntimeError::new(
                RuntimeErrorCode::InvariantViolation,
                "Account lock epoch is exhausted",
            ));
        }
        {
            let _publication = self.publication.lock().expect("publication lock poisoned");
            self.account_access
                .lock()
                .expect("Account access lock poisoned")
                .insert(account_id.clone(), AccountAccessState::Unlocked);
            self.unlocked_items
                .lock()
                .expect("unlocked projection lock poisoned")
                .entry(account_id.clone())
                .or_default();
            // The durable epoch, not zero: a Quick Unlock preserves what the Replica already
            // holds, and a restored Account can carry an epoch a previous close advanced.
            self.account_lock_epochs
                .lock()
                .expect("Account lock epoch lock poisoned")
                .entry(account_id.clone())
                .or_insert(snapshot.lock_epoch);
            // A real unlock ends with the Account's live master unlock key in memory. Tests that
            // write locally need the same key the seeded Vault fixture wrapped its Vault key
            // under.
            self.seed_live_master_unlock_key(account_id, &snapshot.incarnation);
        }
        // And a real unlock ends by projecting what the Replica already holds. Without this the
        // shortcut would show an empty Account after every restart and quietly disagree with the
        // Sign-in and Quick Unlock paths it stands in for.
        self.decrypt_visible_items(account_id)
    }

    #[doc(hidden)]
    pub async fn mark_account_locked(&self, account_id: &AccountId) -> Result<(), RuntimeError> {
        self.retire_account_access(account_id, AccessRetirement::Lock)
            .await
            .map(|_| ())
    }

    /// Retires live access to one Account and answers the access state this Device now holds.
    ///
    /// An Account this Device does not have is already retired, so an unknown or removed Account
    /// answers `SignedOut` instead of failing. That keeps a host's teardown path free of
    /// error handling it cannot act on, and it makes a repeated request harmless.
    pub(crate) async fn retire_account_access(
        &self,
        account_id: &AccountId,
        retirement: AccessRetirement,
    ) -> Result<AccountAccessState, RuntimeError> {
        self.retire_account_access_guarded(account_id, retirement, None, None)
            .await
    }

    pub(super) async fn retire_refused_session(
        &self,
        session: &crate::platform_storage::CurrentSessionDocument,
        lock_epoch: u64,
    ) -> Result<AccountAccessState, RuntimeError> {
        self.retire_account_access_guarded(
            &session.account_id,
            AccessRetirement::RefusedSession,
            Some((session, lock_epoch)),
            None,
        )
        .await
    }

    pub(super) async fn retire_account_generation(
        &self,
        snapshot: &ReplicaSnapshot,
    ) -> Result<AccountAccessState, RuntimeError> {
        self.retire_account_access_guarded(
            &snapshot.account_id,
            AccessRetirement::Lock,
            None,
            Some(snapshot),
        )
        .await
    }

    async fn require_retirement_authority(
        &self,
        session: Option<(&crate::platform_storage::CurrentSessionDocument, u64)>,
        generation: Option<&ReplicaSnapshot>,
    ) -> Result<(), RuntimeError> {
        self.require_refused_session(session).await?;
        self.require_retirement_generation(generation)
    }

    fn require_retirement_generation(
        &self,
        generation: Option<&ReplicaSnapshot>,
    ) -> Result<(), RuntimeError> {
        if generation.is_some_and(|expected| {
            !self
                .replica
                .snapshot(&expected.account_id)
                .is_some_and(|current| {
                    current.incarnation == expected.incarnation
                        && current.user_id == expected.user_id
                        && current.lock_epoch == expected.lock_epoch
                })
        }) {
            return Err(RuntimeError::new(
                RuntimeErrorCode::Cancelled,
                "Account authority was replaced before retirement",
            ));
        }
        Ok(())
    }
    async fn require_refused_session(
        &self,
        expected: Option<(&crate::platform_storage::CurrentSessionDocument, u64)>,
    ) -> Result<(), RuntimeError> {
        let Some((session, epoch)) = expected else {
            return Ok(());
        };
        if !self
            .replica
            .snapshot(&session.account_id)
            .is_some_and(|snapshot| {
                snapshot.incarnation == session.incarnation && snapshot.lock_epoch == epoch
            })
        {
            return Err(RuntimeError::new(
                RuntimeErrorCode::Cancelled,
                "Refused Session belongs to retired authority",
            ));
        }
        let current = self
            .platform_storage
            .load_current_session(&session.account_id, &session.incarnation)
            .await?;
        if current.as_ref() == Some(session) {
            return Ok(());
        }
        // A primitive deletion can take effect and lose its reply. Only this exact refused
        // Session's existing incomplete retirement may finish bookkeeping without a Session.
        // Normal Lock has no expected Session and never enters this branch.
        if current.is_none()
            && self
                .account_access
                .lock()
                .expect("Account access lock poisoned")
                .get(&session.account_id)
                == Some(&AccountAccessState::Locked)
            && self
                .waiting_reasons
                .lock()
                .expect("waiting reasons lock poisoned")
                .get(&session.account_id)
                == Some(&AccountWaitingReason::ReauthenticationRequired)
            && epoch.checked_add(1).is_some_and(|desired| {
                self.lock_epoch_pending
                    .lock()
                    .expect("pending lock epoch lock poisoned")
                    .get(&session.account_id)
                    == Some(&desired)
            })
        {
            return Ok(());
        }
        Err(RuntimeError::new(
            RuntimeErrorCode::Cancelled,
            "Refused Session was replaced or removed",
        ))
    }

    /// One immediate access fence for explicit Lock and native authority loss. Durable epoch
    /// completion still belongs to the existing scoped retirement path.
    pub(super) fn fence_account_access(
        &self,
        snapshot: &ReplicaSnapshot,
        access: AccountAccessState,
    ) -> Result<(Option<Arc<DeliveryToken>>, u64, bool), RuntimeError> {
        let publication = self.publication.lock().expect("publication lock poisoned");
        self.fence_account_access_under_publication(&publication, snapshot, access)
    }

    /// Native authority loss captures its foreground handoff in this same first-fence section.
    pub(super) fn fence_account_access_under_publication(
        &self,
        _publication: &std::sync::MutexGuard<'_, ()>,
        snapshot: &ReplicaSnapshot,
        access: AccountAccessState,
    ) -> Result<(Option<Arc<DeliveryToken>>, u64, bool), RuntimeError> {
        let account_id = &snapshot.account_id;
        let current = self.replica.snapshot(account_id).ok_or_else(|| {
            RuntimeError::new(RuntimeErrorCode::Cancelled, "Account authority is absent")
        })?;
        if current.incarnation != snapshot.incarnation
            || current.user_id != snapshot.user_id
            || current.lock_epoch != snapshot.lock_epoch
        {
            return Err(RuntimeError::new(
                RuntimeErrorCode::Cancelled,
                "Account authority was replaced before retirement",
            ));
        }
        let pending_epoch = self
            .lock_epoch_pending
            .lock()
            .expect("pending lock epoch lock poisoned")
            .get(account_id)
            .copied();
        let overflowed = snapshot.lock_epoch == u64::MAX;
        let desired_epoch = if overflowed {
            snapshot.lock_epoch
        } else {
            pending_epoch.unwrap_or(snapshot.lock_epoch + 1)
        };
        let invalidated_delivery = self.invalidate_delivery(account_id);
        self.unlocked_items
            .lock()
            .expect("unlocked projection lock poisoned")
            .remove(account_id);
        self.clear_live_master_unlock_keys_for_account(account_id);
        self.account_access
            .lock()
            .expect("Account access lock poisoned")
            .insert(account_id.clone(), access);
        self.account_lock_epochs
            .lock()
            .expect("Account lock epoch lock poisoned")
            .insert(account_id.clone(), desired_epoch);
        if overflowed {
            self.lock_epoch_pending
                .lock()
                .expect("pending lock epoch lock poisoned")
                .remove(account_id);
        } else {
            self.lock_epoch_pending
                .lock()
                .expect("pending lock epoch lock poisoned")
                .insert(account_id.clone(), desired_epoch);
        }
        self.device_revision.fetch_add(1, Ordering::SeqCst);
        Ok((invalidated_delivery, desired_epoch, overflowed))
    }

    async fn retire_account_access_guarded(
        &self,
        account_id: &AccountId,
        retirement: AccessRetirement,
        expected: Option<(&crate::platform_storage::CurrentSessionDocument, u64)>,
        generation: Option<&ReplicaSnapshot>,
    ) -> Result<AccountAccessState, RuntimeError> {
        let execution_lock = self.account_execution_lock(account_id)?;
        // Register before waiting on the Account execution fence. Work already inside the fence
        // may finish its durable commit, but it must not publish newly decrypted plaintext ahead
        // of a Lock or Sign-out that is already queued behind it.
        let guarded = expected.is_some() || generation.is_some();
        let mut pending_retirement = (!guarded).then(|| {
            PendingAccessRetirement::new(self.account_access_retirement_intent(account_id))
        });
        if !guarded {
            self.native_authority.retire_account(account_id);
            self.biometric.retire(account_id);
        }
        // Explicit user retirement cancels existing foreground loans before waiting for work
        // holding Account execution, including an image HTTP upload. Guarded background refusals
        // still prove their original authority before cancelling any current foreground work.
        let mut foreground_retirement = if !guarded {
            Some(
                self.foreground_attachments
                    .begin_account_retirement(account_id),
            )
        } else if generation.is_some() {
            // Native lock names an exact generation. Snapshot publication and foreground fencing
            // share this critical section so an old owner cannot cancel a replacement's loans.
            let _publication = self.publication.lock().expect("publication lock poisoned");
            self.require_retirement_generation(generation)?;
            Some(
                self.foreground_attachments
                    .begin_account_retirement(account_id),
            )
        } else {
            // A refused Session must still prove the current stored Session under execution;
            // Account generation alone cannot distinguish renewal within the same lock epoch.
            None
        };
        if let Some(retirement) = &foreground_retirement {
            // The explicit or exact-generation first fence has already won. Notify the host
            // after publication/native guards leave, before unrelated execution can delay cleanup.
            retirement.notify_retirement();
        }
        let lifecycle_lock = self.account_lifecycle_lock(account_id)?;
        let _lifecycle_guard = lifecycle_lock.lock().await;
        let _admission = self.teardown_admission.read().await;
        let lifecycle_request = match retirement {
            AccessRetirement::Lock | AccessRetirement::RefusedSession => RuntimeRequest::Lock {
                account_id: account_id.clone(),
            },
            AccessRetirement::SignOut => RuntimeRequest::SignOut {
                account_id: account_id.clone(),
            },
        };
        self.reject_request_during_pending_teardown(&lifecycle_request)?;
        let execution_guard = execution_lock.lock().await;
        self.require_retirement_authority(expected, generation)
            .await?;
        if guarded {
            // A background refusal names old authority, unlike an explicit user Lock. It must
            // prove that authority is still current before fencing any new Account disclosure.
            pending_retirement = Some(PendingAccessRetirement::new(
                self.account_access_retirement_intent(account_id),
            ));
            self.native_authority.retire_account(account_id);
            self.biometric.retire(account_id);
        }
        let foreground_retirement = foreground_retirement.take().unwrap_or_else(|| {
            self.foreground_attachments
                .begin_account_retirement(account_id)
        });
        drop(execution_guard);
        foreground_retirement.drain().await;
        let _execution_guard = execution_lock.lock().await;
        self.require_retirement_authority(expected, generation)
            .await?;
        if retirement == AccessRetirement::SignOut {
            // The current Session is the last production authority for discarding provisional
            // image bytes. Attempt cleanup behind the lifecycle and execution fences before
            // Sign-out forgets that Session; durable receipts retain any unfinished cleanup.
            self.best_effort_create_vault_remote_cleanup(std::slice::from_ref(account_id))
                .await;
        }
        self.retire_attachment_download_account(account_id).await;
        self.retire_attachment_upload_account(account_id).await;
        self.retire_vault_image_account(account_id).await;
        self.ensure_open()?;
        let Some(mut snapshot) = self.replica.snapshot(account_id) else {
            self.forget_uninstalled_account_access(account_id);
            self.complete_attachment_download_account_retirement(account_id)
                .await;
            self.complete_attachment_upload_account_retirement(account_id)
                .await;
            self.complete_vault_image_account_retirement(account_id)
                .await;
            return Ok(AccountAccessState::SignedOut);
        };
        let access = retirement.resulting_access();
        let (invalidated_delivery, desired_epoch, overflowed) =
            self.fence_account_access(&snapshot, access)?;
        finish_generation_fence(invalidated_delivery);
        // Live keys are gone and every in-flight plaintext lease is revoked before the request
        // answers. Everything below is durable bookkeeping.
        self.publish_all();

        if retirement == AccessRetirement::RefusedSession {
            self.mark_reauthentication_required(account_id);
            self.platform_storage
                .remove_current_session(account_id, &snapshot.incarnation)
                .await?;
        }

        if retirement == AccessRetirement::SignOut {
            if !snapshot.share_capabilities.is_empty() {
                snapshot = match self
                    .replica
                    .execute_recomputing(GuardedCommitPlan::new(
                        account_id.clone(),
                        snapshot.incarnation.clone(),
                        snapshot.revision,
                        snapshot.lock_epoch,
                        vec![PlanMutation::RemoveAllProtectedShareCapabilities],
                    ))
                    .await?
                {
                    RecomputedPlanResult::Applied { snapshot } => {
                        self.replica.cache(snapshot.clone());
                        snapshot
                    }
                    RecomputedPlanResult::Fenced { snapshot } => {
                        self.replica.cache(snapshot);
                        return Err(RuntimeError::new(
                            RuntimeErrorCode::AuthenticationRequired,
                            "Account was fenced while destroying Share capabilities",
                        ));
                    }
                    RecomputedPlanResult::Missing => {
                        self.forget_uninstalled_account_access(account_id);
                        self.complete_attachment_download_account_retirement(account_id)
                            .await;
                        self.complete_attachment_upload_account_retirement(account_id)
                            .await;
                        self.complete_vault_image_account_retirement(account_id)
                            .await;
                        return Ok(AccountAccessState::SignedOut);
                    }
                };
            }
            self.forget_sign_in_material(account_id, &snapshot.incarnation)
                .await?;
        }
        if overflowed {
            return Err(RuntimeError::new(
                RuntimeErrorCode::InvariantViolation,
                "Account lock epoch overflowed",
            ));
        }
        let durable = self
            .replica
            .advance_lock_epoch(
                account_id,
                &snapshot.user_id,
                &snapshot.incarnation,
                desired_epoch,
            )
            .await?;
        let _publication = self.publication.lock().expect("publication lock poisoned");
        self.replica.cache(durable);
        self.account_lock_epochs
            .lock()
            .expect("Account lock epoch lock poisoned")
            .insert(account_id.clone(), desired_epoch);
        self.lock_epoch_pending
            .lock()
            .expect("pending lock epoch lock poisoned")
            .remove(account_id);
        drop(_publication);
        self.complete_attachment_download_account_retirement(account_id)
            .await;
        self.complete_attachment_upload_account_retirement(account_id)
            .await;
        self.complete_vault_image_account_retirement(account_id)
            .await;
        pending_retirement
            .expect("admitted retirement has an access intent")
            .finish();
        drop(foreground_retirement);
        Ok(access)
    }

    pub(super) fn account_access_retirement_is_pending(&self, account_id: &AccountId) -> bool {
        *self
            .account_access_retirement_intent(account_id)
            .lock()
            .expect("pending Account access retirement lock poisoned")
            > 0
    }

    pub(super) fn account_access_retirement_intent(
        &self,
        account_id: &AccountId,
    ) -> Arc<Mutex<usize>> {
        self.account_access_retirement_intents
            .lock()
            .expect("Account access retirement intent map poisoned")
            .entry(account_id.clone())
            .or_insert_with(|| Arc::new(Mutex::new(0)))
            .clone()
    }

    /// Deletes what a later password-only unlock would need. Account metadata and the durable
    /// Replica stay: this Device still knows the Account and still owes its accepted Operations.
    /// Removing the Account from the Device is a separate lifecycle action.
    async fn forget_sign_in_material(
        &self,
        account_id: &AccountId,
        incarnation: &crate::protocol::Incarnation,
    ) -> Result<(), RuntimeError> {
        self.platform_storage
            .remove_quick_unlock(account_id, incarnation)
            .await?;
        self.platform_storage
            .remove_current_session(account_id, incarnation)
            .await?;
        self.platform_storage
            .remove_legacy_session_evidence(account_id, incarnation)
            .await
    }

    fn forget_uninstalled_account_access(&self, account_id: &AccountId) {
        let _publication = self.publication.lock().expect("publication lock poisoned");
        let had_state = self
            .account_access
            .lock()
            .expect("Account access lock poisoned")
            .remove(account_id)
            .is_some();
        let had_items = self
            .unlocked_items
            .lock()
            .expect("unlocked projection lock poisoned")
            .remove(account_id)
            .is_some();
        self.clear_live_master_unlock_keys_for_account(account_id);
        if had_state || had_items {
            self.device_revision.fetch_add(1, Ordering::SeqCst);
            drop(_publication);
            self.publish_all();
        }
    }
}
