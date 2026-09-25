//! Team-leave Rotation through the retained Replica Operation and Sync owners.
use super::team_page::{TeamPageListKind, TeamReadLifetime};
use super::*;
use crate::{
    auth_http::{AuthenticatedOutcome, TeamPageHttpRoute},
    platform_storage::CurrentSessionDocument,
    protocol::{
        RotationCandidate, RotationFinalizeRejectionCode as PublicFinalizeCode,
        RotationIntent as PublicIntent, RotationPlanSelection, RotationSelection,
        RotationStartRejectionCode as PublicStartCode, RotationTerminalOutcome, TeamLeaveAttempt,
    },
    replica::{
        team_leave_finalize_operation, team_leave_start_operation, GuardedCommitPlan,
        OperationOutcomeResult, PlanMutation, PlanResult, RotationAttemptPhase,
        RotationFinalizeRejectionCode, RotationIntent, RotationMemberRecord,
        RotationStartRejectionCode,
    },
    server_contract,
};

impl Runtime {
    pub(super) async fn request_rotation(
        &self,
        request: RuntimeRequest,
        cancellation: RequestCancellation,
    ) -> Result<RuntimeResponse, RuntimeError> {
        match request {
            RuntimeRequest::PrepareRotation {
                account_id,
                intent,
                start_operation_id,
            } => {
                Box::pin(self.prepare_rotation(
                    account_id,
                    intent,
                    start_operation_id,
                    cancellation,
                ))
                .await
            }
            RuntimeRequest::CompleteRotation {
                account_id,
                selection,
            } => Box::pin(self.complete_rotation(account_id, selection, cancellation)).await,
            RuntimeRequest::InspectRotation {
                account_id,
                start_operation_id,
            } => {
                Box::pin(self.inspect_rotation(&account_id, &start_operation_id, cancellation))
                    .await
            }
            RuntimeRequest::ListTeamLeaveAttempts { account_id } => {
                let snapshot = self.require_snapshot(&account_id)?;
                self.require_rotation_unlocked_scope(&snapshot, &cancellation)?;
                let attempts = snapshot
                    .rotation_attempts
                    .iter()
                    .filter_map(|attempt| {
                        let RotationIntent::TeamLeave { team_id } = &attempt.intent else {
                            return None;
                        };
                        if attempt.presentation_acknowledged {
                            return None;
                        }
                        Some(TeamLeaveAttempt {
                            team_id: team_id.clone(),
                            start_operation_id: attempt.start_operation_id.clone(),
                        })
                    })
                    .collect();
                Ok(RuntimeResponse::TeamLeaveAttempts { attempts })
            }
            RuntimeRequest::AcknowledgeTeamLeaveAttempt {
                account_id,
                start_operation_id,
            } => {
                let execution = self.account_execution_lock(&account_id)?;
                let _guard = tokio::select! {
                    biased;
                    () = cancellation.cancelled() => return Err(rotation_cancelled()),
                    guard = execution.lock() => guard,
                };
                let snapshot = self.require_snapshot(&account_id)?;
                self.require_rotation_unlocked_scope(&snapshot, &cancellation)?;
                self.commit_rotation(
                    &snapshot,
                    PlanMutation::AcknowledgeRotationAttempt { start_operation_id },
                )
                .await?;
                Ok(RuntimeResponse::TeamLeaveAttemptAcknowledged)
            }
            _ => unreachable!("only Rotation requests enter this module"),
        }
    }

    async fn prepare_rotation(
        &self,
        account_id: AccountId,
        intent: PublicIntent,
        resume: Option<String>,
        cancellation: RequestCancellation,
    ) -> Result<RuntimeResponse, RuntimeError> {
        let PublicIntent::TeamLeave { team_id } = &intent else {
            return Err(rotation_unsupported());
        };
        if team_id.is_empty() || team_id.len() > 128 {
            return Err(rotation_changed());
        }
        let execution = self.account_execution_lock(&account_id)?;
        let guard = tokio::select! {
            biased;
            () = cancellation.cancelled() => return Err(rotation_cancelled()),
            guard = execution.lock() => guard,
        };
        let expected = self.require_snapshot(&account_id)?;
        self.require_rotation_unlocked_scope(&expected, &cancellation)?;
        let _foreground = self.foreground_attachments.register(
            &account_id,
            &expected.incarnation,
            cancellation.clone(),
        )?;
        let (http, mut session) = self.rotation_http(&expected).await?;
        let start_operation_id = if let Some(id) = resume {
            let current = self.require_snapshot(&account_id)?;
            let matching_attempt = current.rotation_attempts.iter().any(|attempt| {
                attempt.start_operation_id == id
                    && attempt.intent
                        == RotationIntent::TeamLeave {
                            team_id: team_id.clone(),
                        }
            });
            let matching_operation = current.operations.iter().any(|operation| {
                operation.operation_id == id
                    && operation.kind == crate::replica::OperationKind::CreateTeamLeaveRotationPlans
                    && operation.target
                        == crate::replica::ResourceRef::Team {
                            team_id: team_id.clone(),
                        }
            });
            let matching_rejection = current.receipts.iter().any(|receipt| {
                receipt.operation_id == id
                    && receipt.target
                        == crate::replica::ResourceRef::Team {
                            team_id: team_id.clone(),
                        }
                    && matches!(
                        receipt.result,
                        OperationOutcomeResult::RotationStartRejected { .. }
                    )
            });
            if !matching_attempt && !matching_operation && !matching_rejection {
                return Err(rotation_changed());
            }
            id
        } else {
            let proved = Box::pin(self.preflight_rotation_authority(
                &account_id,
                &http,
                session.clone(),
                cancellation.clone(),
            ))
            .await?;
            session = self
                .effective_session(&account_id, &proved.incarnation)
                .await?
                .ok_or_else(rotation_authentication_required)?;
            let current_team = self
                .rotation_current_team(&proved, &http, &mut session, &cancellation)
                .await?;
            if current_team.id != *team_id {
                return Err(rotation_changed());
            }
            self.require_team_page_scope(&expected, &cancellation)?;
            let current = self.require_snapshot(&account_id)?;
            if current.incarnation != expected.incarnation
                || current.lock_epoch != expected.lock_epoch
                || current.user_id != expected.user_id
                || current.revision != proved.revision
            {
                return Err(rotation_changed());
            }
            let operation = team_leave_start_operation(team_id);
            let id = operation.operation_id.clone();
            let authority_generation_id = proved
                .bootstrap
                .active_generation
                .as_ref()
                .ok_or_else(rotation_changed)?
                .0
                .clone();
            self.commit_rotation_plan(
                &current,
                vec![
                    PlanMutation::AcceptOperation(operation),
                    PlanMutation::BindRotationStart {
                        start_operation_id: id.clone(),
                        intent: RotationIntent::TeamLeave {
                            team_id: team_id.clone(),
                        },
                        authority_generation_id,
                        team_role: current_team.role,
                    },
                ],
            )
            .await?;
            id
        };
        drop(guard);
        self.dispatch_rotation_once(&account_id, &start_operation_id)
            .await;
        let _guard = execution.lock().await;
        self.require_rotation_unlocked_scope(&expected, &cancellation)?;
        self.rotation_start_result(&account_id, &intent, &start_operation_id, &cancellation)
            .await
    }

    async fn complete_rotation(
        &self,
        account_id: AccountId,
        selection: RotationSelection,
        cancellation: RequestCancellation,
    ) -> Result<RuntimeResponse, RuntimeError> {
        let execution = self.account_execution_lock(&account_id)?;
        let guard = tokio::select! {
            biased;
            () = cancellation.cancelled() => return Err(rotation_cancelled()),
            guard = execution.lock() => guard,
        };
        let expected = self.require_snapshot(&account_id)?;
        self.require_rotation_unlocked_scope(&expected, &cancellation)?;
        let cleanup_cancellation = RequestCancellation::new();
        let retire_cleanup = cleanup_cancellation.clone();
        let foreground = self.foreground_attachments.register_with_retirement(
            &account_id,
            &expected.incarnation,
            cancellation.clone(),
            std::sync::Arc::new(move || retire_cleanup.cancel()),
        )?;
        let PublicIntent::TeamLeave { team_id } = &selection.intent else {
            return Err(rotation_unsupported());
        };
        let attempt = expected
            .rotation_attempts
            .iter()
            .find(|attempt| attempt.start_operation_id == selection.start_operation_id)
            .ok_or_else(rotation_changed)?;
        if selection.account_id != account_id
            || selection.incarnation_id != expected.incarnation
            || selection.lock_epoch != expected.lock_epoch.to_string()
            || attempt.authority_generation_id.as_deref()
                != Some(selection.authority_generation_id.as_str())
            || expected
                .bootstrap
                .active_generation
                .as_ref()
                .map(|generation| generation.0.as_str())
                != Some(selection.authority_generation_id.as_str())
            || attempt.intent
                != (RotationIntent::TeamLeave {
                    team_id: team_id.clone(),
                })
            || !matches!(attempt.phase, RotationAttemptPhase::Prepared)
            || selection.plans
                != attempt
                    .plans
                    .iter()
                    .map(|plan| RotationPlanSelection {
                        plan_id: plan.plan_id.clone(),
                        vault_id: plan.vault_id.clone(),
                        expected_key_version: plan.expected_key_version,
                    })
                    .collect::<Vec<_>>()
        {
            return Err(rotation_changed());
        }
        if attempt.plans.is_empty() && !selection.candidates.is_empty() {
            return Err(rotation_changed());
        }
        let version_proved = expected
            .bootstrap
            .active_generation
            .as_ref()
            .is_some_and(|id| {
                expected
                    .bootstrap
                    .generations
                    .get(id)
                    .is_some_and(|generation| {
                        generation.vault_key_version_proved && generation.final_page_staged
                    })
            });
        if !version_proved {
            return Err(RuntimeError::new(
                RuntimeErrorCode::VersionEvidenceUnavailable,
                "Rotation authority has no version-capable complete generation",
            ));
        }
        let (http, mut session) = self.rotation_http(&expected).await?;
        let current_team = self
            .rotation_current_team(&expected, &http, &mut session, &cancellation)
            .await?;
        if current_team.id != *team_id || attempt.team_role.as_ref() != Some(&current_team.role) {
            return Err(rotation_changed());
        }
        if !attempt.plans.is_empty() {
            let bound_members = attempt
                .member_manifest
                .as_ref()
                .ok_or_else(rotation_changed)?;
            let mut renewed = false;
            let mut current_members = Vec::new();
            for plan in &attempt.plans {
                let vault = expected
                    .bootstrap
                    .snapshot()
                    .visible_vaults
                    .into_iter()
                    .find(|vault| {
                        vault.id == plan.vault_id
                            && vault.key_version == Some(plan.expected_key_version)
                    })
                    .ok_or_else(rotation_changed)?;
                if vault.encrypted_vault_key.is_empty() {
                    return Err(rotation_changed());
                }
                for record in self
                    .read_rotation_pages(
                        &expected,
                        &http,
                        &mut session,
                        &plan.plan_id,
                        "member",
                        &cancellation,
                        &mut renewed,
                    )
                    .await?
                {
                    let payload: RotationMemberPayload =
                        serde_json::from_str(&record.payload).map_err(|_| rotation_changed())?;
                    current_members.push(RotationMemberRecord {
                        plan_id: plan.plan_id.clone(),
                        record_id: record.id,
                        expected_version: record.expected_version,
                        user_id: payload.user_id,
                        public_key: payload.public_key,
                        role: Some(payload.role),
                    });
                }
            }
            if &current_members != bound_members {
                return Err(rotation_changed());
            }
            let expected_candidates = rotation_candidates(bound_members, &expected.user_id)?;
            if selection.candidates != expected_candidates {
                return Err(rotation_changed());
            }
            let metadata = self
                .platform_storage
                .load_account_metadata(&account_id, &expected.incarnation)
                .await?
                .ok_or_else(rotation_authentication_required)?;
            let verified = self
                .platform_storage
                .load_verified_recipient_keys(&metadata)
                .await?;
            for candidate in &expected_candidates {
                if verified.approved_key(&candidate.user_id, candidate.public_key.clone())?
                    != candidate.public_key
                {
                    return Err(rotation_changed());
                }
            }
        }
        self.require_rotation_unlocked_scope(&expected, &cancellation)?;
        let current = self.require_snapshot(&account_id)?;
        if current.incarnation != expected.incarnation
            || current.lock_epoch != expected.lock_epoch
            || current.user_id != expected.user_id
            || current.bootstrap.active_generation != expected.bootstrap.active_generation
        {
            return Err(rotation_changed());
        }
        let attempt_id = bittery_crypto_core::generate_uuid();
        self.commit_rotation(
            &current,
            PlanMutation::ConsumeRotationAttempt {
                start_operation_id: selection.start_operation_id.clone(),
                attempt_id: attempt_id.clone(),
            },
        )
        .await?;
        let consumed = self.require_snapshot(&account_id)?;
        let pre_admission = async {
            if !attempt.plans.is_empty() {
                self.stage_private_rotation(&consumed, attempt, &http, &mut session, &cancellation)
                    .await?;
                self.require_rotation_manifest(
                    &consumed,
                    attempt,
                    &http,
                    &mut session,
                    &cancellation,
                )
                .await?;
            }
            let current = self.require_snapshot(&account_id)?;
            if current.revision != consumed.revision
                || current.incarnation != consumed.incarnation
                || current.lock_epoch != consumed.lock_epoch
                || current.user_id != consumed.user_id
                || current.bootstrap.active_generation != consumed.bootstrap.active_generation
            {
                return Err(rotation_changed());
            }
            #[cfg(test)]
            self.foreground_attachments.before_finalization_admission();
            {
                let _publication = self.publication.lock().expect("publication lock poisoned");
                self.require_rotation_unlocked_scope(&consumed, &cancellation)?;
                // A queued Lock registers its intent before fencing foreground work. Hold that
                // intent's mutex through admission so either it wins and this existing foreground
                // guard makes Lock drain acceptance.
                let intent = self.account_access_retirement_intent(&account_id);
                let pending = intent
                    .lock()
                    .expect("pending Account access retirement lock poisoned");
                if *pending != 0
                    || !self
                        .foreground_attachments
                        .admit_finalization(&foreground, &cancellation)
                {
                    return Err(rotation_cancelled());
                }
            }
            team_leave_finalize_operation(team_id, &attempt.plans)
        }
        .await;
        let operation = match pre_admission {
            Ok(operation) => operation,
            Err(error) => {
                self.abandon_rotation_attempt_if_authorized(
                    &consumed,
                    attempt,
                    &http,
                    &session,
                    &cleanup_cancellation,
                )
                .await;
                return Err(error);
            }
        };
        let finalize_operation_id = operation.operation_id.clone();
        // Once this commit is attempted, its result may be uncertain. The journal owns
        // finalization and the selective fence if it landed; never abandon these plans.
        self.commit_rotation(
            &consumed,
            PlanMutation::AcceptRotationFinalize {
                start_operation_id: selection.start_operation_id.clone(),
                attempt_id,
                operation,
            },
        )
        .await?;
        drop(guard);
        self.dispatch_rotation_once(&account_id, &finalize_operation_id)
            .await;
        Box::pin(self.inspect_rotation(
            &account_id,
            &selection.start_operation_id,
            RequestCancellation::new(),
        ))
        .await
    }

    async fn abandon_rotation_attempt_if_authorized(
        &self,
        expected: &ReplicaSnapshot,
        attempt: &crate::replica::RotationAttemptRecord,
        http: &AuthHttpClient<'_>,
        staged_session: &CurrentSessionDocument,
        cleanup_cancellation: &RequestCancellation,
    ) {
        // Caller loss may still permit cleanup; the foreground registration cancels this
        // separate request when Account or Runtime retirement needs to drain external work.
        for plan in &attempt.plans {
            if self
                .require_rotation_unlocked_scope(expected, cleanup_cancellation)
                .is_err()
            {
                break;
            }
            let current_session = match self
                .effective_session(&expected.account_id, &expected.incarnation)
                .await
            {
                Ok(Some(current))
                    if current.token.as_ref() == staged_session.token.as_ref()
                        && current.session_id == staged_session.session_id =>
                {
                    current
                }
                _ => break,
            };
            if self
                .require_rotation_unlocked_scope(expected, cleanup_cancellation)
                .is_err()
            {
                break;
            }
            http.abandon_rotation_plan(
                current_session.token.as_ref(),
                &plan.plan_id,
                cleanup_cancellation.clone(),
            )
            .await;
        }
    }

    async fn inspect_rotation(
        &self,
        account_id: &AccountId,
        start_operation_id: &str,
        cancellation: RequestCancellation,
    ) -> Result<RuntimeResponse, RuntimeError> {
        let execution = self.account_execution_lock(account_id)?;
        let guard = tokio::select! {
            biased;
            () = cancellation.cancelled() => return Err(rotation_cancelled()),
            guard = execution.lock() => guard,
        };
        let expected = self.require_snapshot(account_id)?;
        self.require_rotation_unlocked_scope(&expected, &cancellation)?;
        let attempt = expected
            .rotation_attempts
            .iter()
            .find(|attempt| attempt.start_operation_id == start_operation_id);
        let Some(attempt) = attempt else {
            if let Some(receipt) = expected
                .receipts
                .iter()
                .find(|receipt| receipt.operation_id == start_operation_id)
            {
                if let OperationOutcomeResult::RotationStartRejected { code } = receipt.result {
                    return Ok(RuntimeResponse::RotationStartRejected {
                        code: public_start_code(code),
                    });
                }
            }
            if expected.operations.iter().any(|operation| {
                operation.operation_id == start_operation_id
                    && operation.kind == crate::replica::OperationKind::CreateTeamLeaveRotationPlans
            }) {
                drop(guard);
                self.dispatch_rotation_once(account_id, start_operation_id)
                    .await;
                return Ok(RuntimeResponse::RotationStartPending {
                    start_operation_id: start_operation_id.to_owned(),
                });
            }
            return Err(rotation_changed());
        };
        match &attempt.phase {
            RotationAttemptPhase::Starting => {
                drop(guard);
                self.dispatch_rotation_once(account_id, start_operation_id)
                    .await;
                Ok(RuntimeResponse::RotationStartPending {
                    start_operation_id: start_operation_id.to_owned(),
                })
            }
            RotationAttemptPhase::Prepared => {
                let intent = match &attempt.intent {
                    RotationIntent::TeamLeave { team_id } => PublicIntent::TeamLeave {
                        team_id: team_id.clone(),
                    },
                    _ => return Err(rotation_unsupported()),
                };
                self.rotation_start_result(account_id, &intent, start_operation_id, &cancellation)
                    .await
            }
            RotationAttemptPhase::Consumed { .. } => Ok(RuntimeResponse::RotationAttemptConsumed {
                start_operation_id: start_operation_id.to_owned(),
            }),
            RotationAttemptPhase::Finalizing {
                finalize_operation_id,
                ..
            } => {
                let id = finalize_operation_id.clone();
                drop(guard);
                self.dispatch_rotation_once(account_id, &id).await;
                Ok(RuntimeResponse::RotationFinalizePending {
                    finalize_operation_id: id,
                })
            }
            RotationAttemptPhase::Completed {
                personal_team_id, ..
            } => Ok(RuntimeResponse::RotationCompleted {
                personal_team_id: personal_team_id.clone(),
            }),
            RotationAttemptPhase::Rejected { code, .. } => Ok(RuntimeResponse::RotationRejected {
                code: public_finalize_code(*code),
            }),
            RotationAttemptPhase::AppliedAwaitingRefresh {
                finalize_operation_id,
                ..
            }
            | RotationAttemptPhase::RejectedAwaitingRefresh {
                finalize_operation_id,
                ..
            } => {
                let id = finalize_operation_id.clone();
                let outcome = match &attempt.phase {
                    RotationAttemptPhase::AppliedAwaitingRefresh {
                        personal_team_id, ..
                    } => RotationTerminalOutcome::Applied {
                        personal_team_id: personal_team_id.clone(),
                    },
                    RotationAttemptPhase::RejectedAwaitingRefresh { code, .. } => {
                        RotationTerminalOutcome::Rejected {
                            code: public_finalize_code(*code),
                        }
                    }
                    _ => unreachable!(),
                };
                let (http, session) = match self.rotation_http(&expected).await {
                    Ok(connection) => connection,
                    Err(_) => {
                        return Ok(RuntimeResponse::RotationRefreshRequired {
                            finalize_operation_id: id,
                            outcome,
                        })
                    }
                };
                let fresh = Box::pin(self.preflight_rotation_authority(
                    account_id,
                    &http,
                    session,
                    cancellation.clone(),
                ))
                .await;
                let Ok(fresh) = fresh else {
                    return Ok(RuntimeResponse::RotationRefreshRequired {
                        finalize_operation_id: id,
                        outcome,
                    });
                };
                let Some(mut session) = self
                    .effective_session(account_id, &fresh.incarnation)
                    .await?
                else {
                    return Ok(RuntimeResponse::RotationRefreshRequired {
                        finalize_operation_id: id,
                        outcome,
                    });
                };
                let current_team = self
                    .rotation_current_team(&fresh, &http, &mut session, &cancellation)
                    .await;
                let Ok(current_team) = current_team else {
                    return Ok(RuntimeResponse::RotationRefreshRequired {
                        finalize_operation_id: id,
                        outcome,
                    });
                };
                if matches!(&outcome, RotationTerminalOutcome::Applied { personal_team_id } if personal_team_id != &current_team.id)
                {
                    return Ok(RuntimeResponse::RotationRefreshRequired {
                        finalize_operation_id: id,
                        outcome,
                    });
                }
                let visible = fresh.bootstrap.snapshot().visible_vaults;
                let authority_proved = match &outcome {
                    RotationTerminalOutcome::Applied { .. } => attempt
                        .plans
                        .iter()
                        .all(|plan| visible.iter().all(|vault| vault.id != plan.vault_id)),
                    RotationTerminalOutcome::Rejected { .. } => {
                        let old_team = match &attempt.intent {
                            RotationIntent::TeamLeave { team_id } => team_id,
                            _ => return Err(rotation_unsupported()),
                        };
                        if &current_team.id != old_team {
                            attempt
                                .plans
                                .iter()
                                .all(|plan| visible.iter().all(|vault| vault.id != plan.vault_id))
                        } else {
                            attempt.plans.iter().all(|plan| {
                                visible.iter().any(|vault| {
                                    vault.id == plan.vault_id
                                        && vault.key_version.is_some_and(|version| {
                                            version >= plan.expected_key_version
                                        })
                                        && !vault.encrypted_vault_key.is_empty()
                                })
                            })
                        }
                    }
                };
                if !authority_proved {
                    return Ok(RuntimeResponse::RotationRefreshRequired {
                        finalize_operation_id: id,
                        outcome,
                    });
                }
                let current = self.require_snapshot(account_id)?;
                if current.incarnation != expected.incarnation
                    || current.lock_epoch != expected.lock_epoch
                    || current.user_id != expected.user_id
                    || current.revision != fresh.revision
                {
                    return Err(rotation_changed());
                }
                self.commit_rotation(
                    &current,
                    PlanMutation::CompleteRotationRefresh {
                        start_operation_id: start_operation_id.to_owned(),
                        finalize_operation_id: id.clone(),
                    },
                )
                .await?;
                match outcome {
                    RotationTerminalOutcome::Applied { personal_team_id } => {
                        Ok(RuntimeResponse::RotationCompleted { personal_team_id })
                    }
                    RotationTerminalOutcome::Rejected { code } => {
                        Ok(RuntimeResponse::RotationRejected { code })
                    }
                }
            }
        }
    }

    async fn rotation_start_result(
        &self,
        account_id: &AccountId,
        intent: &PublicIntent,
        start_operation_id: &str,
        cancellation: &RequestCancellation,
    ) -> Result<RuntimeResponse, RuntimeError> {
        let snapshot = self.require_snapshot(account_id)?;
        if let Some(attempt) = snapshot
            .rotation_attempts
            .iter()
            .find(|attempt| attempt.start_operation_id == start_operation_id)
        {
            if matches!(attempt.phase, RotationAttemptPhase::Starting) {
                return Ok(RuntimeResponse::RotationStartPending {
                    start_operation_id: start_operation_id.to_owned(),
                });
            }
            if !matches!(attempt.phase, RotationAttemptPhase::Prepared) {
                return Err(rotation_changed());
            }
            let Some(authority_generation_id) = &attempt.authority_generation_id else {
                return Err(rotation_changed());
            };
            let PublicIntent::TeamLeave { team_id } = intent else {
                return Err(rotation_unsupported());
            };
            if attempt.intent
                != (RotationIntent::TeamLeave {
                    team_id: team_id.clone(),
                })
            {
                return Err(rotation_changed());
            }
            let plans: Vec<_> = attempt
                .plans
                .iter()
                .map(|plan| RotationPlanSelection {
                    plan_id: plan.plan_id.clone(),
                    vault_id: plan.vault_id.clone(),
                    expected_key_version: plan.expected_key_version,
                })
                .collect();
            self.require_rotation_unlocked_scope(&snapshot, cancellation)?;
            if snapshot
                .bootstrap
                .active_generation
                .as_ref()
                .map(|generation| generation.0.as_str())
                != Some(authority_generation_id.as_str())
            {
                return Err(rotation_changed());
            }
            let (http, mut session) = self.rotation_http(&snapshot).await?;
            let current_team = self
                .rotation_current_team(&snapshot, &http, &mut session, cancellation)
                .await?;
            if current_team.id != *team_id || attempt.team_role.as_ref() != Some(&current_team.role)
            {
                return Err(rotation_changed());
            }
            let current_authority = snapshot.bootstrap.snapshot();
            if plans.iter().any(|plan| {
                current_authority
                    .visible_vaults
                    .iter()
                    .find(|vault| vault.id == plan.vault_id)
                    .is_none_or(|vault| vault.key_version != Some(plan.expected_key_version))
            }) {
                return Err(rotation_changed());
            }
            let members = if plans.is_empty() {
                Vec::new()
            } else {
                let (http, mut session) = self.rotation_http(&snapshot).await?;
                let mut renewed = false;
                let mut members = Vec::new();
                for plan in &attempt.plans {
                    for record in self
                        .read_rotation_pages(
                            &snapshot,
                            &http,
                            &mut session,
                            &plan.plan_id,
                            "member",
                            cancellation,
                            &mut renewed,
                        )
                        .await?
                    {
                        let payload: RotationMemberPayload = serde_json::from_str(&record.payload)
                            .map_err(|_| rotation_changed())?;
                        if record.id != payload.user_id
                            || record.expected_version != plan.expected_key_version
                        {
                            return Err(rotation_changed());
                        }
                        members.push(RotationMemberRecord {
                            plan_id: plan.plan_id.clone(),
                            record_id: record.id,
                            expected_version: record.expected_version,
                            user_id: payload.user_id,
                            public_key: payload.public_key,
                            role: Some(payload.role),
                        });
                    }
                }
                members
            };
            if !plans.is_empty() {
                self.commit_rotation(
                    &snapshot,
                    PlanMutation::BindRotationManifest {
                        start_operation_id: start_operation_id.to_owned(),
                        members: members.clone(),
                    },
                )
                .await?;
            }
            let candidates = rotation_candidates(&members, &snapshot.user_id)?;
            self.require_rotation_unlocked_scope(&snapshot, cancellation)?;
            return Ok(RuntimeResponse::RotationPrepared {
                selection: RotationSelection {
                    account_id: account_id.clone(),
                    incarnation_id: snapshot.incarnation,
                    lock_epoch: snapshot.lock_epoch.to_string(),
                    authority_generation_id: authority_generation_id.clone(),
                    intent: intent.clone(),
                    start_operation_id: start_operation_id.to_owned(),
                    plans,
                    candidates,
                },
            });
        }
        if let Some(receipt) = snapshot
            .receipts
            .iter()
            .find(|receipt| receipt.operation_id == start_operation_id)
        {
            if let OperationOutcomeResult::RotationStartRejected { code } = receipt.result {
                return Ok(RuntimeResponse::RotationStartRejected {
                    code: public_start_code(code),
                });
            }
        }
        if snapshot
            .operations
            .iter()
            .any(|operation| operation.operation_id == start_operation_id)
        {
            return Ok(RuntimeResponse::RotationStartPending {
                start_operation_id: start_operation_id.to_owned(),
            });
        }
        Err(rotation_changed())
    }

    async fn commit_rotation(
        &self,
        snapshot: &ReplicaSnapshot,
        mutation: PlanMutation,
    ) -> Result<(), RuntimeError> {
        self.commit_rotation_plan(snapshot, vec![mutation]).await
    }

    async fn commit_rotation_plan(
        &self,
        snapshot: &ReplicaSnapshot,
        mutations: Vec<PlanMutation>,
    ) -> Result<(), RuntimeError> {
        let admits_finalize = mutations
            .iter()
            .any(|mutation| matches!(mutation, PlanMutation::AcceptRotationFinalize { .. }));
        let result = self
            .replica
            .execute(GuardedCommitPlan::new(
                snapshot.account_id.clone(),
                snapshot.incarnation.clone(),
                snapshot.revision,
                snapshot.lock_epoch,
                mutations,
            ))
            .await?;
        match result {
            PlanResult::Applied { .. } => {
                if admits_finalize {
                    // The journal now owns the selective fence. Retire old captured delivery
                    // before publishing the filtered projection to mounted observers, while
                    // finalize HTTP is still behind this admission boundary.
                    let invalidated = {
                        let _publication =
                            self.publication.lock().expect("publication lock poisoned");
                        self.invalidate_delivery(&snapshot.account_id)
                    };
                    finish_generation_fence(invalidated);
                    self.publish_all_unless_closed();
                }
                self.wake_dispatch();
                Ok(())
            }
            PlanResult::Stale { .. } => Err(rotation_changed()),
            PlanResult::Missing => Err(RuntimeError::new(
                RuntimeErrorCode::AccountMissing,
                "Rotation Account is missing",
            )),
        }
    }

    async fn rotation_http(
        &self,
        snapshot: &ReplicaSnapshot,
    ) -> Result<(AuthHttpClient<'_>, CurrentSessionDocument), RuntimeError> {
        let metadata = self
            .platform_storage
            .load_account_metadata(&snapshot.account_id, &snapshot.incarnation)
            .await?
            .ok_or_else(rotation_authentication_required)?;
        let session = self
            .effective_session(&snapshot.account_id, &snapshot.incarnation)
            .await?
            .ok_or_else(rotation_authentication_required)?;
        let config = self
            .auth_client_config
            .clone()
            .ok_or_else(rotation_authentication_required)?;
        let http = AuthHttpClient::new(
            &self.http_transport,
            &metadata.normalized_server_url,
            metadata.insecure_transport_confirmed,
            config,
        )?;
        Ok((http, session))
    }

    fn require_rotation_unlocked_scope(
        &self,
        expected: &ReplicaSnapshot,
        cancellation: &RequestCancellation,
    ) -> Result<(), RuntimeError> {
        self.ensure_open()?;
        if cancellation.is_cancelled()
            || self.account_access_retirement_is_pending(&expected.account_id)
            || self.account_teardown_is_pending(&expected.account_id)
        {
            return Err(rotation_cancelled());
        }
        let current = self.require_snapshot(&expected.account_id)?;
        if current.incarnation != expected.incarnation
            || current.lock_epoch != expected.lock_epoch
            || current.user_id != expected.user_id
            || current.failure.is_some()
            || self
                .lock_epoch_pending
                .lock()
                .expect("pending lock epoch lock poisoned")
                .contains_key(&expected.account_id)
            || self
                .account_access
                .lock()
                .expect("Account access lock poisoned")
                .get(&expected.account_id)
                != Some(&AccountAccessState::Unlocked)
        {
            return Err(rotation_changed());
        }
        Ok(())
    }

    async fn rotation_current_team(
        &self,
        expected: &ReplicaSnapshot,
        http: &AuthHttpClient<'_>,
        session: &mut CurrentSessionDocument,
        cancellation: &RequestCancellation,
    ) -> Result<server_contract::TeamSummaryResponse, RuntimeError> {
        let mut lifetime = TeamReadLifetime {
            cancellation,
            renewed: false,
        };
        let user: server_contract::MeResponse = self
            .team_read(
                http,
                expected,
                session,
                TeamPageHttpRoute::User,
                &mut lifetime,
            )
            .await?
            .ok_or_else(rotation_changed)?;
        if user.id != expected.user_id {
            return Err(rotation_changed());
        }
        let team: server_contract::TeamSummaryResponse = self
            .team_read(
                http,
                expected,
                session,
                TeamPageHttpRoute::CurrentTeam,
                &mut lifetime,
            )
            .await?
            .ok_or_else(rotation_changed)?;
        if team.id.is_empty() {
            return Err(rotation_changed());
        }
        Ok(team)
    }

    #[allow(clippy::too_many_arguments)]
    async fn read_rotation_pages(
        &self,
        expected: &ReplicaSnapshot,
        http: &AuthHttpClient<'_>,
        session: &mut CurrentSessionDocument,
        plan_id: &str,
        kind: &str,
        cancellation: &RequestCancellation,
        renewed: &mut bool,
    ) -> Result<Vec<server_contract::PreparationRecord>, RuntimeError> {
        const MAX_PAGES: usize = 256;
        const MAX_RECORDS: usize = 21_000;
        let mut records = Vec::new();
        let mut cursor: Option<String> = None;
        let mut seen = std::collections::HashSet::new();
        for _ in 0..MAX_PAGES {
            self.require_rotation_unlocked_scope(expected, cancellation)?;
            self.require_team_page_session(expected, session, cancellation)
                .await?;
            let page = match http
                .rotation_preparation_page(
                    session.token.as_ref(),
                    plan_id,
                    kind,
                    cursor.as_deref(),
                    cancellation.clone(),
                )
                .await?
            {
                AuthenticatedOutcome::Ok(page) => page,
                AuthenticatedOutcome::ReauthenticationRequired if !*renewed => {
                    let refresh = self
                        .request_session_refresh(session, http, cancellation.clone())
                        .await?;
                    *session = self
                        .publish_session_refresh(&expected.account_id, session, refresh)
                        .await?;
                    *renewed = true;
                    continue;
                }
                AuthenticatedOutcome::ReauthenticationRequired => {
                    return Err(rotation_authentication_required())
                }
                AuthenticatedOutcome::Transient => {
                    return Err(RuntimeError::new(
                        RuntimeErrorCode::RetryableTransport,
                        "Rotation preparation is unavailable",
                    ))
                }
            };
            self.require_rotation_unlocked_scope(expected, cancellation)?;
            if page.records.len() > 100
                || records.len().saturating_add(page.records.len()) > MAX_RECORDS
            {
                return Err(rotation_changed());
            }
            for record in &page.records {
                if record.id.is_empty()
                    || record.id.len() > 128
                    || record.expected_version < 1
                    || record.payload.len() > 512 * 1024
                    || cursor.as_ref().is_some_and(|old| &record.id <= old)
                    || records
                        .last()
                        .is_some_and(|last: &server_contract::PreparationRecord| {
                            last.id >= record.id
                        })
                {
                    return Err(rotation_changed());
                }
            }
            records.extend(page.records);
            match page.next_cursor {
                Some(next) => {
                    if next.len() > 128
                        || records.last().is_none_or(|last| last.id != next)
                        || !seen.insert(next.clone())
                    {
                        return Err(rotation_changed());
                    }
                    cursor = Some(next);
                }
                None => return Ok(records),
            }
        }
        Err(rotation_changed())
    }

    async fn stage_private_rotation(
        &self,
        expected: &ReplicaSnapshot,
        attempt: &crate::replica::RotationAttemptRecord,
        http: &AuthHttpClient<'_>,
        session: &mut CurrentSessionDocument,
        cancellation: &RequestCancellation,
    ) -> Result<(), RuntimeError> {
        self.require_rotation_manifest(expected, attempt, http, session, cancellation)
            .await?;
        let material = self
            .copy_live_vault_key_material(&expected.account_id, &expected.incarnation)
            .ok_or_else(rotation_authentication_required)?;
        let authority = expected.bootstrap.snapshot();
        let mut renewed = false;
        let members = attempt
            .member_manifest
            .as_ref()
            .ok_or_else(rotation_changed)?;
        for plan in &attempt.plans {
            self.require_rotation_unlocked_scope(expected, cancellation)?;
            let vault = authority
                .visible_vaults
                .iter()
                .find(|vault| {
                    vault.id == plan.vault_id
                        && vault.key_version == Some(plan.expected_key_version)
                })
                .ok_or_else(rotation_changed)?;
            let old_key = Zeroizing::new(super::vault_key::unwrap_vault_key(
                vault,
                &expected.user_id,
                &material,
            )?);
            if old_key.len() != 32 {
                return Err(rotation_changed());
            }
            let new_key =
                Zeroizing::new(bittery_crypto_core::key_rotation::generate_new_vault_key());
            for member in members
                .iter()
                .filter(|member| member.plan_id == plan.plan_id)
            {
                self.require_rotation_unlocked_scope(expected, cancellation)?;
                let encrypted = if member.user_id == expected.user_id {
                    bittery_crypto_core::encrypt_vault_key_with_muk(
                        &*new_key,
                        &*material,
                        &bittery_crypto_core::VaultKeyWrapContext::new(
                            &plan.vault_id,
                            &expected.user_id,
                            (plan.expected_key_version + 1) as u64,
                        ),
                    )
                } else {
                    bittery_crypto_core::encrypt_vault_key_for_member(&*new_key, &member.public_key)
                }
                .map_err(|_| rotation_changed())?;
                self.stage_private_record(
                    expected,
                    attempt,
                    http,
                    session,
                    &plan.plan_id,
                    "member",
                    &member.record_id,
                    serde_json::json!({"userId":member.user_id,"encryptedVaultKey":encrypted})
                        .to_string(),
                    cancellation,
                )
                .await?;
            }
            for record in self
                .read_rotation_pages(
                    expected,
                    http,
                    session,
                    &plan.plan_id,
                    "item",
                    cancellation,
                    &mut renewed,
                )
                .await?
            {
                self.require_rotation_unlocked_scope(expected, cancellation)?;
                let item: RotationItemPayload =
                    serde_json::from_str(&record.payload).map_err(|_| rotation_changed())?;
                if item.id != record.id
                    || item.vault_id != plan.vault_id
                    || item.encryption_version < 1
                    || record.expected_version < 1
                    || item.encrypted_by_user_id.is_empty()
                {
                    return Err(rotation_changed());
                }
                let reencrypted = bittery_crypto_core::re_encrypt_item(
                    &bittery_crypto_core::ItemData {
                        id: item.id.clone(),
                        encrypted_data: item.encrypted_data,
                        encryption_iv: item.encryption_iv,
                        encryption_algorithm: item.encryption_algorithm.clone(),
                        context: bittery_crypto_core::AadContext {
                            vault_id: item.vault_id,
                            entity_id: item.id,
                            entity_type: "item".into(),
                            version: item.encryption_version as u64,
                            user_id: item.encrypted_by_user_id,
                        },
                    },
                    &old_key,
                    &*new_key,
                )
                .map_err(|_| rotation_changed())?;
                self.stage_private_record(
                    expected,
                    attempt,
                    http,
                    session,
                    &plan.plan_id,
                    "item",
                    &record.id,
                    serde_json::json!({
                        "itemId":record.id,
                        "encryptedData":reencrypted.encrypted_data,
                        "encryptionIv":reencrypted.encryption_iv,
                        "encryptionAlgorithm":item.encryption_algorithm,
                    })
                    .to_string(),
                    cancellation,
                )
                .await?;
            }
            for record in self
                .read_rotation_pages(
                    expected,
                    http,
                    session,
                    &plan.plan_id,
                    "attachment",
                    cancellation,
                    &mut renewed,
                )
                .await?
            {
                self.require_rotation_unlocked_scope(expected, cancellation)?;
                let attachment: RotationAttachmentPayload =
                    serde_json::from_str(&record.payload).map_err(|_| rotation_changed())?;
                if attachment.attachment_id != record.id
                    || attachment.vault_id != plan.vault_id
                    || attachment.envelope_version < 1
                    || attachment.envelope_version != record.expected_version
                    || attachment.uploaded_by.is_empty()
                {
                    return Err(rotation_changed());
                }
                let old_context = bittery_crypto_core::AadContext {
                    vault_id: attachment.vault_id.clone(),
                    entity_id: attachment.attachment_id.clone(),
                    entity_type: "attachment_key".into(),
                    version: attachment.envelope_version as u64,
                    user_id: attachment.uploaded_by.clone(),
                };
                let new_context = bittery_crypto_core::AadContext {
                    version: old_context.version + 1,
                    ..old_context.clone()
                };
                let wrapped = bittery_crypto_core::rewrap_attachment_key(
                    &bittery_crypto_core::EncryptedData {
                        ciphertext: attachment.encrypted_attachment_key,
                        iv: attachment.attachment_key_iv,
                        algorithm: attachment.attachment_key_algorithm,
                    },
                    &old_key,
                    &*new_key,
                    &old_context,
                    &new_context,
                )
                .map_err(|_| rotation_changed())?;
                self.stage_private_record(
                    expected,
                    attempt,
                    http,
                    session,
                    &plan.plan_id,
                    "attachment",
                    &record.id,
                    serde_json::json!({
                        "attachmentId":record.id,
                        "encryptedAttachmentKey":wrapped.ciphertext,
                        "attachmentKeyIv":wrapped.iv,
                        "attachmentKeyAlgorithm":wrapped.algorithm,
                        "vaultId":attachment.vault_id,
                        "uploadedBy":attachment.uploaded_by,
                        "envelopeVersion":new_context.version,
                    })
                    .to_string(),
                    cancellation,
                )
                .await?;
            }
        }
        Ok(())
    }

    #[allow(clippy::too_many_arguments)]
    async fn stage_private_record(
        &self,
        expected: &ReplicaSnapshot,
        attempt: &crate::replica::RotationAttemptRecord,
        http: &AuthHttpClient<'_>,
        session: &mut CurrentSessionDocument,
        plan_id: &str,
        kind: &str,
        record_id: &str,
        payload: String,
        cancellation: &RequestCancellation,
    ) -> Result<(), RuntimeError> {
        self.require_rotation_unlocked_scope(expected, cancellation)?;
        if payload
            .len()
            .saturating_add(record_id.len())
            .saturating_add(16)
            > 512 * 1024
            || !attempt.plans.iter().any(|plan| plan.plan_id == plan_id)
        {
            return Err(rotation_changed());
        }
        self.require_rotation_manifest(expected, attempt, http, session, cancellation)
            .await?;
        self.require_rotation_unlocked_scope(expected, cancellation)?;
        http.stage_rotation_outputs(
            session.token.as_ref(),
            plan_id,
            kind,
            &server_contract::StageRequest {
                outputs: vec![server_contract::StagedOutputRequest {
                    id: record_id.to_owned(),
                    payload,
                }],
            },
            cancellation.clone(),
        )
        .await?;
        self.require_rotation_unlocked_scope(expected, cancellation)
    }

    async fn require_rotation_manifest(
        &self,
        expected: &ReplicaSnapshot,
        attempt: &crate::replica::RotationAttemptRecord,
        http: &AuthHttpClient<'_>,
        session: &mut CurrentSessionDocument,
        cancellation: &RequestCancellation,
    ) -> Result<(), RuntimeError> {
        let RotationIntent::TeamLeave { team_id } = &attempt.intent else {
            return Err(rotation_unsupported());
        };
        let team = self
            .rotation_current_team(expected, http, session, cancellation)
            .await?;
        if &team.id != team_id || attempt.team_role.as_ref() != Some(&team.role) {
            return Err(rotation_changed());
        }
        let bound = attempt
            .member_manifest
            .as_ref()
            .ok_or_else(rotation_changed)?;
        if bound.iter().any(|member| member.role.is_none()) {
            return Err(rotation_changed());
        }
        let mut current = Vec::new();
        let mut renewed = false;
        for plan in &attempt.plans {
            for record in self
                .read_rotation_pages(
                    expected,
                    http,
                    session,
                    &plan.plan_id,
                    "member",
                    cancellation,
                    &mut renewed,
                )
                .await?
            {
                let payload: RotationMemberPayload =
                    serde_json::from_str(&record.payload).map_err(|_| rotation_changed())?;
                current.push(RotationMemberRecord {
                    plan_id: plan.plan_id.clone(),
                    record_id: record.id,
                    expected_version: record.expected_version,
                    user_id: payload.user_id,
                    public_key: payload.public_key,
                    role: Some(payload.role),
                });
            }
        }
        if &current != bound {
            return Err(rotation_changed());
        }
        // Preparation pages are snapshots. The Server can change a Vault Member's role
        // while a plan is active, and stage accepts that plan until finalization. Read
        // current membership before every new output rather than treating the plan as
        // current permission authority.
        let mut lifetime = TeamReadLifetime {
            cancellation,
            renewed: false,
        };
        let vaults = expected.bootstrap.snapshot().visible_vaults;
        for plan in &attempt.plans {
            let vault = vaults
                .iter()
                .find(|vault| {
                    vault.id == plan.vault_id
                        && vault.key_version == Some(plan.expected_key_version)
                })
                .ok_or_else(rotation_changed)?;
            let initiator_role = match vault.role {
                crate::replica::AuthorityVaultRole::Owner => server_contract::VaultRole::Owner,
                crate::replica::AuthorityVaultRole::Admin => server_contract::VaultRole::Admin,
                crate::replica::AuthorityVaultRole::Member => server_contract::VaultRole::Member,
                crate::replica::AuthorityVaultRole::ReadOnly => {
                    server_contract::VaultRole::ReadOnly
                }
            };
            let live: Vec<server_contract::VaultMemberResponse> = self
                .team_pages(
                    http,
                    expected,
                    session,
                    &plan.vault_id,
                    TeamPageListKind::VaultMembers,
                    &mut lifetime,
                )
                .await?;
            self.require_rotation_unlocked_scope(expected, cancellation)?;
            let mut seen = std::collections::HashSet::new();
            let mut initiator_present = false;
            let mut remaining = Vec::new();
            for member in live {
                if member.user_id.is_empty() || !seen.insert(member.user_id.clone()) {
                    return Err(rotation_changed());
                }
                if member.user_id == expected.user_id {
                    if member.role != initiator_role {
                        return Err(rotation_changed());
                    }
                    initiator_present = true;
                } else {
                    remaining.push((member.user_id, member.role));
                }
            }
            if !initiator_present {
                return Err(rotation_changed());
            }
            let mut planned = bound
                .iter()
                .filter(|member| member.plan_id == plan.plan_id)
                .map(|member| {
                    if member.user_id == expected.user_id || member.record_id != member.user_id {
                        return Err(rotation_changed());
                    }
                    Ok((
                        member.user_id.clone(),
                        member.role.clone().ok_or_else(rotation_changed)?,
                    ))
                })
                .collect::<Result<Vec<_>, RuntimeError>>()?;
            planned.sort_by(|a, b| a.0.cmp(&b.0));
            remaining.sort_by(|a, b| a.0.cmp(&b.0));
            if remaining != planned {
                return Err(rotation_changed());
            }
        }
        Ok(())
    }
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RotationMemberPayload {
    user_id: String,
    public_key: String,
    role: server_contract::VaultRole,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RotationItemPayload {
    id: String,
    vault_id: String,
    encrypted_data: String,
    encryption_iv: String,
    encryption_algorithm: String,
    encryption_version: i32,
    encrypted_by_user_id: String,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RotationAttachmentPayload {
    attachment_id: String,
    vault_id: String,
    uploaded_by: String,
    encrypted_attachment_key: String,
    attachment_key_iv: String,
    attachment_key_algorithm: String,
    envelope_version: i32,
}

fn public_start_code(code: RotationStartRejectionCode) -> PublicStartCode {
    match code {
        RotationStartRejectionCode::TeamMemberNotFound => PublicStartCode::TeamMemberNotFound,
        RotationStartRejectionCode::PersonalTeamDepartureForbidden => {
            PublicStartCode::PersonalTeamDepartureForbidden
        }
        RotationStartRejectionCode::TeamOwnerLeaveForbidden => {
            PublicStartCode::TeamOwnerLeaveForbidden
        }
        _ => unreachable!("only Team-leave start rejections enter the public path"),
    }
}
fn public_finalize_code(code: RotationFinalizeRejectionCode) -> PublicFinalizeCode {
    match code {
        RotationFinalizeRejectionCode::TeamMembershipChanged => {
            PublicFinalizeCode::TeamMembershipChanged
        }
        RotationFinalizeRejectionCode::PersonalTeamDepartureForbidden => {
            PublicFinalizeCode::PersonalTeamDepartureForbidden
        }
        RotationFinalizeRejectionCode::TeamOwnerLeaveForbidden => {
            PublicFinalizeCode::TeamOwnerLeaveForbidden
        }
        RotationFinalizeRejectionCode::RotationPlanUnavailable => {
            PublicFinalizeCode::RotationPlanUnavailable
        }
        RotationFinalizeRejectionCode::RotationPlanMismatch => {
            PublicFinalizeCode::RotationPlanMismatch
        }
        RotationFinalizeRejectionCode::RotationPlanIncomplete => {
            PublicFinalizeCode::RotationPlanIncomplete
        }
        RotationFinalizeRejectionCode::RotationPlanStale => PublicFinalizeCode::RotationPlanStale,
        RotationFinalizeRejectionCode::RotationPlanSetMismatch => {
            PublicFinalizeCode::RotationPlanSetMismatch
        }
    }
}
fn rotation_changed() -> RuntimeError {
    RuntimeError::new(
        RuntimeErrorCode::InvariantViolation,
        "Rotation selection or Account authority changed",
    )
}
fn rotation_candidates(
    members: &[RotationMemberRecord],
    current_user_id: &str,
) -> Result<Vec<RotationCandidate>, RuntimeError> {
    let mut candidates: Vec<RotationCandidate> = Vec::new();
    for member in members {
        if member.user_id == current_user_id {
            continue;
        }
        if let Some(prior) = candidates
            .iter()
            .find(|candidate| candidate.user_id == member.user_id)
        {
            if prior.public_key != member.public_key {
                return Err(rotation_changed());
            }
            continue;
        }
        let fingerprint = bittery_crypto_core::rsa::rsa_public_key_fingerprint(&member.public_key)
            .map_err(|_| rotation_changed())?;
        candidates.push(RotationCandidate {
            user_id: member.user_id.clone(),
            public_key: member.public_key.clone(),
            fingerprint,
        });
    }
    candidates.sort_by(|a, b| a.user_id.cmp(&b.user_id));
    Ok(candidates)
}
fn rotation_unsupported() -> RuntimeError {
    RuntimeError::new(
        RuntimeErrorCode::AuthorityMissing,
        "Rotation private completion is not available for this plan set",
    )
}
fn rotation_cancelled() -> RuntimeError {
    RuntimeError::new(
        RuntimeErrorCode::Cancelled,
        "Rotation caller was cancelled before durable acceptance",
    )
}
fn rotation_authentication_required() -> RuntimeError {
    RuntimeError::new(
        RuntimeErrorCode::AuthenticationRequired,
        "Rotation requires this Account's Session",
    )
}
