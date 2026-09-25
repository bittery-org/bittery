//! Account-scoped local access orchestration. Every password target uses the existing ceremony.
use super::*;
use crate::Incarnation;

pub(super) enum LocalTravelFailure {
    Unavailable,
    Unverified,
    Runtime(RuntimeError),
}

impl Runtime {
    /// One retained-Session Travel decision for local biometric release and native import.
    /// The ceremony never creates or refreshes a Server Session.
    pub(super) async fn verify_local_travel_policy(
        &self,
        metadata: &crate::platform_storage::AccountMetadataDocument,
        session: &crate::platform_storage::CurrentSessionDocument,
        cancellation: RequestCancellation,
    ) -> Result<(crate::platform_storage::VerifiedTravelModePolicy, bool), LocalTravelFailure> {
        let config = self
            .auth_client_config
            .clone()
            .ok_or(LocalTravelFailure::Unavailable)?;
        let http = AuthHttpClient::new(
            &self.http_transport,
            &metadata.normalized_server_url,
            metadata.insecure_transport_confirmed,
            config,
        )
        .map_err(LocalTravelFailure::Runtime)?;
        match http.get_travel_mode(&session.token, cancellation).await {
            Ok(policy) => Ok((
                crate::authentication_installation::prepare_verified_travel_policy(
                    &policy,
                    self.clock.now_ms().map_err(LocalTravelFailure::Runtime)?,
                )
                .map_err(|_| LocalTravelFailure::Unverified)?,
                true,
            )),
            Err(error) if error.code == RuntimeErrorCode::RetryableTransport => Ok((
                metadata
                    .verified_travel_mode
                    .clone()
                    .ok_or(LocalTravelFailure::Unverified)?,
                false,
            )),
            Err(error) => Err(LocalTravelFailure::Runtime(error)),
        }
    }

    pub(super) fn hidden_local_authority_remains(
        snapshot: &ReplicaSnapshot,
        session: &crate::platform_storage::CurrentSessionDocument,
        policy: &crate::platform_storage::VerifiedTravelModePolicy,
    ) -> bool {
        if !policy.enabled {
            return false;
        }
        let hidden = &policy.hidden_vault_ids;
        snapshot
            .bootstrap
            .vaults
            .keys()
            .any(|(_, vault)| hidden.contains(vault))
            || snapshot
                .bootstrap
                .items
                .values()
                .any(|item| hidden.contains(&item.vault_id))
            || snapshot
                .items
                .iter()
                .any(|item| hidden.contains(&item.vault_id))
            || session
                .vault_keys
                .iter()
                .any(|key| hidden.contains(&key.vault_id))
    }
}

impl Runtime {
    pub(super) fn note_local_unlock_completed(&self, account: &AccountId) {
        self.native_local_unlock_completed(account);
        self.reset_inactivity_after_unlock(account);
    }

    /// One guarded password ceremony shared by the public and batch unlock paths.
    pub(super) async fn quick_unlock_account(
        &self,
        account_id: AccountId,
        master_password: String,
        cancellation: RequestCancellation,
        expected_unlock: Option<ReplicaSnapshot>,
        before_acceptance: impl FnOnce(),
        accepted: impl FnOnce(),
    ) -> Result<RuntimeResponse, RuntimeError> {
        // Preserve the ordinary request's teardown admission gate and hold its read lease
        // through the entire ceremony, including accepted installation.
        let request = RuntimeRequest::QuickUnlock {
            account_id,
            master_password,
        };
        let _admission = self.teardown_admission.read().await;
        self.reject_request_during_pending_teardown(&request)?;
        let RuntimeRequest::QuickUnlock {
            account_id,
            master_password,
        } = request
        else {
            unreachable!("the guarded request is Quick Unlock")
        };
        let master_password = Zeroizing::new(master_password);
        self.ensure_open()?;
        self.require_native_local_unlock_allowed(&account_id)?;
        if cancellation.is_cancelled() {
            return Err(RuntimeError::new(
                RuntimeErrorCode::Cancelled,
                "caller cancelled before durable acceptance",
            ));
        }
        let auth_config = self.auth_client_config.clone().ok_or_else(|| {
            RuntimeError::new(
                RuntimeErrorCode::AuthenticationUnavailable,
                "authentication is not configured for this Runtime",
            )
        })?;
        let execution_lock = self.account_execution_lock(&account_id)?;
        let execution_guard = execution_lock.lock().await;
        self.ensure_open()?;
        if cancellation.is_cancelled() {
            return Err(RuntimeError::new(
                RuntimeErrorCode::Cancelled,
                "caller cancelled before Quick Unlock preparation",
            ));
        }
        if self
            .lock_epoch_pending
            .lock()
            .expect("pending lock epoch lock poisoned")
            .contains_key(&account_id)
        {
            return Err(RuntimeError::new(
                RuntimeErrorCode::InvariantViolation,
                "Account lock epoch persistence is pending",
            ));
        }
        let snapshot = self.replica.snapshot(&account_id).ok_or_else(|| {
            RuntimeError::new(RuntimeErrorCode::AccountMissing, "account is not installed")
        })?;
        if expected_unlock.as_ref().is_some_and(|expected| {
            expected.incarnation != snapshot.incarnation
                || expected.user_id != snapshot.user_id
                || expected.lock_epoch != snapshot.lock_epoch
        }) {
            return Err(RuntimeError::new(
                RuntimeErrorCode::AuthenticationRequired,
                "Explicit unlock target was retired before preparation",
            ));
        }
        if snapshot.failure.is_some() {
            return Err(RuntimeError::new(
                RuntimeErrorCode::AccountFailed,
                "the selected Account module has failed",
            ));
        }
        let catalog = self
            .platform_storage
            .load_device_catalog()
            .await?
            .ok_or_else(quick_unlock_material_required)?;
        let catalog_account = catalog
            .accounts
            .iter()
            .find(|candidate| candidate.account_id == account_id)
            .ok_or_else(quick_unlock_material_required)?;
        if catalog_account.pending_install.is_some()
            || catalog_account.active_incarnation.as_ref() != Some(&snapshot.incarnation)
        {
            return Err(quick_unlock_material_required());
        }
        let metadata = self
            .platform_storage
            .load_account_metadata_for_authentication(&account_id, &snapshot.incarnation)
            .await?
            .ok_or_else(quick_unlock_material_required)?;
        if metadata.user_id != snapshot.user_id {
            return Err(quick_unlock_material_required());
        }
        let quick_unlock = self
            .platform_storage
            .load_quick_unlock_for_authentication(&account_id, &snapshot.incarnation)
            .await?
            .ok_or_else(quick_unlock_material_required)?;
        let device_key = self
            .platform_storage
            .load_device_key_for_authentication()
            .await?
            .ok_or_else(quick_unlock_material_required)?;
        let stored_master_unlock_key = unwrap_master_unlock_key(
            &quick_unlock.encrypted_master_unlock_key,
            &device_key.key_bytes,
        )?;
        let normalized_email = bittery_crypto_core::normalize_email(&metadata.email);
        let http = AuthHttpClient::new(
            &self.http_transport,
            &metadata.normalized_server_url,
            metadata.insecure_transport_confirmed,
            auth_config,
        )?;
        let verified = authenticate(
            &http,
            AuthenticationInput {
                email: &normalized_email,
                master_password: &master_password,
                secret_key: &quick_unlock.secret_key,
                pinned_kdf_profile: Some(&metadata.pinned_kdf_profile),
            },
            cancellation.clone(),
        )
        .await?;
        drop(master_password);
        let prepared = prepare_quick_unlock(
            verified,
            metadata,
            quick_unlock,
            &stored_master_unlock_key,
            &SystemClock,
        )?;
        drop(stored_master_unlock_key);
        before_acceptance();
        self.ensure_not_closed()?;
        if cancellation.is_cancelled() {
            return Err(RuntimeError::new(
                RuntimeErrorCode::Cancelled,
                "caller cancelled before durable Quick Unlock acceptance",
            ));
        }

        // Every remote and local equality check is complete. Cancellation no longer owns
        // the accepted session installation; it must finish or fence this exact generation.
        accepted();
        self.commit_quick_unlock(snapshot, prepared, execution_guard)
            .await
    }

    pub(super) async fn quick_unlock_accounts(
        &self,
        account_ids: Vec<AccountId>,
        master_password: Zeroizing<String>,
        cancellation: RequestCancellation,
    ) -> Result<RuntimeResponse, RuntimeError> {
        self.ensure_open()?;
        let mut seen = std::collections::HashSet::new();
        let targets: Vec<_> = account_ids
            .into_iter()
            .filter(|account| seen.insert(account.clone()))
            .map(|account| {
                let snapshot = self.replica.snapshot(&account);
                (account, snapshot)
            })
            .collect();
        let mut accounts = Vec::new();
        for (account_id, expected) in targets {
            let failure = if cancellation.is_cancelled() {
                Some(RuntimeErrorCode::Cancelled)
            } else if self.is_closed() {
                Some(RuntimeErrorCode::RuntimeClosed)
            } else if let Some(expected) = expected {
                let current = self.replica.snapshot(&account_id);
                if current.is_none_or(|current| {
                    current.incarnation != expected.incarnation
                        || current.user_id != expected.user_id
                        || current.lock_epoch != expected.lock_epoch
                }) {
                    Some(RuntimeErrorCode::AuthenticationRequired)
                } else {
                    // The same single-Account command owns SRP, stored-key validation,
                    // timestamps and guarded installation without nesting the dispatcher.
                    match Box::pin(self.quick_unlock_account(
                        account_id.clone(),
                        master_password.to_string(),
                        cancellation.clone(),
                        Some(expected),
                        || {},
                        || {},
                    ))
                    .await
                    {
                        Ok(RuntimeResponse::SignedIn { .. }) => None,
                        Ok(_) => Some(RuntimeErrorCode::InvariantViolation),
                        Err(error) => Some(error.code),
                    }
                }
            } else {
                Some(RuntimeErrorCode::AccountMissing)
            };
            accounts.push(crate::AccountUnlockResult {
                account_id,
                failure,
            });
        }
        Ok(RuntimeResponse::AccountsUnlocked { accounts })
    }
}

impl Runtime {
    pub(super) fn delivery_token(
        &self,
        snapshot: &ReplicaSnapshot,
        generation: &DeliveryGeneration,
    ) -> Arc<DeliveryToken> {
        let account_id = &snapshot.account_id;
        let pending = self.travel_policy_verification_pending(snapshot);
        let mut tokens = self
            .delivery_tokens
            .lock()
            .expect("delivery token map poisoned");
        let entry = tokens
            .entry(account_id.clone())
            .or_insert_with(|| (generation.clone(), Arc::new(DeliveryToken::new())));
        if &entry.0 != generation {
            *entry = (generation.clone(), Arc::new(DeliveryToken::new()));
        }
        entry.1.pause_admission(pending);
        Arc::clone(&entry.1)
    }

    fn require_setup_access(
        &self,
        account_id: &AccountId,
    ) -> Result<ReplicaSnapshot, RuntimeError> {
        self.ensure_open()?;
        self.reject_request_during_pending_teardown(&RuntimeRequest::DeviceSetup {
            account_id: account_id.clone(),
        })?;
        let snapshot = self.require_snapshot(account_id)?;
        if !self.generation_is_preparation_eligible(&snapshot)
            || self
                .lock_epoch_pending
                .lock()
                .expect("pending lock epoch lock poisoned")
                .contains_key(account_id)
            || self
                .copy_live_master_unlock_key(account_id, &snapshot.incarnation)
                .is_none()
        {
            return Err(setup_access_required());
        }
        Ok(snapshot)
    }

    pub(super) async fn device_setup(
        &self,
        account_id: AccountId,
        cancellation: RequestCancellation,
    ) -> Result<RuntimeResponse, RuntimeError> {
        let lock = self.account_execution_lock(&account_id)?;
        let _execution = lock.lock().await;
        let expected = self.require_setup_access(&account_id)?;
        if cancellation.is_cancelled() {
            return Err(setup_cancelled());
        }
        let metadata = self
            .platform_storage
            .load_account_metadata(&account_id, &expected.incarnation)
            .await?
            .ok_or_else(setup_access_required)?;
        let quick = self
            .platform_storage
            .load_quick_unlock(&account_id, &expected.incarnation)
            .await?
            .ok_or_else(setup_access_required)?;
        let _publication = self.publication.lock().expect("publication lock poisoned");
        let current = self.require_setup_access(&account_id)?;
        if current.incarnation != expected.incarnation || current.lock_epoch != expected.lock_epoch
        {
            return Err(setup_access_required());
        }
        if cancellation.is_cancelled() {
            return Err(setup_cancelled());
        }
        Ok(RuntimeResponse::DeviceSetup {
            disclosure: crate::DeviceSetupDisclosure {
                account_id,
                incarnation: expected.incarnation,
                lock_epoch: expected.lock_epoch,
                email: metadata.email.clone(),
                server_url: metadata.normalized_server_url.clone(),
                team_name: metadata
                    .team_name
                    .clone()
                    .or_else(|| (!metadata.name.is_empty()).then(|| metadata.name.clone())),
                secret_key: quick.secret_key.clone(),
            },
        })
    }

    /// Deliver a transient response through the same Account generation fence as plaintext
    /// observations. Bindings must perform their final conversion inside this callback; already
    /// transported payloads retain the Account stamp for caller-side stale-delivery filtering.
    pub fn deliver_response<T>(
        &self,
        response: RuntimeResponse,
        deliver: impl FnOnce(RuntimeResponse) -> T,
    ) -> Result<T, RuntimeError> {
        if let RuntimeResponse::DeviceSetup { disclosure } = &response {
            self.deliver_account_scoped(
                &disclosure.account_id.clone(),
                &disclosure.incarnation.clone(),
                disclosure.lock_epoch,
                |_| Ok(()),
                || deliver(response),
            )
        } else {
            let _active = ActiveRuntimeDelivery::enter(self as *const Self as usize);
            Ok(deliver(response))
        }
    }

    pub(super) fn deliver_account_scoped<T>(
        &self,
        account: &AccountId,
        incarnation: &Incarnation,
        epoch: u64,
        validate: impl FnOnce(&ReplicaSnapshot) -> Result<(), RuntimeError>,
        deliver: impl FnOnce() -> T,
    ) -> Result<T, RuntimeError> {
        let lease = {
            let _publication = self.publication.lock().expect("publication lock poisoned");
            let snapshot = self.require_setup_access(account)?;
            if &snapshot.incarnation != incarnation || snapshot.lock_epoch != epoch {
                return Err(setup_access_required());
            }
            validate(&snapshot)?;
            let generation = DeliveryGeneration {
                incarnation: incarnation.clone(),
                epoch,
            };
            self.delivery_token(&snapshot, &generation)
                .begin()
                .ok_or_else(setup_access_required)?
        };
        let _active = ActiveRuntimeDelivery::enter(self as *const Self as usize);
        let result = deliver();
        drop(lease);
        Ok(result)
    }

    /// JSON bindings use this guarded conversion rather than serializing a retained disclosure
    /// after its Account has been locked or removed.
    pub fn encode_outcome(
        &self,
        outcome: crate::RuntimeOutcome,
    ) -> Result<Zeroizing<String>, RuntimeError> {
        let serialize = |outcome| {
            serde_json::to_string(&outcome)
                .map(Zeroizing::new)
                .map_err(|_| {
                    RuntimeError::new(
                        RuntimeErrorCode::InvariantViolation,
                        "Runtime outcome encoding failed",
                    )
                })
        };
        match outcome {
            crate::RuntimeOutcome::Succeeded(response) => self
                .deliver_response(response, |response| {
                    serialize(crate::RuntimeOutcome::Succeeded(response))
                })?,
            failed => serialize(failed),
        }
    }
}

fn setup_access_required() -> RuntimeError {
    RuntimeError::new(
        RuntimeErrorCode::AuthenticationRequired,
        "Device setup requires the current unlocked Account",
    )
}
fn setup_cancelled() -> RuntimeError {
    RuntimeError::new(
        RuntimeErrorCode::Cancelled,
        "Device setup disclosure was cancelled",
    )
}
