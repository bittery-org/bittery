use super::*;
use crate::{
    http_transport::{HttpHeader, HttpMethod},
    replica::{
        canonical_create_vault_request, CreateVaultCheckpoint, CreateVaultOperationRecord,
        ImmutableHttpRequest, OperationKind, OperationRecord, OperationSchedulingState,
        PlanMutation, RecomputedPlanResult, ResourceRef,
    },
    CreateVaultType, VaultImageSourceInput,
};
use bittery_crypto_core::{
    encrypt_vault_key_with_muk, generate_encryption_key, VaultKeyWrapContext,
};

pub(super) fn create_vault_http_request(
    vault_id: &str,
    intent: &CreateVaultOperationRecord,
) -> Result<(ImmutableHttpRequest, crate::replica::Sha256Fingerprint), RuntimeError> {
    let canonical = canonical_create_vault_request(vault_id, intent)?;
    Ok((
        ImmutableHttpRequest {
            method: HttpMethod::Put,
            path: canonical.path,
            headers: vec![HttpHeader {
                name: "Content-Type".into(),
                value: "application/json".into(),
            }],
            body: canonical.body,
        },
        canonical.fingerprint,
    ))
}

impl Runtime {
    #[allow(
        clippy::too_many_arguments,
        reason = "the closed Runtime request keeps every accepted Vault field explicit"
    )]
    pub(super) async fn accept_create_vault(
        &self,
        account_id: AccountId,
        name: String,
        vault_type: CreateVaultType,
        icon: String,
        image_source: Option<VaultImageSourceInput>,
        cancellation: RequestCancellation,
        accepted: impl FnOnce(),
    ) -> Result<RuntimeResponse, RuntimeError> {
        self.ensure_open()?;
        if cancellation.is_cancelled() {
            return Err(cancelled_before_acceptance());
        }
        let name = name.trim().to_owned();
        let icon = icon.trim().to_owned();
        crate::replica::validate_create_vault_text_fields(&name, &icon).map_err(invalid_request)?;
        let execution_lock = self.account_execution_lock(&account_id)?;
        let _execution_guard = execution_lock.lock().await;
        self.ensure_open()?;
        if cancellation.is_cancelled() {
            return Err(cancelled_before_acceptance());
        }
        if self.account_access_retirement_is_pending(&account_id) {
            return Err(RuntimeError::new(
                RuntimeErrorCode::AuthenticationRequired,
                "Account lifecycle retirement is pending",
            ));
        }
        let snapshot = self.replica.snapshot(&account_id).ok_or_else(|| {
            RuntimeError::new(RuntimeErrorCode::AccountMissing, "account is not installed")
        })?;
        if self.travel_policy_verification_pending(&snapshot) {
            return Err(super::travel_policy::pending_policy());
        }
        if snapshot.failure.is_some() {
            return Err(RuntimeError::new(
                RuntimeErrorCode::AccountFailed,
                "the selected Account module has failed",
            ));
        }
        if self
            .account_access
            .lock()
            .expect("Account access lock poisoned")
            .get(&account_id)
            != Some(&AccountAccessState::Unlocked)
        {
            return Err(RuntimeError::new(
                RuntimeErrorCode::AuthenticationRequired,
                "the selected Account is signed out or locked",
            ));
        }
        let master_unlock_key = self
            .copy_live_master_unlock_key(&account_id, &snapshot.incarnation)
            .ok_or_else(|| {
                RuntimeError::new(
                    RuntimeErrorCode::AuthenticationRequired,
                    "the selected Account has no live key authority",
                )
            })?;

        let operation_id = bittery_crypto_core::generate_uuid();
        let vault_id = bittery_crypto_core::generate_uuid();
        let image = self
            .prepare_vault_operation_image(
                &snapshot,
                &operation_id,
                &vault_id,
                image_source,
                &cancellation,
            )
            .await?;
        let vault_key = Zeroizing::new(generate_encryption_key());
        let encrypted_vault_key = encrypt_vault_key_with_muk(
            vault_key.as_slice(),
            master_unlock_key.as_slice(),
            &VaultKeyWrapContext::new(&vault_id, &snapshot.user_id, 1),
        )
        .map_err(|_| invalid_request("Vault key could not be wrapped"))?;
        drop(master_unlock_key);
        drop(vault_key);

        let has_image = image.is_some();
        let checkpoint = if has_image {
            CreateVaultCheckpoint::ArtifactReady
        } else {
            CreateVaultCheckpoint::FinalRequestFrozen
        };
        let create_vault = CreateVaultOperationRecord {
            account_id: account_id.clone(),
            name,
            vault_type,
            icon,
            encrypted_vault_key,
            image,
            checkpoint,
        };
        let (mut request, request_fingerprint) =
            create_vault_http_request(&vault_id, &create_vault)?;
        if checkpoint != CreateVaultCheckpoint::FinalRequestFrozen {
            request.body.clear();
        }
        let operation = OperationRecord {
            operation_id: operation_id.clone(),
            kind: OperationKind::CreateVault,
            target: ResourceRef::Vault {
                vault_id: vault_id.clone(),
            },
            request,
            request_fingerprint,
            accepted_item_category: None,
            attachment_move_recovery: None,
            update_vault: None,
            create_vault: Some(create_vault),
            scheduling: OperationSchedulingState::default(),
            legacy_admission: None,
        };
        let replica_revision = self.commit_vault_operation(snapshot, operation).await?;
        accepted();
        self.device_revision.fetch_add(1, Ordering::SeqCst);
        self.publish_all();
        self.wake_dispatch();
        if has_image {
            self.finish_vault_image_acceptance_cleanup(&account_id, &operation_id)
                .await;
        }
        if cancellation.is_cancelled() {
            return Err(RuntimeError::new(
                RuntimeErrorCode::Cancelled,
                "caller cancelled after durable Vault acceptance",
            ));
        }
        Ok(RuntimeResponse::VaultCreationAccepted {
            operation_id,
            vault_id,
            replica_revision,
        })
    }
    pub(super) async fn prepare_vault_operation_image(
        &self,
        snapshot: &ReplicaSnapshot,
        operation_id: &str,
        vault_id: &str,
        source: Option<VaultImageSourceInput>,
        cancellation: &RequestCancellation,
    ) -> Result<Option<crate::replica::CreateVaultImageRecord>, RuntimeError> {
        let Some(source) = source else {
            return Ok(None);
        };
        let facade = self
            .vault_image_ingress
            .lock()
            .expect("Vault image ingress lock poisoned")
            .clone()
            .ok_or_else(|| invalid_request("Vault image ingress is unavailable"))?;
        let _loan = self.foreground_attachments.register_target(
            &snapshot.account_id,
            &snapshot.incarnation,
            super::foreground_attachment_lifecycle::ForegroundAttachmentTarget::VaultImage {
                vault_id: vault_id.to_owned(),
                operation_id: operation_id.to_owned(),
            },
            cancellation.clone(),
        )?;
        let device_key = self.require_image_device_key().await?;
        if !self.completion_scope_is_current(snapshot) || cancellation.is_cancelled() {
            return Err(cancelled_before_acceptance());
        }
        let prepared = facade
            .prepare_bound_protected(
                snapshot.account_id.clone(),
                operation_id.to_owned(),
                vault_id.to_owned(),
                source.capability_id,
                source.content_type,
                source.byte_length,
                cancellation,
                crate::vault_image::VaultImageProtection {
                    user_id: &snapshot.user_id,
                    device_key: device_key.key_bytes.as_slice(),
                },
            )
            .await?;
        if !self.completion_scope_is_current(snapshot) || cancellation.is_cancelled() {
            return Err(cancelled_before_acceptance());
        }
        let metadata = prepared.metadata();
        Ok(Some(crate::replica::CreateVaultImageRecord {
            protected_witness: Some(
                metadata
                    .protection()
                    .ok_or_else(|| invalid_request("Protected image publication is missing"))?
                    .witness
                    .clone(),
            ),
            raw_cleanup_pending: false,
            byte_length: metadata.byte_length(),
            content_type: metadata.content_type().to_owned(),
            sha256: metadata.sha256().to_owned(),
            object_key: format!(
                "vaults/{}/{}/create/{}-{}",
                snapshot.user_id,
                vault_id,
                operation_id,
                metadata.sha256()
            ),
        }))
    }

    /// Source acceptance release is process-local; a reopened owner has no old handshake.
    pub(super) async fn release_vault_image_acceptance_for_dispatch(
        &self,
        account_id: &AccountId,
        operation: &OperationRecord,
    ) -> bool {
        if operation.vault_image().is_none() {
            return true;
        }
        let identity = (account_id.clone(), operation.operation_id.clone());
        let pending = self
            .pending_vault_image_acceptance_cleanup
            .lock()
            .expect("Vault image acceptance cleanup lock poisoned")
            .contains(&identity);
        if pending {
            self.finish_vault_image_acceptance_cleanup(account_id, &operation.operation_id)
                .await;
        }
        !self
            .pending_vault_image_acceptance_cleanup
            .lock()
            .expect("Vault image acceptance cleanup lock poisoned")
            .contains(&identity)
    }

    async fn abort_vault_operation_image(&self, account_id: &AccountId, operation_id: &str) {
        self.finish_vault_image_acceptance_cleanup(account_id, operation_id)
            .await;
        let facade = self
            .vault_image_ingress
            .lock()
            .expect("Vault image ingress lock poisoned")
            .clone();
        if let Some(facade) = facade {
            let _ = facade
                .delete_bound(account_id.clone(), operation_id.to_owned())
                .await;
        }
    }

    pub(super) async fn commit_vault_operation(
        &self,
        snapshot: ReplicaSnapshot,
        operation: OperationRecord,
    ) -> Result<u64, RuntimeError> {
        let has_image = operation.vault_image().is_some();
        let account_id = snapshot.account_id.clone();
        let operation_id = operation.operation_id.clone();
        if has_image {
            if let Err(error) = self
                .begin_vault_image_acceptance(&account_id, &operation_id)
                .await
            {
                let facade = {
                    self.vault_image_ingress
                        .lock()
                        .expect("Vault image ingress lock poisoned")
                        .clone()
                };
                if let Some(facade) = facade {
                    let _ = facade
                        .delete_bound(account_id.clone(), operation_id.clone())
                        .await;
                }
                return Err(error);
            }
        }
        let lock_epoch = snapshot.lock_epoch;
        let result = self
            .replica
            .execute_recomputing(GuardedCommitPlan::new(
                account_id.clone(),
                snapshot.incarnation,
                snapshot.revision,
                lock_epoch,
                vec![PlanMutation::AcceptOperation(operation)],
            ))
            .await;
        let replica_revision = match result {
            Ok(RecomputedPlanResult::Applied { snapshot }) => {
                let revision = snapshot.revision;
                self.replica.cache(snapshot);
                revision
            }
            Err(error) => {
                if has_image {
                    self.abort_vault_operation_image(&account_id, &operation_id)
                        .await;
                }
                return Err(error);
            }
            Ok(RecomputedPlanResult::Missing) => {
                if has_image {
                    self.abort_vault_operation_image(&account_id, &operation_id)
                        .await;
                }
                self.replica.remove_cached(&account_id);
                return Err(RuntimeError::new(
                    RuntimeErrorCode::AccountMissing,
                    "account was removed during Vault acceptance",
                ));
            }
            Ok(RecomputedPlanResult::Fenced { snapshot }) => {
                if has_image {
                    self.abort_vault_operation_image(&account_id, &operation_id)
                        .await;
                }
                self.replica.cache(snapshot.clone());
                self.clear_live_master_unlock_keys_for_account(&account_id);
                self.account_access
                    .lock()
                    .expect("Account access lock poisoned")
                    .insert(account_id.clone(), AccountAccessState::Locked);
                self.account_lock_epochs
                    .lock()
                    .expect("Account lock epoch lock poisoned")
                    .insert(account_id.clone(), snapshot.lock_epoch);
                return Err(RuntimeError::new(
                    RuntimeErrorCode::AuthenticationRequired,
                    "Account access changed during Vault acceptance",
                ));
            }
        };
        Ok(replica_revision)
    }
}

fn invalid_request(message: &str) -> RuntimeError {
    RuntimeError::new(RuntimeErrorCode::InvariantViolation, message)
}

fn cancelled_before_acceptance() -> RuntimeError {
    RuntimeError::new(
        RuntimeErrorCode::Cancelled,
        "caller cancelled before durable Vault acceptance",
    )
}
