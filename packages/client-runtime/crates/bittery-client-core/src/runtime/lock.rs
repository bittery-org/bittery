use super::*;

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
}

impl AccessRetirement {
    fn resulting_access(self) -> AccountAccessState {
        match self {
            Self::Lock => AccountAccessState::Locked,
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
        self.account_lock_epochs
            .lock()
            .expect("Account lock epoch lock poisoned")
            .entry(account_id.clone())
            .or_insert(0);
        // A real unlock ends with the Account's live master unlock key in memory. Tests that write
        // locally need the same key the seeded Vault fixture wrapped its Vault key under.
        self.seed_live_master_unlock_key(account_id, &snapshot.incarnation);
        Ok(())
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
        let execution_lock = self.account_execution_lock(account_id)?;
        let execution_guard = execution_lock.lock().await;
        self.ensure_open()?;
        let Some(snapshot) = self.replica.snapshot(account_id) else {
            drop(execution_guard);
            self.forget_uninstalled_account_access(account_id);
            return Ok(AccountAccessState::SignedOut);
        };
        let access = retirement.resulting_access();
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
        let _publication = self.publication.lock().expect("publication lock poisoned");
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
        drop(_publication);
        drop(execution_guard);
        if let Some(token) = invalidated_delivery {
            token.wait_for_other_threads();
        }
        // Live keys are gone and every in-flight plaintext lease is revoked before the request
        // answers. Everything below is durable bookkeeping.
        self.publish_all();

        let _execution_guard = execution_lock.lock().await;
        if retirement == AccessRetirement::SignOut {
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
        Ok(access)
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
