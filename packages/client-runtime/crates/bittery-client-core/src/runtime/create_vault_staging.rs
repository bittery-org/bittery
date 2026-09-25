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
        cancellation: RequestCancellation,
    ) -> Result<(), CreateVaultStagingError>;
    async fn confirm(
        &self,
        binding: &CreateVaultStagingBinding,
    ) -> Result<CreateVaultStagingStatus, CreateVaultStagingError>;
    async fn renew_session(&self) -> Result<(), CreateVaultRecoveryError>;
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
            &self.require_snapshot(account_id)?,
            operation_id,
            staging,
            &mut SessionRenewalBudget::default(),
        )
        .await
        .map_err(CreateVaultRecoveryError::into_runtime_error)
    }

    pub(super) async fn drive_create_vault_staging_cycle_with_budget(
        &self,
        expected: &ReplicaSnapshot,
        operation_id: &str,
        staging: &dyn CreateVaultStagingPort,
        renewal: &mut SessionRenewalBudget,
    ) -> Result<CreateVaultStagingPass, CreateVaultRecoveryError> {
        let account_id = &expected.account_id;
        let execution_lock = self.account_execution_lock(account_id)?;
        let _guard = execution_lock.lock().await;
        let snapshot = self.require_create_vault_attempt_snapshot(expected, operation_id)?;
        let snapshot = self.protect_accepted_vault_images(&snapshot).await?;
        let operation = snapshot
            .operations
            .iter()
            .find(|operation| operation.operation_id == operation_id)
            .cloned()
            .ok_or(CreateVaultRecoveryError::ParkedFenced)?;
        drop(_guard);
        let result = self
            .stage_create_vault_snapshot(snapshot.clone(), operation.clone(), staging, renewal)
            .await;
        match result {
            Err(CreateVaultRecoveryError::Fatal(error))
                if error.code == RuntimeErrorCode::InvariantViolation =>
            {
                let _guard = execution_lock.lock().await;
                self.require_staging_source(&snapshot, &operation)?;
                self.fail_create_vault_scope(snapshot, operation, &error.message)
                    .await
            }
            other => other,
        }
    }

    /// Each phase may advance Replica revision, but its transport must keep the same Account
    /// incarnation, User, lock epoch and accepted action throughout the entire attempt.
    pub(super) fn require_create_vault_attempt_snapshot(
        &self,
        expected: &ReplicaSnapshot,
        operation_id: &str,
    ) -> Result<ReplicaSnapshot, CreateVaultRecoveryError> {
        let current = self.require_snapshot(&expected.account_id)?;
        let original = expected
            .operations
            .iter()
            .find(|operation| operation.operation_id == operation_id);
        let actual = current
            .operations
            .iter()
            .find(|operation| operation.operation_id == operation_id);
        if current.incarnation != expected.incarnation
            || current.user_id != expected.user_id
            || current.lock_epoch != expected.lock_epoch
            || !self.completion_scope_is_current(&current)
            || !matches!((original, actual), (Some(original), Some(actual))
                if original.kind == actual.kind && original.target == actual.target && original.request_fingerprint == actual.request_fingerprint)
        {
            return Err(CreateVaultRecoveryError::ParkedFenced);
        }
        Ok(current)
    }

    async fn stage_create_vault_snapshot(
        &self,
        snapshot: ReplicaSnapshot,
        operation: OperationRecord,
        staging: &dyn CreateVaultStagingPort,
        renewal: &mut SessionRenewalBudget,
    ) -> Result<CreateVaultStagingPass, CreateVaultRecoveryError> {
        let account_id = &snapshot.account_id;
        if !matches!(
            operation.kind,
            OperationKind::CreateVault | OperationKind::UpdateVault
        ) {
            return Err(invalid("Operation is not create-Vault work").into());
        }
        let checkpoint = operation
            .vault_image_checkpoint()
            .ok_or_else(|| invalid("Vault image staging intent is missing"))?;
        match checkpoint {
            CreateVaultCheckpoint::ArtifactReady => {
                let image = operation
                    .vault_image()
                    .ok_or_else(|| invalid("artifact checkpoint has no image"))?;
                let binding = staging_binding(&operation, account_id.clone(), image);
                let status = match retry_once_after_renewal(
                    self,
                    &snapshot,
                    &operation,
                    staging,
                    &mut renewal.renewed,
                    || staging.status(&binding),
                )
                .await?
                {
                    StagingExchange::Value(status) => status,
                    StagingExchange::Retryable => {
                        return self.schedule_staging_retry(snapshot, operation).await;
                    }
                    StagingExchange::ReauthenticationRequired => {
                        self.mark_reauthentication_required(account_id);
                        return Ok(CreateVaultStagingPass::ReauthenticationRequired);
                    }
                };
                if status != CreateVaultStagingStatus::Confirmed {
                    let grant = match retry_once_after_renewal(
                        self,
                        &snapshot,
                        &operation,
                        staging,
                        &mut renewal.renewed,
                        || staging.grant(&binding),
                    )
                    .await?
                    {
                        StagingExchange::Value(grant) => grant,
                        StagingExchange::Retryable => {
                            return self.schedule_staging_retry(snapshot, operation).await;
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
                    self.require_vault_image_read_authority(&snapshot, &operation)?;
                    let cancellation = RequestCancellation::new();
                    let _loan = self.foreground_attachments.register_target(
                        account_id, &snapshot.incarnation,
                        super::foreground_attachment_lifecycle::ForegroundAttachmentTarget::VaultImage {
                            vault_id: operation.vault_id().to_owned(), operation_id: operation.operation_id.clone(),
                        }, cancellation.clone(),
                    ).map_err(|_| CreateVaultRecoveryError::ParkedFenced)?;
                    let device_key = self.require_image_device_key().await?;
                    self.require_vault_image_read_authority(&snapshot, &operation)?;
                    let original = crate::vault_image::VaultImageArtifactMetadata::new(
                        crate::vault_image::VaultImageArtifactScope::new(
                            binding.account_id.clone(),
                            &binding.operation_id,
                        )?,
                        &binding.vault_id,
                        binding.byte_length,
                        &binding.content_type,
                        &binding.sha256,
                    )?;
                    let witness = image
                        .protected_witness
                        .as_ref()
                        .ok_or_else(|| invalid("Accepted image protection is incomplete"))?;
                    let bytes = facade
                        .read_protected_bound(
                            &original,
                            witness,
                            crate::vault_image::VaultImageProtection {
                                user_id: &snapshot.user_id,
                                device_key: device_key.key_bytes.as_slice(),
                            },
                            &cancellation,
                        )
                        .await?;
                    self.require_vault_image_read_authority(&snapshot, &operation)?;
                    match retry_once_after_renewal(
                        self,
                        &snapshot,
                        &operation,
                        staging,
                        &mut renewal.renewed,
                        || async {
                            if cancellation.is_cancelled()
                                || self
                                    .require_vault_image_read_authority(&snapshot, &operation)
                                    .is_err()
                            {
                                return Err(CreateVaultStagingError::Retryable);
                            }
                            staging.upload(&grant, &bytes, cancellation.clone()).await
                        },
                    )
                    .await?
                    {
                        StagingExchange::Value(()) => {}
                        StagingExchange::Retryable => {
                            if cancellation.is_cancelled() {
                                return Err(CreateVaultRecoveryError::ParkedFenced);
                            }
                            return self.schedule_staging_retry(snapshot, operation).await;
                        }
                        StagingExchange::ReauthenticationRequired => {
                            self.mark_reauthentication_required(account_id);
                            return Ok(CreateVaultStagingPass::ReauthenticationRequired);
                        }
                    }
                    drop(bytes);
                    drop(device_key);
                    drop(_loan);
                    match retry_once_after_renewal(
                        self,
                        &snapshot,
                        &operation,
                        staging,
                        &mut renewal.renewed,
                        || staging.confirm(&binding),
                    )
                    .await?
                    {
                        StagingExchange::Value(CreateVaultStagingStatus::Confirmed) => {}
                        StagingExchange::Value(_) | StagingExchange::Retryable => {
                            return self.schedule_staging_retry(snapshot, operation).await;
                        }
                        StagingExchange::ReauthenticationRequired => {
                            self.mark_reauthentication_required(account_id);
                            return Ok(CreateVaultStagingPass::ReauthenticationRequired);
                        }
                    }
                }
                let mut next = operation;
                next.set_vault_image_checkpoint(CreateVaultCheckpoint::RemoteUploadConfirmed);
                self.commit_create_vault_checkpoint(
                    snapshot,
                    next,
                    CreateVaultStagingPass::Progressed,
                )
                .await
            }
            CreateVaultCheckpoint::RemoteUploadConfirmed => {
                let mut next = operation;
                next.set_vault_image_checkpoint(CreateVaultCheckpoint::FinalRequestFrozen);
                let (request, fingerprint) = match (&next.create_vault, &next.update_vault) {
                    (Some(intent), None) => {
                        super::create_vault::create_vault_http_request(next.vault_id(), intent)?
                    }
                    (None, Some(intent)) => crate::replica::canonical_vault_image_update_request(
                        next.vault_id(),
                        intent,
                    )?,
                    _ => return Err(invalid("Vault image staging intent is ambiguous").into()),
                };
                if fingerprint != next.request_fingerprint {
                    return Err(
                        invalid("accepted create-Vault fingerprint changed before freeze").into(),
                    );
                }
                next.request = request;
                self.commit_create_vault_checkpoint(
                    snapshot,
                    next,
                    CreateVaultStagingPass::DispatchReady,
                )
                .await
            }
            CreateVaultCheckpoint::FinalRequestFrozen => Ok(CreateVaultStagingPass::DispatchReady),
        }
    }

    fn require_vault_image_read_authority(
        &self,
        snapshot: &ReplicaSnapshot,
        operation: &OperationRecord,
    ) -> Result<(), CreateVaultRecoveryError> {
        self.require_staging_source(snapshot, operation)?;
        if self
            .account_access
            .lock()
            .expect("Account access lock poisoned")
            .get(&snapshot.account_id)
            != Some(&AccountAccessState::Unlocked)
            || self
                .copy_live_master_unlock_key(&snapshot.account_id, &snapshot.incarnation)
                .is_none()
            || self
                .require_vault_accepting_work(snapshot, operation.vault_id())
                .is_err()
        {
            return Err(CreateVaultRecoveryError::ParkedFenced);
        }
        if operation.kind == OperationKind::UpdateVault {
            self.require_vault_management_authority(
                &snapshot.account_id,
                operation.vault_id(),
                false,
            )
            .map_err(|_| CreateVaultRecoveryError::ParkedFenced)?;
            self.require_vault_image_key_authority(snapshot, operation.vault_id())
                .map_err(|_| CreateVaultRecoveryError::ParkedFenced)?;
        }
        Ok(())
    }

    fn require_staging_source(
        &self,
        snapshot: &ReplicaSnapshot,
        operation: &OperationRecord,
    ) -> Result<(), CreateVaultRecoveryError> {
        let current =
            self.require_create_vault_attempt_snapshot(snapshot, &operation.operation_id)?;
        if current.revision != snapshot.revision {
            return Err(CreateVaultRecoveryError::ParkedFenced);
        }
        Ok(())
    }

    async fn schedule_staging_retry(
        &self,
        snapshot: ReplicaSnapshot,
        operation: OperationRecord,
    ) -> Result<CreateVaultStagingPass, CreateVaultRecoveryError> {
        let execution = self.account_execution_lock(&snapshot.account_id)?;
        let _guard = execution.lock().await;
        self.require_staging_source(&snapshot, &operation)?;
        self.schedule_create_vault_retry(snapshot, operation).await
    }

    pub(super) async fn fail_create_vault_scope(
        &self,
        snapshot: ReplicaSnapshot,
        operation: OperationRecord,
        message: &str,
    ) -> Result<CreateVaultStagingPass, CreateVaultRecoveryError> {
        if matches!(
            self.fail_account_module_at_snapshot(&snapshot).await,
            super::outcome::CompletionResult::Failed
        ) {
            return Err(RuntimeError::new(RuntimeErrorCode::AccountFailed, message).into());
        }
        if self.completion_scope_is_current(&snapshot) {
            self.schedule_create_vault_retry(snapshot, operation).await
        } else {
            Err(CreateVaultRecoveryError::ParkedFenced)
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
            .execute_exact(GuardedCommitPlan::new(
                snapshot.account_id,
                snapshot.incarnation,
                snapshot.revision,
                snapshot.lock_epoch,
                vec![PlanMutation::RescheduleOperation(operation)],
            ))
            .await
            .map_err(|_| storage_retry())?;
        if !matches!(result, PlanResult::Applied { .. }) {
            return Err(CreateVaultRecoveryError::ParkedFenced);
        }
        Ok(CreateVaultStagingPass::RetryScheduled)
    }

    async fn commit_create_vault_checkpoint(
        &self,
        snapshot: ReplicaSnapshot,
        operation: OperationRecord,
        committed: CreateVaultStagingPass,
    ) -> Result<CreateVaultStagingPass, CreateVaultRecoveryError> {
        let execution = self.account_execution_lock(&snapshot.account_id)?;
        let _guard = execution.lock().await;
        self.require_staging_source(&snapshot, &operation)?;
        let result = self
            .replica
            .execute_exact(GuardedCommitPlan::new(
                snapshot.account_id.clone(),
                snapshot.incarnation.clone(),
                snapshot.revision,
                snapshot.lock_epoch,
                vec![PlanMutation::CheckpointCreateVault(operation.clone())],
            ))
            .await;
        match result {
            Ok(PlanResult::Applied { .. }) => {
                self.device_revision.fetch_add(1, Ordering::SeqCst);
                self.publish_all_unless_closed();
                self.wake_dispatch();
                Ok(committed)
            }
            Ok(_) => Err(CreateVaultRecoveryError::ParkedFenced),
            Err(_) => {
                self.retry_create_vault_checkpoint(&snapshot, &operation)
                    .await
            }
        }
    }

    /// A physical commit can succeed and lose its reply. Reload before rescheduling so the
    /// accepted checkpoint/body that actually committed is preserved, never reconstructed backwards.
    async fn retry_create_vault_checkpoint(
        &self,
        captured: &ReplicaSnapshot,
        attempted: &OperationRecord,
    ) -> Result<CreateVaultStagingPass, CreateVaultRecoveryError> {
        let current = self
            .replica
            .load_uncached(&captured.account_id)
            .await
            .map_err(|_| storage_retry())?
            .ok_or(CreateVaultRecoveryError::ParkedFenced)?;
        let operation = current
            .operations
            .iter()
            .find(|operation| operation.operation_id == attempted.operation_id)
            .cloned()
            .ok_or(CreateVaultRecoveryError::ParkedFenced)?;
        {
            let _publication = self.publication.lock().expect("publication lock poisoned");
            if !self.completion_scope_is_current(captured)
                || current.incarnation != captured.incarnation
                || current.user_id != captured.user_id
                || current.lock_epoch != captured.lock_epoch
                || current.revision < captured.revision
                || operation.request_fingerprint != attempted.request_fingerprint
            {
                return Err(CreateVaultRecoveryError::ParkedFenced);
            }
            self.replica.cache(current.clone());
        }
        self.schedule_create_vault_retry(current, operation).await
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

fn storage_retry() -> CreateVaultRecoveryError {
    RuntimeError::new(
        RuntimeErrorCode::StorageUnavailable,
        "Vault image checkpoint storage is unavailable",
    )
    .into()
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
    runtime: &Runtime,
    snapshot: &ReplicaSnapshot,
    operation: &OperationRecord,
    staging: &dyn CreateVaultStagingPort,
    renewed: &mut bool,
    mut exchange: F,
) -> Result<StagingExchange<T>, CreateVaultRecoveryError>
where
    F: FnMut() -> Fut,
    Fut: std::future::Future<Output = Result<T, CreateVaultStagingError>>,
{
    runtime.require_staging_source(snapshot, operation)?;
    let response = exchange().await;
    runtime.require_staging_source(snapshot, operation)?;
    Ok(match response {
        Ok(value) => StagingExchange::Value(value),
        Err(CreateVaultStagingError::Retryable) => StagingExchange::Retryable,
        Err(CreateVaultStagingError::Unauthorized) if !*renewed => {
            *renewed = true;
            let renewal = staging.renew_session().await;
            runtime.require_staging_source(snapshot, operation)?;
            match renewal {
                Ok(()) => {
                    let response = exchange().await;
                    runtime.require_staging_source(snapshot, operation)?;
                    match response {
                        Ok(value) => StagingExchange::Value(value),
                        Err(CreateVaultStagingError::Retryable) => StagingExchange::Retryable,
                        Err(CreateVaultStagingError::Unauthorized) => {
                            StagingExchange::ReauthenticationRequired
                        }
                    }
                }
                Err(CreateVaultRecoveryError::ParkedFenced) => {
                    return Err(CreateVaultRecoveryError::ParkedFenced);
                }
                Err(CreateVaultRecoveryError::Fatal(_)) => {
                    StagingExchange::ReauthenticationRequired
                }
            }
        }
        Err(CreateVaultStagingError::Unauthorized) => StagingExchange::ReauthenticationRequired,
    })
}

#[cfg(test)]
#[path = "create_vault_staging_failure_tests.rs"]
mod failure_tests;

#[cfg(all(test, not(target_arch = "wasm32")))]
#[path = "create_vault_protected_lifecycle_tests.rs"]
mod protected_lifecycle_tests;
