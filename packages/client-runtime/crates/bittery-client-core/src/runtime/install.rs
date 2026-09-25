use super::installation_commit::{InstallationCommitFailure, InstallationDocuments};
use super::*;

#[path = "catalog_retirement.rs"]
mod catalog_retirement;

impl Runtime {
    /// Guarded public Sign-in, polled without the ordinary request dispatcher's frame.
    pub(super) async fn sign_in(
        &self,
        request: RuntimeRequest,
        cancellation: RequestCancellation,
        before_acceptance: impl FnOnce(),
        accepted: impl FnOnce(),
    ) -> Result<RuntimeResponse, RuntimeError> {
        let _admission = self.teardown_admission.read().await;
        self.reject_request_during_pending_teardown(&request)?;
        let RuntimeRequest::SignIn {
            server_url,
            email,
            master_password,
            secret_key,
            insecure_transport_confirmed,
        } = request
        else {
            unreachable!("the guarded request is Sign-in")
        };
        let master_password = Zeroizing::new(master_password);
        let mut secret_key = Zeroizing::new(secret_key);
        self.ensure_open()?;
        if cancellation.is_cancelled() {
            return Err(RuntimeError::new(
                RuntimeErrorCode::Cancelled,
                "caller cancelled before durable acceptance",
            ));
        }
        let auth_config = self.auth_client_config.clone().ok_or_else(|| {
            RuntimeError::new(
                RuntimeErrorCode::AuthenticationUnavailable,
                "authentication is implemented by a later vertical slice",
            )
        })?;
        let normalized_email = bittery_crypto_core::normalize_email(&email);
        let http = AuthHttpClient::new(
            &self.http_transport,
            &server_url,
            insecure_transport_confirmed,
            auth_config,
        )?;
        if !bittery_crypto_core::validate_secret_key(&secret_key) {
            return Err(RuntimeError::new(
                RuntimeErrorCode::AuthenticationUnavailable,
                "Secret Key is invalid",
            ));
        }
        let pinned_kdf_profile = self
            .resolve_sign_in_kdf_pin(&http.normalized_server_url(), &normalized_email)
            .await?;
        let verified = authenticate(
            &http,
            AuthenticationInput {
                email: &normalized_email,
                master_password: &master_password,
                secret_key: &secret_key,
                pinned_kdf_profile: pinned_kdf_profile.as_ref(),
            },
            cancellation.clone(),
        )
        .await?;
        drop(master_password);
        before_acceptance();
        if cancellation.is_cancelled() {
            return Err(RuntimeError::new(
                RuntimeErrorCode::Cancelled,
                "caller cancelled before durable Account acceptance",
            ));
        }

        // Remote verification is complete. From this point the installer owns the accepted
        // generation and must either publish it or fence it despite later caller cancellation.
        accepted();
        let evidence = AuthenticationInstallationEvidence::new(
            std::mem::take(&mut *secret_key),
            insecure_transport_confirmed,
        );
        self.install_verified_authentication(verified, evidence)
            .await
    }

    /// Caller holds catalog serialization. Admission under Account execution only loads this
    /// existing secret and must never acquire catalog serialization in the opposite order.
    pub(super) async fn ensure_image_device_key_under_catalog(
        &self,
        entropy: &dyn InstallationEntropy,
    ) -> Result<DeviceKeyDocument, RuntimeError> {
        if let Some(document) = self.platform_storage.load_device_key().await? {
            return Ok(document);
        }
        let catalog = self.platform_storage.load_device_catalog().await?;
        if let Some(catalog) = catalog {
            for account in catalog.accounts {
                let snapshot = self.replica.load_uncached(&account.account_id).await?;
                if snapshot.is_none() && account.active_incarnation.is_some() {
                    return Err(RuntimeError::new(
                        RuntimeErrorCode::StorageUnavailable,
                        "Device key initialization requires installed Account inventory",
                    ));
                }
                if snapshot.is_some_and(|snapshot| {
                    snapshot.operations.iter().any(|operation| {
                        operation
                            .vault_image()
                            .is_some_and(|image| image.protected_witness.is_some())
                    })
                }) {
                    return Err(RuntimeError::new(
                        RuntimeErrorCode::StorageUnavailable,
                        "Device key is missing for accepted protected Vault images",
                    ));
                }
            }
        }
        let document = DeviceKeyDocument::new(entropy.generate_device_key());
        self.ensure_not_closed()?;
        self.platform_storage.store_device_key(&document).await?;
        Ok(document)
    }

    pub(super) async fn require_image_device_key(&self) -> Result<DeviceKeyDocument, RuntimeError> {
        self.platform_storage
            .load_device_key()
            .await?
            .ok_or_else(|| {
                RuntimeError::new(
                    RuntimeErrorCode::StorageUnavailable,
                    "Device key for protected Vault images is unavailable",
                )
            })
    }

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
        self.account_display_identities
            .lock()
            .expect("Account display identity lock poisoned")
            .remove(&account_id);
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
        self.native_authority.retire_account(&account_id);
        let _biometric_retirement = self.biometric.retire_for_publication(&account_id);
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
        self.account_display_identities
            .lock()
            .expect("Account display identity lock poisoned")
            .remove(&account_id);
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
        drop(_biometric_retirement);
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
        self.require_native_identity_local_unlock_allowed(
            &verified.normalized_server_url,
            &verified.user.id,
        )?;
        let mut original_catalog = self.platform_storage.load_device_catalog().await?;
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
        // Only this already-verified path may retry Replace. Remove and Device Wipe still
        // refuse installation before any write, while ordinary work sees both purposes as gated.
        self.reject_installation_during_account_removal(&account_id)?;
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

        let mut execution_accounts = if is_replacement {
            catalog
                .accounts
                .iter()
                .map(|account| account.account_id.clone())
                .collect::<Vec<_>>()
        } else {
            vec![account_id.clone()]
        };
        execution_accounts.sort();
        execution_accounts.dedup();
        let execution_locks = execution_accounts
            .iter()
            .map(|account| self.account_execution_lock(account))
            .collect::<Result<Vec<_>, _>>()?;
        let mut execution_guards = Vec::with_capacity(execution_locks.len());
        for lock in &execution_locks {
            execution_guards.push(lock.lock().await);
        }
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

        self.require_native_identity_local_unlock_allowed(
            &verified.normalized_server_url,
            &verified.user.id,
        )?;
        let device_key = self.ensure_image_device_key_under_catalog(entropy).await?;
        let prepared = prepare_authenticated_installation(
            verified,
            evidence,
            account_id.clone(),
            incarnation.clone(),
            previous_metadata,
            &device_key.key_bytes,
            clock,
        )?;

        let installed = async {
            if let Some(retired_incarnation) = &expected_active_incarnation {
                self.gate_catalog_account_retirement(
                    &account_id,
                    crate::platform_storage::AccountRetirementPurpose::Replace,
                );
                let marked = self
                    .mark_catalog_account_retirement(
                        &catalog,
                        &account_id,
                        crate::platform_storage::AccountRetirementPurpose::Replace,
                    )
                    .await
                    .map_err(InstallationCommitFailure::BeforeReplica)?;
                self.retire_cross_account_destination_bindings(
                    &marked,
                    &account_id,
                    retired_incarnation,
                )
                .await
                .map_err(InstallationCommitFailure::BeforeReplica)?;
                // A pre-Replica rollback must preserve the already committed retirement intent.
                original_catalog = Some(marked);
            }
            self.persist_account_installation(
                original_catalog.as_ref(),
                previous_snapshot.as_ref(),
                InstallationDocuments {
                    metadata: &prepared.metadata,
                    quick_unlock: Some(&prepared.quick_unlock),
                    current_session: Some(&prepared.current_session),
                },
            )
            .await
        }
        .await;
        let installed_snapshot = match installed {
            Ok(snapshot) => snapshot,
            Err(InstallationCommitFailure::BeforeReplica(error)) => {
                drop(execution_guards);
                drop(catalog_guard);
                self.publish_all_unless_closed();
                return Err(error);
            }
            Err(InstallationCommitFailure::AfterReplica { error, snapshot }) => {
                let invalidated = self.fence_authenticated_installation(
                    snapshot.map(|snapshot| *snapshot),
                    &account_id,
                );
                drop(execution_guards);
                drop(catalog_guard);
                finish_generation_fence(invalidated);
                self.publish_all_unless_closed();
                return Err(error);
            }
        };

        let publication = self.publish_authenticated_installation(
            installed_snapshot.clone(),
            account_id.clone(),
            account_presentation(&prepared.metadata),
            prepared.master_unlock_key,
            Some(prepared.current_session.encrypted_private_key.clone()),
        );
        let (invalidated, unlocked) = match publication {
            Ok(publication) if !self.is_closed() => publication,
            Ok((first_invalidated, _)) => {
                let invalidated =
                    self.fence_authenticated_installation(Some(installed_snapshot), &account_id);
                drop(execution_guards);
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
                drop(execution_guards);
                drop(catalog_guard);
                finish_generation_fence(invalidated);
                self.publish_all_unless_closed();
                return Err(error);
            }
        };
        self.complete_catalog_account_replacement(&account_id);
        drop(execution_guards);
        drop(catalog_guard);
        finish_generation_fence(invalidated);
        self.publish_all_unless_closed();
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

        if !unlocked {
            return Err(RuntimeError::new(
                RuntimeErrorCode::AuthenticationRequired,
                "Connected Desktop authority requires native Account authorization",
            ));
        }
        // A Session is installed again, so anything parked on one may resume.
        self.note_local_unlock_completed(&account_id);
        self.note_session_available(&account_id);
        let _ = self
            .bootstrap_account(&account_id, RequestCancellation::new())
            .await;

        Ok(RuntimeResponse::SignedIn {
            account_id,
            user_id: prepared.metadata.user_id,
        })
    }

    pub(super) async fn rollback_pre_replica_install(
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

    pub(super) fn fence_authenticated_installation(
        &self,
        snapshot: Option<crate::replica::ReplicaSnapshot>,
        account_id: &AccountId,
    ) -> Option<Arc<DeliveryToken>> {
        self.native_authority.retire_account(account_id);
        let _biometric_retirement = self.biometric.retire_for_publication(account_id);
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
        self.account_display_identities
            .lock()
            .expect("Account display identity lock poisoned")
            .remove(account_id);
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
        display_identity: AccountPresentation,
        master_unlock_key: Zeroizing<[u8; 32]>,
        encrypted_private_key: Option<String>,
    ) -> Result<(Option<Arc<DeliveryToken>>, bool), RuntimeError> {
        // Attachment and publication share native→biometric→publication ordering. A connection
        // that appeared during physical installation leaves discoverable independent credentials
        // and a Locked Account, never independently published live keys.
        let native = self.native_local_installation_publication(
            &display_identity.identity.server_url,
            &snapshot.user_id,
            &account_id,
        );
        let _biometric_retirement = self.biometric.retire_for_publication(&account_id);
        let material = native.allowed.then(|| {
            LiveMasterUnlockKey::with_private_key(master_unlock_key, encrypted_private_key)
        });
        let invalidated = self.publish_installed_account(snapshot, display_identity, material)?;
        Ok((invalidated, native.allowed))
    }

    /// Publish installed metadata as Locked or with already-authorized live material. Callers own
    /// installation admission and any required retirement of an existing Account generation.
    pub(super) fn publish_installed_account(
        &self,
        snapshot: ReplicaSnapshot,
        display_identity: AccountPresentation,
        material: Option<LiveMasterUnlockKey>,
    ) -> Result<Option<Arc<DeliveryToken>>, RuntimeError> {
        let account_id = snapshot.account_id.clone();
        let incarnation = snapshot.incarnation.clone();
        let lock_epoch = snapshot.lock_epoch;
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
            .remove(&account_id);
        self.clear_live_master_unlock_keys_for_account(&account_id);
        let access = if let Some(material) = material {
            self.unlocked_items
                .lock()
                .expect("unlocked projection lock poisoned")
                .insert(account_id.clone(), Vec::new());
            self.live_master_unlock_keys
                .lock()
                .expect("live master unlock key lock poisoned")
                .insert((account_id.clone(), incarnation), material);
            AccountAccessState::Unlocked
        } else {
            AccountAccessState::Locked
        };
        self.account_access
            .lock()
            .expect("Account access lock poisoned")
            .insert(account_id.clone(), access);
        self.account_display_identities
            .lock()
            .expect("Account display identity lock poisoned")
            .insert(account_id.clone(), display_identity);
        self.account_lock_epochs
            .lock()
            .expect("Account lock epoch lock poisoned")
            .insert(account_id.clone(), lock_epoch);
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

        let publication = self
            .native_local_unlock_publication(&snapshot)
            .and_then(|_native| {
                self.publish_account_unlock(
                    &snapshot,
                    prepared.master_unlock_key,
                    Some(prepared.current_session.encrypted_private_key.clone()),
                )
            });
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
        self.note_local_unlock_completed(&account_id);
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

    pub(super) fn publish_account_unlock(
        &self,
        expected: &crate::replica::ReplicaSnapshot,
        master_unlock_key: Zeroizing<[u8; 32]>,
        encrypted_private_key: Option<String>,
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
        if self.account_access_retirement_is_pending(&expected.account_id)
            || self
                .lock_epoch_pending
                .lock()
                .expect("pending lock epoch lock poisoned")
                .contains_key(&expected.account_id)
            || current.incarnation != expected.incarnation
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
                LiveMasterUnlockKey::with_private_key(master_unlock_key, encrypted_private_key),
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
        self.fence_account_unlock(expected, AccountAccessState::SignedOut)
    }

    pub(super) fn fence_account_unlock(
        &self,
        expected: &crate::replica::ReplicaSnapshot,
        access: AccountAccessState,
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
            .insert(expected.account_id.clone(), access);
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
