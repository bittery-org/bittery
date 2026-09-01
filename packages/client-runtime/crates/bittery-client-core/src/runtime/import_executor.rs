//! Sending one accepted Import batch and reconciling its authoritative answer.
//!
//! This is the half Ticket 57 still gates. The scheduling loop skips `OperationKind::ImportItems`
//! until the atomic Server/Web cutover replaces the legacy route, so nothing in production drives
//! a cycle yet and the module carries `#[allow(dead_code)]`. Acceptance is already live; only
//! transport waits.
//!
//! One cycle asks what the Server already decided, replays the identical bytes, reads the answer
//! through the crate's one semantic-answer policy, fetches the complete authority within its
//! Item, byte, page, and cursor bounds, and installs it under one guarded commit. Only an
//! authoritative outcome ends the batch; every other answer moves the durable backoff.

use super::*;
use crate::replica::{
    AuthorityItemRecord, OperationOutcomeResult, OperationRecord, PlanMutation,
    RecomputedPlanResult,
};
use async_trait::async_trait;

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct ImportExchangeResponse {
    pub status: u16,
    pub body: Vec<u8>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct ImportAuthorityPage {
    pub raw_response_body: Vec<u8>,
    pub next_cursor: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum ImportExecutorError {
    Retryable,
    Unauthorized,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum ImportExecutorPass {
    RetryScheduled,
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
    async fn fetch_items(
        &self,
        vault_id: &str,
        item_ids: &[String],
        cursor: Option<&str>,
    ) -> Result<ImportAuthorityPage, ImportExecutorError>;
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
        let snapshot = self.replica.snapshot(account_id).ok_or_else(|| {
            RuntimeError::new(RuntimeErrorCode::AccountMissing, "account is not installed")
        })?;
        let operation = snapshot
            .operations
            .iter()
            .find(|candidate| candidate.operation_id == operation_id)
            .cloned()
            .ok_or_else(|| invalid("Import Operation is missing"))?;
        let accepted = super::import::decode_import_request(&operation)?;
        let mut renewed = false;
        let hint = match exchange(&mut renewed, port, || port.lookup(&operation)).await {
            Exchange::Value(value) => value,
            Exchange::Retryable => return self.schedule_import_retry(snapshot, operation).await,
            Exchange::ReauthenticationRequired => {
                self.mark_reauthentication_required(account_id);
                return Ok(ImportExecutorPass::ReauthenticationRequired);
            }
        };
        let replay = match exchange(&mut renewed, port, || port.post_exact(&operation)).await {
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
                return self.schedule_import_retry(snapshot, operation).await
            }
            ValidatedImportAnswer::IdentityReused => {
                self.fail_account_module_fenced(account_id).await;
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
                    self.fail_account_module_fenced(account_id).await;
                    return Err(RuntimeError::new(
                        RuntimeErrorCode::AccountFailed,
                        "Import lookup contradicted the exact replay",
                    ));
                }
            }
        }

        let authority = match &observed.result {
            OperationOutcomeResult::ImportApplied {
                vault_id,
                imported_count,
            } => {
                if usize::from(*imported_count) != accepted.items.len() {
                    return Err(invalid("Import outcome count changed the accepted batch"));
                }
                if accepted.items.is_empty() {
                    Vec::new()
                } else {
                    let ids = accepted
                        .items
                        .iter()
                        .map(|item| item.item_id.clone())
                        .collect::<Vec<_>>();
                    match self
                        .fetch_import_authority(port, &mut renewed, vault_id, &ids)
                        .await
                    {
                        Ok(items) => items,
                        Err(error) if error.code == RuntimeErrorCode::AuthenticationRequired => {
                            self.mark_reauthentication_required(account_id);
                            return Ok(ImportExecutorPass::ReauthenticationRequired);
                        }
                        Err(_) => {
                            return self.schedule_import_retry(snapshot, operation).await;
                        }
                    }
                }
            }
            OperationOutcomeResult::ImportRejected { .. } => Vec::new(),
            _ => return Err(invalid("Import executor received another outcome kind")),
        };
        if matches!(
            observed.result,
            OperationOutcomeResult::ImportApplied { .. }
        ) {
            validate_authority(&accepted.items, operation.vault_id(), &authority)?;
        }
        port.before_reconcile(&operation).await;
        let result = self
            .replica
            .execute_recomputing(GuardedCommitPlan::new(
                account_id.clone(),
                snapshot.incarnation,
                snapshot.revision,
                snapshot.lock_epoch,
                vec![PlanMutation::ReconcileImportItems {
                    outcome: observed,
                    items: authority,
                }],
            ))
            .await?;
        match result {
            RecomputedPlanResult::Applied { snapshot } => {
                self.replica.cache(snapshot);
                self.device_revision.fetch_add(1, Ordering::SeqCst);
                self.decrypt_visible_items(account_id)?;
                self.publish_all_unless_closed();
                Ok(ImportExecutorPass::Completed)
            }
            RecomputedPlanResult::Fenced { .. } | RecomputedPlanResult::Missing => {
                Ok(ImportExecutorPass::RetryScheduled)
            }
        }
    }

    async fn fetch_import_authority(
        &self,
        port: &dyn ImportExecutorPort,
        renewed: &mut bool,
        vault_id: &str,
        item_ids: &[String],
    ) -> Result<Vec<AuthorityItemRecord>, RuntimeError> {
        let mut cursor = None;
        let mut seen_cursors = std::collections::HashSet::new();
        let mut bytes = 0usize;
        let mut items = Vec::new();
        let mut complete = false;
        // Every bound here is a liveness bound, not a correctness one. This runs under the
        // Account execution lock, so an answer that keeps offering one more page would stall
        // every other Operation on the Account rather than merely waste a fetch.
        for _ in 0..super::import::MAX_IMPORT_AUTHORITY_PAGES {
            let page = match exchange(renewed, port, || {
                port.fetch_items(vault_id, item_ids, cursor.as_deref())
            })
            .await
            {
                Exchange::Value(value) => value,
                Exchange::Retryable => return Err(retry("Import authority fetch failed")),
                Exchange::ReauthenticationRequired => {
                    return Err(RuntimeError::new(
                        RuntimeErrorCode::AuthenticationRequired,
                        "Import authority requires reauthentication",
                    ))
                }
            };
            bytes = bytes
                .checked_add(page.raw_response_body.len())
                .ok_or_else(|| invalid("Import authority byte count overflowed"))?;
            if bytes > super::import::MAX_IMPORT_AUTHORITY_BYTES {
                return Err(invalid("Import authority exceeded its byte bound"));
            }
            let decoded: Vec<crate::server_contract::ItemResponseDto> =
                serde_json::from_slice(&page.raw_response_body)
                    .map_err(|_| invalid("Import authority page is malformed"))?;
            if items.len() + decoded.len() > super::import::MAX_IMPORT_ITEMS {
                return Err(invalid("Import authority exceeded its Item bound"));
            }
            let carried_items = !decoded.is_empty();
            for item in decoded {
                items.push(
                    super::bootstrap::authority_item_from_dto(item)
                        .map_err(|_| invalid("Import authority Item is invalid"))?,
                );
            }
            let Some(next) = page.next_cursor else {
                complete = true;
                break;
            };
            if next.is_empty() || !seen_cursors.insert(next.clone()) {
                return Err(invalid("Import authority cursor did not advance"));
            }
            if !carried_items {
                return Err(invalid(
                    "Import authority continued past a page carrying no Items",
                ));
            }
            if seen_cursors.iter().map(String::len).sum::<usize>()
                > super::import::MAX_IMPORT_AUTHORITY_CURSOR_BYTES
            {
                return Err(invalid("Import authority exceeded its cursor byte bound"));
            }
            cursor = Some(next);
        }
        if !complete {
            return Err(invalid("Import authority exceeded its page bound"));
        }
        Ok(items)
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
        self.persist_backoff(&snapshot, &operation).await;
        Ok(ImportExecutorPass::RetryScheduled)
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

fn validate_authority(
    expected: &[super::import::ImportRequestItem],
    vault_id: &str,
    actual: &[AuthorityItemRecord],
) -> Result<(), RuntimeError> {
    if expected.len() != actual.len() {
        return Err(invalid("Import authority omitted accepted Items"));
    }
    let expected = expected
        .iter()
        .map(|item| (item.item_id.as_str(), item))
        .collect::<std::collections::HashMap<_, _>>();
    let mut seen = std::collections::HashSet::new();
    for actual in actual {
        let Some(expected) = expected.get(actual.id.as_str()) else {
            return Err(invalid("Import authority returned an unaccepted Item"));
        };
        if actual.id != expected.item_id
            || actual.vault_id != vault_id
            || actual.category != category(expected.category.clone())
            || actual.favorite != expected.favorite
            || actual.encrypted_data != expected.encrypted_data
            || actual.encryption_iv != expected.encryption_iv
            || actual.encryption_algorithm != expected.encryption_algorithm
            || actual.version != 1
            || actual.encryption_version != 1
        {
            return Err(invalid("Import authority changed accepted Item bytes"));
        }
        if !seen.insert(actual.id.as_str()) {
            return Err(invalid("Import authority repeated an accepted Item"));
        }
    }
    Ok(())
}

fn category(value: crate::server_contract::ItemCategory) -> crate::replica::AuthorityItemCategory {
    match value {
        crate::server_contract::ItemCategory::Login => crate::replica::AuthorityItemCategory::Login,
        crate::server_contract::ItemCategory::SecureNote => {
            crate::replica::AuthorityItemCategory::SecureNote
        }
        crate::server_contract::ItemCategory::CreditCard => {
            crate::replica::AuthorityItemCategory::CreditCard
        }
        crate::server_contract::ItemCategory::Identity => {
            crate::replica::AuthorityItemCategory::Identity
        }
        crate::server_contract::ItemCategory::Totp => crate::replica::AuthorityItemCategory::Totp,
    }
}

fn invalid(message: &str) -> RuntimeError {
    RuntimeError::new(RuntimeErrorCode::InvariantViolation, message)
}

fn retry(message: &str) -> RuntimeError {
    RuntimeError::new(RuntimeErrorCode::RetryableTransport, message)
}
