#![allow(
    dead_code,
    reason = "Ticket 53 proves cleanup behind a test-only gate before Ticket 54 composes production ports"
)]

use super::*;
use crate::replica::{GuardedCommitPlan, PlanMutation, PlanResult};
use async_trait::async_trait;

use super::create_vault_staging::{CreateVaultStagingBinding, CreateVaultStagingError};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum CreateVaultCleanupPass {
    Progressed,
    RetryScheduled,
    ReauthenticationRequired,
    Completed,
}

#[async_trait]
pub(crate) trait CreateVaultCleanupPort: Send + Sync {
    async fn cleanup_remote(
        &self,
        binding: &CreateVaultStagingBinding,
    ) -> Result<(), CreateVaultStagingError>;
    async fn renew_session(&self) -> Result<(), CreateVaultStagingError>;
}

impl Runtime {
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
            let Some(facade) = self
                .vault_image_ingress
                .lock()
                .expect("Vault image ingress lock poisoned")
                .clone()
            else {
                return Ok(CreateVaultCleanupPass::RetryScheduled);
            };
            if facade
                .delete_bound(account_id.clone(), operation_id.to_owned())
                .await
                .is_err()
            {
                return Ok(CreateVaultCleanupPass::RetryScheduled);
            }
            self.commit_cleanup(snapshot, operation_id, true, false)
                .await?;
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
            .execute(GuardedCommitPlan::new(
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
