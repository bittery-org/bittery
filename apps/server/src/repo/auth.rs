use sqlx::{query, query_as, query_scalar, PgPool, Postgres};
use time::OffsetDateTime;

use crate::{
    db::models::*,
    error::AppError,
    integrations::storage,
    repo::common::generate_resource_id,
    services::auth::{
        AuthVaultKeyResponse, EncryptedVaultKeyInput, RecoveryVaultKeyResponse, ValidatedKdfProfile,
    },
    services::session::hash_token,
    services::verification_code::VerificationCodeService,
};

// ---------------------------------------------------------------------------
// User existence checks
// ---------------------------------------------------------------------------

pub async fn ensure_user_does_not_exist(pool: &PgPool, email: &str) -> Result<(), AppError> {
    let existing =
        query_scalar::<_, String>("SELECT id FROM \"user\" WHERE LOWER(email) = $1 LIMIT 1")
            .bind(email)
            .fetch_optional(pool)
            .await
            .map_err(|e| {
                tracing::error!(error = %e, "Failed to check account");
                AppError::internal("Failed to check account")
            })?;
    if existing.is_some() {
        return Err(AppError::bad_request("Unable to create account"));
    }
    Ok(())
}

pub async fn has_any_registered_user(pool: &PgPool) -> Result<bool, AppError> {
    let user_id = query_scalar::<_, String>("SELECT id FROM \"user\" LIMIT 1")
        .fetch_optional(pool)
        .await
        .map_err(|e| {
            tracing::error!(error = %e, "Failed to load registration status");
            AppError::internal("Failed to load registration status")
        })?;
    Ok(user_id.is_some())
}

// ---------------------------------------------------------------------------
// Account creation
// ---------------------------------------------------------------------------

#[derive(Clone, Copy)]
pub struct CreateUserParams<'a> {
    pub user_id: &'a str,
    pub email: &'a str,
    pub name: &'a str,
    pub email_verified: bool,
    pub secret_key_hint: &'a str,
    pub srp_salt: &'a str,
    pub srp_verifier: &'a str,
    pub public_key: &'a str,
    pub encrypted_private_key: &'a str,
    pub encrypted_master_key: Option<&'a str>,
    pub recovery_key_hint: Option<&'a str>,
    pub kdf_profile: ValidatedKdfProfile,
}

pub async fn insert_user_account(
    transaction: &mut sqlx::Transaction<'_, Postgres>,
    params: CreateUserParams<'_>,
) -> Result<(), AppError> {
    query(
        "INSERT INTO \"user\" (id, email, name, email_verified, secret_key_hint, srp_salt, srp_verifier, public_key, encrypted_private_key, encrypted_master_key, recovery_key_hint, kdf_algorithm, kdf_iterations, kdf_schema_version) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)",
    )
    .bind(params.user_id)
    .bind(params.email)
    .bind(params.name)
    .bind(params.email_verified)
    .bind(params.secret_key_hint)
    .bind(params.srp_salt)
    .bind(params.srp_verifier)
    .bind(params.public_key)
    .bind(params.encrypted_private_key)
    .bind(params.encrypted_master_key)
    .bind(params.recovery_key_hint)
    .bind(params.kdf_profile.algorithm)
    .bind(params.kdf_profile.iterations)
    .bind(params.kdf_profile.schema_version)
    .execute(transaction.as_mut())
    .await
    .map_err(|e| {
        tracing::error!(error = %e, "Failed to create user account");
        AppError::bad_request("Unable to create account")
    })?;

    Ok(())
}

#[allow(clippy::too_many_arguments)]
pub async fn insert_team(
    transaction: &mut sqlx::Transaction<'_, Postgres>,
    team_id: &str,
    team_name: &str,
    owner_id: &str,
    team_type: &str,
    member_limit: Option<i32>,
    billing_plan: &str,
    billing_status: &str,
) -> Result<(), AppError> {
    query(
        "INSERT INTO team (id, name, owner_id, type, member_limit, billing_plan, billing_status) VALUES ($1, $2, $3, $4::team_type, $5, $6::billing_plan, $7::billing_status)",
    )
    .bind(team_id)
    .bind(team_name)
    .bind(owner_id)
    .bind(team_type)
    .bind(member_limit)
    .bind(billing_plan)
    .bind(billing_status)
    .execute(transaction.as_mut())
    .await
    .map_err(|e| {
        tracing::error!(error = %e, "Failed to create team");
        AppError::internal("Failed to create team")
    })?;

    Ok(())
}

pub async fn insert_personal_vault(
    transaction: &mut sqlx::Transaction<'_, Postgres>,
    vault_id: &str,
    user_id: &str,
    encrypted_vault_key: &str,
) -> Result<(), AppError> {
    query(
        "INSERT INTO vault (id, name, type, icon, created_by_id) VALUES ($1, 'Personal', 'personal'::vault_type, 'lock', $2)",
    )
    .bind(vault_id)
    .bind(user_id)
    .execute(transaction.as_mut())
    .await
    .map_err(|e| {
        tracing::error!(error = %e, "Failed to create personal vault");
        AppError::internal("Failed to create personal vault")
    })?;
    query(
        "INSERT INTO vault_key (id, vault_id, user_id, encrypted_vault_key, role) VALUES ($1, $2, $3, $4, 'owner')",
    )
    .bind(generate_resource_id("vault_key"))
    .bind(vault_id)
    .bind(user_id)
    .bind(encrypted_vault_key)
    .execute(transaction.as_mut())
    .await
    .map_err(|e| {
        tracing::error!(error = %e, "Failed to create personal vault key");
        AppError::internal("Failed to create personal vault key")
    })?;

    Ok(())
}

// ---------------------------------------------------------------------------
// Account mutations
// ---------------------------------------------------------------------------

pub async fn store_recovery_key_data(
    pool: &PgPool,
    user_id: &str,
    encrypted_master_key: &str,
    recovery_key_hint: &str,
) -> Result<(), AppError> {
    query("UPDATE \"user\" SET encrypted_master_key = $1, recovery_key_hint = $2 WHERE id = $3")
        .bind(encrypted_master_key)
        .bind(recovery_key_hint)
        .bind(user_id)
        .execute(pool)
        .await
        .map_err(|e| {
            tracing::error!(error = %e, "Failed to store recovery key");
            AppError::internal("Failed to store recovery key")
        })?;
    Ok(())
}

pub async fn delete_user_account_data(pool: &PgPool, user_id: &str) -> Result<(), AppError> {
    query("DELETE FROM \"user\" WHERE id = $1")
        .bind(user_id)
        .execute(pool)
        .await
        .map_err(|e| {
            tracing::error!(error = %e, "Failed to delete account");
            AppError::internal("Failed to delete account")
        })?;
    Ok(())
}

pub async fn apply_encrypted_vault_key_updates(
    transaction: &mut sqlx::Transaction<'_, Postgres>,
    user_id: &str,
    encrypted_vault_keys: &[EncryptedVaultKeyInput],
) -> Result<(), AppError> {
    for vault_key in encrypted_vault_keys {
        query("UPDATE vault_key SET encrypted_vault_key = $1 WHERE vault_id = $2 AND user_id = $3")
            .bind(&vault_key.encrypted_vault_key)
            .bind(&vault_key.vault_id)
            .bind(user_id)
            .execute(&mut **transaction)
            .await
            .map_err(|e| {
                tracing::error!(error = %e, "Failed to update vault keys");
                AppError::internal("Failed to update vault keys")
            })?;
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
pub async fn update_user_email_data(
    pool: &PgPool,
    user_id: &str,
    new_email: &str,
    srp_salt: &str,
    srp_verifier: &str,
    encrypted_private_key: &str,
    encrypted_vault_keys: &[EncryptedVaultKeyInput],
    kdf: ValidatedKdfProfile,
) -> Result<(), AppError> {
    let mut transaction = pool.begin().await.map_err(|e| {
        tracing::error!(error = %e, "Failed to start email update transaction");
        AppError::internal("Failed to start email update transaction")
    })?;
    query(
        "UPDATE \"user\" SET email = $1, srp_salt = $2, srp_verifier = $3, encrypted_private_key = $4, encrypted_master_key = NULL, recovery_key_hint = NULL, kdf_algorithm = $5, kdf_iterations = $6, kdf_schema_version = $7 WHERE id = $8",
    )
    .bind(new_email)
    .bind(srp_salt)
    .bind(srp_verifier)
    .bind(encrypted_private_key)
    .bind(kdf.algorithm)
    .bind(kdf.iterations)
    .bind(kdf.schema_version)
    .bind(user_id)
    .execute(transaction.as_mut())
    .await
    .map_err(|e| {
        tracing::error!(error = %e, "Failed to update email");
        AppError::internal("Failed to update email")
    })?;
    apply_encrypted_vault_key_updates(&mut transaction, user_id, encrypted_vault_keys).await?;
    transaction.commit().await.map_err(|e| {
        tracing::error!(error = %e, "Failed to commit email update");
        AppError::internal("Failed to commit email update")
    })?;
    Ok(())
}

pub async fn update_user_password_data(
    pool: &PgPool,
    user_id: &str,
    srp_salt: &str,
    srp_verifier: &str,
    encrypted_private_key: &str,
    encrypted_vault_keys: &[EncryptedVaultKeyInput],
    kdf: ValidatedKdfProfile,
) -> Result<(), AppError> {
    let mut transaction = pool.begin().await.map_err(|e| {
        tracing::error!(error = %e, "Failed to start password update transaction");
        AppError::internal("Failed to start password update transaction")
    })?;
    query(
        "UPDATE \"user\" SET srp_salt = $1, srp_verifier = $2, encrypted_private_key = $3, encrypted_master_key = NULL, recovery_key_hint = NULL, kdf_algorithm = $4, kdf_iterations = $5, kdf_schema_version = $6 WHERE id = $7",
    )
    .bind(srp_salt)
    .bind(srp_verifier)
    .bind(encrypted_private_key)
    .bind(kdf.algorithm)
    .bind(kdf.iterations)
    .bind(kdf.schema_version)
    .bind(user_id)
    .execute(transaction.as_mut())
    .await
    .map_err(|e| {
        tracing::error!(error = %e, "Failed to update password");
        AppError::internal("Failed to update password")
    })?;
    apply_encrypted_vault_key_updates(&mut transaction, user_id, encrypted_vault_keys).await?;
    transaction.commit().await.map_err(|e| {
        tracing::error!(error = %e, "Failed to commit password update");
        AppError::internal("Failed to commit password update")
    })?;
    Ok(())
}

#[allow(clippy::too_many_arguments)]
pub async fn update_user_secret_key_data(
    pool: &PgPool,
    user_id: &str,
    secret_key_hint: &str,
    srp_salt: &str,
    srp_verifier: &str,
    encrypted_private_key: &str,
    encrypted_vault_keys: &[EncryptedVaultKeyInput],
    kdf: ValidatedKdfProfile,
) -> Result<(), AppError> {
    let mut transaction = pool.begin().await.map_err(|e| {
        tracing::error!(error = %e, "Failed to start secret key transaction");
        AppError::internal("Failed to start secret key transaction")
    })?;
    query(
        "UPDATE \"user\" SET secret_key_hint = $1, srp_salt = $2, srp_verifier = $3, encrypted_private_key = $4, encrypted_master_key = NULL, recovery_key_hint = NULL, kdf_algorithm = $5, kdf_iterations = $6, kdf_schema_version = $7 WHERE id = $8",
    )
    .bind(secret_key_hint)
    .bind(srp_salt)
    .bind(srp_verifier)
    .bind(encrypted_private_key)
    .bind(kdf.algorithm)
    .bind(kdf.iterations)
    .bind(kdf.schema_version)
    .bind(user_id)
    .execute(transaction.as_mut())
    .await
    .map_err(|e| {
        tracing::error!(error = %e, "Failed to regenerate secret key");
        AppError::internal("Failed to regenerate secret key")
    })?;
    apply_encrypted_vault_key_updates(&mut transaction, user_id, encrypted_vault_keys).await?;
    transaction.commit().await.map_err(|e| {
        tracing::error!(error = %e, "Failed to commit secret key update");
        AppError::internal("Failed to commit secret key update")
    })?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Recovery flow queries
// ---------------------------------------------------------------------------

#[allow(clippy::too_many_arguments)]
pub async fn reset_user_password_with_recovery(
    pool: &PgPool,
    verification_id: &str,
    expected_user_id: &str,
    srp_salt: &str,
    srp_verifier: &str,
    encrypted_private_key: &str,
    encrypted_master_key: &str,
    recovery_key_hint: &str,
    secret_key_hint: Option<&str>,
    encrypted_vault_keys: &[EncryptedVaultKeyInput],
    kdf: ValidatedKdfProfile,
) -> Result<(String, Vec<String>), AppError> {
    let now = OffsetDateTime::now_utc();
    let mut transaction = pool.begin().await.map_err(|e| {
        tracing::error!(error = %e, "Failed to start recovery reset transaction");
        AppError::internal("Failed to start recovery reset transaction")
    })?;

    let verification = query_as::<_, DbRecoveryVerificationRow>(
        "SELECT id, email, code_hash, attempts, max_attempts, expires_at, used_at, created_at FROM recovery_verification WHERE id = $1 AND expires_at > $2 AND used_at IS NOT NULL AND attempts < max_attempts FOR UPDATE",
    )
    .bind(verification_id)
    .bind(now)
    .fetch_optional(transaction.as_mut())
    .await
    .map_err(|e| {
        tracing::error!(error = %e, "Failed to load recovery verification");
        AppError::internal("Failed to load recovery verification")
    })?
    .ok_or_else(|| AppError::unauthorized("Invalid recovery session"))?;

    let user_id = query_scalar::<_, String>(
        "SELECT id FROM \"user\" WHERE id = $1 AND LOWER(email) = LOWER($2) LIMIT 1",
    )
    .bind(expected_user_id)
    .bind(&verification.email)
    .fetch_optional(transaction.as_mut())
    .await
    .map_err(|e| {
        tracing::error!(error = %e, "Failed to load recovery account");
        AppError::internal("Failed to load recovery account")
    })?
    .ok_or_else(|| AppError::unauthorized("Invalid recovery session"))?;
    let revoked_session_ids =
        query_scalar::<_, String>("SELECT id FROM session WHERE user_id = $1 FOR UPDATE")
            .bind(&user_id)
            .fetch_all(transaction.as_mut())
            .await
            .map_err(|e| {
                tracing::error!(error = %e, "Failed to load recovery sessions");
                AppError::internal("Failed to load recovery sessions")
            })?;

    query(
        "UPDATE \"user\" SET srp_salt = $1, srp_verifier = $2, encrypted_private_key = $3, encrypted_master_key = $4, recovery_key_hint = $5, secret_key_hint = COALESCE($6, secret_key_hint), kdf_algorithm = $7, kdf_iterations = $8, kdf_schema_version = $9 WHERE id = $10",
    )
    .bind(srp_salt)
    .bind(srp_verifier)
    .bind(encrypted_private_key)
    .bind(encrypted_master_key)
    .bind(recovery_key_hint)
    .bind(secret_key_hint)
    .bind(kdf.algorithm)
    .bind(kdf.iterations)
    .bind(kdf.schema_version)
    .bind(&user_id)
    .execute(transaction.as_mut())
    .await
    .map_err(|e| {
        tracing::error!(error = %e, "Failed to update recovery credentials");
        AppError::internal("Failed to update recovery credentials")
    })?;

    for vault_key in encrypted_vault_keys {
        query("UPDATE vault_key SET encrypted_vault_key = $1 WHERE vault_id = $2 AND user_id = $3")
            .bind(&vault_key.encrypted_vault_key)
            .bind(&vault_key.vault_id)
            .bind(&user_id)
            .execute(transaction.as_mut())
            .await
            .map_err(|e| {
                tracing::error!(error = %e, "Failed to update recovery vault keys");
                AppError::internal("Failed to update recovery vault keys")
            })?;
    }

    query("DELETE FROM session WHERE user_id = $1")
        .bind(&user_id)
        .execute(transaction.as_mut())
        .await
        .map_err(|e| {
            tracing::error!(error = %e, "Failed to revoke sessions after recovery");
            AppError::internal("Failed to revoke sessions after recovery")
        })?;
    if !VerificationCodeService::new(pool)
        .consume_recovery_session(&mut transaction, &verification.id)
        .await?
    {
        return Err(AppError::unauthorized("Invalid recovery session"));
    }

    transaction.commit().await.map_err(|e| {
        tracing::error!(error = %e, "Failed to commit recovery reset");
        AppError::internal("Failed to commit recovery reset")
    })?;

    Ok((user_id, revoked_session_ids))
}

pub async fn load_recovery_data(
    pool: &PgPool,
    verification_id: &str,
    expected_user_id: &str,
) -> Result<Option<DbRecoveryUserDataRow>, AppError> {
    let now = OffsetDateTime::now_utc();
    let user = query_as::<_, DbRecoveryUserDataRow>(
        "SELECT u.id, u.encrypted_master_key, u.encrypted_private_key, u.secret_key_hint, u.recovery_key_hint FROM recovery_verification rv INNER JOIN \"user\" u ON LOWER(u.email) = LOWER(rv.email) WHERE rv.id = $1 AND rv.expires_at > $2 AND rv.used_at IS NOT NULL AND rv.attempts < rv.max_attempts AND u.id = $3 AND u.encrypted_master_key IS NOT NULL LIMIT 1",
    )
    .bind(verification_id)
    .bind(now)
    .bind(expected_user_id)
    .fetch_optional(pool)
    .await
    .map_err(|e| {
        tracing::error!(error = %e, "Failed to load recovery account");
        AppError::internal("Failed to load recovery account")
    })?;

    Ok(user)
}

pub async fn load_recovery_vault_keys(
    pool: &PgPool,
    user_id: &str,
) -> Result<Vec<RecoveryVaultKeyResponse>, AppError> {
    let rows = query_as::<_, DbRecoveryVaultKeyRow>(
        "SELECT vk.vault_id, vk.encrypted_vault_key, v.created_by_id FROM vault_key vk INNER JOIN vault v ON v.id = vk.vault_id WHERE vk.user_id = $1 ORDER BY vk.created_at DESC",
    )
    .bind(user_id)
    .fetch_all(pool)
    .await
    .map_err(|e| {
        tracing::error!(error = %e, "Failed to load recovery vault keys");
        AppError::internal("Failed to load recovery vault keys")
    })?;

    Ok(rows
        .into_iter()
        .map(|row| RecoveryVaultKeyResponse {
            vault_id: row.vault_id,
            encrypted_vault_key: row.encrypted_vault_key,
            created_by_id: row.created_by_id,
        })
        .collect())
}

pub async fn load_auth_vault_keys(
    pool: &PgPool,
    user_id: &str,
) -> Result<Vec<AuthVaultKeyResponse>, AppError> {
    let rows = query_as::<_, DbAuthVaultKeyRow>(
        "SELECT vk.vault_id, v.name AS vault_name, v.type::text AS vault_type, v.icon AS vault_icon, v.image_key AS vault_image_key, vk.encrypted_vault_key, vk.role::text AS role FROM vault_key vk INNER JOIN vault v ON v.id = vk.vault_id WHERE vk.user_id = $1 ORDER BY v.created_at ASC",
    )
    .bind(user_id)
    .fetch_all(pool)
    .await
    .map_err(|e| {
        tracing::error!(error = %e, "Failed to load vault keys");
        AppError::internal("Failed to load vault keys")
    })?;

    Ok(rows
        .into_iter()
        .map(|row| AuthVaultKeyResponse {
            vault_id: row.vault_id,
            vault_name: row.vault_name,
            vault_type: row.vault_type,
            vault_icon: row.vault_icon,
            vault_image_url: row
                .vault_image_key
                .as_deref()
                .and_then(storage::public_asset_url),
            encrypted_vault_key: row.encrypted_vault_key,
            role: row.role,
        })
        .collect())
}

// ---------------------------------------------------------------------------
// Invitation queries
// ---------------------------------------------------------------------------

pub async fn get_pending_invitation_for_signup(
    pool: &PgPool,
    invitation_token: &str,
    normalized_email: &str,
    is_self_hosted: bool,
) -> Result<DbTeamInvitationAcceptRow, AppError> {
    let invitation = query_as::<_, DbTeamInvitationAcceptRow>(
        "SELECT ti.id, ti.team_id, t.name AS team_name, ti.email, ti.role::text AS role, ti.invited_by_id, ti.expires_at, t.billing_plan::text AS billing_plan, t.billing_status::text AS billing_status, ti.pending_vault_keys FROM team_invitation ti INNER JOIN team t ON ti.team_id = t.id WHERE ti.token_hash = $1 AND ti.status = 'pending' LIMIT 1",
    )
    .bind(hash_token(invitation_token))
    .fetch_optional(pool)
    .await
    .map_err(|e| {
        tracing::error!(error = %e, "Failed to load invitation");
        AppError::internal("Failed to load invitation")
    })?
    .ok_or_else(|| AppError::not_found("Invitation not found or already used"))?;

    if !check_team_management_enabled(
        is_self_hosted,
        &invitation.billing_plan,
        &invitation.billing_status,
    ) {
        return Err(AppError::forbidden(
            "This team cannot accept invitations on its current plan or billing status.",
        ));
    }
    if invitation.expires_at < OffsetDateTime::now_utc() {
        return Err(AppError::bad_request("Invitation has expired"));
    }
    if !emails_match(&invitation.email, normalized_email) {
        return Err(AppError::bad_request("Email does not match invitation"));
    }

    Ok(invitation)
}

pub async fn get_pending_signup_invitation(
    pool: &PgPool,
    invitation_token: &str,
    normalized_email: &str,
    is_self_hosted: bool,
) -> Result<DbSignupInvitationRow, AppError> {
    let invitation = query_as::<_, DbSignupInvitationRow>(
        "SELECT ti.id, ti.team_id, t.name AS team_name, t.type::text AS team_type, t.image_key AS team_image_key, ti.email, ti.role::text AS role, ti.invited_by_id, ti.expires_at, t.member_limit, t.billing_plan::text AS billing_plan, t.billing_status::text AS billing_status, ti.pending_vault_keys FROM team_invitation ti INNER JOIN team t ON ti.team_id = t.id WHERE ti.token_hash = $1 AND ti.status = 'pending' LIMIT 1",
    )
    .bind(hash_token(invitation_token))
    .fetch_optional(pool)
    .await
    .map_err(|e| {
        tracing::error!(error = %e, "Failed to load invitation");
        AppError::internal("Failed to load invitation")
    })?
    .ok_or_else(|| AppError::not_found("Invitation not found or already used"))?;

    if !check_team_management_enabled(
        is_self_hosted,
        &invitation.billing_plan,
        &invitation.billing_status,
    ) {
        return Err(AppError::forbidden(
            "This team cannot accept invitations on its current plan or billing status.",
        ));
    }
    if invitation.expires_at < OffsetDateTime::now_utc() {
        return Err(AppError::bad_request("Invitation has expired"));
    }
    if !emails_match(&invitation.email, normalized_email) {
        return Err(AppError::bad_request("Email does not match invitation"));
    }

    Ok(invitation)
}

pub async fn assert_pending_vault_keys_authorized(
    pool: &PgPool,
    team_id: &str,
    inviter_id: &str,
    pending_vault_keys: &[crate::services::auth::PendingVaultKeyEntry],
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
    .map_err(|e| {
        tracing::error!(error = %e, "Failed to validate pendingVaultKeys vaults");
        AppError::internal("Failed to validate pendingVaultKeys vaults")
    })?;
    if team_vault_count != vault_ids.len() as i64 {
        return Err(AppError::bad_request(
            "pendingVaultKeys contains vaults outside the invited team",
        ));
    }
    let authorized_roles = query_as::<_, DbVaultRoleRow>(
        "SELECT vault_id, role::text AS role FROM vault_key WHERE user_id = $1 AND vault_id = ANY($2)",
    )
    .bind(inviter_id)
    .bind(&vault_ids)
    .fetch_all(pool)
    .await
    .map_err(|e| {
        tracing::error!(error = %e, "Failed to validate inviter vault access");
        AppError::internal("Failed to validate inviter vault access")
    })?;
    let authorized_vault_ids: std::collections::HashSet<String> = authorized_roles
        .into_iter()
        .filter(|record| record.role == "owner" || record.role == "admin")
        .map(|record| record.vault_id)
        .collect();
    if authorized_vault_ids.len() != vault_ids.len() {
        return Err(AppError::forbidden(
            "You do not have permission to grant access for one or more vaults",
        ));
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

fn check_team_management_enabled(
    is_self_hosted: bool,
    billing_plan: &str,
    billing_status: &str,
) -> bool {
    if is_self_hosted {
        return true;
    }
    matches!(billing_plan, "family" | "team") && matches!(billing_status, "active" | "trialing")
}

fn emails_match(invitation_email: &str, normalized_email: &str) -> bool {
    invitation_email.trim().to_lowercase() == normalized_email
}
