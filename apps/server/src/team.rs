use std::collections::{HashMap, HashSet};

use qubit::{
    builder::IntoResponse,
    handler,
    server::{ErrorCode, Router, RpcError},
};
use rand::random;
use serde::{Deserialize, Serialize};
use serde_json::json;
use sqlx::{query, query_as, query_scalar, PgPool, Postgres, Transaction};
use time::OffsetDateTime;
use ts_rs::TS;

use crate::{
    auth::{AppContext, RefreshSessionContext},
    billing::sync_team_seats_best_effort,
    db::models::*,
    session_control::{load_user_session_ids, record_session_revocations},
    storage, AppState,
};

const TEAM_MANAGEMENT_UNAVAILABLE_MESSAGE: &str =
    "Team management is only available on Family or Team plans with active billing.";

#[derive(Debug, Clone, Serialize, TS)]
pub struct TeamRpcError {
    pub code: String,
    pub message: String,
}

#[derive(Debug, Clone, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[serde(deny_unknown_fields)]
pub struct TokenInput {
    pub token: String,
}

#[derive(Debug, Clone, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[serde(deny_unknown_fields)]
pub struct TeamIdInput {
    pub team_id: String,
}

#[derive(Debug, Clone, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[serde(deny_unknown_fields)]
pub struct CreateTeamInput {
    pub name: String,
    pub team_type: Option<String>,
}

#[derive(Debug, Clone, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[serde(deny_unknown_fields)]
pub struct UpdateTeamInput {
    pub team_id: String,
    pub name: Option<String>,
    pub image_key: Option<Option<String>>,
}

#[derive(Debug, Clone, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[serde(deny_unknown_fields)]
pub struct CreateImageUploadInput {
    pub team_id: String,
    pub file_name: String,
    pub content_type: String,
}

#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct TeamSummaryResponse {
    pub id: String,
    pub name: String,
    pub team_type: String,
    pub owner_id: String,
    pub role: String,
    pub member_count: i64,
    pub member_limit: Option<i32>,
    pub image_url: Option<String>,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct TeamDetailsResponse {
    pub id: String,
    pub name: String,
    pub team_type: String,
    pub owner_id: String,
    pub owner_name: String,
    pub user_role: String,
    pub member_count: i64,
    pub member_limit: Option<i32>,
    pub image_url: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct TeamVaultResponse {
    pub id: String,
    pub name: String,
    pub encrypted_vault_key: Option<String>,
}

#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct TeamMemberResponse {
    pub user_id: String,
    pub name: String,
    pub email: String,
    pub role: String,
    pub joined_at: String,
}

#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct RotationMemberResponse {
    pub user_id: String,
    pub public_key: String,
    pub role: String,
}

#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct RotationItemResponse {
    pub id: String,
    pub encrypted_data: String,
    pub encryption_iv: String,
    pub encryption_algorithm: String,
}

#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct RotationVaultResponse {
    pub vault_id: String,
    pub vault_name: String,
    pub key_version: i32,
    pub members: Vec<RotationMemberResponse>,
    pub items: Vec<RotationItemResponse>,
}

#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct RotationDataResponse {
    pub vaults: Vec<RotationVaultResponse>,
}

#[derive(Debug, Clone, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[serde(deny_unknown_fields)]
pub struct InvitationIdInput {
    pub invitation_id: String,
}

#[derive(Debug, Clone, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[serde(deny_unknown_fields)]
pub struct SendInvitationInput {
    pub team_id: String,
    pub email: String,
    #[serde(default = "default_invitation_role")]
    pub role: String,
    pub pending_vault_keys: Option<Vec<PendingVaultKeyEntry>>,
}

#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct TeamInvitationDetailsResponse {
    pub id: String,
    pub email: String,
    pub team_id: String,
    pub team_name: String,
    pub role: String,
    pub status: String,
    pub invited_by_name: String,
    pub expires_at: String,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct PendingTeamInvitationResponse {
    pub id: String,
    pub token: String,
    pub team_id: String,
    pub team_name: String,
    pub role: String,
    pub invited_by: String,
    pub expires_at: String,
}

#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct SendInvitationResponse {
    pub invitation_id: String,
    pub token: String,
    pub existing_user_public_key: Option<String>,
}

#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct AcceptInvitationResponse {
    pub team_id: String,
    pub team_name: String,
}

#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct SuccessResponse {
    pub success: bool,
}

#[derive(Debug, Clone, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[serde(deny_unknown_fields)]
pub struct DeleteAccountInput {
    pub team_id: String,
    pub user_id: String,
    pub confirmation: String,
}

#[derive(Debug, Clone, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[serde(deny_unknown_fields)]
pub struct TeamRotationInput {
    pub team_id: String,
    pub exclude_user_id: String,
}

const MAX_ROTATION_VAULTS: usize = 100;
const MAX_ROTATION_MEMBER_KEYS: usize = 100;
const MAX_ROTATION_REENCRYPTED_ITEMS: usize = 100;

#[derive(Debug, Clone, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[serde(deny_unknown_fields)]
pub struct RotationMemberKeyInput {
    pub user_id: String,
    pub encrypted_vault_key: String,
}

#[derive(Debug, Clone, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[serde(deny_unknown_fields)]
pub struct RotationReEncryptedItemInput {
    pub item_id: String,
    pub encrypted_data: String,
    pub encryption_iv: String,
}

#[derive(Debug, Clone, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[serde(deny_unknown_fields)]
pub struct VaultKeyRotationInput {
    pub member_keys: Vec<RotationMemberKeyInput>,
    pub re_encrypted_items: Vec<RotationReEncryptedItemInput>,
}

#[derive(Debug, Clone, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[serde(deny_unknown_fields)]
pub struct RotationVaultInput {
    pub vault_id: String,
    pub key_rotation: VaultKeyRotationInput,
}

#[derive(Debug, Clone, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[serde(deny_unknown_fields)]
pub struct LeaveTeamInput {
    pub team_id: String,
    pub vault_rotations: Vec<RotationVaultInput>,
    pub client_id: Option<String>,
}

#[derive(Debug, Clone, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[serde(deny_unknown_fields)]
pub struct RemoveTeamMemberInput {
    pub team_id: String,
    pub user_id: String,
    pub vault_rotations: Vec<RotationVaultInput>,
    pub client_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct TeamVaultRotationResult {
    pub vault_id: String,
    pub rotation_id: String,
    pub new_key_version: i32,
}

#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct RemoveTeamMemberResponse {
    pub success: bool,
    pub vault_rotations: Vec<TeamVaultRotationResult>,
}

#[derive(Debug, Clone, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[serde(deny_unknown_fields)]
pub struct PendingVaultKeyEntry {
    pub vault_id: String,
    pub encrypted_vault_key: String,
}

#[allow(non_snake_case)]
#[handler(query)]
pub async fn getByToken(
    ctx: AppContext,
    input: TokenInput,
) -> Result<TeamInvitationDetailsResponse, TeamRpcError> {
    validate_token(&input.token)?;

    let pool = db_pool(&ctx.app_state)?;
    let invitation = query_as::<_, DbTeamInvitationDetailsRow>(
		"SELECT ti.id, ti.email, ti.team_id, t.name AS team_name, ti.role::text AS role, ti.status::text AS status, invited_by.name AS invited_by_name, ti.expires_at, ti.created_at FROM team_invitation ti INNER JOIN team t ON ti.team_id = t.id INNER JOIN \"user\" invited_by ON ti.invited_by_id = invited_by.id WHERE ti.token = $1 LIMIT 1",
	)
	.bind(&input.token)
	.fetch_optional(pool)
	.await
	.map_err(|e| { tracing::error!(error = %e, "Failed to load invitation"); internal_error("Failed to load invitation") })?
	.ok_or_else(|| not_found_error("Invitation not found"))?;

    let invitation_status = if invitation.expires_at < OffsetDateTime::now_utc() {
        "expired".to_string()
    } else {
        invitation.status
    };

    Ok(TeamInvitationDetailsResponse {
        id: invitation.id,
        email: invitation.email,
        team_id: invitation.team_id,
        team_name: invitation.team_name,
        role: invitation.role,
        status: invitation_status,
        invited_by_name: invitation.invited_by_name,
        expires_at: format_timestamp(invitation.expires_at),
        created_at: format_timestamp(invitation.created_at),
    })
}

#[allow(non_snake_case)]
#[handler(query)]
pub async fn pending(
    ctx: RefreshSessionContext,
) -> Result<Vec<PendingTeamInvitationResponse>, TeamRpcError> {
    let pool = db_pool(&ctx.app_state)?;
    let current_user = query_as::<_, DbTeamUserRow>(
        "SELECT id, email, team_id, role::text AS role FROM \"user\" WHERE id = $1 LIMIT 1",
    )
    .bind(&ctx.session.user_id)
    .fetch_optional(pool)
    .await
    .map_err(|e| {
        tracing::error!(error = %e, "Failed to load user");
        internal_error("Failed to load user")
    })?
    .ok_or_else(|| not_found_error("User not found"))?;

    let invitations = query_as::<_, DbPendingTeamInvitationRow>(
		"SELECT ti.id, ti.token, ti.team_id, t.name AS team_name, ti.role::text AS role, invited_by.name AS invited_by_name, ti.expires_at FROM team_invitation ti INNER JOIN team t ON ti.team_id = t.id INNER JOIN \"user\" invited_by ON ti.invited_by_id = invited_by.id WHERE ti.email = $1 AND ti.status = 'pending' AND ti.expires_at > $2 ORDER BY ti.created_at DESC",
	)
	.bind(&current_user.email)
	.bind(OffsetDateTime::now_utc())
	.fetch_all(pool)
	.await
	.map_err(|e| { tracing::error!(error = %e, "Failed to load invitations"); internal_error("Failed to load invitations") })?;

    Ok(invitations
        .into_iter()
        .map(|invitation| PendingTeamInvitationResponse {
            id: invitation.id,
            token: invitation.token,
            team_id: invitation.team_id,
            team_name: invitation.team_name,
            role: invitation.role,
            invited_by: invitation.invited_by_name,
            expires_at: format_timestamp(invitation.expires_at),
        })
        .collect())
}

#[allow(non_snake_case)]
#[handler(query)]
pub async fn list(ctx: RefreshSessionContext) -> Result<TeamSummaryResponse, TeamRpcError> {
    let pool = db_pool(&ctx.app_state)?;
    let team = query_as::<_, DbTeamSummaryRow>(
		"SELECT t.id, t.name, t.type::text AS team_type, t.owner_id, u.role::text AS role, (SELECT COUNT(*)::bigint FROM \"user\" member WHERE member.team_id = t.id) AS member_count, t.member_limit, t.image_key, t.created_at FROM \"user\" u INNER JOIN team t ON u.team_id = t.id WHERE u.id = $1 LIMIT 1",
	)
	.bind(&ctx.session.user_id)
	.fetch_optional(pool)
	.await
	.map_err(|e| { tracing::error!(error = %e, "Failed to load team"); internal_error("Failed to load team") })?
	.ok_or_else(|| not_found_error("User has no team"))?;

    Ok(TeamSummaryResponse {
        id: team.id,
        name: team.name,
        team_type: team.team_type,
        owner_id: team.owner_id,
        role: team.role,
        member_count: team.member_count,
        member_limit: team.member_limit,
        image_url: team.image_key.map(storage::public_url),
        created_at: format_timestamp(team.created_at),
    })
}

#[allow(non_snake_case)]
#[handler(query)]
pub async fn get(
    ctx: RefreshSessionContext,
    input: TeamIdInput,
) -> Result<TeamDetailsResponse, TeamRpcError> {
    let pool = db_pool(&ctx.app_state)?;
    let current_user = query_as::<_, DbTeamUserRow>(
        "SELECT id, email, team_id, role::text AS role FROM \"user\" WHERE id = $1 LIMIT 1",
    )
    .bind(&ctx.session.user_id)
    .fetch_optional(pool)
    .await
    .map_err(|e| {
        tracing::error!(error = %e, "Failed to load user");
        internal_error("Failed to load user")
    })?;
    if current_user
        .as_ref()
        .and_then(|user| user.team_id.as_deref())
        != Some(input.team_id.as_str())
    {
        return Err(forbidden_error("You are not a member of this team"));
    }

    let team = query_as::<_, DbTeamDetailsRow>(
		"SELECT t.id, t.name, t.type::text AS team_type, t.owner_id, owner.name AS owner_name, u.role::text AS user_role, (SELECT COUNT(*)::bigint FROM \"user\" member WHERE member.team_id = t.id) AS member_count, t.member_limit, t.image_key, t.created_at, t.updated_at FROM team t INNER JOIN \"user\" owner ON t.owner_id = owner.id INNER JOIN \"user\" u ON u.id = $1 WHERE t.id = $2 LIMIT 1",
	)
	.bind(&ctx.session.user_id)
	.bind(&input.team_id)
	.fetch_optional(pool)
	.await
	.map_err(|e| { tracing::error!(error = %e, "Failed to load team"); internal_error("Failed to load team") })?
	.ok_or_else(|| not_found_error("Team not found"))?;

    Ok(TeamDetailsResponse {
        id: team.id,
        name: team.name,
        team_type: team.team_type,
        owner_id: team.owner_id,
        owner_name: team.owner_name,
        user_role: team.user_role,
        member_count: team.member_count,
        member_limit: team.member_limit,
        image_url: team.image_key.map(storage::public_url),
        created_at: format_timestamp(team.created_at),
        updated_at: format_timestamp(team.updated_at),
    })
}

#[allow(non_snake_case)]
#[handler(query)]
pub async fn vaults(
    ctx: RefreshSessionContext,
    input: TeamIdInput,
) -> Result<Vec<TeamVaultResponse>, TeamRpcError> {
    let pool = db_pool(&ctx.app_state)?;
    let actor = load_team_membership_actor(pool, &ctx.session.user_id).await?;
    if actor
        .as_ref()
        .and_then(|value| value.team_id.as_ref())
        .map(|team_id| team_id != &input.team_id)
        .unwrap_or(true)
    {
        return Err(forbidden_error("You are not a member of this team"));
    }

    let actor = actor.ok_or_else(|| forbidden_error("You are not a member of this team"))?;
    ensure_team_admin(&actor.role)?;
    assert_optional_team_management_entitlement(
        actor.billing_plan.as_deref(),
        actor.billing_status.as_deref(),
    )?;

    let team_vaults = query_as::<_, DbTeamVaultRow>(
        "SELECT id, name FROM vault WHERE team_id = $1 ORDER BY created_at ASC",
    )
    .bind(&input.team_id)
    .fetch_all(pool)
    .await
    .map_err(|e| {
        tracing::error!(error = %e, "Failed to load team vaults");
        internal_error("Failed to load team vaults")
    })?;
    if team_vaults.is_empty() {
        return Ok(Vec::new());
    }

    let team_vault_ids: Vec<String> = team_vaults.iter().map(|vault| vault.id.clone()).collect();
    let user_vault_keys = query_as::<_, DbUserVaultKeyRow>(
		"SELECT vault_id, encrypted_vault_key FROM vault_key WHERE user_id = $1 AND vault_id = ANY($2)",
	)
	.bind(&ctx.session.user_id)
	.bind(&team_vault_ids)
	.fetch_all(pool)
	.await
	.map_err(|e| { tracing::error!(error = %e, "Failed to load user vault keys"); internal_error("Failed to load user vault keys") })?;

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
#[handler(mutation)]
pub async fn create(
    _ctx: RefreshSessionContext,
    _input: CreateTeamInput,
) -> Result<SuccessResponse, TeamRpcError> {
    Err(bad_request_error(
        "Teams are automatically created on signup. Contact support to upgrade your team type.",
    ))
}

#[allow(non_snake_case)]
#[handler(mutation)]
pub async fn update(
    ctx: RefreshSessionContext,
    input: UpdateTeamInput,
) -> Result<SuccessResponse, TeamRpcError> {
    let pool = db_pool(&ctx.app_state)?;
    let current_user = query_as::<_, DbTeamUserRow>(
        "SELECT id, email, team_id, role::text AS role FROM \"user\" WHERE id = $1 LIMIT 1",
    )
    .bind(&ctx.session.user_id)
    .fetch_optional(pool)
    .await
    .map_err(|e| {
        tracing::error!(error = %e, "Failed to load user");
        internal_error("Failed to load user")
    })?;
    if current_user
        .as_ref()
        .and_then(|user| user.team_id.as_deref())
        != Some(input.team_id.as_str())
    {
        return Err(forbidden_error("You are not a member of this team"));
    }

    let current_user =
        current_user.ok_or_else(|| forbidden_error("You are not a member of this team"))?;
    ensure_team_admin(&current_user.role)?;

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
                .map_err(|e| {
                    tracing::error!(error = %e, "Failed to update team");
                    internal_error("Failed to update team")
                })?;
        }
        (Some(name), None) => {
            query("UPDATE team SET name = $1, updated_at = $2 WHERE id = $3")
                .bind(name)
                .bind(updated_at)
                .bind(&input.team_id)
                .execute(pool)
                .await
                .map_err(|e| {
                    tracing::error!(error = %e, "Failed to update team");
                    internal_error("Failed to update team")
                })?;
        }
        (None, Some(image_key)) => {
            query("UPDATE team SET image_key = $1, updated_at = $2 WHERE id = $3")
                .bind(image_key.as_ref())
                .bind(updated_at)
                .bind(&input.team_id)
                .execute(pool)
                .await
                .map_err(|e| {
                    tracing::error!(error = %e, "Failed to update team");
                    internal_error("Failed to update team")
                })?;
        }
        (None, None) => {
            query("UPDATE team SET updated_at = $1 WHERE id = $2")
                .bind(updated_at)
                .bind(&input.team_id)
                .execute(pool)
                .await
                .map_err(|e| {
                    tracing::error!(error = %e, "Failed to update team");
                    internal_error("Failed to update team")
                })?;
        }
    }

    Ok(SuccessResponse { success: true })
}

#[allow(non_snake_case)]
#[handler(mutation)]
pub async fn createImageUpload(
    ctx: RefreshSessionContext,
    input: CreateImageUploadInput,
) -> Result<storage::PresignedUploadResult, TeamRpcError> {
    if !input.content_type.starts_with("image/") {
        return Err(bad_request_error("Only image files are allowed"));
    }

    let pool = db_pool(&ctx.app_state)?;
    let current_user = query_as::<_, DbTeamUserRow>(
        "SELECT id, email, team_id, role::text AS role FROM \"user\" WHERE id = $1 LIMIT 1",
    )
    .bind(&ctx.session.user_id)
    .fetch_optional(pool)
    .await
    .map_err(|e| {
        tracing::error!(error = %e, "Failed to load user");
        internal_error("Failed to load user")
    })?;
    if current_user
        .as_ref()
        .and_then(|user| user.team_id.as_deref())
        != Some(input.team_id.as_str())
    {
        return Err(forbidden_error("You are not a member of this team"));
    }

    let current_user =
        current_user.ok_or_else(|| forbidden_error("You are not a member of this team"))?;
    ensure_team_admin(&current_user.role)?;

    let key = storage::create_team_image_key(&input.team_id, &input.file_name);
    storage::create_presigned_upload(&key, &input.content_type, None, None)
        .await
        .map_err(|error| internal_error(&error.to_string()))
}

#[allow(non_snake_case)]
#[handler(mutation)]
pub async fn delete(
    ctx: RefreshSessionContext,
    input: TeamIdInput,
) -> Result<SuccessResponse, TeamRpcError> {
    if bittery_mode() == "self-hosted" {
        return Err(bad_request_error(
            "Team deletion is disabled in self-hosted mode. This instance uses a single team.",
        ));
    }

    let pool = db_pool(&ctx.app_state)?;
    let actor = query_as::<_, DbDeleteTeamActorRow>(
		"SELECT u.id AS user_id, u.name AS user_name, u.team_id, u.role::text AS role, t.type::text AS team_type FROM \"user\" u INNER JOIN team t ON u.team_id = t.id WHERE u.id = $1 LIMIT 1",
	)
	.bind(&ctx.session.user_id)
	.fetch_optional(pool)
	.await
	.map_err(|e| { tracing::error!(error = %e, "Failed to load team actor"); internal_error("Failed to load team actor") })?;
    let Some(actor) = actor else {
        return Err(forbidden_error("You are not a member of this team"));
    };
    if actor.team_id != input.team_id {
        return Err(forbidden_error("You are not a member of this team"));
    }
    if actor.role != "owner" {
        return Err(forbidden_error("Only the team owner can delete the team"));
    }
    if actor.team_type == "personal" {
        return Err(bad_request_error(
            "Personal teams cannot be deleted. To close your account, use Account Settings.",
        ));
    }

    let mut transaction = pool.begin().await.map_err(|e| {
        tracing::error!(error = %e, "Failed to start transaction");
        internal_error("Failed to start transaction")
    })?;

    let actor = query_as::<_, DbDeleteTeamActorRow>(
		"SELECT u.id AS user_id, u.name AS user_name, u.team_id, u.role::text AS role, t.type::text AS team_type FROM \"user\" u INNER JOIN team t ON u.team_id = t.id WHERE u.id = $1 LIMIT 1",
	)
	.bind(&ctx.session.user_id)
	.fetch_optional(&mut *transaction)
	.await
	.map_err(|e| { tracing::error!(error = %e, "Failed to reload team actor"); internal_error("Failed to reload team actor") })?;
    let Some(actor) = actor else {
        return Err(forbidden_error("Only the team owner can delete the team"));
    };
    if actor.team_id != input.team_id || actor.role != "owner" || actor.team_type == "personal" {
        return Err(forbidden_error("Only the team owner can delete the team"));
    }

    let member_count =
        query_scalar::<_, i64>("SELECT COUNT(*)::bigint FROM \"user\" WHERE team_id = $1")
            .bind(&input.team_id)
            .fetch_one(&mut *transaction)
            .await
            .map_err(|e| {
                tracing::error!(error = %e, "Failed to count team members");
                internal_error("Failed to count team members")
            })?;
    if member_count != 1 {
        return Err(bad_request_error(
            "Team deletion is blocked until the owner is the only remaining member.",
        ));
    }

    let team_vault_count =
        query_scalar::<_, i64>("SELECT COUNT(*)::bigint FROM vault WHERE team_id = $1")
            .bind(&input.team_id)
            .fetch_one(&mut *transaction)
            .await
            .map_err(|e| {
                tracing::error!(error = %e, "Failed to count team vaults");
                internal_error("Failed to count team vaults")
            })?;
    if team_vault_count > 0 {
        return Err(bad_request_error(
            "Team deletion is blocked until all team vaults have been removed or converted.",
        ));
    }

    create_personal_team_for_user(&mut transaction, &ctx.session.user_id, &actor.user_name).await?;
    query("DELETE FROM team_invitation WHERE team_id = $1")
        .bind(&input.team_id)
        .execute(&mut *transaction)
        .await
        .map_err(|e| {
            tracing::error!(error = %e, "Failed to delete team invitations");
            internal_error("Failed to delete team invitations")
        })?;
    query("DELETE FROM team WHERE id = $1")
        .bind(&input.team_id)
        .execute(&mut *transaction)
        .await
        .map_err(|e| {
            tracing::error!(error = %e, "Failed to delete team");
            internal_error("Failed to delete team")
        })?;

    transaction.commit().await.map_err(|e| {
        tracing::error!(error = %e, "Failed to commit team deletion");
        internal_error("Failed to commit team deletion")
    })?;

    Ok(SuccessResponse { success: true })
}

#[allow(non_snake_case)]
#[handler(mutation)]
pub async fn leave(
    ctx: RefreshSessionContext,
    input: LeaveTeamInput,
) -> Result<SuccessResponse, TeamRpcError> {
    validate_rotation_vault_inputs(&input.vault_rotations)?;

    let pool = db_pool(&ctx.app_state)?;
    let actor = query_as::<_, DbDeleteTeamActorRow>(
		"SELECT u.id AS user_id, u.name AS user_name, u.team_id, u.role::text AS role, t.type::text AS team_type FROM \"user\" u INNER JOIN team t ON u.team_id = t.id WHERE u.id = $1 LIMIT 1",
	)
	.bind(&ctx.session.user_id)
	.fetch_optional(pool)
	.await
	.map_err(|e| { tracing::error!(error = %e, "Failed to load team membership"); internal_error("Failed to load team membership") })?
	.ok_or_else(|| forbidden_error("You are not a member of this team"))?;
    if actor.team_id != input.team_id {
        return Err(forbidden_error("You are not a member of this team"));
    }
    if actor.role == "owner" {
        return Err(bad_request_error(
            "The team owner cannot leave. Transfer ownership first.",
        ));
    }
    if actor.team_type == "personal" {
        return Err(bad_request_error("You cannot leave a personal team."));
    }
    let team_vaults =
        load_team_vaults_with_user_access(pool, &input.team_id, &ctx.session.user_id).await?;
    let accessible_vault_ids: HashSet<String> =
        team_vaults.iter().map(|vault| vault.id.clone()).collect();
    ensure_exact_rotation_vault_set(
        &accessible_vault_ids,
        &input.vault_rotations,
        "Vault rotation data must exactly match the accessible team vault set.",
    )?;
    let team_vault_map: HashMap<String, DbTeamRotationVaultRow> = team_vaults
        .into_iter()
        .map(|vault| (vault.id.clone(), vault))
        .collect();
    let rotation_records = create_rotation_records(
        pool,
        &input.vault_rotations,
        &team_vault_map,
        &ctx.session.user_id,
        &ctx.session.user_id,
    )
    .await?;
    let rotation_record_map: HashMap<String, TeamVaultRotationRecordInternal> = rotation_records
        .iter()
        .cloned()
        .map(|record| (record.vault_id.clone(), record))
        .collect();
    let member_actor = load_team_membership_actor(pool, &ctx.session.user_id)
        .await?
        .ok_or_else(|| forbidden_error("You are not a member of this team"))?;
    let billing_plan = member_actor
        .billing_plan
        .unwrap_or_else(|| "free".to_string());

    let result = async {
        let mut transaction = pool.begin().await.map_err(|e| {
            tracing::error!(error = %e, "Failed to start leave-team transaction");
            internal_error("Failed to start leave-team transaction")
        })?;
        apply_team_vault_rotations(
            &mut transaction,
            &input.vault_rotations,
            &rotation_record_map,
            &ctx.session.user_id,
            &ctx.session.user_id,
            input
                .client_id
                .as_deref()
                .or(ctx.request.client_id.as_deref()),
            "member_left",
        )
        .await?;
        create_personal_team_for_user(&mut transaction, &ctx.session.user_id, &actor.user_name)
            .await?;
        transaction.commit().await.map_err(|e| {
            tracing::error!(error = %e, "Failed to commit leave-team transaction");
            internal_error("Failed to commit leave-team transaction")
        })?;
        Ok::<(), TeamRpcError>(())
    }
    .await;

    if let Err(error) = result {
        mark_rotation_records_failed(pool, &rotation_records, &error.message).await?;
        return Err(internal_error(
            "Failed to leave team during key rotation. Please try again.",
        ));
    }

    let revoked_session_ids = load_user_session_ids(pool, &ctx.session.user_id)
        .await
        .map_err(|e| {
            tracing::error!(error = %e, "Failed to load sessions after leaving team");
            internal_error("Failed to load sessions after leaving team")
        })?;
    query("DELETE FROM session WHERE user_id = $1")
        .bind(&ctx.session.user_id)
        .execute(pool)
        .await
        .map_err(|e| {
            tracing::error!(error = %e, "Failed to revoke sessions after leaving team");
            internal_error("Failed to revoke sessions after leaving team")
        })?;
    record_session_revocations(
        pool,
        &ctx.session.user_id,
        &revoked_session_ids,
        "team_left",
    )
    .await
    .map_err(|e| {
        tracing::error!(error = %e, "Failed to record session revocations after leaving team");
        internal_error("Failed to record session revocations after leaving team")
    })?;
    insert_team_member_audit_log(
        pool,
        &ctx.session.user_id,
        "team_member_removed",
        json!({
            "teamId": input.team_id,
            "reason": "voluntary_leave",
            "vaultsRotated": rotation_records.len(),
        }),
    )
    .await?;
    sync_team_seats_best_effort(pool, &input.team_id, &billing_plan).await;

    Ok(SuccessResponse { success: true })
}

#[allow(non_snake_case)]
#[handler(query)]
pub async fn getLeaveRotationData(
    ctx: RefreshSessionContext,
    input: TeamIdInput,
) -> Result<RotationDataResponse, TeamRpcError> {
    let pool = db_pool(&ctx.app_state)?;
    let current_user = query_as::<_, DbTeamUserRow>(
        "SELECT id, email, team_id, role::text AS role FROM \"user\" WHERE id = $1 LIMIT 1",
    )
    .bind(&ctx.session.user_id)
    .fetch_optional(pool)
    .await
    .map_err(|e| {
        tracing::error!(error = %e, "Failed to load user");
        internal_error("Failed to load user")
    })?;
    if current_user
        .as_ref()
        .and_then(|user| user.team_id.as_deref())
        != Some(input.team_id.as_str())
    {
        return Err(forbidden_error("You are not a member of this team"));
    }

    let team_vaults =
        load_team_vaults_with_user_access(pool, &input.team_id, &ctx.session.user_id).await?;
    let rotation_vaults = load_rotation_vault_data(pool, team_vaults, &ctx.session.user_id).await?;

    Ok(RotationDataResponse {
        vaults: rotation_vaults,
    })
}

#[allow(non_snake_case)]
#[handler(mutation)]
pub async fn send(
    ctx: RefreshSessionContext,
    input: SendInvitationInput,
) -> Result<SendInvitationResponse, TeamRpcError> {
    let pool = db_pool(&ctx.app_state)?;
    let actor = load_team_membership_actor(pool, &ctx.session.user_id).await?;
    if actor
        .as_ref()
        .and_then(|value| value.team_id.as_ref())
        .map(|team_id| team_id != &input.team_id)
        .unwrap_or(true)
    {
        return Err(forbidden_error("You are not a member of this team"));
    }

    let actor = actor.ok_or_else(|| forbidden_error("You are not a member of this team"))?;
    ensure_team_admin(&actor.role)?;

    let team = query_as::<_, DbTeamInvitationSendTeamRow>(
		"SELECT id, member_limit, billing_plan::text AS billing_plan, billing_status::text AS billing_status FROM team WHERE id = $1 LIMIT 1",
	)
	.bind(&input.team_id)
	.fetch_optional(pool)
	.await
	.map_err(|e| { tracing::error!(error = %e, "Failed to load team"); internal_error("Failed to load team") })?
	.ok_or_else(|| not_found_error("Team not found"))?;
    assert_team_management_entitlement(&team.billing_plan, &team.billing_status)?;

    if let Some(member_limit) = team.member_limit {
        let current_members =
            query_scalar::<_, i64>("SELECT COUNT(*)::bigint FROM \"user\" WHERE team_id = $1")
                .bind(&input.team_id)
                .fetch_one(pool)
                .await
                .map_err(|e| {
                    tracing::error!(error = %e, "Failed to count team members");
                    internal_error("Failed to count team members")
                })?;
        let pending_invitations = query_scalar::<_, i64>(
			"SELECT COUNT(*)::bigint FROM team_invitation WHERE team_id = $1 AND status = 'pending'",
		)
		.bind(&input.team_id)
		.fetch_one(pool)
		.await
		.map_err(|e| { tracing::error!(error = %e, "Failed to count pending invitations"); internal_error("Failed to count pending invitations") })?;
        if current_members + pending_invitations >= i64::from(member_limit) {
            return Err(bad_request_error("Team has reached member limit"));
        }
    }

    let existing_user = query_as::<_, DbExistingInviteeRow>(
        "SELECT team_id, public_key FROM \"user\" WHERE email = $1 LIMIT 1",
    )
    .bind(&input.email)
    .fetch_optional(pool)
    .await
    .map_err(|e| {
        tracing::error!(error = %e, "Failed to load existing user");
        internal_error("Failed to load existing user")
    })?;
    if existing_user
        .as_ref()
        .and_then(|value| value.team_id.as_ref())
        .is_some()
    {
        return Err(bad_request_error("This user already belongs to a team"));
    }

    let has_pending_invitation = query_scalar::<_, bool>(
		"SELECT EXISTS(SELECT 1 FROM team_invitation WHERE team_id = $1 AND email = $2 AND status = 'pending')",
	)
	.bind(&input.team_id)
	.bind(&input.email)
	.fetch_one(pool)
	.await
	.map_err(|e| { tracing::error!(error = %e, "Failed to check pending invitations"); internal_error("Failed to check pending invitations") })?;
    if has_pending_invitation {
        return Err(bad_request_error(
            "An invitation is already pending for this email",
        ));
    }

    let pending_vault_keys = normalize_pending_vault_keys(input.pending_vault_keys)?;
    assert_invitation_pending_vault_keys_are_authorized(
        pool,
        &input.team_id,
        &ctx.session.user_id,
        &pending_vault_keys,
    )
    .await?;

    let invitation_id = generate_resource_id("team_invitation");
    let token = generate_secure_token();
    let expires_at = OffsetDateTime::now_utc() + time::Duration::days(7);
    let serialized_pending_vault_keys = if pending_vault_keys.is_empty() {
        None
    } else {
        Some(serde_json::to_string(&pending_vault_keys).map_err(|e| {
            tracing::error!(error = %e, "Failed to serialize pendingVaultKeys");
            internal_error("Failed to serialize pendingVaultKeys")
        })?)
    };

    query(
		"INSERT INTO team_invitation (id, team_id, email, role, invited_by_id, token, pending_vault_keys, expires_at) VALUES ($1, $2, $3, $4::team_role, $5, $6, $7, $8)",
	)
	.bind(&invitation_id)
	.bind(&input.team_id)
	.bind(&input.email)
	.bind(&input.role)
	.bind(&ctx.session.user_id)
	.bind(&token)
	.bind(serialized_pending_vault_keys)
	.bind(expires_at)
	.execute(pool)
	.await
	.map_err(|e| { tracing::error!(error = %e, "Failed to create invitation"); internal_error("Failed to create invitation") })?;

    Ok(SendInvitationResponse {
        invitation_id,
        token,
        existing_user_public_key: existing_user.and_then(|value| value.public_key),
    })
}

#[allow(non_snake_case)]
#[handler(mutation)]
pub async fn accept(
    ctx: RefreshSessionContext,
    input: TokenInput,
) -> Result<AcceptInvitationResponse, TeamRpcError> {
    validate_token(&input.token)?;

    let pool = db_pool(&ctx.app_state)?;
    let invitation = query_as::<_, DbTeamInvitationAcceptRow>(
		"SELECT ti.id, ti.team_id, t.name AS team_name, ti.email, ti.role::text AS role, ti.invited_by_id, ti.expires_at, t.billing_plan::text AS billing_plan, t.billing_status::text AS billing_status, ti.pending_vault_keys FROM team_invitation ti INNER JOIN team t ON ti.team_id = t.id WHERE ti.token = $1 AND ti.status = 'pending' LIMIT 1",
	)
	.bind(&input.token)
	.fetch_optional(pool)
	.await
	.map_err(|e| { tracing::error!(error = %e, "Failed to load invitation"); internal_error("Failed to load invitation") })?
	.ok_or_else(|| not_found_error("Invitation not found or already used"))?;

    if invitation.expires_at < OffsetDateTime::now_utc() {
        query("UPDATE team_invitation SET status = 'expired' WHERE id = $1")
            .bind(&invitation.id)
            .execute(pool)
            .await
            .map_err(|e| {
                tracing::error!(error = %e, "Failed to expire invitation");
                internal_error("Failed to expire invitation")
            })?;

        return Err(bad_request_error("Invitation has expired"));
    }

    assert_team_management_entitlement(&invitation.billing_plan, &invitation.billing_status)?;

    let current_user = query_as::<_, DbTeamUserRow>(
        "SELECT id, email, team_id, role::text AS role FROM \"user\" WHERE id = $1 LIMIT 1",
    )
    .bind(&ctx.session.user_id)
    .fetch_optional(pool)
    .await
    .map_err(|e| {
        tracing::error!(error = %e, "Failed to load user");
        internal_error("Failed to load user")
    })?
    .ok_or_else(|| not_found_error("User not found"))?;

    if current_user.email != invitation.email {
        return Err(forbidden_error("This invitation is not for you"));
    }

    if current_user.team_id.is_some() {
        return Err(bad_request_error("You already belong to a team"));
    }

    let pending_keys = parse_pending_vault_keys(invitation.pending_vault_keys.as_deref())?;
    assert_invitation_pending_vault_keys_are_authorized(
        pool,
        &invitation.team_id,
        &invitation.invited_by_id,
        &pending_keys,
    )
    .await?;

    let vault_role = if invitation.role == "admin" {
        "admin"
    } else {
        "member"
    };

    let mut transaction = pool.begin().await.map_err(|e| {
        tracing::error!(error = %e, "Failed to start transaction");
        internal_error("Failed to start transaction")
    })?;

    query("UPDATE \"user\" SET team_id = $1, role = $2::team_role WHERE id = $3")
        .bind(&invitation.team_id)
        .bind(&invitation.role)
        .bind(&ctx.session.user_id)
        .execute(&mut *transaction)
        .await
        .map_err(|e| {
            tracing::error!(error = %e, "Failed to update team membership");
            internal_error("Failed to update team membership")
        })?;

    for pending_key in pending_keys {
        let existing_key = query_scalar::<_, bool>(
            "SELECT EXISTS(SELECT 1 FROM vault_key WHERE vault_id = $1 AND user_id = $2)",
        )
        .bind(&pending_key.vault_id)
        .bind(&ctx.session.user_id)
        .fetch_one(&mut *transaction)
        .await
        .map_err(|e| {
            tracing::error!(error = %e, "Failed to load existing vault access");
            internal_error("Failed to load existing vault access")
        })?;

        if !existing_key {
            query(
				"INSERT INTO vault_key (id, vault_id, user_id, encrypted_vault_key, role) VALUES ($1, $2, $3, $4, $5::vault_role)",
			)
			.bind(generate_resource_id("vault_key"))
			.bind(&pending_key.vault_id)
			.bind(&ctx.session.user_id)
			.bind(&pending_key.encrypted_vault_key)
			.bind(vault_role)
			.execute(&mut *transaction)
			.await
			.map_err(|e| { tracing::error!(error = %e, "Failed to provision vault access"); internal_error("Failed to provision vault access") })?;
        }
    }

    query("UPDATE team_invitation SET status = 'accepted', accepted_at = $1 WHERE id = $2")
        .bind(OffsetDateTime::now_utc())
        .bind(&invitation.id)
        .execute(&mut *transaction)
        .await
        .map_err(|e| {
            tracing::error!(error = %e, "Failed to accept invitation");
            internal_error("Failed to accept invitation")
        })?;

    transaction.commit().await.map_err(|e| {
        tracing::error!(error = %e, "Failed to commit invitation acceptance");
        internal_error("Failed to commit invitation acceptance")
    })?;

    sync_team_seats_best_effort(pool, &invitation.team_id, &invitation.billing_plan).await;

    Ok(AcceptInvitationResponse {
        team_id: invitation.team_id,
        team_name: invitation.team_name,
    })
}

#[allow(non_snake_case)]
#[handler(mutation)]
pub async fn decline(
    ctx: RefreshSessionContext,
    input: TokenInput,
) -> Result<SuccessResponse, TeamRpcError> {
    validate_token(&input.token)?;

    let pool = db_pool(&ctx.app_state)?;
    let invitation = query_as::<_, DbTeamInvitationAcceptRow>(
		"SELECT ti.id, ti.team_id, t.name AS team_name, ti.email, ti.role::text AS role, ti.invited_by_id, ti.expires_at, t.billing_plan::text AS billing_plan, t.billing_status::text AS billing_status, ti.pending_vault_keys FROM team_invitation ti INNER JOIN team t ON ti.team_id = t.id WHERE ti.token = $1 AND ti.status = 'pending' LIMIT 1",
	)
	.bind(&input.token)
	.fetch_optional(pool)
	.await
	.map_err(|e| { tracing::error!(error = %e, "Failed to load invitation"); internal_error("Failed to load invitation") })?
	.ok_or_else(|| not_found_error("Invitation not found or already used"))?;

    let current_user = query_as::<_, DbTeamUserRow>(
        "SELECT id, email, team_id, role::text AS role FROM \"user\" WHERE id = $1 LIMIT 1",
    )
    .bind(&ctx.session.user_id)
    .fetch_optional(pool)
    .await
    .map_err(|e| {
        tracing::error!(error = %e, "Failed to load user");
        internal_error("Failed to load user")
    })?
    .ok_or_else(|| not_found_error("User not found"))?;

    if current_user.email != invitation.email {
        return Err(forbidden_error("This invitation is not for you"));
    }

    query("UPDATE team_invitation SET status = 'declined' WHERE id = $1")
        .bind(&invitation.id)
        .execute(pool)
        .await
        .map_err(|e| {
            tracing::error!(error = %e, "Failed to decline invitation");
            internal_error("Failed to decline invitation")
        })?;

    Ok(SuccessResponse { success: true })
}

#[allow(non_snake_case)]
#[handler(mutation)]
pub async fn cancel(
    ctx: RefreshSessionContext,
    input: InvitationIdInput,
) -> Result<SuccessResponse, TeamRpcError> {
    let pool = db_pool(&ctx.app_state)?;
    let invitation = query_as::<_, DbManageTeamInvitationRow>(
		"SELECT ti.id, ti.team_id, t.billing_plan::text AS billing_plan, t.billing_status::text AS billing_status FROM team_invitation ti INNER JOIN team t ON ti.team_id = t.id WHERE ti.id = $1 LIMIT 1",
	)
	.bind(&input.invitation_id)
	.fetch_optional(pool)
	.await
	.map_err(|e| { tracing::error!(error = %e, "Failed to load invitation"); internal_error("Failed to load invitation") })?
	.ok_or_else(|| not_found_error("Invitation not found"))?;

    let actor = load_team_membership_actor(pool, &ctx.session.user_id).await?;
    let is_admin_or_owner = actor
        .as_ref()
        .map(|value| {
            value.team_id.as_deref() == Some(invitation.team_id.as_str())
                && matches!(value.role.as_str(), "owner" | "admin")
        })
        .unwrap_or(false);
    if !is_admin_or_owner {
        return Err(forbidden_error("Insufficient permissions"));
    }

    assert_team_management_entitlement(&invitation.billing_plan, &invitation.billing_status)?;

    query("DELETE FROM team_invitation WHERE id = $1")
        .bind(&input.invitation_id)
        .execute(pool)
        .await
        .map_err(|e| {
            tracing::error!(error = %e, "Failed to cancel invitation");
            internal_error("Failed to cancel invitation")
        })?;

    Ok(SuccessResponse { success: true })
}

#[allow(non_snake_case)]
#[handler(mutation)]
pub async fn resend(
    ctx: RefreshSessionContext,
    input: InvitationIdInput,
) -> Result<SuccessResponse, TeamRpcError> {
    let pool = db_pool(&ctx.app_state)?;
    let invitation = query_as::<_, DbManageTeamInvitationRow>(
		"SELECT ti.id, ti.team_id, t.billing_plan::text AS billing_plan, t.billing_status::text AS billing_status FROM team_invitation ti INNER JOIN team t ON ti.team_id = t.id WHERE ti.id = $1 LIMIT 1",
	)
	.bind(&input.invitation_id)
	.fetch_optional(pool)
	.await
	.map_err(|e| { tracing::error!(error = %e, "Failed to load invitation"); internal_error("Failed to load invitation") })?
	.ok_or_else(|| not_found_error("Invitation not found"))?;

    let actor = load_team_membership_actor(pool, &ctx.session.user_id).await?;
    let is_admin_or_owner = actor
        .as_ref()
        .map(|value| {
            value.team_id.as_deref() == Some(invitation.team_id.as_str())
                && matches!(value.role.as_str(), "owner" | "admin")
        })
        .unwrap_or(false);
    if !is_admin_or_owner {
        return Err(forbidden_error("Insufficient permissions"));
    }

    assert_team_management_entitlement(&invitation.billing_plan, &invitation.billing_status)?;

    query("UPDATE team_invitation SET expires_at = $1, status = 'pending' WHERE id = $2")
        .bind(OffsetDateTime::now_utc() + time::Duration::days(7))
        .bind(&input.invitation_id)
        .execute(pool)
        .await
        .map_err(|e| {
            tracing::error!(error = %e, "Failed to resend invitation");
            internal_error("Failed to resend invitation")
        })?;

    Ok(SuccessResponse { success: true })
}

pub fn create_team_router() -> Router<AppState> {
    Router::new()
        .handler(list)
        .handler(get)
        .handler(vaults)
        .handler(create)
        .handler(update)
        .handler(createImageUpload)
        .handler(delete)
        .handler(leave)
        .handler(getLeaveRotationData)
        .nest("members", create_team_members_router())
        .nest("invitations", create_team_invitations_router())
}

fn create_team_invitations_router() -> Router<AppState> {
    Router::new()
        .handler(getByToken)
        .handler(invitation_handlers::list)
        .handler(pending)
        .handler(send)
        .handler(accept)
        .handler(cancel)
        .handler(resend)
        .handler(decline)
}

fn create_team_members_router() -> Router<AppState> {
    Router::new()
        .handler(member_handlers::list)
        .handler(member_handlers::getTeamRotationData)
        .handler(member_handlers::remove)
        .handler(member_handlers::deleteAccount)
}

mod member_handlers {
    use super::*;

    #[allow(non_snake_case)]
    #[handler(query)]
    pub async fn list(
        ctx: RefreshSessionContext,
        input: TeamIdInput,
    ) -> Result<Vec<TeamMemberResponse>, TeamRpcError> {
        let pool = db_pool(&ctx.app_state)?;
        let current_user = query_as::<_, DbTeamUserRow>(
            "SELECT id, email, team_id, role::text AS role FROM \"user\" WHERE id = $1 LIMIT 1",
        )
        .bind(&ctx.session.user_id)
        .fetch_optional(pool)
        .await
        .map_err(|e| {
            tracing::error!(error = %e, "Failed to load user");
            internal_error("Failed to load user")
        })?;
        if current_user
            .as_ref()
            .and_then(|user| user.team_id.as_deref())
            != Some(input.team_id.as_str())
        {
            return Err(forbidden_error("You are not a member of this team"));
        }

        let members = query_as::<_, DbTeamMemberRow>(
			"SELECT id AS user_id, name, email, role::text AS role, created_at AS joined_at FROM \"user\" WHERE team_id = $1 ORDER BY created_at ASC",
		)
		.bind(&input.team_id)
		.fetch_all(pool)
		.await
		.map_err(|e| { tracing::error!(error = %e, "Failed to load team members"); internal_error("Failed to load team members") })?;

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

    #[allow(non_snake_case)]
    #[handler(query)]
    pub async fn getTeamRotationData(
        ctx: RefreshSessionContext,
        input: TeamRotationInput,
    ) -> Result<RotationDataResponse, TeamRpcError> {
        let pool = db_pool(&ctx.app_state)?;
        let actor = load_team_membership_actor(pool, &ctx.session.user_id).await?;
        if actor.as_ref().and_then(|user| user.team_id.as_deref()) != Some(input.team_id.as_str()) {
            return Err(forbidden_error("You are not a member of this team"));
        }

        let actor = actor.ok_or_else(|| forbidden_error("You are not a member of this team"))?;
        if !matches!(actor.role.as_str(), "owner" | "admin") {
            return Err(forbidden_error(
                "Only owner or admin can perform key rotation",
            ));
        }
        assert_optional_team_management_entitlement(
            actor.billing_plan.as_deref(),
            actor.billing_status.as_deref(),
        )?;

        let removal_scope = load_team_removal_scope(
            pool,
            &input.team_id,
            &ctx.session.user_id,
            &input.exclude_user_id,
        )
        .await?;
        if !removal_scope.inaccessible_target_vault_ids.is_empty() {
            return Err(forbidden_error(
                "You cannot remove this member from only part of their team vault access.",
            ));
        }

        let rotation_vaults =
            load_rotation_vault_data(pool, removal_scope.removable_vaults, &input.exclude_user_id)
                .await?;
        Ok(RotationDataResponse {
            vaults: rotation_vaults,
        })
    }

    #[allow(non_snake_case)]
    #[handler(mutation)]
    pub async fn remove(
        ctx: RefreshSessionContext,
        input: RemoveTeamMemberInput,
    ) -> Result<RemoveTeamMemberResponse, TeamRpcError> {
        validate_rotation_vault_inputs(&input.vault_rotations)?;

        let pool = db_pool(&ctx.app_state)?;
        let actor = load_team_membership_actor(pool, &ctx.session.user_id).await?;
        if actor.as_ref().and_then(|user| user.team_id.as_deref()) != Some(input.team_id.as_str()) {
            return Err(forbidden_error("You are not a member of this team"));
        }
        let actor = actor.ok_or_else(|| forbidden_error("You are not a member of this team"))?;
        if !matches!(actor.role.as_str(), "owner" | "admin") {
            return Err(forbidden_error("Insufficient permissions"));
        }
        assert_optional_team_management_entitlement(
            actor.billing_plan.as_deref(),
            actor.billing_status.as_deref(),
        )?;
        if ctx.session.user_id == input.user_id {
            return Err(bad_request_error(
                "You cannot remove yourself from the team",
            ));
        }
        let target_user = query_as::<_, DbTeamUserRow>(
            "SELECT id, email, team_id, role::text AS role FROM \"user\" WHERE id = $1 LIMIT 1",
        )
        .bind(&input.user_id)
        .fetch_optional(pool)
        .await
        .map_err(|e| {
            tracing::error!(error = %e, "Failed to load target user");
            internal_error("Failed to load target user")
        })?
        .ok_or_else(|| not_found_error("Team member not found"))?;
        if target_user.team_id.as_deref() != Some(input.team_id.as_str()) {
            return Err(not_found_error("Team member not found"));
        }
        if target_user.role == "owner" {
            return Err(forbidden_error("The team owner cannot be removed"));
        }
        let target_user_name =
            query_scalar::<_, String>("SELECT name FROM \"user\" WHERE id = $1 LIMIT 1")
                .bind(&input.user_id)
                .fetch_optional(pool)
                .await
                .map_err(|e| {
                    tracing::error!(error = %e, "Failed to load target user name");
                    internal_error("Failed to load target user name")
                })?
                .ok_or_else(|| not_found_error("Team member not found"))?;
        let removal_scope =
            load_team_removal_scope(pool, &input.team_id, &ctx.session.user_id, &input.user_id)
                .await?;
        if !removal_scope.inaccessible_target_vault_ids.is_empty() {
            return Err(forbidden_error(
                "You cannot remove this member from only part of their team vault access.",
            ));
        }
        let expected_vault_ids: HashSet<String> = removal_scope
            .removable_vaults
            .iter()
            .map(|record| record.id.clone())
            .collect();
        ensure_exact_rotation_vault_set(
            &expected_vault_ids,
            &input.vault_rotations,
            "Vault rotation data must exactly match the removable team vault set.",
        )?;
        let vault_map: HashMap<String, DbTeamRotationVaultRow> = removal_scope
            .removable_vaults
            .into_iter()
            .map(|vault| (vault.id.clone(), vault))
            .collect();
        let rotation_records = create_rotation_records(
            pool,
            &input.vault_rotations,
            &vault_map,
            &ctx.session.user_id,
            &input.user_id,
        )
        .await?;
        let rotation_record_map: HashMap<String, TeamVaultRotationRecordInternal> =
            rotation_records
                .iter()
                .cloned()
                .map(|record| (record.vault_id.clone(), record))
                .collect();
        let billing_plan = actor.billing_plan.unwrap_or_else(|| "free".to_string());
        let result = async {
            let mut transaction = pool.begin().await.map_err(|e| {
                tracing::error!(error = %e, "Failed to start team member removal transaction");
                internal_error("Failed to start team member removal transaction")
            })?;
            apply_team_vault_rotations(
                &mut transaction,
                &input.vault_rotations,
                &rotation_record_map,
                &input.user_id,
                &ctx.session.user_id,
                input
                    .client_id
                    .as_deref()
                    .or(ctx.request.client_id.as_deref()),
                "team_member_removed",
            )
            .await?;
            create_personal_team_for_user(&mut transaction, &input.user_id, &target_user_name)
                .await?;
            transaction.commit().await.map_err(|e| {
                tracing::error!(error = %e, "Failed to commit team member removal");
                internal_error("Failed to commit team member removal")
            })?;
            Ok::<(), TeamRpcError>(())
        }
        .await;
        if let Err(error) = result {
            mark_rotation_records_failed(pool, &rotation_records, &error.message).await?;
            return Err(internal_error(
                "Team member removal failed during key rotation. Please try again.",
            ));
        }
        let revoked_session_ids =
            load_user_session_ids(pool, &input.user_id)
                .await
                .map_err(|e| {
                    tracing::error!(error = %e, "Failed to load removed user sessions");
                    internal_error("Failed to load removed user sessions")
                })?;
        query("DELETE FROM session WHERE user_id = $1")
            .bind(&input.user_id)
            .execute(pool)
            .await
            .map_err(|e| {
                tracing::error!(error = %e, "Failed to revoke removed user sessions");
                internal_error("Failed to revoke removed user sessions")
            })?;
        record_session_revocations(
            pool,
            &input.user_id,
            &revoked_session_ids,
            "team_member_removed",
        )
        .await
        .map_err(|e| {
            tracing::error!(error = %e, "Failed to record removed user session revocations");
            internal_error("Failed to record removed user session revocations")
        })?;
        insert_team_member_audit_log(
            pool,
            &ctx.session.user_id,
            "team_member_removed",
            json!({
                "teamId": input.team_id,
                "actorRole": actor.role,
                "vaultsRotated": rotation_records.len(),
                "removedUserId": input.user_id,
            }),
        )
        .await?;
        sync_team_seats_best_effort(pool, &input.team_id, &billing_plan).await;
        Ok(RemoveTeamMemberResponse {
            success: true,
            vault_rotations: rotation_records
                .into_iter()
                .map(|record| TeamVaultRotationResult {
                    vault_id: record.vault_id,
                    rotation_id: record.rotation_id,
                    new_key_version: record.new_key_version,
                })
                .collect(),
        })
    }

    #[allow(non_snake_case)]
    #[handler(mutation)]
    pub async fn deleteAccount(
        _ctx: RefreshSessionContext,
        input: DeleteAccountInput,
    ) -> Result<SuccessResponse, TeamRpcError> {
        if input.confirmation != "DELETE" {
            return Err(bad_request_error("Invalid params"));
        }

        Err(bad_request_error(
			"Account deletion by team admins is no longer supported. Use 'Remove member' instead. The removed user can delete their own account.",
		))
    }
}

mod invitation_handlers {
    use super::*;

    #[derive(Debug, Clone, Serialize, TS)]
    #[serde(rename_all = "camelCase")]
    pub struct TeamInvitationListEntry {
        pub id: String,
        pub email: String,
        pub role: String,
        pub status: String,
        pub invited_by: String,
        pub created_at: String,
        pub expires_at: String,
    }

    #[allow(non_snake_case)]
    #[handler(query)]
    pub async fn list(
        ctx: RefreshSessionContext,
        input: TeamIdInput,
    ) -> Result<Vec<TeamInvitationListEntry>, TeamRpcError> {
        let pool = db_pool(&ctx.app_state)?;
        let actor = load_team_membership_actor(pool, &ctx.session.user_id).await?;
        if actor
            .as_ref()
            .and_then(|value| value.team_id.as_ref())
            .map(|team_id| team_id != &input.team_id)
            .unwrap_or(true)
        {
            return Err(forbidden_error("You are not a member of this team"));
        }

        let actor = actor.ok_or_else(|| forbidden_error("You are not a member of this team"))?;
        ensure_team_admin(&actor.role)?;
        assert_optional_team_management_entitlement(
            actor.billing_plan.as_deref(),
            actor.billing_status.as_deref(),
        )?;

        let invitations = query_as::<_, DbTeamInvitationListRow>(
			"SELECT ti.id, ti.email, ti.role::text AS role, ti.status::text AS status, invited_by.name AS invited_by_name, ti.created_at, ti.expires_at FROM team_invitation ti INNER JOIN \"user\" invited_by ON ti.invited_by_id = invited_by.id WHERE ti.team_id = $1 AND ti.status = 'pending' ORDER BY ti.created_at DESC",
		)
		.bind(&input.team_id)
		.fetch_all(pool)
		.await
		.map_err(|e| { tracing::error!(error = %e, "Failed to load invitations"); internal_error("Failed to load invitations") })?;

        Ok(invitations
            .into_iter()
            .map(|invitation| TeamInvitationListEntry {
                id: invitation.id,
                email: invitation.email,
                role: invitation.role,
                status: invitation.status,
                invited_by: invitation.invited_by_name,
                created_at: format_timestamp(invitation.created_at),
                expires_at: format_timestamp(invitation.expires_at),
            })
            .collect())
    }
}

fn db_pool(app_state: &AppState) -> Result<&PgPool, TeamRpcError> {
    app_state
        .db_pool
        .as_ref()
        .ok_or_else(|| internal_error("Database is not configured"))
}

fn assert_team_management_entitlement(
    billing_plan: &str,
    billing_status: &str,
) -> Result<(), TeamRpcError> {
    if bittery_mode() == "self-hosted" {
        return Ok(());
    }

    let has_entitlement = matches!(billing_plan, "family" | "team")
        && matches!(billing_status, "active" | "trialing");
    if has_entitlement {
        Ok(())
    } else {
        Err(forbidden_error(TEAM_MANAGEMENT_UNAVAILABLE_MESSAGE))
    }
}

fn assert_optional_team_management_entitlement(
    billing_plan: Option<&str>,
    billing_status: Option<&str>,
) -> Result<(), TeamRpcError> {
    let plan = billing_plan.ok_or_else(|| not_found_error("Team not found"))?;
    let status = billing_status.ok_or_else(|| not_found_error("Team not found"))?;
    assert_team_management_entitlement(plan, status)
}

fn bittery_mode() -> &'static str {
    match std::env::var("BITTERY_MODE") {
        Ok(value) => {
            let normalized = value.trim().to_ascii_lowercase();
            if normalized == "self-hosted"
                || normalized == "self_hosted"
                || normalized == "selfhosted"
            {
                "self-hosted"
            } else {
                "cloud"
            }
        }
        Err(_) => "cloud",
    }
}

fn default_invitation_role() -> String {
    "member".to_string()
}

fn validate_token(token: &str) -> Result<(), TeamRpcError> {
    if token.len() != 32
        || !token.chars().all(|character| {
            character.is_ascii_alphanumeric() || character == '_' || character == '-'
        })
    {
        return Err(bad_request_error("Invalid token"));
    }

    Ok(())
}

fn validate_rotation_vault_inputs(
    vault_rotations: &[RotationVaultInput],
) -> Result<(), TeamRpcError> {
    if vault_rotations.len() > MAX_ROTATION_VAULTS {
        return Err(bad_request_error("Too many vault rotations provided."));
    }

    for vault_rotation in vault_rotations {
        if vault_rotation.key_rotation.member_keys.len() > MAX_ROTATION_MEMBER_KEYS {
            return Err(bad_request_error(
                "Too many member key rotations provided for a vault.",
            ));
        }
        if vault_rotation.key_rotation.re_encrypted_items.len() > MAX_ROTATION_REENCRYPTED_ITEMS {
            return Err(bad_request_error(
                "Too many re-encrypted items provided for a vault.",
            ));
        }
    }

    Ok(())
}

fn ensure_exact_rotation_vault_set(
    expected_vault_ids: &HashSet<String>,
    vault_rotations: &[RotationVaultInput],
    mismatch_message: &str,
) -> Result<(), TeamRpcError> {
    let provided_vault_ids: HashSet<String> = vault_rotations
        .iter()
        .map(|rotation| rotation.vault_id.clone())
        .collect();
    if provided_vault_ids.len() != vault_rotations.len() {
        return Err(bad_request_error(
            "Duplicate vault rotation entries are not allowed.",
        ));
    }
    let has_missing = expected_vault_ids
        .iter()
        .any(|vault_id| !provided_vault_ids.contains(vault_id));
    let has_extra = provided_vault_ids
        .iter()
        .any(|vault_id| !expected_vault_ids.contains(vault_id));
    if has_missing || has_extra {
        return Err(bad_request_error(mismatch_message));
    }

    Ok(())
}

fn normalize_pending_vault_keys(
    pending_vault_keys: Option<Vec<PendingVaultKeyEntry>>,
) -> Result<Vec<PendingVaultKeyEntry>, TeamRpcError> {
    let Some(entries) = pending_vault_keys else {
        return Ok(Vec::new());
    };
    if entries.is_empty() {
        return Ok(Vec::new());
    }

    let mut normalized = Vec::with_capacity(entries.len());
    let mut seen_vault_ids = HashSet::with_capacity(entries.len());
    for (index, entry) in entries.into_iter().enumerate() {
        let vault_id = entry.vault_id.trim().to_string();
        let encrypted_vault_key = entry.encrypted_vault_key.trim().to_string();
        if vault_id.is_empty() || encrypted_vault_key.is_empty() {
            return Err(bad_request_error(&format!(
                "Invalid pendingVaultKeys entry at index {index}",
            )));
        }

        if !seen_vault_ids.insert(vault_id.clone()) {
            return Err(bad_request_error(
                "Duplicate vault IDs are not allowed in pendingVaultKeys",
            ));
        }

        normalized.push(PendingVaultKeyEntry {
            vault_id,
            encrypted_vault_key,
        });
    }

    Ok(normalized)
}

fn parse_pending_vault_keys(
    raw_pending_vault_keys: Option<&str>,
) -> Result<Vec<PendingVaultKeyEntry>, TeamRpcError> {
    let Some(raw_value) = raw_pending_vault_keys else {
        return Ok(Vec::new());
    };
    if raw_value.trim().is_empty() {
        return Ok(Vec::new());
    }

    let parsed = serde_json::from_str::<Vec<PendingVaultKeyEntry>>(raw_value)
        .map_err(|_| bad_request_error("Invalid pendingVaultKeys payload"))?;
    normalize_pending_vault_keys(Some(parsed))
}

async fn assert_invitation_pending_vault_keys_are_authorized(
    pool: &PgPool,
    team_id: &str,
    inviter_id: &str,
    pending_vault_keys: &[PendingVaultKeyEntry],
) -> Result<(), TeamRpcError> {
    if pending_vault_keys.is_empty() {
        return Ok(());
    }

    let vault_ids: Vec<String> = pending_vault_keys
        .iter()
        .map(|entry| entry.vault_id.clone())
        .collect();
    let team_vault_count = query_scalar::<_, i64>(
        "SELECT COUNT(*)::bigint FROM vault WHERE team_id = $1 AND id = ANY($2)",
    )
    .bind(team_id)
    .bind(&vault_ids)
    .fetch_one(pool)
    .await
    .map_err(|e| {
        tracing::error!(error = %e, "Failed to validate pendingVaultKeys vaults");
        internal_error("Failed to validate pendingVaultKeys vaults")
    })?;
    if team_vault_count != vault_ids.len() as i64 {
        return Err(bad_request_error(
            "pendingVaultKeys contains vaults outside the invited team",
        ));
    }

    let authorized_vault_roles = query_as::<_, DbVaultRoleRow>(
		"SELECT vault_id, role::text AS role FROM vault_key WHERE user_id = $1 AND vault_id = ANY($2)",
	)
	.bind(inviter_id)
	.bind(&vault_ids)
	.fetch_all(pool)
	.await
	.map_err(|e| { tracing::error!(error = %e, "Failed to validate inviter vault access"); internal_error("Failed to validate inviter vault access") })?;

    let authorized_vault_ids: HashSet<String> = authorized_vault_roles
        .into_iter()
        .filter(|record| record.role == "owner" || record.role == "admin")
        .map(|record| record.vault_id)
        .collect();
    if authorized_vault_ids.len() != vault_ids.len() {
        return Err(forbidden_error(
            "You do not have permission to grant access for one or more vaults",
        ));
    }

    Ok(())
}

async fn load_team_membership_actor(
    pool: &PgPool,
    user_id: &str,
) -> Result<Option<DbTeamMembershipActorRow>, TeamRpcError> {
    query_as::<_, DbTeamMembershipActorRow>(
		"SELECT u.id, u.team_id, u.role::text AS role, t.billing_plan::text AS billing_plan, t.billing_status::text AS billing_status FROM \"user\" u LEFT JOIN team t ON u.team_id = t.id WHERE u.id = $1 LIMIT 1",
	)
	.bind(user_id)
	.fetch_optional(pool)
	.await
	.map_err(|_| internal_error("Failed to load team membership"))
}

async fn load_team_vaults_with_user_access(
    pool: &PgPool,
    team_id: &str,
    user_id: &str,
) -> Result<Vec<DbTeamRotationVaultRow>, TeamRpcError> {
    let team_vaults = query_as::<_, DbTeamRotationVaultRow>(
        "SELECT id, name, key_version FROM vault WHERE team_id = $1 ORDER BY created_at ASC",
    )
    .bind(team_id)
    .fetch_all(pool)
    .await
    .map_err(|e| {
        tracing::error!(error = %e, "Failed to load team vaults");
        internal_error("Failed to load team vaults")
    })?;
    if team_vaults.is_empty() {
        return Ok(Vec::new());
    }

    let team_vault_ids: Vec<String> = team_vaults.iter().map(|vault| vault.id.clone()).collect();
    let user_vault_keys = query_as::<_, DbVaultRoleRow>(
		"SELECT vault_id, role::text AS role FROM vault_key WHERE user_id = $1 AND vault_id = ANY($2)",
	)
	.bind(user_id)
	.bind(&team_vault_ids)
	.fetch_all(pool)
	.await
	.map_err(|e| { tracing::error!(error = %e, "Failed to load user vault access"); internal_error("Failed to load user vault access") })?;
    let accessible_vault_ids: HashSet<String> = user_vault_keys
        .into_iter()
        .map(|record| record.vault_id)
        .collect();

    Ok(team_vaults
        .into_iter()
        .filter(|vault| accessible_vault_ids.contains(&vault.id))
        .collect())
}

struct TeamRemovalScope {
    removable_vaults: Vec<DbTeamRotationVaultRow>,
    inaccessible_target_vault_ids: Vec<String>,
}

async fn load_team_removal_scope(
    pool: &PgPool,
    team_id: &str,
    actor_user_id: &str,
    target_user_id: &str,
) -> Result<TeamRemovalScope, TeamRpcError> {
    let team_vaults = query_as::<_, DbTeamRotationVaultRow>(
        "SELECT id, name, key_version FROM vault WHERE team_id = $1 ORDER BY created_at ASC",
    )
    .bind(team_id)
    .fetch_all(pool)
    .await
    .map_err(|e| {
        tracing::error!(error = %e, "Failed to load team vaults");
        internal_error("Failed to load team vaults")
    })?;
    if team_vaults.is_empty() {
        return Ok(TeamRemovalScope {
            removable_vaults: Vec::new(),
            inaccessible_target_vault_ids: Vec::new(),
        });
    }

    let team_vault_ids: Vec<String> = team_vaults.iter().map(|vault| vault.id.clone()).collect();
    let actor_vault_keys = query_as::<_, DbVaultRoleRow>(
		"SELECT vault_id, role::text AS role FROM vault_key WHERE user_id = $1 AND vault_id = ANY($2)",
	)
	.bind(actor_user_id)
	.bind(&team_vault_ids)
	.fetch_all(pool)
	.await
	.map_err(|e| { tracing::error!(error = %e, "Failed to load actor vault access"); internal_error("Failed to load actor vault access") })?;
    let target_vault_keys = query_as::<_, DbVaultRoleRow>(
		"SELECT vault_id, role::text AS role FROM vault_key WHERE user_id = $1 AND vault_id = ANY($2)",
	)
	.bind(target_user_id)
	.bind(&team_vault_ids)
	.fetch_all(pool)
	.await
	.map_err(|e| { tracing::error!(error = %e, "Failed to load target vault access"); internal_error("Failed to load target vault access") })?;

    let actor_admin_vault_ids: HashSet<String> = actor_vault_keys
        .into_iter()
        .filter(|record| matches!(record.role.as_str(), "owner" | "admin"))
        .map(|record| record.vault_id)
        .collect();
    let target_vault_ids: HashSet<String> = target_vault_keys
        .into_iter()
        .map(|record| record.vault_id)
        .collect();
    let inaccessible_target_vault_ids: Vec<String> = target_vault_ids
        .iter()
        .filter(|vault_id| !actor_admin_vault_ids.contains(*vault_id))
        .cloned()
        .collect();
    let removable_vaults = team_vaults
        .into_iter()
        .filter(|vault| {
            target_vault_ids.contains(&vault.id) && actor_admin_vault_ids.contains(&vault.id)
        })
        .collect();

    Ok(TeamRemovalScope {
        removable_vaults,
        inaccessible_target_vault_ids,
    })
}

async fn load_rotation_vault_data(
    pool: &PgPool,
    rotation_scope: Vec<DbTeamRotationVaultRow>,
    excluded_user_id: &str,
) -> Result<Vec<RotationVaultResponse>, TeamRpcError> {
    let mut rotation_vaults = Vec::with_capacity(rotation_scope.len());
    for vault in rotation_scope {
        let members = query_as::<_, DbRotationMemberRow>(
			"SELECT vk.user_id, u.public_key, vk.role::text AS role FROM vault_key vk INNER JOIN \"user\" u ON vk.user_id = u.id WHERE vk.vault_id = $1 AND vk.user_id != $2 ORDER BY vk.created_at ASC",
		)
		.bind(&vault.id)
		.bind(excluded_user_id)
		.fetch_all(pool)
		.await
		.map_err(|e| { tracing::error!(error = %e, "Failed to load rotation members"); internal_error("Failed to load rotation members") })?;
        let items = query_as::<_, DbRotationItemRow>(
			"SELECT id, encrypted_data, encryption_iv, encryption_algorithm FROM item WHERE vault_id = $1 ORDER BY created_at ASC",
		)
		.bind(&vault.id)
		.fetch_all(pool)
		.await
		.map_err(|e| { tracing::error!(error = %e, "Failed to load rotation items"); internal_error("Failed to load rotation items") })?;

        rotation_vaults.push(RotationVaultResponse {
            vault_id: vault.id,
            vault_name: vault.name,
            key_version: vault.key_version,
            members: members
                .into_iter()
                .map(|member| RotationMemberResponse {
                    user_id: member.user_id,
                    public_key: member.public_key,
                    role: member.role,
                })
                .collect(),
            items: items
                .into_iter()
                .map(|item| RotationItemResponse {
                    id: item.id,
                    encrypted_data: item.encrypted_data,
                    encryption_iv: item.encryption_iv,
                    encryption_algorithm: item.encryption_algorithm,
                })
                .collect(),
        });
    }

    Ok(rotation_vaults)
}

#[derive(Clone)]
struct TeamVaultRotationRecordInternal {
    vault_id: String,
    rotation_id: String,
    new_key_version: i32,
}

async fn create_rotation_records(
    pool: &PgPool,
    vault_rotations: &[RotationVaultInput],
    vault_map: &HashMap<String, DbTeamRotationVaultRow>,
    initiated_by_id: &str,
    removed_user_id: &str,
) -> Result<Vec<TeamVaultRotationRecordInternal>, TeamRpcError> {
    let mut records = Vec::new();
    for vault_rotation in vault_rotations {
        let Some(vault_data) = vault_map.get(&vault_rotation.vault_id) else {
            continue;
        };
        let rotation_id = generate_resource_id("rotation");
        let new_key_version = vault_data.key_version + 1;
        query(
			"INSERT INTO vault_key_rotation (id, vault_id, key_version, reason, initiated_by_id, removed_user_id, items_re_encrypted, members_updated, status, created_at) VALUES ($1, $2, $3, 'member_removed'::key_rotation_reason, $4, $5, $6, $7, 'in_progress', $8)",
		)
		.bind(&rotation_id)
		.bind(&vault_rotation.vault_id)
		.bind(new_key_version)
		.bind(initiated_by_id)
		.bind(removed_user_id)
		.bind(vault_rotation.key_rotation.re_encrypted_items.len() as i32)
		.bind(vault_rotation.key_rotation.member_keys.len() as i32)
		.bind(OffsetDateTime::now_utc())
		.execute(pool)
		.await
		.map_err(|e| { tracing::error!(error = %e, "Failed to create vault key rotation"); internal_error("Failed to create vault key rotation") })?;
        records.push(TeamVaultRotationRecordInternal {
            vault_id: vault_rotation.vault_id.clone(),
            rotation_id,
            new_key_version,
        });
    }
    Ok(records)
}

async fn mark_rotation_records_failed(
    pool: &PgPool,
    records: &[TeamVaultRotationRecordInternal],
    error_message: &str,
) -> Result<(), TeamRpcError> {
    for record in records {
        query("UPDATE vault_key_rotation SET status = 'failed', error_message = $1 WHERE id = $2")
            .bind(error_message)
            .bind(&record.rotation_id)
            .execute(pool)
            .await
            .map_err(|e| {
                tracing::error!(error = %e, "Failed to mark rotation as failed");
                internal_error("Failed to mark rotation as failed")
            })?;
    }
    Ok(())
}

async fn apply_team_vault_rotations(
    transaction: &mut Transaction<'_, Postgres>,
    vault_rotations: &[RotationVaultInput],
    rotation_record_map: &HashMap<String, TeamVaultRotationRecordInternal>,
    removed_user_id: &str,
    actor_user_id: &str,
    client_id: Option<&str>,
    removal_reason: &str,
) -> Result<(), TeamRpcError> {
    for vault_rotation in vault_rotations {
        let Some(record) = rotation_record_map.get(&vault_rotation.vault_id) else {
            continue;
        };
        let deleted_rows = query("DELETE FROM vault_key WHERE vault_id = $1 AND user_id = $2")
            .bind(&vault_rotation.vault_id)
            .bind(removed_user_id)
            .execute(&mut **transaction)
            .await
            .map_err(|e| {
                tracing::error!(error = %e, "Failed to remove rotated vault access");
                internal_error("Failed to remove rotated vault access")
            })?
            .rows_affected();
        if deleted_rows == 0 {
            return Err(not_found_error("Vault key not found during rotation"));
        }
        for member_key in &vault_rotation.key_rotation.member_keys {
            let updated_rows = query(
				"UPDATE vault_key SET encrypted_vault_key = $1 WHERE vault_id = $2 AND user_id = $3",
			)
			.bind(&member_key.encrypted_vault_key)
			.bind(&vault_rotation.vault_id)
			.bind(&member_key.user_id)
			.execute(&mut **transaction)
			.await
			.map_err(|e| { tracing::error!(error = %e, "Failed to update rotated vault key"); internal_error("Failed to update rotated vault key") })?
			.rows_affected();
            if updated_rows == 0 {
                return Err(not_found_error("Member key not found during rotation"));
            }
        }
        for item in &vault_rotation.key_rotation.re_encrypted_items {
            let updated_rows = query(
				"UPDATE item SET encrypted_data = $1, encryption_iv = $2, updated_at = $3 WHERE id = $4 AND vault_id = $5",
			)
			.bind(&item.encrypted_data)
			.bind(&item.encryption_iv)
			.bind(OffsetDateTime::now_utc())
			.bind(&item.item_id)
			.bind(&vault_rotation.vault_id)
			.execute(&mut **transaction)
			.await
			.map_err(|e| { tracing::error!(error = %e, "Failed to update rotated item"); internal_error("Failed to update rotated item") })?
			.rows_affected();
            if updated_rows == 0 {
                return Err(not_found_error("Item not found during rotation"));
            }
        }
        query("UPDATE vault SET key_version = $1, updated_at = $2 WHERE id = $3")
            .bind(record.new_key_version)
            .bind(OffsetDateTime::now_utc())
            .bind(&vault_rotation.vault_id)
            .execute(&mut **transaction)
            .await
            .map_err(|e| {
                tracing::error!(error = %e, "Failed to update vault key version");
                internal_error("Failed to update vault key version")
            })?;
        query(
            "UPDATE vault_key_rotation SET status = 'completed', completed_at = $1 WHERE id = $2",
        )
        .bind(OffsetDateTime::now_utc())
        .bind(&record.rotation_id)
        .execute(&mut **transaction)
        .await
        .map_err(|e| {
            tracing::error!(error = %e, "Failed to finalize vault key rotation");
            internal_error("Failed to finalize vault key rotation")
        })?;
        insert_team_vault_access_revoked_sync_event(
            transaction,
            &vault_rotation.vault_id,
            removed_user_id,
            client_id,
            record.new_key_version,
            serde_json::json!({ "removedUserId": removed_user_id, "reason": removal_reason }),
        )
        .await?;
        insert_team_vault_member_removed_sync_event(
            transaction,
            removed_user_id,
            &vault_rotation.vault_id,
            actor_user_id,
            client_id,
            record.new_key_version,
            serde_json::json!({ "removedUserId": removed_user_id, "reason": removal_reason }),
        )
        .await?;
        insert_team_vault_key_rotated_sync_event(
            transaction,
            &vault_rotation.vault_id,
            actor_user_id,
            client_id,
            record.new_key_version,
            serde_json::json!({ "reason": removal_reason, "keyRotationId": record.rotation_id }),
        )
        .await?;
    }
    Ok(())
}

async fn insert_team_vault_access_revoked_sync_event(
    transaction: &mut Transaction<'_, Postgres>,
    vault_id: &str,
    user_id: &str,
    client_id: Option<&str>,
    version: i32,
    metadata: serde_json::Value,
) -> Result<(), TeamRpcError> {
    query(
		"INSERT INTO sync_event (id, event_type, entity_id, entity_type, vault_id, user_id, version, client_id, metadata, created_at) VALUES ($1, 'vault_access_revoked'::sync_event_type, $2, 'vault'::sync_entity_type, $3, $4, $5, $6, $7, $8)",
	)
	.bind(generate_resource_id("sync"))
	.bind(vault_id)
	.bind(vault_id)
	.bind(user_id)
	.bind(version)
	.bind(client_id)
	.bind(metadata.to_string())
	.bind(OffsetDateTime::now_utc())
	.execute(&mut **transaction)
	.await
	.map_err(|e| { tracing::error!(error = %e, "Failed to insert vault access revoked sync event"); internal_error("Failed to insert vault access revoked sync event") })?;
    Ok(())
}

async fn insert_team_vault_member_removed_sync_event(
    transaction: &mut Transaction<'_, Postgres>,
    entity_id: &str,
    vault_id: &str,
    user_id: &str,
    client_id: Option<&str>,
    version: i32,
    metadata: serde_json::Value,
) -> Result<(), TeamRpcError> {
    query(
		"INSERT INTO sync_event (id, event_type, entity_id, entity_type, vault_id, user_id, version, client_id, metadata, created_at) VALUES ($1, 'vault_member_removed'::sync_event_type, $2, 'vault_member'::sync_entity_type, $3, $4, $5, $6, $7, $8)",
	)
	.bind(generate_resource_id("sync"))
	.bind(entity_id)
	.bind(vault_id)
	.bind(user_id)
	.bind(version)
	.bind(client_id)
	.bind(metadata.to_string())
	.bind(OffsetDateTime::now_utc())
	.execute(&mut **transaction)
	.await
	.map_err(|e| { tracing::error!(error = %e, "Failed to insert vault member removed sync event"); internal_error("Failed to insert vault member removed sync event") })?;
    Ok(())
}

async fn insert_team_vault_key_rotated_sync_event(
    transaction: &mut Transaction<'_, Postgres>,
    vault_id: &str,
    user_id: &str,
    client_id: Option<&str>,
    version: i32,
    metadata: serde_json::Value,
) -> Result<(), TeamRpcError> {
    query(
		"INSERT INTO sync_event (id, event_type, entity_id, entity_type, vault_id, user_id, version, client_id, metadata, created_at) VALUES ($1, 'vault_key_rotated'::sync_event_type, $2, 'vault_key'::sync_entity_type, $3, $4, $5, $6, $7, $8)",
	)
	.bind(generate_resource_id("sync"))
	.bind(vault_id)
	.bind(vault_id)
	.bind(user_id)
	.bind(version)
	.bind(client_id)
	.bind(metadata.to_string())
	.bind(OffsetDateTime::now_utc())
	.execute(&mut **transaction)
	.await
	.map_err(|e| { tracing::error!(error = %e, "Failed to insert vault key rotated sync event"); internal_error("Failed to insert vault key rotated sync event") })?;
    Ok(())
}

async fn insert_team_member_audit_log(
    pool: &PgPool,
    user_id: &str,
    action: &str,
    metadata: serde_json::Value,
) -> Result<(), TeamRpcError> {
    let query_text = format!(
		"INSERT INTO audit_log (id, user_id, action, entity_type, entity_id, metadata, created_at) VALUES ($1, $2, '{action}', 'user', $3, $4, $5)"
	);
    query(&query_text)
        .bind(generate_resource_id("audit"))
        .bind(user_id)
        .bind(user_id)
        .bind(metadata)
        .bind(OffsetDateTime::now_utc())
        .execute(pool)
        .await
        .map_err(|e| {
            tracing::error!(error = %e, "Failed to record team member audit event");
            internal_error("Failed to record team member audit event")
        })?;
    Ok(())
}

async fn create_personal_team_for_user(
    transaction: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    user_id: &str,
    user_name: &str,
) -> Result<String, TeamRpcError> {
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
	.map_err(|e| { tracing::error!(error = %e, "Failed to create personal team"); internal_error("Failed to create personal team") })?;
    query("UPDATE \"user\" SET team_id = $1, role = 'owner' WHERE id = $2")
        .bind(&team_id)
        .bind(user_id)
        .execute(&mut **transaction)
        .await
        .map_err(|e| {
            tracing::error!(error = %e, "Failed to reassign team owner");
            internal_error("Failed to reassign team owner")
        })?;

    Ok(team_id)
}

fn ensure_team_admin(role: &str) -> Result<(), TeamRpcError> {
    if matches!(role, "owner" | "admin") {
        Ok(())
    } else {
        Err(forbidden_error("Insufficient permissions"))
    }
}

fn format_timestamp(value: OffsetDateTime) -> String {
    value
        .format(&time::format_description::well_known::Rfc3339)
        .unwrap_or_else(|_| value.unix_timestamp().to_string())
}

fn generate_resource_id(prefix: &str) -> String {
    format!("{prefix}_{:016x}", random::<u64>())
}

fn generate_secure_token() -> String {
    const ALPHABET: &[u8] = b"0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
    let mut rng = rand::thread_rng();
    (0..32)
        .map(|_| {
            let index = rand::Rng::gen_range(&mut rng, 0..ALPHABET.len());
            ALPHABET[index] as char
        })
        .collect()
}

fn forbidden_error(message: &str) -> TeamRpcError {
    TeamRpcError {
        code: "FORBIDDEN".to_string(),
        message: message.to_string(),
    }
}

fn bad_request_error(message: &str) -> TeamRpcError {
    TeamRpcError {
        code: "BAD_REQUEST".to_string(),
        message: message.to_string(),
    }
}

fn not_found_error(message: &str) -> TeamRpcError {
    TeamRpcError {
        code: "NOT_FOUND".to_string(),
        message: message.to_string(),
    }
}

fn internal_error(message: &str) -> TeamRpcError {
    TeamRpcError {
        code: "INTERNAL_SERVER_ERROR".to_string(),
        message: message.to_string(),
    }
}

impl From<TeamRpcError> for RpcError {
    fn from(value: TeamRpcError) -> Self {
        let code = match value.code.as_str() {
            "NOT_FOUND" => ErrorCode::ServerError(404),
            "FORBIDDEN" => ErrorCode::ServerError(403),
            "BAD_REQUEST" => ErrorCode::InvalidParams,
            _ => ErrorCode::InternalError,
        };

        RpcError {
            code,
            message: value.message,
            data: None,
        }
    }
}

impl IntoResponse for TeamRpcError {
    type Output = <RpcError as IntoResponse>::Output;

    fn into_response(self) -> jsonrpsee::ResponsePayload<'static, Self::Output> {
        RpcError::from(self).into_response()
    }
}

#[cfg(test)]
mod tests {
    use super::{
        assert_optional_team_management_entitlement, assert_team_management_entitlement,
        bittery_mode, ensure_exact_rotation_vault_set, ensure_team_admin, generate_secure_token,
        normalize_pending_vault_keys, parse_pending_vault_keys, validate_rotation_vault_inputs,
        validate_token, PendingVaultKeyEntry, RotationMemberKeyInput, RotationReEncryptedItemInput,
        RotationVaultInput, VaultKeyRotationInput, TEAM_MANAGEMENT_UNAVAILABLE_MESSAGE,
    };
    use crate::session_control::load_session_revocation;
    use crate::test_support::{
        acquire_env_lock, assign_user_to_team, authenticated_json_headers, seed_item, seed_team,
        seed_user, seed_vault, seed_vault_key, with_rpc_test_app,
    };
    use axum::http::{header::CONTENT_TYPE, HeaderMap, HeaderValue, StatusCode};
    use serde_json::{json, Value};
    use sqlx::{query, query_scalar, PgPool};
    use std::{collections::HashSet, future::Future};
    use time::{Duration, OffsetDateTime};

    fn set_env_var(key: &str, value: Option<&str>) {
        match value {
            Some(value) => unsafe { std::env::set_var(key, value) },
            None => unsafe { std::env::remove_var(key) },
        }
    }

    fn restore_env_var(key: &str, value: Option<String>) {
        match value {
            Some(value) => unsafe { std::env::set_var(key, value) },
            None => unsafe { std::env::remove_var(key) },
        }
    }

    fn with_bittery_mode<T>(value: Option<&str>, test_fn: impl FnOnce() -> T) -> T {
        let _guard = acquire_env_lock();
        let previous = std::env::var("BITTERY_MODE").ok();

        set_env_var("BITTERY_MODE", value);

        let result = test_fn();

        restore_env_var("BITTERY_MODE", previous);

        result
    }

    async fn with_bittery_mode_async<T, F>(value: Option<&str>, future: F) -> T
    where
        F: Future<Output = T>,
    {
        let _guard = acquire_env_lock();
        let previous = std::env::var("BITTERY_MODE").ok();
        set_env_var("BITTERY_MODE", value);
        let result = future.await;
        restore_env_var("BITTERY_MODE", previous);
        result
    }

    async fn with_storage_env_async<T, F>(future: F) -> T
    where
        F: Future<Output = T>,
    {
        let _guard = acquire_env_lock();
        let previous_endpoint = std::env::var("BITTERY_STORAGE_ENDPOINT").ok();
        let previous_bucket = std::env::var("BITTERY_STORAGE_BUCKET").ok();
        let previous_access_key = std::env::var("BITTERY_STORAGE_ACCESS_KEY_ID").ok();
        let previous_secret_key = std::env::var("BITTERY_STORAGE_SECRET_ACCESS_KEY").ok();
        let previous_region = std::env::var("BITTERY_STORAGE_REGION").ok();
        let previous_public_url = std::env::var("BITTERY_STORAGE_PUBLIC_URL").ok();
        let previous_cdn_url = std::env::var("BITTERY_STORAGE_CDN_URL").ok();

        set_env_var(
            "BITTERY_STORAGE_ENDPOINT",
            Some("https://storage.example.invalid"),
        );
        set_env_var("BITTERY_STORAGE_BUCKET", Some("bittery-test"));
        set_env_var("BITTERY_STORAGE_ACCESS_KEY_ID", Some("test-access-key"));
        set_env_var("BITTERY_STORAGE_SECRET_ACCESS_KEY", Some("test-secret-key"));
        set_env_var("BITTERY_STORAGE_REGION", Some("auto"));
        set_env_var(
            "BITTERY_STORAGE_PUBLIC_URL",
            Some("https://cdn.example.invalid/public"),
        );
        set_env_var(
            "BITTERY_STORAGE_CDN_URL",
            Some("https://cdn.example.invalid/assets"),
        );

        let result = future.await;

        restore_env_var("BITTERY_STORAGE_ENDPOINT", previous_endpoint);
        restore_env_var("BITTERY_STORAGE_BUCKET", previous_bucket);
        restore_env_var("BITTERY_STORAGE_ACCESS_KEY_ID", previous_access_key);
        restore_env_var("BITTERY_STORAGE_SECRET_ACCESS_KEY", previous_secret_key);
        restore_env_var("BITTERY_STORAGE_REGION", previous_region);
        restore_env_var("BITTERY_STORAGE_PUBLIC_URL", previous_public_url);
        restore_env_var("BITTERY_STORAGE_CDN_URL", previous_cdn_url);

        result
    }

    fn unauthenticated_json_headers() -> HeaderMap {
        let mut headers = HeaderMap::new();
        headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
        headers.insert("x-app-platform", HeaderValue::from_static("desktop"));
        headers.insert("x-client-id", HeaderValue::from_static("integration-test"));
        headers
    }

    fn assert_rpc_error(body: &Value, code: &str, message: &str) {
        assert_eq!(body["jsonrpc"], json!("2.0"));
        assert_eq!(body["error"]["message"], json!(message));
        assert_eq!(body["error"]["data"]["code"], json!(code));
    }

    fn assert_handler_error(body: &Value, code: &str, message: &str) {
        assert_eq!(body["jsonrpc"], json!("2.0"));
        assert_eq!(body["result"]["Err"]["code"], json!(code));
        assert_eq!(body["result"]["Err"]["message"], json!(message));
    }

    fn assert_invalid_params_error(body: &Value) {
        assert_eq!(body["jsonrpc"], json!("2.0"));
        assert!(
            body["error"].is_object(),
            "unexpected invalid params body: {body}"
        );
        let message = body["error"]["message"]
            .as_str()
            .unwrap_or_default()
            .to_ascii_lowercase();
        assert!(
            message.contains("invalid params"),
            "unexpected invalid params body: {body}"
        );
    }

    struct TeamRouterFixture {
        owner_user_id: String,
        admin_user_id: String,
        member_user_id: String,
        remove_target_user_id: String,
        no_team_user_id: String,
        outsider_user_id: String,
        team_id: String,
        outsider_team_id: String,
        invitee_user_id: String,
        accept_user_id: String,
        decline_user_id: String,
        accessible_vault_id: String,
        hidden_vault_id: String,
        admin_inaccessible_vault_id: String,
        accessible_item_id: String,
        admin_inaccessible_item_id: String,
    }

    async fn build_team_router_fixture(pool: &PgPool) -> TeamRouterFixture {
        let owner_user_id = "team_owner_user".to_string();
        let admin_user_id = "team_admin_user".to_string();
        let member_user_id = "team_member_user".to_string();
        let remove_target_user_id = "team_remove_target_user".to_string();
        let no_team_user_id = "team_no_team_user".to_string();
        let outsider_user_id = "team_outsider_user".to_string();
        let invitee_user_id = "team_invitee_user".to_string();
        let accept_user_id = "team_accept_user".to_string();
        let decline_user_id = "team_decline_user".to_string();
        let team_id = "team_router_main".to_string();
        let outsider_team_id = "team_router_other".to_string();
        let accessible_vault_id = "team_router_accessible_vault".to_string();
        let hidden_vault_id = "team_router_hidden_vault".to_string();
        let admin_inaccessible_vault_id = "team_router_admin_hidden_vault".to_string();
        let accessible_item_id = "team_router_accessible_item".to_string();
        let admin_inaccessible_item_id = "team_router_admin_hidden_item".to_string();

        seed_user(pool, &owner_user_id, "Team Owner", "team-owner@example.com").await;
        seed_user(pool, &admin_user_id, "Team Admin", "team-admin@example.com").await;
        seed_user(
            pool,
            &member_user_id,
            "Team Member",
            "team-member@example.com",
        )
        .await;
        seed_user(
            pool,
            &remove_target_user_id,
            "Remove Target",
            "team-remove-target@example.com",
        )
        .await;
        seed_user(pool, &no_team_user_id, "No Team", "team-none@example.com").await;
        seed_user(
            pool,
            &outsider_user_id,
            "Outsider",
            "team-outsider@example.com",
        )
        .await;
        seed_user(
            pool,
            &invitee_user_id,
            "Invitee",
            "team-invitee@example.com",
        )
        .await;
        seed_user(
            pool,
            &accept_user_id,
            "Accept User",
            "team-accept@example.com",
        )
        .await;
        seed_user(
            pool,
            &decline_user_id,
            "Decline User",
            "team-decline@example.com",
        )
        .await;

        seed_team(
            pool,
            &team_id,
            "Router Team",
            &owner_user_id,
            "organization",
            "team",
            "active",
        )
        .await;
        assign_user_to_team(pool, &owner_user_id, &team_id, "owner").await;
        assign_user_to_team(pool, &admin_user_id, &team_id, "admin").await;
        assign_user_to_team(pool, &member_user_id, &team_id, "member").await;
        assign_user_to_team(pool, &remove_target_user_id, &team_id, "member").await;

        seed_team(
            pool,
            &outsider_team_id,
            "Other Team",
            &outsider_user_id,
            "organization",
            "team",
            "active",
        )
        .await;
        assign_user_to_team(pool, &outsider_user_id, &outsider_team_id, "owner").await;

        seed_vault(
            pool,
            &accessible_vault_id,
            "Accessible Vault",
            "personal",
            &owner_user_id,
            Some(&team_id),
        )
        .await;
        seed_vault(
            pool,
            &hidden_vault_id,
            "Hidden Vault",
            "personal",
            &owner_user_id,
            Some(&team_id),
        )
        .await;
        seed_vault(
            pool,
            &admin_inaccessible_vault_id,
            "Admin Inaccessible Vault",
            "personal",
            &owner_user_id,
            Some(&team_id),
        )
        .await;

        seed_vault_key(
            pool,
            "team_router_accessible_owner_key",
            &accessible_vault_id,
            &owner_user_id,
            "owner-accessible-key",
            "owner",
        )
        .await;
        seed_vault_key(
            pool,
            "team_router_accessible_admin_key",
            &accessible_vault_id,
            &admin_user_id,
            "admin-accessible-key",
            "admin",
        )
        .await;
        seed_vault_key(
            pool,
            "team_router_accessible_member_key",
            &accessible_vault_id,
            &member_user_id,
            "member-accessible-key",
            "member",
        )
        .await;
        seed_vault_key(
            pool,
            "team_router_accessible_target_key",
            &accessible_vault_id,
            &remove_target_user_id,
            "target-accessible-key",
            "member",
        )
        .await;
        seed_vault_key(
            pool,
            "team_router_hidden_owner_key",
            &hidden_vault_id,
            &owner_user_id,
            "owner-hidden-key",
            "owner",
        )
        .await;
        seed_vault_key(
            pool,
            "team_router_admin_hidden_owner_key",
            &admin_inaccessible_vault_id,
            &owner_user_id,
            "owner-admin-hidden-key",
            "owner",
        )
        .await;
        seed_vault_key(
            pool,
            "team_router_admin_hidden_target_key",
            &admin_inaccessible_vault_id,
            &remove_target_user_id,
            "target-admin-hidden-key",
            "member",
        )
        .await;

        seed_item(
            pool,
            &accessible_item_id,
            &accessible_vault_id,
            "login",
            "accessible-ciphertext",
            "accessible-iv",
            &owner_user_id,
        )
        .await;
        seed_item(
            pool,
            &admin_inaccessible_item_id,
            &admin_inaccessible_vault_id,
            "login",
            "admin-hidden-ciphertext",
            "admin-hidden-iv",
            &owner_user_id,
        )
        .await;

        TeamRouterFixture {
            owner_user_id,
            admin_user_id,
            member_user_id,
            remove_target_user_id,
            no_team_user_id,
            outsider_user_id,
            team_id,
            outsider_team_id,
            invitee_user_id,
            accept_user_id,
            decline_user_id,
            accessible_vault_id,
            hidden_vault_id,
            admin_inaccessible_vault_id,
            accessible_item_id,
            admin_inaccessible_item_id,
        }
    }

    async fn seed_team_invitation(
        pool: &PgPool,
        invitation_id: &str,
        team_id: &str,
        email: &str,
        role: &str,
        invited_by_id: &str,
        token: &str,
        pending_vault_keys: Option<&str>,
        expires_at: OffsetDateTime,
    ) {
        query(
			"INSERT INTO team_invitation (id, team_id, email, role, invited_by_id, token, pending_vault_keys, expires_at) VALUES ($1, $2, $3, $4::team_role, $5, $6, $7, $8)",
		)
		.bind(invitation_id)
		.bind(team_id)
		.bind(email)
		.bind(role)
		.bind(invited_by_id)
		.bind(token)
		.bind(pending_vault_keys)
		.bind(expires_at)
		.execute(pool)
		.await
		.expect("team invitation should seed");
    }

    #[test]
    fn bittery_mode_normalizes_self_hosted_aliases_and_defaults_to_cloud() {
        with_bittery_mode(None, || {
            assert_eq!(bittery_mode(), "cloud");
        });
        with_bittery_mode(Some("self-hosted"), || {
            assert_eq!(bittery_mode(), "self-hosted");
        });
        with_bittery_mode(Some("SELF_HOSTED"), || {
            assert_eq!(bittery_mode(), "self-hosted");
        });
        with_bittery_mode(Some("selfhosted"), || {
            assert_eq!(bittery_mode(), "self-hosted");
        });
        with_bittery_mode(Some("cloud"), || {
            assert_eq!(bittery_mode(), "cloud");
        });
    }

    #[test]
    fn assert_team_management_entitlement_respects_mode_and_billing() {
        with_bittery_mode(Some("self_hosted"), || {
            assert!(assert_team_management_entitlement("free", "none").is_ok());
        });

        with_bittery_mode(Some("cloud"), || {
            assert!(assert_team_management_entitlement("team", "active").is_ok());
            assert!(assert_team_management_entitlement("family", "trialing").is_ok());

            let error = assert_team_management_entitlement("free", "none").unwrap_err();
            assert_eq!(error.code, "FORBIDDEN");
            assert_eq!(error.message, TEAM_MANAGEMENT_UNAVAILABLE_MESSAGE);
        });
    }

    #[test]
    fn assert_optional_team_management_entitlement_requires_team_billing_fields() {
        let missing_plan =
            assert_optional_team_management_entitlement(None, Some("active")).unwrap_err();
        assert_eq!(missing_plan.code, "NOT_FOUND");
        assert_eq!(missing_plan.message, "Team not found");

        let missing_status =
            assert_optional_team_management_entitlement(Some("team"), None).unwrap_err();
        assert_eq!(missing_status.code, "NOT_FOUND");
        assert_eq!(missing_status.message, "Team not found");
    }

    #[test]
    fn validate_token_rejects_invalid_input() {
        let error = validate_token("not-a-valid-token").unwrap_err();
        assert_eq!(error.code, "BAD_REQUEST");
        assert_eq!(error.message, "Invalid token");
    }

    #[test]
    fn parse_pending_vault_keys_rejects_invalid_payload() {
        let error = parse_pending_vault_keys(Some("{not-json}")).unwrap_err();
        assert_eq!(error.code, "BAD_REQUEST");
        assert_eq!(error.message, "Invalid pendingVaultKeys payload");
    }

    #[test]
    fn parse_pending_vault_keys_accepts_missing_or_blank_values() {
        assert!(parse_pending_vault_keys(None).unwrap().is_empty());
        assert!(parse_pending_vault_keys(Some("   ")).unwrap().is_empty());
    }

    #[test]
    fn normalize_pending_vault_keys_rejects_duplicate_vault_ids() {
        let error = normalize_pending_vault_keys(Some(vec![
            PendingVaultKeyEntry {
                vault_id: "vault_1".to_string(),
                encrypted_vault_key: "encrypted-a".to_string(),
            },
            PendingVaultKeyEntry {
                vault_id: "vault_1".to_string(),
                encrypted_vault_key: "encrypted-b".to_string(),
            },
        ]))
        .unwrap_err();

        assert_eq!(error.code, "BAD_REQUEST");
        assert_eq!(
            error.message,
            "Duplicate vault IDs are not allowed in pendingVaultKeys",
        );
    }

    #[test]
    fn normalize_pending_vault_keys_trims_valid_entries() {
        let entries = normalize_pending_vault_keys(Some(vec![PendingVaultKeyEntry {
            vault_id: " vault_1 ".to_string(),
            encrypted_vault_key: " wrapped-key ".to_string(),
        }]))
        .unwrap();

        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].vault_id, "vault_1");
        assert_eq!(entries[0].encrypted_vault_key, "wrapped-key");
    }

    #[test]
    fn normalize_pending_vault_keys_rejects_blank_entries() {
        let error = normalize_pending_vault_keys(Some(vec![PendingVaultKeyEntry {
            vault_id: " ".to_string(),
            encrypted_vault_key: "wrapped-key".to_string(),
        }]))
        .unwrap_err();

        assert_eq!(error.code, "BAD_REQUEST");
        assert_eq!(error.message, "Invalid pendingVaultKeys entry at index 0");
    }

    #[test]
    fn validate_rotation_vault_inputs_rejects_too_many_vaults() {
        let error = validate_rotation_vault_inputs(
            &(0..101)
                .map(|index| RotationVaultInput {
                    vault_id: format!("vault_{index}"),
                    key_rotation: VaultKeyRotationInput {
                        member_keys: Vec::new(),
                        re_encrypted_items: Vec::new(),
                    },
                })
                .collect::<Vec<_>>(),
        )
        .unwrap_err();

        assert_eq!(error.code, "BAD_REQUEST");
        assert_eq!(error.message, "Too many vault rotations provided.");
    }

    #[test]
    fn validate_rotation_vault_inputs_rejects_too_many_member_keys() {
        let error = validate_rotation_vault_inputs(&[RotationVaultInput {
            vault_id: "vault_1".to_string(),
            key_rotation: VaultKeyRotationInput {
                member_keys: (0..101)
                    .map(|index| RotationMemberKeyInput {
                        user_id: format!("user_{index}"),
                        encrypted_vault_key: "wrapped".to_string(),
                    })
                    .collect(),
                re_encrypted_items: Vec::new(),
            },
        }])
        .unwrap_err();

        assert_eq!(error.code, "BAD_REQUEST");
        assert_eq!(
            error.message,
            "Too many member key rotations provided for a vault.",
        );
    }

    #[test]
    fn validate_rotation_vault_inputs_rejects_too_many_reencrypted_items() {
        let error = validate_rotation_vault_inputs(&[RotationVaultInput {
            vault_id: "vault_1".to_string(),
            key_rotation: VaultKeyRotationInput {
                member_keys: Vec::new(),
                re_encrypted_items: (0..101)
                    .map(|index| RotationReEncryptedItemInput {
                        item_id: format!("item_{index}"),
                        encrypted_data: "ciphertext".to_string(),
                        encryption_iv: "iv".to_string(),
                    })
                    .collect(),
            },
        }])
        .unwrap_err();

        assert_eq!(error.code, "BAD_REQUEST");
        assert_eq!(
            error.message,
            "Too many re-encrypted items provided for a vault.",
        );
    }

    #[test]
    fn ensure_exact_rotation_vault_set_rejects_duplicates() {
        let expected = HashSet::from(["vault_1".to_string()]);
        let error = ensure_exact_rotation_vault_set(
            &expected,
            &[
                RotationVaultInput {
                    vault_id: "vault_1".to_string(),
                    key_rotation: VaultKeyRotationInput {
                        member_keys: Vec::new(),
                        re_encrypted_items: Vec::new(),
                    },
                },
                RotationVaultInput {
                    vault_id: "vault_1".to_string(),
                    key_rotation: VaultKeyRotationInput {
                        member_keys: Vec::new(),
                        re_encrypted_items: Vec::new(),
                    },
                },
            ],
            "Rotation mismatch.",
        )
        .unwrap_err();

        assert_eq!(error.code, "BAD_REQUEST");
        assert_eq!(
            error.message,
            "Duplicate vault rotation entries are not allowed.",
        );
    }

    #[test]
    fn ensure_exact_rotation_vault_set_rejects_extra_vaults() {
        let expected = HashSet::from(["vault_1".to_string()]);
        let error = ensure_exact_rotation_vault_set(
            &expected,
            &[
                RotationVaultInput {
                    vault_id: "vault_1".to_string(),
                    key_rotation: VaultKeyRotationInput {
                        member_keys: Vec::new(),
                        re_encrypted_items: Vec::new(),
                    },
                },
                RotationVaultInput {
                    vault_id: "vault_2".to_string(),
                    key_rotation: VaultKeyRotationInput {
                        member_keys: Vec::new(),
                        re_encrypted_items: Vec::new(),
                    },
                },
            ],
            "Rotation mismatch.",
        )
        .unwrap_err();

        assert_eq!(error.code, "BAD_REQUEST");
        assert_eq!(error.message, "Rotation mismatch.");
    }

    #[test]
    fn ensure_exact_rotation_vault_set_rejects_missing_vaults() {
        let expected = HashSet::from(["vault_1".to_string(), "vault_2".to_string()]);
        let error = ensure_exact_rotation_vault_set(
            &expected,
            &[RotationVaultInput {
                vault_id: "vault_1".to_string(),
                key_rotation: VaultKeyRotationInput {
                    member_keys: Vec::new(),
                    re_encrypted_items: Vec::new(),
                },
            }],
            "Rotation mismatch.",
        )
        .unwrap_err();

        assert_eq!(error.code, "BAD_REQUEST");
        assert_eq!(error.message, "Rotation mismatch.");
    }

    #[test]
    fn ensure_team_admin_rejects_members() {
        assert!(ensure_team_admin("owner").is_ok());
        assert!(ensure_team_admin("admin").is_ok());

        let error = ensure_team_admin("member").unwrap_err();
        assert_eq!(error.code, "FORBIDDEN");
        assert_eq!(error.message, "Insufficient permissions");
    }

    #[test]
    fn generate_secure_token_returns_32_url_safe_characters() {
        let token = generate_secure_token();

        assert_eq!(token.len(), 32);
        assert!(token
            .chars()
            .all(|character| character.is_ascii_alphanumeric()));
    }

    #[tokio::test]
    async fn team_protected_handlers_require_authentication() {
        with_rpc_test_app("team_auth_matrix", |app| async move {
            let valid_token = "A234567890123456789012345678901";
            for (method, params) in [
                ("team.list", json!([])),
                ("team.get", json!([{ "teamId": "team_test" }])),
                ("team.vaults", json!([{ "teamId": "team_test" }])),
                ("team.create", json!([{ "name": "Example Team" }])),
                (
                    "team.update",
                    json!([{ "teamId": "team_test", "name": "Updated Team" }]),
                ),
                (
                    "team.createImageUpload",
                    json!([{
                        "teamId": "team_test",
                        "fileName": "logo.png",
                        "contentType": "image/png"
                    }]),
                ),
                ("team.delete", json!([{ "teamId": "team_test" }])),
                (
                    "team.leave",
                    json!([{ "teamId": "team_test", "vaultRotations": [] }]),
                ),
                (
                    "team.getLeaveRotationData",
                    json!([{ "teamId": "team_test" }]),
                ),
                ("team.members.list", json!([{ "teamId": "team_test" }])),
                (
                    "team.members.getTeamRotationData",
                    json!([{ "teamId": "team_test", "excludeUserId": "user_test" }]),
                ),
                (
                    "team.members.remove",
                    json!([{
                        "teamId": "team_test",
                        "userId": "user_test",
                        "vaultRotations": []
                    }]),
                ),
                (
                    "team.members.deleteAccount",
                    json!([{
                        "teamId": "team_test",
                        "userId": "user_test",
                        "confirmation": "DELETE"
                    }]),
                ),
                ("team.invitations.list", json!([{ "teamId": "team_test" }])),
                ("team.invitations.pending", json!([])),
                (
                    "team.invitations.send",
                    json!([{ "teamId": "team_test", "email": "invitee@example.com" }]),
                ),
                ("team.invitations.accept", json!([{ "token": valid_token }])),
                (
                    "team.invitations.cancel",
                    json!([{ "invitationId": "invitation_test" }]),
                ),
                (
                    "team.invitations.resend",
                    json!([{ "invitationId": "invitation_test" }]),
                ),
                (
                    "team.invitations.decline",
                    json!([{ "token": valid_token }]),
                ),
            ] {
                let response = app
                    .rpc_call(method, params, unauthenticated_json_headers())
                    .await;

                assert_eq!(response.status, axum::http::StatusCode::OK, "{method}");
                assert_rpc_error(&response.body, "UNAUTHORIZED", "Authentication required");
            }
        })
        .await;
    }

    #[tokio::test]
    async fn team_handlers_reject_malformed_request_input() {
        with_rpc_test_app("team_bad_params", |app| async move {
            let fixture = build_team_router_fixture(&app.pool).await;
            let owner_session = app.issue_session(&fixture.owner_user_id).await;
            let headers = authenticated_json_headers(&owner_session.token);

            let get_response = app.rpc_call("team.get", json!([{}]), headers.clone()).await;
            assert_eq!(get_response.status, StatusCode::OK);
            assert_invalid_params_error(&get_response.body);

            let remove_response = app
                .rpc_call(
                    "team.members.remove",
                    json!([{ "teamId": fixture.team_id, "vaultRotations": [] }]),
                    headers,
                )
                .await;
            assert_eq!(remove_response.status, StatusCode::OK);
            assert_invalid_params_error(&remove_response.body);

            let token_response = app
                .rpc_call(
                    "team.invitations.getByToken",
                    json!([{}]),
                    unauthenticated_json_headers(),
                )
                .await;
            assert_eq!(token_response.status, StatusCode::OK);
            assert_invalid_params_error(&token_response.body);
        })
        .await;
    }

    #[tokio::test]
    async fn team_invitation_lookup_send_list_pending_cancel_and_resend_paths() {
        with_rpc_test_app("team_invite_manage", |app| async move {
            let fixture = build_team_router_fixture(&app.pool).await;
            let owner_session = app.issue_session(&fixture.owner_user_id).await;
            let owner_headers = authenticated_json_headers(&owner_session.token);

            let send_response = app
                .rpc_call(
                    "team.invitations.send",
                    json!([{
                        "teamId": fixture.team_id,
                        "email": "team-invitee@example.com",
                        "pendingVaultKeys": [{
                            "vaultId": fixture.accessible_vault_id,
                            "encryptedVaultKey": "invitee-wrapped-key"
                        }]
                    }]),
                    owner_headers.clone(),
                )
                .await;
            assert_eq!(send_response.status, StatusCode::OK);
            assert_eq!(
                send_response.body["result"]["Ok"]["existingUserPublicKey"],
                json!("public-key")
            );
            let invitation_id = send_response.body["result"]["Ok"]["invitationId"]
                .as_str()
                .expect("invitation id should exist")
                .to_string();
            let invitation_token = send_response.body["result"]["Ok"]["token"]
                .as_str()
                .expect("invitation token should exist")
                .to_string();

            let list_response = app
                .rpc_call(
                    "team.invitations.list",
                    json!([{ "teamId": fixture.team_id }]),
                    owner_headers.clone(),
                )
                .await;
            assert_eq!(list_response.status, StatusCode::OK);
            assert_eq!(
                list_response.body["result"]["Ok"][0]["id"],
                json!(invitation_id.clone())
            );

            let invitee_session = app.issue_session(&fixture.invitee_user_id).await;
            let pending_response = app
                .rpc_call(
                    "team.invitations.pending",
                    json!([]),
                    authenticated_json_headers(&invitee_session.token),
                )
                .await;
            assert_eq!(pending_response.status, StatusCode::OK);
            assert_eq!(
                pending_response.body["result"]["Ok"][0]["token"],
                json!(invitation_token.clone())
            );

            let public_lookup = app
                .rpc_call(
                    "team.invitations.getByToken",
                    json!([{ "token": invitation_token.clone() }]),
                    unauthenticated_json_headers(),
                )
                .await;
            assert_eq!(public_lookup.status, StatusCode::OK);
            assert_eq!(
                public_lookup.body["result"]["Ok"]["status"],
                json!("pending")
            );
            assert_eq!(
                public_lookup.body["result"]["Ok"]["teamId"],
                json!(fixture.team_id.clone())
            );

            let invalid_token_response = app
                .rpc_call(
                    "team.invitations.getByToken",
                    json!([{ "token": "short-token" }]),
                    unauthenticated_json_headers(),
                )
                .await;
            assert_eq!(invalid_token_response.status, StatusCode::OK);
            assert_handler_error(&invalid_token_response.body, "BAD_REQUEST", "Invalid token");

            let missing_token = "0123456789abcdefghijklmnopqrstuv";
            let missing_response = app
                .rpc_call(
                    "team.invitations.getByToken",
                    json!([{ "token": missing_token }]),
                    unauthenticated_json_headers(),
                )
                .await;
            assert_eq!(missing_response.status, StatusCode::OK);
            assert_handler_error(&missing_response.body, "NOT_FOUND", "Invitation not found");

            seed_team_invitation(
                &app.pool,
                "team_invitation_expired",
                &fixture.team_id,
                "team-decline@example.com",
                "member",
                &fixture.owner_user_id,
                "ZXCVBNMASDFGHJKLQWERTYUIOP123456",
                None,
                OffsetDateTime::now_utc() - Duration::days(1),
            )
            .await;
            let expired_lookup = app
                .rpc_call(
                    "team.invitations.getByToken",
                    json!([{ "token": "ZXCVBNMASDFGHJKLQWERTYUIOP123456" }]),
                    unauthenticated_json_headers(),
                )
                .await;
            assert_eq!(expired_lookup.status, StatusCode::OK);
            assert_eq!(
                expired_lookup.body["result"]["Ok"]["status"],
                json!("expired")
            );

            let member_session = app.issue_session(&fixture.member_user_id).await;
            let forbidden_list = app
                .rpc_call(
                    "team.invitations.list",
                    json!([{ "teamId": fixture.team_id }]),
                    authenticated_json_headers(&member_session.token),
                )
                .await;
            assert_eq!(forbidden_list.status, StatusCode::OK);
            assert_handler_error(
                &forbidden_list.body,
                "FORBIDDEN",
                "Insufficient permissions",
            );

            query("UPDATE team_invitation SET expires_at = $1 WHERE id = $2")
                .bind(OffsetDateTime::now_utc() - Duration::hours(1))
                .bind(&invitation_id)
                .execute(&app.pool)
                .await
                .expect("invitation should update");
            let resend_response = app
                .rpc_call(
                    "team.invitations.resend",
                    json!([{ "invitationId": invitation_id.clone() }]),
                    owner_headers.clone(),
                )
                .await;
            assert_eq!(resend_response.status, StatusCode::OK);
            assert_eq!(resend_response.body["result"]["Ok"]["success"], json!(true));
            let resent_expires_at = query_scalar::<_, OffsetDateTime>(
                "SELECT expires_at FROM team_invitation WHERE id = $1",
            )
            .bind(&invitation_id)
            .fetch_one(&app.pool)
            .await
            .expect("resent invitation should exist");
            assert!(resent_expires_at > OffsetDateTime::now_utc());

            let cancel_response = app
                .rpc_call(
                    "team.invitations.cancel",
                    json!([{ "invitationId": invitation_id.clone() }]),
                    owner_headers,
                )
                .await;
            assert_eq!(cancel_response.status, StatusCode::OK);
            assert_eq!(cancel_response.body["result"]["Ok"]["success"], json!(true));
            let invitation_exists = query_scalar::<_, bool>(
                "SELECT EXISTS(SELECT 1 FROM team_invitation WHERE id = $1)",
            )
            .bind(&invitation_id)
            .fetch_one(&app.pool)
            .await
            .expect("cancel existence query should succeed");
            assert!(!invitation_exists);
        })
        .await;
    }

    #[tokio::test]
    async fn team_list_get_create_update_and_image_upload_paths() {
        with_rpc_test_app("team_core_mutations", |app| async move {
            let fixture = build_team_router_fixture(&app.pool).await;
            let owner_session = app.issue_session(&fixture.owner_user_id).await;
            let owner_headers = authenticated_json_headers(&owner_session.token);

            let list_response = app
                .rpc_call("team.list", json!([]), owner_headers.clone())
                .await;
            assert_eq!(list_response.status, StatusCode::OK);
            assert_eq!(
                list_response.body["result"]["Ok"]["id"],
                json!(fixture.team_id.clone())
            );
            assert_eq!(list_response.body["result"]["Ok"]["memberCount"], json!(4));

            let no_team_session = app.issue_session(&fixture.no_team_user_id).await;
            let no_team_list = app
                .rpc_call(
                    "team.list",
                    json!([]),
                    authenticated_json_headers(&no_team_session.token),
                )
                .await;
            assert_eq!(no_team_list.status, StatusCode::OK);
            assert_handler_error(&no_team_list.body, "NOT_FOUND", "User has no team");

            let get_response = app
                .rpc_call(
                    "team.get",
                    json!([{ "teamId": fixture.team_id }]),
                    owner_headers.clone(),
                )
                .await;
            assert_eq!(get_response.status, StatusCode::OK);
            assert_eq!(
                get_response.body["result"]["Ok"]["ownerId"],
                json!(fixture.owner_user_id.clone())
            );
            assert_eq!(
                get_response.body["result"]["Ok"]["userRole"],
                json!("owner")
            );

            let outsider_session = app.issue_session(&fixture.outsider_user_id).await;
            let forbidden_get = app
                .rpc_call(
                    "team.get",
                    json!([{ "teamId": fixture.team_id }]),
                    authenticated_json_headers(&outsider_session.token),
                )
                .await;
            assert_eq!(forbidden_get.status, StatusCode::OK);
            assert_handler_error(
                &forbidden_get.body,
                "FORBIDDEN",
                "You are not a member of this team",
            );

            let create_response = app
                .rpc_call(
                    "team.create",
                    json!([{ "name": "Manual Team" }]),
                    owner_headers.clone(),
                )
                .await;
            assert_eq!(create_response.status, StatusCode::OK);
            assert_handler_error(
					&create_response.body,
					"BAD_REQUEST",
					"Teams are automatically created on signup. Contact support to upgrade your team type.",
				);

            let member_session = app.issue_session(&fixture.member_user_id).await;
            let forbidden_update = app
                .rpc_call(
                    "team.update",
                    json!([{
                        "teamId": fixture.team_id,
                        "name": "Forbidden Rename"
                    }]),
                    authenticated_json_headers(&member_session.token),
                )
                .await;
            assert_eq!(forbidden_update.status, StatusCode::OK);
            assert_handler_error(
                &forbidden_update.body,
                "FORBIDDEN",
                "Insufficient permissions",
            );

            let update_response = app
                .rpc_call(
                    "team.update",
                    json!([{
                        "teamId": fixture.team_id,
                        "name": "Renamed Router Team",
                        "imageKey": "teams/team_router_main/custom-logo.png"
                    }]),
                    owner_headers.clone(),
                )
                .await;
            assert_eq!(update_response.status, StatusCode::OK);
            assert_eq!(update_response.body["result"]["Ok"]["success"], json!(true));
            let updated_name = query_scalar::<_, String>("SELECT name FROM team WHERE id = $1")
                .bind(&fixture.team_id)
                .fetch_one(&app.pool)
                .await
                .expect("team name should load");
            let updated_image_key =
                query_scalar::<_, Option<String>>("SELECT image_key FROM team WHERE id = $1")
                    .bind(&fixture.team_id)
                    .fetch_one(&app.pool)
                    .await
                    .expect("team image key should load");
            assert_eq!(updated_name, "Renamed Router Team");
            assert_eq!(
                updated_image_key,
                Some("teams/team_router_main/custom-logo.png".to_string())
            );

            let forbidden_upload = app
                .rpc_call(
                    "team.createImageUpload",
                    json!([{
                        "teamId": fixture.team_id,
                        "fileName": "logo.png",
                        "contentType": "image/png"
                    }]),
                    authenticated_json_headers(&member_session.token),
                )
                .await;
            assert_eq!(forbidden_upload.status, StatusCode::OK);
            assert_handler_error(
                &forbidden_upload.body,
                "FORBIDDEN",
                "Insufficient permissions",
            );

            let invalid_upload = app
                .rpc_call(
                    "team.createImageUpload",
                    json!([{
                        "teamId": fixture.team_id,
                        "fileName": "logo.txt",
                        "contentType": "text/plain"
                    }]),
                    owner_headers.clone(),
                )
                .await;
            assert_eq!(invalid_upload.status, StatusCode::OK);
            assert_handler_error(
                &invalid_upload.body,
                "BAD_REQUEST",
                "Only image files are allowed",
            );

            let upload_response = with_storage_env_async(app.rpc_call(
                "team.createImageUpload",
                json!([{
                    "teamId": fixture.team_id,
                    "fileName": "logo.png",
                    "contentType": "image/png"
                }]),
                owner_headers,
            ))
            .await;
            assert_eq!(upload_response.status, StatusCode::OK);
            let key = upload_response.body["result"]["Ok"]["key"]
                .as_str()
                .expect("upload key should exist");
            assert!(
                key.starts_with("teams/team_router_main/"),
                "unexpected key: {key}"
            );
            assert!(
                upload_response.body["result"]["Ok"]["uploadUrl"]
                    .as_str()
                    .expect("upload url should exist")
                    .contains("storage.example.invalid/bittery-test/"),
                "unexpected upload response: {}",
                upload_response.body
            );
            assert!(
                upload_response.body["result"]["Ok"]["publicUrl"]
                    .as_str()
                    .expect("public url should exist")
                    .starts_with("https://cdn.example.invalid/assets/teams/team_router_main/"),
                "unexpected upload response: {}",
                upload_response.body
            );
        })
        .await;
    }

    #[tokio::test]
    async fn team_vaults_members_and_leave_rotation_queries() {
        with_rpc_test_app("team_query_paths", |app| async move {
            let fixture = build_team_router_fixture(&app.pool).await;
            let owner_session = app.issue_session(&fixture.owner_user_id).await;
            let owner_headers = authenticated_json_headers(&owner_session.token);

            let vaults_response = app
                .rpc_call(
                    "team.vaults",
                    json!([{ "teamId": fixture.team_id }]),
                    owner_headers.clone(),
                )
                .await;
            assert_eq!(vaults_response.status, StatusCode::OK);
            assert_eq!(
                vaults_response.body["result"]["Ok"]
                    .as_array()
                    .expect("vaults should be an array")
                    .len(),
                3
            );
            assert_eq!(
                vaults_response.body["result"]["Ok"][0]["encryptedVaultKey"],
                json!("owner-accessible-key")
            );

            let member_session = app.issue_session(&fixture.member_user_id).await;
            let forbidden_vaults = app
                .rpc_call(
                    "team.vaults",
                    json!([{ "teamId": fixture.team_id }]),
                    authenticated_json_headers(&member_session.token),
                )
                .await;
            assert_eq!(forbidden_vaults.status, StatusCode::OK);
            assert_handler_error(
                &forbidden_vaults.body,
                "FORBIDDEN",
                "Insufficient permissions",
            );

            let members_response = app
                .rpc_call(
                    "team.members.list",
                    json!([{ "teamId": fixture.team_id }]),
                    owner_headers.clone(),
                )
                .await;
            assert_eq!(members_response.status, StatusCode::OK);
            let members = members_response.body["result"]["Ok"]
                .as_array()
                .expect("members should be an array");
            assert_eq!(members.len(), 4);
            assert!(members
                .iter()
                .any(|member| member["role"] == json!("owner")));
            assert!(members
                .iter()
                .any(|member| member["role"] == json!("admin")));
            assert!(members
                .iter()
                .any(|member| member["role"] == json!("member")));

            let outsider_session = app.issue_session(&fixture.outsider_user_id).await;
            let forbidden_members = app
                .rpc_call(
                    "team.members.list",
                    json!([{ "teamId": fixture.team_id }]),
                    authenticated_json_headers(&outsider_session.token),
                )
                .await;
            assert_eq!(forbidden_members.status, StatusCode::OK);
            assert_handler_error(
                &forbidden_members.body,
                "FORBIDDEN",
                "You are not a member of this team",
            );

            let leave_rotation_response = app
                .rpc_call(
                    "team.getLeaveRotationData",
                    json!([{ "teamId": fixture.team_id }]),
                    authenticated_json_headers(&member_session.token),
                )
                .await;
            assert_eq!(leave_rotation_response.status, StatusCode::OK);
            let rotation_vaults = leave_rotation_response.body["result"]["Ok"]["vaults"]
                .as_array()
                .expect("rotation vaults should be an array");
            assert_eq!(rotation_vaults.len(), 1);
            assert_eq!(
                rotation_vaults[0]["vaultId"],
                json!(fixture.accessible_vault_id)
            );
            assert_eq!(
                rotation_vaults[0]["items"][0]["id"],
                json!(fixture.accessible_item_id)
            );
            assert!(rotation_vaults[0]["members"]
                .as_array()
                .expect("members should be an array")
                .iter()
                .all(|member| member["userId"] != json!(fixture.member_user_id.clone())));
        })
        .await;
    }

    #[tokio::test]
    async fn team_invitation_accept_and_decline_paths() {
        with_rpc_test_app("team_accept_decline", |app| async move {
            let fixture = build_team_router_fixture(&app.pool).await;
            let owner_session = app.issue_session(&fixture.owner_user_id).await;
            let owner_headers = authenticated_json_headers(&owner_session.token);

            let accept_invitation = app
                .rpc_call(
                    "team.invitations.send",
                    json!([{
                        "teamId": fixture.team_id,
                        "email": "team-accept@example.com",
                        "pendingVaultKeys": [{
                            "vaultId": fixture.accessible_vault_id,
                            "encryptedVaultKey": "accepted-user-key"
                        }]
                    }]),
                    owner_headers.clone(),
                )
                .await;
            assert_eq!(accept_invitation.status, StatusCode::OK);
            let accept_invitation_id = accept_invitation.body["result"]["Ok"]["invitationId"]
                .as_str()
                .expect("accept invitation id should exist")
                .to_string();
            let accept_token = accept_invitation.body["result"]["Ok"]["token"]
                .as_str()
                .expect("accept token should exist")
                .to_string();

            let wrong_user_session = app.issue_session(&fixture.no_team_user_id).await;
            let wrong_user_accept = app
                .rpc_call(
                    "team.invitations.accept",
                    json!([{ "token": accept_token.clone() }]),
                    authenticated_json_headers(&wrong_user_session.token),
                )
                .await;
            assert_eq!(wrong_user_accept.status, StatusCode::OK);
            assert_handler_error(
                &wrong_user_accept.body,
                "FORBIDDEN",
                "This invitation is not for you",
            );

            let accept_user_session = app.issue_session(&fixture.accept_user_id).await;
            let accept_response = app
                .rpc_call(
                    "team.invitations.accept",
                    json!([{ "token": accept_token.clone() }]),
                    authenticated_json_headers(&accept_user_session.token),
                )
                .await;
            assert_eq!(accept_response.status, StatusCode::OK);
            assert_eq!(
                accept_response.body["result"]["Ok"]["teamId"],
                json!(fixture.team_id.clone())
            );
            let accepted_team_id =
                query_scalar::<_, Option<String>>("SELECT team_id FROM \"user\" WHERE id = $1")
                    .bind(&fixture.accept_user_id)
                    .fetch_one(&app.pool)
                    .await
                    .expect("accepted user team should load");
            let accepted_role =
                query_scalar::<_, String>("SELECT role::text FROM \"user\" WHERE id = $1")
                    .bind(&fixture.accept_user_id)
                    .fetch_one(&app.pool)
                    .await
                    .expect("accepted user role should load");
            let accepted_vault_role = query_scalar::<_, String>(
                "SELECT role::text FROM vault_key WHERE vault_id = $1 AND user_id = $2",
            )
            .bind(&fixture.accessible_vault_id)
            .bind(&fixture.accept_user_id)
            .fetch_one(&app.pool)
            .await
            .expect("accepted vault key should load");
            let accepted_status =
                query_scalar::<_, String>("SELECT status::text FROM team_invitation WHERE id = $1")
                    .bind(&accept_invitation_id)
                    .fetch_one(&app.pool)
                    .await
                    .expect("accepted invitation status should load");
            assert_eq!(accepted_team_id, Some(fixture.team_id.clone()));
            assert_eq!(accepted_role, "member");
            assert_eq!(accepted_vault_role, "member");
            assert_eq!(accepted_status, "accepted");

            let decline_invitation = app
                .rpc_call(
                    "team.invitations.send",
                    json!([{
                        "teamId": fixture.team_id,
                        "email": "team-decline@example.com"
                    }]),
                    owner_headers,
                )
                .await;
            assert_eq!(decline_invitation.status, StatusCode::OK);
            let decline_invitation_id = decline_invitation.body["result"]["Ok"]["invitationId"]
                .as_str()
                .expect("decline invitation id should exist")
                .to_string();
            let decline_token = decline_invitation.body["result"]["Ok"]["token"]
                .as_str()
                .expect("decline token should exist")
                .to_string();

            let decline_user_session = app.issue_session(&fixture.decline_user_id).await;
            let decline_response = app
                .rpc_call(
                    "team.invitations.decline",
                    json!([{ "token": decline_token }]),
                    authenticated_json_headers(&decline_user_session.token),
                )
                .await;
            assert_eq!(decline_response.status, StatusCode::OK);
            assert_eq!(
                decline_response.body["result"]["Ok"]["success"],
                json!(true)
            );
            let declined_status =
                query_scalar::<_, String>("SELECT status::text FROM team_invitation WHERE id = $1")
                    .bind(&decline_invitation_id)
                    .fetch_one(&app.pool)
                    .await
                    .expect("declined invitation status should load");
            assert_eq!(declined_status, "declined");
        })
        .await;
    }

    #[tokio::test]
    async fn team_leave_paths() {
        with_rpc_test_app("team_leave", |app| async move {
            let fixture = build_team_router_fixture(&app.pool).await;

            let owner_session = app.issue_session(&fixture.owner_user_id).await;
            let owner_leave = app
                .rpc_call(
                    "team.leave",
                    json!([{ "teamId": fixture.team_id, "vaultRotations": [] }]),
                    authenticated_json_headers(&owner_session.token),
                )
                .await;
            assert_eq!(owner_leave.status, StatusCode::OK);
            assert_handler_error(
                &owner_leave.body,
                "BAD_REQUEST",
                "The team owner cannot leave. Transfer ownership first.",
            );

            let leaving_session = app.issue_session(&fixture.member_user_id).await;
            let additional_session = app.issue_session(&fixture.member_user_id).await;
            let leave_response = app
                .rpc_call(
                    "team.leave",
                    json!([{
                        "teamId": fixture.team_id,
                        "vaultRotations": [{
                            "vaultId": fixture.accessible_vault_id,
                            "keyRotation": {
                                "memberKeys": [
                                    {
                                        "userId": fixture.owner_user_id,
                                        "encryptedVaultKey": "rotated-owner-key"
                                    },
                                    {
                                        "userId": fixture.admin_user_id,
                                        "encryptedVaultKey": "rotated-admin-key"
                                    },
                                    {
                                        "userId": fixture.remove_target_user_id,
                                        "encryptedVaultKey": "rotated-target-key"
                                    }
                                ],
                                "reEncryptedItems": [{
                                    "itemId": fixture.accessible_item_id,
                                    "encryptedData": "rotated-item-ciphertext",
                                    "encryptionIv": "rotated-item-iv"
                                }]
                            }
                        }]
                    }]),
                    authenticated_json_headers(&leaving_session.token),
                )
                .await;
            assert_eq!(leave_response.status, StatusCode::OK);
            assert_eq!(leave_response.body["result"]["Ok"]["success"], json!(true));

            let new_team_id =
                query_scalar::<_, Option<String>>("SELECT team_id FROM \"user\" WHERE id = $1")
                    .bind(&fixture.member_user_id)
                    .fetch_one(&app.pool)
                    .await
                    .expect("leaving user team should load")
                    .expect("leaving user should have a new team");
            let new_role =
                query_scalar::<_, String>("SELECT role::text FROM \"user\" WHERE id = $1")
                    .bind(&fixture.member_user_id)
                    .fetch_one(&app.pool)
                    .await
                    .expect("leaving user role should load");
            let old_vault_key_exists = query_scalar::<_, bool>(
                "SELECT EXISTS(SELECT 1 FROM vault_key WHERE vault_id = $1 AND user_id = $2)",
            )
            .bind(&fixture.accessible_vault_id)
            .bind(&fixture.member_user_id)
            .fetch_one(&app.pool)
            .await
            .expect("vault key existence query should succeed");
            let rotated_owner_key = query_scalar::<_, String>(
                "SELECT encrypted_vault_key FROM vault_key WHERE vault_id = $1 AND user_id = $2",
            )
            .bind(&fixture.accessible_vault_id)
            .bind(&fixture.owner_user_id)
            .fetch_one(&app.pool)
            .await
            .expect("rotated owner key should load");
            let new_key_version =
                query_scalar::<_, i32>("SELECT key_version FROM vault WHERE id = $1")
                    .bind(&fixture.accessible_vault_id)
                    .fetch_one(&app.pool)
                    .await
                    .expect("rotated vault version should load");
            let completed_rotations = query_scalar::<_, i64>(
				"SELECT COUNT(*)::bigint FROM vault_key_rotation WHERE vault_id = $1 AND status = 'completed'",
			)
			.bind(&fixture.accessible_vault_id)
			.fetch_one(&app.pool)
			.await
			.expect("rotation count should load");
            let remaining_sessions =
                query_scalar::<_, i64>("SELECT COUNT(*)::bigint FROM session WHERE user_id = $1")
                    .bind(&fixture.member_user_id)
                    .fetch_one(&app.pool)
                    .await
                    .expect("session count should load");

            assert_ne!(new_team_id, fixture.team_id);
            assert_eq!(new_role, "owner");
            assert!(!old_vault_key_exists);
            assert_eq!(rotated_owner_key, "rotated-owner-key");
            assert_eq!(new_key_version, 2);
            assert_eq!(completed_rotations, 1);
            assert_eq!(remaining_sessions, 0);

            let revoked_session = load_session_revocation(
                &app.pool,
                &fixture.member_user_id,
                &additional_session.session_id,
            )
            .await
            .expect("revoked session should load")
            .expect("revoked session record should exist");
            assert_eq!(revoked_session.reason.as_deref(), Some("team_left"));
        })
        .await;
    }

    #[tokio::test]
    async fn team_delete_paths() {
        with_rpc_test_app("team_delete", |app| async move {
            let fixture = build_team_router_fixture(&app.pool).await;

            let member_session = app.issue_session(&fixture.member_user_id).await;
            let forbidden_delete = app
                .rpc_call(
                    "team.delete",
                    json!([{ "teamId": fixture.team_id }]),
                    authenticated_json_headers(&member_session.token),
                )
                .await;
            assert_eq!(forbidden_delete.status, StatusCode::OK);
            assert_handler_error(
                &forbidden_delete.body,
                "FORBIDDEN",
                "Only the team owner can delete the team",
            );

            let owner_session = app.issue_session(&fixture.owner_user_id).await;
            let self_hosted_delete = with_bittery_mode_async(
                Some("self_hosted"),
                app.rpc_call(
                    "team.delete",
                    json!([{ "teamId": fixture.team_id }]),
                    authenticated_json_headers(&owner_session.token),
                ),
            )
            .await;
            assert_eq!(self_hosted_delete.status, StatusCode::OK);
            assert_handler_error(
                &self_hosted_delete.body,
                "BAD_REQUEST",
                "Team deletion is disabled in self-hosted mode. This instance uses a single team.",
            );

            let members_blocked = app
                .rpc_call(
                    "team.delete",
                    json!([{ "teamId": fixture.team_id }]),
                    authenticated_json_headers(&owner_session.token),
                )
                .await;
            assert_eq!(members_blocked.status, StatusCode::OK);
            assert_handler_error(
                &members_blocked.body,
                "BAD_REQUEST",
                "Team deletion is blocked until the owner is the only remaining member.",
            );

            let vault_owner_id = "team_delete_vault_owner";
            let vault_team_id = "team_delete_vault_team";
            seed_user(
                &app.pool,
                vault_owner_id,
                "Vault Delete Owner",
                "team-delete-vault-owner@example.com",
            )
            .await;
            seed_team(
                &app.pool,
                vault_team_id,
                "Vault Delete Team",
                vault_owner_id,
                "organization",
                "team",
                "active",
            )
            .await;
            assign_user_to_team(&app.pool, vault_owner_id, vault_team_id, "owner").await;
            seed_vault(
                &app.pool,
                "team_delete_blocking_vault",
                "Blocking Vault",
                "personal",
                vault_owner_id,
                Some(vault_team_id),
            )
            .await;
            let vault_owner_session = app.issue_session(vault_owner_id).await;
            let vault_blocked = app
                .rpc_call(
                    "team.delete",
                    json!([{ "teamId": vault_team_id }]),
                    authenticated_json_headers(&vault_owner_session.token),
                )
                .await;
            assert_eq!(vault_blocked.status, StatusCode::OK);
            assert_handler_error(
                &vault_blocked.body,
                "BAD_REQUEST",
                "Team deletion is blocked until all team vaults have been removed or converted.",
            );

            let success_owner_id = "team_delete_success_owner";
            let success_team_id = "team_delete_success_team";
            seed_user(
                &app.pool,
                success_owner_id,
                "Delete Success Owner",
                "team-delete-success-owner@example.com",
            )
            .await;
            seed_team(
                &app.pool,
                success_team_id,
                "Delete Success Team",
                success_owner_id,
                "organization",
                "team",
                "active",
            )
            .await;
            assign_user_to_team(&app.pool, success_owner_id, success_team_id, "owner").await;
            let success_session = app.issue_session(success_owner_id).await;
            let delete_success = app
                .rpc_call(
                    "team.delete",
                    json!([{ "teamId": success_team_id }]),
                    authenticated_json_headers(&success_session.token),
                )
                .await;
            assert_eq!(delete_success.status, StatusCode::OK);
            assert_eq!(delete_success.body["result"]["Ok"]["success"], json!(true));
            let deleted_team_exists =
                query_scalar::<_, bool>("SELECT EXISTS(SELECT 1 FROM team WHERE id = $1)")
                    .bind(success_team_id)
                    .fetch_one(&app.pool)
                    .await
                    .expect("deleted team existence query should load");
            let reassigned_team_type = query_scalar::<_, String>(
				"SELECT t.type::text FROM team t INNER JOIN \"user\" u ON u.team_id = t.id WHERE u.id = $1",
			)
			.bind(success_owner_id)
			.fetch_one(&app.pool)
			.await
			.expect("reassigned team type should load");
            assert!(!deleted_team_exists);
            assert_eq!(reassigned_team_type, "personal");
        })
        .await;
    }

    #[tokio::test]
    async fn team_member_rotation_remove_and_delete_account_paths() {
        with_rpc_test_app(
			"team_member_remove",
			|app| async move {
				let fixture = build_team_router_fixture(&app.pool).await;

				let owner_session = app.issue_session(&fixture.owner_user_id).await;
				let owner_headers = authenticated_json_headers(&owner_session.token);
				let owner_rotation = app
					.rpc_call(
						"team.members.getTeamRotationData",
						json!([{
							"teamId": fixture.team_id,
							"excludeUserId": fixture.remove_target_user_id
						}]),
						owner_headers.clone(),
					)
					.await;
				assert_eq!(owner_rotation.status, StatusCode::OK);
				let owner_vaults = owner_rotation.body["result"]["Ok"]["vaults"]
					.as_array()
					.expect("owner rotation vaults should be an array");
				assert_eq!(owner_vaults.len(), 2);
				assert!(owner_vaults.iter().any(|vault| vault["vaultId"] == json!(fixture.accessible_vault_id.clone())));
				assert!(owner_vaults.iter().any(|vault| vault["vaultId"] == json!(fixture.admin_inaccessible_vault_id.clone())));

				let admin_session = app.issue_session(&fixture.admin_user_id).await;
				let admin_rotation = app
					.rpc_call(
						"team.members.getTeamRotationData",
						json!([{
							"teamId": fixture.team_id,
							"excludeUserId": fixture.remove_target_user_id
						}]),
						authenticated_json_headers(&admin_session.token),
					)
					.await;
				assert_eq!(admin_rotation.status, StatusCode::OK);
				assert_handler_error(
					&admin_rotation.body,
					"FORBIDDEN",
					"You cannot remove this member from only part of their team vault access.",
				);

				let member_session = app.issue_session(&fixture.member_user_id).await;
				let member_rotation = app
					.rpc_call(
						"team.members.getTeamRotationData",
						json!([{
							"teamId": fixture.team_id,
							"excludeUserId": fixture.remove_target_user_id
						}]),
						authenticated_json_headers(&member_session.token),
					)
					.await;
				assert_eq!(member_rotation.status, StatusCode::OK);
				assert_handler_error(
					&member_rotation.body,
					"FORBIDDEN",
					"Only owner or admin can perform key rotation",
				);

				let missing_target = app
					.rpc_call(
						"team.members.remove",
						json!([{
							"teamId": fixture.team_id,
							"userId": "missing-user",
							"vaultRotations": []
						}]),
						owner_headers.clone(),
					)
					.await;
				assert_eq!(missing_target.status, StatusCode::OK);
				assert_handler_error(
					&missing_target.body,
					"NOT_FOUND",
					"Team member not found",
				);

				let self_remove = app
					.rpc_call(
						"team.members.remove",
						json!([{
							"teamId": fixture.team_id,
							"userId": fixture.owner_user_id,
							"vaultRotations": []
						}]),
						owner_headers.clone(),
					)
					.await;
				assert_eq!(self_remove.status, StatusCode::OK);
				assert_handler_error(
					&self_remove.body,
					"BAD_REQUEST",
					"You cannot remove yourself from the team",
				);

				let removed_session = app.issue_session(&fixture.remove_target_user_id).await;
				let remove_response = app
					.rpc_call(
						"team.members.remove",
						json!([{
							"teamId": fixture.team_id,
							"userId": fixture.remove_target_user_id,
							"vaultRotations": [
								{
									"vaultId": fixture.accessible_vault_id,
									"keyRotation": {
										"memberKeys": [
											{
												"userId": fixture.owner_user_id,
												"encryptedVaultKey": "remove-owner-key"
											},
											{
												"userId": fixture.admin_user_id,
												"encryptedVaultKey": "remove-admin-key"
											},
											{
												"userId": fixture.member_user_id,
												"encryptedVaultKey": "remove-member-key"
											}
										],
										"reEncryptedItems": [{
											"itemId": fixture.accessible_item_id,
											"encryptedData": "remove-accessible-ciphertext",
											"encryptionIv": "remove-accessible-iv"
										}]
									}
								},
								{
									"vaultId": fixture.admin_inaccessible_vault_id,
									"keyRotation": {
										"memberKeys": [{
											"userId": fixture.owner_user_id,
											"encryptedVaultKey": "remove-owner-hidden-key"
										}],
										"reEncryptedItems": [{
											"itemId": fixture.admin_inaccessible_item_id,
											"encryptedData": "remove-hidden-ciphertext",
											"encryptionIv": "remove-hidden-iv"
										}]
									}
								}
							]
						}]),
						owner_headers,
					)
					.await;
				assert_eq!(remove_response.status, StatusCode::OK);
				assert_eq!(remove_response.body["result"]["Ok"]["success"], json!(true));
				assert_eq!(
					remove_response.body["result"]["Ok"]["vaultRotations"]
						.as_array()
						.expect("rotation results should be an array")
						.len(),
					2
				);

				let removed_user_team = query_scalar::<_, Option<String>>(
					"SELECT team_id FROM \"user\" WHERE id = $1",
				)
				.bind(&fixture.remove_target_user_id)
				.fetch_one(&app.pool)
				.await
				.expect("removed user team should load")
				.expect("removed user should have a personal team");
				let removed_user_role = query_scalar::<_, String>(
					"SELECT role::text FROM \"user\" WHERE id = $1",
				)
				.bind(&fixture.remove_target_user_id)
				.fetch_one(&app.pool)
				.await
				.expect("removed user role should load");
				let removed_user_old_key_exists = query_scalar::<_, bool>(
					"SELECT EXISTS(SELECT 1 FROM vault_key WHERE vault_id = $1 AND user_id = $2)",
				)
				.bind(&fixture.accessible_vault_id)
				.bind(&fixture.remove_target_user_id)
				.fetch_one(&app.pool)
				.await
				.expect("removed user old vault key query should succeed");
				let accessible_version = query_scalar::<_, i32>(
					"SELECT key_version FROM vault WHERE id = $1",
				)
				.bind(&fixture.accessible_vault_id)
				.fetch_one(&app.pool)
				.await
				.expect("accessible vault version should load");
				let hidden_version = query_scalar::<_, i32>(
					"SELECT key_version FROM vault WHERE id = $1",
				)
				.bind(&fixture.admin_inaccessible_vault_id)
				.fetch_one(&app.pool)
				.await
				.expect("hidden vault version should load");
				let completed_rotations = query_scalar::<_, i64>(
					"SELECT COUNT(*)::bigint FROM vault_key_rotation WHERE removed_user_id = $1 AND status = 'completed'",
				)
				.bind(&fixture.remove_target_user_id)
				.fetch_one(&app.pool)
				.await
				.expect("completed rotation count should load");
				let removed_user_session_count = query_scalar::<_, i64>(
					"SELECT COUNT(*)::bigint FROM session WHERE user_id = $1",
				)
				.bind(&fixture.remove_target_user_id)
				.fetch_one(&app.pool)
				.await
				.expect("removed user session count should load");

				assert_ne!(removed_user_team, fixture.team_id);
				assert_eq!(removed_user_role, "owner");
				assert!(!removed_user_old_key_exists);
				assert_eq!(accessible_version, 2);
				assert_eq!(hidden_version, 2);
				assert_eq!(completed_rotations, 2);
				assert_eq!(removed_user_session_count, 0);

				let removed_session_revoked = load_session_revocation(
					&app.pool,
					&fixture.remove_target_user_id,
					&removed_session.session_id,
				)
				.await
				.expect("removed session revocation should load")
				.expect("removed session revocation record should exist");
				assert_eq!(
					removed_session_revoked.reason.as_deref(),
					Some("team_member_removed")
				);

				let invalid_delete_account = app
					.rpc_call(
						"team.members.deleteAccount",
						json!([{
							"teamId": fixture.team_id,
							"userId": fixture.member_user_id,
							"confirmation": "NOPE"
						}]),
						authenticated_json_headers(&admin_session.token),
					)
					.await;
				assert_eq!(invalid_delete_account.status, StatusCode::OK);
				assert_handler_error(
					&invalid_delete_account.body,
					"BAD_REQUEST",
					"Invalid params",
				);

				let deprecated_delete_account = app
					.rpc_call(
						"team.members.deleteAccount",
						json!([{
							"teamId": fixture.team_id,
							"userId": fixture.member_user_id,
							"confirmation": "DELETE"
						}]),
						authenticated_json_headers(&admin_session.token),
					)
					.await;
				assert_eq!(deprecated_delete_account.status, StatusCode::OK);
				assert_handler_error(
					&deprecated_delete_account.body,
					"BAD_REQUEST",
					"Account deletion by team admins is no longer supported. Use 'Remove member' instead. The removed user can delete their own account.",
				);
			},
		)
		.await;
    }
}
