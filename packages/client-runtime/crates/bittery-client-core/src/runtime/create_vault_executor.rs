use super::*;
use crate::replica::{
    CreateVaultCheckpoint, ObservedOutcome, OperationKind, OperationOutcomeResult, OperationRecord,
    PlanMutation,
};
use async_trait::async_trait;

use super::{
    create_vault_staging::{
        CreateVaultPortThreading, CreateVaultRecoveryError, CreateVaultStagingError,
        CreateVaultStagingPass, CreateVaultStagingPort, SessionRenewalBudget,
    },
    outcome::SemanticAnswer,
};

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct CreateVaultOperationResponse {
    pub status: u16,
    pub body: Vec<u8>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum CreateVaultExecutorPass {
    RetryScheduled,
    ReauthenticationRequired,
    Completed,
}

#[cfg_attr(target_arch = "wasm32", async_trait(?Send))]
#[cfg_attr(not(target_arch = "wasm32"), async_trait)]
pub(crate) trait CreateVaultExecutorPort: CreateVaultPortThreading {
    async fn lookup(
        &self,
        operation: &OperationRecord,
    ) -> Result<Option<CreateVaultOperationResponse>, CreateVaultStagingError>;
    async fn put_exact(
        &self,
        operation: &OperationRecord,
    ) -> Result<CreateVaultOperationResponse, CreateVaultStagingError>;
    async fn renew_session(&self) -> Result<(), CreateVaultStagingError>;
    async fn before_reconcile(&self, _operation: &OperationRecord) {}
}

impl Runtime {
    #[cfg(test)]
    pub(crate) async fn drive_create_vault_executor_cycle(
        &self,
        account_id: &AccountId,
        operation_id: &str,
        port: &dyn CreateVaultExecutorPort,
    ) -> Result<CreateVaultExecutorPass, RuntimeError> {
        self.drive_create_vault_executor_cycle_with_budget(
            &self.require_snapshot(account_id)?,
            operation_id,
            port,
            &mut SessionRenewalBudget::default(),
        )
        .await
        .map_err(CreateVaultRecoveryError::into_runtime_error)
    }

    #[cfg(test)]
    pub(crate) async fn drive_create_vault_recovery_cycle(
        &self,
        account_id: &AccountId,
        operation_id: &str,
        staging: &dyn CreateVaultStagingPort,
        port: &dyn CreateVaultExecutorPort,
    ) -> Result<CreateVaultExecutorPass, CreateVaultRecoveryError> {
        self.drive_create_vault_recovery_at_snapshot(
            &self.require_snapshot(account_id)?,
            operation_id,
            staging,
            port,
        )
        .await
    }

    pub(super) async fn drive_create_vault_recovery_at_snapshot(
        &self,
        expected: &ReplicaSnapshot,
        operation_id: &str,
        staging: &dyn CreateVaultStagingPort,
        port: &dyn CreateVaultExecutorPort,
    ) -> Result<CreateVaultExecutorPass, CreateVaultRecoveryError> {
        let mut renewal = SessionRenewalBudget::default();
        loop {
            match self
                .drive_create_vault_staging_cycle_with_budget(
                    expected,
                    operation_id,
                    staging,
                    &mut renewal,
                )
                .await?
            {
                CreateVaultStagingPass::Progressed => continue,
                CreateVaultStagingPass::RetryScheduled => {
                    return Ok(CreateVaultExecutorPass::RetryScheduled);
                }
                CreateVaultStagingPass::ReauthenticationRequired => {
                    return Ok(CreateVaultExecutorPass::ReauthenticationRequired);
                }
                CreateVaultStagingPass::DispatchReady => break,
            }
        }
        self.drive_create_vault_executor_cycle_with_budget(
            expected,
            operation_id,
            port,
            &mut renewal,
        )
        .await
    }

    async fn drive_create_vault_executor_cycle_with_budget(
        &self,
        expected: &ReplicaSnapshot,
        operation_id: &str,
        port: &dyn CreateVaultExecutorPort,
        renewal: &mut SessionRenewalBudget,
    ) -> Result<CreateVaultExecutorPass, CreateVaultRecoveryError> {
        let account_id = &expected.account_id;
        let execution_lock = self.account_execution_lock(account_id)?;
        let _guard = execution_lock.lock().await;
        let snapshot = self.require_create_vault_attempt_snapshot(expected, operation_id)?;
        let operation = snapshot
            .operations
            .iter()
            .find(|operation| operation.operation_id == operation_id)
            .cloned()
            .ok_or_else(|| invalid("create-Vault Operation is missing"))?;
        if operation.kind != OperationKind::CreateVault
            || operation
                .create_vault
                .as_ref()
                .is_none_or(|intent| intent.checkpoint != CreateVaultCheckpoint::FinalRequestFrozen)
        {
            return Err(invalid("create-Vault Operation is not dispatch-ready").into());
        }
        if !self
            .release_vault_image_acceptance_for_dispatch(account_id, &operation)
            .await
        {
            return self.schedule_executor_retry(snapshot, operation).await;
        }

        let hint =
            match retry_once_after_renewal(port, &mut renewal.renewed, || port.lookup(&operation))
                .await
            {
                Exchange::Value(value) => value,
                Exchange::Retryable => {
                    return self.schedule_executor_retry(snapshot, operation).await;
                }
                Exchange::ReauthenticationRequired => {
                    self.mark_reauthentication_required(account_id);
                    return Ok(CreateVaultExecutorPass::ReauthenticationRequired);
                }
            };
        // A lookup is only a recovery hint. Exact PUT replay is the one exchange that proves the
        // retained answer belongs to these immutable bytes.
        let replay = match retry_once_after_renewal(port, &mut renewal.renewed, || {
            port.put_exact(&operation)
        })
        .await
        {
            Exchange::Value(value) => value,
            Exchange::Retryable => return self.schedule_executor_retry(snapshot, operation).await,
            Exchange::ReauthenticationRequired => {
                self.mark_reauthentication_required(account_id);
                return Ok(CreateVaultExecutorPass::ReauthenticationRequired);
            }
        };
        let observed = match self.read_create_vault_response(&operation, &replay) {
            ValidatedCreateVaultAnswer::Outcome(outcome) => outcome,
            ValidatedCreateVaultAnswer::Transient => {
                return self.schedule_executor_retry(snapshot, operation).await;
            }
            ValidatedCreateVaultAnswer::IdentityReused => {
                return self
                    .fail_create_vault_reply(
                        snapshot,
                        operation,
                        "create-Vault replay reused an Operation identity",
                    )
                    .await;
            }
        };
        if let Some(hint) = &hint {
            match self.read_create_vault_response(&operation, hint) {
                ValidatedCreateVaultAnswer::Outcome(hint) if hint == observed => {}
                ValidatedCreateVaultAnswer::Transient => {}
                ValidatedCreateVaultAnswer::Outcome(_)
                | ValidatedCreateVaultAnswer::IdentityReused => {
                    return self
                        .fail_create_vault_reply(
                            snapshot,
                            operation,
                            "create-Vault lookup contradicted the exact replay",
                        )
                        .await;
                }
            }
        }

        port.before_reconcile(&operation).await;
        match self
            .commit_completion_fenced(
                account_id,
                &snapshot,
                PlanMutation::ReconcileRetainedResult { outcome: observed },
            )
            .await
        {
            super::outcome::CompletionResult::Completed => Ok(CreateVaultExecutorPass::Completed),
            _ if self.completion_scope_is_current(&snapshot) => {
                self.schedule_executor_retry(snapshot, operation).await
            }
            _ => Err(CreateVaultRecoveryError::ParkedFenced),
        }
    }

    async fn fail_create_vault_reply(
        &self,
        snapshot: crate::replica::ReplicaSnapshot,
        operation: OperationRecord,
        message: &str,
    ) -> Result<CreateVaultExecutorPass, CreateVaultRecoveryError> {
        self.fail_create_vault_scope(snapshot, operation, message)
            .await?;
        Ok(CreateVaultExecutorPass::RetryScheduled)
    }

    async fn schedule_executor_retry(
        &self,
        snapshot: crate::replica::ReplicaSnapshot,
        operation: OperationRecord,
    ) -> Result<CreateVaultExecutorPass, CreateVaultRecoveryError> {
        self.schedule_create_vault_retry(snapshot, operation)
            .await?;
        Ok(CreateVaultExecutorPass::RetryScheduled)
    }

    fn read_create_vault_response(
        &self,
        operation: &OperationRecord,
        response: &CreateVaultOperationResponse,
    ) -> ValidatedCreateVaultAnswer {
        match self.read_dispatch_answer(operation, response.status, &response.body) {
            SemanticAnswer::Outcome(outcome)
                if matches!(
                    outcome.result,
                    OperationOutcomeResult::VaultApplied { .. }
                        | OperationOutcomeResult::VaultRejected { .. }
                ) =>
            {
                ValidatedCreateVaultAnswer::Outcome(outcome)
            }
            SemanticAnswer::IdentityReused => ValidatedCreateVaultAnswer::IdentityReused,
            SemanticAnswer::Outcome(_)
            | SemanticAnswer::Undecided
            | SemanticAnswer::Transient
            | SemanticAnswer::ReauthenticationRequired => ValidatedCreateVaultAnswer::Transient,
        }
    }
}

enum ValidatedCreateVaultAnswer {
    Outcome(ObservedOutcome),
    Transient,
    IdentityReused,
}

enum Exchange<T> {
    Value(T),
    Retryable,
    ReauthenticationRequired,
}

async fn retry_once_after_renewal<T, F, Fut>(
    port: &dyn CreateVaultExecutorPort,
    renewed: &mut bool,
    mut exchange: F,
) -> Exchange<T>
where
    F: FnMut() -> Fut,
    Fut: std::future::Future<Output = Result<T, CreateVaultStagingError>>,
{
    match exchange().await {
        Ok(value) => Exchange::Value(value),
        Err(CreateVaultStagingError::Retryable) => Exchange::Retryable,
        Err(CreateVaultStagingError::Unauthorized) if !*renewed => {
            *renewed = true;
            match port.renew_session().await {
                Ok(()) => match exchange().await {
                    Ok(value) => Exchange::Value(value),
                    Err(CreateVaultStagingError::Retryable) => Exchange::Retryable,
                    Err(CreateVaultStagingError::Unauthorized) => {
                        Exchange::ReauthenticationRequired
                    }
                },
                Err(_) => Exchange::ReauthenticationRequired,
            }
        }
        Err(CreateVaultStagingError::Unauthorized) => Exchange::ReauthenticationRequired,
    }
}

fn invalid(message: &str) -> RuntimeError {
    RuntimeError::new(RuntimeErrorCode::InvariantViolation, message)
}
