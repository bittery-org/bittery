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
        let mut restored = Vec::with_capacity(catalog.accounts.len());
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
            reconciled_accounts.push(DeviceCatalogAccount {
                account_id: account.account_id.clone(),
                active_incarnation: Some(active),
                pending_install: None,
            });
            restored.push(snapshot);
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

    fn publish_restored_accounts(&self, restored: &[crate::replica::ReplicaSnapshot]) {
        self.recovery_accounts
            .lock()
            .expect("recovery Account lock poisoned")
            .clear();
        self.live_master_unlock_keys
            .lock()
            .expect("live master unlock key lock poisoned")
            .clear();
        self.replica.replace_cache(restored);
        *self
            .account_access
            .lock()
            .expect("Account access lock poisoned") = restored
            .iter()
            .map(|snapshot| (snapshot.account_id.clone(), AccountAccessState::SignedOut))
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
            .map(|snapshot| (snapshot.account_id.clone(), snapshot.lock_epoch))
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
