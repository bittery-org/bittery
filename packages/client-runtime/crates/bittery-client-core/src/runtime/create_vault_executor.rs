#![allow(
    dead_code,
    reason = "Ticket 53 proves this executor behind a test-only gate before Ticket 54 opens production dispatch"
)]

use super::*;
use crate::replica::{
    AuthorityVaultRecord, AuthorityVaultRole, AuthorityVaultType, CreateVaultCheckpoint,
    ObservedOutcome, OperationKind, OperationOutcomeResult, OperationRecord, PlanMutation,
    PlanResult,
};
use crate::server_contract::AuthVaultKeyResponse;
use async_trait::async_trait;

use super::{
    create_vault_staging::{
        CreateVaultStagingError, CreateVaultStagingPass, CreateVaultStagingPort,
        SessionRenewalBudget,
    },
    outcome::SemanticAnswer,
};

const MAX_AUTHORITY_PAGES: usize = 200;
const MAX_AUTHORITY_ITEMS: usize = 21_000;
const MAX_AUTHORITY_PAGE_BYTES: usize = 4 * 1024 * 1024;
const MAX_AUTHORITY_BYTES: usize = 32 * 1024 * 1024;

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct CreateVaultOperationResponse {
    pub status: u16,
    pub body: Vec<u8>,
}

#[derive(Clone, PartialEq)]
pub(crate) struct CreateVaultAuthorityPage {
    /// Exact response body observed by the HTTP transport. Domain bounds and decodes it exactly
    /// once, so adapters never carry a parallel semantic representation.
    pub raw_response_body: Option<Vec<u8>>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct CreateVaultAuthorityRecord {
    pub id: String,
    pub name: String,
    pub vault_type: AuthorityVaultType,
    pub icon: Option<String>,
    pub image_url: Option<String>,
    pub role: AuthorityVaultRole,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum CreateVaultExecutorPass {
    RetryScheduled,
    ReauthenticationRequired,
    Completed,
}

#[async_trait]
pub(crate) trait CreateVaultExecutorPort: Send + Sync {
    async fn lookup(
        &self,
        operation: &OperationRecord,
    ) -> Result<Option<CreateVaultOperationResponse>, CreateVaultStagingError>;
    async fn put_exact(
        &self,
        operation: &OperationRecord,
    ) -> Result<CreateVaultOperationResponse, CreateVaultStagingError>;
    async fn fetch_vault(
        &self,
        vault_id: &str,
    ) -> Result<CreateVaultAuthorityRecord, CreateVaultStagingError>;
    async fn fetch_vault_keys(
        &self,
        vault_id: &str,
        cursor: Option<&str>,
    ) -> Result<CreateVaultAuthorityPage, CreateVaultStagingError>;
    async fn renew_session(&self) -> Result<(), CreateVaultStagingError>;
    async fn before_reconcile(&self, _operation: &OperationRecord) {}
}

impl Runtime {
    pub(crate) async fn drive_create_vault_executor_cycle(
        &self,
        account_id: &AccountId,
        operation_id: &str,
        port: &dyn CreateVaultExecutorPort,
    ) -> Result<CreateVaultExecutorPass, RuntimeError> {
        self.drive_create_vault_executor_cycle_with_budget(
            account_id,
            operation_id,
            port,
            &mut SessionRenewalBudget::default(),
        )
        .await
    }

    pub(crate) async fn drive_create_vault_recovery_cycle(
        &self,
        account_id: &AccountId,
        operation_id: &str,
        staging: &dyn CreateVaultStagingPort,
        port: &dyn CreateVaultExecutorPort,
    ) -> Result<CreateVaultExecutorPass, RuntimeError> {
        let mut renewal = SessionRenewalBudget::default();
        loop {
            match self
                .drive_create_vault_staging_cycle_with_budget(
                    account_id,
                    operation_id,
                    staging,
                    &mut renewal,
                )
                .await?
            {
                CreateVaultStagingPass::Progressed => continue,
                CreateVaultStagingPass::RetryScheduled => {
                    return Ok(CreateVaultExecutorPass::RetryScheduled)
                }
                CreateVaultStagingPass::ReauthenticationRequired => {
                    return Ok(CreateVaultExecutorPass::ReauthenticationRequired)
                }
                CreateVaultStagingPass::DispatchReady => break,
            }
        }
        self.drive_create_vault_executor_cycle_with_budget(
            account_id,
            operation_id,
            port,
            &mut renewal,
        )
        .await
    }

    async fn drive_create_vault_executor_cycle_with_budget(
        &self,
        account_id: &AccountId,
        operation_id: &str,
        port: &dyn CreateVaultExecutorPort,
        renewal: &mut SessionRenewalBudget,
    ) -> Result<CreateVaultExecutorPass, RuntimeError> {
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
        if operation.kind != OperationKind::CreateVault
            || operation
                .create_vault
                .as_ref()
                .is_none_or(|intent| intent.checkpoint != CreateVaultCheckpoint::FinalRequestFrozen)
        {
            return Err(invalid("create-Vault Operation is not dispatch-ready"));
        }
        if operation
            .create_vault
            .as_ref()
            .is_some_and(|intent| intent.image.is_some())
        {
            // The accepted Operation is also the durable release obligation. Retry the
            // idempotent source release before an authoritative outcome can remove that record.
            self.finish_vault_image_acceptance_cleanup(account_id, operation_id)
                .await;
            let cleanup_pending = self
                .pending_vault_image_acceptance_cleanup
                .lock()
                .expect("Vault image acceptance cleanup lock poisoned")
                .contains(&(account_id.clone(), operation_id.to_owned()));
            if cleanup_pending {
                return self.schedule_executor_retry(snapshot, operation).await;
            }
        }

        let hint =
            match retry_once_after_renewal(port, &mut renewal.renewed, || port.lookup(&operation))
                .await
            {
                Exchange::Value(value) => value,
                Exchange::Retryable => {
                    return self.schedule_executor_retry(snapshot, operation).await
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
                return self.schedule_executor_retry(snapshot, operation).await
            }
            ValidatedCreateVaultAnswer::IdentityReused => {
                self.fail_account_module_fenced(account_id).await;
                return Err(RuntimeError::new(
                    RuntimeErrorCode::AccountFailed,
                    "create-Vault replay reused an Operation identity",
                ));
            }
        };
        if let Some(hint) = &hint {
            match self.read_create_vault_response(&operation, hint) {
                ValidatedCreateVaultAnswer::Outcome(hint) if hint == observed => {}
                ValidatedCreateVaultAnswer::Transient => {}
                ValidatedCreateVaultAnswer::Outcome(_)
                | ValidatedCreateVaultAnswer::IdentityReused => {
                    self.fail_account_module_fenced(account_id).await;
                    return Err(RuntimeError::new(
                        RuntimeErrorCode::AccountFailed,
                        "create-Vault lookup contradicted the exact replay",
                    ));
                }
            }
        }

        let (result, authority) = match &observed.result {
            OperationOutcomeResult::VaultApplied { vault_id } => {
                let authority = match retry_once_after_renewal(port, &mut renewal.renewed, || {
                    port.fetch_vault(vault_id)
                })
                .await
                {
                    Exchange::Value(value) => value,
                    Exchange::Retryable => {
                        return self.schedule_executor_retry(snapshot, operation).await
                    }
                    Exchange::ReauthenticationRequired => {
                        self.mark_reauthentication_required(account_id);
                        return Ok(CreateVaultExecutorPass::ReauthenticationRequired);
                    }
                };
                if authority.id != *vault_id {
                    return Err(invalid("create-Vault authority changed the Vault ID"));
                }
                let intent = operation.create_vault.as_ref().unwrap();
                let mut cursor = None;
                let mut seen_cursors = std::collections::HashSet::new();
                let mut seen_vaults = std::collections::HashSet::new();
                let mut item_count = 0_usize;
                let mut byte_count = 2_usize;
                let mut exact_key = None;
                for _ in 0..MAX_AUTHORITY_PAGES {
                    let page = match retry_once_after_renewal(port, &mut renewal.renewed, || {
                        port.fetch_vault_keys(vault_id, cursor.as_deref())
                    })
                    .await
                    {
                        Exchange::Value(value) => value,
                        Exchange::Retryable => {
                            return self.schedule_executor_retry(snapshot, operation).await
                        }
                        Exchange::ReauthenticationRequired => {
                            self.mark_reauthentication_required(account_id);
                            return Ok(CreateVaultExecutorPass::ReauthenticationRequired);
                        }
                    };
                    let Some(raw_response_body) = page.raw_response_body.as_deref() else {
                        return Err(invalid(
                            "create-Vault authority key page omitted its raw byte evidence",
                        ));
                    };
                    if raw_response_body.len() > MAX_AUTHORITY_PAGE_BYTES {
                        return Err(invalid(
                            "create-Vault authority key page exceeded its raw response bound",
                        ));
                    }
                    let decoded: crate::server_contract::CursorPageAuthVaultKeyResponse =
                        serde_json::from_slice(raw_response_body).map_err(|_| {
                            invalid("create-Vault authority key page could not be decoded")
                        })?;
                    let page = decoded;
                    if page.items.len() > 500 {
                        return Err(invalid(
                            "create-Vault authority key page exceeded its item bound",
                        ));
                    }
                    let page_is_empty = page.items.is_empty();
                    let prior_item_count = item_count;
                    item_count = item_count
                        .checked_add(page.items.len())
                        .ok_or_else(|| invalid("create-Vault authority key count overflowed"))?;
                    if item_count > MAX_AUTHORITY_ITEMS {
                        return Err(invalid(
                            "create-Vault authority exceeded its key count bound",
                        ));
                    }
                    for (page_index, key) in page.items.into_iter().enumerate() {
                        let item_bytes = serde_json::to_vec(&key)
                            .map_err(|_| {
                                invalid("create-Vault authority key could not be measured")
                            })?
                            .len();
                        byte_count = byte_count
                            .checked_add(
                                item_bytes + usize::from(prior_item_count + page_index > 0),
                            )
                            .ok_or_else(|| {
                                invalid("create-Vault authority key bytes overflowed")
                            })?;
                        if byte_count > MAX_AUTHORITY_BYTES {
                            return Err(invalid(
                                "create-Vault authority exceeded its key byte bound",
                            ));
                        }
                        if !seen_vaults.insert(key.vault_id.clone()) {
                            return Err(invalid("create-Vault authority duplicated a Vault key"));
                        }
                        if key.vault_id == *vault_id {
                            exact_key = Some(key);
                        }
                    }
                    if !page.has_more {
                        if page.next_cursor.is_some() {
                            return Err(invalid("create-Vault authority ended with a cursor"));
                        }
                        cursor = None;
                        break;
                    }
                    if page_is_empty {
                        return Err(invalid(
                            "create-Vault authority continued after an empty page",
                        ));
                    }
                    let Some(next) = page.next_cursor else {
                        return Err(invalid("create-Vault authority omitted its next cursor"));
                    };
                    if next.is_empty() {
                        return Err(invalid(
                            "create-Vault authority returned an empty key cursor",
                        ));
                    }
                    if !seen_cursors.insert(next.clone()) {
                        return Err(invalid("create-Vault authority repeated a key cursor"));
                    }
                    if seen_cursors.iter().map(String::len).sum::<usize>() > MAX_AUTHORITY_BYTES {
                        return Err(invalid(
                            "create-Vault authority exceeded its cursor byte bound",
                        ));
                    }
                    cursor = Some(next);
                }
                if cursor.is_some() && seen_cursors.len() == MAX_AUTHORITY_PAGES {
                    return Err(invalid(
                        "create-Vault authority exceeded the key page bound",
                    ));
                }
                let exact_key = exact_key.ok_or_else(|| {
                    invalid("create-Vault authority did not contain the accepted Vault key")
                })?;
                validate_authority_key(&authority, intent, &exact_key)?;
                let authority = AuthorityVaultRecord {
                    id: authority.id,
                    name: authority.name,
                    vault_type: authority.vault_type,
                    icon: authority.icon,
                    image_url: authority.image_url,
                    encrypted_vault_key: intent.encrypted_vault_key.clone(),
                    role: authority.role,
                };
                (
                    OperationOutcomeResult::VaultApplied {
                        vault_id: vault_id.clone(),
                    },
                    Some(authority),
                )
            }
            OperationOutcomeResult::VaultRejected { code } => {
                (OperationOutcomeResult::VaultRejected { code: *code }, None)
            }
            _ => {
                return Err(invalid(
                    "create-Vault replay produced another Operation result",
                ))
            }
        };
        let observed = ObservedOutcome { result, ..observed };
        port.before_reconcile(&operation).await;
        let result = self
            .replica
            .execute(crate::replica::GuardedCommitPlan::new(
                snapshot.account_id,
                snapshot.incarnation,
                snapshot.revision,
                snapshot.lock_epoch,
                vec![PlanMutation::ReconcileCreateVault {
                    outcome: observed,
                    vault: authority,
                }],
            ))
            .await?;
        if !matches!(result, PlanResult::Applied { .. }) {
            return Err(invalid("create-Vault reconciliation was fenced"));
        }
        self.device_revision.fetch_add(1, Ordering::SeqCst);
        self.publish_all();
        Ok(CreateVaultExecutorPass::Completed)
    }

    async fn schedule_executor_retry(
        &self,
        snapshot: crate::replica::ReplicaSnapshot,
        operation: OperationRecord,
    ) -> Result<CreateVaultExecutorPass, RuntimeError> {
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

fn validate_authority_key(
    authority: &CreateVaultAuthorityRecord,
    intent: &crate::replica::CreateVaultOperationRecord,
    key: &AuthVaultKeyResponse,
) -> Result<(), RuntimeError> {
    use crate::server_contract::{VaultRole as WireRole, VaultType as WireType};
    let expected_type = match intent.vault_type {
        crate::CreateVaultType::Personal => WireType::Personal,
        crate::CreateVaultType::Shared => WireType::Team,
    };
    if key.vault_id != authority.id
        || key.encrypted_vault_key != intent.encrypted_vault_key
        || key.role != WireRole::Owner
        || key.vault_name != intent.name
        || key.vault_type != expected_type
        || key.vault_icon.as_deref() != Some(intent.icon.as_str())
        || key.vault_image_url.is_some() != intent.image.is_some()
        || authority.name != key.vault_name
        || authority.icon != key.vault_icon
        || authority.image_url != key.vault_image_url
        || authority.role != AuthorityVaultRole::Owner
        || authority.vault_type
            != match intent.vault_type {
                crate::CreateVaultType::Personal => AuthorityVaultType::Personal,
                crate::CreateVaultType::Shared => AuthorityVaultType::Team,
            }
    {
        return Err(invalid(
            "create-Vault Vault-key authority did not match the accepted ownership identity",
        ));
    }
    Ok(())
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
