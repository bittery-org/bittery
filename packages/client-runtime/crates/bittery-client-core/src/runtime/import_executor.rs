//! Exact replay and receipt reconciliation for one accepted Import batch.
//!
//! A retained result describes the original batch even when its Items were later edited, moved,
//! hidden, or deleted. Completion retains that result and asks the existing Bootstrap owner for
//! current authority; it never installs an old request as today's Items.

use super::*;
use crate::replica::{OperationOutcomeResult, OperationRecord, PlanMutation};
use async_trait::async_trait;

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct ImportExchangeResponse {
    pub status: u16,
    pub body: Vec<u8>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum ImportExecutorError {
    Retryable,
    Unauthorized,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum ImportExecutorPass {
    RetryScheduled,
    ParkedFenced,
    ReauthenticationRequired,
    Completed,
}

#[cfg(not(target_arch = "wasm32"))]
pub(crate) trait ImportExecutorThreading: Send + Sync {}
#[cfg(not(target_arch = "wasm32"))]
impl<T: Send + Sync> ImportExecutorThreading for T {}
#[cfg(target_arch = "wasm32")]
pub(crate) trait ImportExecutorThreading {}
#[cfg(target_arch = "wasm32")]
impl<T> ImportExecutorThreading for T {}

#[cfg_attr(target_arch = "wasm32", async_trait(?Send))]
#[cfg_attr(not(target_arch = "wasm32"), async_trait)]
pub(crate) trait ImportExecutorPort: ImportExecutorThreading {
    async fn lookup(
        &self,
        operation: &OperationRecord,
    ) -> Result<Option<ImportExchangeResponse>, ImportExecutorError>;
    async fn post_exact(
        &self,
        operation: &OperationRecord,
    ) -> Result<ImportExchangeResponse, ImportExecutorError>;
    async fn renew_session(&self) -> Result<(), ImportExecutorError>;
    async fn before_reconcile(&self, _operation: &OperationRecord) {}
}

enum Exchange<T> {
    Value(T),
    Retryable,
    ReauthenticationRequired,
}

async fn exchange<T, F, Fut>(
    renewed: &mut bool,
    port: &dyn ImportExecutorPort,
    mut request: F,
) -> Exchange<T>
where
    F: FnMut() -> Fut,
    Fut: std::future::Future<Output = Result<T, ImportExecutorError>>,
{
    match request().await {
        Ok(value) => Exchange::Value(value),
        Err(ImportExecutorError::Retryable) => Exchange::Retryable,
        Err(ImportExecutorError::Unauthorized) if !*renewed => {
            *renewed = true;
            match port.renew_session().await {
                Ok(()) => match request().await {
                    Ok(value) => Exchange::Value(value),
                    Err(ImportExecutorError::Retryable) => Exchange::Retryable,
                    Err(ImportExecutorError::Unauthorized) => Exchange::ReauthenticationRequired,
                },
                Err(ImportExecutorError::Retryable) => Exchange::Retryable,
                Err(ImportExecutorError::Unauthorized) => Exchange::ReauthenticationRequired,
            }
        }
        Err(ImportExecutorError::Unauthorized) => Exchange::ReauthenticationRequired,
    }
}

impl Runtime {
    pub(crate) async fn drive_import_executor_cycle(
        &self,
        account_id: &AccountId,
        operation_id: &str,
        port: &dyn ImportExecutorPort,
    ) -> Result<ImportExecutorPass, RuntimeError> {
        let execution_lock = self.account_execution_lock(account_id)?;
        let _guard = execution_lock.lock().await;
        if self.is_closed() || self.account_teardown_is_pending(account_id) {
            return Ok(ImportExecutorPass::ParkedFenced);
        }
        let Some(snapshot) = self.replica.snapshot(account_id) else {
            return Ok(ImportExecutorPass::ParkedFenced);
        };
        if snapshot.failure.is_some() || !self.completion_scope_is_current(&snapshot) {
            return Ok(ImportExecutorPass::ParkedFenced);
        }
        let Some(operation) = snapshot
            .operations
            .iter()
            .find(|candidate| candidate.operation_id == operation_id)
            .cloned()
        else {
            return Ok(ImportExecutorPass::ParkedFenced);
        };
        let accepted = super::import::decode_import_request(&operation)?;
        let mut renewed = false;
        let hint = exchange(&mut renewed, port, || port.lookup(&operation)).await;
        if !self.completion_scope_is_current(&snapshot) {
            return Ok(ImportExecutorPass::ParkedFenced);
        }
        let hint = match hint {
            Exchange::Value(value) => value,
            Exchange::Retryable => return self.schedule_import_retry(snapshot, operation).await,
            Exchange::ReauthenticationRequired => {
                self.mark_reauthentication_required(account_id);
                return Ok(ImportExecutorPass::ReauthenticationRequired);
            }
        };
        let replay = exchange(&mut renewed, port, || port.post_exact(&operation)).await;
        if !self.completion_scope_is_current(&snapshot) {
            return Ok(ImportExecutorPass::ParkedFenced);
        }
        let replay = match replay {
            Exchange::Value(value) => value,
            Exchange::Retryable => return self.schedule_import_retry(snapshot, operation).await,
            Exchange::ReauthenticationRequired => {
                self.mark_reauthentication_required(account_id);
                return Ok(ImportExecutorPass::ReauthenticationRequired);
            }
        };
        let observed = match self.read_import_response(&operation, &replay) {
            ValidatedImportAnswer::Outcome(outcome) => outcome,
            ValidatedImportAnswer::Transient => {
                return self.schedule_import_retry(snapshot, operation).await;
            }
            ValidatedImportAnswer::IdentityReused => {
                if !matches!(
                    self.fail_account_module_at_snapshot(&snapshot).await,
                    super::outcome::CompletionResult::Failed
                ) {
                    return self.schedule_import_retry(snapshot, operation).await;
                }
                return Err(RuntimeError::new(
                    RuntimeErrorCode::AccountFailed,
                    "Import replay reused an Operation identity",
                ));
            }
        };
        if let Some(hint) = &hint {
            match self.read_import_response(&operation, hint) {
                ValidatedImportAnswer::Outcome(hint) if hint == observed => {}
                ValidatedImportAnswer::Transient => {}
                ValidatedImportAnswer::Outcome(_) | ValidatedImportAnswer::IdentityReused => {
                    if !matches!(
                        self.fail_account_module_at_snapshot(&snapshot).await,
                        super::outcome::CompletionResult::Failed
                    ) {
                        return self.schedule_import_retry(snapshot, operation).await;
                    }
                    return Err(RuntimeError::new(
                        RuntimeErrorCode::AccountFailed,
                        "Import lookup contradicted the exact replay",
                    ));
                }
            }
        }

        match &observed.result {
            OperationOutcomeResult::ImportApplied { imported_count, .. }
                if usize::from(*imported_count) == accepted.items.len() => {}
            OperationOutcomeResult::ImportApplied { .. } => {
                if !matches!(
                    self.fail_account_module_at_snapshot(&snapshot).await,
                    super::outcome::CompletionResult::Failed
                ) {
                    return self.schedule_import_retry(snapshot, operation).await;
                }
                return Err(RuntimeError::new(
                    RuntimeErrorCode::AccountFailed,
                    "Import outcome count changed the accepted batch",
                ));
            }
            OperationOutcomeResult::ImportRejected { .. } => {}
            _ => return Err(invalid("Import executor received another outcome kind")),
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
            super::outcome::CompletionResult::Completed => Ok(ImportExecutorPass::Completed),
            _ => self.schedule_import_retry(snapshot, operation).await,
        }
    }

    /// Narrows the crate's one semantic-answer policy to the answers an Import batch may carry.
    ///
    /// Status classification stays in `read_dispatch_answer`, so Import cannot drift from the
    /// rule that only a structured `OPERATION_ID_REUSED` problem ends accepted work.
    fn read_import_response(
        &self,
        operation: &OperationRecord,
        response: &ImportExchangeResponse,
    ) -> ValidatedImportAnswer {
        match self.read_dispatch_answer(operation, response.status, &response.body) {
            super::outcome::SemanticAnswer::Outcome(outcome)
                if matches!(
                    outcome.result,
                    OperationOutcomeResult::ImportApplied { .. }
                        | OperationOutcomeResult::ImportRejected { .. }
                ) =>
            {
                ValidatedImportAnswer::Outcome(outcome)
            }
            super::outcome::SemanticAnswer::IdentityReused => ValidatedImportAnswer::IdentityReused,
            super::outcome::SemanticAnswer::Outcome(_)
            | super::outcome::SemanticAnswer::Undecided
            | super::outcome::SemanticAnswer::Transient
            | super::outcome::SemanticAnswer::ReauthenticationRequired => {
                ValidatedImportAnswer::Transient
            }
        }
    }

    /// Import has no retry policy of its own. A transport answer moves the same durable attempt
    /// count and bounded exponential delay every other accepted Operation moves, so an offline
    /// Device cannot hot-loop one batch while it backs the rest of its work off.
    async fn schedule_import_retry(
        &self,
        snapshot: crate::replica::ReplicaSnapshot,
        operation: OperationRecord,
    ) -> Result<ImportExecutorPass, RuntimeError> {
        if !self.completion_scope_is_current(&snapshot) {
            return Ok(ImportExecutorPass::ParkedFenced);
        }
        Ok(if self.persist_backoff(&snapshot, &operation).await {
            ImportExecutorPass::RetryScheduled
        } else {
            ImportExecutorPass::ParkedFenced
        })
    }
}

/// What one Import exchange is allowed to mean.
///
/// The variants are enumerated on purpose: a new shared `SemanticAnswer` must be classified here
/// deliberately instead of falling through a wildcard into "retry".
enum ValidatedImportAnswer {
    Outcome(crate::replica::ObservedOutcome),
    Transient,
    IdentityReused,
}

fn invalid(message: &str) -> RuntimeError {
    RuntimeError::new(RuntimeErrorCode::InvariantViolation, message)
}
