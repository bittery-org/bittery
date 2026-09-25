use super::*;
#[path = "cross_account_move_attachments.rs"]
mod attachments;
#[path = "cross_account_move_resume.rs"]
mod resume;
use crate::auth_http::AuthenticatedOutcome;
use crate::replica::{
    cross_account_item_matches as same_item,
    cross_account_item_metadata_matches as same_item_metadata, CrossAccountMoveItemOperation,
};
use crate::runtime::dispatch::DispatchPass;
use crate::runtime::foreground_attachment_lifecycle::ForegroundAttachmentTarget;

enum MoveFailure {
    Retry,
    Waiting(CrossAccountMoveWaitingReason),
    Parked,
    Blocked(CrossAccountMoveBlockedReason),
}

struct Endpoint<'a> {
    http: AuthHttpClient<'a>,
    session: CurrentSessionDocument,
    budget: OutcomeResolutionAuthBudget,
}

#[derive(Clone, Copy)]
enum AttemptPurpose {
    Dispatch,
    DestinationReauthorization,
}

struct Attempt<'a> {
    runtime: &'a Runtime,
    purpose: AttemptPurpose,
    source: &'a ReplicaSnapshot,
    target: &'a ReplicaSnapshot,
    record: &'a CrossAccountMoveRecord,
    cancellation: RequestCancellation,
    attachment_access: Option<&'a attachments::AttachmentAccess>,
}

impl Runtime {
    pub(in crate::runtime) async fn dispatch_cross_account_move(
        &self,
        captured: &ReplicaSnapshot,
        operation_id: &str,
    ) -> DispatchPass {
        let Some(record) = captured
            .cross_account_moves
            .iter()
            .find(|row| row.operation_id() == operation_id)
            .and_then(|row| row.captured())
        else {
            return DispatchPass::Parked;
        };
        let attachment_access =
            match attachments::AttachmentAccess::acquire(self, captured, record).await {
                Ok(access) => access,
                Err(_) => return DispatchPass::WaitFor { milliseconds: 250 },
            };
        let mut accounts = [
            captured.account_id.clone(),
            record.destination_binding.account_id.clone(),
        ];
        accounts.sort();
        let (Ok(first), Ok(second)) = (
            self.account_execution_lock(&accounts[0]),
            self.account_execution_lock(&accounts[1]),
        ) else {
            return DispatchPass::Parked;
        };
        let (_first, _second) = tokio::select! {
            biased;
            () = attachments::lease_lost(attachment_access.as_ref()) => return DispatchPass::Parked,
            guards = async { (first.lock().await, second.lock().await) } => guards,
        };
        let Ok(source) = self.require_snapshot(&captured.account_id) else {
            return DispatchPass::Parked;
        };
        if source.incarnation != captured.incarnation {
            return DispatchPass::Parked;
        }
        let Some(record) = source
            .cross_account_moves
            .iter()
            .find(|row| row.operation_id() == operation_id)
            .and_then(|row| row.captured())
        else {
            return DispatchPass::Parked;
        };
        let Ok(target) = self.require_snapshot(&record.destination_binding.account_id) else {
            return DispatchPass::Parked;
        };
        if self
            .require_bound_cross_move_scope(record, &source, &target)
            .is_err()
            || matches!(
                record.stage,
                CrossAccountMoveStage::Completed | CrossAccountMoveStage::Rejected
            )
            || matches!(
                record.disposition,
                CrossAccountMoveDisposition::Blocked { .. }
            )
        {
            return DispatchPass::Parked;
        }
        let cancellation = RequestCancellation::new();
        let attempt = Attempt {
            runtime: self,
            purpose: AttemptPurpose::Dispatch,
            source: &source,
            target: &target,
            record,
            cancellation: cancellation.clone(),
            attachment_access: attachment_access.as_ref(),
        };
        if attempt.check().is_err() {
            return DispatchPass::Parked;
        }
        // These are registrations in the existing retirement owner, not another workflow registry.
        // Either participating Vault/Account can cancel the entire current attempt before teardown.
        let Ok(_source_guard) = self.foreground_attachments.register_target(
            &source.account_id,
            &source.incarnation,
            ForegroundAttachmentTarget::Item {
                vault_id: record.source.vault_id.clone(),
                item_id: record.source.id.clone(),
            },
            cancellation.clone(),
        ) else {
            return DispatchPass::Parked;
        };
        let Ok(_target_guard) = self.foreground_attachments.register_target(
            &target.account_id,
            &target.incarnation,
            ForegroundAttachmentTarget::Item {
                vault_id: record.target.vault_id.clone(),
                item_id: record.target.id.clone(),
            },
            cancellation.clone(),
        ) else {
            return DispatchPass::Parked;
        };
        let result = tokio::select! {
            biased;
            () = cancellation.cancelled() => return DispatchPass::Parked,
            () = attachments::lease_lost(attachment_access.as_ref()) => { cancellation.cancel(); return DispatchPass::Parked; },
            result = attempt.drive() => result,
        };
        if attempt.check().is_err() {
            return DispatchPass::Parked;
        }
        let (mut next, source_authority) = match result {
            Ok(value) => value,
            Err(MoveFailure::Parked) => return DispatchPass::Parked,
            Err(failure @ (MoveFailure::Retry | MoveFailure::Waiting(_))) => {
                let mut next = record.clone();
                next.scheduling.attempt_count = next.scheduling.attempt_count.saturating_add(1);
                next.scheduling.not_before_ms = self.clock.now_ms().unwrap_or(0).saturating_add(
                    crate::runtime::dispatch::backoff_ms(next.scheduling.attempt_count),
                );
                next.disposition = CrossAccountMoveDisposition::Waiting {
                    reason: match failure {
                        MoveFailure::Waiting(reason) => reason,
                        _ => CrossAccountMoveWaitingReason::Offline,
                    },
                };
                (next, CrossAccountMoveSourceAuthority::Unchanged)
            }
            Err(MoveFailure::Blocked(reason)) => {
                let mut next = record.clone();
                next.disposition = CrossAccountMoveDisposition::Blocked { reason };
                (next, CrossAccountMoveSourceAuthority::Unchanged)
            }
        };
        if !matches!(
            next.disposition,
            CrossAccountMoveDisposition::Waiting { .. }
        ) {
            next.scheduling.not_before_ms = 0;
        }
        if next.stage == CrossAccountMoveStage::Completed && !record.attachments.is_empty() {
            if let Some(lifecycle) = self
                .attachment_move_lifecycle
                .lock()
                .expect("Attachment lifecycle lock poisoned")
                .as_ref()
            {
                lifecycle.require_sweep(&source.account_id, &source.incarnation);
            }
            // Publish the cleanup duty before the terminal write: its reply can be lost.
            // The existing lifecycle acquires this source execution lock and rereads durable work.
            self.wake_dispatch();
        }
        let result = self
            .replica
            .execute_exact_while_current(
                GuardedCommitPlan::new(
                    source.account_id.clone(),
                    source.incarnation.clone(),
                    source.revision,
                    source.lock_epoch,
                    vec![PlanMutation::AdvanceCrossAccountMove {
                        operation_id: operation_id.into(),
                        expected_binding_revision: record.destination_binding.binding_revision,
                        next: Box::new(next),
                        source_authority,
                    }],
                ),
                || {
                    attempt.check().map_err(|_| {
                        RuntimeError::new(
                            RuntimeErrorCode::Cancelled,
                            "Move checkpoint scope is no longer current",
                        )
                    })
                },
            )
            .await;
        let applied_revision = match &result {
            Ok(PlanResult::Applied { replica_revision }) => Some(*replica_revision),
            _ => None,
        };
        if attempt.check_after_commit(applied_revision).is_err() {
            return DispatchPass::Parked;
        }
        match result {
            Ok(PlanResult::Applied { .. }) => {
                self.device_revision.fetch_add(1, Ordering::SeqCst);
                let _ = self.decrypt_visible_items(&source.account_id);
                self.publish_all_unless_closed();
                DispatchPass::Progressed
            }
            _ => DispatchPass::WaitFor {
                milliseconds: 1_000,
            },
        }
    }
}

impl<'a> Attempt<'a> {
    fn check(&self) -> Result<(), MoveFailure> {
        self.check_with_source(self.source)
    }

    fn check_after_commit(&self, applied_revision: Option<u64>) -> Result<(), MoveFailure> {
        let current = self
            .runtime
            .replica
            .snapshot(&self.source.account_id)
            .ok_or(MoveFailure::Parked)?;
        if current.incarnation != self.source.incarnation
            || current.lock_epoch != self.source.lock_epoch
            || applied_revision.is_some_and(|revision| current.revision != revision)
        {
            return Err(MoveFailure::Parked);
        }
        self.check_with_source(&current)
    }

    fn check_with_source(&self, source: &ReplicaSnapshot) -> Result<(), MoveFailure> {
        if self.cancellation.is_cancelled()
            || self
                .attachment_access
                .is_some_and(|access| !access.is_live())
        {
            return Err(MoveFailure::Parked);
        }
        self.runtime
            .require_cross_move_participants(self.record, source, self.target)
            .map_err(|_| MoveFailure::Parked)?;
        if matches!(self.purpose, AttemptPurpose::DestinationReauthorization) {
            self.runtime
                .require_cross_move_scope(source, &self.record.source.vault_id)
                .map_err(|_| MoveFailure::Parked)?;
            self.runtime
                .require_cross_move_scope(self.target, &self.record.target.vault_id)
                .map_err(|_| MoveFailure::Parked)?;
            // After the atomic commit, the current row owns its newly restored overlay.
            let owner = source
                .cross_account_moves
                .iter()
                .find(|record| record.operation_id() == self.record.operation_id)
                .and_then(|record| record.captured())
                .ok_or(MoveFailure::Parked)?;
            if source.cross_account_move_has_conflicting_source_owner(owner) {
                return Err(MoveFailure::Blocked(
                    CrossAccountMoveBlockedReason::SourceChanged,
                ));
            }
        }
        if self
            .target
            .item_has_optimistic_owner(&self.record.target.id)
        {
            return Err(MoveFailure::Blocked(
                CrossAccountMoveBlockedReason::TargetChanged,
            ));
        }
        Ok(())
    }

    async fn endpoint(
        &self,
        snapshot: &ReplicaSnapshot,
        identity: &CrossAccountMoveIdentity,
    ) -> Result<Endpoint<'a>, MoveFailure> {
        let metadata = self
            .runtime
            .platform_storage
            .load_account_metadata(&snapshot.account_id, &snapshot.incarnation)
            .await
            .map_err(|_| MoveFailure::Retry)?
            .ok_or(MoveFailure::Parked)?;
        self.check()?;
        if metadata.normalized_server_url != identity.server_url
            || snapshot.user_id != identity.user_id
        {
            return Err(MoveFailure::Blocked(
                CrossAccountMoveBlockedReason::DestinationRetired,
            ));
        }
        let session = self
            .runtime
            .effective_session(&snapshot.account_id, &snapshot.incarnation)
            .await
            .map_err(|_| MoveFailure::Retry)?
            .ok_or(MoveFailure::Parked)?;
        self.check()?;
        let config = self
            .runtime
            .auth_client_config
            .clone()
            .ok_or(MoveFailure::Parked)?;
        let http = AuthHttpClient::new(
            &self.runtime.http_transport,
            &metadata.normalized_server_url,
            metadata.insecure_transport_confirmed,
            config,
        )
        .map_err(|_| MoveFailure::Parked)?;
        Ok(Endpoint {
            http,
            session,
            budget: OutcomeResolutionAuthBudget::default(),
        })
    }

    async fn current(
        &self,
        snapshot: &ReplicaSnapshot,
        item_id: &str,
        endpoint: &mut Endpoint<'_>,
    ) -> Result<Option<AuthorityItemRecord>, MoveFailure> {
        let current = self
            .runtime
            .fetch_authoritative_item(
                &snapshot.account_id,
                item_id,
                &endpoint.http,
                &mut endpoint.session,
                &mut endpoint.budget,
            )
            .await
            .map_err(completion_failure)?;
        self.check()?;
        match current {
            CurrentAuthority::Absent => Ok(None),
            CurrentAuthority::Unavailable => Err(MoveFailure::Parked),
            CurrentAuthority::Present(mut item) => {
                item.attachments = self
                    .runtime
                    .fetch_authoritative_attachments(
                        &snapshot.account_id,
                        item_id,
                        &item,
                        &endpoint.http,
                        &mut endpoint.session,
                        &mut endpoint.budget,
                        snapshot,
                    )
                    .await
                    .map_err(completion_failure)?;
                self.check()?;
                item.attachments.sort_by(|a, b| a.id.cmp(&b.id));
                Ok(Some(item))
            }
        }
    }

    async fn lookup(
        &self,
        snapshot: &ReplicaSnapshot,
        child: &CrossAccountMoveItemOperation,
        endpoint: &mut Endpoint<'_>,
    ) -> Result<Option<ObservedOutcome>, MoveFailure> {
        let operation = child_operation(child, &self.record.source.category);
        let answer = self
            .runtime
            .lookup_operation_outcome(
                &snapshot.account_id,
                &operation,
                &endpoint.http,
                &mut endpoint.session,
                &mut endpoint.budget,
            )
            .await;
        self.check()?;
        let hint = semantic(answer)?;
        if self.record.is_legacy_held() {
            let Some(proof) = hint.as_ref() else {
                if matches!(self.purpose, AttemptPurpose::DestinationReauthorization)
                    && (matches!(
                        (&self.record.stage, &child.step),
                        (
                            CrossAccountMoveStage::SourceTrash,
                            CrossAccountMoveStep::SourceTrash
                        ) | (
                            CrossAccountMoveStage::SourceDelete,
                            CrossAccountMoveStep::SourceDelete
                        )
                    ) || (self.record.stage == CrossAccountMoveStage::TargetCreate
                        && child.step == CrossAccountMoveStep::TargetCreate
                        && child.result.is_none()))
                {
                    // Confirmation may authorize this fixed future request after checking authority.
                    // It cannot send it; the held send guard still requires an actual hint.
                    return Ok(None);
                }
                return Err(MoveFailure::Parked);
            };
            if applied(proof) && !self.original_applied_proof(child, Some(proof)) {
                return Err(MoveFailure::Blocked(
                    CrossAccountMoveBlockedReason::MissingProof,
                ));
            }
        }
        Ok(hint)
    }

    fn can_recover_legacy_progress(&self) -> bool {
        self.record.legacy_admission.is_some()
            && self.record.attachments.is_empty()
            && self.record.destination_binding.binding_revision == 0
    }

    fn legacy_source_progressed(&self, current: Option<&AuthorityItemRecord>) -> bool {
        self.can_recover_legacy_progress()
            && current.is_none_or(|item| same_item(item, &self.record.source, true))
    }

    fn original_applied_proof(
        &self,
        child: &CrossAccountMoveItemOperation,
        proof: Option<&ObservedOutcome>,
    ) -> bool {
        let Some(ObservedOutcome {
            result: OperationOutcomeResult::Applied { entity_id, version },
            ..
        }) = proof
        else {
            return false;
        };
        let expected_version = match child.step {
            CrossAccountMoveStep::TargetCreate => 1,
            CrossAccountMoveStep::SourceTrash => self.record.source.version + 1,
            CrossAccountMoveStep::SourceDelete => self.record.source.version + 2,
        };
        child.target.item_id() == Some(entity_id) && *version == expected_version
    }

    async fn send(
        &self,
        snapshot: &ReplicaSnapshot,
        child: &CrossAccountMoveItemOperation,
        hint: Option<&ObservedOutcome>,
        endpoint: &mut Endpoint<'_>,
    ) -> Result<ObservedOutcome, MoveFailure> {
        self.check()?;
        if self.record.is_legacy_held() && hint.is_none() {
            return Err(MoveFailure::Parked);
        }
        let mut answer = endpoint
            .http
            .dispatch_operation(
                endpoint.session.token.as_ref(),
                &child.operation_id,
                &child.request,
                self.cancellation.clone(),
            )
            .await;
        self.check()?;
        if matches!(answer, Ok(AuthenticatedOutcome::ReauthenticationRequired)) {
            if !endpoint.budget.consume_renewal() {
                return Err(MoveFailure::Parked);
            }
            endpoint.session = self
                .runtime
                .renew_session(
                    &snapshot.account_id,
                    &endpoint.session,
                    &endpoint.http,
                    self.cancellation.clone(),
                )
                .await
                .map_err(|_| MoveFailure::Parked)?;
            self.check()?;
            answer = endpoint
                .http
                .dispatch_operation(
                    endpoint.session.token.as_ref(),
                    &child.operation_id,
                    &child.request,
                    self.cancellation.clone(),
                )
                .await;
            self.check()?;
        }
        let answer = match answer {
            Ok(AuthenticatedOutcome::Ok(answer)) => answer,
            Ok(AuthenticatedOutcome::ReauthenticationRequired) => return Err(MoveFailure::Parked),
            _ => return Err(MoveFailure::Retry),
        };
        let outcome = semantic(self.runtime.read_dispatch_answer(
            &child_operation(child, &self.record.source.category),
            answer.status,
            &answer.body,
        ))?
        .ok_or(MoveFailure::Retry)?;
        if hint.is_some_and(|hint| hint != &outcome) {
            return Err(MoveFailure::Blocked(
                CrossAccountMoveBlockedReason::MissingProof,
            ));
        }
        match &outcome.result {
            OperationOutcomeResult::Applied { .. } => {
                if !self.original_applied_proof(child, Some(&outcome)) {
                    return Err(MoveFailure::Blocked(
                        CrossAccountMoveBlockedReason::MissingProof,
                    ));
                }
            }
            OperationOutcomeResult::Rejected { .. } => {}
            _ => {
                return Err(MoveFailure::Blocked(
                    CrossAccountMoveBlockedReason::MissingProof,
                ));
            }
        }
        Ok(outcome)
    }

    async fn drive(
        &self,
    ) -> Result<(CrossAccountMoveRecord, CrossAccountMoveSourceAuthority), MoveFailure> {
        let mut source = self
            .endpoint(self.source, &self.record.source_identity)
            .await?;
        let mut target = self
            .endpoint(self.target, &self.record.destination_identity)
            .await?;
        let mut next = self.record.clone();
        next.disposition = CrossAccountMoveDisposition::Ready;
        let target_item = self
            .current(self.target, &self.record.target.id, &mut target)
            .await?;
        match self.record.stage {
            CrossAccountMoveStage::TargetCreate => {
                let source_item = self
                    .current(self.source, &self.record.source.id, &mut source)
                    .await?;
                let progressed = self.legacy_source_progressed(source_item.as_ref());
                if !source_item
                    .as_ref()
                    .is_some_and(|item| same_item(item, &self.record.source, false))
                    && !progressed
                {
                    return Err(MoveFailure::Blocked(
                        CrossAccountMoveBlockedReason::SourceChanged,
                    ));
                }
                if progressed
                    && !target_item
                        .as_ref()
                        .is_some_and(|item| same_item(item, &self.record.target, false))
                {
                    return Err(MoveFailure::Blocked(
                        CrossAccountMoveBlockedReason::TargetChanged,
                    ));
                }
                let index = child_index(self.record, &CrossAccountMoveStep::TargetCreate)?;
                let child = self.record.children[index]
                    .item()
                    .ok_or(MoveFailure::Blocked(
                        CrossAccountMoveBlockedReason::MissingProof,
                    ))?;
                if child.result.is_none() {
                    let hint = self.lookup(self.target, child, &mut target).await?;
                    if progressed && !self.original_applied_proof(child, hint.as_ref()) {
                        return Err(MoveFailure::Blocked(
                            CrossAccountMoveBlockedReason::MissingProof,
                        ));
                    }
                    match &target_item {
                        Some(item) if !same_item(item, &self.record.target, false) => {
                            return Err(MoveFailure::Blocked(
                                CrossAccountMoveBlockedReason::TargetChanged,
                            ));
                        }
                        Some(_) if hint.is_none() => {
                            return Err(MoveFailure::Blocked(
                                CrossAccountMoveBlockedReason::MissingProof,
                            ));
                        }
                        None if hint.as_ref().is_some_and(applied) => {
                            return Err(MoveFailure::Blocked(
                                CrossAccountMoveBlockedReason::TargetChanged,
                            ));
                        }
                        _ => {}
                    }
                    let outcome = self
                        .send(self.target, child, hint.as_ref(), &mut target)
                        .await?;
                    if retain_child_result(&mut next, index, outcome)? {
                        return Ok((next, CrossAccountMoveSourceAuthority::Unchanged));
                    }
                }
                // Retain the exact result before the next current-authority decision. It cannot
                // install the target locally or by itself authorize source destruction.
                next.stage = if next.attachments.is_empty() {
                    CrossAccountMoveStage::SourceTrash
                } else {
                    CrossAccountMoveStage::Attachments { next_index: 0 }
                };
            }
            CrossAccountMoveStage::SourceTrash | CrossAccountMoveStage::SourceDelete => {
                self.verify_target_attachments(target_item.as_ref(), true)?;
                let delete = self.record.stage == CrossAccountMoveStage::SourceDelete;
                let step = if delete {
                    CrossAccountMoveStep::SourceDelete
                } else {
                    CrossAccountMoveStep::SourceTrash
                };
                let current = self
                    .current(self.source, &self.record.source.id, &mut source)
                    .await?;
                let index = self
                    .record
                    .children
                    .iter()
                    .position(|child| child.item().is_some_and(|item| item.step == step));
                let Some(index) = index else {
                    if !current
                        .as_ref()
                        .is_some_and(|item| same_item(item, &self.record.source, delete))
                        && !self.legacy_source_progressed(current.as_ref())
                    {
                        return Err(MoveFailure::Blocked(
                            CrossAccountMoveBlockedReason::SourceChanged,
                        ));
                    }
                    next.children
                        .push(source_child(self.record, delete).map_err(|_| {
                            MoveFailure::Blocked(CrossAccountMoveBlockedReason::MissingProof)
                        })?);
                    return Ok((next, CrossAccountMoveSourceAuthority::Unchanged));
                };
                let child = self.record.children[index]
                    .item()
                    .ok_or(MoveFailure::Blocked(
                        CrossAccountMoveBlockedReason::MissingProof,
                    ))?;
                if !delete
                    && child.result.is_some()
                    && self.can_recover_legacy_progress()
                    && !self.legacy_source_progressed(current.as_ref())
                {
                    return Err(MoveFailure::Blocked(
                        CrossAccountMoveBlockedReason::SourceChanged,
                    ));
                }
                if child.result.is_none() {
                    let hint = self.lookup(self.source, child, &mut source).await?;
                    let source_matches = current
                        .as_ref()
                        .is_some_and(|item| same_item(item, &self.record.source, delete));
                    // Progressed authority permits only a proved replay. In particular, absence
                    // cannot authorize a new Trash, nor can another child's version supply proof.
                    if !source_matches
                        && self.legacy_source_progressed(current.as_ref())
                        && !self.original_applied_proof(child, hint.as_ref())
                    {
                        return Err(MoveFailure::Blocked(
                            CrossAccountMoveBlockedReason::MissingProof,
                        ));
                    }
                    let proved_prior_effect = hint.as_ref().is_some_and(applied)
                        && if delete {
                            current.is_none()
                        } else {
                            current
                                .as_ref()
                                .is_some_and(|item| same_item(item, &self.record.source, true))
                                || (self.can_recover_legacy_progress() && current.is_none())
                        };
                    if !source_matches && !proved_prior_effect {
                        return Err(MoveFailure::Blocked(if current.is_none() {
                            CrossAccountMoveBlockedReason::MissingProof
                        } else {
                            CrossAccountMoveBlockedReason::SourceChanged
                        }));
                    }
                    let outcome = self
                        .send(self.source, child, hint.as_ref(), &mut source)
                        .await?;
                    if retain_child_result(&mut next, index, outcome)? {
                        return Ok((next, CrossAccountMoveSourceAuthority::Unchanged));
                    }
                    if delete {
                        // Preserve the proved destructive result before any subsequent read can
                        // fail or discover changed authority. The next pass proves current absence.
                        return Ok((next, CrossAccountMoveSourceAuthority::Unchanged));
                    }
                }
                if delete {
                    // A lost delete result is proved by its original child; absence is only the
                    // subsequent authority check and never a substitute for that result.
                    if self
                        .current(self.source, &self.record.source.id, &mut source)
                        .await?
                        .is_some()
                    {
                        return Err(MoveFailure::Blocked(
                            CrossAccountMoveBlockedReason::SourceChanged,
                        ));
                    }
                    next.stage = CrossAccountMoveStage::Completed;
                    return Ok((next, CrossAccountMoveSourceAuthority::Absent));
                }
                next.stage = CrossAccountMoveStage::SourceDelete;
            }
            CrossAccountMoveStage::Attachments { next_index } => {
                return self
                    .drive_attachment(next_index, target_item.as_ref(), &mut source, &mut target)
                    .await;
            }
            CrossAccountMoveStage::Completed | CrossAccountMoveStage::Rejected => {
                return Err(MoveFailure::Parked);
            }
        }
        Ok((next, CrossAccountMoveSourceAuthority::Unchanged))
    }
}

fn completion_failure(result: CompletionResult) -> MoveFailure {
    match result {
        CompletionResult::Retry => MoveFailure::Retry,
        _ => MoveFailure::Parked,
    }
}

fn semantic(answer: SemanticAnswer) -> Result<Option<ObservedOutcome>, MoveFailure> {
    match answer {
        SemanticAnswer::Outcome(outcome) => Ok(Some(outcome)),
        SemanticAnswer::Undecided => Ok(None),
        SemanticAnswer::Transient => Err(MoveFailure::Retry),
        SemanticAnswer::ReauthenticationRequired => Err(MoveFailure::Parked),
        SemanticAnswer::IdentityReused => Err(MoveFailure::Blocked(
            CrossAccountMoveBlockedReason::MissingProof,
        )),
    }
}

fn applied(outcome: &ObservedOutcome) -> bool {
    matches!(outcome.result, OperationOutcomeResult::Applied { .. })
}

fn retain_child_result(
    record: &mut CrossAccountMoveRecord,
    index: usize,
    outcome: ObservedOutcome,
) -> Result<bool, MoveFailure> {
    let rejected = if let OperationOutcomeResult::Rejected { code } = &outcome.result {
        record.stage = CrossAccountMoveStage::Rejected;
        record.disposition = CrossAccountMoveDisposition::Rejected { code: *code };
        true
    } else {
        false
    };
    let child = record.children[index]
        .item_mut()
        .ok_or(MoveFailure::Blocked(
            CrossAccountMoveBlockedReason::MissingProof,
        ))?;
    child.result = Some(outcome);
    Ok(rejected)
}

fn child_index(
    record: &CrossAccountMoveRecord,
    step: &CrossAccountMoveStep,
) -> Result<usize, MoveFailure> {
    record
        .children
        .iter()
        .position(|child| child.item().is_some_and(|item| &item.step == step))
        .ok_or(MoveFailure::Blocked(
            CrossAccountMoveBlockedReason::MissingProof,
        ))
}

fn child_operation(
    child: &CrossAccountMoveItemOperation,
    category: &crate::replica::AuthorityItemCategory,
) -> OperationRecord {
    let mut operation = OperationRecord {
        operation_id: child.operation_id.clone(),
        kind: child.kind,
        target: child.target.clone(),
        request: child.request.clone(),
        request_fingerprint: child.request_fingerprint,
        accepted_item_category: None,
        attachment_move_recovery: None,
        update_vault: None,
        create_vault: None,
        scheduling: OperationSchedulingState::default(),
        legacy_admission: None,
    };
    operation.accepted_item_category = Some(category.clone());
    operation
}
