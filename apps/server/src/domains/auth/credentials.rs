use super::{
    bad_request_handler_error, enforce_window_limit, validate_hex_string, validate_resource_id,
    ChangePasswordInput, EncryptedVaultKeyInput, LogoutResponse, RegenerateSecretKeyInput,
    StoreRecoveryKeyInput, UpdateEmailInput, ValidatedKdfProfile,
};
use bittery_crypto_core::normalize_email;
use serde_json::json;
use sqlx::{query, query_as, query_scalar, PgPool, Postgres};

use crate::{
    db::events::{generate_resource_id, insert_audit_event},
    domains::{
        sessions::{control::record_session_revocations, service::VerifiedSession},
        vaults::key::validate_encrypted_vault_key,
    },
    error::AppError,
    shared::{
        rate_limit::{
            account_mutation_limit, SCOPE_CHANGE_PASSWORD_USER, SCOPE_REGENERATE_SECRET_KEY_USER,
            SCOPE_UPDATE_EMAIL_USER,
        },
        transaction::database_error,
    },
    AppState,
};
pub(crate) async fn update_email(
    app_state: &AppState,
    session: &VerifiedSession,
    input: UpdateEmailInput,
) -> Result<LogoutResponse, AppError> {
    enforce_account_mutation_limit(app_state, session, SCOPE_UPDATE_EMAIL_USER).await?;
    validate_hex_string(&input.srp_salt, "Invalid SRP salt")?;
    validate_hex_string(&input.srp_verifier, "Invalid SRP verifier")?;
    let kdf_profile = ValidatedKdfProfile::try_from(&input.kdf_params)?;
    validate_encrypted_vault_keys(&input.encrypted_vault_keys)?;
    let pool = &app_state.db_pool;
    let normalized_new_email = normalize_email(&input.new_email);
    let existing_user_id =
        query_scalar::<_, String>("SELECT id FROM \"user\" WHERE LOWER(email) = $1 LIMIT 1")
            .bind(&normalized_new_email)
            .fetch_optional(pool)
            .await
            .map_err(|error| database_error(error, "Failed to check email"))?;
    if existing_user_id
        .as_deref()
        .is_some_and(|value| value != session.user_id)
    {
        return Err(bad_request_handler_error("Email already in use"));
    }

    update_user_email_data(
        pool,
        &session.user_id,
        &normalized_new_email,
        &input,
        kdf_profile,
    )
    .await?;
    let revoked_session_ids = app_state
        .sessions
        .delete_all_user_sessions(&session.user_id)
        .await?;
    record_session_revocations(
        pool,
        &session.user_id,
        &revoked_session_ids,
        "email_changed",
    )
    .await
    .map_err(|error| database_error(error, "Failed to record session revocations"))?;
    insert_audit_event(
        pool,
        &generate_resource_id("audit"),
        &session.user_id,
        "email_changed",
        "user",
        &session.user_id,
        Some(json!({ "newEmail": normalized_new_email, "vaultKeysUpdated": input.encrypted_vault_keys.len() })),
    )
    .await
    .map_err(|error| {
        tracing::error!(error = %error, "Failed to record email change audit event");
        AppError::internal("Failed to record email change audit event")
    })?;

    Ok(LogoutResponse { success: true })
}

pub(crate) async fn change_password(
    app_state: &AppState,
    session: &VerifiedSession,
    input: ChangePasswordInput,
) -> Result<LogoutResponse, AppError> {
    enforce_account_mutation_limit(app_state, session, SCOPE_CHANGE_PASSWORD_USER).await?;
    validate_hex_string(&input.srp_salt, "Invalid SRP salt")?;
    validate_hex_string(&input.srp_verifier, "Invalid SRP verifier")?;
    let kdf_profile = ValidatedKdfProfile::try_from(&input.kdf_params)?;
    validate_encrypted_vault_keys(&input.encrypted_vault_keys)?;
    let pool = &app_state.db_pool;

    update_user_password_data(pool, &session.user_id, &input, kdf_profile).await?;
    let revoked_session_ids = app_state
        .sessions
        .delete_all_user_sessions(&session.user_id)
        .await?;
    record_session_revocations(
        pool,
        &session.user_id,
        &revoked_session_ids,
        "password_changed",
    )
    .await
    .map_err(|error| database_error(error, "Failed to record session revocations"))?;
    insert_audit_event(
        pool,
        &generate_resource_id("audit"),
        &session.user_id,
        "password_changed",
        "user",
        &session.user_id,
        Some(json!({ "vaultKeysUpdated": input.encrypted_vault_keys.len() })),
    )
    .await
    .map_err(|error| {
        tracing::error!(error = %error, "Failed to record password change audit event");
        AppError::internal("Failed to record password change audit event")
    })?;

    Ok(LogoutResponse { success: true })
}

pub(crate) async fn regenerate_secret_key(
    app_state: &AppState,
    session: &VerifiedSession,
    input: RegenerateSecretKeyInput,
) -> Result<LogoutResponse, AppError> {
    enforce_account_mutation_limit(app_state, session, SCOPE_REGENERATE_SECRET_KEY_USER).await?;
    validate_hex_string(&input.srp_salt, "Invalid SRP salt")?;
    validate_hex_string(&input.srp_verifier, "Invalid SRP verifier")?;
    let kdf_profile = ValidatedKdfProfile::try_from(&input.kdf_params)?;
    validate_encrypted_vault_keys(&input.encrypted_vault_keys)?;
    let pool = &app_state.db_pool;

    update_user_secret_key_data(pool, &session.user_id, &input, kdf_profile).await?;
    let revoked_session_ids = app_state
        .sessions
        .delete_other_user_sessions(&session.user_id, &session.session_id)
        .await?;
    record_session_revocations(
        pool,
        &session.user_id,
        &revoked_session_ids,
        "secret_key_regenerated",
    )
    .await
    .map_err(|error| database_error(error, "Failed to record session revocations"))?;
    insert_audit_event(
        pool,
        &generate_resource_id("audit"),
        &session.user_id,
        "secret_key_regenerated",
        "user",
        &session.user_id,
        Some(json!({ "vaultKeysUpdated": input.encrypted_vault_keys.len() })),
    )
    .await
    .map_err(|error| {
        tracing::error!(error = %error, "Failed to record secret key regeneration audit event");
        AppError::internal("Failed to record secret key regeneration audit event")
    })?;

    Ok(LogoutResponse { success: true })
}

pub(crate) async fn store_recovery_key(
    app_state: &AppState,
    session: &VerifiedSession,
    input: StoreRecoveryKeyInput,
) -> Result<LogoutResponse, AppError> {
    let pool = &app_state.db_pool;
    let user = query_as::<_, DbAccountMutationUserRow>(
        "SELECT encrypted_master_key FROM \"user\" WHERE id = $1 LIMIT 1",
    )
    .bind(&session.user_id)
    .fetch_optional(pool)
    .await
    .map_err(|error| database_error(error, "Failed to load user"))?
    .ok_or_else(|| AppError::not_found("User not found"))?;
    let had_recovery_key = user.encrypted_master_key.is_some();

    store_recovery_key_data(pool, &session.user_id, &input).await?;
    insert_audit_event(
        pool,
        &generate_resource_id("audit"),
        &session.user_id,
        if had_recovery_key {
            "recovery_key_regenerated"
        } else {
            "recovery_key_setup"
        },
        "user",
        &session.user_id,
        None,
    )
    .await
    .map_err(|error| {
        tracing::error!(error = %error, "Failed to record recovery key audit event");
        AppError::internal("Failed to record recovery key audit event")
    })?;

    Ok(LogoutResponse { success: true })
}

async fn enforce_account_mutation_limit(
    app_state: &AppState,
    session: &VerifiedSession,
    scope: &str,
) -> Result<(), AppError> {
    enforce_window_limit(
        app_state.rate_limiter.as_ref(),
        scope,
        &session.user_id,
        account_mutation_limit(&app_state.config.rate_limit),
    )
    .await
}

pub(super) fn validate_encrypted_vault_keys(
    encrypted_vault_keys: &[EncryptedVaultKeyInput],
) -> Result<(), AppError> {
    for entry in encrypted_vault_keys {
        validate_resource_id(&entry.vault_id)?;
        validate_encrypted_vault_key(&entry.encrypted_vault_key)?;
    }
    Ok(())
}

async fn update_user_email_data(
    pool: &PgPool,
    user_id: &str,
    new_email: &str,
    input: &UpdateEmailInput,
    kdf_profile: ValidatedKdfProfile,
) -> Result<(), AppError> {
    let mut transaction = pool
        .begin()
        .await
        .map_err(|error| database_error(error, "Failed to start email update transaction"))?;
    query(
        "UPDATE \"user\" SET email = $1, srp_salt = $2, srp_verifier = $3, encrypted_private_key = $4, encrypted_master_key = NULL, recovery_key_hint = NULL, kdf_algorithm = $5, kdf_iterations = $6, kdf_schema_version = $7 WHERE id = $8",
    )
    .bind(new_email)
    .bind(&input.srp_salt)
    .bind(&input.srp_verifier)
    .bind(&input.encrypted_private_key)
    .bind(kdf_profile.algorithm)
    .bind(kdf_profile.iterations)
    .bind(kdf_profile.schema_version)
    .bind(user_id)
    .execute(transaction.as_mut())
    .await
    .map_err(|error| database_error(error, "Failed to update email"))?;
    apply_encrypted_vault_key_updates(&mut transaction, user_id, &input.encrypted_vault_keys)
        .await?;
    transaction
        .commit()
        .await
        .map_err(|error| database_error(error, "Failed to commit email update"))
}

async fn update_user_password_data(
    pool: &PgPool,
    user_id: &str,
    input: &ChangePasswordInput,
    kdf_profile: ValidatedKdfProfile,
) -> Result<(), AppError> {
    let mut transaction = pool
        .begin()
        .await
        .map_err(|error| database_error(error, "Failed to start password update transaction"))?;
    query(
        "UPDATE \"user\" SET srp_salt = $1, srp_verifier = $2, encrypted_private_key = $3, encrypted_master_key = NULL, recovery_key_hint = NULL, kdf_algorithm = $4, kdf_iterations = $5, kdf_schema_version = $6 WHERE id = $7",
    )
    .bind(&input.srp_salt)
    .bind(&input.srp_verifier)
    .bind(&input.encrypted_private_key)
    .bind(kdf_profile.algorithm)
    .bind(kdf_profile.iterations)
    .bind(kdf_profile.schema_version)
    .bind(user_id)
    .execute(transaction.as_mut())
    .await
    .map_err(|error| database_error(error, "Failed to update password"))?;
    apply_encrypted_vault_key_updates(&mut transaction, user_id, &input.encrypted_vault_keys)
        .await?;
    transaction
        .commit()
        .await
        .map_err(|error| database_error(error, "Failed to commit password update"))
}

async fn update_user_secret_key_data(
    pool: &PgPool,
    user_id: &str,
    input: &RegenerateSecretKeyInput,
    kdf_profile: ValidatedKdfProfile,
) -> Result<(), AppError> {
    let mut transaction = pool
        .begin()
        .await
        .map_err(|error| database_error(error, "Failed to start secret key transaction"))?;
    query(
        "UPDATE \"user\" SET secret_key_hint = $1, srp_salt = $2, srp_verifier = $3, encrypted_private_key = $4, encrypted_master_key = NULL, recovery_key_hint = NULL, kdf_algorithm = $5, kdf_iterations = $6, kdf_schema_version = $7 WHERE id = $8",
    )
    .bind(&input.secret_key_hint)
    .bind(&input.srp_salt)
    .bind(&input.srp_verifier)
    .bind(&input.encrypted_private_key)
    .bind(kdf_profile.algorithm)
    .bind(kdf_profile.iterations)
    .bind(kdf_profile.schema_version)
    .bind(user_id)
    .execute(transaction.as_mut())
    .await
    .map_err(|error| database_error(error, "Failed to regenerate secret key"))?;
    apply_encrypted_vault_key_updates(&mut transaction, user_id, &input.encrypted_vault_keys)
        .await?;
    transaction
        .commit()
        .await
        .map_err(|error| database_error(error, "Failed to commit secret key update"))
}

async fn store_recovery_key_data(
    pool: &PgPool,
    user_id: &str,
    input: &StoreRecoveryKeyInput,
) -> Result<(), AppError> {
    query("UPDATE \"user\" SET encrypted_master_key = $1, recovery_key_hint = $2 WHERE id = $3")
        .bind(&input.encrypted_master_key)
        .bind(&input.recovery_key_hint)
        .bind(user_id)
        .execute(pool)
        .await
        .map_err(|error| database_error(error, "Failed to store recovery key"))?;
    Ok(())
}

async fn apply_encrypted_vault_key_updates(
    transaction: &mut sqlx::Transaction<'_, Postgres>,
    user_id: &str,
    encrypted_vault_keys: &[EncryptedVaultKeyInput],
) -> Result<(), AppError> {
    for vault_key in encrypted_vault_keys {
        validate_encrypted_vault_key(&vault_key.encrypted_vault_key)?;
        query("UPDATE vault_key SET encrypted_vault_key = $1 WHERE vault_id = $2 AND user_id = $3")
            .bind(&vault_key.encrypted_vault_key)
            .bind(&vault_key.vault_id)
            .bind(user_id)
            .execute(&mut **transaction)
            .await
            .map_err(|error| database_error(error, "Failed to update vault keys"))?;
    }
    Ok(())
}
#[derive(Debug, sqlx::FromRow)]
struct DbAccountMutationUserRow {
    encrypted_master_key: Option<String>,
}
