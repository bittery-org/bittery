use super::*;

/// The Server's three distinct plan-start routes, including the member the request removes.
/// Team starts keep a Team target even when their authoritative plan list is empty.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub(crate) enum RotationIntent {
    VaultMemberRemoval { vault_id: String, user_id: String },
    TeamLeave { team_id: String },
    TeamMemberRemoval { team_id: String, user_id: String },
}

/// Non-secret plan identities and bounds retained after the compact start receipt is written.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct RotationPlanRecord {
    pub plan_id: String,
    pub vault_id: String,
    pub initiator_user_id: String,
    pub expected_key_version: i32,
    pub idle_expires_at: String,
    pub absolute_expires_at: String,
}

/// Exact nonsecret Server member manifest bound before a private selection is issued.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct RotationMemberRecord {
    pub plan_id: String,
    pub record_id: String,
    pub expected_version: i32,
    pub user_id: String,
    pub public_key: String,
    #[serde(default)]
    pub role: Option<crate::server_contract::VaultRole>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct RotationResultRecord {
    pub plan_id: String,
    pub vault_id: String,
    pub key_version: i32,
    pub rotation_id: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub(crate) enum RotationAttemptPhase {
    Starting,
    Prepared,
    Consumed {
        attempt_id: String,
    },
    Finalizing {
        attempt_id: String,
        finalize_operation_id: String,
        affected_vault_ids: Vec<String>,
        expected_key_versions: Vec<i32>,
    },
    AppliedAwaitingRefresh {
        attempt_id: String,
        finalize_operation_id: String,
        personal_team_id: String,
    },
    RejectedAwaitingRefresh {
        attempt_id: String,
        finalize_operation_id: String,
        code: RotationFinalizeRejectionCode,
        details: Option<RotationStaleDetails>,
    },
    Completed {
        attempt_id: String,
        finalize_operation_id: String,
        personal_team_id: String,
    },
    Rejected {
        attempt_id: String,
        finalize_operation_id: String,
        code: RotationFinalizeRejectionCode,
        details: Option<RotationStaleDetails>,
    },
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct RotationStaleDetails {
    pub plan_id: String,
    pub reason: RotationStaleReason,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum RotationStaleReason {
    VaultVersion,
    MemberSet,
    ItemState,
    AttachmentState,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum RotationFinalizeRejectionCode {
    TeamMembershipChanged,
    PersonalTeamDepartureForbidden,
    TeamOwnerLeaveForbidden,
    RotationPlanUnavailable,
    RotationPlanMismatch,
    RotationPlanIncomplete,
    RotationPlanStale,
    RotationPlanSetMismatch,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct RotationAttemptRecord {
    pub account_id: AccountId,
    pub start_operation_id: String,
    pub intent: RotationIntent,
    pub plans: Vec<RotationPlanRecord>,
    #[serde(default)]
    pub member_manifest: Option<Vec<RotationMemberRecord>>,
    #[serde(default)]
    pub team_role: Option<crate::server_contract::TeamRole>,
    #[serde(default)]
    pub presentation_acknowledged: bool,
    #[serde(default)]
    pub applied_results: Vec<RotationResultRecord>,
    #[serde(default)]
    pub authority_generation_id: Option<String>,
    pub phase: RotationAttemptPhase,
}

impl RotationAttemptRecord {
    pub(crate) fn fences_vault(&self, vault_id: &str) -> bool {
        matches!(
            self.phase,
            RotationAttemptPhase::Finalizing { .. }
                | RotationAttemptPhase::AppliedAwaitingRefresh { .. }
                | RotationAttemptPhase::RejectedAwaitingRefresh { .. }
        ) && self.plans.iter().any(|plan| plan.vault_id == vault_id)
    }
}

impl ReplicaSnapshot {
    pub(crate) fn rotation_fenced_vault_ids(&self) -> Vec<String> {
        let mut ids: Vec<_> = self
            .rotation_attempts
            .iter()
            .filter(|attempt| {
                matches!(
                    attempt.phase,
                    RotationAttemptPhase::Finalizing { .. }
                        | RotationAttemptPhase::AppliedAwaitingRefresh { .. }
                        | RotationAttemptPhase::RejectedAwaitingRefresh { .. }
                )
            })
            .flat_map(|attempt| attempt.plans.iter().map(|plan| plan.vault_id.clone()))
            .collect();
        ids.sort();
        ids.dedup();
        ids
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum RotationStartRejectionCode {
    VaultAccessDenied,
    VaultMemberNotFound,
    SelfRemovalForbidden,
    VaultOwnerProtected,
    VaultAdminPeerProtected,
    SharedVaultRequired,
    VaultSharingEntitlementDenied,
    TeamMemberNotFound,
    PersonalTeamDepartureForbidden,
    TeamOwnerLeaveForbidden,
    TeamManagementDenied,
    TeamOwnerProtected,
    TeamManagementEntitlementDenied,
    VaultManagementIncomplete,
}

pub(crate) fn rotation_plan_digest(
    plans: &[RotationPlanRecord],
) -> Result<Sha256Fingerprint, RuntimeError> {
    let bytes = serde_json::to_vec(plans)
        .map_err(|_| replica_invariant("Rotation plan list could not be serialized"))?;
    Ok(Sha256Fingerprint::of_bytes(&bytes))
}

pub(crate) fn team_leave_start_operation(team_id: &str) -> OperationRecord {
    let operation_id = bittery_crypto_core::generate_uuid();
    OperationRecord {
        operation_id,
        kind: OperationKind::CreateTeamLeaveRotationPlans,
        target: ResourceRef::Team {
            team_id: team_id.to_owned(),
        },
        request: ImmutableHttpRequest {
            method: HttpMethod::Post,
            path: format!(
                "/api/v1/teams/{}/leave-rotation-plans",
                encode_component(team_id)
            ),
            headers: Vec::new(),
            body: Vec::new(),
        },
        request_fingerprint: rotation_start_fingerprint(
            b"create_team_leave_rotation_plans",
            b"POST /api/v1/teams/{teamId}/leave-rotation-plans",
            &[team_id],
        ),
        accepted_item_category: None,
        attachment_move_recovery: None,
        update_vault: None,
        create_vault: None,
        scheduling: OperationSchedulingState::default(),
        legacy_admission: None,
    }
}

pub(crate) fn team_leave_finalize_operation(
    team_id: &str,
    plans: &[RotationPlanRecord],
) -> Result<OperationRecord, RuntimeError> {
    let body = serde_json::to_vec(&serde_json::json!({
        "planIds": plans.iter().map(|plan| &plan.plan_id).collect::<Vec<_>>()
    }))
    .map_err(|_| replica_invariant("Rotation finalize plan IDs cannot be serialized"))?;
    Ok(OperationRecord {
        operation_id: bittery_crypto_core::generate_uuid(),
        kind: OperationKind::FinalizeTeamLeaveRotationPlans,
        target: ResourceRef::Team {
            team_id: team_id.to_owned(),
        },
        request: ImmutableHttpRequest {
            method: HttpMethod::Post,
            path: format!(
                "/api/v1/teams/{}/leave-rotation-plans/finalize",
                encode_component(team_id)
            ),
            headers: vec![HttpHeader {
                name: "Content-Type".into(),
                value: "application/json".into(),
            }],
            body: body.clone(),
        },
        request_fingerprint: rotation_request_fingerprint(
            b"finalize_team_leave_rotation_plans",
            b"POST /api/v1/teams/{teamId}/leave-rotation-plans/finalize",
            &[team_id],
            &body,
        ),
        accepted_item_category: None,
        attachment_move_recovery: None,
        update_vault: None,
        create_vault: None,
        scheduling: OperationSchedulingState::default(),
        legacy_admission: None,
    })
}

impl AccountReplica {
    pub(super) fn bind_rotation_start(
        &mut self,
        start_operation_id: &str,
        intent: RotationIntent,
        authority_generation_id: String,
        team_role: crate::server_contract::TeamRole,
    ) -> Result<(), RuntimeError> {
        let operation = self
            .operations
            .get(start_operation_id)
            .ok_or_else(|| replica_invariant("Rotation start was not durably accepted"))?;
        if authority_generation_id.is_empty()
            || self.rotation_attempts.contains_key(start_operation_id)
            || !matches!(
                (&operation.kind, &operation.target, &intent),
                (
                    OperationKind::CreateTeamLeaveRotationPlans,
                    ResourceRef::Team { team_id: target },
                    RotationIntent::TeamLeave { team_id: expected },
                ) if target == expected
            )
        {
            return Err(replica_invariant(
                "Rotation start preflight binding changed",
            ));
        }
        self.rotation_attempts.insert(
            start_operation_id.to_owned(),
            RotationAttemptRecord {
                account_id: self.account_id.clone(),
                start_operation_id: start_operation_id.to_owned(),
                intent,
                plans: Vec::new(),
                member_manifest: None,
                team_role: Some(team_role),
                presentation_acknowledged: false,
                applied_results: Vec::new(),
                authority_generation_id: Some(authority_generation_id),
                phase: RotationAttemptPhase::Starting,
            },
        );
        Ok(())
    }

    pub(crate) fn validate_rotation_attempts(&self) -> Result<(), RuntimeError> {
        for receipt in self.receipts.values() {
            if matches!(
                &receipt.result,
                OperationOutcomeResult::RotationStartAppliedReceipt { .. }
            ) && !self.rotation_attempts.contains_key(&receipt.operation_id)
            {
                return Err(replica_invariant(
                    "Applied Rotation start receipt has no atomic attempt",
                ));
            }
            if receipt.kind == OperationKind::FinalizeTeamLeaveRotationPlans
                && !self
                    .rotation_attempts
                    .values()
                    .any(|attempt| match &attempt.phase {
                        RotationAttemptPhase::AppliedAwaitingRefresh {
                            finalize_operation_id,
                            ..
                        }
                        | RotationAttemptPhase::RejectedAwaitingRefresh {
                            finalize_operation_id,
                            ..
                        }
                        | RotationAttemptPhase::Completed {
                            finalize_operation_id,
                            ..
                        }
                        | RotationAttemptPhase::Rejected {
                            finalize_operation_id,
                            ..
                        } => finalize_operation_id == &receipt.operation_id,
                        _ => false,
                    })
            {
                return Err(replica_invariant(
                    "Rotation finalize receipt has no atomic attempt",
                ));
            }
        }
        for attempt in self.rotation_attempts.values() {
            if matches!(attempt.phase, RotationAttemptPhase::Starting) {
                let Some(operation) = self.operations.get(&attempt.start_operation_id) else {
                    return Err(replica_invariant(
                        "Starting Rotation lost its accepted request",
                    ));
                };
                if attempt.account_id != self.account_id
                    || !attempt.plans.is_empty()
                    || attempt
                        .authority_generation_id
                        .as_ref()
                        .is_none_or(String::is_empty)
                    || self.receipts.contains_key(&attempt.start_operation_id)
                    || check_immutable_request(operation).is_err()
                    || !matches!(
                        (&operation.kind, &operation.target, &attempt.intent),
                        (
                            OperationKind::CreateTeamLeaveRotationPlans,
                            ResourceRef::Team { team_id: target },
                            RotationIntent::TeamLeave { team_id: expected },
                        ) if target == expected
                    )
                {
                    return Err(replica_invariant("Starting Rotation binding is incomplete"));
                }
                continue;
            }
            let Some(receipt) = self.receipts.get(&attempt.start_operation_id) else {
                return Err(replica_invariant(
                    "Rotation attempt has no atomic start receipt",
                ));
            };
            let OperationOutcomeResult::RotationStartAppliedReceipt {
                plan_set_fingerprint,
                plan_count,
            } = receipt.result
            else {
                return Err(replica_invariant(
                    "Rotation attempt has no applied start receipt",
                ));
            };
            let RotationIntent::TeamLeave { team_id } = &attempt.intent else {
                return Err(replica_invariant("Rotation attempt intent is unsupported"));
            };
            let finalize_body = serde_json::to_vec(&serde_json::json!({
                "planIds": attempt.plans.iter().map(|plan| &plan.plan_id).collect::<Vec<_>>()
            }))
            .map_err(|_| replica_invariant("Rotation finalize plan list is invalid"))?;
            if attempt.account_id != self.account_id
                || self.operations.contains_key(&attempt.start_operation_id)
                || receipt.operation_id != attempt.start_operation_id
                || receipt.kind != OperationKind::CreateTeamLeaveRotationPlans
                || !matches!(
                    (&receipt.target, &attempt.intent),
                    (
                        ResourceRef::Team { team_id: target },
                        RotationIntent::TeamLeave { team_id: intent }
                    ) if target == intent
                )
                || usize::from(plan_count) != attempt.plans.len()
                || rotation_plan_digest(&attempt.plans)? != plan_set_fingerprint
                || receipt.request_fingerprint
                    != rotation_start_fingerprint(
                        b"create_team_leave_rotation_plans",
                        b"POST /api/v1/teams/{teamId}/leave-rotation-plans",
                        &[team_id],
                    )
            {
                return Err(replica_invariant(
                    "Rotation attempt disagrees with its start receipt",
                ));
            }
            if let Some(members) = &attempt.member_manifest {
                validate_member_manifest(&attempt.plans, members)?;
            }
            match &attempt.phase {
                RotationAttemptPhase::Starting => unreachable!(),
                RotationAttemptPhase::Prepared => {}
                RotationAttemptPhase::Consumed { attempt_id } => {
                    if attempt_id.is_empty() {
                        return Err(replica_invariant("Rotation consumption has no identity"));
                    }
                }
                RotationAttemptPhase::Finalizing {
                    attempt_id,
                    finalize_operation_id,
                    affected_vault_ids,
                    expected_key_versions,
                } => {
                    let finalizing = self.operations.get(finalize_operation_id);
                    if attempt_id.is_empty()
                        || finalize_operation_id.is_empty()
                        || affected_vault_ids
                            != &attempt
                                .plans
                                .iter()
                                .map(|plan| plan.vault_id.clone())
                                .collect::<Vec<_>>()
                        || expected_key_versions
                            != &attempt
                                .plans
                                .iter()
                                .map(|plan| plan.expected_key_version)
                                .collect::<Vec<_>>()
                        || finalizing.is_none_or(|operation| {
                            operation.kind != OperationKind::FinalizeTeamLeaveRotationPlans
                                || operation.target
                                    != (ResourceRef::Team {
                                        team_id: team_id.clone(),
                                    })
                                || operation.request.body != finalize_body
                                || check_immutable_request(operation).is_err()
                        })
                        || self.receipts.contains_key(finalize_operation_id)
                    {
                        return Err(replica_invariant("Rotation finalize journal is incomplete"));
                    }
                }
                RotationAttemptPhase::AppliedAwaitingRefresh {
                    attempt_id,
                    finalize_operation_id,
                    personal_team_id,
                }
                | RotationAttemptPhase::Completed {
                    attempt_id,
                    finalize_operation_id,
                    personal_team_id,
                } => {
                    let finalized = self.receipts.get(finalize_operation_id);
                    if attempt_id.is_empty()
                        || personal_team_id.is_empty()
                        || validate_rotation_results(&attempt.plans, &attempt.applied_results)
                            .is_err()
                        || finalized.is_none_or(|receipt| {
                            receipt.kind != OperationKind::FinalizeTeamLeaveRotationPlans
                            || receipt.target
                                != (ResourceRef::Team {
                                    team_id: team_id.clone(),
                                })
                            || receipt.request_fingerprint
                                != rotation_request_fingerprint(
                                    b"finalize_team_leave_rotation_plans",
                                    b"POST /api/v1/teams/{teamId}/leave-rotation-plans/finalize",
                                    &[team_id],
                                    &finalize_body,
                                )
                            || receipt.result
                                != (OperationOutcomeResult::RotationFinalizeApplied {
                                    personal_team_id: personal_team_id.clone(),
                                    rotations: attempt.applied_results.clone(),
                                })
                        })
                        || self.operations.contains_key(finalize_operation_id)
                    {
                        return Err(replica_invariant(
                            "Rotation applied receipt disagrees with its attempt",
                        ));
                    }
                }
                RotationAttemptPhase::RejectedAwaitingRefresh {
                    attempt_id,
                    finalize_operation_id,
                    code,
                    details,
                }
                | RotationAttemptPhase::Rejected {
                    attempt_id,
                    finalize_operation_id,
                    code,
                    details,
                } => {
                    let finalized = self.receipts.get(finalize_operation_id);
                    if attempt_id.is_empty()
                        || !attempt.applied_results.is_empty()
                        || finalized.is_none_or(|receipt| {
                            receipt.kind != OperationKind::FinalizeTeamLeaveRotationPlans
                            || receipt.target
                                != (ResourceRef::Team {
                                    team_id: team_id.clone(),
                                })
                            || receipt.request_fingerprint
                                != rotation_request_fingerprint(
                                    b"finalize_team_leave_rotation_plans",
                                    b"POST /api/v1/teams/{teamId}/leave-rotation-plans/finalize",
                                    &[team_id],
                                    &finalize_body,
                                )
                            || receipt.result
                                != (OperationOutcomeResult::RotationFinalizeRejected {
                                    code: *code,
                                    details: details.clone(),
                                })
                        })
                        || self.operations.contains_key(finalize_operation_id)
                    {
                        return Err(replica_invariant(
                            "Rotation rejected receipt disagrees with its attempt",
                        ));
                    }
                }
            }
        }
        Ok(())
    }

    pub(super) fn reconcile_rotation_start(
        &mut self,
        outcome: ObservedOutcome,
        intent: RotationIntent,
        validated_plans: Vec<RotationPlanRecord>,
    ) -> Result<(), RuntimeError> {
        let operation = self.operation_for(&outcome)?;
        let starting = self.rotation_attempts.get(&operation.operation_id);
        if starting.is_some_and(|attempt| {
            !matches!(attempt.phase, RotationAttemptPhase::Starting)
                || attempt.intent != intent
                || attempt.account_id != self.account_id
        }) || !matches!(
            (&operation.kind, &operation.target, &intent),
            (
                OperationKind::CreateTeamLeaveRotationPlans,
                ResourceRef::Team { team_id: target },
                RotationIntent::TeamLeave { team_id: intent },
            ) if target == intent
        ) {
            return Err(replica_invariant(
                "Rotation start intent does not match accepted Team work",
            ));
        }
        let authority_generation_id =
            starting.and_then(|attempt| attempt.authority_generation_id.clone());
        let team_role = starting.and_then(|attempt| attempt.team_role.clone());
        let compact_result = match &outcome.result {
            OperationOutcomeResult::RotationStartApplied { plans } if plans == &validated_plans => {
                validate_start_plans(self, &intent, plans)?;
                let plan_count = u16::try_from(plans.len())
                    .map_err(|_| replica_invariant("Rotation start has too many plans"))?;
                OperationOutcomeResult::RotationStartAppliedReceipt {
                    plan_set_fingerprint: rotation_plan_digest(plans)?,
                    plan_count,
                }
            }
            OperationOutcomeResult::RotationStartRejected { code }
                if validated_plans.is_empty()
                    && matches!(
                        code,
                        RotationStartRejectionCode::TeamMemberNotFound
                            | RotationStartRejectionCode::PersonalTeamDepartureForbidden
                            | RotationStartRejectionCode::TeamOwnerLeaveForbidden
                    ) =>
            {
                outcome.result.clone()
            }
            _ => {
                return Err(replica_invariant(
                    "Rotation start result and plan list disagree",
                ))
            }
        };
        let compact = ObservedOutcome {
            operation_id: outcome.operation_id,
            request_fingerprint: outcome.request_fingerprint,
            result: compact_result,
        };
        self.retain_receipt(&operation, &compact)?;
        if matches!(
            outcome.result,
            OperationOutcomeResult::RotationStartApplied { .. }
        ) {
            let attempt = RotationAttemptRecord {
                account_id: self.account_id.clone(),
                start_operation_id: operation.operation_id.clone(),
                intent,
                plans: validated_plans,
                member_manifest: None,
                team_role,
                presentation_acknowledged: false,
                applied_results: Vec::new(),
                authority_generation_id,
                phase: RotationAttemptPhase::Prepared,
            };
            self.rotation_attempts
                .insert(operation.operation_id.clone(), attempt);
        } else {
            self.rotation_attempts.remove(&operation.operation_id);
        }
        self.operations.remove(&operation.operation_id);
        Ok(())
    }

    pub(super) fn consume_rotation_attempt(
        &mut self,
        start_operation_id: &str,
        attempt_id: String,
    ) -> Result<(), RuntimeError> {
        let attempt = self
            .rotation_attempts
            .get_mut(start_operation_id)
            .ok_or_else(|| replica_invariant("Rotation selection has no durable attempt"))?;
        if attempt_id.is_empty()
            || !matches!(attempt.phase, RotationAttemptPhase::Prepared)
            || attempt.team_role.is_none()
            || (!attempt.plans.is_empty() && attempt.member_manifest.is_none())
        {
            return Err(replica_invariant("Rotation selection was already consumed"));
        }
        attempt.phase = RotationAttemptPhase::Consumed { attempt_id };
        Ok(())
    }

    pub(super) fn bind_rotation_manifest(
        &mut self,
        start_operation_id: &str,
        members: Vec<RotationMemberRecord>,
    ) -> Result<(), RuntimeError> {
        let attempt = self
            .rotation_attempts
            .get_mut(start_operation_id)
            .ok_or_else(|| replica_invariant("Rotation manifest has no prepared attempt"))?;
        if !matches!(attempt.phase, RotationAttemptPhase::Prepared) {
            return Err(replica_invariant(
                "Rotation manifest is no longer preparable",
            ));
        }
        validate_member_manifest(&attempt.plans, &members)?;
        match &attempt.member_manifest {
            Some(existing) if existing != &members => {
                Err(replica_invariant("Rotation member manifest changed"))
            }
            Some(_) => Ok(()),
            None => {
                attempt.member_manifest = Some(members);
                Ok(())
            }
        }
    }

    pub(super) fn acknowledge_rotation_attempt(
        &mut self,
        start_operation_id: &str,
    ) -> Result<(), RuntimeError> {
        let attempt = self
            .rotation_attempts
            .get_mut(start_operation_id)
            .ok_or_else(|| replica_invariant("Rotation attempt is missing"))?;
        if !matches!(&attempt.intent, RotationIntent::TeamLeave { .. })
            || !matches!(
                &attempt.phase,
                RotationAttemptPhase::Completed { .. } | RotationAttemptPhase::Rejected { .. }
            )
        {
            return Err(replica_invariant("Rotation result is not terminal"));
        }
        attempt.presentation_acknowledged = true;
        Ok(())
    }

    pub(super) fn accept_rotation_finalize(
        &mut self,
        start_operation_id: &str,
        attempt_id: &str,
        operation: OperationRecord,
    ) -> Result<(), RuntimeError> {
        let attempt = self
            .rotation_attempts
            .get(start_operation_id)
            .ok_or_else(|| replica_invariant("Rotation finalize has no durable attempt"))?;
        let plan_ids: Vec<_> = attempt.plans.iter().map(|plan| &plan.plan_id).collect();
        if !matches!(&attempt.phase, RotationAttemptPhase::Consumed { attempt_id: id } if id == attempt_id)
            || serde_json::from_slice::<serde_json::Value>(&operation.request.body).ok()
                != Some(serde_json::json!({"planIds":plan_ids}))
            || !matches!((&attempt.intent, &operation.target),
                (RotationIntent::TeamLeave { team_id: intent }, ResourceRef::Team { team_id: target }) if intent == target)
            || operation.kind != OperationKind::FinalizeTeamLeaveRotationPlans
            || self.operations.contains_key(&operation.operation_id)
            || self.receipts.contains_key(&operation.operation_id)
            || self
                .cross_account_moves
                .contains_key(&operation.operation_id)
            || self
                .attachment_move_preparations
                .contains_key(&operation.operation_id)
        {
            return Err(replica_invariant(
                "Rotation finalize changed or reused its attempt",
            ));
        }
        check_immutable_request(&operation)?;
        let affected_vault_ids = attempt
            .plans
            .iter()
            .map(|plan| plan.vault_id.clone())
            .collect();
        let expected_key_versions = attempt
            .plans
            .iter()
            .map(|plan| plan.expected_key_version)
            .collect();
        let finalize_operation_id = operation.operation_id.clone();
        self.operations
            .insert(finalize_operation_id.clone(), operation);
        self.rotation_attempts
            .get_mut(start_operation_id)
            .unwrap()
            .phase = RotationAttemptPhase::Finalizing {
            attempt_id: attempt_id.to_owned(),
            finalize_operation_id,
            affected_vault_ids,
            expected_key_versions,
        };
        Ok(())
    }

    pub(super) fn reconcile_rotation_finalize(
        &mut self,
        start_operation_id: &str,
        outcome: ObservedOutcome,
    ) -> Result<(), RuntimeError> {
        let operation = self.operation_for(&outcome)?;
        let attempt = self
            .rotation_attempts
            .get(start_operation_id)
            .ok_or_else(|| replica_invariant("Rotation finalize has no durable attempt"))?;
        let RotationAttemptPhase::Finalizing {
            attempt_id,
            finalize_operation_id,
            affected_vault_ids,
            expected_key_versions,
        } = &attempt.phase
        else {
            return Err(replica_invariant("Rotation finalize is not active"));
        };
        if finalize_operation_id != &operation.operation_id
            || affected_vault_ids
                != &attempt
                    .plans
                    .iter()
                    .map(|plan| plan.vault_id.clone())
                    .collect::<Vec<_>>()
            || expected_key_versions
                != &attempt
                    .plans
                    .iter()
                    .map(|plan| plan.expected_key_version)
                    .collect::<Vec<_>>()
            || operation.kind != OperationKind::FinalizeTeamLeaveRotationPlans
        {
            return Err(replica_invariant(
                "Rotation finalize result changed its selection",
            ));
        }
        let applied_results = match &outcome.result {
            OperationOutcomeResult::RotationFinalizeApplied { rotations, .. } => {
                validate_rotation_results(&attempt.plans, rotations)?;
                rotations.clone()
            }
            _ => Vec::new(),
        };
        let next = match &outcome.result {
            OperationOutcomeResult::RotationFinalizeApplied {
                personal_team_id, ..
            } if !personal_team_id.is_empty() && personal_team_id.len() <= 128 => {
                RotationAttemptPhase::AppliedAwaitingRefresh {
                    attempt_id: attempt_id.clone(),
                    finalize_operation_id: finalize_operation_id.clone(),
                    personal_team_id: personal_team_id.clone(),
                }
            }
            OperationOutcomeResult::RotationFinalizeRejected { code, details }
                if details.is_none() =>
            {
                RotationAttemptPhase::RejectedAwaitingRefresh {
                    attempt_id: attempt_id.clone(),
                    finalize_operation_id: finalize_operation_id.clone(),
                    code: *code,
                    details: None,
                }
            }
            _ => return Err(replica_invariant("Rotation finalize result is invalid")),
        };
        self.retain_receipt(&operation, &outcome)?;
        self.operations.remove(&operation.operation_id);
        let attempt = self.rotation_attempts.get_mut(start_operation_id).unwrap();
        attempt.applied_results = applied_results;
        attempt.phase = next;
        Ok(())
    }

    pub(super) fn complete_rotation_refresh(
        &mut self,
        start_operation_id: &str,
        finalize_operation_id: &str,
    ) -> Result<(), RuntimeError> {
        let attempt = self
            .rotation_attempts
            .get_mut(start_operation_id)
            .ok_or_else(|| replica_invariant("Rotation refresh has no durable attempt"))?;
        attempt.phase = match &attempt.phase {
            RotationAttemptPhase::AppliedAwaitingRefresh {
                attempt_id,
                finalize_operation_id: id,
                personal_team_id,
            } if id == finalize_operation_id => RotationAttemptPhase::Completed {
                attempt_id: attempt_id.clone(),
                finalize_operation_id: id.clone(),
                personal_team_id: personal_team_id.clone(),
            },
            RotationAttemptPhase::RejectedAwaitingRefresh {
                attempt_id,
                finalize_operation_id: id,
                code,
                details,
            } if id == finalize_operation_id => RotationAttemptPhase::Rejected {
                attempt_id: attempt_id.clone(),
                finalize_operation_id: id.clone(),
                code: *code,
                details: details.clone(),
            },
            _ => {
                return Err(replica_invariant(
                    "Rotation refresh duty changed or was already completed",
                ))
            }
        };
        Ok(())
    }
}

fn validate_start_plans(
    account: &AccountReplica,
    intent: &RotationIntent,
    plans: &[RotationPlanRecord],
) -> Result<(), RuntimeError> {
    const MAX_PLANS: usize = 21_000;
    const MAX_PLAN_BYTES: usize = 8 * 1024 * 1024;
    if plans.len() > MAX_PLANS {
        return Err(replica_invariant(
            "Rotation plan list exceeds the authority bound",
        ));
    }
    let mut plan_ids = HashSet::new();
    let mut vault_ids = HashSet::new();
    for plan in plans {
        for id in [&plan.plan_id, &plan.vault_id, &plan.initiator_user_id] {
            if id.is_empty() || id.len() > 128 {
                return Err(replica_invariant("Rotation plan identity is invalid"));
            }
        }
        if plan.initiator_user_id != account.user_id
            || !(1..i32::MAX).contains(&plan.expected_key_version)
            || plan.idle_expires_at.is_empty()
            || plan.absolute_expires_at.is_empty()
            || plan.idle_expires_at.len() > 64
            || plan.absolute_expires_at.len() > 64
            || !plan_ids.insert(&plan.plan_id)
            || !vault_ids.insert(&plan.vault_id)
        {
            return Err(replica_invariant(
                "Rotation plan is duplicate or changed its owner",
            ));
        }
        // The Server's accepted plan remains authoritative even if a separate Bootstrap
        // replaces local Vault authority while this start request is in flight. Retain the
        // exact plan; the public selection/Complete path refuses stale local authority.
        if let RotationIntent::VaultMemberRemoval { vault_id, .. } = intent {
            if &plan.vault_id != vault_id {
                return Err(replica_invariant("Vault removal plan changed its target"));
            }
        }
    }
    if matches!(intent, RotationIntent::VaultMemberRemoval { .. }) && plans.len() != 1 {
        return Err(replica_invariant("Vault removal must return one plan"));
    }
    if serde_json::to_vec(plans)
        .map_err(|_| replica_invariant("Rotation plan list could not be serialized"))?
        .len()
        > MAX_PLAN_BYTES
    {
        return Err(replica_invariant(
            "Rotation plan list exceeds the retained byte bound",
        ));
    }
    Ok(())
}

fn validate_member_manifest(
    plans: &[RotationPlanRecord],
    members: &[RotationMemberRecord],
) -> Result<(), RuntimeError> {
    const MAX_MEMBERS: usize = 21_000;
    const MAX_MEMBER_BYTES: usize = 32 * 1024 * 1024;
    if members.len() > MAX_MEMBERS
        || serde_json::to_vec(members)
            .map_err(|_| replica_invariant("Rotation manifest cannot be serialized"))?
            .len()
            > MAX_MEMBER_BYTES
    {
        return Err(replica_invariant(
            "Rotation member manifest exceeds its bound",
        ));
    }
    let mut seen = HashSet::new();
    for member in members {
        if member.record_id != member.user_id
            || member.user_id.is_empty()
            || member.user_id.len() > 128
            || member.public_key.is_empty()
            || member.public_key.len() > 16 * 1024
            || !seen.insert((&member.plan_id, &member.record_id))
            || plans
                .iter()
                .find(|plan| plan.plan_id == member.plan_id)
                .is_none_or(|plan| plan.expected_key_version != member.expected_version)
        {
            return Err(replica_invariant(
                "Rotation member manifest changed or is invalid",
            ));
        }
    }
    if plans
        .iter()
        .any(|plan| !members.iter().any(|member| member.plan_id == plan.plan_id))
    {
        return Err(replica_invariant("Rotation plan has no remaining Member"));
    }
    Ok(())
}

fn validate_rotation_results(
    plans: &[RotationPlanRecord],
    results: &[RotationResultRecord],
) -> Result<(), RuntimeError> {
    if results.len() != plans.len() {
        return Err(replica_invariant("Rotation result count changed"));
    }
    let mut ids = HashSet::new();
    for (plan, result) in plans.iter().zip(results) {
        if result.plan_id != plan.plan_id
            || result.vault_id != plan.vault_id
            || Some(result.key_version) != plan.expected_key_version.checked_add(1)
            || result.rotation_id.is_empty()
            || result.rotation_id.len() > 128
            || !ids.insert(&result.rotation_id)
        {
            return Err(replica_invariant(
                "Rotation result changed its plan or version",
            ));
        }
    }
    Ok(())
}
