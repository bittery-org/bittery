//! Vault Member removal policy over the shared key-rotation mechanism.

use serde::Serialize;
use serde_json::json;
use sqlx::{query, query_as, PgPool};

use crate::{
    config::bittery_mode,
    db::enums::{BillingPlan, BillingStatus, KeyRotationReason, VaultRole, VaultType},
    error::AppError,
    services::{
        team_billing::resolve_vault_sharing_entitlement,
        vault_key_rotation::{
            self, CreateRotationPlanInput, FinalizeError, RotationPlanSummary, RotationResult,
        },
    },
};

const REASON: &str = "member_removed";
const CONTEXT: &str = "vault_member_removal";
const VAULT_SHARING_UNAVAILABLE_MESSAGE: &str =
    "Shared vault management is only available on Family or Team plans with active billing.";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct VaultMemberRemovalResult {
    pub rotation: RotationResult,
}

#[derive(Clone, Copy)]
enum MemberManagementViolation {
    SelfAction,
    InsufficientPermissions,
    TargetIsOwner,
    AdminManagingAdmin,
}

fn member_management_violation(
    actor: VaultRole,
    target: VaultRole,
    self_action: bool,
) -> Option<MemberManagementViolation> {
    self_action_violation(self_action).or_else(|| member_role_violation(actor, target))
}

fn self_action_violation(self_action: bool) -> Option<MemberManagementViolation> {
    self_action.then_some(MemberManagementViolation::SelfAction)
}

fn member_role_violation(actor: VaultRole, target: VaultRole) -> Option<MemberManagementViolation> {
    if !actor.can_manage() {
        Some(MemberManagementViolation::InsufficientPermissions)
    } else if target == VaultRole::Owner {
        Some(MemberManagementViolation::TargetIsOwner)
    } else if actor == VaultRole::Admin && target == VaultRole::Admin {
        Some(MemberManagementViolation::AdminManagingAdmin)
    } else {
        None
    }
}

fn authorize(actor: VaultRole, target: VaultRole, self_removal: bool) -> Result<(), AppError> {
    match member_management_violation(actor, target, self_removal) {
        None => Ok(()),
        Some(MemberManagementViolation::SelfAction) => {
            Err(AppError::bad_request("Cannot remove yourself"))
        }
        Some(MemberManagementViolation::InsufficientPermissions) => {
            Err(AppError::forbidden("Insufficient permissions"))
        }
        Some(MemberManagementViolation::TargetIsOwner) => {
            Err(AppError::forbidden("Cannot remove vault owner"))
        }
        Some(MemberManagementViolation::AdminManagingAdmin) => {
            Err(AppError::forbidden("Admins cannot remove other admins"))
        }
    }
}

pub(crate) fn assert_role_change_not_self(self_change: bool) -> Result<(), AppError> {
    match self_action_violation(self_change) {
        None => Ok(()),
        Some(MemberManagementViolation::SelfAction) => {
            Err(AppError::bad_request("Cannot change your own role"))
        }
        Some(_) => unreachable!("self-action policy returns only self-action violations"),
    }
}

pub(crate) fn authorize_role_change(actor: VaultRole, target: VaultRole) -> Result<(), AppError> {
    match member_role_violation(actor, target) {
        None => Ok(()),
        Some(MemberManagementViolation::InsufficientPermissions) => Err(AppError::forbidden(
            "Only vault owner or admin can manage members",
        )),
        Some(MemberManagementViolation::TargetIsOwner) => {
            Err(AppError::forbidden("Cannot change vault owner's role"))
        }
        Some(MemberManagementViolation::AdminManagingAdmin) => {
            Err(AppError::forbidden("Admins cannot change other admins"))
        }
        Some(MemberManagementViolation::SelfAction) => {
            unreachable!("role policy does not evaluate self actions")
        }
    }
}

fn authorize_vault_policy(
    vault_type: VaultType,
    team_id: Option<&str>,
    billing_plan: Option<BillingPlan>,
    billing_status: Option<BillingStatus>,
) -> Result<(), AppError> {
    if vault_type != VaultType::Team || team_id.is_none() {
        return Err(AppError::bad_request(
            "Only team vaults support removing members",
        ));
    }
    if !resolve_vault_sharing_entitlement(bittery_mode(), billing_plan, billing_status).allowed {
        return Err(AppError::forbidden(VAULT_SHARING_UNAVAILABLE_MESSAGE));
    }
    Ok(())
}

async fn authorize_managed_vault(
    pool: &PgPool,
    vault_id: &str,
    actor_id: &str,
) -> Result<(), AppError> {
    let policy: (VaultType, Option<String>, Option<BillingPlan>, Option<BillingStatus>) = query_as(
        "SELECT v.type,v.team_id,t.billing_plan,t.billing_status FROM vault v JOIN vault_key actor_key ON actor_key.vault_id=v.id AND actor_key.user_id=$2 JOIN \"user\" actor ON actor.id=actor_key.user_id LEFT JOIN team t ON t.id=actor.team_id WHERE v.id=$1",
    )
    .bind(vault_id)
    .bind(actor_id)
    .fetch_optional(pool)
    .await
    .map_err(database)?
    .ok_or_else(|| AppError::forbidden("Insufficient permissions"))?;
    authorize_vault_policy(policy.0, policy.1.as_deref(), policy.2, policy.3)
}

async fn roles(
    pool: &PgPool,
    vault_id: &str,
    actor_id: &str,
    target_id: &str,
) -> Result<(VaultRole, VaultRole), AppError> {
    let actor =
        query_as::<_, (VaultRole,)>("SELECT role FROM vault_key WHERE vault_id=$1 AND user_id=$2")
            .bind(vault_id)
            .bind(actor_id)
            .fetch_optional(pool)
            .await
            .map_err(|error| {
                tracing::error!(%error, "failed to load Vault removal actor");
                AppError::internal("Failed to load Vault membership")
            })?
            .ok_or_else(|| AppError::forbidden("Insufficient permissions"))?
            .0;
    let target =
        query_as::<_, (VaultRole,)>("SELECT role FROM vault_key WHERE vault_id=$1 AND user_id=$2")
            .bind(vault_id)
            .bind(target_id)
            .fetch_optional(pool)
            .await
            .map_err(|error| {
                tracing::error!(%error, "failed to load Vault removal target");
                AppError::internal("Failed to load Vault membership")
            })?
            .ok_or_else(|| AppError::not_found("Member not found"))?
            .0;
    Ok((actor, target))
}

pub(crate) async fn create_removal_plan(
    pool: &PgPool,
    actor_id: &str,
    vault_id: &str,
    target_id: &str,
) -> Result<RotationPlanSummary, AppError> {
    let (actor, target) = roles(pool, vault_id, actor_id, target_id).await?;
    authorize(actor, target, actor_id == target_id)?;
    authorize_managed_vault(pool, vault_id, actor_id).await?;
    vault_key_rotation::create_plan(
        pool,
        CreateRotationPlanInput {
            vault_id: vault_id.to_owned(),
            initiator_user_id: actor_id.to_owned(),
            reason: KeyRotationReason::MemberRemoved,
            authorization_context: CONTEXT.to_owned(),
            excluded_user_id: Some(target_id.to_owned()),
        },
    )
    .await
}

pub(crate) async fn finalize_removal(
    pool: &PgPool,
    actor_id: &str,
    vault_id: &str,
    target_id: &str,
    plan_id: &str,
) -> Result<VaultMemberRemovalResult, AppError> {
    let mut tx = pool.begin().await.map_err(database)?;
    query("SET TRANSACTION ISOLATION LEVEL SERIALIZABLE")
        .execute(&mut *tx)
        .await
        .map_err(database)?;
    let policy = vault_key_rotation::lock_plan_policy(&mut tx, plan_id)
        .await
        .map_err(finalize_error)?;
    if policy.vault_id != vault_id
        || policy.initiator_user_id != actor_id
        || policy.excluded_user_id.as_deref() != Some(target_id)
        || policy.reason != REASON
        || policy.authorization_context != CONTEXT
    {
        return Err(AppError::bad_request(
            "Rotation plan does not match this Vault Member removal",
        ));
    }
    let row = query_as::<_, (VaultRole, VaultRole, VaultType, Option<String>)>(
        "SELECT actor.role,target.role,v.type,v.team_id FROM vault_key actor JOIN vault_key target ON target.vault_id=actor.vault_id JOIN vault v ON v.id=actor.vault_id WHERE actor.vault_id=$1 AND actor.user_id=$2 AND target.user_id=$3 FOR UPDATE OF actor,target,v",
    ).bind(vault_id).bind(actor_id).bind(target_id).fetch_optional(&mut *tx).await.map_err(database)?
      .ok_or_else(|| AppError::conflict("Vault membership changed while rotation was prepared"))?;
    authorize(row.0, row.1, actor_id == target_id)?;
    if row.2 != VaultType::Team || row.3.is_none() {
        return Err(AppError::bad_request(
            "Only team vaults support removing members",
        ));
    }
    let billing: Option<(BillingPlan, BillingStatus)> = query_as(
        "SELECT t.billing_plan,t.billing_status FROM \"user\" actor JOIN team t ON t.id=actor.team_id WHERE actor.id=$1 FOR UPDATE OF actor,t",
    )
    .bind(actor_id)
    .fetch_optional(&mut *tx)
    .await
    .map_err(database)?;
    authorize_vault_policy(
        row.2,
        row.3.as_deref(),
        billing.map(|value| value.0),
        billing.map(|value| value.1),
    )?;
    let rotation = match vault_key_rotation::finalize_locked_plan(&mut tx, plan_id, actor_id).await
    {
        Ok(rotation) => rotation,
        Err(FinalizeError::Stale(reason)) => {
            tx.rollback().await.map_err(database)?;
            vault_key_rotation::record_stale(pool, plan_id, reason).await?;
            return Err(finalize_error(FinalizeError::Stale(reason)));
        }
        Err(error) => return Err(finalize_error(error)),
    };
    query("INSERT INTO audit_log (id,user_id,action,entity_type,entity_id,metadata) VALUES ('audit_' || md5(random()::text || clock_timestamp()::text),$1,'vault_member_removed','vault',$2,$3)")
        .bind(actor_id).bind(vault_id).bind(json!({"removedUserId": target_id, "keyRotationId": rotation.rotation_id}).to_string())
        .execute(&mut *tx).await.map_err(database)?;
    tx.commit().await.map_err(database)?;
    Ok(VaultMemberRemovalResult { rotation })
}

fn database(error: sqlx::Error) -> AppError {
    crate::services::transaction::database_error(error, "Vault membership operation failed")
}
fn finalize_error(error: FinalizeError) -> AppError {
    match error {
        FinalizeError::Stale(reason) => AppError::rotation_stale(reason),
        FinalizeError::Incomplete => AppError::conflict("Rotation plan is incomplete"),
        FinalizeError::InvalidState => AppError::conflict("Rotation plan is no longer active"),
        FinalizeError::RetryableConflict => AppError::retryable_conflict(
            "A concurrent update interrupted the removal. Retry the request.",
        ),
        FinalizeError::Database(message) => {
            tracing::error!(%message, "Vault removal rotation failed");
            AppError::internal("Vault membership operation failed")
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::{
        acquire_env_lock_async, assign_user_to_team, seed_team, seed_user, seed_vault,
        seed_vault_key, with_api_test_app, EnvVarGuard,
    };

    #[test]
    fn owner_and_admin_role_matrix_is_fail_closed() {
        assert!(authorize(VaultRole::Owner, VaultRole::Admin, false).is_ok());
        assert!(authorize(VaultRole::Admin, VaultRole::Member, false).is_ok());
        assert!(authorize(VaultRole::Admin, VaultRole::Admin, false).is_err());
        assert!(authorize(VaultRole::Member, VaultRole::ReadOnly, false).is_err());
        assert!(authorize(VaultRole::Owner, VaultRole::Owner, false).is_err());
        assert!(authorize(VaultRole::Owner, VaultRole::Member, true).is_err());
    }

    #[test]
    fn role_change_policy_preserves_action_specific_errors() {
        assert!(authorize_role_change(VaultRole::Owner, VaultRole::Admin).is_ok());

        let self_change = assert_role_change_not_self(true).unwrap_err();
        assert_eq!(self_change.code, crate::error::AppErrorCode::BadRequest);
        assert_eq!(self_change.message, "Cannot change your own role");

        let owner_target = authorize_role_change(VaultRole::Owner, VaultRole::Owner).unwrap_err();
        assert_eq!(owner_target.code, crate::error::AppErrorCode::Forbidden);
        assert_eq!(owner_target.message, "Cannot change vault owner's role");

        let admin_target = authorize_role_change(VaultRole::Admin, VaultRole::Admin).unwrap_err();
        assert_eq!(admin_target.code, crate::error::AppErrorCode::Forbidden);
        assert_eq!(admin_target.message, "Admins cannot change other admins");
    }

    #[tokio::test]
    async fn removal_requires_an_entitled_team_vault_through_finalization() {
        let _env_lock = acquire_env_lock_async().await;
        let _env = EnvVarGuard::set(&[("BITTERY_MODE", "cloud")]);
        with_api_test_app("vault_membership_policy", |app| async move {
            let pool = &app.pool;
            seed_user(
                pool,
                "inactive_actor",
                "Inactive Actor",
                "inactive-actor@test.invalid",
            )
            .await;
            seed_user(
                pool,
                "inactive_target",
                "Inactive Target",
                "inactive-target@test.invalid",
            )
            .await;
            seed_team(
                pool,
                "inactive_vault_team",
                "Inactive Vault Team",
                "inactive_actor",
                "family",
                "family",
                "past_due",
            )
            .await;
            assign_user_to_team(pool, "inactive_actor", "inactive_vault_team", "owner").await;
            assign_user_to_team(pool, "inactive_target", "inactive_vault_team", "member").await;
            seed_vault(
                pool,
                "inactive_team_vault",
                "Inactive Team Vault",
                "team",
                "inactive_actor",
                Some("inactive_vault_team"),
            )
            .await;
            seed_vault_key(
                pool,
                "inactive_actor_key",
                "inactive_team_vault",
                "inactive_actor",
                "actor-key",
                "owner",
            )
            .await;
            seed_vault_key(
                pool,
                "inactive_target_key",
                "inactive_team_vault",
                "inactive_target",
                "target-key",
                "member",
            )
            .await;
            let inactive_error = create_removal_plan(
                pool,
                "inactive_actor",
                "inactive_team_vault",
                "inactive_target",
            )
            .await
            .expect_err("inactive Vault sharing must block removal preparation");
            assert_eq!(inactive_error.code, crate::error::AppErrorCode::Forbidden);

            seed_user(
                pool,
                "personal_actor",
                "Personal Actor",
                "personal-actor@test.invalid",
            )
            .await;
            seed_user(
                pool,
                "personal_target",
                "Personal Target",
                "personal-target@test.invalid",
            )
            .await;
            seed_vault(
                pool,
                "personal_removal_vault",
                "Personal Removal Vault",
                "personal",
                "personal_actor",
                None,
            )
            .await;
            seed_vault_key(
                pool,
                "personal_actor_key",
                "personal_removal_vault",
                "personal_actor",
                "actor-key",
                "owner",
            )
            .await;
            seed_vault_key(
                pool,
                "personal_target_key",
                "personal_removal_vault",
                "personal_target",
                "target-key",
                "member",
            )
            .await;
            let personal_error = create_removal_plan(
                pool,
                "personal_actor",
                "personal_removal_vault",
                "personal_target",
            )
            .await
            .expect_err("personal Vaults must reject membership removal");
            assert_eq!(personal_error.code, crate::error::AppErrorCode::BadRequest);

            seed_user(
                pool,
                "lapsed_actor",
                "Lapsed Actor",
                "lapsed-actor@test.invalid",
            )
            .await;
            seed_user(
                pool,
                "lapsed_target",
                "Lapsed Target",
                "lapsed-target@test.invalid",
            )
            .await;
            seed_team(
                pool,
                "lapsed_vault_team",
                "Lapsed Vault Team",
                "lapsed_actor",
                "organization",
                "team",
                "active",
            )
            .await;
            assign_user_to_team(pool, "lapsed_actor", "lapsed_vault_team", "owner").await;
            assign_user_to_team(pool, "lapsed_target", "lapsed_vault_team", "member").await;
            seed_vault(
                pool,
                "lapsed_team_vault",
                "Lapsed Team Vault",
                "team",
                "lapsed_actor",
                Some("lapsed_vault_team"),
            )
            .await;
            seed_vault_key(
                pool,
                "lapsed_actor_key",
                "lapsed_team_vault",
                "lapsed_actor",
                "actor-key",
                "owner",
            )
            .await;
            seed_vault_key(
                pool,
                "lapsed_target_key",
                "lapsed_team_vault",
                "lapsed_target",
                "target-key",
                "member",
            )
            .await;
            let plan =
                create_removal_plan(pool, "lapsed_actor", "lapsed_team_vault", "lapsed_target")
                    .await
                    .expect("active Vault sharing should allow preparation");
            query("UPDATE team SET billing_status='past_due' WHERE id='lapsed_vault_team'")
                .execute(pool)
                .await
                .expect("billing should lapse");

            let finalization_error = finalize_removal(
                pool,
                "lapsed_actor",
                "lapsed_team_vault",
                "lapsed_target",
                &plan.id,
            )
            .await
            .expect_err("lapsed Vault sharing must block finalization");
            assert_eq!(
                finalization_error.code,
                crate::error::AppErrorCode::Forbidden
            );
        })
        .await;
    }
}
