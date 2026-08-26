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
    auth_http::AuthenticatedOutcome,
    platform_storage::CurrentSessionDocument,
    replica::{
        AuthorityItemRecord, CursorAdvance, ObservedOutcome, OperationKind, OperationOutcomeResult,
        OperationRejectionCode, ReplicaSnapshot, SyncCursor,
    },
    server_contract::{
        CreateShareOperationRejectionCode as WireShareRejectionCode,
        CreateShareOperationResult as WireCreateShareOperationResult,
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
    /// The Server answered this Operation ID for other request bytes, or for another entity.
    ///
    /// That is identity reuse. It is neither a retry nor a replay, and the only safe response is
    /// to fail the Account module rather than to guess which request the answer belongs to.
    IdentityReused,
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
            let Ok(renewed) = self
                .renew_session(account_id, session, http, cancellation.clone())
                .await
            else {
                return SemanticAnswer::Transient;
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
            Ok(AuthenticatedOutcome::ReauthenticationRequired)
            | Ok(AuthenticatedOutcome::Transient)
            | Err(_) => SemanticAnswer::Transient,
        }
    }

    /// Completes one Operation against its authoritative outcome.
    ///
    /// For an applied create the authoritative Item is fetched first, outside any transaction,
    /// and only then does one plan write authority, remove the Operation and its overlay, insert
    /// the compact receipt, and advance a matching exact Cursor. A fetch or commit failure leaves
    /// every one of those unchanged.
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
        self.complete_operation_with_fence(
            account_id, operation, outcome, http, session, cursor, false,
        )
        .await
    }

    /// Dispatch already owns the Account execution fence across Session use and reconciliation.
    pub(super) async fn complete_operation_fenced(
        &self,
        account_id: &AccountId,
        operation: &OperationRecord,
        outcome: ObservedOutcome,
        http: &AuthHttpClient<'_>,
        session: &mut CurrentSessionDocument,
        cursor: Option<CursorAdvance>,
    ) -> CompletionResult {
        self.complete_operation_with_fence(
            account_id, operation, outcome, http, session, cursor, true,
        )
        .await
    }

    #[allow(
        clippy::too_many_arguments,
        reason = "the fence mode preserves one reconciliation path for dispatch and Sync"
    )]
    async fn complete_operation_with_fence(
        &self,
        account_id: &AccountId,
        operation: &OperationRecord,
        outcome: ObservedOutcome,
        http: &AuthHttpClient<'_>,
        session: &mut CurrentSessionDocument,
        cursor: Option<CursorAdvance>,
        fence_already_held: bool,
    ) -> CompletionResult {
        let observed = outcome.clone();
        let mutation = match &outcome.result {
            OperationOutcomeResult::Applied { entity_id, version } => {
                let item = match self
                    .fetch_authoritative_item(account_id, entity_id, http, session)
                    .await
                {
                    Ok(Some(item)) => item,
                    Ok(None) => return CompletionResult::Retry,
                    Err(result) => return result,
                };
                if item.id != operation.item_id
                    || item.vault_id != operation.vault_id
                    || item.version != *version
                {
                    // The Server's own outcome and its own Item disagree. Reading further would
                    // be guessing, and this Runtime does not guess about authority.
                    return if fence_already_held {
                        self.fail_account_module_fenced(account_id).await
                    } else {
                        self.fail_account_module(account_id).await
                    };
                }
                PlanMutation::ReconcileAppliedCreate {
                    outcome,
                    item: Box::new(item),
                    cursor,
                }
            }
            OperationOutcomeResult::ShareApplied { .. } => {
                PlanMutation::ReconcileShareOutcome { outcome, cursor }
            }
            OperationOutcomeResult::Rejected { .. } => {
                if operation.kind == OperationKind::CreateShare {
                    PlanMutation::ReconcileShareOutcome { outcome, cursor }
                } else {
                    PlanMutation::RetainRejection { outcome, cursor }
                }
            }
        };
        if fence_already_held {
            self.commit_completion_fenced(account_id, &observed, mutation)
                .await
        } else {
            self.commit_completion(account_id, &observed, mutation)
                .await
        }
    }

    /// Fetches the authoritative encrypted Item, renewing one expired Session on the way.
    async fn fetch_authoritative_item(
        &self,
        account_id: &AccountId,
        item_id: &str,
        http: &AuthHttpClient<'_>,
        session: &mut CurrentSessionDocument,
    ) -> Result<Option<AuthorityItemRecord>, CompletionResult> {
        let cancellation = RequestCancellation::new();
        let mut fetched = http
            .fetch_item(session.token.as_ref(), item_id, cancellation.clone())
            .await;
        if matches!(fetched, Ok(AuthenticatedOutcome::ReauthenticationRequired)) {
            match self
                .renew_session(account_id, session, http, cancellation.clone())
                .await
            {
                Ok(renewed) => {
                    *session = renewed;
                    fetched = http
                        .fetch_item(session.token.as_ref(), item_id, cancellation)
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
            Ok(AuthenticatedOutcome::Ok(item)) => match authority_item_from_dto(item) {
                Ok(item) => Ok(Some(item)),
                Err(_) => Ok(None),
            },
            Ok(AuthenticatedOutcome::ReauthenticationRequired) => {
                self.mark_reauthentication_required(account_id);
                Err(CompletionResult::Reauthenticate)
            }
            Ok(AuthenticatedOutcome::Transient) | Err(_) => Ok(None),
        }
    }

    /// Commits the one plan that ends an Operation, and republishes what a reader can now see.
    async fn commit_completion(
        &self,
        account_id: &AccountId,
        observed: &ObservedOutcome,
        mutation: PlanMutation,
    ) -> CompletionResult {
        // The completion reads and writes the Replica head, the Operation, its overlay, and the
        // Bootstrap authority together, so it takes the same Account execution lock every other
        // whole-Account transition takes.
        let Ok(execution_lock) = self.account_execution_lock(account_id) else {
            return CompletionResult::Retry;
        };
        let _execution_guard = execution_lock.lock().await;
        if self.is_closed() {
            return CompletionResult::Retry;
        }
        self.commit_completion_fenced(account_id, observed, mutation)
            .await
    }

    async fn commit_completion_fenced(
        &self,
        account_id: &AccountId,
        observed: &ObservedOutcome,
        mutation: PlanMutation,
    ) -> CompletionResult {
        if self.is_closed() {
            return CompletionResult::Retry;
        }
        let Some(snapshot) = self.replica.snapshot(account_id) else {
            return CompletionResult::Retry;
        };
        // Another sender may already have completed this Operation. A matching receipt is the
        // proof, and it makes a duplicate completion a no-op rather than a second transaction.
        if let Some(receipt) = snapshot
            .receipts
            .iter()
            .find(|receipt| receipt.operation_id == observed.operation_id)
        {
            if receipt.request_fingerprint == observed.request_fingerprint
                && receipt.result == observed.result
            {
                return CompletionResult::Completed;
            }
            // A matching semantic outcome is immutable, so a different one for the same
            // identity is not an update; it is a contradiction.
            return self.fail_account_module_fenced(account_id).await;
        }
        match snapshot
            .operations
            .iter()
            .find(|operation| operation.operation_id == observed.operation_id)
        {
            // The durable fingerprint is the last word on which bytes this outcome answered.
            Some(operation) if operation.request_fingerprint != observed.request_fingerprint => {
                return self.fail_account_module_fenced(account_id).await;
            }
            Some(_) => {}
            // The Operation is gone without a receipt, which only Account removal or a
            // replacement incarnation can do. Nothing is owed here any more.
            None => return CompletionResult::Retry,
        }
        let result = self
            .replica
            .execute_recomputing(GuardedCommitPlan::new(
                account_id.clone(),
                snapshot.incarnation.clone(),
                snapshot.revision,
                snapshot.lock_epoch,
                vec![mutation],
            ))
            .await;
        match result {
            Ok(RecomputedPlanResult::Applied { snapshot }) => {
                let publication = self.publication.lock().expect("publication lock poisoned");
                self.replica.cache(snapshot);
                self.device_revision.fetch_add(1, Ordering::SeqCst);
                drop(publication);
                let _ = self.decrypt_visible_items(account_id);
                self.publish_all_unless_closed();
                CompletionResult::Completed
            }
            // A fenced or removed Account keeps every durable row it still has. Nothing here may
            // reverse a Server effect, so the Operation simply stays owed until it can commit.
            Ok(RecomputedPlanResult::Fenced { .. }) | Ok(RecomputedPlanResult::Missing) => {
                CompletionResult::Retry
            }
            // A persistence failure is a failure to write, never a semantic verdict. Everything
            // this plan would have moved is still exactly where it was.
            Err(_) => CompletionResult::Retry,
        }
    }

    /// Marks the Account module failed, durably, and stops working on it.
    ///
    /// Failing keeps every local record. It is the opposite of a discard: the Runtime refuses to
    /// act rather than inventing an outcome, and a Server effect is neither cancelled nor
    /// reversed by it.
    pub(super) async fn fail_account_module(&self, account_id: &AccountId) -> CompletionResult {
        let Ok(execution_lock) = self.account_execution_lock(account_id) else {
            return CompletionResult::Failed;
        };
        let _execution_guard = execution_lock.lock().await;
        self.fail_account_module_fenced(account_id).await
    }

    pub(super) async fn fail_account_module_fenced(
        &self,
        account_id: &AccountId,
    ) -> CompletionResult {
        let Some(snapshot) = self.replica.snapshot(account_id) else {
            return CompletionResult::Failed;
        };
        if snapshot.failure.is_some() {
            return CompletionResult::Failed;
        }
        if let Ok(RecomputedPlanResult::Applied { snapshot }) = self
            .replica
            .execute_recomputing(GuardedCommitPlan::new(
                account_id.clone(),
                snapshot.incarnation.clone(),
                snapshot.revision,
                snapshot.lock_epoch,
                vec![PlanMutation::FailAccount {
                    code: RuntimeErrorCode::InvariantViolation,
                }],
            ))
            .await
        {
            let publication = self.publication.lock().expect("publication lock poisoned");
            self.replica.cache(snapshot);
            self.device_revision.fetch_add(1, Ordering::SeqCst);
            drop(publication);
            self.publish_all_unless_closed();
        }
        CompletionResult::Failed
    }

    /// Completes one Operation because the Sync feed says the Server resolved it.
    ///
    /// The feed carries identity, never the decision, so the outcome is still read from the
    /// Server. The event's Cursor rides along in the same reconciliation plan: the Operation and
    /// the Cursor step past it become durable together, or neither does.
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
        next_cursor: Option<SyncCursor>,
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
            next_cursor,
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
        next_cursor: Option<SyncCursor>,
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
            // Another Device's Operation, or one this Device already completed.
            return CompletionResult::Completed;
        };
        let cursor = Self::cursor_advance(&snapshot, next_cursor);
        match self
            .lookup_operation_outcome(account_id, &operation, http, session)
            .await
        {
            SemanticAnswer::Outcome(outcome) => {
                if operation.kind == OperationKind::CreateShare {
                    // The lookup cannot prove the Share request fingerprint. Sync is a reader
                    // and must not turn the hint into the POST that proves it while production
                    // CreateShare dispatch remains gated for the atomic cutover.
                    return CompletionResult::Retry;
                }
                self.complete_operation_fenced(
                    account_id, &operation, outcome, http, session, cursor,
                )
                .await
            }
            SemanticAnswer::IdentityReused => self.fail_account_module_fenced(account_id).await,
            SemanticAnswer::Undecided | SemanticAnswer::Transient => CompletionResult::Retry,
        }
    }

    /// The Cursor step a Sync event supplies, taken only from the Cursor that event followed.
    pub(super) fn cursor_advance(
        snapshot: &ReplicaSnapshot,
        next: Option<SyncCursor>,
    ) -> Option<CursorAdvance> {
        next.map(|next| CursorAdvance {
            expected: snapshot.bootstrap.active_cursor.clone(),
            next,
        })
    }
}

/// Reads one wire outcome as this Operation's outcome, or refuses it.
///
/// The lookup route answers one union tagged on `kind`, so the first thing that happens here is
/// the check the contract was designed for: does the kind the Server answered match the kind this
/// Device durably accepted? A `kind` this Runtime does not carry fails to deserialize; a `kind` it
/// carries but did not ask for is identity reuse. Neither is ever read as this Operation's answer.
fn observed_outcome(operation: &OperationRecord, outcome: WireOperationOutcome) -> SemanticAnswer {
    let (operation_id, expected_kind, result) = match outcome {
        WireOperationOutcome::CreateItem {
            operation_id,
            result,
        } => {
            let result = match result {
                WireItemOperationResult::Applied { item_id, version } => {
                    if item_id != operation.item_id || version < 1 {
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
        _ => {
            // Another kind under this ID answers work this Device never accepted.
            return SemanticAnswer::IdentityReused;
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
