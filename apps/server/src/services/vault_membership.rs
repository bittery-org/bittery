//! Vault Member removal policy over the shared key-rotation mechanism.

use serde::Serialize;
use serde_json::json;
use sqlx::{query, query_as, PgPool};

use crate::{
    db::enums::{KeyRotationReason, VaultRole},
    error::AppError,
    services::vault_key_rotation::{
        self, CreateRotationPlanInput, FinalizeError, RotationPlanSummary, RotationResult,
    },
};

const REASON: &str = "member_removed";
const CONTEXT: &str = "vault_member_removal";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct VaultMemberRemovalResult {
    pub rotation: RotationResult,
}

fn authorize(actor: VaultRole, target: VaultRole, self_removal: bool) -> Result<(), AppError> {
    if self_removal {
        return Err(AppError::bad_request("Cannot remove yourself"));
    }
    if !actor.can_manage() {
        return Err(AppError::forbidden("Insufficient permissions"));
    }
    if target == VaultRole::Owner {
        return Err(AppError::forbidden("Cannot remove vault owner"));
    }
    if actor == VaultRole::Admin && target == VaultRole::Admin {
        return Err(AppError::forbidden("Admins cannot remove other admins"));
    }
    Ok(())
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
    let row = query_as::<_, (VaultRole, VaultRole)>(
        "SELECT actor.role, target.role FROM vault_key actor JOIN vault_key target ON target.vault_id=actor.vault_id WHERE actor.vault_id=$1 AND actor.user_id=$2 AND target.user_id=$3 FOR UPDATE OF actor, target",
    ).bind(vault_id).bind(actor_id).bind(target_id).fetch_optional(&mut *tx).await.map_err(database)?
      .ok_or_else(|| AppError::conflict("Vault membership changed while rotation was prepared"))?;
    authorize(row.0, row.1, actor_id == target_id)?;
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
    #[test]
    fn owner_and_admin_role_matrix_is_fail_closed() {
        assert!(authorize(VaultRole::Owner, VaultRole::Admin, false).is_ok());
        assert!(authorize(VaultRole::Admin, VaultRole::Member, false).is_ok());
        assert!(authorize(VaultRole::Admin, VaultRole::Admin, false).is_err());
        assert!(authorize(VaultRole::Member, VaultRole::ReadOnly, false).is_err());
        assert!(authorize(VaultRole::Owner, VaultRole::Owner, false).is_err());
        assert!(authorize(VaultRole::Owner, VaultRole::Member, true).is_err());
    }
}
