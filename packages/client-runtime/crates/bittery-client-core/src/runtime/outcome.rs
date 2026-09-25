//! Turning a Server answer into local completion.
//!
//! Three rules run through everything here. A matching semantic outcome is immutable. A result
//! that carries a known Operation ID with another request fingerprint is identity reuse, which is
//! fatal rather than retryable. And a transport status is never an outcome: an HTTP `200` only
//! earns the right to read what the Server decided, while local completion happens in exactly one
//! reconciliation plan.

use super::bootstrap::authority_item_from_dto;
use super::*;
use crate::{
    auth_http::{AuthenticatedOutcome, CurrentAuthority},
    platform_storage::CurrentSessionDocument,
    replica::{
        AuthorityAttachmentRecord, AuthorityItemRecord, CursorAdvance, ObservedOutcome,
        OperationKind, OperationOutcomeResult, OperationRejectionCode, PlanResult,
    },
    server_contract::{
        CreateShareOperationRejectionCode as WireShareRejectionCode,
        CreateShareOperationResult as WireCreateShareOperationResult,
        CreateVaultOperationRejectionCode as WireVaultRejectionCode,
        CreateVaultOperationResult as WireCreateVaultOperationResult,
        ImportItemsOperationResult as WireImportItemsOperationResult,
        ItemOperationResult as WireItemOperationResult, OperationOutcome as WireOperationOutcome,
        OperationRejectionCode as WireOperationRejectionCode,
    },
};

/// What one Server answer was worth.
pub(super) enum SemanticAnswer {
    /// The Server decided, and the decision belongs to these exact request bytes.
    Outcome(ObservedOutcome),
    /// Nothing was decided yet. The identical bytes still have to be sent.
    Undecided,
    /// No semantic answer. The same work is owed, and the same bytes will go again later.
    Transient,
    /// This attempt already spent its single Session renewal and met another 401.
    ReauthenticationRequired,
    /// The Server answered this Operation ID for other request bytes, or for another entity.
    ///
    /// That is identity reuse. It is neither a retry nor a replay, and the only safe response is
    /// to fail the Account module rather than to guess which request the answer belongs to.
    IdentityReused,
}

/// One renewal allowance shared by every authenticated exchange that resolves one outcome.
#[derive(Default)]
pub(super) struct OutcomeResolutionAuthBudget {
    renewal_consumed: bool,
}

impl OutcomeResolutionAuthBudget {
    pub(super) fn consume_renewal(&mut self) -> bool {
        if self.renewal_consumed {
            false
        } else {
            self.renewal_consumed = true;
            true
        }
    }
}

/// What one completion attempt left behind.
pub(super) enum CompletionResult {
    /// Authority, receipt, and removal all committed. The Operation is over.
    Completed,
    /// Nothing durable moved. The same Operation is owed, and the caller schedules the retry.
    Retry,
    /// This Account needs reauthentication before anything else can be read.
    Reauthenticate,
    /// The Account module failed. Nothing further is attempted for it.
    Failed,
}

impl Runtime {
    pub(super) async fn acknowledge_share_result(
        &self,
        account_id: AccountId,
        operation_id: String,
        cancellation: RequestCancellation,
    ) -> Result<RuntimeResponse, RuntimeError> {
        self.ensure_open()?;
        if cancellation.is_cancelled() {
            return Err(RuntimeError::new(
                RuntimeErrorCode::Cancelled,
                "caller cancelled before Share result acknowledgement",
            ));
        }
        let execution_lock = self.account_execution_lock(&account_id)?;
        let _execution_guard = execution_lock.lock().await;
        self.ensure_open()?;
        let snapshot = self.replica.snapshot(&account_id).ok_or_else(|| {
            RuntimeError::new(RuntimeErrorCode::AccountMissing, "account is not installed")
        })?;
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
        if self
            .lock_epoch_pending
            .lock()
            .expect("pending lock epoch lock poisoned")
            .contains_key(&account_id)
        {
            return Err(RuntimeError::new(
                RuntimeErrorCode::InvariantViolation,
                "Account lock epoch persistence is pending",
            ));
        }
        let lock_epoch = *self
            .account_lock_epochs
            .lock()
            .expect("Account lock epoch lock poisoned")
            .entry(account_id.clone())
            .or_insert(snapshot.lock_epoch);
        if lock_epoch != snapshot.lock_epoch {
            return Err(RuntimeError::new(
                RuntimeErrorCode::AuthenticationRequired,
                "the selected Account lifecycle changed",
            ));
        }
        let already_acknowledged = !snapshot
            .share_capabilities
            .iter()
            .any(|capability| capability.operation_id == operation_id)
            && snapshot.receipts.iter().any(|receipt| {
                receipt.operation_id == operation_id
                    && receipt.kind == OperationKind::CreateShare
                    && matches!(receipt.result, OperationOutcomeResult::ShareApplied { .. })
            });
        if already_acknowledged {
            return Ok(RuntimeResponse::ShareResultAcknowledged {
                account_id,
                operation_id,
            });
        }
        let result = self
            .replica
            .execute_recomputing(GuardedCommitPlan::new(
                account_id.clone(),
                snapshot.incarnation,
                snapshot.revision,
                lock_epoch,
                vec![PlanMutation::AcknowledgeShareResult {
                    operation_id: operation_id.clone(),
                }],
            ))
            .await?;
        let RecomputedPlanResult::Applied { snapshot } = result else {
            return Err(RuntimeError::new(
                RuntimeErrorCode::AuthenticationRequired,
                "the selected Account lifecycle changed during acknowledgement",
            ));
        };
        let publication = self.publication.lock().expect("publication lock poisoned");
        self.replica.cache(snapshot);
        self.device_revision.fetch_add(1, Ordering::SeqCst);
        drop(publication);
        drop(_execution_guard);
        self.publish_all_unless_closed();
        if cancellation.is_cancelled() {
            return Err(RuntimeError::new(
                RuntimeErrorCode::Cancelled,
                "caller cancelled after Share result acknowledgement",
            ));
        }
        Ok(RuntimeResponse::ShareResultAcknowledged {
            account_id,
            operation_id,
        })
    }

    /// Reads a create dispatch response as a semantic answer, and never as a status code.
    pub(super) fn read_dispatch_answer(
        &self,
        operation: &OperationRecord,
        status: u16,
        body: &[u8],
    ) -> SemanticAnswer {
        match status {
            200 => match serde_json::from_slice::<WireOperationOutcome>(body) {
                Ok(outcome) => observed_outcome(operation, outcome),
                // A `200` this Runtime cannot read is not a decision it may act on. The Operation
                // survives, and the identical bytes are sent again later.
                Err(_) => SemanticAnswer::Transient,
            },
            // The Server's one structured way of saying "this ID belongs to other bytes".
            422 if reused_operation_id(body) => SemanticAnswer::IdentityReused,
            // Everything else is a transport-shaped answer. Nothing durable may end on one.
            _ => SemanticAnswer::Transient,
        }
    }

    /// Asks the Server what it already decided about one Operation.
    ///
    /// A retry that reaches this path has already handed the same bytes over at least once, so
    /// asking costs one read and can never create a second effect.
    pub(super) async fn lookup_operation_outcome(
        &self,
        account_id: &AccountId,
        operation: &OperationRecord,
        http: &AuthHttpClient<'_>,
        session: &mut CurrentSessionDocument,
        auth_budget: &mut OutcomeResolutionAuthBudget,
    ) -> SemanticAnswer {
        let cancellation = RequestCancellation::new();
        let mut answer = http
            .fetch_operation_outcome(
                session.token.as_ref(),
                &operation.operation_id,
                cancellation.clone(),
            )
            .await;
        if matches!(answer, Ok(AuthenticatedOutcome::ReauthenticationRequired)) {
            if !auth_budget.consume_renewal() {
                self.mark_reauthentication_required(account_id);
                return SemanticAnswer::ReauthenticationRequired;
            }
            let renewed = match self
                .renew_session(account_id, session, http, cancellation.clone())
                .await
            {
                Ok(renewed) => renewed,
                Err(error) if error.code == RuntimeErrorCode::AuthenticationRequired => {
                    self.mark_reauthentication_required(account_id);
                    return SemanticAnswer::ReauthenticationRequired;
                }
                Err(_) => return SemanticAnswer::Transient,
            };
            *session = renewed;
            answer = http
                .fetch_operation_outcome(
                    session.token.as_ref(),
                    &operation.operation_id,
                    cancellation,
                )
                .await;
        }
        match answer {
            Ok(AuthenticatedOutcome::Ok(Some(outcome))) => observed_outcome(operation, outcome),
            Ok(AuthenticatedOutcome::Ok(None)) => SemanticAnswer::Undecided,
            Ok(AuthenticatedOutcome::ReauthenticationRequired) => {
                self.mark_reauthentication_required(account_id);
                SemanticAnswer::ReauthenticationRequired
            }
            Ok(AuthenticatedOutcome::Transient) | Err(_) => SemanticAnswer::Transient,
        }
    }

    /// Completes one Operation against its authoritative outcome.
    ///
    /// For an applied Item outcome current authority (or explicit absence) is fetched first,
    /// outside any transaction. One plan then reconciles authority, removes its Operation/overlay, and
    /// insert the compact receipt. Bootstrap advances terminal page progress separately after
    /// every event succeeds. A fetch or commit failure leaves every semantic fact unchanged.
    #[allow(
        dead_code,
        reason = "non-Bootstrap Sync callers retain the lock-acquiring reconciliation seam"
    )]
    pub(super) async fn complete_operation(
        &self,
        account_id: &AccountId,
        operation: &OperationRecord,
        outcome: ObservedOutcome,
        http: &AuthHttpClient<'_>,
        session: &mut CurrentSessionDocument,
        cursor: Option<CursorAdvance>,
    ) -> CompletionResult {
        let Ok(execution_lock) = self.account_execution_lock(account_id) else {
            return CompletionResult::Retry;
        };
        let _execution_guard = execution_lock.lock().await;
        let mut auth_budget = OutcomeResolutionAuthBudget::default();
        self.complete_operation_fenced_with_auth_budget(
            account_id,
            operation,
            outcome,
            http,
            session,
            cursor,
            &mut auth_budget,
        )
        .await
    }

    #[allow(
        clippy::too_many_arguments,
        reason = "one captured completion scope and authentication budget span dispatch and Sync"
    )]
    pub(super) async fn complete_operation_fenced_with_auth_budget(
        &self,
        account_id: &AccountId,
        operation: &OperationRecord,
        outcome: ObservedOutcome,
        http: &AuthHttpClient<'_>,
        session: &mut CurrentSessionDocument,
        cursor: Option<CursorAdvance>,
        auth_budget: &mut OutcomeResolutionAuthBudget,
    ) -> CompletionResult {
        let Some(captured) = self.replica.snapshot(account_id) else {
            return CompletionResult::Retry;
        };
        if !self.completion_scope_is_current(&captured) {
            return CompletionResult::Retry;
        }
        if let Some(receipt) = captured
            .receipts
            .iter()
            .find(|receipt| receipt.operation_id == outcome.operation_id)
        {
            return if receipt.kind == operation.kind
                && receipt.target == operation.target
                && receipt.request_fingerprint == outcome.request_fingerprint
                && outcome_matches_receipt(&receipt.result, &outcome.result)
            {
                CompletionResult::Completed
            } else {
                self.fail_account_module_at_snapshot(&captured).await
            };
        }
        if !outcome_matches_operation_shape(operation, &outcome.result) {
            return self.fail_account_module_at_snapshot(&captured).await;
        }
        let expected_category = captured
            .operations
            .iter()
            .find(|accepted| {
                accepted.operation_id == operation.operation_id
                    && accepted.kind == operation.kind
                    && accepted.request_fingerprint == operation.request_fingerprint
            })
            .and_then(|accepted| accepted.accepted_item_category.clone())
            .or_else(|| {
                captured
                    .items
                    .iter()
                    .find(|item| item.operation_id == operation.operation_id)
                    .map(|item| item.category.clone())
            });
        let mutation = match &outcome.result {
            OperationOutcomeResult::RotationStartApplied { plans } => {
                let intent = match &operation.target {
                    crate::replica::ResourceRef::Team { team_id }
                        if operation.kind == OperationKind::CreateTeamLeaveRotationPlans =>
                    {
                        crate::replica::RotationIntent::TeamLeave {
                            team_id: team_id.clone(),
                        }
                    }
                    _ => return self.fail_account_module_at_snapshot(&captured).await,
                };
                PlanMutation::ReconcileRotationStart {
                    outcome: outcome.clone(),
                    intent,
                    validated_plans: plans.clone(),
                }
            }
            OperationOutcomeResult::RotationStartRejected { .. } => {
                let intent = match &operation.target {
                    crate::replica::ResourceRef::Team { team_id }
                        if operation.kind == OperationKind::CreateTeamLeaveRotationPlans =>
                    {
                        crate::replica::RotationIntent::TeamLeave {
                            team_id: team_id.clone(),
                        }
                    }
                    _ => return self.fail_account_module_at_snapshot(&captured).await,
                };
                PlanMutation::ReconcileRotationStart {
                    outcome: outcome.clone(),
                    intent,
                    validated_plans: Vec::new(),
                }
            }
            OperationOutcomeResult::RotationStartAppliedReceipt { .. } => {
                return self.fail_account_module_at_snapshot(&captured).await;
            }
            OperationOutcomeResult::RotationFinalizeApplied { .. }
            | OperationOutcomeResult::RotationFinalizeRejected { .. } => {
                let Some(attempt) = captured.rotation_attempts.iter().find(|attempt| {
                    matches!(&attempt.phase,
                        crate::replica::RotationAttemptPhase::Finalizing { finalize_operation_id, .. }
                            if finalize_operation_id == &operation.operation_id)
                }) else {
                    return self.fail_account_module_at_snapshot(&captured).await;
                };
                PlanMutation::ReconcileRotationFinalize {
                    start_operation_id: attempt.start_operation_id.clone(),
                    outcome,
                }
            }
            OperationOutcomeResult::Applied { entity_id, version } => {
                let item = match self
                    .fetch_authoritative_item(account_id, entity_id, http, session, auth_budget)
                    .await
                {
                    Ok(item) => item,
                    Err(result) => return result,
                };
                match item {
                    // Neither current absence nor access refusal changes the retained result or
                    // installs authority. The existing refresh establishes current visibility.
                    CurrentAuthority::Absent | CurrentAuthority::Unavailable => {
                        PlanMutation::ReconcileRetainedResult { outcome }
                    }
                    CurrentAuthority::Present(mut item) => {
                        if operation.kind == OperationKind::PermanentlyDeleteItem
                            || item.id != operation.item_id()
                            || item.version < *version
                            || expected_category.as_ref() != Some(&item.category)
                        {
                            return self.fail_account_module_at_snapshot(&captured).await;
                        }
                        let current_visible =
                            self.current_item_authority_is_visible(&captured, &item);
                        if !current_visible {
                            PlanMutation::ReconcileRetainedResult { outcome }
                        } else {
                            if operation.kind == OperationKind::MoveItem {
                                let attachments = match self
                                    .fetch_authoritative_attachments(
                                        account_id,
                                        entity_id,
                                        &item,
                                        http,
                                        session,
                                        auth_budget,
                                        &captured,
                                    )
                                    .await
                                {
                                    Ok(attachments) => attachments,
                                    Err(result) => return result,
                                };
                                item.attachments = attachments;
                            }
                            if let Err(result) = self
                                .validate_outcome_authority(account_id, &item, &captured)
                                .await
                            {
                                return result;
                            }
                            if operation.kind == OperationKind::CreateItem {
                                PlanMutation::ReconcileAppliedCreate {
                                    outcome,
                                    item: Box::new(item),
                                    cursor,
                                }
                            } else {
                                PlanMutation::ReconcileItemMutation {
                                    outcome,
                                    item: Some(Box::new(item)),
                                    cursor,
                                }
                            }
                        }
                    }
                }
            }
            OperationOutcomeResult::ShareApplied { .. } => {
                PlanMutation::ReconcileShareOutcome { outcome, cursor }
            }
            OperationOutcomeResult::VaultApplied { .. }
            | OperationOutcomeResult::VaultMutationRejected { .. }
                if matches!(
                    operation.kind,
                    OperationKind::UpdateVault | OperationKind::DeleteVault
                ) =>
            {
                PlanMutation::ReconcileVaultMutation { outcome }
            }
            OperationOutcomeResult::VaultApplied { .. }
            | OperationOutcomeResult::VaultRejected { .. }
            | OperationOutcomeResult::ImportApplied { .. }
            | OperationOutcomeResult::ImportRejected { .. } => {
                PlanMutation::ReconcileRetainedResult { outcome }
            }
            OperationOutcomeResult::VaultMutationRejected { .. } => return CompletionResult::Retry,
            OperationOutcomeResult::Rejected { .. } => {
                if operation.kind == OperationKind::CreateShare {
                    PlanMutation::ReconcileShareOutcome { outcome, cursor }
                } else if operation.kind != OperationKind::CreateItem {
                    let mut item = match self
                        .fetch_authoritative_item(
                            account_id,
                            operation.item_id(),
                            http,
                            session,
                            auth_budget,
                        )
                        .await
                    {
                        Ok(CurrentAuthority::Present(item)) => Some(item),
                        Ok(CurrentAuthority::Absent | CurrentAuthority::Unavailable) => None,
                        Err(result) => return result,
                    };
                    if item
                        .as_ref()
                        .is_some_and(|item| expected_category.as_ref() != Some(&item.category))
                    {
                        return self.fail_account_module_at_snapshot(&captured).await;
                    }
                    if item
                        .as_ref()
                        .is_none_or(|item| !self.current_item_authority_is_visible(&captured, item))
                    {
                        PlanMutation::ReconcileRetainedResult { outcome }
                    } else {
                        if operation.kind == OperationKind::MoveItem {
                            if let Some(authority) = item.as_mut() {
                                let attachments = match self
                                    .fetch_authoritative_attachments(
                                        account_id,
                                        operation.item_id(),
                                        authority,
                                        http,
                                        session,
                                        auth_budget,
                                        &captured,
                                    )
                                    .await
                                {
                                    Ok(attachments) => attachments,
                                    Err(result) => return result,
                                };
                                authority.attachments = attachments;
                            }
                        }
                        if let Some(item) = &item {
                            if let Err(result) = self
                                .validate_outcome_authority(account_id, item, &captured)
                                .await
                            {
                                return result;
                            }
                        }
                        PlanMutation::ReconcileItemMutation {
                            outcome,
                            item: item.map(Box::new),
                            cursor,
                        }
                    }
                } else {
                    PlanMutation::RetainRejection { outcome, cursor }
                }
            }
        };
        self.commit_completion_fenced(account_id, &captured, mutation)
            .await
    }

    /// Fetches the authoritative encrypted Item, renewing one expired Session on the way.
    pub(super) async fn fetch_authoritative_item(
        &self,
        account_id: &AccountId,
        item_id: &str,
        http: &AuthHttpClient<'_>,
        session: &mut CurrentSessionDocument,
        auth_budget: &mut OutcomeResolutionAuthBudget,
    ) -> Result<CurrentAuthority<AuthorityItemRecord>, CompletionResult> {
        let cancellation = RequestCancellation::new();
        let mut fetched = http
            .fetch_retained_item_authority(session.token.as_ref(), item_id, cancellation.clone())
            .await;
        if matches!(fetched, Ok(AuthenticatedOutcome::ReauthenticationRequired)) {
            if !auth_budget.consume_renewal() {
                self.mark_reauthentication_required(account_id);
                return Err(CompletionResult::Reauthenticate);
            }
            match self
                .renew_session(account_id, session, http, cancellation.clone())
                .await
            {
                Ok(renewed) => {
                    *session = renewed;
                    fetched = http
                        .fetch_retained_item_authority(
                            session.token.as_ref(),
                            item_id,
                            cancellation,
                        )
                        .await;
                }
                Err(error) if error.code == RuntimeErrorCode::AuthenticationRequired => {
                    self.mark_reauthentication_required(account_id);
                    return Err(CompletionResult::Reauthenticate);
                }
                Err(_) => return Err(CompletionResult::Retry),
            }
        }
        match fetched {
            Ok(AuthenticatedOutcome::Ok(CurrentAuthority::Present(item))) => {
                authority_item_from_dto(item)
                    .map(CurrentAuthority::Present)
                    .map_err(|_| CompletionResult::Retry)
            }
            Ok(AuthenticatedOutcome::Ok(CurrentAuthority::Absent)) => Ok(CurrentAuthority::Absent),
            Ok(AuthenticatedOutcome::Ok(CurrentAuthority::Unavailable)) => {
                Ok(CurrentAuthority::Unavailable)
            }
            Ok(AuthenticatedOutcome::ReauthenticationRequired) => {
                self.mark_reauthentication_required(account_id);
                Err(CompletionResult::Reauthenticate)
            }
            Ok(AuthenticatedOutcome::Transient) | Err(_) => Err(CompletionResult::Retry),
        }
    }

    #[allow(
        clippy::too_many_arguments,
        reason = "bounded authority validation keeps Account, Item, Vault, fence, and authentication scope explicit"
    )]
    pub(super) async fn fetch_authoritative_attachments(
        &self,
        account_id: &AccountId,
        expected_item_id: &str,
        item: &AuthorityItemRecord,
        http: &AuthHttpClient<'_>,
        session: &mut CurrentSessionDocument,
        auth_budget: &mut OutcomeResolutionAuthBudget,
        captured: &ReplicaSnapshot,
    ) -> Result<Vec<AuthorityAttachmentRecord>, CompletionResult> {
        if !self.completion_scope_is_current(captured) {
            return Err(CompletionResult::Retry);
        }
        let snapshot = captured;
        if item.id != expected_item_id
            || !snapshot
                .bootstrap
                .snapshot()
                .visible_vaults
                .iter()
                .any(|vault| vault.id == item.vault_id)
        {
            return Err(self.fail_account_module_at_snapshot(captured).await);
        }
        let item_id = &item.id;
        let cancellation = RequestCancellation::new();
        let mut fetch = http
            .begin_attachment_authority(item_id)
            .map_err(|_| CompletionResult::Retry)?;
        loop {
            match http
                .fetch_attachment_authority_page(
                    session.token.as_ref(),
                    &mut fetch,
                    cancellation.clone(),
                )
                .await
            {
                Ok(AuthenticatedOutcome::Ok(Some(attachments))) => {
                    let attachments: Vec<_> = attachments
                        .into_iter()
                        .map(super::attachment::authority_attachment_from_dto)
                        .collect();
                    if attachments.iter().any(|attachment| {
                        attachment.item_id != item.id || attachment.vault_id != item.vault_id
                    }) {
                        return Err(self.fail_account_module_at_snapshot(captured).await);
                    }
                    return Ok(attachments);
                }
                Ok(AuthenticatedOutcome::Ok(None)) => {}
                Ok(AuthenticatedOutcome::ReauthenticationRequired)
                    if auth_budget.consume_renewal() =>
                {
                    match self
                        .renew_session(account_id, session, http, cancellation.clone())
                        .await
                    {
                        Ok(replacement) => *session = replacement,
                        Err(error) if error.code == RuntimeErrorCode::AuthenticationRequired => {
                            self.mark_reauthentication_required(account_id);
                            return Err(CompletionResult::Reauthenticate);
                        }
                        Err(_) => return Err(CompletionResult::Retry),
                    }
                }
                Ok(AuthenticatedOutcome::ReauthenticationRequired) => {
                    self.mark_reauthentication_required(account_id);
                    return Err(CompletionResult::Reauthenticate);
                }
                Ok(AuthenticatedOutcome::Transient) | Err(_) => {
                    return Err(CompletionResult::Retry);
                }
            }
        }
    }

    /// Retained Sessions can finish sending accepted ciphertext while locked. Authority still
    /// needs live keys before reconciliation; their absence defers completion, not Account health.
    async fn validate_outcome_authority(
        &self,
        account_id: &AccountId,
        item: &AuthorityItemRecord,
        captured: &ReplicaSnapshot,
    ) -> Result<(), CompletionResult> {
        if !self.completion_scope_is_current(captured) {
            return Err(CompletionResult::Retry);
        }
        match self.validate_authoritative_item(account_id, item) {
            Ok(()) => Ok(()),
            Err(error) if error.code == RuntimeErrorCode::AuthenticationRequired => {
                Err(CompletionResult::Retry)
            }
            Err(_) => Err(self.fail_account_module_at_snapshot(captured).await),
        }
    }

    pub(super) fn completion_scope_is_current(&self, captured: &ReplicaSnapshot) -> bool {
        let account_id = &captured.account_id;
        !self.is_closed()
            && !self.account_teardown_is_pending(account_id)
            && !self.account_access_retirement_is_pending(account_id)
            && !self
                .lock_epoch_pending
                .lock()
                .expect("pending lock epoch lock poisoned")
                .contains_key(account_id)
            && self
                .account_lock_epochs
                .lock()
                .expect("Account lock epoch lock poisoned")
                .get(account_id)
                .is_none_or(|epoch| *epoch == captured.lock_epoch)
            && self.replica.snapshot(account_id).is_some_and(|current| {
                current.incarnation == captured.incarnation
                    && current.lock_epoch == captured.lock_epoch
                    && current.revision == captured.revision
            })
    }

    /// Commits the captured completion under the caller-held Account execution fence.
    pub(super) async fn commit_completion_fenced(
        &self,
        account_id: &AccountId,
        captured: &ReplicaSnapshot,
        mutation: PlanMutation,
    ) -> CompletionResult {
        if !self.completion_scope_is_current(captured) {
            return CompletionResult::Retry;
        }
        let installs_authority = !matches!(&mutation, PlanMutation::ReconcileRetainedResult { .. });
        let result = self
            .replica
            .execute_exact(GuardedCommitPlan::new(
                account_id.clone(),
                captured.incarnation.clone(),
                captured.revision,
                captured.lock_epoch,
                vec![mutation],
            ))
            .await;
        match result {
            Ok(PlanResult::Applied { .. }) => {
                let publication = self.publication.lock().expect("publication lock poisoned");
                self.device_revision.fetch_add(1, Ordering::SeqCst);
                drop(publication);
                if installs_authority {
                    let _ = self.decrypt_visible_items(account_id);
                }
                self.publish_all_unless_closed();
                CompletionResult::Completed
            }
            // A fenced or removed Account keeps every durable row it still has. Nothing here may
            // reverse a Server effect, so the Operation simply stays owed until it can commit.
            Ok(PlanResult::Stale { .. }) | Ok(PlanResult::Missing) => CompletionResult::Retry,
            // A persistence failure is a failure to write, never a semantic verdict. Everything
            // this plan would have moved is still exactly where it was.
            Err(_) => CompletionResult::Retry,
        }
    }

    pub(super) async fn fail_account_module_fenced(
        &self,
        account_id: &AccountId,
    ) -> CompletionResult {
        let Some(snapshot) = self.replica.snapshot(account_id) else {
            return CompletionResult::Failed;
        };
        self.fail_account_module_at_snapshot(&snapshot).await
    }

    pub(super) async fn fail_account_module_at_snapshot(
        &self,
        snapshot: &ReplicaSnapshot,
    ) -> CompletionResult {
        if !self.completion_scope_is_current(snapshot) {
            return CompletionResult::Retry;
        }
        if snapshot.failure.is_some() {
            return CompletionResult::Failed;
        }
        match self
            .replica
            .execute_exact(GuardedCommitPlan::new(
                snapshot.account_id.clone(),
                snapshot.incarnation.clone(),
                snapshot.revision,
                snapshot.lock_epoch,
                vec![PlanMutation::FailAccount {
                    code: RuntimeErrorCode::InvariantViolation,
                }],
            ))
            .await
        {
            Ok(PlanResult::Applied { .. }) => {
                let publication = self.publication.lock().expect("publication lock poisoned");
                self.device_revision.fetch_add(1, Ordering::SeqCst);
                drop(publication);
                self.publish_all_unless_closed();
                CompletionResult::Failed
            }
            _ => CompletionResult::Retry,
        }
    }

    /// Completes one Operation because the Sync feed says the Server resolved it.
    ///
    /// The feed carries identity, never the decision, so the outcome is still read from the
    /// Server. Page progress remains owned by Bootstrap after every event has reconciled.
    #[allow(
        dead_code,
        reason = "non-Bootstrap Sync callers retain the lock-acquiring reconciliation seam"
    )]
    pub(super) async fn reconcile_resolved_operation(
        &self,
        account_id: &AccountId,
        operation_id: &str,
        http: &AuthHttpClient<'_>,
        session: &mut CurrentSessionDocument,
    ) -> CompletionResult {
        let Ok(execution_lock) = self.account_execution_lock(account_id) else {
            return CompletionResult::Retry;
        };
        let _execution_guard = execution_lock.lock().await;
        if self.is_closed() {
            return CompletionResult::Retry;
        }
        self.reconcile_resolved_operation_fenced(
            account_id,
            operation_id,
            http,
            session,
            &mut OutcomeResolutionAuthBudget::default(),
        )
        .await
    }

    /// Bootstrap already owns the Account execution fence across Sync reconciliation.
    pub(super) async fn reconcile_resolved_operation_fenced(
        &self,
        account_id: &AccountId,
        operation_id: &str,
        http: &AuthHttpClient<'_>,
        session: &mut CurrentSessionDocument,
        auth_budget: &mut OutcomeResolutionAuthBudget,
    ) -> CompletionResult {
        let Some(snapshot) = self.replica.snapshot(account_id) else {
            return CompletionResult::Retry;
        };
        let Some(operation) = snapshot
            .operations
            .iter()
            .find(|operation| operation.operation_id == operation_id)
            .cloned()
        else {
            // Another Device's Operation, or one this Device already completed. Bootstrap owns
            // the page watermark and advances it only after every event has been processed.
            return CompletionResult::Completed;
        };
        if operation.is_legacy_held() {
            let Ok(now_ms) = self.clock.now_ms() else {
                return CompletionResult::Retry;
            };
            if operation.scheduling.not_before_ms > now_ms
                || !self.completion_scope_is_current(&snapshot)
            {
                return CompletionResult::Retry;
            }
        }
        match self
            .lookup_operation_outcome(account_id, &operation, http, session, auth_budget)
            .await
        {
            SemanticAnswer::Outcome(hint) => {
                if operation.kind == OperationKind::CreateShare {
                    self.wake_dispatch();
                    return CompletionResult::Retry;
                }
                // Lookup is only a hint because it carries no request fingerprint. Replay the
                // exact immutable request under this same Sync fence so identity remains proven
                // before Bootstrap advances the page watermark, including Create with Item404.
                self.replay_lookup_hint_for_sync_fenced(
                    &snapshot,
                    &operation,
                    &hint,
                    http,
                    session,
                    auth_budget,
                )
                .await
            }
            SemanticAnswer::IdentityReused if operation.is_legacy_held() => {
                self.fail_account_module_at_snapshot(&snapshot).await
            }
            SemanticAnswer::IdentityReused => self.fail_account_module_fenced(account_id).await,
            SemanticAnswer::Transient => {
                if operation.is_legacy_held() && self.completion_scope_is_current(&snapshot) {
                    self.persist_backoff(&snapshot, &operation).await;
                }
                CompletionResult::Retry
            }
            SemanticAnswer::Undecided => CompletionResult::Retry,
            SemanticAnswer::ReauthenticationRequired => CompletionResult::Reauthenticate,
        }
    }

    pub(super) async fn advance_sync_page_cursor_fenced(
        &self,
        account_id: &AccountId,
        operation_ids: Vec<String>,
        cursor: CursorAdvance,
    ) -> CompletionResult {
        let Some(snapshot) = self.replica.snapshot(account_id) else {
            return CompletionResult::Retry;
        };
        if snapshot.bootstrap.active_cursor != cursor.expected || cursor.expected == cursor.next {
            return CompletionResult::Retry;
        }
        match self
            .replica
            .execute_recomputing(GuardedCommitPlan::new(
                account_id.clone(),
                snapshot.incarnation.clone(),
                snapshot.revision,
                snapshot.lock_epoch,
                vec![PlanMutation::AdvanceSyncPageCursor {
                    operation_ids,
                    cursor,
                }],
            ))
            .await
        {
            Ok(RecomputedPlanResult::Applied { snapshot }) => {
                let publication = self.publication.lock().expect("publication lock poisoned");
                self.replica.cache(snapshot);
                self.device_revision.fetch_add(1, Ordering::SeqCst);
                drop(publication);
                self.publish_all_unless_closed();
                CompletionResult::Completed
            }
            Ok(RecomputedPlanResult::Fenced { .. })
            | Ok(RecomputedPlanResult::Missing)
            | Err(_) => CompletionResult::Retry,
        }
    }
}

fn outcome_matches_operation_shape(
    operation: &OperationRecord,
    result: &OperationOutcomeResult,
) -> bool {
    let item_target = operation.target.item_id().is_some();
    match result {
        OperationOutcomeResult::RotationStartApplied { .. }
        | OperationOutcomeResult::RotationStartRejected { .. } => {
            matches!(operation.target, crate::replica::ResourceRef::Team { .. })
                && operation.kind == OperationKind::CreateTeamLeaveRotationPlans
        }
        OperationOutcomeResult::RotationStartAppliedReceipt { .. } => false,
        OperationOutcomeResult::RotationFinalizeApplied { .. }
        | OperationOutcomeResult::RotationFinalizeRejected { .. } => {
            matches!(operation.target, crate::replica::ResourceRef::Team { .. })
                && operation.kind == OperationKind::FinalizeTeamLeaveRotationPlans
        }
        OperationOutcomeResult::Applied { .. } => {
            item_target
                && matches!(
                    operation.kind,
                    OperationKind::CreateItem
                        | OperationKind::UpdateItem
                        | OperationKind::SetItemFavorite
                        | OperationKind::TrashItem
                        | OperationKind::RestoreItem
                        | OperationKind::MoveItem
                        | OperationKind::PermanentlyDeleteItem
                )
        }
        OperationOutcomeResult::Rejected { .. } => {
            item_target
                && !matches!(
                    operation.kind,
                    OperationKind::CreateVault
                        | OperationKind::UpdateVault
                        | OperationKind::DeleteVault
                )
        }
        OperationOutcomeResult::ShareApplied { .. } => {
            item_target && operation.kind == OperationKind::CreateShare
        }
        OperationOutcomeResult::VaultApplied { vault_id } => {
            matches!(operation.target, crate::replica::ResourceRef::Vault { .. })
                && matches!(
                    operation.kind,
                    OperationKind::CreateVault
                        | OperationKind::UpdateVault
                        | OperationKind::DeleteVault
                )
                && vault_id == operation.vault_id()
        }
        OperationOutcomeResult::VaultRejected { .. } => {
            !item_target && operation.kind == OperationKind::CreateVault
        }
        OperationOutcomeResult::VaultMutationRejected { .. } => {
            matches!(operation.target, crate::replica::ResourceRef::Vault { .. })
                && matches!(
                    operation.kind,
                    OperationKind::UpdateVault | OperationKind::DeleteVault
                )
        }
        OperationOutcomeResult::ImportApplied {
            vault_id,
            imported_count,
        } => {
            matches!(
                operation.target,
                crate::replica::ResourceRef::ImportBatch { .. }
            ) && operation.kind == OperationKind::ImportItems
                && vault_id == operation.vault_id()
                && super::import::decode_import_request(operation)
                    .is_ok_and(|body| body.items.len() == usize::from(*imported_count))
        }
        OperationOutcomeResult::ImportRejected { .. } => {
            matches!(
                operation.target,
                crate::replica::ResourceRef::ImportBatch { .. }
            ) && operation.kind == OperationKind::ImportItems
        }
    }
}

fn outcome_matches_receipt(
    receipt: &OperationOutcomeResult,
    observed: &OperationOutcomeResult,
) -> bool {
    match (receipt, observed) {
        (
            OperationOutcomeResult::RotationStartAppliedReceipt {
                plan_set_fingerprint,
                plan_count,
            },
            OperationOutcomeResult::RotationStartApplied { plans },
        ) => {
            usize::from(*plan_count) == plans.len()
                && crate::replica::rotation_plan_digest(plans)
                    .is_ok_and(|digest| digest == *plan_set_fingerprint)
        }
        _ => receipt == observed,
    }
}

/// Reads one wire outcome as this Operation's outcome, or refuses it.
///
/// The lookup route answers one union tagged on `kind`, so the first thing that happens here is
/// the check the contract was designed for: does the kind the Server answered match the kind this
/// Device durably accepted? A `kind` this Runtime does not carry fails to deserialize; a `kind` it
/// carries but did not ask for is identity reuse. Neither is ever read as this Operation's answer.
fn observed_outcome(operation: &OperationRecord, outcome: WireOperationOutcome) -> SemanticAnswer {
    macro_rules! ordinary {
        ($operation_id:expr, $kind:expr, $result:expr) => {
            match ordinary_item_outcome(operation, $operation_id, $kind, $result) {
                Some(outcome) => outcome,
                None => return SemanticAnswer::IdentityReused,
            }
        };
    }
    let (operation_id, expected_kind, result) = match outcome {
        // Unsupported Rotation kinds still cannot resolve a durable Operation.
        WireOperationOutcome::CreateVaultMemberRemovalRotationPlans { .. }
        | WireOperationOutcome::FinalizeVaultMemberRemovalRotationPlans { .. }
        | WireOperationOutcome::CreateTeamMemberRemovalRotationPlans { .. }
        | WireOperationOutcome::FinalizeTeamMemberRemovalRotationPlans { .. } => {
            return SemanticAnswer::IdentityReused;
        }
        WireOperationOutcome::CreateTeamLeaveRotationPlans {
            operation_id,
            result,
        } => {
            if operation.kind != OperationKind::CreateTeamLeaveRotationPlans
                || !matches!(operation.target, crate::replica::ResourceRef::Team { .. })
            {
                return SemanticAnswer::IdentityReused;
            }
            let result = match result {
                crate::server_contract::CreateTeamLeaveRotationPlansResult::Applied { plans } => {
                    let Some(plans) = parse_rotation_start_plans(plans) else {
                        return SemanticAnswer::IdentityReused;
                    };
                    OperationOutcomeResult::RotationStartApplied { plans }
                }
                crate::server_contract::CreateTeamLeaveRotationPlansResult::Rejected { code } => {
                    use crate::replica::RotationStartRejectionCode as Local;
                    let code = match code {
                        crate::server_contract::CreateTeamLeaveRotationPlansRejectionCode::TeamMemberNotFound => Local::TeamMemberNotFound,
                        crate::server_contract::CreateTeamLeaveRotationPlansRejectionCode::PersonalTeamDepartureForbidden => Local::PersonalTeamDepartureForbidden,
                        crate::server_contract::CreateTeamLeaveRotationPlansRejectionCode::TeamOwnerLeaveForbidden => Local::TeamOwnerLeaveForbidden,
                    };
                    OperationOutcomeResult::RotationStartRejected { code }
                }
            };
            (
                operation_id,
                OperationKind::CreateTeamLeaveRotationPlans,
                result,
            )
        }
        WireOperationOutcome::FinalizeTeamLeaveRotationPlans {
            operation_id,
            result,
        } => {
            if operation.kind != OperationKind::FinalizeTeamLeaveRotationPlans
                || !matches!(operation.target, crate::replica::ResourceRef::Team { .. })
            {
                return SemanticAnswer::IdentityReused;
            }
            let result = match result {
                crate::server_contract::FinalizeTeamLeaveRotationPlansResult::Applied {
                    rotations,
                    personal_team_id,
                } => {
                    if personal_team_id.is_empty() || personal_team_id.len() > 128 {
                        return SemanticAnswer::IdentityReused;
                    }
                    OperationOutcomeResult::RotationFinalizeApplied {
                        personal_team_id,
                        rotations: rotations
                            .into_iter()
                            .map(|rotation| crate::replica::RotationResultRecord {
                                plan_id: rotation.plan_id,
                                vault_id: rotation.vault_id,
                                key_version: rotation.key_version,
                                rotation_id: rotation.rotation_id,
                            })
                            .collect(),
                    }
                }
                crate::server_contract::FinalizeTeamLeaveRotationPlansResult::Rejected {
                    code,
                    details,
                } => {
                    use crate::replica::RotationFinalizeRejectionCode as Local;
                    let code = match code {
                        crate::server_contract::FinalizeTeamLeaveRotationPlansRejectionCode::TeamMembershipChanged => Local::TeamMembershipChanged,
                        crate::server_contract::FinalizeTeamLeaveRotationPlansRejectionCode::PersonalTeamDepartureForbidden => Local::PersonalTeamDepartureForbidden,
                        crate::server_contract::FinalizeTeamLeaveRotationPlansRejectionCode::TeamOwnerLeaveForbidden => Local::TeamOwnerLeaveForbidden,
                        crate::server_contract::FinalizeTeamLeaveRotationPlansRejectionCode::RotationPlanUnavailable => Local::RotationPlanUnavailable,
                        crate::server_contract::FinalizeTeamLeaveRotationPlansRejectionCode::RotationPlanMismatch => Local::RotationPlanMismatch,
                        crate::server_contract::FinalizeTeamLeaveRotationPlansRejectionCode::RotationPlanIncomplete => Local::RotationPlanIncomplete,
                        crate::server_contract::FinalizeTeamLeaveRotationPlansRejectionCode::RotationPlanStale => Local::RotationPlanStale,
                        crate::server_contract::FinalizeTeamLeaveRotationPlansRejectionCode::RotationPlanSetMismatch => Local::RotationPlanSetMismatch,
                    };
                    let details = match details {
                        Some(details) if code == Local::RotationPlanStale => {
                            let reason = match details.reason {
                                crate::server_contract::VaultKeyRotationStaleReason::VaultVersion => crate::replica::RotationStaleReason::VaultVersion,
                                crate::server_contract::VaultKeyRotationStaleReason::MemberSet => crate::replica::RotationStaleReason::MemberSet,
                                crate::server_contract::VaultKeyRotationStaleReason::ItemState => crate::replica::RotationStaleReason::ItemState,
                                crate::server_contract::VaultKeyRotationStaleReason::AttachmentState => crate::replica::RotationStaleReason::AttachmentState,
                            };
                            Some(crate::replica::RotationStaleDetails {
                                plan_id: details.plan_id,
                                reason,
                            })
                        }
                        None => None,
                        Some(_) => return SemanticAnswer::IdentityReused,
                    };
                    if details.is_some() {
                        return SemanticAnswer::IdentityReused;
                    }
                    OperationOutcomeResult::RotationFinalizeRejected { code, details }
                }
            };
            (
                operation_id,
                OperationKind::FinalizeTeamLeaveRotationPlans,
                result,
            )
        }

        WireOperationOutcome::CreateItem {
            operation_id,
            result,
        } => {
            if operation.kind != OperationKind::CreateItem || operation.target.item_id().is_none() {
                return SemanticAnswer::IdentityReused;
            }
            let result = match result {
                WireItemOperationResult::Applied { item_id, version } => {
                    if item_id != operation.item_id() || version < 1 {
                        return SemanticAnswer::IdentityReused;
                    }
                    OperationOutcomeResult::Applied {
                        entity_id: item_id,
                        version,
                    }
                }
                WireItemOperationResult::Rejected { code, .. } => {
                    OperationOutcomeResult::Rejected {
                        code: rejection_code(code),
                    }
                }
            };
            (operation_id, OperationKind::CreateItem, result)
        }
        WireOperationOutcome::UpdateItem {
            operation_id,
            result,
        } => ordinary!(operation_id, OperationKind::UpdateItem, result),
        WireOperationOutcome::SetItemFavorite {
            operation_id,
            result,
        } => ordinary!(operation_id, OperationKind::SetItemFavorite, result),
        WireOperationOutcome::TrashItem {
            operation_id,
            result,
        } => ordinary!(operation_id, OperationKind::TrashItem, result),
        WireOperationOutcome::RestoreItem {
            operation_id,
            result,
        } => ordinary!(operation_id, OperationKind::RestoreItem, result),
        WireOperationOutcome::MoveItem {
            operation_id,
            result,
        } => ordinary!(operation_id, OperationKind::MoveItem, result),
        WireOperationOutcome::PermanentlyDeleteItem {
            operation_id,
            result,
        } => ordinary!(operation_id, OperationKind::PermanentlyDeleteItem, result),
        WireOperationOutcome::CreateShare {
            operation_id,
            result,
        } => {
            let result = match result {
                WireCreateShareOperationResult::Applied {
                    base_share_url,
                    expires_at,
                    share_link_id,
                } => {
                    if base_share_url.is_empty()
                        || expires_at.is_empty()
                        || share_link_id.is_empty()
                    {
                        return SemanticAnswer::IdentityReused;
                    }
                    OperationOutcomeResult::ShareApplied {
                        share_link_id,
                        base_share_url,
                        expires_at,
                    }
                }
                WireCreateShareOperationResult::Rejected { code } => {
                    OperationOutcomeResult::Rejected {
                        code: share_rejection_code(code),
                    }
                }
            };
            (operation_id, OperationKind::CreateShare, result)
        }
        WireOperationOutcome::UpdateVault {
            operation_id,
            result,
        } => {
            match vault_mutation_outcome(
                operation,
                operation_id,
                OperationKind::UpdateVault,
                result,
            ) {
                Some(outcome) => outcome,
                None => return SemanticAnswer::IdentityReused,
            }
        }
        WireOperationOutcome::DeleteVault {
            operation_id,
            result,
        } => {
            match vault_mutation_outcome(
                operation,
                operation_id,
                OperationKind::DeleteVault,
                result,
            ) {
                Some(outcome) => outcome,
                None => return SemanticAnswer::IdentityReused,
            }
        }
        WireOperationOutcome::CreateVault {
            operation_id,
            result,
        } => {
            if !matches!(operation.target, crate::replica::ResourceRef::Vault { .. }) {
                return SemanticAnswer::IdentityReused;
            }
            let result = match result {
                WireCreateVaultOperationResult::Applied { vault_id } => {
                    if vault_id != operation.vault_id() {
                        return SemanticAnswer::IdentityReused;
                    }
                    OperationOutcomeResult::VaultApplied { vault_id }
                }
                WireCreateVaultOperationResult::Rejected { code } => {
                    OperationOutcomeResult::VaultRejected {
                        code: vault_rejection_code(code),
                    }
                }
            };
            (operation_id, OperationKind::CreateVault, result)
        }
        // An Import answer is eligible only for an Operation this Device accepted as an Import
        // batch against the same Vault. Under any other accepted kind or target the Server is
        // describing other bytes under this ID, which is identity reuse, never a decision.
        WireOperationOutcome::ImportItems {
            operation_id,
            result,
        } => {
            let accepted_import = operation.kind == OperationKind::ImportItems
                && matches!(
                    operation.target,
                    crate::replica::ResourceRef::ImportBatch { .. }
                );
            let result = match result {
                WireImportItemsOperationResult::Applied {
                    imported_count,
                    vault_id,
                } => {
                    // The Server's closed schema, and the frozen migration behind it, constrain an
                    // applied count to the accepted batch bound. A count outside that range, or
                    // one too wide for the durable field, is a payload this Runtime cannot read at
                    // all: malformed exactly like a negative count, so it retries and never
                    // fences. Widening the batch bound needs a new Server migration first.
                    let Some(imported_count) = u16::try_from(imported_count)
                        .ok()
                        .filter(|count| usize::from(*count) <= crate::replica::MAX_IMPORT_ITEMS)
                    else {
                        return SemanticAnswer::Transient;
                    };
                    if vault_id.is_empty() {
                        return SemanticAnswer::Transient;
                    }
                    if !accepted_import || vault_id != operation.vault_id() {
                        return SemanticAnswer::IdentityReused;
                    }
                    OperationOutcomeResult::ImportApplied {
                        vault_id,
                        imported_count,
                    }
                }
                WireImportItemsOperationResult::Rejected { code } => {
                    if !accepted_import {
                        return SemanticAnswer::IdentityReused;
                    }
                    OperationOutcomeResult::ImportRejected {
                        code: import_rejection_code(code),
                    }
                }
            };
            (operation_id, OperationKind::ImportItems, result)
        }
    };
    if operation_id != operation.operation_id || operation.kind != expected_kind {
        // The Operation ID is ours; the kind is not. Keeping the fingerprint independent of the
        // Operation ID is what makes that visible at all.
        return SemanticAnswer::IdentityReused;
    }
    SemanticAnswer::Outcome(ObservedOutcome {
        operation_id: operation.operation_id.clone(),
        request_fingerprint: operation.request_fingerprint,
        result,
    })
}

fn parse_rotation_start_plans(
    plans: Vec<crate::server_contract::RotationPlanSnapshot>,
) -> Option<Vec<crate::replica::RotationPlanRecord>> {
    if plans.len() > 21_000 {
        return None;
    }
    let mut plan_ids = std::collections::HashSet::new();
    let mut vault_ids = std::collections::HashSet::new();
    plans
        .into_iter()
        .map(|plan| {
            if !matches!(
                plan.state,
                crate::server_contract::InitialRotationPlanState::Preparing
            ) || plan.id.is_empty()
                || plan.id.len() > 128
                || plan.vault_id.is_empty()
                || plan.vault_id.len() > 128
                || plan.initiator_user_id.is_empty()
                || plan.initiator_user_id.len() > 128
                || plan.expected_key_version < 1
                || plan.idle_expires_at.is_empty()
                || plan.idle_expires_at.len() > 64
                || plan.absolute_expires_at.is_empty()
                || plan.absolute_expires_at.len() > 64
                || !plan_ids.insert(plan.id.clone())
                || !vault_ids.insert(plan.vault_id.clone())
            {
                return None;
            }
            Some(crate::replica::RotationPlanRecord {
                plan_id: plan.id,
                vault_id: plan.vault_id,
                initiator_user_id: plan.initiator_user_id,
                expected_key_version: plan.expected_key_version,
                idle_expires_at: plan.idle_expires_at,
                absolute_expires_at: plan.absolute_expires_at,
            })
        })
        .collect()
}

fn vault_rejection_code(
    code: WireVaultRejectionCode,
) -> crate::replica::CreateVaultOperationRejectionCode {
    use crate::replica::CreateVaultOperationRejectionCode as Local;
    match code {
        WireVaultRejectionCode::VaultIdConflict => Local::VaultIdConflict,
        WireVaultRejectionCode::TeamMembershipRequired => Local::TeamMembershipRequired,
        WireVaultRejectionCode::VaultSharingEntitlementDenied => {
            Local::VaultSharingEntitlementDenied
        }
        WireVaultRejectionCode::SharedVaultLimitReached => Local::SharedVaultLimitReached,
    }
}

fn ordinary_item_outcome(
    operation: &OperationRecord,
    operation_id: String,
    kind: OperationKind,
    result: WireItemOperationResult,
) -> Option<(String, OperationKind, OperationOutcomeResult)> {
    if operation.kind != kind || operation.target.item_id().is_none() {
        return None;
    }
    let result = match result {
        WireItemOperationResult::Applied { item_id, version } => {
            if item_id != operation.item_id() || version < 1 {
                return None;
            }
            OperationOutcomeResult::Applied {
                entity_id: item_id,
                version,
            }
        }
        WireItemOperationResult::Rejected { code, .. } => {
            let code = rejection_code(code);
            if !rejection_allowed(kind, code) {
                return None;
            }
            OperationOutcomeResult::Rejected { code }
        }
    };
    Some((operation_id, kind, result))
}

fn rejection_allowed(kind: OperationKind, code: OperationRejectionCode) -> bool {
    use OperationKind::{
        MoveItem, PermanentlyDeleteItem, RestoreItem, SetItemFavorite, TrashItem, UpdateItem,
    };
    use OperationRejectionCode::{
        AttachmentStateConflict, InvalidCiphertext, ItemNotFound, ItemNotTrashed, ItemTrashed,
        ItemVersionConflict, SourceVaultMismatch, TargetVaultAccessDenied, TargetVaultReadOnly,
        VaultAccessDenied, VaultReadOnly,
    };

    match kind {
        UpdateItem => matches!(
            code,
            InvalidCiphertext
                | VaultAccessDenied
                | VaultReadOnly
                | ItemNotFound
                | ItemVersionConflict
        ),
        SetItemFavorite => matches!(
            code,
            VaultAccessDenied | VaultReadOnly | ItemNotFound | ItemVersionConflict
        ),
        TrashItem => matches!(
            code,
            InvalidCiphertext
                | VaultAccessDenied
                | VaultReadOnly
                | ItemNotFound
                | ItemVersionConflict
        ),
        RestoreItem | PermanentlyDeleteItem => matches!(
            code,
            InvalidCiphertext
                | VaultAccessDenied
                | VaultReadOnly
                | ItemNotFound
                | ItemNotTrashed
                | ItemVersionConflict
        ),
        MoveItem => matches!(
            code,
            InvalidCiphertext
                | VaultAccessDenied
                | VaultReadOnly
                | ItemNotFound
                | SourceVaultMismatch
                | ItemTrashed
                | TargetVaultAccessDenied
                | TargetVaultReadOnly
                | ItemVersionConflict
                | AttachmentStateConflict
        ),
        OperationKind::CreateVault
        | OperationKind::UpdateVault
        | OperationKind::DeleteVault
        | OperationKind::CreateItem
        | OperationKind::CreateShare
        | OperationKind::ImportItems
        | OperationKind::CreateVaultMemberRemovalRotationPlans
        | OperationKind::FinalizeVaultMemberRemovalRotationPlans
        | OperationKind::CreateTeamLeaveRotationPlans
        | OperationKind::FinalizeTeamLeaveRotationPlans
        | OperationKind::CreateTeamMemberRemovalRotationPlans
        | OperationKind::FinalizeTeamMemberRemovalRotationPlans => false,
    }
}

fn vault_mutation_outcome(
    operation: &OperationRecord,
    operation_id: String,
    kind: OperationKind,
    result: crate::server_contract::VaultMutationOperationResult,
) -> Option<(String, OperationKind, OperationOutcomeResult)> {
    if operation.kind != kind
        || !matches!(operation.target, crate::replica::ResourceRef::Vault { .. })
    {
        return None;
    }
    let result = match result {
        crate::server_contract::VaultMutationOperationResult::Applied { vault_id } => {
            if vault_id != operation.vault_id() {
                return None;
            }
            OperationOutcomeResult::VaultApplied { vault_id }
        }
        crate::server_contract::VaultMutationOperationResult::Rejected { code } => {
            let code = match code {
                crate::server_contract::VaultMutationOperationRejectionCode::VaultAccessDenied => {
                    crate::replica::VaultMutationOperationRejectionCode::VaultAccessDenied
                }
            };
            OperationOutcomeResult::VaultMutationRejected { code }
        }
    };
    Some((operation_id, kind, result))
}

fn import_rejection_code(
    code: crate::server_contract::ImportItemsOperationRejectionCode,
) -> crate::replica::ImportItemsOperationRejectionCode {
    use crate::replica::ImportItemsOperationRejectionCode as Local;
    match code {
        crate::server_contract::ImportItemsOperationRejectionCode::InvalidCiphertext => {
            Local::InvalidCiphertext
        }
        crate::server_contract::ImportItemsOperationRejectionCode::VaultAccessDenied => {
            Local::VaultAccessDenied
        }
        crate::server_contract::ImportItemsOperationRejectionCode::VaultReadOnly => {
            Local::VaultReadOnly
        }
        crate::server_contract::ImportItemsOperationRejectionCode::ItemIdConflict => {
            Local::ItemIdConflict
        }
    }
}

fn share_rejection_code(code: WireShareRejectionCode) -> OperationRejectionCode {
    match code {
        WireShareRejectionCode::ItemNotFound => OperationRejectionCode::ItemNotFound,
        WireShareRejectionCode::VaultReadOnly => OperationRejectionCode::VaultReadOnly,
        WireShareRejectionCode::ShareEntitlementDenied => {
            OperationRejectionCode::ShareEntitlementDenied
        }
        WireShareRejectionCode::ShareLimitReached => OperationRejectionCode::ShareLimitReached,
    }
}

pub(super) fn rejection_code(code: WireOperationRejectionCode) -> OperationRejectionCode {
    match code {
        WireOperationRejectionCode::InvalidCiphertext => OperationRejectionCode::InvalidCiphertext,
        WireOperationRejectionCode::VaultAccessDenied => OperationRejectionCode::VaultAccessDenied,
        WireOperationRejectionCode::VaultReadOnly => OperationRejectionCode::VaultReadOnly,
        WireOperationRejectionCode::ItemIdConflict => OperationRejectionCode::ItemIdConflict,
        WireOperationRejectionCode::ItemNotFound => OperationRejectionCode::ItemNotFound,
        WireOperationRejectionCode::ItemVersionConflict => {
            OperationRejectionCode::ItemVersionConflict
        }
        WireOperationRejectionCode::ItemTrashed => OperationRejectionCode::ItemTrashed,
        WireOperationRejectionCode::ItemNotTrashed => OperationRejectionCode::ItemNotTrashed,
        WireOperationRejectionCode::SourceVaultMismatch => {
            OperationRejectionCode::SourceVaultMismatch
        }
        WireOperationRejectionCode::TargetVaultAccessDenied => {
            OperationRejectionCode::TargetVaultAccessDenied
        }
        WireOperationRejectionCode::TargetVaultReadOnly => {
            OperationRejectionCode::TargetVaultReadOnly
        }
        WireOperationRejectionCode::AttachmentStateConflict => {
            OperationRejectionCode::AttachmentStateConflict
        }
    }
}

/// The Server's one structured way of saying "this Operation ID belongs to other bytes".
fn reused_operation_id(body: &[u8]) -> bool {
    serde_json::from_slice::<serde_json::Value>(body)
        .ok()
        .and_then(|problem| {
            problem
                .get("code")
                .and_then(serde_json::Value::as_str)
                .map(str::to_owned)
        })
        .is_some_and(|code| code == "OPERATION_ID_REUSED")
}

impl Runtime {
    fn current_item_authority_is_visible(
        &self,
        snapshot: &ReplicaSnapshot,
        item: &AuthorityItemRecord,
    ) -> bool {
        // Frozen ciphertext can finish while current policy is unknown. Its retained result
        // does not authorize installing freshly fetched Item authority during that interval.
        !self.travel_policy_verification_pending(snapshot)
            && snapshot.bootstrap.state == crate::replica::ReplicaState::Ready
            && !snapshot
                .bootstrap
                .pending_vault_retirements
                .contains(&item.vault_id)
            && snapshot
                .bootstrap
                .active_generation
                .as_ref()
                .is_some_and(|generation| {
                    snapshot
                        .bootstrap
                        .vaults
                        .contains_key(&(generation.clone(), item.vault_id.clone()))
                })
    }
}
