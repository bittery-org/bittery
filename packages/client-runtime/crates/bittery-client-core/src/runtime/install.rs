use super::*;

impl Runtime {
    #[cfg(test)]
    pub(crate) fn install_account(
        &self,
        account_id: AccountId,
        user_id: String,
        incarnation: crate::protocol::Incarnation,
    ) -> Result<(), RuntimeError> {
        self.ensure_open()?;
        let _publication = self.publication.lock().expect("publication lock poisoned");
        self.test_persistence
            .as_ref()
            .expect("test Account installation requires in-memory persistence")
            .install(account_id.clone(), user_id, incarnation.clone())?;
        // A real Sign-in installs an Account already unlocked, with its master unlock key live.
        self.seed_live_master_unlock_key(&account_id, &incarnation);
        self.replica.cache(
            self.test_persistence
                .as_ref()
                .expect("test Account installation requires in-memory persistence")
                .snapshot(&account_id)
                .expect("installed Account must have a snapshot"),
        );
        self.recovery_accounts
            .lock()
            .expect("recovery Account lock poisoned")
            .remove(&account_id);
        self.unlocked_items
            .lock()
            .expect("unlocked projection lock poisoned")
            .entry(account_id.clone())
            .or_default();
        self.account_access
            .lock()
            .expect("Account access lock poisoned")
            .insert(account_id.clone(), AccountAccessState::Unlocked);
        self.account_lock_epochs
            .lock()
            .expect("Account lock epoch lock poisoned")
            .entry(account_id.clone())
            .or_insert(0);
        self.device_revision.fetch_add(1, Ordering::SeqCst);
        drop(_publication);
        self.publish_all();
        Ok(())
    }

    #[doc(hidden)]
    pub async fn install_or_replace_account(
        &self,
        account_id: AccountId,
        user_id: String,
        incarnation: crate::protocol::Incarnation,
    ) -> Result<(), RuntimeError> {
        let _catalog_guard = self.catalog_transition.lock().await;
        let execution_lock = self.account_execution_lock(&account_id)?;
        let _execution_guard = execution_lock.lock().await;
        self.ensure_open()?;
        let snapshot = self
            .replica
            .install_or_replace(account_id.clone(), user_id, incarnation)
            .await?;
        let next_lock_epoch = snapshot.lock_epoch;
        let _publication = self.publication.lock().expect("publication lock poisoned");
        let invalidated_delivery = self.invalidate_delivery(&account_id);
        self.replica.cache(snapshot);
        self.recovery_accounts
            .lock()
            .expect("recovery Account lock poisoned")
            .remove(&account_id);
        self.unlocked_items
            .lock()
            .expect("unlocked projection lock poisoned")
            .remove(&account_id);
        self.clear_live_master_unlock_keys_for_account(&account_id);
        self.account_access
            .lock()
            .expect("Account access lock poisoned")
            .insert(account_id.clone(), AccountAccessState::SignedOut);
        self.account_lock_epochs
            .lock()
            .expect("Account lock epoch lock poisoned")
            .insert(account_id.clone(), next_lock_epoch);
        self.lock_epoch_pending
            .lock()
            .expect("pending lock epoch lock poisoned")
            .remove(&account_id);
        self.device_revision.fetch_add(1, Ordering::SeqCst);
        drop(_publication);
        drop(_execution_guard);
        drop(_catalog_guard);
        if let Some(token) = invalidated_delivery {
            token.wait_for_other_threads();
        }
        self.publish_all();
        Ok(())
    }

    /// Installs one fully authenticated Account generation without exposing authentication policy
    /// to bindings.
    pub(crate) async fn install_verified_authentication(
        &self,
        verified: VerifiedAuthentication,
        evidence: AuthenticationInstallationEvidence,
    ) -> Result<RuntimeResponse, RuntimeError> {
        self.install_verified_authentication_with(
            verified,
            evidence,
            &SystemClock,
            &SystemInstallationEntropy,
        )
        .await
    }

    pub(crate) async fn install_verified_authentication_with(
        &self,
        verified: VerifiedAuthentication,
        evidence: AuthenticationInstallationEvidence,
        clock: &dyn Clock,
        entropy: &dyn InstallationEntropy,
    ) -> Result<RuntimeResponse, RuntimeError> {
        let catalog_guard = self.catalog_transition.lock().await;
        self.ensure_open()?;
        let original_catalog = self.platform_storage.load_device_catalog().await?;
        let catalog = original_catalog
            .clone()
            .unwrap_or(DeviceCatalogDocument::new(Vec::new())?);
        if catalog
            .accounts
            .iter()
            .any(|account| account.pending_install.is_some())
        {
            return Err(startup_invariant(
                "Device catalog must reconcile pending installation before Sign-in",
            ));
        }

        let mut matching_accounts = Vec::new();
        let mut active_metadata = HashMap::new();
        for account in &catalog.accounts {
            let active = account.active_incarnation.as_ref().ok_or_else(|| {
                startup_invariant("active catalog Account has no active incarnation")
            })?;
            let metadata = self
                .platform_storage
                .load_account_metadata(&account.account_id, active)
                .await?
                .ok_or_else(|| {
                    startup_invariant("active catalog Account has no generation metadata")
                })?;
            if metadata.normalized_server_url == verified.normalized_server_url
                && metadata.user_id == verified.user.id
            {
                matching_accounts.push(account.account_id.clone());
            }
            active_metadata.insert(account.account_id.clone(), metadata);
        }
        if matching_accounts.len() > 1 {
            return Err(startup_invariant(
                "Device catalog contains duplicate Server Account identity",
            ));
        }

        let matched_account_id = matching_accounts.pop();
        let is_replacement = matched_account_id.is_some();
        let account_id =
            matched_account_id.unwrap_or_else(|| AccountId::from(entropy.generate_uuid()));
        if account_id.as_str().is_empty()
            || (!is_replacement
                && catalog
                    .accounts
                    .iter()
                    .any(|account| account.account_id == account_id))
        {
            return Err(startup_invariant(
                "generated Account identity collides with the Device catalog",
            ));
        }
        // This is the first point at which the Account identity is known, and it is still before any
        // installation write. A pending teardown of exactly this Account must fence it here.
        if self.account_teardown_is_pending(&account_id) {
            return Err(RuntimeError::new(
                RuntimeErrorCode::AccountMissing,
                "Account teardown is pending",
            ));
        }
        let previous_metadata = active_metadata.get(&account_id);
        let existing_catalog_account = catalog
            .accounts
            .iter()
            .find(|account| account.account_id == account_id);
        let expected_active_incarnation =
            existing_catalog_account.and_then(|account| account.active_incarnation.clone());
        let incarnation = crate::protocol::Incarnation::from(entropy.generate_uuid());
        if incarnation.as_str().is_empty()
            || catalog.accounts.iter().any(|account| {
                account.active_incarnation.as_ref() == Some(&incarnation)
                    || account
                        .pending_install
                        .as_ref()
                        .is_some_and(|pending| pending.incarnation == incarnation)
            })
        {
            return Err(startup_invariant(
                "generated Account incarnation collides with the Device catalog",
            ));
        }

        let execution_lock = self.account_execution_lock(&account_id)?;
        let execution_guard = execution_lock.lock().await;
        self.ensure_open()?;
        let previous_snapshot = self.replica.snapshot(&account_id);
        match (&expected_active_incarnation, &previous_snapshot) {
            (Some(expected), Some(snapshot))
                if snapshot.incarnation == *expected && snapshot.user_id == verified.user.id => {}
            (None, None) => {}
            _ => {
                return Err(startup_invariant(
                    "Device catalog and Runtime Replica disagree before Account installation",
                ));
            }
        }

        let device_key = match self.platform_storage.load_device_key().await? {
            Some(document) => document,
            None => {
                let document = DeviceKeyDocument::new(entropy.generate_device_key());
                self.ensure_not_closed()?;
                self.platform_storage.store_device_key(&document).await?;
                document
            }
        };
        let prepared = prepare_authenticated_installation(
            verified,
            evidence,
            account_id.clone(),
            incarnation.clone(),
            previous_metadata,
            &device_key.key_bytes,
            clock,
        )?;

        let staged_catalog = stage_catalog_install(
            &catalog,
            account_id.clone(),
            incarnation.clone(),
            expected_active_incarnation.clone(),
        )?;
        self.ensure_not_closed()?;
        if let Err(error) = self
            .platform_storage
            .store_device_catalog(&staged_catalog)
            .await
        {
            self.rollback_pre_replica_install(original_catalog.as_ref(), &account_id, &incarnation)
                .await;
            return Err(error);
        }
        if let Err(error) = self.ensure_not_closed() {
            self.rollback_pre_replica_install(original_catalog.as_ref(), &account_id, &incarnation)
                .await;
            return Err(error);
        }
        if let Err(error) = self
            .platform_storage
            .store_account_metadata(&prepared.metadata)
            .await
        {
            self.rollback_pre_replica_install(original_catalog.as_ref(), &account_id, &incarnation)
                .await;
            return Err(error);
        }
        if let Err(error) = self.ensure_not_closed() {
            self.rollback_pre_replica_install(original_catalog.as_ref(), &account_id, &incarnation)
                .await;
            return Err(error);
        }
        if let Err(error) = self
            .platform_storage
            .store_quick_unlock(&prepared.quick_unlock)
            .await
        {
            self.rollback_pre_replica_install(original_catalog.as_ref(), &account_id, &incarnation)
                .await;
            return Err(error);
        }
        if let Err(error) = self.ensure_not_closed() {
            self.rollback_pre_replica_install(original_catalog.as_ref(), &account_id, &incarnation)
                .await;
            return Err(error);
        }

        let installed_snapshot = match self
            .replica
            .install_or_replace(
                account_id.clone(),
                prepared.metadata.user_id.clone(),
                incarnation.clone(),
            )
            .await
        {
            Ok(snapshot) => snapshot,
            Err(error) => match self.replica.load_uncached(&account_id).await {
                Ok(durable)
                    if durable_installation_is_unchanged(
                        durable.as_ref(),
                        previous_snapshot.as_ref(),
                    ) =>
                {
                    self.rollback_pre_replica_install(
                        original_catalog.as_ref(),
                        &account_id,
                        &incarnation,
                    )
                    .await;
                    return Err(error);
                }
                Ok(Some(snapshot))
                    if snapshot.incarnation == incarnation
                        && snapshot.user_id == prepared.metadata.user_id =>
                {
                    let invalidated =
                        self.fence_authenticated_installation(Some(snapshot), &account_id);
                    drop(execution_guard);
                    drop(catalog_guard);
                    finish_generation_fence(invalidated);
                    self.publish_all_unless_closed();
                    return Err(error);
                }
                Ok(Some(third_head)) => {
                    let invalidated =
                        self.fence_authenticated_installation(Some(third_head), &account_id);
                    drop(execution_guard);
                    drop(catalog_guard);
                    finish_generation_fence(invalidated);
                    self.publish_all_unless_closed();
                    return Err(startup_invariant(
                        "Replica changed to an unexpected generation during installation",
                    ));
                }
                Ok(None) | Err(_) => {
                    let invalidated = self.fence_authenticated_installation(None, &account_id);
                    drop(execution_guard);
                    drop(catalog_guard);
                    finish_generation_fence(invalidated);
                    self.publish_all_unless_closed();
                    return Err(startup_invariant(
                        "Replica installation outcome could not be established",
                    ));
                }
            },
        };

        if let Err(error) = self.ensure_not_closed() {
            let invalidated =
                self.fence_authenticated_installation(Some(installed_snapshot), &account_id);
            drop(execution_guard);
            drop(catalog_guard);
            finish_generation_fence(invalidated);
            self.publish_all_unless_closed();
            return Err(error);
        }

        let promoted_catalog =
            match promote_catalog_install(&staged_catalog, &account_id, &incarnation) {
                Ok(catalog) => catalog,
                Err(error) => {
                    let invalidated = self
                        .fence_authenticated_installation(Some(installed_snapshot), &account_id);
                    drop(execution_guard);
                    drop(catalog_guard);
                    finish_generation_fence(invalidated);
                    self.publish_all_unless_closed();
                    return Err(error);
                }
            };
        if let Err(error) = self
            .platform_storage
            .store_device_catalog(&promoted_catalog)
            .await
        {
            let invalidated =
                self.fence_authenticated_installation(Some(installed_snapshot), &account_id);
            drop(execution_guard);
            drop(catalog_guard);
            finish_generation_fence(invalidated);
            self.publish_all_unless_closed();
            return Err(error);
        }
        if let Err(error) = self.ensure_not_closed() {
            let invalidated =
                self.fence_authenticated_installation(Some(installed_snapshot), &account_id);
            drop(execution_guard);
            drop(catalog_guard);
            finish_generation_fence(invalidated);
            self.publish_all_unless_closed();
            return Err(error);
        }
        if let Err(error) = self
            .platform_storage
            .store_current_session(&prepared.current_session)
            .await
        {
            let invalidated =
                self.fence_authenticated_installation(Some(installed_snapshot), &account_id);
            drop(execution_guard);
            drop(catalog_guard);
            finish_generation_fence(invalidated);
            self.publish_all_unless_closed();
            return Err(error);
        }

        let publication = self.publish_authenticated_installation(
            installed_snapshot.clone(),
            account_id.clone(),
            incarnation.clone(),
            prepared.master_unlock_key,
        );
        let invalidated = match publication {
            Ok(invalidated) if !self.is_closed() => invalidated,
            Ok(first_invalidated) => {
                let invalidated =
                    self.fence_authenticated_installation(Some(installed_snapshot), &account_id);
                drop(execution_guard);
                drop(catalog_guard);
                finish_generation_fence(first_invalidated);
                finish_generation_fence(invalidated);
                self.publish_all_unless_closed();
                return Err(RuntimeError::new(
                    RuntimeErrorCode::RuntimeClosed,
                    "Runtime was closed during Account installation",
                ));
            }
            Err(error) => {
                let invalidated =
                    self.fence_authenticated_installation(Some(installed_snapshot), &account_id);
                drop(execution_guard);
                drop(catalog_guard);
                finish_generation_fence(invalidated);
                self.publish_all_unless_closed();
                return Err(error);
            }
        };
        drop(execution_guard);
        drop(catalog_guard);
        finish_generation_fence(invalidated);
        self.publish_all_unless_closed();
        // A Session is installed again, so anything parked on one may resume.
        self.note_session_available(&account_id);
        let _ = self
            .bootstrap_account(&account_id, RequestCancellation::new())
            .await;

        if let Some(old_incarnation) = expected_active_incarnation {
            let _ = self
                .platform_storage
                .remove_account_metadata(&account_id, &old_incarnation)
                .await;
            let _ = self
                .platform_storage
                .remove_quick_unlock(&account_id, &old_incarnation)
                .await;
            let _ = self
                .platform_storage
                .remove_current_session(&account_id, &old_incarnation)
                .await;
        }

        Ok(RuntimeResponse::SignedIn {
            account_id,
            user_id: prepared.metadata.user_id,
        })
    }

    async fn rollback_pre_replica_install(
        &self,
        original_catalog: Option<&DeviceCatalogDocument>,
        account_id: &AccountId,
        incarnation: &crate::protocol::Incarnation,
    ) {
        match original_catalog {
            Some(catalog) => {
                let _ = self.platform_storage.store_device_catalog(catalog).await;
            }
            None => {
                let _ = self.platform_storage.remove_device_catalog().await;
            }
        }
        let _ = self
            .platform_storage
            .remove_account_metadata(account_id, incarnation)
            .await;
        let _ = self
            .platform_storage
            .remove_quick_unlock(account_id, incarnation)
            .await;
        let _ = self
            .platform_storage
            .remove_current_session(account_id, incarnation)
            .await;
    }

    fn fence_authenticated_installation(
        &self,
        snapshot: Option<crate::replica::ReplicaSnapshot>,
        account_id: &AccountId,
    ) -> Option<Arc<DeliveryToken>> {
        let _publication = self.publication.lock().expect("publication lock poisoned");
        let invalidated = self.invalidate_delivery(account_id);
        let previous_revision = self
            .replica
            .snapshot(account_id)
            .map_or(0, |snapshot| snapshot.revision);
        let lock_epoch = snapshot.as_ref().map(|snapshot| snapshot.lock_epoch);
        if let Some(snapshot) = snapshot {
            self.replica.cache(snapshot);
            self.recovery_accounts
                .lock()
                .expect("recovery Account lock poisoned")
                .remove(account_id);
        } else {
            self.replica.remove_cached(account_id);
            self.recovery_accounts
                .lock()
                .expect("recovery Account lock poisoned")
                .insert(
                    account_id.clone(),
                    RecoveryAccountStatus {
                        replica_revision: previous_revision,
                    },
                );
        }
        self.unlocked_items
            .lock()
            .expect("unlocked projection lock poisoned")
            .remove(account_id);
        self.clear_live_master_unlock_keys_for_account(account_id);
        let mut account_access = self
            .account_access
            .lock()
            .expect("Account access lock poisoned");
        let mut lock_epochs = self
            .account_lock_epochs
            .lock()
            .expect("Account lock epoch lock poisoned");
        if let Some(lock_epoch) = lock_epoch {
            account_access.insert(account_id.clone(), AccountAccessState::SignedOut);
            lock_epochs.insert(account_id.clone(), lock_epoch);
        } else {
            account_access.remove(account_id);
            lock_epochs.remove(account_id);
        }
        self.lock_epoch_pending
            .lock()
            .expect("pending lock epoch lock poisoned")
            .remove(account_id);
        self.device_revision.fetch_add(1, Ordering::SeqCst);
        invalidated
    }

    fn publish_authenticated_installation(
        &self,
        snapshot: crate::replica::ReplicaSnapshot,
        account_id: AccountId,
        incarnation: crate::protocol::Incarnation,
        master_unlock_key: Zeroizing<[u8; 32]>,
    ) -> Result<Option<Arc<DeliveryToken>>, RuntimeError> {
        let _publication = self.publication.lock().expect("publication lock poisoned");
        if self.is_closed() {
            return Err(RuntimeError::new(
                RuntimeErrorCode::RuntimeClosed,
                "Runtime was closed during Account installation",
            ));
        }
        let invalidated = self.invalidate_delivery(&account_id);
        self.replica.cache(snapshot);
        self.recovery_accounts
            .lock()
            .expect("recovery Account lock poisoned")
            .remove(&account_id);
        self.unlocked_items
            .lock()
            .expect("unlocked projection lock poisoned")
            .insert(account_id.clone(), Vec::new());
        self.clear_live_master_unlock_keys_for_account(&account_id);
        self.live_master_unlock_keys
            .lock()
            .expect("live master unlock key lock poisoned")
            .insert(
                (account_id.clone(), incarnation),
                LiveMasterUnlockKey::new(master_unlock_key),
            );
        self.account_access
            .lock()
            .expect("Account access lock poisoned")
            .insert(account_id.clone(), AccountAccessState::Unlocked);
        self.account_lock_epochs
            .lock()
            .expect("Account lock epoch lock poisoned")
            .insert(account_id.clone(), 0);
        self.lock_epoch_pending
            .lock()
            .expect("pending lock epoch lock poisoned")
            .remove(&account_id);
        self.device_revision.fetch_add(1, Ordering::SeqCst);
        Ok(invalidated)
    }

    pub(crate) async fn commit_quick_unlock(
        &self,
        snapshot: crate::replica::ReplicaSnapshot,
        prepared: PreparedQuickUnlock,
        execution_guard: tokio::sync::MutexGuard<'_, ()>,
    ) -> Result<RuntimeResponse, RuntimeError> {
        let account_id = snapshot.account_id.clone();
        let user_id = snapshot.user_id.clone();

        if let Err(error) = self
            .platform_storage
            .store_account_metadata(&prepared.metadata)
            .await
        {
            return self
                .finish_failed_quick_unlock(&snapshot, execution_guard, error)
                .await;
        }
        if let Err(error) = self
            .platform_storage
            .store_quick_unlock(&prepared.quick_unlock)
            .await
        {
            return self
                .finish_failed_quick_unlock(&snapshot, execution_guard, error)
                .await;
        }
        if let Err(error) = self
            .platform_storage
            .store_current_session(&prepared.current_session)
            .await
        {
            return self
                .finish_failed_quick_unlock(&snapshot, execution_guard, error)
                .await;
        }

        let publication = self.publish_quick_unlock(&snapshot, prepared.master_unlock_key);
        let invalidated = match publication {
            Ok(invalidated) if !self.is_closed() => invalidated,
            Ok(first_invalidated) => {
                let invalidated = self.fence_quick_unlock(&snapshot);
                drop(execution_guard);
                finish_generation_fence(first_invalidated);
                finish_generation_fence(invalidated);
                self.publish_all_unless_closed();
                return Err(RuntimeError::new(
                    RuntimeErrorCode::RuntimeClosed,
                    "Runtime was closed during Quick Unlock",
                ));
            }
            Err(error) => {
                let invalidated = self.fence_quick_unlock(&snapshot);
                drop(execution_guard);
                finish_generation_fence(invalidated);
                self.publish_all_unless_closed();
                return Err(error);
            }
        };
        drop(execution_guard);
        finish_generation_fence(invalidated);
        self.publish_all_unless_closed();
        // A Session is installed again, so anything parked on one may resume.
        self.note_session_available(&account_id);
        let _ = self
            .bootstrap_account(&account_id, RequestCancellation::new())
            .await;
        Ok(RuntimeResponse::SignedIn {
            account_id,
            user_id,
        })
    }

    async fn finish_failed_quick_unlock(
        &self,
        snapshot: &crate::replica::ReplicaSnapshot,
        execution_guard: tokio::sync::MutexGuard<'_, ()>,
        error: RuntimeError,
    ) -> Result<RuntimeResponse, RuntimeError> {
        let invalidated = self.fence_quick_unlock(snapshot);
        drop(execution_guard);
        finish_generation_fence(invalidated);
        self.publish_all_unless_closed();
        Err(error)
    }

    fn publish_quick_unlock(
        &self,
        expected: &crate::replica::ReplicaSnapshot,
        master_unlock_key: Zeroizing<[u8; 32]>,
    ) -> Result<Option<Arc<DeliveryToken>>, RuntimeError> {
        let _publication = self.publication.lock().expect("publication lock poisoned");
        if self.is_closed() {
            return Err(RuntimeError::new(
                RuntimeErrorCode::RuntimeClosed,
                "Runtime was closed during Quick Unlock",
            ));
        }
        let current = self.replica.snapshot(&expected.account_id).ok_or_else(|| {
            RuntimeError::new(RuntimeErrorCode::AccountMissing, "account is not installed")
        })?;
        if current.incarnation != expected.incarnation
            || current.user_id != expected.user_id
            || current.revision != expected.revision
            || current.lock_epoch != expected.lock_epoch
        {
            return Err(RuntimeError::new(
                RuntimeErrorCode::AuthenticationRequired,
                "Account generation changed during Quick Unlock",
            ));
        }

        let invalidated = self.invalidate_delivery(&expected.account_id);
        self.unlocked_items
            .lock()
            .expect("unlocked projection lock poisoned")
            .insert(expected.account_id.clone(), Vec::new());
        self.clear_live_master_unlock_keys_for_account(&expected.account_id);
        self.live_master_unlock_keys
            .lock()
            .expect("live master unlock key lock poisoned")
            .insert(
                (expected.account_id.clone(), expected.incarnation.clone()),
                LiveMasterUnlockKey::new(master_unlock_key),
            );
        self.account_access
            .lock()
            .expect("Account access lock poisoned")
            .insert(expected.account_id.clone(), AccountAccessState::Unlocked);
        self.device_revision.fetch_add(1, Ordering::SeqCst);
        Ok(invalidated)
    }

    fn fence_quick_unlock(
        &self,
        expected: &crate::replica::ReplicaSnapshot,
    ) -> Option<Arc<DeliveryToken>> {
        let _publication = self.publication.lock().expect("publication lock poisoned");
        let current = self.replica.snapshot(&expected.account_id)?;
        if current.incarnation != expected.incarnation || current.user_id != expected.user_id {
            return None;
        }
        let invalidated = self.invalidate_delivery(&expected.account_id);
        self.unlocked_items
            .lock()
            .expect("unlocked projection lock poisoned")
            .remove(&expected.account_id);
        self.clear_live_master_unlock_keys_for_account(&expected.account_id);
        self.account_access
            .lock()
            .expect("Account access lock poisoned")
            .insert(expected.account_id.clone(), AccountAccessState::SignedOut);
        self.device_revision.fetch_add(1, Ordering::SeqCst);
        invalidated
    }

    #[doc(hidden)]
    // lines 2077-2113
    pub(crate) async fn resolve_sign_in_kdf_pin(
        &self,
        normalized_server_url: &str,
        normalized_email: &str,
    ) -> Result<Option<bittery_crypto_core::KdfProfile>, RuntimeError> {
        let _catalog_guard = self.catalog_transition.lock().await;
        self.ensure_open()?;
        let Some(catalog) = self.platform_storage.load_device_catalog().await? else {
            return Ok(None);
        };
        let mut matching_profile = None;
        for account in catalog.accounts {
            let incarnation = account.active_incarnation.ok_or_else(|| {
                startup_invariant("active catalog Account has no active incarnation")
            })?;
            let metadata = self
                .platform_storage
                .load_account_metadata(&account.account_id, &incarnation)
                .await?
                .ok_or_else(|| {
                    startup_invariant("active catalog Account has no generation metadata")
                })?;
            if metadata.normalized_server_url == normalized_server_url
                && bittery_crypto_core::normalize_email(&metadata.email) == normalized_email
            {
                if matching_profile.is_some() {
                    return Err(RuntimeError::new(
                        RuntimeErrorCode::AuthenticationUnavailable,
                        "Device catalog has ambiguous authentication downgrade evidence",
                    ));
                }
                matching_profile = Some(metadata.pinned_kdf_profile);
            }
        }
        Ok(matching_profile)
    }
}
