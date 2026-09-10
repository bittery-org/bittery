use super::*;
use crate::replica::{
    CreateVaultCheckpoint, CreateVaultImageRecord, OperationKind, OperationRecord, PlanMutation,
    PlanResult,
};
use async_trait::async_trait;

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct CreateVaultStagingBinding {
    pub account_id: AccountId,
    pub operation_id: String,
    pub vault_id: String,
    pub object_key: String,
    pub byte_length: u64,
    pub content_type: String,
    pub sha256: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum CreateVaultStagingStatus {
    Missing,
    AwaitingUpload,
    Confirmed,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct CreateVaultUploadGrant {
    pub object_key: String,
    pub byte_length: u64,
    pub content_type: String,
    pub sha256: String,
}

impl CreateVaultUploadGrant {
    pub(crate) fn exact(binding: &CreateVaultStagingBinding) -> Self {
        Self {
            object_key: binding.object_key.clone(),
            byte_length: binding.byte_length,
            content_type: binding.content_type.clone(),
            sha256: binding.sha256.clone(),
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum CreateVaultStagingError {
    Unauthorized,
    Retryable,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum CreateVaultStagingPass {
    Progressed,
    RetryScheduled,
    ReauthenticationRequired,
    DispatchReady,
}

#[derive(Debug)]
pub(crate) enum CreateVaultRecoveryError {
    ParkedFenced,
    Fatal(RuntimeError),
}

impl From<RuntimeError> for CreateVaultRecoveryError {
    fn from(error: RuntimeError) -> Self {
        Self::Fatal(error)
    }
}

impl CreateVaultRecoveryError {
    #[cfg(test)]
    pub(crate) fn into_runtime_error(self) -> RuntimeError {
        match self {
            Self::ParkedFenced => invalid("create-Vault recovery was fenced"),
            Self::Fatal(error) => error,
        }
    }
}

#[derive(Default)]
pub(super) struct SessionRenewalBudget {
    pub(super) renewed: bool,
}

#[cfg(not(target_arch = "wasm32"))]
pub(crate) trait CreateVaultPortThreading: Send + Sync {}
#[cfg(not(target_arch = "wasm32"))]
impl<T: Send + Sync + ?Sized> CreateVaultPortThreading for T {}

#[cfg(target_arch = "wasm32")]
pub(crate) trait CreateVaultPortThreading {}
#[cfg(target_arch = "wasm32")]
impl<T: ?Sized> CreateVaultPortThreading for T {}

#[cfg_attr(target_arch = "wasm32", async_trait(?Send))]
#[cfg_attr(not(target_arch = "wasm32"), async_trait)]
pub(crate) trait CreateVaultStagingPort: CreateVaultPortThreading {
    async fn status(
        &self,
        binding: &CreateVaultStagingBinding,
    ) -> Result<CreateVaultStagingStatus, CreateVaultStagingError>;
    async fn grant(
        &self,
        binding: &CreateVaultStagingBinding,
    ) -> Result<CreateVaultUploadGrant, CreateVaultStagingError>;
    async fn upload(
        &self,
        grant: &CreateVaultUploadGrant,
        bytes: &[u8],
    ) -> Result<(), CreateVaultStagingError>;
    async fn confirm(
        &self,
        binding: &CreateVaultStagingBinding,
    ) -> Result<CreateVaultStagingStatus, CreateVaultStagingError>;
    async fn renew_session(&self) -> Result<(), CreateVaultStagingError>;
}

impl Runtime {
    #[cfg(test)]
    pub(crate) async fn drive_create_vault_staging_cycle(
        &self,
        account_id: &AccountId,
        operation_id: &str,
        staging: &dyn CreateVaultStagingPort,
    ) -> Result<CreateVaultStagingPass, RuntimeError> {
        self.drive_create_vault_staging_cycle_with_budget(
            account_id,
            operation_id,
            staging,
            &mut SessionRenewalBudget::default(),
        )
        .await
        .map_err(CreateVaultRecoveryError::into_runtime_error)
    }

    pub(super) async fn drive_create_vault_staging_cycle_with_budget(
        &self,
        account_id: &AccountId,
        operation_id: &str,
        staging: &dyn CreateVaultStagingPort,
        renewal: &mut SessionRenewalBudget,
    ) -> Result<CreateVaultStagingPass, CreateVaultRecoveryError> {
        let execution_lock = self.account_execution_lock(account_id)?;
        let _guard = execution_lock.lock().await;
        let snapshot = self.replica.snapshot(account_id).ok_or_else(|| {
            RuntimeError::new(RuntimeErrorCode::AccountMissing, "account is not installed")
        })?;
        let operation = snapshot
            .operations
            .iter()
            .find(|operation| operation.operation_id == operation_id)
            .cloned()
            .ok_or_else(|| invalid("create-Vault Operation is missing"))?;
        if operation.kind != OperationKind::CreateVault {
            return Err(invalid("Operation is not create-Vault work").into());
        }
        let intent = operation
            .create_vault
            .as_ref()
            .ok_or_else(|| invalid("create-Vault intent is missing"))?;
        match intent.checkpoint {
            CreateVaultCheckpoint::ArtifactReady => {
                let image = intent
                    .image
                    .as_ref()
                    .ok_or_else(|| invalid("artifact checkpoint has no image"))?;
                let binding = staging_binding(&operation, intent.account_id.clone(), image);
                let status = match retry_once_after_renewal(staging, &mut renewal.renewed, || {
                    staging.status(&binding)
                })
                .await
                {
                    StagingExchange::Value(status) => status,
                    StagingExchange::Retryable => {
                        return self.schedule_create_vault_retry(snapshot, operation).await;
                    }
                    StagingExchange::ReauthenticationRequired => {
                        self.mark_reauthentication_required(account_id);
                        return Ok(CreateVaultStagingPass::ReauthenticationRequired);
                    }
                };
                if status != CreateVaultStagingStatus::Confirmed {
                    let grant =
                        match retry_once_after_renewal(staging, &mut renewal.renewed, || {
                            staging.grant(&binding)
                        })
                        .await
                        {
                            StagingExchange::Value(grant) => grant,
                            StagingExchange::Retryable => {
                                return self.schedule_create_vault_retry(snapshot, operation).await;
                            }
                            StagingExchange::ReauthenticationRequired => {
                                self.mark_reauthentication_required(account_id);
                                return Ok(CreateVaultStagingPass::ReauthenticationRequired);
                            }
                        };
                    if grant != CreateVaultUploadGrant::exact(&binding) {
                        return Err(
                            invalid("staging credential changed exact image authority").into()
                        );
                    }
                    let facade = self
                        .vault_image_ingress
                        .lock()
                        .expect("Vault image ingress lock poisoned")
                        .clone()
                        .ok_or_else(|| invalid("Vault image ingress is unavailable"))?;
                    let bytes = facade
                        .read_published_bound(
                            binding.account_id.clone(),
                            binding.operation_id.clone(),
                            binding.vault_id.clone(),
                            binding.byte_length,
                            binding.content_type.clone(),
                            binding.sha256.clone(),
                        )
                        .await?;
                    match retry_once_after_renewal(staging, &mut renewal.renewed, || {
                        staging.upload(&grant, &bytes)
                    })
                    .await
                    {
                        StagingExchange::Value(()) => {}
                        StagingExchange::Retryable => {
                            return self.schedule_create_vault_retry(snapshot, operation).await;
                        }
                        StagingExchange::ReauthenticationRequired => {
                            self.mark_reauthentication_required(account_id);
                            return Ok(CreateVaultStagingPass::ReauthenticationRequired);
                        }
                    }
                    match retry_once_after_renewal(staging, &mut renewal.renewed, || {
                        staging.confirm(&binding)
                    })
                    .await
                    {
                        StagingExchange::Value(CreateVaultStagingStatus::Confirmed) => {}
                        StagingExchange::Value(_) | StagingExchange::Retryable => {
                            return self.schedule_create_vault_retry(snapshot, operation).await;
                        }
                        StagingExchange::ReauthenticationRequired => {
                            self.mark_reauthentication_required(account_id);
                            return Ok(CreateVaultStagingPass::ReauthenticationRequired);
                        }
                    }
                }
                let mut next = operation;
                next.create_vault.as_mut().unwrap().checkpoint =
                    CreateVaultCheckpoint::RemoteUploadConfirmed;
                self.commit_create_vault_checkpoint(snapshot, next).await?;
                Ok(CreateVaultStagingPass::Progressed)
            }
            CreateVaultCheckpoint::RemoteUploadConfirmed => {
                let mut next = operation;
                next.create_vault.as_mut().unwrap().checkpoint =
                    CreateVaultCheckpoint::FinalRequestFrozen;
                let (request, fingerprint) = super::create_vault::create_vault_http_request(
                    next.vault_id(),
                    next.create_vault.as_ref().unwrap(),
                )?;
                if fingerprint != next.request_fingerprint {
                    return Err(
                        invalid("accepted create-Vault fingerprint changed before freeze").into(),
                    );
                }
                next.request = request;
                self.commit_create_vault_checkpoint(snapshot, next).await?;
                self.wake_dispatch();
                Ok(CreateVaultStagingPass::DispatchReady)
            }
            CreateVaultCheckpoint::FinalRequestFrozen => Ok(CreateVaultStagingPass::DispatchReady),
        }
    }

    pub(super) async fn schedule_create_vault_retry(
        &self,
        snapshot: ReplicaSnapshot,
        mut operation: OperationRecord,
    ) -> Result<CreateVaultStagingPass, CreateVaultRecoveryError> {
        operation.scheduling.attempt_count = operation.scheduling.attempt_count.saturating_add(1);
        operation.scheduling.not_before_ms = self
            .clock
            .now_ms()?
            .saturating_add(100_u64 << operation.scheduling.attempt_count.min(10));
        let result = self
            .replica
            .execute(GuardedCommitPlan::new(
                snapshot.account_id,
                snapshot.incarnation,
                snapshot.revision,
                snapshot.lock_epoch,
                vec![PlanMutation::RescheduleOperation(operation)],
            ))
            .await?;
        if !matches!(result, PlanResult::Applied { .. }) {
            return Err(CreateVaultRecoveryError::ParkedFenced);
        }
        Ok(CreateVaultStagingPass::RetryScheduled)
    }

    async fn commit_create_vault_checkpoint(
        &self,
        snapshot: ReplicaSnapshot,
        operation: OperationRecord,
    ) -> Result<(), CreateVaultRecoveryError> {
        let result = self
            .replica
            .execute(GuardedCommitPlan::new(
                snapshot.account_id,
                snapshot.incarnation,
                snapshot.revision,
                snapshot.lock_epoch,
                vec![PlanMutation::CheckpointCreateVault(operation)],
            ))
            .await?;
        if !matches!(result, PlanResult::Applied { .. }) {
            return Err(CreateVaultRecoveryError::ParkedFenced);
        }
        self.device_revision.fetch_add(1, Ordering::SeqCst);
        self.publish_all();
        Ok(())
    }
}

fn staging_binding(
    operation: &OperationRecord,
    account_id: AccountId,
    image: &CreateVaultImageRecord,
) -> CreateVaultStagingBinding {
    CreateVaultStagingBinding {
        account_id,
        operation_id: operation.operation_id.clone(),
        vault_id: operation.vault_id().to_owned(),
        object_key: image.object_key.clone(),
        byte_length: image.byte_length,
        content_type: image.content_type.clone(),
        sha256: image.sha256.clone(),
    }
}

fn invalid(message: &str) -> RuntimeError {
    RuntimeError::new(RuntimeErrorCode::InvariantViolation, message)
}

enum StagingExchange<T> {
    Value(T),
    Retryable,
    ReauthenticationRequired,
}

async fn retry_once_after_renewal<T, F, Fut>(
    staging: &dyn CreateVaultStagingPort,
    renewed: &mut bool,
    mut exchange: F,
) -> StagingExchange<T>
where
    F: FnMut() -> Fut,
    Fut: std::future::Future<Output = Result<T, CreateVaultStagingError>>,
{
    match exchange().await {
        Ok(value) => StagingExchange::Value(value),
        Err(CreateVaultStagingError::Retryable) => StagingExchange::Retryable,
        Err(CreateVaultStagingError::Unauthorized) if !*renewed => {
            *renewed = true;
            match staging.renew_session().await {
                Ok(()) => match exchange().await {
                    Ok(value) => StagingExchange::Value(value),
                    Err(CreateVaultStagingError::Retryable) => StagingExchange::Retryable,
                    Err(CreateVaultStagingError::Unauthorized) => {
                        StagingExchange::ReauthenticationRequired
                    }
                },
                Err(_) => StagingExchange::ReauthenticationRequired,
            }
        }
        Err(CreateVaultStagingError::Unauthorized) => StagingExchange::ReauthenticationRequired,
    }
}
