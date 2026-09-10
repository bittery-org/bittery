//! Closed retained Rotation answers. The Domain owns policies; this boundary owns retention.
use super::{OperationOutcome, StoredOutcomeRow};
use crate::{
    db::enums::{OperationKind, OperationOutcomeStatus, VaultKeyRotationStaleReason},
    error::AppError,
};
use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub(crate) enum InitialRotationPlanState {
    Preparing,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct RotationPlanSnapshot {
    pub id: String,
    pub vault_id: String,
    pub initiator_user_id: String,
    pub expected_key_version: i32,
    pub state: InitialRotationPlanState,
    #[schema(format = DateTime)]
    pub idle_expires_at: String,
    #[schema(format = DateTime)]
    pub absolute_expires_at: String,
}
impl From<crate::domains::vaults::rotation::plans::RotationPlanSummary> for RotationPlanSnapshot {
    fn from(plan: crate::domains::vaults::rotation::plans::RotationPlanSummary) -> Self {
        Self {
            id: plan.id,
            vault_id: plan.vault_id,
            initiator_user_id: plan.initiator_user_id,
            expected_key_version: plan.expected_key_version,
            state: InitialRotationPlanState::Preparing,
            idle_expires_at: plan.idle_expires_at,
            absolute_expires_at: plan.absolute_expires_at,
        }
    }
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct RotationStaleDetails {
    pub plan_id: String,
    pub reason: VaultKeyRotationStaleReason,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, ToSchema)]
#[serde(tag = "status", rename_all = "snake_case", deny_unknown_fields)]
pub(crate) enum CreateVaultMemberRemovalRotationPlansResult {
    Applied {
        plans: Vec<RotationPlanSnapshot>,
    },
    Rejected {
        code: CreateVaultMemberRemovalRotationPlansRejectionCode,
    },
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub(crate) enum CreateVaultMemberRemovalRotationPlansRejectionCode {
    VaultAccessDenied,
    VaultMemberNotFound,
    SelfRemovalForbidden,
    VaultOwnerProtected,
    VaultAdminPeerProtected,
    SharedVaultRequired,
    VaultSharingEntitlementDenied,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, ToSchema)]
#[serde(tag = "status", rename_all = "snake_case", deny_unknown_fields)]
pub(crate) enum FinalizeVaultMemberRemovalRotationPlansResult {
    Applied {
        rotations: Vec<crate::domains::vaults::rotation::plans::RotationResult>,
    },
    Rejected {
        code: FinalizeVaultMemberRemovalRotationPlansRejectionCode,
        #[serde(skip_serializing_if = "Option::is_none")]
        details: Option<RotationStaleDetails>,
    },
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub(crate) enum FinalizeVaultMemberRemovalRotationPlansRejectionCode {
    VaultAccessDenied,
    VaultMembershipChanged,
    SelfRemovalForbidden,
    VaultOwnerProtected,
    VaultAdminPeerProtected,
    SharedVaultRequired,
    VaultSharingEntitlementDenied,
    RotationPlanUnavailable,
    RotationPlanMismatch,
    RotationPlanIncomplete,
    RotationPlanStale,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, ToSchema)]
#[serde(tag = "status", rename_all = "snake_case", deny_unknown_fields)]
pub(crate) enum CreateTeamLeaveRotationPlansResult {
    Applied {
        plans: Vec<RotationPlanSnapshot>,
    },
    Rejected {
        code: CreateTeamLeaveRotationPlansRejectionCode,
    },
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub(crate) enum CreateTeamLeaveRotationPlansRejectionCode {
    TeamMemberNotFound,
    PersonalTeamDepartureForbidden,
    TeamOwnerLeaveForbidden,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, ToSchema)]
#[serde(tag = "status", rename_all = "snake_case", deny_unknown_fields)]
pub(crate) enum FinalizeTeamLeaveRotationPlansResult {
    Applied {
        rotations: Vec<crate::domains::vaults::rotation::plans::RotationResult>,
        #[serde(rename = "personalTeamId")]
        personal_team_id: String,
    },
    Rejected {
        code: FinalizeTeamLeaveRotationPlansRejectionCode,
        #[serde(skip_serializing_if = "Option::is_none")]
        details: Option<RotationStaleDetails>,
    },
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub(crate) enum FinalizeTeamLeaveRotationPlansRejectionCode {
    TeamMembershipChanged,
    PersonalTeamDepartureForbidden,
    TeamOwnerLeaveForbidden,
    RotationPlanUnavailable,
    RotationPlanMismatch,
    RotationPlanIncomplete,
    RotationPlanStale,
    RotationPlanSetMismatch,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, ToSchema)]
#[serde(tag = "status", rename_all = "snake_case", deny_unknown_fields)]
pub(crate) enum CreateTeamMemberRemovalRotationPlansResult {
    Applied {
        plans: Vec<RotationPlanSnapshot>,
    },
    Rejected {
        code: CreateTeamMemberRemovalRotationPlansRejectionCode,
    },
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub(crate) enum CreateTeamMemberRemovalRotationPlansRejectionCode {
    TeamMemberNotFound,
    PersonalTeamDepartureForbidden,
    SelfRemovalForbidden,
    TeamManagementDenied,
    TeamOwnerProtected,
    TeamManagementEntitlementDenied,
    VaultManagementIncomplete,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, ToSchema)]
#[serde(tag = "status", rename_all = "snake_case", deny_unknown_fields)]
pub(crate) enum FinalizeTeamMemberRemovalRotationPlansResult {
    Applied {
        rotations: Vec<crate::domains::vaults::rotation::plans::RotationResult>,
        #[serde(rename = "personalTeamId")]
        personal_team_id: String,
    },
    Rejected {
        code: FinalizeTeamMemberRemovalRotationPlansRejectionCode,
        #[serde(skip_serializing_if = "Option::is_none")]
        details: Option<RotationStaleDetails>,
    },
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub(crate) enum FinalizeTeamMemberRemovalRotationPlansRejectionCode {
    TeamMembershipChanged,
    PersonalTeamDepartureForbidden,
    SelfRemovalForbidden,
    TeamManagementDenied,
    TeamOwnerProtected,
    TeamManagementEntitlementDenied,
    VaultManagementIncomplete,
    RotationPlanUnavailable,
    RotationPlanMismatch,
    RotationPlanIncomplete,
    RotationPlanStale,
    RotationPlanSetMismatch,
}

pub(super) fn is_rotation_kind(kind: OperationKind) -> bool {
    matches!(
        kind,
        OperationKind::CreateVaultMemberRemovalRotationPlans
            | OperationKind::FinalizeVaultMemberRemovalRotationPlans
            | OperationKind::CreateTeamLeaveRotationPlans
            | OperationKind::FinalizeTeamLeaveRotationPlans
            | OperationKind::CreateTeamMemberRemovalRotationPlans
            | OperationKind::FinalizeTeamMemberRemovalRotationPlans
    )
}

pub(super) fn outcome_from_row(
    operation_id: &str,
    row: StoredOutcomeRow,
) -> Result<OperationOutcome, AppError> {
    let mut result = match row.result_status {
        OperationOutcomeStatus::Applied => {
            serde_json::from_str::<serde_json::Value>(&row.applied_payload.ok_or_else(|| {
                AppError::internal("Stored Rotation outcome is missing its payload")
            })?)
            .map_err(|_| AppError::internal("Stored Rotation payload is invalid"))?
        }
        OperationOutcomeStatus::Rejected => {
            let mut value = serde_json::json!({"code": row.rejection_code.ok_or_else(|| AppError::internal("Stored Rotation rejection is missing its code"))?});
            if let Some(details) = row.rejection_details {
                value["details"] = serde_json::from_str(&details).map_err(|_| {
                    AppError::internal("Stored Rotation rejection details are invalid")
                })?;
            }
            value
        }
    };
    result["status"] = serde_json::to_value(row.result_status)
        .map_err(|_| AppError::internal("Invalid Rotation status"))?;
    serde_json::from_value(serde_json::json!({"kind": row.operation_kind, "operationId": operation_id, "result":result})).map_err(|_| AppError::internal("Stored Rotation outcome violates its kind contract"))
}

use super::{fingerprint_part, load_outcome, OperationResolution, OPERATION_DISCRIMINATOR};
use crate::{
    config::DeploymentMode,
    db::{
        enums::{BillingPlan, SyncEntityType, SyncEventType},
        events::{
            begin_serializable_sync_event_transaction, generate_resource_id, insert_audit_event,
            insert_user_sync_event,
        },
    },
    domains::{
        billing::sync_team_seats_best_effort,
        vaults::rotation::{
            departure::{self, Intent},
            failure::RotationFailure,
            membership, plans,
        },
    },
    integrations::stripe::BillingGateway,
    shared::transaction::{acquire_operation_lock, database_error},
};
use sha2::{Digest, Sha256};
use sqlx::{query, PgPool, Postgres, Transaction};

/// Route identity is structural: a voluntary request cannot acquire an administrative fingerprint.
pub(crate) enum RotationEffect {
    CreateVaultRemoval {
        vault_id: String,
        target_id: String,
    },
    FinalizeVaultRemoval {
        vault_id: String,
        target_id: String,
        plan_id: String,
    },
    CreateTeamLeave {
        team_id: String,
    },
    FinalizeTeamLeave {
        team_id: String,
        plan_ids: Vec<String>,
    },
    CreateTeamRemoval {
        team_id: String,
        target_id: String,
    },
    FinalizeTeamRemoval {
        team_id: String,
        target_id: String,
        plan_ids: Vec<String>,
    },
}
impl RotationEffect {
    fn kind(&self) -> OperationKind {
        match self {
            Self::CreateVaultRemoval { .. } => OperationKind::CreateVaultMemberRemovalRotationPlans,
            Self::FinalizeVaultRemoval { .. } => {
                OperationKind::FinalizeVaultMemberRemovalRotationPlans
            }
            Self::CreateTeamLeave { .. } => OperationKind::CreateTeamLeaveRotationPlans,
            Self::FinalizeTeamLeave { .. } => OperationKind::FinalizeTeamLeaveRotationPlans,
            Self::CreateTeamRemoval { .. } => OperationKind::CreateTeamMemberRemovalRotationPlans,
            Self::FinalizeTeamRemoval { .. } => {
                OperationKind::FinalizeTeamMemberRemovalRotationPlans
            }
        }
    }
    fn route(&self) -> &'static str {
        match self {
            Self::CreateVaultRemoval { .. } => {
                "POST /api/v1/vaults/{vaultId}/members/{userId}/removal-rotation-plans"
            }
            Self::FinalizeVaultRemoval { .. } => {
                "POST /api/v1/vaults/{vaultId}/members/{userId}/removal-rotation-plans/finalize"
            }
            Self::CreateTeamLeave { .. } => "POST /api/v1/teams/{teamId}/leave-rotation-plans",
            Self::FinalizeTeamLeave { .. } => {
                "POST /api/v1/teams/{teamId}/leave-rotation-plans/finalize"
            }
            Self::CreateTeamRemoval { .. } => {
                "POST /api/v1/teams/{teamId}/members/{userId}/removal-rotation-plans"
            }
            Self::FinalizeTeamRemoval { .. } => {
                "POST /api/v1/teams/{teamId}/members/{userId}/removal-rotation-plans/finalize"
            }
        }
    }
    fn path_values(&self) -> Vec<&str> {
        match self {
            Self::CreateVaultRemoval {
                vault_id,
                target_id,
            }
            | Self::FinalizeVaultRemoval {
                vault_id,
                target_id,
                ..
            } => vec![vault_id, target_id],
            Self::CreateTeamLeave { team_id } | Self::FinalizeTeamLeave { team_id, .. } => {
                vec![team_id]
            }
            Self::CreateTeamRemoval { team_id, target_id }
            | Self::FinalizeTeamRemoval {
                team_id, target_id, ..
            } => vec![team_id, target_id],
        }
    }
    fn billing_team(&self) -> Option<&str> {
        match self {
            Self::FinalizeTeamLeave { team_id, .. } | Self::FinalizeTeamRemoval { team_id, .. } => {
                Some(team_id)
            }
            _ => None,
        }
    }
}
pub(crate) struct RotationOperationInput {
    pub operation_id: String,
    pub user_id: String,
    pub effect: RotationEffect,
    pub raw_body: Vec<u8>,
    pub deployment_mode: DeploymentMode,
}
fn fingerprint(input: &RotationOperationInput) -> [u8; 32] {
    let mut hash = Sha256::new();
    fingerprint_part(&mut hash, OPERATION_DISCRIMINATOR);
    fingerprint_part(&mut hash, input.effect.kind().as_str().as_bytes());
    fingerprint_part(&mut hash, input.effect.route().as_bytes());
    for value in input.effect.path_values() {
        fingerprint_part(&mut hash, value.as_bytes());
    }
    fingerprint_part(&mut hash, &input.raw_body);
    fingerprint_part(&mut hash, b"");
    hash.finalize().into()
}
fn snapshot_payload(plans: Vec<plans::RotationPlanSummary>) -> serde_json::Value {
    serde_json::json!({"plans": plans.into_iter().map(RotationPlanSnapshot::from).collect::<Vec<_>>()})
}
async fn apply(
    tx: &mut Transaction<'_, Postgres>,
    input: &RotationOperationInput,
) -> Result<(serde_json::Value, Option<BillingPlan>), RotationFailure> {
    let actor = &input.user_id;
    let mode = input.deployment_mode;
    match &input.effect {
        RotationEffect::CreateVaultRemoval {
            vault_id,
            target_id,
        } => {
            let plan = membership::create_removal_plan_in_transaction(
                tx, mode, actor, vault_id, target_id,
            )
            .await?;
            Ok((snapshot_payload(vec![plan]), None))
        }
        RotationEffect::FinalizeVaultRemoval {
            vault_id,
            target_id,
            plan_id,
        } => {
            let result = membership::finalize_removal_in_transaction(
                tx, mode, actor, vault_id, target_id, plan_id,
            )
            .await?;
            Ok((serde_json::json!({"rotations":[result.rotation]}), None))
        }
        RotationEffect::CreateTeamLeave { team_id } => {
            let result = departure::create_plans_in_transaction(
                tx,
                mode,
                team_id,
                actor,
                actor,
                Intent::Voluntary,
            )
            .await?;
            Ok((snapshot_payload(result.plans), None))
        }
        RotationEffect::CreateTeamRemoval { team_id, target_id } => {
            let result = departure::create_plans_in_transaction(
                tx,
                mode,
                team_id,
                actor,
                target_id,
                Intent::Administrative,
            )
            .await?;
            Ok((snapshot_payload(result.plans), None))
        }
        RotationEffect::FinalizeTeamLeave { team_id, plan_ids } => {
            let (result, billing) = departure::finalize_in_transaction(
                tx,
                mode,
                team_id,
                actor,
                actor,
                Intent::Voluntary,
                plan_ids,
            )
            .await?;
            Ok((
                serde_json::json!({"rotations":result.rotations,"personalTeamId":result.personal_team_id}),
                Some(billing),
            ))
        }
        RotationEffect::FinalizeTeamRemoval {
            team_id,
            target_id,
            plan_ids,
        } => {
            let (result, billing) = departure::finalize_in_transaction(
                tx,
                mode,
                team_id,
                actor,
                target_id,
                Intent::Administrative,
                plan_ids,
            )
            .await?;
            Ok((
                serde_json::json!({"rotations":result.rotations,"personalTeamId":result.personal_team_id}),
                Some(billing),
            ))
        }
    }
}

/// SERIALIZABLE protects plan snapshots and finalization against concurrent non-Sync policy writers.
/// A waiter can start its snapshot before the winner commits; retrying that transient transaction
/// opens a fresh snapshot and observes the winner's retained answer. No transient attempt is retained.
pub(crate) async fn execute(
    pool: &PgPool,
    billing_gateway: Option<&dyn BillingGateway>,
    input: RotationOperationInput,
) -> Result<OperationResolution, AppError> {
    let fingerprint = fingerprint(&input);
    let mut attempt = 0;
    let (resolution, billing) = loop {
        match execute_attempt(pool, &input, &fingerprint).await {
            Err(error)
                if error.code == crate::error::AppErrorCode::RetryableConflict && attempt < 2 =>
            {
                attempt += 1;
            }
            result => break result?,
        }
    };
    if let (Some(team_id), Some(billing)) = (input.effect.billing_team(), billing) {
        sync_team_seats_best_effort(pool, billing_gateway, team_id, billing).await;
    }
    Ok(resolution)
}
async fn execute_attempt(
    pool: &PgPool,
    input: &RotationOperationInput,
    fingerprint: &[u8; 32],
) -> Result<(OperationResolution, Option<BillingPlan>), AppError> {
    let mut tx = begin_serializable_sync_event_transaction(pool)
        .await
        .map_err(|error| database_error(error, "Failed to begin Rotation Operation"))?;
    acquire_operation_lock(
        &mut *tx,
        &input.user_id,
        &input.operation_id,
        "Failed to lock Rotation Operation",
    )
    .await?;
    if let Some(row) = load_outcome(&mut *tx, &input.user_id, &input.operation_id).await? {
        if row.request_fingerprint != fingerprint {
            return Ok((OperationResolution::IdReused, None));
        }
        let outcome = super::outcome_from_row(&input.operation_id, row)?;
        tx.commit()
            .await
            .map_err(|error| database_error(error, "Failed to replay Rotation Operation"))?;
        return Ok((
            OperationResolution::Outcome {
                outcome,
                newly_committed: false,
            },
            None,
        ));
    }
    query("SAVEPOINT rotation_effect")
        .execute(&mut *tx)
        .await
        .map_err(|error| database_error(error, "Failed to begin Rotation effects"))?;
    let (status, payload, code, details, billing) = match apply(&mut tx, input).await {
        Ok((payload, billing)) => (
            OperationOutcomeStatus::Applied,
            Some(payload),
            None,
            None,
            billing,
        ),
        Err(RotationFailure::Infrastructure(error)) => return Err(error),
        Err(RotationFailure::Rejected { code, stale }) => {
            query("ROLLBACK TO SAVEPOINT rotation_effect")
                .execute(&mut *tx)
                .await
                .map_err(|error| database_error(error, "Failed to roll back Rotation effects"))?;
            let details = if let Some((plan_id, reason)) = stale {
                plans::mark_stale(&mut tx, &plan_id, reason)
                    .await
                    .map_err(|error| {
                        database_error(error, "Failed to retain stale Rotation state")
                    })?;
                Some(serde_json::json!({"planId":plan_id,"reason":reason}))
            } else {
                None
            };
            (
                OperationOutcomeStatus::Rejected,
                None,
                Some(code),
                details,
                None,
            )
        }
    };
    query("RELEASE SAVEPOINT rotation_effect")
        .execute(&mut *tx)
        .await
        .map_err(|error| database_error(error, "Failed to release Rotation effects"))?;
    insert_audit_event(
        &mut *tx,
        &generate_resource_id("audit"),
        &input.user_id,
        if status == OperationOutcomeStatus::Applied {
            "rotation_operation_applied"
        } else {
            "rotation_operation_rejected"
        },
        "operation",
        &input.operation_id,
        Some(serde_json::json!({"kind":input.effect.kind(),"code":code})),
    )
    .await?;
    query("INSERT INTO operation_outcome (user_id,operation_id,operation_kind,request_fingerprint,result_status,applied_payload,rejection_code,rejection_details) VALUES ($1,$2,$3::operation_kind,$4,$5::operation_outcome_status,$6::jsonb,$7::operation_rejection_code,$8::jsonb)")
        .bind(&input.user_id).bind(&input.operation_id).bind(input.effect.kind()).bind(fingerprint.as_slice()).bind(status).bind(payload).bind(code).bind(details).execute(&mut *tx).await.map_err(|error| database_error(error, "Failed to retain Rotation outcome"))?;
    insert_user_sync_event(
        &mut tx,
        SyncEventType::OperationResolved,
        &input.operation_id,
        SyncEntityType::Operation,
        &input.user_id,
        1,
        None,
        None,
    )
    .await?;
    let row = load_outcome(&mut *tx, &input.user_id, &input.operation_id)
        .await?
        .ok_or_else(|| AppError::internal("New Rotation outcome is missing"))?;
    let outcome = outcome_from_row(&input.operation_id, row)?;
    tx.commit()
        .await
        .map_err(|error| database_error(error, "Failed to commit Rotation outcome"))?;
    Ok((
        OperationResolution::Outcome {
            outcome,
            newly_committed: true,
        },
        billing,
    ))
}
