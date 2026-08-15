use serde_json::json;
use sqlx::{query, query_as, query_scalar, PgPool};
use time::OffsetDateTime;

use super::{
    access::load_vault_access,
    catalog::{
        insert_vault_audit_log_with_metadata, insert_vault_member_sync_event,
        resolve_vault_sharing_entitlement, DbVaultOwnerAccessRow,
    },
    AddVaultMemberInput, SuccessResponse, UpdateVaultMemberRoleInput, VaultAvailableMemberResponse,
    VaultIdInput, VaultMemberResponse,
};
use crate::{
    config::DeploymentMode,
    db::events::generate_resource_id,
    db::{
        enums::{BillingPlan, BillingStatus, SyncEventType, VaultRole, VaultType},
        models::DbTeamBillingEntitlementRow,
    },
    domains::{
        billing::entitlements::load_team_billing_entitlement,
        vaults::{
            key::validate_encrypted_vault_key,
            rotation::membership::{assert_role_change_not_self, authorize_role_change},
        },
    },
    error::{AppError, AppErrorCode},
    shared::transaction::database_error,
};

#[derive(Debug, sqlx::FromRow)]
struct DbVaultAvailableMemberRow {
    user_id: String,
    name: String,
    email: String,
    public_key: String,
}

#[derive(Debug, sqlx::FromRow)]
struct DbVaultLookupUserRow {
    team_id: Option<String>,
}

#[derive(Debug, sqlx::FromRow)]
struct DbVaultMemberRow {
    user_id: String,
    name: String,
    email: String,
    role: VaultRole,
}

pub(crate) async fn list_vault_members(
    pool: &PgPool,
    user_id: &str,
    input: VaultIdInput,
) -> Result<Vec<VaultMemberResponse>, AppError> {
    let _access = load_vault_access(pool, &input.vault_id, user_id).await?;
    let members = query_as::<_, DbVaultMemberRow>(
			"SELECT vk.user_id, u.name, u.email, vk.role::text AS role, vk.created_at AS joined_at FROM vault_key vk INNER JOIN \"user\" u ON vk.user_id = u.id WHERE vk.vault_id = $1 ORDER BY vk.created_at ASC",
		)
		.bind(&input.vault_id)
		.fetch_all(pool)
		.await
		.map_err(|error| database_error(error, "Failed to load vault members"))?;
    Ok(members
        .into_iter()
        .map(|member| VaultMemberResponse {
            user_id: member.user_id,
            name: member.name,
            email: member.email,
            role: member.role,
        })
        .collect())
}

pub(crate) async fn available_team_members(
    pool: &PgPool,
    deployment_mode: DeploymentMode,
    user_id: &str,
    input: VaultIdInput,
) -> Result<Vec<VaultAvailableMemberResponse>, AppError> {
    let actor =
        load_managed_team_vault_actor(pool, &input.vault_id, user_id, deployment_mode).await?;
    let team_members = query_as::<_, DbVaultAvailableMemberRow>(
			"SELECT id AS user_id, name, email, public_key FROM \"user\" WHERE team_id = $1 ORDER BY created_at ASC",
		)
		.bind(actor.team_id.as_deref())
		.fetch_all(pool)
		.await
		.map_err(|error| database_error(error, "Failed to load team members"))?;
    let existing_member_ids =
        query_scalar::<_, String>("SELECT user_id FROM vault_key WHERE vault_id = $1")
            .bind(&input.vault_id)
            .fetch_all(pool)
            .await
            .map_err(|error| database_error(error, "Failed to load vault members"))?;
    let existing_member_ids: std::collections::HashSet<String> =
        existing_member_ids.into_iter().collect();
    Ok(team_members
        .into_iter()
        .filter(|member| !existing_member_ids.contains(&member.user_id))
        .map(|member| VaultAvailableMemberResponse {
            user_id: member.user_id,
            name: member.name,
            email: member.email,
            public_key: member.public_key,
        })
        .collect())
}

pub(crate) async fn update_vault_member_role(
    pool: &PgPool,
    deployment_mode: DeploymentMode,
    user_id: &str,
    input: UpdateVaultMemberRoleInput,
) -> Result<SuccessResponse, AppError> {
    let role = validate_vault_member_role(input.role)?;
    let actor =
        load_managed_team_vault_actor(pool, &input.vault_id, user_id, deployment_mode).await?;
    assert_role_change_not_self(input.user_id == user_id)?;
    let target_access = load_vault_access(pool, &input.vault_id, &input.user_id)
        .await
        .map_err(|error| {
            if error.code == AppErrorCode::Forbidden {
                AppError::not_found("Member not found")
            } else {
                error
            }
        })?;
    authorize_role_change(actor.role, target_access.role)?;
    query("UPDATE vault_key SET role = $1::vault_role WHERE vault_id = $2 AND user_id = $3")
        .bind(role)
        .bind(&input.vault_id)
        .bind(&input.user_id)
        .execute(pool)
        .await
        .map_err(|error| database_error(error, "Failed to update vault member role"))?;
    Ok(SuccessResponse { success: true })
}

pub(crate) async fn add_vault_member(
    pool: &PgPool,
    deployment_mode: DeploymentMode,
    user_id: &str,
    request_client_id: Option<&str>,
    input: AddVaultMemberInput,
) -> Result<SuccessResponse, AppError> {
    validate_encrypted_vault_key(&input.encrypted_vault_key)?;
    let role = validate_vault_member_role(input.role)?;
    let actor =
        load_managed_team_vault_actor(pool, &input.vault_id, user_id, deployment_mode).await?;
    let target_user = query_as::<_, DbVaultLookupUserRow>(
        "SELECT id, name, email, public_key, team_id FROM \"user\" WHERE id = $1 LIMIT 1",
    )
    .bind(&input.user_id)
    .fetch_optional(pool)
    .await
    .map_err(|error| database_error(error, "Failed to load target user"))?
    .ok_or_else(|| AppError::not_found("User not found"))?;
    if target_user.team_id.as_deref() != actor.team_id.as_deref() {
        return Err(AppError::bad_request(
            "User must belong to the same team as this vault",
        ));
    }
    let existing_member = query_scalar::<_, String>(
        "SELECT user_id FROM vault_key WHERE vault_id = $1 AND user_id = $2 LIMIT 1",
    )
    .bind(&input.vault_id)
    .bind(&input.user_id)
    .fetch_optional(pool)
    .await
    .map_err(|error| database_error(error, "Failed to load existing vault member"))?;
    if existing_member.is_some() {
        return Err(AppError::conflict("User is already a member of this vault"));
    }
    let mut transaction = pool
        .begin()
        .await
        .map_err(|error| database_error(error, "Failed to start vault member add transaction"))?;
    query(
			"INSERT INTO vault_key (id, vault_id, user_id, encrypted_vault_key, role, created_at) VALUES ($1, $2, $3, $4, $5::vault_role, $6)",
		)
		.bind(generate_resource_id("vault_key"))
		.bind(&input.vault_id)
		.bind(&input.user_id)
		.bind(&input.encrypted_vault_key)
		.bind(role)
		.bind(OffsetDateTime::now_utc())
		.execute(&mut *transaction)
		.await
		.map_err(|error| database_error(error, "Failed to add vault member"))?;
    insert_vault_member_sync_event(
        &mut transaction,
        SyncEventType::VaultMemberAdded,
        &input.user_id,
        &input.vault_id,
        user_id,
        input.client_id.as_deref().or(request_client_id),
        json!({ "addedUserId": input.user_id, "role": role }),
    )
    .await?;
    insert_vault_audit_log_with_metadata(
        &mut *transaction,
        "vault_member_added",
        &input.vault_id,
        user_id,
        json!({ "addedUserId": input.user_id, "role": role }),
    )
    .await?;
    transaction
        .commit()
        .await
        .map_err(|error| database_error(error, "Failed to commit vault member add"))?;
    Ok(SuccessResponse { success: true })
}

struct ManagedVaultActor {
    role: VaultRole,
    team_id: Option<String>,
}

async fn load_managed_team_vault_actor(
    pool: &PgPool,
    vault_id: &str,
    user_id: &str,
    deployment_mode: DeploymentMode,
) -> Result<ManagedVaultActor, AppError> {
    let actor = query_as::<_, DbVaultOwnerAccessRow>(
			"SELECT vk.vault_id, v.type::text AS vault_type, v.team_id, vk.role::text AS role FROM vault_key vk INNER JOIN vault v ON v.id = vk.vault_id WHERE vk.vault_id = $1 AND vk.user_id = $2 LIMIT 1",
		)
		.bind(vault_id)
		.bind(user_id)
		.fetch_optional(pool)
		.await
		.map_err(|error| database_error(error, "Failed to load vault access"))?
		.ok_or_else(|| AppError::forbidden("Access denied to this vault"))?;
    let billing =
        load_team_billing_entitlement(pool, user_id, "Failed to load billing entitlements").await?;
    assert_vault_sharing_available(deployment_mode, billing.as_ref())?;
    if !actor.role.can_manage() {
        return Err(AppError::forbidden(
            "Only vault owner or admin can manage members",
        ));
    }
    if actor.vault_type != VaultType::Team || actor.team_id.is_none() {
        return Err(AppError::bad_request(
            "Only team vaults support adding members",
        ));
    }
    Ok(ManagedVaultActor {
        role: actor.role,
        team_id: actor.team_id,
    })
}

fn assert_vault_sharing_available(
    deployment_mode: DeploymentMode,
    billing: Option<&DbTeamBillingEntitlementRow>,
) -> Result<(), AppError> {
    if deployment_mode.is_self_hosted() {
        return Ok(());
    }
    let Some(billing) = billing else {
        return Err(AppError::forbidden(
				"Shared vault management is only available on Family or Team plans with active billing.",
			));
    };
    let entitlement = resolve_vault_sharing_entitlement(
        deployment_mode,
        billing.billing_plan.unwrap_or(BillingPlan::Free),
        billing.billing_status.unwrap_or(BillingStatus::None),
    );
    if !entitlement.allowed {
        return Err(AppError::forbidden(
				"Shared vault management is only available on Family or Team plans with active billing.",
			));
    }
    Ok(())
}

/// A vault has exactly one owner — created with the vault — so `owner` is not grantable.
fn validate_vault_member_role(role: VaultRole) -> Result<VaultRole, AppError> {
    match role {
        VaultRole::Admin | VaultRole::Member | VaultRole::ReadOnly => Ok(role),
        VaultRole::Owner => Err(AppError::bad_request("Invalid member role")),
    }
}

#[cfg(test)]
mod tests {
    use super::{
        assert_vault_sharing_available, resolve_vault_sharing_entitlement,
        validate_vault_member_role, BillingPlan, BillingStatus, DeploymentMode, VaultRole,
    };
    use crate::db::models::DbTeamBillingEntitlementRow;
    use crate::error::AppErrorCode;

    #[test]
    fn validate_vault_member_role_accepts_supported_roles() {
        for role in [VaultRole::Admin, VaultRole::Member, VaultRole::ReadOnly] {
            assert_eq!(validate_vault_member_role(role).unwrap(), role);
        }
    }

    #[test]
    fn validate_vault_member_role_rejects_invalid_roles() {
        let error = validate_vault_member_role(VaultRole::Owner).unwrap_err();

        assert_eq!(error.code, AppErrorCode::BadRequest);
        assert_eq!(error.message, "Invalid member role");
    }

    #[test]
    fn resolve_vault_sharing_entitlement_respects_plan_status_and_mode() {
        let family = resolve_vault_sharing_entitlement(
            DeploymentMode::Cloud,
            BillingPlan::Family,
            BillingStatus::Active,
        );
        assert!(family.allowed);
        assert_eq!(family.shared_vault_limit, Some(5));

        let team = resolve_vault_sharing_entitlement(
            DeploymentMode::Cloud,
            BillingPlan::Team,
            BillingStatus::Trialing,
        );
        assert!(team.allowed);
        assert_eq!(team.shared_vault_limit, None);

        let free = resolve_vault_sharing_entitlement(
            DeploymentMode::Cloud,
            BillingPlan::Free,
            BillingStatus::Active,
        );
        assert!(!free.allowed);
        assert_eq!(free.shared_vault_limit, Some(0));

        let entitlement = resolve_vault_sharing_entitlement(
            DeploymentMode::SelfHosted,
            BillingPlan::Free,
            BillingStatus::None,
        );
        assert!(entitlement.allowed);
        assert_eq!(entitlement.shared_vault_limit, None);
    }

    #[test]
    fn assert_vault_sharing_available_requires_cloud_entitlement() {
        assert!(assert_vault_sharing_available(
            DeploymentMode::Cloud,
            Some(&DbTeamBillingEntitlementRow {
                team_id: Some("team_123".to_string()),
                billing_plan: Some(BillingPlan::Family),
                billing_status: Some(BillingStatus::Active),
            }),
        )
        .is_ok());

        let missing = assert_vault_sharing_available(DeploymentMode::Cloud, None).unwrap_err();
        assert_eq!(missing.code, AppErrorCode::Forbidden);
        assert_eq!(
					missing.message,
					"Shared vault management is only available on Family or Team plans with active billing."
				);

        let free_plan = assert_vault_sharing_available(
            DeploymentMode::Cloud,
            Some(&DbTeamBillingEntitlementRow {
                team_id: Some("team_123".to_string()),
                billing_plan: Some(BillingPlan::Free),
                billing_status: Some(BillingStatus::Active),
            }),
        )
        .unwrap_err();
        assert_eq!(free_plan.code, AppErrorCode::Forbidden);

        assert!(assert_vault_sharing_available(DeploymentMode::SelfHosted, None).is_ok());
    }
}
