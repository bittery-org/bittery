use super::{
    encode_hs256_token, enforce_window_limit, hash_normalized_email, request_ip_key,
    validate_hex_string, GetRecoveryDataInput, GetRecoveryDataResponse, LogoutResponse,
    RecoveryVaultKeyResponse, RequestRecoveryVerificationInput, ResetPasswordInput,
    ResetPasswordResponse, ValidatedKdfProfile, VerifyRecoveryCodeInput,
    VerifyRecoveryCodeResponse, JWT_ISSUER,
};
use bittery_crypto_core::normalize_email;
use jsonwebtoken::{decode, Algorithm, DecodingKey, Validation};
use serde::{Deserialize, Serialize};
use serde_json::json;
use sqlx::{query, query_as, query_scalar, FromRow, PgPool};
use time::{Duration, OffsetDateTime};
use tracing::info;

const RECOVERY_JWT_AUDIENCE: &str = "bittery-recovery";
const RECOVERY_VERIFICATION_TTL_MINUTES: i64 = 15;

use crate::{
    config::AuthConfig,
    db::events::{generate_resource_id, insert_audit_event},
    db::models::DbRecoveryVerificationRow,
    domains::{
        auth::verification_code::{
            LockoutVerificationCodeOutcome, VerificationCodeService, VerificationPurpose,
        },
        sessions::{
            control::record_session_revocations,
            service::{format_rfc3339, now_utc, RequestMetadata},
        },
        vaults::key::validate_encrypted_vault_key,
    },
    error::AppError,
    shared::{
        rate_limit::{self, generic_ip_limit, rate_limited_error, recovery_request_limit},
        transaction::database_error,
    },
    AppState,
};

fn unauthorized_handler_error(message: &str) -> AppError {
    AppError::unauthorized(message)
}
pub(crate) async fn request_recovery_verification(
    app_state: &AppState,
    request: &RequestMetadata,
    input: RequestRecoveryVerificationInput,
) -> Result<LogoutResponse, AppError> {
    let pool = &app_state.db_pool;
    let normalized_email = normalize_email(&input.email);

    // Two independent counters rather than one composite `email:ip` key: a composite
    // key mints a fresh budget for every new pair, so rotating IPs for one email (or
    // emails from one IP) would bypass the limit entirely. The email dimension caps
    // the per-account email-send budget; the IP dimension caps a single source.
    enforce_window_limit(
        app_state.rate_limiter.as_ref(),
        rate_limit::SCOPE_RECOVERY_REQUEST_EMAIL,
        &hash_normalized_email(&normalized_email),
        recovery_request_limit(&app_state.config.rate_limit),
    )
    .await?;
    enforce_window_limit(
        app_state.rate_limiter.as_ref(),
        rate_limit::SCOPE_RECOVERY_REQUEST_IP,
        &request_ip_key(request),
        recovery_request_limit(&app_state.config.rate_limit),
    )
    .await?;

    let existing_user = query_as::<_, DbRecoveryUserDataRow>(
		"SELECT id, encrypted_master_key, encrypted_private_key, secret_key_hint, recovery_key_hint FROM \"user\" WHERE LOWER(email) = $1 LIMIT 1",
	)
	.bind(&normalized_email)
	.fetch_optional(pool)
	.await
	.map_err(|error| database_error(error, "Failed to load recovery account"))?;

    if existing_user
        .as_ref()
        .and_then(|row| row.encrypted_master_key.as_ref())
        .is_some()
    {
        VerificationCodeService::new(pool, &app_state.config.auth, &app_state.config.rate_limit)
            .issue_and_deliver(VerificationPurpose::Recovery, &normalized_email)
            .await?;
    }

    Ok(LogoutResponse { success: true })
}

pub(crate) async fn verify_recovery_code(
    app_state: &AppState,
    request: &RequestMetadata,
    input: VerifyRecoveryCodeInput,
) -> Result<VerifyRecoveryCodeResponse, AppError> {
    let pool = &app_state.db_pool;
    let normalized_email = normalize_email(&input.email);
    let limiter = app_state.rate_limiter.as_ref();

    // Generic per-IP throttle guards against high-volume guessing that spreads
    // across many email addresses (which would otherwise dodge the per-email lock).
    enforce_window_limit(
        limiter,
        rate_limit::SCOPE_GENERIC_IP,
        &request_ip_key(request),
        generic_ip_limit(&app_state.config.rate_limit),
    )
    .await?;

    let outcome =
        VerificationCodeService::new(pool, &app_state.config.auth, &app_state.config.rate_limit)
            .verify_with_lockout_and_consume(
                VerificationPurpose::Recovery,
                &normalized_email,
                &input.code,
                limiter,
            )
            .await?;

    if outcome == LockoutVerificationCodeOutcome::LockoutTriggered {
        // Threshold reached: invalidate any pending recovery code and record an audit
        // event so the lockout is observable.
        if let Some(user_id) = load_user_id_by_email(pool, &normalized_email).await? {
            if let Err(error) = insert_audit_event(
                pool,
                &generate_resource_id("audit"),
                &user_id,
                "recovery_verification_locked",
                "user",
                &user_id,
                None,
            )
            .await
            {
                tracing::error!(error = %error, "Failed to record recovery lockout audit event");
            }
        }
        return Err(rate_limited_error());
    }

    if outcome == LockoutVerificationCodeOutcome::Locked {
        return Err(rate_limited_error());
    }

    let recovery_token = match outcome {
        LockoutVerificationCodeOutcome::Valid { verification_id } => {
            load_user_id_by_email(pool, &normalized_email)
                .await?
                .map(|user_id| {
                    create_recovery_token(
                        &app_state.config.auth,
                        &verification_id,
                        &user_id,
                        &normalized_email,
                    )
                })
                .transpose()?
        }
        LockoutVerificationCodeOutcome::Invalid | LockoutVerificationCodeOutcome::Exhausted => None,
        LockoutVerificationCodeOutcome::Locked
        | LockoutVerificationCodeOutcome::LockoutTriggered => {
            unreachable!("recovery lockout outcomes are handled above")
        }
    };
    Ok(VerifyRecoveryCodeResponse {
        success: recovery_token.is_some(),
        recovery_token,
    })
}

async fn load_user_id_by_email(
    pool: &PgPool,
    normalized_email: &str,
) -> Result<Option<String>, AppError> {
    query_scalar::<_, String>("SELECT id FROM \"user\" WHERE LOWER(email) = $1 LIMIT 1")
        .bind(normalized_email)
        .fetch_optional(pool)
        .await
        .map_err(|error| database_error(error, "Failed to load user for recovery lockout"))
}

pub(crate) async fn get_recovery_data(
    app_state: &AppState,
    request: &RequestMetadata,
    input: GetRecoveryDataInput,
) -> Result<GetRecoveryDataResponse, AppError> {
    let pool = &app_state.db_pool;
    enforce_window_limit(
        app_state.rate_limiter.as_ref(),
        rate_limit::SCOPE_GENERIC_IP,
        &request_ip_key(request),
        generic_ip_limit(&app_state.config.rate_limit),
    )
    .await?;
    let recovery_claims =
        verify_recovery_token(&app_state.config.auth.jwt_secret, &input.recovery_token)
            .await
            .ok_or_else(|| unauthorized_handler_error("Invalid recovery session"))?;
    let recovery_data = load_recovery_data(
        pool,
        &recovery_claims.verification_id,
        &recovery_claims.user_id,
    )
    .await?
    .ok_or_else(|| unauthorized_handler_error("Invalid recovery session"))?;
    let vault_keys = load_recovery_vault_keys(pool, &recovery_data.id).await?;

    Ok(GetRecoveryDataResponse {
        user_id: recovery_data.id,
        encrypted_master_key: recovery_data.encrypted_master_key.unwrap_or_default(),
        encrypted_private_key: recovery_data.encrypted_private_key,
        secret_key_hint: recovery_data.secret_key_hint,
        recovery_key_hint: recovery_data.recovery_key_hint,
        vault_keys,
    })
}

pub(crate) async fn reset_password(
    app_state: &AppState,
    request: &RequestMetadata,
    input: ResetPasswordInput,
) -> Result<ResetPasswordResponse, AppError> {
    validate_hex_string(&input.srp_salt, "Invalid SRP salt")?;
    validate_hex_string(&input.srp_verifier, "Invalid SRP verifier")?;
    let kdf_profile = ValidatedKdfProfile::try_from(&input.kdf_params)?;
    super::credentials::validate_encrypted_vault_keys(&input.encrypted_vault_keys)?;
    let pool = &app_state.db_pool;
    enforce_window_limit(
        app_state.rate_limiter.as_ref(),
        rate_limit::SCOPE_GENERIC_IP,
        &request_ip_key(request),
        generic_ip_limit(&app_state.config.rate_limit),
    )
    .await?;
    let recovery_claims =
        verify_recovery_token(&app_state.config.auth.jwt_secret, &input.recovery_token)
            .await
            .ok_or_else(|| unauthorized_handler_error("Invalid recovery session"))?;
    let (user_id, revoked_session_ids) = reset_user_password_with_recovery(
        pool,
        &recovery_claims.verification_id,
        &recovery_claims.user_id,
        &input,
        kdf_profile,
        &app_state.config.auth,
        &app_state.config.rate_limit,
    )
    .await
    .map_err(|_| unauthorized_handler_error("Invalid recovery session"))?;
    record_session_revocations(
        pool,
        &user_id,
        &revoked_session_ids,
        "password_reset_via_recovery",
    )
    .await
    .map_err(|error| database_error(error, "Failed to record session revocations"))?;
    let session = app_state.sessions.create_session(&user_id, request).await?;

    insert_audit_event(
        pool,
        &generate_resource_id("audit"),
        &user_id,
        "password_reset_via_recovery",
        "user",
        &user_id,
        Some(json!({ "vaultKeysUpdated": input.encrypted_vault_keys.len() })),
    )
    .await
    .map_err(|error| {
        tracing::error!(error = %error, "Failed to record recovery audit event");
        AppError::internal("Failed to record recovery audit event")
    })?;

    Ok(ResetPasswordResponse {
        token: session.token,
        session_id: session.session_id,
        expires_at: format_rfc3339(session.expires_at),
        user_id,
    })
}
async fn load_recovery_data(
    pool: &PgPool,
    verification_id: &str,
    user_id: &str,
) -> Result<Option<DbRecoveryUserDataRow>, AppError> {
    let now = OffsetDateTime::now_utc();
    query_as::<_, DbRecoveryUserDataRow>(
        "SELECT u.id, u.encrypted_master_key, u.encrypted_private_key, u.secret_key_hint, u.recovery_key_hint FROM recovery_verification rv INNER JOIN \"user\" u ON LOWER(u.email) = LOWER(rv.email) WHERE rv.id = $1 AND rv.expires_at > $2 AND rv.used_at IS NOT NULL AND rv.attempts < rv.max_attempts AND u.id = $3 AND u.encrypted_master_key IS NOT NULL LIMIT 1",
    )
    .bind(verification_id)
    .bind(now)
    .bind(user_id)
    .fetch_optional(pool)
    .await
    .map_err(|error| database_error(error, "Failed to load recovery account"))
}

async fn load_recovery_vault_keys(
    pool: &PgPool,
    user_id: &str,
) -> Result<Vec<RecoveryVaultKeyResponse>, AppError> {
    let rows = query_as::<_, DbRecoveryVaultKeyRow>(
        "SELECT vk.vault_id, vk.encrypted_vault_key, v.created_by_id FROM vault_key vk INNER JOIN vault v ON v.id = vk.vault_id WHERE vk.user_id = $1 ORDER BY vk.created_at DESC",
    )
    .bind(user_id)
    .fetch_all(pool)
    .await
    .map_err(|error| database_error(error, "Failed to load recovery vault keys"))?;

    Ok(rows
        .into_iter()
        .map(|row| RecoveryVaultKeyResponse {
            vault_id: row.vault_id,
            encrypted_vault_key: row.encrypted_vault_key,
            created_by_id: row.created_by_id,
        })
        .collect())
}

async fn reset_user_password_with_recovery(
    pool: &PgPool,
    verification_id: &str,
    user_id: &str,
    input: &ResetPasswordInput,
    kdf_profile: ValidatedKdfProfile,
    auth_config: &AuthConfig,
    rate_limit_config: &crate::config::RateLimitConfig,
) -> Result<(String, Vec<String>), AppError> {
    let now = OffsetDateTime::now_utc();
    let mut transaction = pool
        .begin()
        .await
        .map_err(|error| database_error(error, "Failed to start recovery reset transaction"))?;

    let verification = query_as::<_, DbRecoveryVerificationRow>(
        "SELECT id, email, code_hash, attempts, max_attempts, expires_at, used_at, created_at FROM recovery_verification WHERE id = $1 AND expires_at > $2 AND used_at IS NOT NULL AND attempts < max_attempts FOR UPDATE",
    )
    .bind(verification_id)
    .bind(now)
    .fetch_optional(transaction.as_mut())
    .await
    .map_err(|error| database_error(error, "Failed to load recovery verification"))?
    .ok_or_else(|| AppError::unauthorized("Invalid recovery session"))?;

    let user_id = query_scalar::<_, String>(
        "SELECT id FROM \"user\" WHERE id = $1 AND LOWER(email) = LOWER($2) LIMIT 1",
    )
    .bind(user_id)
    .bind(&verification.email)
    .fetch_optional(transaction.as_mut())
    .await
    .map_err(|error| database_error(error, "Failed to load recovery account"))?
    .ok_or_else(|| AppError::unauthorized("Invalid recovery session"))?;
    let revoked_session_ids =
        query_scalar::<_, String>("SELECT id FROM session WHERE user_id = $1 FOR UPDATE")
            .bind(&user_id)
            .fetch_all(transaction.as_mut())
            .await
            .map_err(|error| database_error(error, "Failed to load recovery sessions"))?;

    query(
        "UPDATE \"user\" SET srp_salt = $1, srp_verifier = $2, encrypted_private_key = $3, encrypted_master_key = $4, recovery_key_hint = $5, secret_key_hint = COALESCE($6, secret_key_hint), kdf_algorithm = $7, kdf_iterations = $8, kdf_schema_version = $9 WHERE id = $10",
    )
    .bind(&input.srp_salt)
    .bind(&input.srp_verifier)
    .bind(&input.encrypted_private_key)
    .bind(&input.encrypted_master_key)
    .bind(&input.recovery_key_hint)
    .bind(input.secret_key_hint.as_deref())
    .bind(kdf_profile.algorithm)
    .bind(kdf_profile.iterations)
    .bind(kdf_profile.schema_version)
    .bind(&user_id)
    .execute(transaction.as_mut())
    .await
    .map_err(|error| database_error(error, "Failed to update recovery credentials"))?;

    for vault_key in &input.encrypted_vault_keys {
        validate_encrypted_vault_key(&vault_key.encrypted_vault_key)?;
        query("UPDATE vault_key SET encrypted_vault_key = $1 WHERE vault_id = $2 AND user_id = $3")
            .bind(&vault_key.encrypted_vault_key)
            .bind(&vault_key.vault_id)
            .bind(&user_id)
            .execute(transaction.as_mut())
            .await
            .map_err(|error| database_error(error, "Failed to update recovery vault keys"))?;
    }

    query("DELETE FROM session WHERE user_id = $1")
        .bind(&user_id)
        .execute(transaction.as_mut())
        .await
        .map_err(|error| database_error(error, "Failed to revoke sessions after recovery"))?;
    if !VerificationCodeService::new(pool, auth_config, rate_limit_config)
        .consume_recovery_session(&mut transaction, &verification.id)
        .await?
    {
        return Err(AppError::unauthorized("Invalid recovery session"));
    }

    transaction
        .commit()
        .await
        .map_err(|error| database_error(error, "Failed to commit recovery reset"))?;

    Ok((user_id, revoked_session_ids))
}
fn create_recovery_token(
    auth_config: &AuthConfig,
    verification_id: &str,
    user_id: &str,
    email: &str,
) -> Result<String, AppError> {
    let issued_at = now_utc().unix_timestamp() as usize;
    let expires_at = (now_utc() + Duration::minutes(RECOVERY_VERIFICATION_TTL_MINUTES))
        .unix_timestamp() as usize;
    let claims = RecoveryTokenClaims {
        verification_id: verification_id.to_string(),
        user_id: user_id.to_string(),
        email: email.to_string(),
        token_type: "recovery".to_string(),
        iss: JWT_ISSUER.to_string(),
        aud: RECOVERY_JWT_AUDIENCE.to_string(),
        exp: expires_at,
        iat: issued_at,
    };

    let token = encode_hs256_token(
        &claims,
        &auth_config.jwt_secret,
        "Failed to create recovery token",
    )?;
    if auth_config.dev_stubs_enabled {
        info!(
            email = %email,
            token = %token,
            "[auth] Recovery token issued"
        );
    }
    Ok(token)
}

async fn verify_recovery_token(jwt_secret: &str, token: &str) -> Option<RecoveryTokenClaims> {
    let mut validation = Validation::new(Algorithm::HS256);
    validation.set_audience(&[RECOVERY_JWT_AUDIENCE]);
    validation.set_issuer(&[JWT_ISSUER]);

    decode::<RecoveryTokenClaims>(
        token,
        &DecodingKey::from_secret(jwt_secret.as_bytes()),
        &validation,
    )
    .ok()
    .and_then(|data| (data.claims.token_type == "recovery").then_some(data.claims))
}
#[derive(Clone, Debug, FromRow)]
struct DbRecoveryUserDataRow {
    id: String,
    encrypted_master_key: Option<String>,
    encrypted_private_key: String,
    secret_key_hint: Option<String>,
    recovery_key_hint: Option<String>,
}

#[derive(Clone, Debug, FromRow)]
struct DbRecoveryVaultKeyRow {
    vault_id: String,
    encrypted_vault_key: String,
    created_by_id: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
struct RecoveryTokenClaims {
    verification_id: String,
    user_id: String,
    email: String,
    #[serde(rename = "type")]
    token_type: String,
    iss: String,
    aud: String,
    exp: usize,
    iat: usize,
}
