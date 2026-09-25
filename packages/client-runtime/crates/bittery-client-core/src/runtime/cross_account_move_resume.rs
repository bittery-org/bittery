//! Read-only preparation and explicit, stateless destination reauthorization.
use super::*;
use crate::protocol::CrossAccountMoveResumeGuard;
use crate::replica::{AuthorityAttachmentRecord, LegacyCrossAccountCompletionProof};

enum VerifiedResume {
    Continuation(Vec<AuthorityAttachmentRecord>),
    TrashedContinuation(Box<AuthorityItemRecord>),
    LegacyCompletion(Box<LegacyCrossAccountCompletionProof>),
}

impl Runtime {
    pub(in crate::runtime) async fn request_cross_account_move_resume(
        &self,
        request: RuntimeRequest,
        cancellation: RequestCancellation,
        accepted: impl FnOnce(),
    ) -> Result<RuntimeResponse, RuntimeError> {
        self.ensure_open()?;
        let (account_id, operation_id, target_account_id, expected_revision, confirmation) =
            match request {
                RuntimeRequest::PrepareCrossAccountMoveResume {
                    account_id,
                    operation_id,
                    target_account_id,
                    expected_binding_revision,
                } => (
                    account_id,
                    operation_id,
                    target_account_id,
                    expected_binding_revision,
                    None,
                ),
                RuntimeRequest::ResumeCrossAccountMove { guard } => (
                    guard.account_id.clone(),
                    guard.operation_id.clone(),
                    guard.target_account_id.clone(),
                    guard.binding_revision,
                    Some(guard),
                ),
                _ => return Err(move_error("Expected cross-Account Move Resume intent")),
            };
        if account_id == target_account_id || cancellation.is_cancelled() {
            return Err(move_error("Move Resume requires two current Accounts"));
        }
        let captured = self.require_snapshot(&account_id)?;
        let captured_record = captured
            .cross_account_moves
            .iter()
            .find(|record| record.operation_id() == operation_id)
            .and_then(|record| record.captured())
            .ok_or_else(|| move_error("The source Move is unavailable"))?;
        require_held_resume_shape(captured_record)?;
        let attachment_access = tokio::select! {
            biased;
            () = cancellation.cancelled() => return Err(RuntimeError::new(RuntimeErrorCode::Cancelled, "Move Resume cancelled")),
            result = attachments::AttachmentAccess::acquire(self, &captured, captured_record) => result?,
        };
        let mut accounts = [account_id.clone(), target_account_id.clone()];
        accounts.sort();
        let first = self.account_execution_lock(&accounts[0])?;
        let second = self.account_execution_lock(&accounts[1])?;
        let (_first, _second) = tokio::select! {
            biased;
            () = cancellation.cancelled() => return Err(RuntimeError::new(RuntimeErrorCode::Cancelled, "Move Resume cancelled")),
            () = attachments::lease_lost(attachment_access.as_ref()) => return Err(RuntimeError::new(RuntimeErrorCode::RetryableTransport, "Attachment Account lease was lost")),
            guards = async { (first.lock().await, second.lock().await) } => guards,
        };
        let source = self.require_snapshot(&account_id)?;
        let target = self.require_snapshot(&target_account_id)?;
        let record = source
            .cross_account_moves
            .iter()
            .find(|record| record.operation_id() == operation_id)
            .and_then(|record| record.captured())
            .ok_or_else(|| move_error("The source Move is unavailable"))?;
        require_held_resume_shape(record)?;
        if source.incarnation != captured.incarnation
            || record.attachments != captured_record.attachments
        {
            return Err(move_error("Move changed before Attachment validation"));
        }
        if record.destination_binding.binding_revision != expected_revision
            || record.destination_binding.status != CrossAccountMoveBindingStatus::Retired
            || matches!(
                record.stage,
                CrossAccountMoveStage::Completed | CrossAccountMoveStage::Rejected
            )
        {
            return Err(move_error(
                "Move Resume requires the exact retired destination binding",
            ));
        }
        let guard = CrossAccountMoveResumeGuard {
            account_id: account_id.clone(),
            source_incarnation: source.incarnation.clone(),
            source_lock_epoch: source.lock_epoch,
            target_account_id: target_account_id.clone(),
            target_incarnation: target.incarnation.clone(),
            target_lock_epoch: target.lock_epoch,
            operation_id: operation_id.clone(),
            binding_revision: expected_revision,
            source_replica_revision: source.revision,
            owner_incarnation: self.native_authority.owner_incarnation().into(),
        };
        if confirmation
            .as_ref()
            .is_some_and(|confirmation| confirmation != &guard)
        {
            return Err(move_error("Move Resume confirmation is stale"));
        }
        let attempt = Attempt {
            runtime: self,
            purpose: AttemptPurpose::DestinationReauthorization,
            source: &source,
            target: &target,
            record,
            cancellation: cancellation.clone(),
            attachment_access: attachment_access.as_ref(),
        };
        attempt.check().map_err(resume_failure)?;
        let _source_guard = self.foreground_attachments.register_target(
            &source.account_id,
            &source.incarnation,
            ForegroundAttachmentTarget::Item {
                vault_id: record.source.vault_id.clone(),
                item_id: record.source.id.clone(),
            },
            cancellation.clone(),
        )?;
        let _target_guard = self.foreground_attachments.register_target(
            &target.account_id,
            &target.incarnation,
            ForegroundAttachmentTarget::Item {
                vault_id: record.target.vault_id.clone(),
                item_id: record.target.id.clone(),
            },
            cancellation.clone(),
        )?;
        let verified = tokio::select! {
            biased;
            () = cancellation.cancelled() => return Err(RuntimeError::new(RuntimeErrorCode::Cancelled, "Move Resume authority was retired")),
            () = attachments::lease_lost(attachment_access.as_ref()) => { cancellation.cancel(); return Err(RuntimeError::new(RuntimeErrorCode::RetryableTransport, "Attachment Account lease was lost")); },
            result = attempt.verify_resume(confirmation.is_some()) => result.map_err(resume_failure)?,
        };
        attempt.check().map_err(resume_failure)?;
        if confirmation.is_none() {
            return Ok(RuntimeResponse::CrossAccountMoveResumePrepared { guard });
        }
        let mutation = match verified {
            VerifiedResume::Continuation(verified_attachments) => {
                PlanMutation::ReauthorizeCrossAccountMoveDestination {
                    operation_id: operation_id.clone(),
                    expected_binding_revision: expected_revision,
                    destination_account_id: target_account_id,
                    destination_incarnation: target.incarnation.clone(),
                    verified_attachments,
                }
            }
            VerifiedResume::TrashedContinuation(verified_source) => {
                PlanMutation::ReauthorizeLegacyCrossAccountMoveFromTrashedCache {
                    operation_id: operation_id.clone(),
                    expected_binding_revision: expected_revision,
                    destination_account_id: target_account_id,
                    destination_incarnation: target.incarnation.clone(),
                    verified_source,
                }
            }
            VerifiedResume::LegacyCompletion(verified_outcomes) => {
                PlanMutation::ReauthorizeAndCompleteLegacyCrossAccountMove {
                    operation_id: operation_id.clone(),
                    expected_binding_revision: expected_revision,
                    destination_account_id: target_account_id,
                    destination_incarnation: target.incarnation.clone(),
                    verified_outcomes,
                }
            }
        };
        let result = self
            .replica
            .execute_exact_while_current(
                GuardedCommitPlan::new(
                    account_id,
                    source.incarnation.clone(),
                    source.revision,
                    source.lock_epoch,
                    vec![mutation],
                ),
                || attempt.check().map_err(resume_failure),
            )
            .await?;
        let PlanResult::Applied { replica_revision } = result else {
            return Err(move_error(
                "Move Resume authority changed before acceptance",
            ));
        };
        attempt
            .check_after_commit(Some(replica_revision))
            .map_err(resume_failure)?;
        accepted();
        self.device_revision.fetch_add(1, Ordering::SeqCst);
        if record.is_legacy_held() {
            let _ = self.decrypt_visible_items(&source.account_id);
        }
        self.wake_dispatch();
        self.publish_all_unless_closed();
        if cancellation.is_cancelled() {
            return Err(RuntimeError::new(
                RuntimeErrorCode::Cancelled,
                "Move Resume cancelled after acceptance",
            ));
        }
        attempt
            .check_after_commit(Some(replica_revision))
            .map_err(resume_failure)?;
        Ok(RuntimeResponse::Accepted {
            operation_id,
            item_id: record.source.id.clone(),
            replica_revision,
        })
    }
}

fn require_held_resume_shape(record: &CrossAccountMoveRecord) -> Result<(), RuntimeError> {
    if record.is_legacy_held()
        && !record.supports_legacy_held_destination_reauthorization()
        && !record.supports_legacy_held_destination_completion()
    {
        return Err(move_error(
            "Stopped legacy Move requires its original target proof before reauthorization",
        ));
    }
    Ok(())
}

impl Attempt<'_> {
    /// A lookup is only a candidate hint. Explicit Resume may prove an already-decided child
    /// using its exact request; it never executes an undecided child or advances a workflow stage.
    async fn verify_resume(&self, prove_hints: bool) -> Result<VerifiedResume, MoveFailure> {
        self.verify_artifacts().await?;
        let mut source = self
            .endpoint(self.source, &self.record.source_identity)
            .await?;
        let mut target = self
            .endpoint(self.target, &self.record.destination_identity)
            .await?;
        let target_item = self
            .current(self.target, &self.record.target.id, &mut target)
            .await?;
        let source_item = self
            .current(self.source, &self.record.source.id, &mut source)
            .await?;
        let fresh_completion =
            self.record.supports_legacy_held_destination_completion() && source_item.is_none();
        // Only initial absence selects the full original completion candidates. Keep the same
        // requests through lookup, replay and both authority checks; final-read absence retries.
        let completion_children =
            if fresh_completion {
                Some(self.record.legacy_completion_candidates().map_err(|_| {
                    MoveFailure::Blocked(CrossAccountMoveBlockedReason::MissingProof)
                })?)
            } else {
                None
            };
        let children: Vec<_> = match &completion_children {
            Some(children) => children.iter().collect(),
            None => self
                .record
                .children
                .iter()
                .filter_map(CrossAccountMoveChild::item)
                .collect(),
        };
        let mut evidence = Vec::with_capacity(children.len());
        for child in &children {
            let outcome = match &child.result {
                Some(result)
                    if !(fresh_completion && child.step == CrossAccountMoveStep::SourceDelete) =>
                {
                    Some(result.clone())
                }
                _ => match child.endpoint {
                    CrossAccountMoveEndpoint::Source => {
                        self.lookup(self.source, child, &mut source).await?
                    }
                    CrossAccountMoveEndpoint::Destination => {
                        self.lookup(self.target, child, &mut target).await?
                    }
                },
            };
            if (fresh_completion
                && child.step == CrossAccountMoveStep::SourceDelete
                && child
                    .result
                    .as_ref()
                    .is_some_and(|retained| outcome.as_ref() != Some(retained)))
                || outcome.as_ref().is_some_and(|outcome| !applied(outcome))
            {
                return Err(MoveFailure::Blocked(
                    CrossAccountMoveBlockedReason::MissingProof,
                ));
            }
            evidence.push(outcome);
        }
        let mut verified = self.verify_resume_authority(
            target_item.as_ref(),
            source_item.as_ref(),
            &children,
            &evidence,
        )?;
        if prove_hints {
            for (child, outcome) in children.iter().zip(&evidence) {
                // Never use a GET hint as proof, and never send an undecided request here.
                if let (None, Some(hint)) = (&child.result, outcome) {
                    match child.endpoint {
                        CrossAccountMoveEndpoint::Source => {
                            self.send(self.source, child, Some(hint), &mut source)
                                .await?;
                        }
                        CrossAccountMoveEndpoint::Destination => {
                            self.send(self.target, child, Some(hint), &mut target)
                                .await?;
                        }
                    }
                }
            }
            let target_item = self
                .current(self.target, &self.record.target.id, &mut target)
                .await?;
            let source_item = self
                .current(self.source, &self.record.source.id, &mut source)
                .await?;
            verified = self.verify_resume_authority(
                target_item.as_ref(),
                source_item.as_ref(),
                &children,
                &evidence,
            )?;
        }
        self.check()?;
        Ok(verified)
    }

    fn verify_resume_authority(
        &self,
        target: Option<&AuthorityItemRecord>,
        source: Option<&AuthorityItemRecord>,
        children: &[&CrossAccountMoveItemOperation],
        evidence: &[Option<ObservedOutcome>],
    ) -> Result<VerifiedResume, MoveFailure> {
        let decided = |step: CrossAccountMoveStep| {
            children
                .iter()
                .zip(evidence)
                .any(|(child, outcome)| child.step == step && outcome.as_ref().is_some_and(applied))
        };
        let created = decided(CrossAccountMoveStep::TargetCreate);
        let trashed = decided(CrossAccountMoveStep::SourceTrash);
        let deleted = decided(CrossAccountMoveStep::SourceDelete);
        let target_matches = match target {
            Some(item) => created && same_item_metadata(item, &self.record.target, false),
            None => !created && self.record.stage == CrossAccountMoveStage::TargetCreate,
        };
        if !target_matches {
            return Err(MoveFailure::Blocked(if target.is_some() && !created {
                CrossAccountMoveBlockedReason::MissingProof
            } else {
                CrossAccountMoveBlockedReason::TargetChanged
            }));
        }
        let additions = match target {
            Some(item) => self.verify_target_attachments(Some(item), false)?,
            None => Vec::new(),
        };
        let completion = if self.record.supports_legacy_held_destination_completion()
            && source.is_none()
            && created
            && trashed
            && deleted
        {
            let proof = |step: CrossAccountMoveStep| {
                children
                    .iter()
                    .zip(evidence)
                    .find_map(|(child, outcome)| {
                        (child.step == step).then(|| outcome.clone()).flatten()
                    })
                    .ok_or(MoveFailure::Blocked(
                        CrossAccountMoveBlockedReason::MissingProof,
                    ))
            };
            Some(Box::new(LegacyCrossAccountCompletionProof {
                target_create: proof(CrossAccountMoveStep::TargetCreate)?,
                source_trash: proof(CrossAccountMoveStep::SourceTrash)?,
                source_delete: proof(CrossAccountMoveStep::SourceDelete)?,
            }))
        } else {
            None
        };
        if self.record.is_legacy_held()
            && completion.is_none()
            && !source.is_some_and(|item| {
                same_item(
                    item,
                    &self.record.source,
                    self.record.stage == CrossAccountMoveStage::SourceDelete,
                )
            })
        {
            return Err(MoveFailure::Blocked(
                CrossAccountMoveBlockedReason::SourceChanged,
            ));
        }
        let source_matches = match source {
            Some(item) => !deleted && same_item(item, &self.record.source, trashed),
            None => deleted,
        };
        if !source_matches {
            return Err(MoveFailure::Blocked(if source.is_none() && !deleted {
                CrossAccountMoveBlockedReason::MissingProof
            } else {
                CrossAccountMoveBlockedReason::SourceChanged
            }));
        }
        if let Some(outcome) = completion {
            return Ok(VerifiedResume::LegacyCompletion(outcome));
        }
        if self.record.stage == CrossAccountMoveStage::SourceDelete
            && self
                .record
                .supports_legacy_held_destination_reauthorization()
        {
            let cached = self
                .source
                .bootstrap
                .active_generation
                .as_ref()
                .and_then(|generation| {
                    self.source
                        .bootstrap
                        .items
                        .get(&(generation.clone(), self.record.source.id.clone()))
                });
            if cached != Some(&self.record.source) {
                let current = source.ok_or(MoveFailure::Blocked(
                    CrossAccountMoveBlockedReason::SourceChanged,
                ))?;
                if cached != Some(current) || !same_item(current, &self.record.source, true) {
                    return Err(MoveFailure::Blocked(
                        CrossAccountMoveBlockedReason::SourceChanged,
                    ));
                }
                // This function runs again after confirmation's final authority reads. Carry that
                // exact DTO to the guarded mutation; neither layer may synthesize a source overlay.
                return Ok(VerifiedResume::TrashedContinuation(Box::new(
                    current.clone(),
                )));
            }
        }
        Ok(VerifiedResume::Continuation(additions))
    }
}

fn resume_failure(failure: MoveFailure) -> RuntimeError {
    match failure {
        MoveFailure::Waiting(_) | MoveFailure::Retry => {
            move_error("Move Resume requires available current Server authority")
        }
        MoveFailure::Parked => move_error("Move Resume requires both current unlocked Accounts"),
        MoveFailure::Blocked(CrossAccountMoveBlockedReason::DestinationRetired) => {
            move_error("Move Resume requires the original Server and User")
        }
        MoveFailure::Blocked(CrossAccountMoveBlockedReason::SourceChanged) => {
            move_error("The source Item changed before Move Resume")
        }
        MoveFailure::Blocked(CrossAccountMoveBlockedReason::TargetChanged) => {
            move_error("The original target Item changed before Move Resume")
        }
        MoveFailure::Blocked(CrossAccountMoveBlockedReason::MissingProof) => {
            move_error("Move Resume has incomplete retained evidence")
        }
        MoveFailure::Blocked(CrossAccountMoveBlockedReason::MissingArtifact) => {
            move_error("Move Resume requires its original encrypted artifacts")
        }
    }
}
