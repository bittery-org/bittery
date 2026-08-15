use std::collections::HashSet;

use serde::{Deserialize, Serialize};
use sqlx::{query, query_as, query_scalar, PgPool};
use time::OffsetDateTime;

use crate::{
    config::{format_timestamp, DeploymentMode},
    db::enums::{InvitationStatus, TeamRole},
    db::models::*,
    error::AppError,
    integrations::stripe::BillingGateway,
    repo::common::{generate_resource_id, hash_token},
    services::{
        billing::sync_team_seats_best_effort, generate_secure_token, transaction::database_error,
        vault_key::validate_encrypted_vault_key,
    },
};

use super::{
    assert_optional_team_management_entitlement, assert_team_management_entitlement,
    ensure_team_admin, load_team_membership_actor, SuccessResponse, TeamIdInput,
};

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
#[serde(deny_unknown_fields)]
pub struct TokenInput {
    pub token: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
#[serde(deny_unknown_fields)]
pub struct InvitationIdInput {
    pub invitation_id: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
#[serde(deny_unknown_fields)]
pub struct SendInvitationInput {
    pub team_id: String,
    pub email: String,
    #[serde(default = "default_invitation_role")]
    pub role: TeamRole,
    pub pending_vault_keys: Option<Vec<PendingVaultKeyEntry>>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TeamInvitationDetailsResponse {
    pub id: String,
    pub email: String,
    pub team_id: String,
    pub team_name: String,
    pub role: TeamRole,
    pub status: InvitationStatus,
    pub invited_by_name: String,
    pub expires_at: String,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingTeamInvitationResponse {
    pub id: String,
    pub team_id: String,
    pub team_name: String,
    pub role: TeamRole,
    pub invited_by: String,
    pub expires_at: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SendInvitationResponse {
    pub invitation_id: String,
    pub token: String,
    pub existing_user_public_key: Option<String>,
}

/// Resending rotates the invite token, so the caller receives a brand new raw
/// token exactly like `SendInvitationResponse` does. Only the digest is stored,
/// which means the previous link stops working the moment this returns.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResendInvitationResponse {
    pub invitation_id: String,
    pub token: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AcceptInvitationResponse {
    pub team_id: String,
    pub team_name: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
#[serde(deny_unknown_fields)]
pub struct PendingVaultKeyEntry {
    pub vault_id: String,
    pub encrypted_vault_key: String,
}

pub(crate) async fn get_invitation_by_token(
    pool: &PgPool,
    input: TokenInput,
) -> Result<TeamInvitationDetailsResponse, AppError> {
    validate_token(&input.token)?;

    let invitation = query_as::<_, DbTeamInvitationDetailsRow>(
		"SELECT ti.id, ti.email, ti.team_id, t.name AS team_name, ti.role::text AS role, ti.status::text AS status, invited_by.name AS invited_by_name, ti.expires_at, ti.created_at FROM team_invitation ti INNER JOIN team t ON ti.team_id = t.id INNER JOIN \"user\" invited_by ON ti.invited_by_id = invited_by.id WHERE ti.token_hash = $1 LIMIT 1",
	)
	.bind(hash_token(&input.token))
	.fetch_optional(pool)
	.await
	.map_err(|error| database_error(error, "Failed to load invitation"))?
	.ok_or_else(|| AppError::not_found("Invitation not found"))?;

    let invitation_status = if invitation.expires_at < OffsetDateTime::now_utc() {
        InvitationStatus::Expired
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
pub(crate) async fn get_pending_invitations(
    pool: &PgPool,
    user_id: &str,
) -> Result<Vec<PendingTeamInvitationResponse>, AppError> {
    let current_user = load_team_membership_actor(pool, user_id)
        .await?
        .ok_or_else(|| AppError::not_found("User not found"))?;

    let invitations = query_as::<_, DbPendingTeamInvitationRow>(
		"SELECT ti.id, ti.team_id, t.name AS team_name, ti.role::text AS role, invited_by.name AS invited_by_name, ti.expires_at FROM team_invitation ti INNER JOIN team t ON ti.team_id = t.id INNER JOIN \"user\" invited_by ON ti.invited_by_id = invited_by.id WHERE ti.email = $1 AND ti.status = 'pending' AND ti.expires_at > $2 ORDER BY ti.created_at DESC",
	)
	.bind(&current_user.email)
	.bind(OffsetDateTime::now_utc())
	.fetch_all(pool)
	.await
	.map_err(|error| database_error(error, "Failed to load invitations"))?;

    Ok(invitations
        .into_iter()
        .map(|invitation| PendingTeamInvitationResponse {
            id: invitation.id,
            team_id: invitation.team_id,
            team_name: invitation.team_name,
            role: invitation.role,
            invited_by: invitation.invited_by_name,
            expires_at: format_timestamp(invitation.expires_at),
        })
        .collect())
}

pub(crate) async fn send_invitation(
    pool: &PgPool,
    deployment_mode: DeploymentMode,
    user_id: &str,
    input: SendInvitationInput,
) -> Result<SendInvitationResponse, AppError> {
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

    let team = query_as::<_, DbTeamInvitationSendTeamRow>(
		"SELECT id, member_limit, billing_plan::text AS billing_plan, billing_status::text AS billing_status FROM team WHERE id = $1 LIMIT 1",
	)
	.bind(&input.team_id)
	.fetch_optional(pool)
	.await
	.map_err(|error| database_error(error, "Failed to load team"))?
	.ok_or_else(|| AppError::not_found("Team not found"))?;
    assert_team_management_entitlement(deployment_mode, team.billing_plan, team.billing_status)?;

    if let Some(member_limit) = team.member_limit {
        let current_members =
            query_scalar::<_, i64>("SELECT COUNT(*)::bigint FROM \"user\" WHERE team_id = $1")
                .bind(&input.team_id)
                .fetch_one(pool)
                .await
                .map_err(|error| database_error(error, "Failed to count team members"))?;
        let pending_invitations = query_scalar::<_, i64>(
			"SELECT COUNT(*)::bigint FROM team_invitation WHERE team_id = $1 AND status = 'pending'",
		)
		.bind(&input.team_id)
		.fetch_one(pool)
		.await
		.map_err(|error| database_error(error, "Failed to count pending invitations"))?;
        if current_members + pending_invitations >= i64::from(member_limit) {
            return Err(AppError::bad_request("Team has reached member limit"));
        }
    }

    let existing_user = query_as::<_, DbExistingInviteeRow>(
        "SELECT team_id, public_key FROM \"user\" WHERE email = $1 LIMIT 1",
    )
    .bind(&input.email)
    .fetch_optional(pool)
    .await
    .map_err(|error| database_error(error, "Failed to load existing user"))?;
    if existing_user
        .as_ref()
        .and_then(|value| value.team_id.as_ref())
        .is_some()
    {
        return Err(AppError::bad_request("This user already belongs to a team"));
    }

    let has_pending_invitation = query_scalar::<_, bool>(
		"SELECT EXISTS(SELECT 1 FROM team_invitation WHERE team_id = $1 AND email = $2 AND status = 'pending')",
	)
	.bind(&input.team_id)
	.bind(&input.email)
	.fetch_one(pool)
	.await
	.map_err(|error| database_error(error, "Failed to check pending invitations"))?;
    if has_pending_invitation {
        return Err(AppError::bad_request(
            "An invitation is already pending for this email",
        ));
    }

    let pending_vault_keys = normalize_pending_vault_keys(input.pending_vault_keys)?;
    assert_invitation_pending_vault_keys_are_authorized(
        pool,
        &input.team_id,
        user_id,
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
            AppError::internal("Failed to serialize pendingVaultKeys")
        })?)
    };

    query(
		"INSERT INTO team_invitation (id, team_id, email, role, invited_by_id, token_hash, pending_vault_keys, expires_at) VALUES ($1, $2, $3, $4::team_role, $5, $6, $7, $8)",
	)
	.bind(&invitation_id)
	.bind(&input.team_id)
	.bind(&input.email)
	.bind(input.role)
	.bind(user_id)
	.bind(hash_token(&token))
	.bind(serialized_pending_vault_keys)
	.bind(expires_at)
	.execute(pool)
	.await
	.map_err(|error| database_error(error, "Failed to create invitation"))?;

    Ok(SendInvitationResponse {
        invitation_id,
        token,
        existing_user_public_key: existing_user.and_then(|value| value.public_key),
    })
}

/// Loads a still-pending invitation from the raw token handed out at creation
/// time. Only the SHA-256 digest is stored, so the caller's token is hashed
/// before comparison, exactly as session tokens are.
async fn load_pending_invitation_by_token(
    pool: &PgPool,
    token: &str,
) -> Result<DbTeamInvitationAcceptRow, AppError> {
    query_as::<_, DbTeamInvitationAcceptRow>(
		"SELECT ti.id, ti.team_id, t.name AS team_name, ti.email, ti.role::text AS role, ti.invited_by_id, ti.expires_at, t.billing_plan::text AS billing_plan, t.billing_status::text AS billing_status, ti.pending_vault_keys FROM team_invitation ti INNER JOIN team t ON ti.team_id = t.id WHERE ti.token_hash = $1 AND ti.status = 'pending' LIMIT 1",
	)
	.bind(hash_token(token))
	.fetch_optional(pool)
	.await
	.map_err(|error| database_error(error, "Failed to load invitation"))?
	.ok_or_else(|| AppError::not_found("Invitation not found or already used"))
}

/// Loads a still-pending invitation by its opaque id. Used by the in-app pending
/// invitation list, which can no longer surface the raw token. The id is not a
/// bearer credential: every caller re-checks that the invitation email matches
/// the authenticated session user.
async fn load_pending_invitation_by_id(
    pool: &PgPool,
    invitation_id: &str,
) -> Result<DbTeamInvitationAcceptRow, AppError> {
    query_as::<_, DbTeamInvitationAcceptRow>(
		"SELECT ti.id, ti.team_id, t.name AS team_name, ti.email, ti.role::text AS role, ti.invited_by_id, ti.expires_at, t.billing_plan::text AS billing_plan, t.billing_status::text AS billing_status, ti.pending_vault_keys FROM team_invitation ti INNER JOIN team t ON ti.team_id = t.id WHERE ti.id = $1 AND ti.status = 'pending' LIMIT 1",
	)
	.bind(invitation_id)
	.fetch_optional(pool)
	.await
	.map_err(|error| database_error(error, "Failed to load invitation"))?
	.ok_or_else(|| AppError::not_found("Invitation not found or already used"))
}

pub(crate) async fn accept_invitation(
    pool: &PgPool,
    deployment_mode: DeploymentMode,
    billing_gateway: Option<&dyn BillingGateway>,
    user_id: &str,
    input: TokenInput,
) -> Result<AcceptInvitationResponse, AppError> {
    validate_token(&input.token)?;
    let invitation = load_pending_invitation_by_token(pool, &input.token).await?;
    accept_loaded_invitation(pool, deployment_mode, billing_gateway, user_id, invitation).await
}

/// Accepts an invitation the signed-in user already sees in their pending list.
/// Exists because that list no longer exposes the raw token.
pub(crate) async fn accept_invitation_by_id(
    pool: &PgPool,
    deployment_mode: DeploymentMode,
    billing_gateway: Option<&dyn BillingGateway>,
    user_id: &str,
    input: InvitationIdInput,
) -> Result<AcceptInvitationResponse, AppError> {
    let invitation = load_pending_invitation_by_id(pool, &input.invitation_id).await?;
    accept_loaded_invitation(pool, deployment_mode, billing_gateway, user_id, invitation).await
}

async fn accept_loaded_invitation(
    pool: &PgPool,
    deployment_mode: DeploymentMode,
    billing_gateway: Option<&dyn BillingGateway>,
    user_id: &str,
    invitation: DbTeamInvitationAcceptRow,
) -> Result<AcceptInvitationResponse, AppError> {
    if invitation.expires_at < OffsetDateTime::now_utc() {
        query("UPDATE team_invitation SET status = 'expired' WHERE id = $1")
            .bind(&invitation.id)
            .execute(pool)
            .await
            .map_err(|error| database_error(error, "Failed to expire invitation"))?;

        return Err(AppError::bad_request("Invitation has expired"));
    }

    assert_team_management_entitlement(
        deployment_mode,
        invitation.billing_plan,
        invitation.billing_status,
    )?;

    let current_user = load_team_membership_actor(pool, user_id)
        .await?
        .ok_or_else(|| AppError::not_found("User not found"))?;

    if current_user.email != invitation.email {
        return Err(AppError::forbidden("This invitation is not for you"));
    }

    if current_user.team_id.is_some() {
        return Err(AppError::bad_request("You already belong to a team"));
    }

    let pending_keys = parse_pending_vault_keys(invitation.pending_vault_keys.as_deref())?;
    assert_invitation_pending_vault_keys_are_authorized(
        pool,
        &invitation.team_id,
        &invitation.invited_by_id,
        &pending_keys,
    )
    .await?;

    let vault_role = invitation.role.vault_role();

    let mut transaction = pool
        .begin()
        .await
        .map_err(|error| database_error(error, "Failed to start transaction"))?;

    query("UPDATE \"user\" SET team_id = $1, role = $2::team_role WHERE id = $3")
        .bind(&invitation.team_id)
        .bind(invitation.role)
        .bind(user_id)
        .execute(&mut *transaction)
        .await
        .map_err(|error| database_error(error, "Failed to update team membership"))?;

    for pending_key in pending_keys {
        validate_encrypted_vault_key(&pending_key.encrypted_vault_key)?;
        let existing_key = query_scalar::<_, bool>(
            "SELECT EXISTS(SELECT 1 FROM vault_key WHERE vault_id = $1 AND user_id = $2)",
        )
        .bind(&pending_key.vault_id)
        .bind(user_id)
        .fetch_one(&mut *transaction)
        .await
        .map_err(|error| database_error(error, "Failed to load existing vault access"))?;

        if !existing_key {
            query(
				"INSERT INTO vault_key (id, vault_id, user_id, encrypted_vault_key, role) VALUES ($1, $2, $3, $4, $5::vault_role)",
			)
			.bind(generate_resource_id("vault_key"))
			.bind(&pending_key.vault_id)
			.bind(user_id)
			.bind(&pending_key.encrypted_vault_key)
			.bind(vault_role)
			.execute(&mut *transaction)
			.await
			.map_err(|error| database_error(error, "Failed to provision vault access"))?;
        }
    }

    query("UPDATE team_invitation SET status = 'accepted', accepted_at = $1 WHERE id = $2")
        .bind(OffsetDateTime::now_utc())
        .bind(&invitation.id)
        .execute(&mut *transaction)
        .await
        .map_err(|error| database_error(error, "Failed to accept invitation"))?;

    transaction
        .commit()
        .await
        .map_err(|error| database_error(error, "Failed to commit invitation acceptance"))?;

    sync_team_seats_best_effort(
        pool,
        billing_gateway,
        &invitation.team_id,
        invitation.billing_plan,
    )
    .await;

    Ok(AcceptInvitationResponse {
        team_id: invitation.team_id,
        team_name: invitation.team_name,
    })
}

pub(crate) async fn decline_invitation(
    pool: &PgPool,
    user_id: &str,
    input: TokenInput,
) -> Result<SuccessResponse, AppError> {
    validate_token(&input.token)?;
    let invitation = load_pending_invitation_by_token(pool, &input.token).await?;
    decline_loaded_invitation(pool, user_id, invitation).await
}

/// Declines an invitation the signed-in user already sees in their pending list.
/// Exists because that list no longer exposes the raw token.
pub(crate) async fn decline_invitation_by_id(
    pool: &PgPool,
    user_id: &str,
    input: InvitationIdInput,
) -> Result<SuccessResponse, AppError> {
    let invitation = load_pending_invitation_by_id(pool, &input.invitation_id).await?;
    decline_loaded_invitation(pool, user_id, invitation).await
}

async fn decline_loaded_invitation(
    pool: &PgPool,
    user_id: &str,
    invitation: DbTeamInvitationAcceptRow,
) -> Result<SuccessResponse, AppError> {
    let current_user = load_team_membership_actor(pool, user_id)
        .await?
        .ok_or_else(|| AppError::not_found("User not found"))?;

    if current_user.email != invitation.email {
        return Err(AppError::forbidden("This invitation is not for you"));
    }

    query("UPDATE team_invitation SET status = 'declined' WHERE id = $1")
        .bind(&invitation.id)
        .execute(pool)
        .await
        .map_err(|error| database_error(error, "Failed to decline invitation"))?;

    Ok(SuccessResponse { success: true })
}

pub(crate) async fn cancel_invitation(
    pool: &PgPool,
    deployment_mode: DeploymentMode,
    user_id: &str,
    input: InvitationIdInput,
) -> Result<SuccessResponse, AppError> {
    let invitation = query_as::<_, DbManageTeamInvitationRow>(
		"SELECT ti.id, ti.team_id, t.billing_plan::text AS billing_plan, t.billing_status::text AS billing_status FROM team_invitation ti INNER JOIN team t ON ti.team_id = t.id WHERE ti.id = $1 LIMIT 1",
	)
	.bind(&input.invitation_id)
	.fetch_optional(pool)
	.await
	.map_err(|error| database_error(error, "Failed to load invitation"))?
	.ok_or_else(|| AppError::not_found("Invitation not found"))?;

    let actor = load_team_membership_actor(pool, user_id).await?;
    let is_admin_or_owner = actor
        .as_ref()
        .map(|value| {
            value.team_id.as_deref() == Some(invitation.team_id.as_str()) && value.role.can_manage()
        })
        .unwrap_or(false);
    if !is_admin_or_owner {
        return Err(AppError::forbidden("Insufficient permissions"));
    }

    assert_team_management_entitlement(
        deployment_mode,
        invitation.billing_plan,
        invitation.billing_status,
    )?;

    query("DELETE FROM team_invitation WHERE id = $1")
        .bind(&input.invitation_id)
        .execute(pool)
        .await
        .map_err(|error| database_error(error, "Failed to cancel invitation"))?;

    Ok(SuccessResponse { success: true })
}

/// Re-opens an invitation with a freshly minted token.
///
/// Only the SHA-256 digest of an invite token is stored, so the raw token that
/// was handed out at creation time cannot be recovered here. Reviving the row
/// without rotating would therefore produce a `pending` invitation that nobody
/// can redeem. The token is regenerated, the digest replaced, and the new raw
/// token returned once so the caller can hand out a working link.
pub(crate) async fn resend_invitation(
    pool: &PgPool,
    deployment_mode: DeploymentMode,
    user_id: &str,
    input: InvitationIdInput,
) -> Result<ResendInvitationResponse, AppError> {
    let invitation = query_as::<_, DbManageTeamInvitationRow>(
		"SELECT ti.id, ti.team_id, t.billing_plan::text AS billing_plan, t.billing_status::text AS billing_status FROM team_invitation ti INNER JOIN team t ON ti.team_id = t.id WHERE ti.id = $1 LIMIT 1",
	)
	.bind(&input.invitation_id)
	.fetch_optional(pool)
	.await
	.map_err(|error| database_error(error, "Failed to load invitation"))?
	.ok_or_else(|| AppError::not_found("Invitation not found"))?;

    let actor = load_team_membership_actor(pool, user_id).await?;
    let is_admin_or_owner = actor
        .as_ref()
        .map(|value| {
            value.team_id.as_deref() == Some(invitation.team_id.as_str()) && value.role.can_manage()
        })
        .unwrap_or(false);
    if !is_admin_or_owner {
        return Err(AppError::forbidden("Insufficient permissions"));
    }

    assert_team_management_entitlement(
        deployment_mode,
        invitation.billing_plan,
        invitation.billing_status,
    )?;

    let token = generate_secure_token();
    query(
        "UPDATE team_invitation SET token_hash = $1, expires_at = $2, status = 'pending' WHERE id = $3",
    )
    .bind(hash_token(&token))
    .bind(OffsetDateTime::now_utc() + time::Duration::days(7))
    .bind(&input.invitation_id)
    .execute(pool)
    .await
    .map_err(|error| database_error(error, "Failed to resend invitation"))?;

    Ok(ResendInvitationResponse {
        invitation_id: invitation.id,
        token,
    })
}

pub(crate) mod invitation_handlers {
    use super::*;

    #[derive(Debug, Clone, Serialize)]
    #[serde(rename_all = "camelCase")]
    pub struct TeamInvitationListEntry {
        pub id: String,
        pub email: String,
        pub role: TeamRole,
        pub status: InvitationStatus,
        pub invited_by: String,
        pub created_at: String,
        pub expires_at: String,
    }

    pub(crate) async fn list_team_invitations(
        pool: &PgPool,
        deployment_mode: DeploymentMode,
        user_id: &str,
        input: TeamIdInput,
    ) -> Result<Vec<TeamInvitationListEntry>, AppError> {
        let actor = load_team_membership_actor(pool, user_id).await?;
        if actor
            .as_ref()
            .and_then(|value| value.team_id.as_ref())
            .map(|team_id| team_id != &input.team_id)
            .unwrap_or(true)
        {
            return Err(AppError::forbidden("You are not a member of this team"));
        }

        let actor =
            actor.ok_or_else(|| AppError::forbidden("You are not a member of this team"))?;
        ensure_team_admin(actor.role)?;
        assert_optional_team_management_entitlement(
            deployment_mode,
            actor.billing_plan,
            actor.billing_status,
        )?;

        let invitations = query_as::<_, DbTeamInvitationListRow>(
			"SELECT ti.id, ti.email, ti.role::text AS role, ti.status::text AS status, invited_by.name AS invited_by_name, ti.created_at, ti.expires_at FROM team_invitation ti INNER JOIN \"user\" invited_by ON ti.invited_by_id = invited_by.id WHERE ti.team_id = $1 AND ti.status = 'pending' ORDER BY ti.created_at DESC",
		)
		.bind(&input.team_id)
		.fetch_all(pool)
		.await
		.map_err(|error| database_error(error, "Failed to load invitations"))?;

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

fn default_invitation_role() -> TeamRole {
    TeamRole::Member
}

pub(super) fn validate_token(token: &str) -> Result<(), AppError> {
    if token.len() != 32
        || !token.chars().all(|character| {
            character.is_ascii_alphanumeric() || character == '_' || character == '-'
        })
    {
        return Err(AppError::bad_request("Invalid token"));
    }

    Ok(())
}

pub(crate) fn normalize_pending_vault_keys(
    pending_vault_keys: Option<Vec<PendingVaultKeyEntry>>,
) -> Result<Vec<PendingVaultKeyEntry>, AppError> {
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
        if vault_id.is_empty() || validate_encrypted_vault_key(&encrypted_vault_key).is_err() {
            return Err(AppError::bad_request(format!(
                "Invalid pendingVaultKeys entry at index {index}",
            )));
        }

        if !seen_vault_ids.insert(vault_id.clone()) {
            return Err(AppError::bad_request(
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

pub(crate) fn parse_pending_vault_keys(
    raw_pending_vault_keys: Option<&str>,
) -> Result<Vec<PendingVaultKeyEntry>, AppError> {
    let Some(raw_value) = raw_pending_vault_keys else {
        return Ok(Vec::new());
    };
    if raw_value.trim().is_empty() {
        return Ok(Vec::new());
    }

    let parsed = serde_json::from_str::<Vec<PendingVaultKeyEntry>>(raw_value)
        .map_err(|_| AppError::bad_request("Invalid pendingVaultKeys payload"))?;
    normalize_pending_vault_keys(Some(parsed))
}

pub(crate) async fn assert_invitation_pending_vault_keys_are_authorized(
    pool: &PgPool,
    team_id: &str,
    inviter_id: &str,
    pending_vault_keys: &[PendingVaultKeyEntry],
) -> Result<(), AppError> {
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
    .map_err(|error| database_error(error, "Failed to validate pendingVaultKeys vaults"))?;
    if team_vault_count != vault_ids.len() as i64 {
        return Err(AppError::bad_request(
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
	.map_err(|error| database_error(error, "Failed to validate inviter vault access"))?;

    let authorized_vault_ids: HashSet<String> = authorized_vault_roles
        .into_iter()
        .filter(|record| record.role.can_manage())
        .map(|record| record.vault_id)
        .collect();
    if authorized_vault_ids.len() != vault_ids.len() {
        return Err(AppError::forbidden(
            "You do not have permission to grant access for one or more vaults",
        ));
    }

    Ok(())
}
