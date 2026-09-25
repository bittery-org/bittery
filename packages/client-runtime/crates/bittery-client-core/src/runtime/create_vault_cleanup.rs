use super::*;
use crate::replica::{GuardedCommitPlan, PlanMutation, PlanResult};
use async_trait::async_trait;

use super::create_vault_staging::{
    CreateVaultPortThreading, CreateVaultStagingBinding, CreateVaultStagingError,
};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum CreateVaultCleanupPass {
    Progressed,
    RetryScheduled,
    ReauthenticationRequired,
    Completed,
}

#[cfg_attr(target_arch = "wasm32", async_trait(?Send))]
#[cfg_attr(not(target_arch = "wasm32"), async_trait)]
pub(crate) trait CreateVaultCleanupPort: CreateVaultPortThreading {
    async fn cleanup_remote(
        &self,
        binding: &CreateVaultStagingBinding,
    ) -> Result<(), CreateVaultStagingError>;
    async fn renew_session(&self) -> Result<(), CreateVaultStagingError>;
}

impl Runtime {
    pub(super) async fn protect_accepted_vault_images(
        &self,
        snapshot: &crate::replica::ReplicaSnapshot,
    ) -> Result<crate::replica::ReplicaSnapshot, RuntimeError> {
        let operations: Vec<_> = snapshot
            .operations
            .iter()
            .filter(|operation| {
                operation.vault_image().is_some_and(|image| {
                    image.protected_witness.is_none() || image.raw_cleanup_pending
                })
            })
            .map(|operation| operation.operation_id.clone())
            .collect();
        if operations.is_empty() {
            return Ok(snapshot.clone());
        }
        let mut current = self.image_protection_scope(snapshot)?;
        let facade = self
            .vault_image_ingress
            .lock()
            .expect("Vault image ingress lock poisoned")
            .clone()
            .ok_or_else(|| {
                RuntimeError::new(
                    RuntimeErrorCode::StorageUnavailable,
                    "Accepted Vault image protection is unavailable",
                )
            })?;
        for operation_id in operations {
            let operation = current
                .operations
                .iter()
                .find(|operation| operation.operation_id == operation_id)
                .ok_or_else(cleanup_cancelled)?
                .clone();
            let image = operation.vault_image().ok_or_else(cleanup_cancelled)?;
            let original = crate::vault_image::VaultImageArtifactMetadata::new(
                crate::vault_image::VaultImageArtifactScope::new(
                    current.account_id.clone(),
                    &operation_id,
                )?,
                operation.vault_id(),
                image.byte_length,
                &image.content_type,
                &image.sha256,
            )?;
            let witness = match &image.protected_witness {
                Some(witness) => witness.clone(),
                None => {
                    let device_key = self.require_image_device_key().await?;
                    self.image_protection_scope(&current)?;
                    let protected = facade
                        .protect_legacy_bound(
                            &original,
                            crate::vault_image::VaultImageProtection {
                                user_id: &current.user_id,
                                device_key: device_key.key_bytes.as_slice(),
                            },
                            &RequestCancellation::new(),
                        )
                        .await?;
                    let witness = protected
                        .protection()
                        .ok_or_else(cleanup_cancelled)?
                        .witness
                        .clone();
                    current = self
                        .commit_image_protection(
                            current,
                            PlanMutation::ProtectVaultImage {
                                operation_id: operation_id.clone(),
                                witness: witness.clone(),
                            },
                        )
                        .await?;
                    witness
                }
            };
            self.image_protection_scope(&current)?;
            facade
                .verify_protected_bound(
                    &original,
                    &witness,
                    &current.user_id,
                    &RequestCancellation::new(),
                )
                .await?;
            self.image_protection_scope(&current)?;
            facade.delete_raw_generation(&original).await?;
            current = self
                .commit_image_protection(
                    current,
                    PlanMutation::CompleteVaultImageRawCleanup {
                        operation_id,
                        witness,
                    },
                )
                .await?;
        }
        Ok(current)
    }

    fn image_protection_scope(
        &self,
        expected: &ReplicaSnapshot,
    ) -> Result<ReplicaSnapshot, RuntimeError> {
        let current = self.image_cleanup_scope(expected)?;
        if current.user_id != expected.user_id
            || current.revision != expected.revision
            || !self.completion_scope_is_current(expected)
        {
            return Err(cleanup_cancelled());
        }
        Ok(current)
    }

    async fn commit_image_protection(
        &self,
        snapshot: ReplicaSnapshot,
        mutation: PlanMutation,
    ) -> Result<ReplicaSnapshot, RuntimeError> {
        self.image_protection_scope(&snapshot)?;
        let result = self
            .replica
            .execute_exact(GuardedCommitPlan::new(
                snapshot.account_id.clone(),
                snapshot.incarnation.clone(),
                snapshot.revision,
                snapshot.lock_epoch,
                vec![mutation],
            ))
            .await;
        match result {
            Ok(PlanResult::Applied { .. }) => {
                let current = self.image_cleanup_scope(&snapshot)?;
                if current.user_id != snapshot.user_id {
                    return Err(cleanup_cancelled());
                }
                Ok(current)
            }
            Ok(_) => Err(cleanup_cancelled()),
            Err(error) => {
                // A store may commit and lose its acknowledgement. Reinstall only durable state
                // in the original Account/epoch so retry discovers its existing publication/duty.
                let durable = self
                    .replica
                    .load_uncached(&snapshot.account_id)
                    .await?
                    .ok_or_else(cleanup_cancelled)?;
                let _publication = self.publication.lock().expect("publication lock poisoned");
                self.image_protection_scope(&snapshot)?;
                if durable.incarnation != snapshot.incarnation
                    || durable.user_id != snapshot.user_id
                    || durable.lock_epoch != snapshot.lock_epoch
                    || durable.revision < snapshot.revision
                {
                    return Err(cleanup_cancelled());
                }
                self.replica.cache(durable);
                Err(error)
            }
        }
    }

    pub(super) async fn sweep_retired_vault_images(
        &self,
        snapshot: &crate::replica::ReplicaSnapshot,
        vault_ids: &[String],
    ) -> Result<(), RuntimeError> {
        // Called under the existing Account execution fence after selective foreground drain.
        // Unpublished images may belong to unrelated live ingress, so this is not an orphan sweep.
        let mut current = self.image_cleanup_scope(snapshot)?;
        if current.revision != snapshot.revision {
            return Err(cleanup_cancelled());
        }
        let operations: Vec<_> = snapshot
            .receipts
            .iter()
            .filter(|receipt| {
                receipt
                    .create_vault_cleanup
                    .as_ref()
                    .is_some_and(|cleanup| {
                        cleanup.local_artifact_pending
                            && receipt
                                .target
                                .vault_id_opt()
                                .is_some_and(|id| vault_ids.iter().any(|vault| vault == id))
                    })
            })
            .map(|receipt| receipt.operation_id.clone())
            .collect();
        for operation_id in operations {
            if !self
                .remove_local_image_and_acknowledge(current, &operation_id)
                .await?
            {
                return Err(RuntimeError::new(
                    RuntimeErrorCode::StorageUnavailable,
                    "Retired Vault image cleanup is incomplete",
                ));
            }
            current = self.image_cleanup_scope(snapshot)?;
        }
        Ok(())
    }

    fn image_cleanup_scope(
        &self,
        expected: &crate::replica::ReplicaSnapshot,
    ) -> Result<crate::replica::ReplicaSnapshot, RuntimeError> {
        if self.is_closed() {
            return Err(cleanup_cancelled());
        }
        self.replica
            .snapshot(&expected.account_id)
            .filter(|current| {
                current.incarnation == expected.incarnation
                    && current.lock_epoch == expected.lock_epoch
            })
            .ok_or_else(cleanup_cancelled)
    }

    /// A false result preserves the existing local duty for the owning driver's retry.
    async fn remove_local_image_and_acknowledge(
        &self,
        snapshot: crate::replica::ReplicaSnapshot,
        operation_id: &str,
    ) -> Result<bool, RuntimeError> {
        if self.image_cleanup_scope(&snapshot)?.revision != snapshot.revision {
            return Err(cleanup_cancelled());
        }
        let Some(facade) = self
            .vault_image_ingress
            .lock()
            .expect("Vault image ingress lock poisoned")
            .clone()
        else {
            return Ok(false);
        };
        if facade
            .delete_bound(snapshot.account_id.clone(), operation_id.to_owned())
            .await
            .is_err()
        {
            return Ok(false);
        }
        if self.image_cleanup_scope(&snapshot)?.revision != snapshot.revision {
            return Err(cleanup_cancelled());
        }
        self.commit_cleanup(snapshot.clone(), operation_id, true, false)
            .await?;
        self.image_cleanup_scope(&snapshot)?;
        Ok(true)
    }

    pub(crate) async fn drive_create_vault_cleanup_cycle(
        &self,
        account_id: &AccountId,
        operation_id: &str,
        port: &dyn CreateVaultCleanupPort,
    ) -> Result<CreateVaultCleanupPass, RuntimeError> {
        let execution_lock = self.account_execution_lock(account_id)?;
        let _guard = execution_lock.lock().await;
        let snapshot = self.replica.snapshot(account_id).ok_or_else(|| {
            RuntimeError::new(RuntimeErrorCode::AccountMissing, "account is not installed")
        })?;
        let receipt = snapshot
            .receipts
            .iter()
            .find(|receipt| receipt.operation_id == operation_id)
            .cloned()
            .ok_or_else(|| invalid("create-Vault cleanup receipt is missing"))?;
        let Some(cleanup) = receipt.create_vault_cleanup.clone() else {
            return Ok(CreateVaultCleanupPass::Completed);
        };

        if cleanup.local_artifact_pending {
            if !self
                .remove_local_image_and_acknowledge(snapshot, operation_id)
                .await?
            {
                return Ok(CreateVaultCleanupPass::RetryScheduled);
            }
            return Ok(CreateVaultCleanupPass::Progressed);
        }

        if cleanup.remote_staging_pending {
            let binding = CreateVaultStagingBinding {
                account_id: account_id.clone(),
                operation_id: operation_id.to_owned(),
                vault_id: receipt.vault_id().to_owned(),
                object_key: cleanup.image.object_key,
                byte_length: cleanup.image.byte_length,
                content_type: cleanup.image.content_type,
                sha256: cleanup.image.sha256,
            };
            let mut renewed = false;
            let cleanup_result = loop {
                match port.cleanup_remote(&binding).await {
                    Ok(()) => break Ok(()),
                    Err(CreateVaultStagingError::Retryable) => break Err(false),
                    Err(CreateVaultStagingError::Unauthorized) if !renewed => {
                        renewed = true;
                        if port.renew_session().await.is_err() {
                            break Err(true);
                        }
                    }
                    Err(CreateVaultStagingError::Unauthorized) => break Err(true),
                }
            };
            match cleanup_result {
                Ok(()) => {
                    self.commit_cleanup(snapshot, operation_id, false, true)
                        .await?;
                    return Ok(CreateVaultCleanupPass::Completed);
                }
                Err(false) => return Ok(CreateVaultCleanupPass::RetryScheduled),
                Err(true) => {
                    self.mark_reauthentication_required(account_id);
                    return Ok(CreateVaultCleanupPass::ReauthenticationRequired);
                }
            }
        }

        Ok(CreateVaultCleanupPass::Completed)
    }

    async fn commit_cleanup(
        &self,
        snapshot: crate::replica::ReplicaSnapshot,
        operation_id: &str,
        local_artifact_done: bool,
        remote_staging_done: bool,
    ) -> Result<(), RuntimeError> {
        let result = self
            .replica
            .execute_exact(GuardedCommitPlan::new(
                snapshot.account_id,
                snapshot.incarnation,
                snapshot.revision,
                snapshot.lock_epoch,
                vec![PlanMutation::CompleteCreateVaultCleanup {
                    operation_id: operation_id.to_owned(),
                    local_artifact_done,
                    remote_staging_done,
                }],
            ))
            .await?;
        if !matches!(result, PlanResult::Applied { .. }) {
            return Err(invalid("create-Vault cleanup checkpoint was fenced"));
        }
        Ok(())
    }
}

fn invalid(message: &str) -> RuntimeError {
    RuntimeError::new(RuntimeErrorCode::InvariantViolation, message)
}

fn cleanup_cancelled() -> RuntimeError {
    RuntimeError::new(
        RuntimeErrorCode::Cancelled,
        "Vault image cleanup scope retired",
    )
}

#[cfg(all(test, not(target_arch = "wasm32")))]
#[path = "create_vault_cleanup_tests.rs"]
mod tests;
