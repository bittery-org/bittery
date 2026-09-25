//! Durable Vault metadata requests use the existing Replica and Operation dispatcher.
use super::*;
use crate::{
    http_transport::{HttpHeader, HttpMethod},
    replica::{
        vault_update_fingerprint, AuthorityVaultRole, ImmutableHttpRequest, OperationKind,
        OperationRecord, OperationSchedulingState, ResourceRef,
    },
    VaultIconPatch, VaultImageChange,
};

impl Runtime {
    pub(super) async fn accept_vault_deletion(
        &self,
        account_id: AccountId,
        vault_id: String,
        cancellation: RequestCancellation,
        accepted: impl FnOnce(),
    ) -> Result<RuntimeResponse, RuntimeError> {
        self.ensure_open()?;
        let execution = self.account_execution_lock(&account_id)?;
        let _execution = execution.lock().await;
        self.ensure_open()?;
        if cancellation.is_cancelled() {
            return Err(RuntimeError::new(
                RuntimeErrorCode::Cancelled,
                "caller cancelled before Vault deletion acceptance",
            ));
        }
        let snapshot = self.require_vault_management_authority(&account_id, &vault_id, true)?;
        let operation_id = bittery_crypto_core::generate_uuid();
        let operation = OperationRecord {
            operation_id: operation_id.clone(),
            kind: OperationKind::DeleteVault,
            target: ResourceRef::Vault {
                vault_id: vault_id.clone(),
            },
            request_fingerprint: crate::replica::vault_deletion_fingerprint(&vault_id),
            request: ImmutableHttpRequest {
                method: HttpMethod::Post,
                path: format!("/api/v1/vaults/{vault_id}/deletions"),
                headers: vec![HttpHeader {
                    name: "Content-Type".into(),
                    value: "application/json".into(),
                }],
                body: b"{}".to_vec(),
            },
            accepted_item_category: None,
            attachment_move_recovery: None,
            create_vault: None,
            update_vault: None,
            scheduling: OperationSchedulingState::default(),
            legacy_admission: None,
        };
        let replica_revision = self.commit_vault_operation(snapshot, operation).await?;
        accepted();
        self.device_revision.fetch_add(1, Ordering::SeqCst);
        self.publish_all_unless_closed();
        self.wake_dispatch();
        if cancellation.is_cancelled() {
            return Err(RuntimeError::new(
                RuntimeErrorCode::Cancelled,
                "caller cancelled after durable Vault deletion acceptance",
            ));
        }
        Ok(RuntimeResponse::VaultDeletionAccepted {
            operation_id,
            vault_id,
            replica_revision,
        })
    }

    #[allow(
        clippy::too_many_arguments,
        reason = "closed Vault update request fields and acceptance lifetime"
    )]
    pub(super) async fn accept_vault_update(
        &self,
        account_id: AccountId,
        vault_id: String,
        name: Option<String>,
        icon: VaultIconPatch,
        image: VaultImageChange,
        cancellation: RequestCancellation,
        accepted: impl FnOnce(),
    ) -> Result<RuntimeResponse, RuntimeError> {
        self.ensure_open()?;
        let execution = self.account_execution_lock(&account_id)?;
        let _execution = execution.lock().await;
        self.ensure_open()?;
        if cancellation.is_cancelled() {
            return Err(RuntimeError::new(
                RuntimeErrorCode::Cancelled,
                "caller cancelled before Vault update acceptance",
            ));
        }
        let snapshot = self.require_vault_management_authority(&account_id, &vault_id, false)?;
        let name = name.map(|name| name.trim().to_owned());
        let mut fields = crate::replica::vault_update_fields(name.as_deref(), &icon);
        if matches!(image, VaultImageChange::Remove) {
            fields.insert("imageKey".into(), serde_json::Value::Null);
        }
        crate::replica::validate_vault_update_fields(&fields)
            .map_err(|message| RuntimeError::new(RuntimeErrorCode::InvariantViolation, message))?;
        let body = serde_json::to_vec(&fields).map_err(|_| {
            RuntimeError::new(
                RuntimeErrorCode::InvariantViolation,
                "Vault metadata could not be encoded",
            )
        })?;
        let operation_id = bittery_crypto_core::generate_uuid();
        let source = match image {
            VaultImageChange::Source { source } => Some(source),
            _ => None,
        };
        if source.is_some() {
            self.require_vault_image_key_authority(&snapshot, &vault_id)?;
        }
        let prepared_image = self
            .prepare_vault_operation_image(
                &snapshot,
                &operation_id,
                &vault_id,
                source,
                &cancellation,
            )
            .await?;
        let update_vault = prepared_image.map(|image| {
            Box::new(crate::replica::UpdateVaultImageOperationRecord {
                account_id: account_id.clone(),
                name,
                icon,
                image,
                checkpoint: crate::replica::CreateVaultCheckpoint::ArtifactReady,
            })
        });
        let mut operation = OperationRecord {
            operation_id: operation_id.clone(),
            kind: OperationKind::UpdateVault,
            target: ResourceRef::Vault {
                vault_id: vault_id.clone(),
            },
            request_fingerprint: vault_update_fingerprint(&vault_id, &body),
            request: ImmutableHttpRequest {
                method: HttpMethod::Post,
                path: format!("/api/v1/vaults/{vault_id}/metadata-updates"),
                headers: vec![HttpHeader {
                    name: "Content-Type".into(),
                    value: "application/json".into(),
                }],
                body,
            },
            accepted_item_category: None,
            attachment_move_recovery: None,
            update_vault,
            create_vault: None,
            scheduling: OperationSchedulingState::default(),
            legacy_admission: None,
        };
        let has_image = operation.update_vault.is_some();
        if let Some(intent) = &operation.update_vault {
            let (mut request, fingerprint) =
                crate::replica::canonical_vault_image_update_request(&vault_id, intent)?;
            request.body.clear();
            operation.request = request;
            operation.request_fingerprint = fingerprint;
        }
        let replica_revision = self.commit_vault_operation(snapshot, operation).await?;
        accepted();
        self.device_revision.fetch_add(1, Ordering::SeqCst);
        self.publish_all_unless_closed();
        self.wake_dispatch();
        if has_image {
            self.finish_vault_image_acceptance_cleanup(&account_id, &operation_id)
                .await;
        }
        if cancellation.is_cancelled() {
            return Err(RuntimeError::new(
                RuntimeErrorCode::Cancelled,
                "caller cancelled after durable Vault update acceptance",
            ));
        }
        Ok(RuntimeResponse::VaultUpdateAccepted {
            operation_id,
            vault_id,
            replica_revision,
        })
    }
    /// An image key is separate from Vault encryption, but image access still requires a
    /// usable key from the current visible Vault authority, never an accepted historical wrapper.
    pub(super) fn require_vault_image_key_authority(
        &self,
        snapshot: &ReplicaSnapshot,
        vault_id: &str,
    ) -> Result<(), RuntimeError> {
        let unavailable = || {
            RuntimeError::new(
                RuntimeErrorCode::AuthorityMissing,
                "Current Vault key authority is unavailable",
            )
        };
        let generation = snapshot
            .bootstrap
            .active_generation
            .as_ref()
            .ok_or_else(unavailable)?;
        let vault = snapshot
            .bootstrap
            .vaults
            .get(&(generation.clone(), vault_id.to_owned()))
            .ok_or_else(unavailable)?;
        let material = self
            .copy_live_vault_key_material(&snapshot.account_id, &snapshot.incarnation)
            .ok_or_else(unavailable)?;
        let key = Zeroizing::new(
            super::vault_key::unwrap_vault_key(vault, &snapshot.user_id, &material)
                .map_err(|_| unavailable())?,
        );
        if key.len() != 32 {
            return Err(unavailable());
        }
        Ok(())
    }

    pub(super) fn require_vault_management_authority(
        &self,
        account_id: &AccountId,
        vault_id: &str,
        owner_only: bool,
    ) -> Result<ReplicaSnapshot, RuntimeError> {
        let snapshot = self.require_snapshot(account_id)?;
        self.require_vault_accepting_work(&snapshot, vault_id)?;
        if snapshot.failure.is_some() {
            return Err(RuntimeError::new(
                RuntimeErrorCode::AccountFailed,
                "Account module has failed",
            ));
        }
        if snapshot.bootstrap.state != crate::replica::ReplicaState::Ready {
            return Err(RuntimeError::new(
                RuntimeErrorCode::AuthorityMissing,
                "Vault mutation needs current Replica authority",
            ));
        }
        if self.account_access_retirement_is_pending(account_id)
            || self
                .lock_epoch_pending
                .lock()
                .expect("pending epoch lock poisoned")
                .contains_key(account_id)
            || self
                .account_access
                .lock()
                .expect("Account access lock poisoned")
                .get(account_id)
                != Some(&AccountAccessState::Unlocked)
            || self
                .copy_live_master_unlock_key(account_id, &snapshot.incarnation)
                .is_none()
        {
            return Err(RuntimeError::new(
                RuntimeErrorCode::AuthenticationRequired,
                "Vault mutation requires current unlocked authority",
            ));
        }
        let generation = snapshot
            .bootstrap
            .active_generation
            .as_ref()
            .ok_or_else(|| {
                RuntimeError::new(
                    RuntimeErrorCode::AuthorityMissing,
                    "Vault authority is unavailable",
                )
            })?;
        let vault = snapshot
            .bootstrap
            .vaults
            .get(&(generation.clone(), vault_id.to_owned()))
            .ok_or_else(|| {
                RuntimeError::new(RuntimeErrorCode::AccessDenied, "Vault is not visible")
            })?;
        if vault.role != AuthorityVaultRole::Owner
            && (owner_only || vault.role != AuthorityVaultRole::Admin)
        {
            return Err(RuntimeError::new(
                RuntimeErrorCode::AccessDenied,
                "Vault management is not permitted",
            ));
        }
        Ok(snapshot)
    }
}
