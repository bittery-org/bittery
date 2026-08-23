use super::*;

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
        Ok(())
    }

    #[doc(hidden)]
    pub async fn mark_account_locked(&self, account_id: &AccountId) -> Result<(), RuntimeError> {
        let execution_lock = self.account_execution_lock(account_id)?;
        let execution_guard = execution_lock.lock().await;
        self.ensure_open()?;
        let snapshot = self.replica.snapshot(account_id).ok_or_else(|| {
            RuntimeError::new(RuntimeErrorCode::AccountMissing, "account is not installed")
        })?;
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
            .insert(account_id.clone(), AccountAccessState::Locked);
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
        self.publish_all();
        if overflowed {
            return Err(RuntimeError::new(
                RuntimeErrorCode::InvariantViolation,
                "Account lock epoch overflowed",
            ));
        }
        let _execution_guard = execution_lock.lock().await;
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
        Ok(())
    }
}
