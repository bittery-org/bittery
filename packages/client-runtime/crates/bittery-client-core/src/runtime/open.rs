use super::*;

impl Runtime {
    pub async fn open(&self) -> Result<(), RuntimeError> {
        let _catalog_guard = self.catalog_transition.lock().await;
        self.ensure_not_closed()?;
        if self.ready.load(Ordering::SeqCst) {
            return Ok(());
        }

        let Some(catalog) = self.platform_storage.load_device_catalog().await? else {
            let _publication = self.publication.lock().expect("publication lock poisoned");
            self.ensure_not_closed()?;
            self.publish_restored_accounts(&[]);
            self.ready.store(true, Ordering::SeqCst);
            return Ok(());
        };

        let mut reconciled_accounts = Vec::with_capacity(catalog.accounts.len());
        let mut restored: Vec<(crate::replica::ReplicaSnapshot, AccountAccessState)> =
            Vec::with_capacity(catalog.accounts.len());
        let mut orphaned_generations = Vec::new();
        let mut corrected = false;

        for account in &catalog.accounts {
            self.ensure_not_closed()?;
            let snapshot = self.replica.load_uncached(&account.account_id).await?;
            let (active, orphaned) = reconcile_catalog_account(account, snapshot.as_ref())?;
            corrected |= active != account.active_incarnation || account.pending_install.is_some();
            if let Some(orphaned) = orphaned {
                orphaned_generations.push((account.account_id.clone(), orphaned));
            }
            let Some(active) = active else {
                continue;
            };
            let snapshot = snapshot
                .ok_or_else(|| startup_invariant("active Account has no durable Replica"))?;
            let metadata = self
                .platform_storage
                .load_account_metadata(&account.account_id, &active)
                .await?
                .ok_or_else(|| startup_invariant("active Account has no generation metadata"))?;
            if snapshot.account_id != account.account_id
                || snapshot.incarnation != active
                || snapshot.user_id != metadata.user_id
            {
                return Err(startup_invariant(
                    "active Account Replica and generation metadata disagree",
                ));
            }
            let access = self
                .restored_access_state(&account.account_id, &active)
                .await?;
            reconciled_accounts.push(DeviceCatalogAccount {
                account_id: account.account_id.clone(),
                active_incarnation: Some(active),
                pending_install: None,
            });
            restored.push((snapshot, access));
        }

        if corrected {
            self.ensure_not_closed()?;
            let reconciled = DeviceCatalogDocument::new(reconciled_accounts)?;
            self.platform_storage
                .store_device_catalog(&reconciled)
                .await?;
            for (account_id, incarnation) in orphaned_generations {
                let _ = self
                    .platform_storage
                    .remove_account_metadata(&account_id, &incarnation)
                    .await;
                let _ = self
                    .platform_storage
                    .remove_quick_unlock(&account_id, &incarnation)
                    .await;
                let _ = self
                    .platform_storage
                    .remove_current_session(&account_id, &incarnation)
                    .await;
            }
        }

        let _publication = self.publication.lock().expect("publication lock poisoned");
        self.ensure_not_closed()?;
        self.publish_restored_accounts(&restored);
        self.ready.store(true, Ordering::SeqCst);
        Ok(())
    }

    /// How far a restart may carry one installed Account.
    ///
    /// A Device that still holds the Account's Quick Unlock document and the Device key that
    /// wraps it can reopen the Account with the master password alone, which is exactly what
    /// `Locked` means, and exactly what `AccessRetirement::Lock` leaves behind. Without that
    /// material the Account needs email, master password, and Secret Key again, which is
    /// `SignedOut`. Restoring everything as `SignedOut` collapsed the two and left the host
    /// unable to tell a lock screen from a full Sign-in.
    ///
    /// Missing or unusable material is an answer, not a startup failure: it means this Device
    /// has to sign in again. Only a host or executor failure propagates.
    async fn restored_access_state(
        &self,
        account_id: &AccountId,
        incarnation: &crate::protocol::Incarnation,
    ) -> Result<AccountAccessState, RuntimeError> {
        if !self.holds_material(
            self.platform_storage
                .load_quick_unlock_for_authentication(account_id, incarnation)
                .await,
        )? {
            return Ok(AccountAccessState::SignedOut);
        }
        if !self.holds_material(
            self.platform_storage
                .load_device_key_for_authentication()
                .await,
        )? {
            return Ok(AccountAccessState::SignedOut);
        }
        Ok(AccountAccessState::Locked)
    }

    /// Reads a presence answer out of an authentication load. The loader already classifies
    /// unusable persisted material as `AuthenticationRequired`, so that code means "absent"
    /// here and every other code stays a real failure. The document itself is dropped at once;
    /// it is zeroized on drop and startup has no use for its secrets.
    fn holds_material<T>(
        &self,
        loaded: Result<Option<T>, RuntimeError>,
    ) -> Result<bool, RuntimeError> {
        match loaded {
            Ok(document) => Ok(document.is_some()),
            Err(error) if error.code == RuntimeErrorCode::AuthenticationRequired => Ok(false),
            Err(error) => Err(error),
        }
    }

    fn publish_restored_accounts(
        &self,
        restored: &[(crate::replica::ReplicaSnapshot, AccountAccessState)],
    ) {
        self.recovery_accounts
            .lock()
            .expect("recovery Account lock poisoned")
            .clear();
        self.live_master_unlock_keys
            .lock()
            .expect("live master unlock key lock poisoned")
            .clear();
        let snapshots: Vec<_> = restored
            .iter()
            .map(|(snapshot, _)| snapshot.clone())
            .collect();
        self.replica.replace_cache(&snapshots);
        *self
            .account_access
            .lock()
            .expect("Account access lock poisoned") = restored
            .iter()
            .map(|(snapshot, access)| (snapshot.account_id.clone(), *access))
            .collect();
        self.unlocked_items
            .lock()
            .expect("unlocked projection lock poisoned")
            .clear();
        *self
            .account_lock_epochs
            .lock()
            .expect("Account lock epoch lock poisoned") = restored
            .iter()
            .map(|(snapshot, _)| (snapshot.account_id.clone(), snapshot.lock_epoch))
            .collect();
        self.lock_epoch_pending
            .lock()
            .expect("pending lock epoch lock poisoned")
            .clear();
        self.device_revision.fetch_add(1, Ordering::SeqCst);
    }

    pub async fn restore_known_accounts(
        &self,
        account_ids: Vec<AccountId>,
    ) -> Result<(), RuntimeError> {
        let _catalog_guard = self.catalog_transition.lock().await;
        self.ensure_open()?;
        let mut unique = HashSet::with_capacity(account_ids.len());
        for account_id in &account_ids {
            if !unique.insert(account_id.clone()) {
                return Err(RuntimeError::new(
                    RuntimeErrorCode::InvariantViolation,
                    "known Account identity is duplicated",
                ));
            }
        }
        let mut lock_ids: HashSet<_> = self
            .replica
            .snapshots()
            .into_iter()
            .map(|snapshot| snapshot.account_id)
            .collect();
        lock_ids.extend(account_ids.iter().cloned());
        let mut lock_ids: Vec<_> = lock_ids.into_iter().collect();
        lock_ids.sort_by(|a, b| a.as_str().cmp(b.as_str()));
        let execution_locks: Vec<_> = lock_ids
            .iter()
            .map(|account_id| self.account_execution_lock(account_id))
            .collect::<Result<_, _>>()?;
        let mut execution_guards = Vec::with_capacity(execution_locks.len());
        for lock in &execution_locks {
            execution_guards.push(lock.lock().await);
        }
        self.ensure_open()?;
        let restored = self.replica.restore_known_accounts(&account_ids).await?;
        let _publication = self.publication.lock().expect("publication lock poisoned");
        let invalidated_deliveries: Vec<_> = lock_ids
            .iter()
            .filter_map(|account_id| self.invalidate_delivery(account_id))
            .collect();
        self.replica.replace_cache(&restored);
        self.recovery_accounts
            .lock()
            .expect("recovery Account lock poisoned")
            .clear();
        {
            let mut access = self
                .account_access
                .lock()
                .expect("Account access lock poisoned");
            *access = restored
                .iter()
                .map(|snapshot| (snapshot.account_id.clone(), AccountAccessState::SignedOut))
                .collect();
        }
        self.unlocked_items
            .lock()
            .expect("unlocked projection lock poisoned")
            .clear();
        self.live_master_unlock_keys
            .lock()
            .expect("live master unlock key lock poisoned")
            .clear();
        *self
            .account_lock_epochs
            .lock()
            .expect("Account lock epoch lock poisoned") = restored
            .iter()
            .map(|snapshot| (snapshot.account_id.clone(), snapshot.lock_epoch))
            .collect();
        self.lock_epoch_pending
            .lock()
            .expect("pending lock epoch lock poisoned")
            .clear();
        self.device_revision.fetch_add(1, Ordering::SeqCst);
        drop(_publication);
        drop(execution_guards);
        drop(_catalog_guard);
        for token in invalidated_deliveries {
            token.wait_for_other_threads();
        }
        self.publish_all();
        Ok(())
    }
}
