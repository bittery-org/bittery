use std::collections::HashMap;

use serde::{Deserialize, Serialize};
use sqlx::{query, query_as, query_scalar, PgPool};
use time::OffsetDateTime;

use crate::{
    config::{format_timestamp, DeploymentMode},
    db::enums::{BillingPlan, BillingStatus, TeamRole, TeamType},
    db::events::generate_resource_id,
    db::models::*,
    error::AppError,
    integrations::storage,
    shared::transaction::{
        acquire_team_authority_lock, acquire_user_authority_lock, database_error,
    },
};

use super::shape::{team_details_shape, team_summary_shape};
use crate::domains::billing::entitlements::team_management_enabled as shared_team_management_enabled;

#[cfg(test)]
use super::invitations::{
    normalize_pending_vault_keys, parse_pending_vault_keys, validate_token, PendingVaultKeyEntry,
};
#[cfg(test)]
use crate::shared::generate_secure_token;

const TEAM_MANAGEMENT_UNAVAILABLE_MESSAGE: &str =
    "Team management is only available on Family or Team plans with active billing.";

#[allow(dead_code)]
#[derive(Clone, Debug, sqlx::FromRow)]
pub(super) struct DbTeamMembershipActorRow {
    pub(super) id: String,
    pub(super) email: String,
    pub(super) team_id: Option<String>,
    pub(super) role: TeamRole,
    pub(super) billing_plan: Option<BillingPlan>,
    pub(super) billing_status: Option<BillingStatus>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
#[serde(deny_unknown_fields)]
pub struct TeamIdInput {
    pub team_id: String,
}

#[allow(dead_code)]
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
#[serde(deny_unknown_fields)]
pub struct CreateTeamInput {
    pub name: String,
    pub team_type: Option<TeamType>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
#[serde(deny_unknown_fields)]
pub struct UpdateTeamInput {
    pub team_id: String,
    pub name: Option<String>,
    pub image_key: Option<Option<String>>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
#[serde(deny_unknown_fields)]
pub struct CreateImageUploadInput {
    pub team_id: String,
    pub file_name: String,
    pub content_type: String,
}

team_summary_shape!(service_struct {
    #[derive(Debug, Clone, Serialize)]
    #[serde(rename_all = "camelCase")]
    pub struct TeamSummaryResponse
}, count = i64);

team_details_shape!(service_struct {
    #[derive(Debug, Clone, Serialize)]
    #[serde(rename_all = "camelCase")]
    pub struct TeamDetailsResponse
}, count = i64);

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TeamVaultResponse {
    pub id: String,
    pub name: String,
    pub encrypted_vault_key: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TeamMemberResponse {
    pub user_id: String,
    pub name: String,
    pub email: String,
    pub role: TeamRole,
    pub joined_at: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SuccessResponse {
    pub success: bool,
}

pub(crate) async fn list_teams(
    pool: &PgPool,
    object_storage: &dyn storage::ObjectStorage,
    user_id: &str,
) -> Result<TeamSummaryResponse, AppError> {
    let team = query_as::<_, DbTeamSummaryRow>(
		"SELECT t.id, t.name, t.type::text AS team_type, t.owner_id, u.role::text AS role, (SELECT COUNT(*)::bigint FROM \"user\" member WHERE member.team_id = t.id) AS member_count, t.member_limit, t.image_key, t.created_at FROM \"user\" u INNER JOIN team t ON u.team_id = t.id WHERE u.id = $1 LIMIT 1",
	)
	.bind(user_id)
	.fetch_optional(pool)
	.await
	.map_err(|error| database_error(error, "Failed to load team"))?
	.ok_or_else(|| AppError::not_found("User has no team"))?;

    Ok(TeamSummaryResponse {
        id: team.id,
        name: team.name,
        team_type: team.team_type,
        owner_id: team.owner_id,
        role: team.role,
        member_count: team.member_count,
        member_limit: team.member_limit,
        image_url: team
            .image_key
            .as_deref()
            .and_then(|key| object_storage.public_url(key)),
        created_at: format_timestamp(team.created_at),
    })
}

pub(crate) async fn get_team(
    pool: &PgPool,
    object_storage: &dyn storage::ObjectStorage,
    user_id: &str,
    input: TeamIdInput,
) -> Result<TeamDetailsResponse, AppError> {
    let current_user = load_team_membership_actor(pool, user_id).await?;
    if current_user
        .as_ref()
        .and_then(|user| user.team_id.as_deref())
        != Some(input.team_id.as_str())
    {
        return Err(AppError::forbidden("You are not a member of this team"));
    }

    let team = query_as::<_, DbTeamDetailsRow>(
		"SELECT t.id, t.name, t.type::text AS team_type, t.owner_id, owner.name AS owner_name, u.role::text AS user_role, (SELECT COUNT(*)::bigint FROM \"user\" member WHERE member.team_id = t.id) AS member_count, t.member_limit, t.image_key, t.created_at, t.updated_at FROM team t INNER JOIN \"user\" owner ON t.owner_id = owner.id INNER JOIN \"user\" u ON u.id = $1 WHERE t.id = $2 LIMIT 1",
	)
	.bind(user_id)
	.bind(&input.team_id)
	.fetch_optional(pool)
	.await
	.map_err(|error| database_error(error, "Failed to load team"))?
	.ok_or_else(|| AppError::not_found("Team not found"))?;

    Ok(TeamDetailsResponse {
        id: team.id,
        name: team.name,
        team_type: team.team_type,
        owner_id: team.owner_id,
        owner_name: team.owner_name,
        user_role: team.user_role,
        member_count: team.member_count,
        member_limit: team.member_limit,
        image_url: team
            .image_key
            .as_deref()
            .and_then(|key| object_storage.public_url(key)),
        created_at: format_timestamp(team.created_at),
        updated_at: format_timestamp(team.updated_at),
    })
}

pub(crate) async fn get_team_vaults(
    pool: &PgPool,
    deployment_mode: DeploymentMode,
    user_id: &str,
    input: TeamIdInput,
) -> Result<Vec<TeamVaultResponse>, AppError> {
    let actor = load_team_membership_actor(pool, user_id).await?;
    if actor
        .as_ref()
        .and_then(|value| value.team_id.as_ref())
        .map(|team_id| team_id != &input.team_id)
        .unwrap_or(true)
    {
        return Err(AppError::forbidden("You are not a member of this team"));
    }

    let actor = actor.ok_or_else(|| AppError::forbidden("You are not a member of this team"))?;
    ensure_team_admin(actor.role)?;
    assert_optional_team_management_entitlement(
        deployment_mode,
        actor.billing_plan,
        actor.billing_status,
    )?;

    let team_vaults = query_as::<_, DbTeamVaultRow>(
        "SELECT id, name FROM vault WHERE team_id = $1 ORDER BY created_at ASC",
    )
    .bind(&input.team_id)
    .fetch_all(pool)
    .await
    .map_err(|error| database_error(error, "Failed to load team vaults"))?;
    if team_vaults.is_empty() {
        return Ok(Vec::new());
    }

    let team_vault_ids: Vec<String> = team_vaults.iter().map(|vault| vault.id.clone()).collect();
    let user_vault_keys = query_as::<_, DbUserVaultKeyRow>(
		"SELECT vault_id, encrypted_vault_key FROM vault_key WHERE user_id = $1 AND vault_id = ANY($2)",
	)
	.bind(user_id)
	.bind(&team_vault_ids)
	.fetch_all(pool)
	.await
	.map_err(|error| database_error(error, "Failed to load user vault keys"))?;

    let key_map: HashMap<String, String> = user_vault_keys
        .into_iter()
        .map(|record| (record.vault_id, record.encrypted_vault_key))
        .collect();

    Ok(team_vaults
        .into_iter()
        .map(|vault| TeamVaultResponse {
            encrypted_vault_key: key_map.get(&vault.id).cloned(),
            id: vault.id,
            name: vault.name,
        })
        .collect())
}

#[allow(non_snake_case)]
pub(crate) async fn create_team(
    _pool: &PgPool,
    _user_id: &str,
    _input: CreateTeamInput,
) -> Result<SuccessResponse, AppError> {
    Err(AppError::bad_request(
        "Teams are automatically created on signup. Contact support to upgrade your team type.",
    ))
}

pub(crate) async fn update_team(
    pool: &PgPool,
    user_id: &str,
    input: UpdateTeamInput,
) -> Result<SuccessResponse, AppError> {
    let current_user = load_team_membership_actor(pool, user_id).await?;
    if current_user
        .as_ref()
        .and_then(|user| user.team_id.as_deref())
        != Some(input.team_id.as_str())
    {
        return Err(AppError::forbidden("You are not a member of this team"));
    }

    let current_user =
        current_user.ok_or_else(|| AppError::forbidden("You are not a member of this team"))?;
    ensure_team_admin(current_user.role)?;

    let updated_at = OffsetDateTime::now_utc();
    match (input.name.as_ref(), input.image_key.as_ref()) {
        (Some(name), Some(image_key)) => {
            query("UPDATE team SET name = $1, image_key = $2, updated_at = $3 WHERE id = $4")
                .bind(name)
                .bind(image_key.as_ref())
                .bind(updated_at)
                .bind(&input.team_id)
                .execute(pool)
                .await
                .map_err(|error| database_error(error, "Failed to update team"))?;
        }
        (Some(name), None) => {
            query("UPDATE team SET name = $1, updated_at = $2 WHERE id = $3")
                .bind(name)
                .bind(updated_at)
                .bind(&input.team_id)
                .execute(pool)
                .await
                .map_err(|error| database_error(error, "Failed to update team"))?;
        }
        (None, Some(image_key)) => {
            query("UPDATE team SET image_key = $1, updated_at = $2 WHERE id = $3")
                .bind(image_key.as_ref())
                .bind(updated_at)
                .bind(&input.team_id)
                .execute(pool)
                .await
                .map_err(|error| database_error(error, "Failed to update team"))?;
        }
        (None, None) => {
            query("UPDATE team SET updated_at = $1 WHERE id = $2")
                .bind(updated_at)
                .bind(&input.team_id)
                .execute(pool)
                .await
                .map_err(|error| database_error(error, "Failed to update team"))?;
        }
    }

    Ok(SuccessResponse { success: true })
}

pub(crate) async fn create_team_image_upload(
    pool: &PgPool,
    object_storage: &dyn storage::ObjectStorage,
    user_id: &str,
    input: CreateImageUploadInput,
) -> Result<storage::PresignedUploadResult, AppError> {
    if !input.content_type.starts_with("image/") {
        return Err(AppError::bad_request("Only image files are allowed"));
    }

    let current_user = load_team_membership_actor(pool, user_id).await?;
    if current_user
        .as_ref()
        .and_then(|user| user.team_id.as_deref())
        != Some(input.team_id.as_str())
    {
        return Err(AppError::forbidden("You are not a member of this team"));
    }

    let current_user =
        current_user.ok_or_else(|| AppError::forbidden("You are not a member of this team"))?;
    ensure_team_admin(current_user.role)?;

    let key = storage::create_team_image_key(&input.team_id, &input.file_name);
    object_storage
        .presign_upload(&key, &input.content_type, None, None, None)
        .await
        .map_err(|error| {
            tracing::error!(error = %error, "Internal error");
            AppError::internal("An internal error occurred")
        })
}

pub(crate) async fn delete_team(
    pool: &PgPool,
    deployment_mode: DeploymentMode,
    user_id: &str,
    input: TeamIdInput,
) -> Result<SuccessResponse, AppError> {
    if deployment_mode.is_self_hosted() {
        return Err(AppError::bad_request(
            "Team deletion is disabled in self-hosted mode. This instance uses a single team.",
        ));
    }

    let actor = query_as::<_, DbDeleteTeamActorRow>(
		"SELECT u.id AS user_id, u.name AS user_name, u.team_id, u.role::text AS role, t.type::text AS team_type FROM \"user\" u INNER JOIN team t ON u.team_id = t.id WHERE u.id = $1 LIMIT 1",
	)
	.bind(user_id)
	.fetch_optional(pool)
	.await
	.map_err(|error| database_error(error, "Failed to load team actor"))?;
    let Some(actor) = actor else {
        return Err(AppError::forbidden("You are not a member of this team"));
    };
    if actor.team_id != input.team_id {
        return Err(AppError::forbidden("You are not a member of this team"));
    }
    if actor.role != TeamRole::Owner {
        return Err(AppError::forbidden(
            "Only the team owner can delete the team",
        ));
    }
    if actor.team_type == TeamType::Personal {
        return Err(AppError::bad_request(
            "Personal teams cannot be deleted. To close your account, use Account Settings.",
        ));
    }

    let mut transaction = pool
        .begin()
        .await
        .map_err(|error| database_error(error, "Failed to start transaction"))?;
    acquire_user_authority_lock(
        &mut transaction,
        user_id,
        "Failed to lock Team deletion User authority",
    )
    .await?;
    acquire_team_authority_lock(
        &mut *transaction,
        &input.team_id,
        "Failed to lock Team deletion authority",
    )
    .await?;

    let actor = query_as::<_, DbDeleteTeamActorRow>(
		"SELECT u.id AS user_id, u.name AS user_name, u.team_id, u.role::text AS role, t.type::text AS team_type FROM \"user\" u INNER JOIN team t ON u.team_id = t.id WHERE u.id = $1 LIMIT 1",
	)
	.bind(user_id)
	.fetch_optional(&mut *transaction)
	.await
	.map_err(|error| database_error(error, "Failed to reload team actor"))?;
    let Some(actor) = actor else {
        return Err(AppError::forbidden(
            "Only the team owner can delete the team",
        ));
    };
    if actor.team_id != input.team_id
        || actor.role != TeamRole::Owner
        || actor.team_type == TeamType::Personal
    {
        return Err(AppError::forbidden(
            "Only the team owner can delete the team",
        ));
    }

    let member_count =
        query_scalar::<_, i64>("SELECT COUNT(*)::bigint FROM \"user\" WHERE team_id = $1")
            .bind(&input.team_id)
            .fetch_one(&mut *transaction)
            .await
            .map_err(|error| database_error(error, "Failed to count team members"))?;
    if member_count != 1 {
        return Err(AppError::bad_request(
            "Team deletion is blocked until the owner is the only remaining member.",
        ));
    }

    let team_vault_count =
        query_scalar::<_, i64>("SELECT COUNT(*)::bigint FROM vault WHERE team_id = $1")
            .bind(&input.team_id)
            .fetch_one(&mut *transaction)
            .await
            .map_err(|error| database_error(error, "Failed to count team vaults"))?;
    if team_vault_count > 0 {
        return Err(AppError::bad_request(
            "Team deletion is blocked until all team vaults have been removed or converted.",
        ));
    }

    create_personal_team_for_user(&mut transaction, user_id, &actor.user_name).await?;
    query("DELETE FROM team_invitation WHERE team_id = $1")
        .bind(&input.team_id)
        .execute(&mut *transaction)
        .await
        .map_err(|error| database_error(error, "Failed to delete team invitations"))?;
    query("DELETE FROM team WHERE id = $1")
        .bind(&input.team_id)
        .execute(&mut *transaction)
        .await
        .map_err(|error| database_error(error, "Failed to delete team"))?;

    transaction
        .commit()
        .await
        .map_err(|error| database_error(error, "Failed to commit team deletion"))?;

    Ok(SuccessResponse { success: true })
}

pub(crate) mod member_handlers {
    use super::*;

    pub(crate) async fn list_team_members(
        pool: &PgPool,
        user_id: &str,
        input: TeamIdInput,
    ) -> Result<Vec<TeamMemberResponse>, AppError> {
        let current_user = load_team_membership_actor(pool, user_id).await?;
        if current_user
            .as_ref()
            .and_then(|user| user.team_id.as_deref())
            != Some(input.team_id.as_str())
        {
            return Err(AppError::forbidden("You are not a member of this team"));
        }

        let members = query_as::<_, DbTeamMemberRow>(
			"SELECT id AS user_id, name, email, role::text AS role, created_at AS joined_at FROM \"user\" WHERE team_id = $1 ORDER BY created_at ASC",
		)
		.bind(&input.team_id)
		.fetch_all(pool)
		.await
		.map_err(|error| database_error(error, "Failed to load team members"))?;

        Ok(members
            .into_iter()
            .map(|member| TeamMemberResponse {
                user_id: member.user_id,
                name: member.name,
                email: member.email,
                role: member.role,
                joined_at: format_timestamp(member.joined_at),
            })
            .collect())
    }
}

pub(super) fn assert_team_management_entitlement(
    deployment_mode: DeploymentMode,
    billing_plan: BillingPlan,
    billing_status: BillingStatus,
) -> Result<(), AppError> {
    if shared_team_management_enabled(
        deployment_mode.as_str(),
        Some(billing_plan),
        Some(billing_status),
    ) {
        Ok(())
    } else {
        Err(AppError::forbidden(TEAM_MANAGEMENT_UNAVAILABLE_MESSAGE))
    }
}

pub(super) fn assert_optional_team_management_entitlement(
    deployment_mode: DeploymentMode,
    billing_plan: Option<BillingPlan>,
    billing_status: Option<BillingStatus>,
) -> Result<(), AppError> {
    let plan = billing_plan.ok_or_else(|| AppError::not_found("Team not found"))?;
    let status = billing_status.ok_or_else(|| AppError::not_found("Team not found"))?;
    assert_team_management_entitlement(deployment_mode, plan, status)
}

async fn create_personal_team_for_user(
    transaction: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    user_id: &str,
    user_name: &str,
) -> Result<String, AppError> {
    let team_id = generate_resource_id("team");
    let team_name = format!("{user_name}'s Team");
    query(
		"INSERT INTO team (id, name, owner_id, type, member_limit, billing_plan, billing_status) VALUES ($1, $2, $3, 'personal', 1, 'free', 'none')",
	)
	.bind(&team_id)
	.bind(&team_name)
	.bind(user_id)
	.execute(&mut **transaction)
	.await
	.map_err(|error| database_error(error, "Failed to create personal team"))?;
    query("UPDATE \"user\" SET team_id = $1, role = 'owner' WHERE id = $2")
        .bind(&team_id)
        .bind(user_id)
        .execute(&mut **transaction)
        .await
        .map_err(|error| database_error(error, "Failed to reassign team owner"))?;

    Ok(team_id)
}

pub(super) fn ensure_team_admin(role: TeamRole) -> Result<(), AppError> {
    if role.can_manage() {
        Ok(())
    } else {
        Err(AppError::forbidden("Insufficient permissions"))
    }
}

pub(super) async fn load_team_membership_actor(
    pool: &PgPool,
    user_id: &str,
) -> Result<Option<DbTeamMembershipActorRow>, AppError> {
    query_as::<_, DbTeamMembershipActorRow>(
        "SELECT u.id, u.email, u.team_id, u.role::text AS role, t.billing_plan::text AS billing_plan, t.billing_status::text AS billing_status FROM \"user\" u LEFT JOIN team t ON u.team_id = t.id WHERE u.id = $1 LIMIT 1",
    )
    .bind(user_id)
    .fetch_optional(pool)
    .await
    .map_err(|error| database_error(error, "Failed to load team membership"))
}

#[cfg(test)]
#[path = "service_tests.rs"]
mod tests;
