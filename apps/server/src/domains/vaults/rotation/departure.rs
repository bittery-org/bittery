//! Voluntary and administrative Team Member departure policy.

use std::collections::HashSet;

use super::failure::RotationFailure;
use crate::db::enums::OperationRejectionCode as Code;
use serde::Serialize;
use serde_json::json;
#[cfg(test)]
use sqlx::PgPool;
use sqlx::{query, query_as, query_scalar, Postgres, Transaction};
use uuid::Uuid;

use crate::{
    config::DeploymentMode,
    db::enums::{BillingPlan, BillingStatus, KeyRotationReason, TeamRole, TeamType},
    domains::billing::entitlements::team_management_enabled,
    shared::transaction::{
        acquire_team_authority_lock, acquire_user_authority_lock, database_error,
    },
};

use super::plans::{
    self as vault_key_rotation, CreateRotationPlanInput, RotationPlanSummary, RotationResult,
};

const REASON: &str = "member_removed";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Intent {
    Voluntary,
    Administrative,
}

impl Intent {
    fn context(self, team_id: &str) -> String {
        format!(
            "team_member_departure:{}:{team_id}",
            match self {
                Self::Voluntary => "voluntary",
                Self::Administrative => "administrative",
            }
        )
    }
    fn audit_reason(self) -> &'static str {
        match self {
            Self::Voluntary => "voluntary_leave",
            Self::Administrative => "administrative_removal",
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DeparturePlanSet {
    pub plans: Vec<RotationPlanSummary>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DepartureResult {
    pub personal_team_id: String,
    pub rotations: Vec<RotationResult>,
}

fn authorize(
    intent: Intent,
    actor: TeamRole,
    target: TeamRole,
    same_user: bool,
    team_type: TeamType,
) -> Result<(), RotationFailure> {
    if team_type == TeamType::Personal {
        return Err(RotationFailure::rejected(
            Code::PersonalTeamDepartureForbidden,
        ));
    }
    match intent {
        Intent::Voluntary if !same_user => Err(RotationFailure::Infrastructure(
            crate::error::AppError::internal("Invalid voluntary departure target"),
        )),
        Intent::Voluntary if target == TeamRole::Owner => {
            Err(RotationFailure::rejected(Code::TeamOwnerLeaveForbidden))
        }
        Intent::Voluntary => Ok(()),
        Intent::Administrative if same_user => {
            Err(RotationFailure::rejected(Code::SelfRemovalForbidden))
        }
        Intent::Administrative if !actor.can_manage() => {
            Err(RotationFailure::rejected(Code::TeamManagementDenied))
        }
        Intent::Administrative if target == TeamRole::Owner => {
            Err(RotationFailure::rejected(Code::TeamOwnerProtected))
        }
        Intent::Administrative => Ok(()),
    }
}

fn authorize_entitlement(
    deployment_mode: DeploymentMode,
    intent: Intent,
    billing_plan: BillingPlan,
    billing_status: BillingStatus,
) -> Result<(), RotationFailure> {
    if intent == Intent::Voluntary
        || team_management_enabled(
            deployment_mode.as_str(),
            Some(billing_plan),
            Some(billing_status),
        )
    {
        Ok(())
    } else {
        Err(RotationFailure::rejected(
            Code::TeamManagementEntitlementDenied,
        ))
    }
}

pub(crate) async fn create_plans_in_transaction(
    tx: &mut Transaction<'_, Postgres>,
    deployment_mode: DeploymentMode,
    team_id: &str,
    actor_id: &str,
    target_id: &str,
    intent: Intent,
) -> Result<DeparturePlanSet, RotationFailure> {
    let (actor_role, target_role, team_type, billing_plan, billing_status): (
        TeamRole,
        TeamRole,
        TeamType,
        BillingPlan,
        BillingStatus,
    ) = query_as(
        "SELECT actor.role,target.role,t.type,t.billing_plan,t.billing_status FROM \"user\" actor JOIN \"user\" target ON target.team_id=actor.team_id JOIN team t ON t.id=actor.team_id WHERE actor.id=$1 AND target.id=$2 AND actor.team_id=$3",
    ).bind(actor_id).bind(target_id).bind(team_id).fetch_optional(&mut **tx).await.map_err(|error| database_error(error, "Member departure operation failed"))?
      .ok_or_else(|| RotationFailure::rejected(Code::TeamMemberNotFound))?;
    authorize(
        intent,
        actor_role,
        target_role,
        actor_id == target_id,
        team_type,
    )?;
    authorize_entitlement(deployment_mode, intent, billing_plan, billing_status)?;
    if intent == Intent::Administrative {
        let has_unmanaged_vault: bool = query_scalar("SELECT EXISTS(SELECT 1 FROM vault v JOIN vault_key target_key ON target_key.vault_id=v.id AND target_key.user_id=$2 LEFT JOIN vault_key actor_key ON actor_key.vault_id=v.id AND actor_key.user_id=$3 WHERE v.team_id=$1 AND (actor_key.role IS NULL OR actor_key.role NOT IN ('owner','admin')))")
            .bind(team_id).bind(target_id).bind(actor_id).fetch_one(&mut **tx).await.map_err(|error| database_error(error, "Member departure operation failed"))?;
        if has_unmanaged_vault {
            return Err(RotationFailure::rejected(Code::VaultManagementIncomplete));
        }
    }
    let vault_ids: Vec<String> = query_scalar("SELECT v.id FROM vault v JOIN vault_key vk ON vk.vault_id=v.id WHERE v.team_id=$1 AND vk.user_id=$2 ORDER BY v.id")
        .bind(team_id).bind(target_id).fetch_all(&mut **tx).await.map_err(|error| database_error(error, "Member departure operation failed"))?;
    let mut plans = Vec::with_capacity(vault_ids.len());
    for vault_id in vault_ids {
        plans.push(
            vault_key_rotation::create_plan_in_transaction(
                tx,
                CreateRotationPlanInput {
                    vault_id,
                    initiator_user_id: actor_id.to_owned(),
                    reason: KeyRotationReason::MemberRemoved,
                    authorization_context: intent.context(team_id),
                    excluded_user_id: Some(target_id.to_owned()),
                },
            )
            .await?,
        );
    }
    Ok(DeparturePlanSet { plans })
}

fn exact_plan_set(
    expected: &HashSet<String>,
    supplied: &[(String, String)],
) -> Result<(), RotationFailure> {
    let actual: HashSet<_> = supplied
        .iter()
        .map(|(_, vault_id)| vault_id.clone())
        .collect();
    if actual.len() != supplied.len() || &actual != expected {
        return Err(RotationFailure::rejected(Code::RotationPlanSetMismatch));
    }
    Ok(())
}

pub(crate) async fn finalize_in_transaction(
    tx: &mut Transaction<'_, Postgres>,
    deployment_mode: DeploymentMode,
    team_id: &str,
    actor_id: &str,
    target_id: &str,
    intent: Intent,
    plan_ids: &[String],
) -> Result<(DepartureResult, BillingPlan), RotationFailure> {
    let mut authority_user_ids = [actor_id, target_id];
    authority_user_ids.sort_unstable();
    for user_id in authority_user_ids {
        acquire_user_authority_lock(
            tx,
            user_id,
            "Failed to lock Team Member departure User authority",
        )
        .await?;
    }
    acquire_team_authority_lock(
        &mut **tx,
        team_id,
        "Failed to lock Team Member departure authority",
    )
    .await?;
    let (actor_role, target_role, team_type, target_name, billing_plan, billing_status): (
        TeamRole,
        TeamRole,
        TeamType,
        String,
        BillingPlan,
        BillingStatus,
    ) = query_as(
        "SELECT actor.role,target.role,t.type,target.name,t.billing_plan,t.billing_status FROM \"user\" actor JOIN \"user\" target ON target.team_id=actor.team_id JOIN team t ON t.id=actor.team_id WHERE actor.id=$1 AND target.id=$2 AND actor.team_id=$3 FOR UPDATE OF actor,target,t",
    ).bind(actor_id).bind(target_id).bind(team_id).fetch_optional(&mut **tx).await.map_err(|error| database_error(error, "Member departure operation failed"))?
      .ok_or_else(|| RotationFailure::rejected(Code::TeamMembershipChanged))?;
    authorize(
        intent,
        actor_role,
        target_role,
        actor_id == target_id,
        team_type,
    )?;
    authorize_entitlement(deployment_mode, intent, billing_plan, billing_status)?;
    let expected: HashSet<String> = query_scalar("SELECT v.id FROM vault v JOIN vault_key vk ON vk.vault_id=v.id WHERE v.team_id=$1 AND vk.user_id=$2")
        .bind(team_id).bind(target_id).fetch_all(&mut **tx).await.map_err(|error| database_error(error, "Member departure operation failed"))?.into_iter().collect();
    if intent == Intent::Administrative {
        let managed: HashSet<String> = query_scalar("SELECT v.id FROM vault v JOIN vault_key target_key ON target_key.vault_id=v.id AND target_key.user_id=$2 JOIN vault_key actor_key ON actor_key.vault_id=v.id AND actor_key.user_id=$3 WHERE v.team_id=$1 AND actor_key.role IN ('owner','admin')")
            .bind(team_id).bind(target_id).bind(actor_id).fetch_all(&mut **tx).await.map_err(|error| database_error(error, "Member departure operation failed"))?.into_iter().collect();
        if managed != expected {
            return Err(RotationFailure::rejected(Code::VaultManagementIncomplete));
        }
    }
    let mut policies = Vec::with_capacity(plan_ids.len());
    for plan_id in plan_ids {
        policies.push((
            plan_id,
            vault_key_rotation::lock_plan_policy(tx, plan_id)
                .await
                .map_err(|error| RotationFailure::finalize(plan_id, error))?,
        ));
    }
    if policies
        .iter()
        .any(|(_, policy)| policy.initiator_user_id != actor_id)
    {
        return Err(RotationFailure::rejected(Code::RotationPlanUnavailable));
    }
    let supplied: Vec<_> = policies
        .iter()
        .map(|(id, p)| ((*id).clone(), p.vault_id.clone()))
        .collect();
    exact_plan_set(&expected, &supplied)?;
    let context = intent.context(team_id);
    // The immutable policies above already proved every initiator is this actor; foreign
    // plans were classified as unavailable before these intent/target mismatch checks.
    if policies.iter().any(|(_, p)| {
        p.excluded_user_id.as_deref() != Some(target_id)
            || p.reason != REASON
            || p.authorization_context != context
    }) {
        return Err(RotationFailure::rejected(Code::RotationPlanMismatch));
    }
    let mut rotations = Vec::with_capacity(plan_ids.len());
    for plan_id in plan_ids {
        rotations.push(
            vault_key_rotation::finalize_locked_plan(tx, plan_id, actor_id)
                .await
                .map_err(|error| RotationFailure::finalize(plan_id, error))?,
        );
    }

    let session_ids: Vec<String> =
        query_scalar("SELECT id FROM session WHERE user_id=$1 FOR UPDATE")
            .bind(target_id)
            .fetch_all(&mut **tx)
            .await
            .map_err(|error| database_error(error, "Member departure operation failed"))?;
    for session_id in &session_ids {
        query("INSERT INTO audit_log (id,user_id,action,entity_type,entity_id,metadata) VALUES ($1,$2,'session_revoked','session',$3,$4)")
            .bind(format!("audit_{}", Uuid::new_v4())).bind(target_id).bind(session_id)
            .bind(json!({"reason": if intent == Intent::Voluntary { "team_left" } else { "team_member_removed" }}).to_string())
            .execute(&mut **tx).await.map_err(|error| database_error(error, "Member departure operation failed"))?;
    }
    query("DELETE FROM session WHERE user_id=$1")
        .bind(target_id)
        .execute(&mut **tx)
        .await
        .map_err(|error| database_error(error, "Member departure operation failed"))?;
    let personal_team_id = format!("team_{}", Uuid::new_v4());
    query("INSERT INTO team (id,name,owner_id,type,member_limit,billing_plan,billing_status) VALUES ($1,$2,$3,'personal',1,'free','none')")
        .bind(&personal_team_id).bind(format!("{}'s Team", target_name)).bind(target_id).execute(&mut **tx).await.map_err(|error| database_error(error, "Member departure operation failed"))?;
    query("UPDATE \"user\" SET team_id=$1,role='owner' WHERE id=$2")
        .bind(&personal_team_id)
        .bind(target_id)
        .execute(&mut **tx)
        .await
        .map_err(|error| database_error(error, "Member departure operation failed"))?;
    query("INSERT INTO audit_log (id,user_id,action,entity_type,entity_id,metadata) VALUES ($1,$2,'team_member_removed','user',$3,$4)")
        .bind(format!("audit_{}", Uuid::new_v4())).bind(actor_id).bind(target_id)
        .bind(json!({"teamId":team_id,"reason":intent.audit_reason(),"vaultsRotated":rotations.len()}).to_string())
        .execute(&mut **tx).await.map_err(|error| database_error(error, "Member departure operation failed"))?;
    Ok((
        DepartureResult {
            personal_team_id,
            rotations,
        },
        billing_plan,
    ))
}

#[cfg(test)]
use crate::{error::AppError, integrations::stripe::BillingGateway};
#[cfg(test)]
async fn create_plans(
    pool: &PgPool,
    deployment_mode: DeploymentMode,
    team_id: &str,
    actor_id: &str,
    target_id: &str,
    intent: Intent,
) -> Result<DeparturePlanSet, AppError> {
    let mut tx = crate::db::events::begin_serializable_sync_event_transaction(pool)
        .await
        .map_err(|error| database_error(error, "Rotation test transaction failed"))?;
    let result = create_plans_in_transaction(
        &mut tx,
        deployment_mode,
        team_id,
        actor_id,
        target_id,
        intent,
    )
    .await?;
    tx.commit()
        .await
        .map_err(|error| database_error(error, "Rotation test transaction failed"))?;
    Ok(result)
}

#[cfg(test)]
pub(crate) async fn create_administrative_plans(
    pool: &PgPool,
    deployment_mode: DeploymentMode,
    team_id: &str,
    actor_id: &str,
    target_id: &str,
) -> Result<DeparturePlanSet, AppError> {
    create_plans(
        pool,
        deployment_mode,
        team_id,
        actor_id,
        target_id,
        Intent::Administrative,
    )
    .await
}
#[cfg(test)]
async fn finalize(
    pool: &PgPool,
    deployment_mode: DeploymentMode,
    team_id: &str,
    actor_id: &str,
    target_id: &str,
    intent: Intent,
    plan_ids: &[String],
) -> Result<DepartureResult, AppError> {
    let mut tx = crate::db::events::begin_serializable_sync_event_transaction(pool)
        .await
        .map_err(|error| database_error(error, "Rotation test transaction failed"))?;
    match finalize_in_transaction(
        &mut tx,
        deployment_mode,
        team_id,
        actor_id,
        target_id,
        intent,
        plan_ids,
    )
    .await
    {
        Ok((result, _)) => {
            tx.commit()
                .await
                .map_err(|error| database_error(error, "Rotation test transaction failed"))?;
            Ok(result)
        }
        Err(error) => {
            tx.rollback()
                .await
                .map_err(|error| database_error(error, "Rotation test transaction failed"))?;
            if let RotationFailure::Rejected {
                stale: Some((id, reason)),
                ..
            } = &error
            {
                vault_key_rotation::record_stale(pool, id, *reason).await?;
            }
            Err(error.into())
        }
    }
}

#[cfg(test)]
pub(crate) async fn finalize_administrative(
    pool: &PgPool,
    _billing: Option<&dyn BillingGateway>,
    deployment_mode: DeploymentMode,
    team_id: &str,
    actor_id: &str,
    target_id: &str,
    plan_ids: &[String],
) -> Result<DepartureResult, AppError> {
    finalize(
        pool,
        deployment_mode,
        team_id,
        actor_id,
        target_id,
        Intent::Administrative,
        plan_ids,
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::super::plans::StagedOutput;
    use super::*;
    use crate::{
        db::enums::{VaultKeyRotationManifestKind, VaultKeyRotationStaleReason},
        test_support::{
            assign_user_to_team, seed_item, seed_team, seed_user, seed_vault, seed_vault_key,
            with_api_test_app,
        },
    };
    #[test]
    fn departure_role_matrix() {
        assert!(authorize(
            Intent::Voluntary,
            TeamRole::Member,
            TeamRole::Member,
            true,
            TeamType::Family
        )
        .is_ok());
        assert!(authorize(
            Intent::Voluntary,
            TeamRole::Owner,
            TeamRole::Owner,
            true,
            TeamType::Family
        )
        .is_err());
        assert!(authorize(
            Intent::Administrative,
            TeamRole::Admin,
            TeamRole::Member,
            false,
            TeamType::Family
        )
        .is_ok());
        assert!(authorize(
            Intent::Administrative,
            TeamRole::Member,
            TeamRole::Member,
            false,
            TeamType::Family
        )
        .is_err());
        assert!(authorize(
            Intent::Administrative,
            TeamRole::Owner,
            TeamRole::Member,
            true,
            TeamType::Family
        )
        .is_err());
    }
    #[test]
    fn exact_coverage_rejects_duplicates_omissions_and_extras() {
        let expected = HashSet::from(["v1".to_owned(), "v2".to_owned()]);
        assert!(exact_plan_set(
            &expected,
            &[("p1".into(), "v1".into()), ("p2".into(), "v2".into())]
        )
        .is_ok());
        assert!(exact_plan_set(
            &expected,
            &[("p1".into(), "v1".into()), ("p2".into(), "v1".into())]
        )
        .is_err());
        assert!(exact_plan_set(&expected, &[("p1".into(), "v1".into())]).is_err());
        assert!(exact_plan_set(
            &expected,
            &[
                ("p1".into(), "v1".into()),
                ("p2".into(), "v2".into()),
                ("p3".into(), "v3".into())
            ]
        )
        .is_err());
    }

    #[tokio::test]
    async fn administrative_departure_rechecks_team_management_entitlement() {
        with_api_test_app("member_departure_entitlement", |app| async move {
            let pool = &app.pool;
            seed_user(
                pool,
                "inactive_owner",
                "Inactive Owner",
                "inactive-owner@test.invalid",
            )
            .await;
            seed_user(
                pool,
                "inactive_member",
                "Inactive Member",
                "inactive-member@test.invalid",
            )
            .await;
            seed_team(
                pool,
                "inactive_team",
                "Inactive Team",
                "inactive_owner",
                "organization",
                "team",
                "past_due",
            )
            .await;
            assign_user_to_team(pool, "inactive_owner", "inactive_team", "owner").await;
            assign_user_to_team(pool, "inactive_member", "inactive_team", "member").await;

            let preparation_error = create_administrative_plans(
                pool,
                DeploymentMode::Cloud,
                "inactive_team",
                "inactive_owner",
                "inactive_member",
            )
            .await
            .expect_err("inactive billing must block administrative preparation");
            assert_eq!(
                preparation_error.code,
                crate::error::AppErrorCode::Forbidden
            );

            seed_user(
                pool,
                "lapsed_owner",
                "Lapsed Owner",
                "lapsed-owner@test.invalid",
            )
            .await;
            seed_user(
                pool,
                "lapsed_member",
                "Lapsed Member",
                "lapsed-member@test.invalid",
            )
            .await;
            seed_team(
                pool,
                "lapsed_team",
                "Lapsed Team",
                "lapsed_owner",
                "organization",
                "team",
                "active",
            )
            .await;
            assign_user_to_team(pool, "lapsed_owner", "lapsed_team", "owner").await;
            assign_user_to_team(pool, "lapsed_member", "lapsed_team", "member").await;
            let plans = create_administrative_plans(
                pool,
                DeploymentMode::Cloud,
                "lapsed_team",
                "lapsed_owner",
                "lapsed_member",
            )
            .await
            .expect("active billing should allow preparation");
            assert!(plans.plans.is_empty());
            query("UPDATE team SET billing_status='past_due' WHERE id='lapsed_team'")
                .execute(pool)
                .await
                .expect("billing should lapse");

            let finalization_error = finalize_administrative(
                pool,
                Some(&crate::integrations::stripe::TestBillingGateway::default()),
                DeploymentMode::Cloud,
                "lapsed_team",
                "lapsed_owner",
                "lapsed_member",
                &[],
            )
            .await
            .expect_err("lapsed billing must block administrative finalization");
            assert_eq!(
                finalization_error.code,
                crate::error::AppErrorCode::Forbidden
            );
            let team_id: Option<String> =
                query_scalar("SELECT team_id FROM \"user\" WHERE id='lapsed_member'")
                    .fetch_one(pool)
                    .await
                    .expect("Member Team should load");
            assert_eq!(team_id.as_deref(), Some("lapsed_team"));
        })
        .await;
    }

    #[tokio::test]
    async fn one_stale_vault_rolls_back_the_entire_departure() {
        with_api_test_app("member_departure_stale_rolls_back_all", |app| async move {
            let pool = &app.pool;
            seed_user(pool, "user_owner", "Owner", "owner@rotation.test").await;
            seed_user(pool, "user_member", "Member", "member@rotation.test").await;
            seed_team(
                pool,
                "team_rotation",
                "Rotation Team",
                "user_owner",
                "organization",
                "team",
                "active",
            )
            .await;
            assign_user_to_team(pool, "user_owner", "team_rotation", "owner").await;
            assign_user_to_team(pool, "user_member", "team_rotation", "member").await;

            for suffix in ["a", "b"] {
                let vault_id = format!("vault_{suffix}");
                seed_vault(
                    pool,
                    &vault_id,
                    &format!("Vault {suffix}"),
                    "team",
                    "user_owner",
                    Some("team_rotation"),
                )
                .await;
                seed_vault_key(
                    pool,
                    &format!("vault_key_owner_{suffix}"),
                    &vault_id,
                    "user_owner",
                    &format!("owner-key-{suffix}"),
                    "owner",
                )
                .await;
                seed_vault_key(
                    pool,
                    &format!("vault_key_member_{suffix}"),
                    &vault_id,
                    "user_member",
                    &format!("member-key-{suffix}"),
                    "member",
                )
                .await;
                seed_item(
                    pool,
                    &format!("item_{suffix}"),
                    &vault_id,
                    "login",
                    &format!("ciphertext-{suffix}"),
                    &format!("iv-{suffix}"),
                    "user_owner",
                )
                .await;
            }

            let plan_set = create_administrative_plans(
                pool,
                DeploymentMode::Cloud,
                "team_rotation",
                "user_owner",
                "user_member",
            )
            .await
            .expect("departure plans should be created");
            assert_eq!(plan_set.plans.len(), 2);

            for plan in &plan_set.plans {
                let members = vault_key_rotation::read_preparation_page(
                    pool,
                    &plan.id,
                    "user_owner",
                    VaultKeyRotationManifestKind::Member,
                    None,
                    100,
                )
                .await
                .expect("member manifest should load");
                let member_outputs: Vec<_> = members
                    .records
                    .into_iter()
                    .map(|record| StagedOutput {
                        id: record.id,
                        payload: r#"{"encryptedVaultKey":"rotated-owner-key"}"#.to_owned(),
                    })
                    .collect();
                vault_key_rotation::stage_outputs(
                    pool,
                    &plan.id,
                    "user_owner",
                    VaultKeyRotationManifestKind::Member,
                    &member_outputs,
                )
                .await
                .expect("member output should stage");

                let items = vault_key_rotation::read_preparation_page(
                    pool,
                    &plan.id,
                    "user_owner",
                    VaultKeyRotationManifestKind::Item,
                    None,
                    100,
                )
                .await
                .expect("item manifest should load");
                let item_outputs: Vec<_> = items
                    .records
                    .into_iter()
                    .map(|record| StagedOutput {
                        id: record.id,
                        payload: r#"{"encryptedData":"rotated","encryptionIv":"rotated-iv","encryptionAlgorithm":"AES-GCM"}"#.to_owned(),
                    })
                    .collect();
                vault_key_rotation::stage_outputs(
                    pool,
                    &plan.id,
                    "user_owner",
                    VaultKeyRotationManifestKind::Item,
                    &item_outputs,
                )
                .await
                .expect("item output should stage");
            }

            query("UPDATE item SET version=version+1 WHERE id='item_b'")
                .execute(pool)
                .await
                .expect("fixture should make the second Vault stale");

            let plan_ids: Vec<_> = plan_set.plans.iter().map(|plan| plan.id.clone()).collect();
            let error = finalize_administrative(
                pool,
                Some(&crate::integrations::stripe::TestBillingGateway::default()),
                DeploymentMode::Cloud,
                "team_rotation",
                "user_owner",
                "user_member",
                &plan_ids,
            )
            .await
            .expect_err("one stale Vault must reject the whole departure");
            assert_eq!(
                error.code,
                crate::error::AppErrorCode::RotationStaleItemState
            );

            let versions: Vec<(String, i32)> = query_as(
                "SELECT id,key_version FROM vault WHERE id IN ('vault_a','vault_b') ORDER BY id",
            )
            .fetch_all(pool)
            .await
            .expect("Vault versions should load");
            assert_eq!(
                versions,
                vec![("vault_a".to_owned(), 1), ("vault_b".to_owned(), 1)]
            );
            let memberships: i64 = query_scalar(
                "SELECT COUNT(*) FROM vault_key WHERE user_id='user_member' AND vault_id IN ('vault_a','vault_b')",
            )
            .fetch_one(pool)
            .await
            .expect("Vault memberships should count");
            assert_eq!(memberships, 2);
            let team_id: Option<String> =
                query_scalar("SELECT team_id FROM \"user\" WHERE id='user_member'")
                    .fetch_one(pool)
                    .await
                    .expect("Member Team should load");
            assert_eq!(team_id.as_deref(), Some("team_rotation"));
            let completed: i64 = query_scalar(
                "SELECT COUNT(*) FROM vault_key_rotation WHERE status='completed' AND vault_id IN ('vault_a','vault_b')",
            )
            .fetch_one(pool)
            .await
            .expect("rotation history should count");
            assert_eq!(completed, 0);
            let stale: Vec<(String, Option<VaultKeyRotationStaleReason>)> = query_as(
                "SELECT id,stale_reason FROM vault_key_rotation_plan WHERE id=ANY($1) AND state='stale'",
            )
            .bind(&plan_ids)
            .fetch_all(pool)
            .await
            .expect("stale diagnostic should load");
            assert_eq!(
                stale,
                vec![(
                    plan_set.plans[1].id.clone(),
                    Some(VaultKeyRotationStaleReason::ItemState),
                )]
            );
        })
        .await;
    }
}
