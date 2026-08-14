use super::{
    bad_request_handler_error, enforce_window_limit, format_rfc3339, hash_normalized_email,
    jwt_signing_secret, request_ip_key, validate_hex_string, AuthVaultKeyPage,
    AuthVaultKeyResponse, FinishLoginInput, FinishLoginResponse, LoginKdfParamsResponse,
    LoginUserResponse, StartLoginInput, StartLoginResponse, CURRENT_KDF_ALGORITHM,
    CURRENT_KDF_ITERATIONS, CURRENT_KDF_SCHEMA_VERSION,
};
use bittery_crypto_core::{
    normalize_email,
    srp6a::{HashAlgorithm, PrimeGroup, SrpServer},
};
use regex::Regex;
use sha2::{Digest, Sha256};
use sqlx::{query, query_as, FromRow, PgPool};
use std::sync::LazyLock;
use time::{Duration, OffsetDateTime};

const LOGIN_ATTEMPT_TTL_SECONDS: i64 = 60;
const FAKE_SRP_VERIFIER: &str = concat!(
    "1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef",
    "1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef",
    "1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef",
    "1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef"
);

use crate::{
    db::enums::{VaultRole, VaultType},
    error::AppError,
    integrations::storage,
    services::{
        rate_limit::{self, generic_ip_limit, login_email_limit, login_ip_limit},
        session::{now_utc, RequestMetadata},
    },
    AppState,
};

fn build_login_attempt_id(normalized_email_hash: &str) -> String {
    format!(
        "{normalized_email_hash}:{}",
        crate::repo::common::generate_resource_id("attempt")
    )
}

fn build_fake_login_salt(normalized_email: &str) -> String {
    let secret = jwt_signing_secret();
    let mut hasher = Sha256::new();
    hasher.update(secret.as_bytes());
    hasher.update(normalized_email.as_bytes());
    hex::encode(hasher.finalize())
}

pub(super) fn validate_login_attempt_id(value: &str) -> Result<(), AppError> {
    static RE: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(r"^[a-f0-9]{64}:[A-Za-z0-9_-]{10,64}$")
            .expect("login attempt id regex should be valid")
    });
    if RE.is_match(value) {
        Ok(())
    } else {
        Err(bad_request_handler_error("Invalid login attempt ID"))
    }
}
pub(crate) async fn start_login(
    app_state: &AppState,
    request: &RequestMetadata,
    input: StartLoginInput,
) -> Result<StartLoginResponse, AppError> {
    validate_hex_string(&input.client_public_key, "Invalid client public key")?;
    let pool = &app_state.db_pool;
    let normalized_email = normalize_email(&input.email);
    let normalized_email_hash = hash_normalized_email(&normalized_email);

    let limiter = app_state.rate_limiter.as_ref();
    enforce_window_limit(
        limiter,
        rate_limit::SCOPE_LOGIN_IP,
        &request_ip_key(request),
        login_ip_limit(),
    )
    .await?;
    enforce_window_limit(
        limiter,
        rate_limit::SCOPE_LOGIN_EMAIL,
        &normalized_email_hash,
        login_email_limit(),
    )
    .await?;

    let server = SrpServer::new(HashAlgorithm::Sha256, PrimeGroup::G4096);
    let now = now_utc();

    query("DELETE FROM login_attempt WHERE expires_at <= $1")
        .bind(now)
        .execute(pool)
        .await
        .map_err(|e| {
            tracing::error!(error = %e, "Failed to prune login attempts");
            AppError::internal("Failed to prune login attempts")
        })?;

    let user = query_as::<_, DbLoginUserRow>(
		"SELECT id, email, name, secret_key_hint, srp_salt, srp_verifier, public_key, encrypted_private_key, kdf_algorithm, kdf_iterations, kdf_schema_version FROM \"user\" WHERE LOWER(email) = $1 LIMIT 1",
	)
	.bind(&normalized_email)
	.fetch_optional(pool)
	.await
	.map_err(|e| { tracing::error!(error = %e, "Failed to load login account"); AppError::internal("Failed to load login account") })?;

    let salt = user
        .as_ref()
        .map(|existing| existing.srp_salt.clone())
        .unwrap_or_else(|| build_fake_login_salt(&normalized_email));
    let verifier = user
        .as_ref()
        .map(|existing| existing.srp_verifier.clone())
        .unwrap_or_else(|| FAKE_SRP_VERIFIER.to_string());
    let ephemeral = server.generate_ephemeral(&verifier).map_err(|e| {
        tracing::error!(error = %e, "Failed to create login challenge");
        AppError::internal("Failed to create login challenge")
    })?;
    let attempt_id = build_login_attempt_id(&normalized_email_hash);

    query(
		"INSERT INTO login_attempt (id, user_id, normalized_email_hash, client_public_key, server_ephemeral_secret, expires_at) VALUES ($1, $2, $3, $4, $5, $6)",
	)
	.bind(&attempt_id)
	.bind(user.as_ref().map(|existing| existing.id.as_str()))
	.bind(&normalized_email_hash)
	.bind(&input.client_public_key)
	.bind(&ephemeral.secret)
	.bind(now + Duration::seconds(LOGIN_ATTEMPT_TTL_SECONDS))
	.execute(pool)
	.await
	.map_err(|e| { tracing::error!(error = %e, "Failed to create login attempt"); AppError::internal("Failed to create login attempt") })?;

    // The database constraint and verifier-write validation guarantee that a
    // real account uses the same profile as this decoy. Do not introduce a
    // second stored profile without redesigning enumeration-resistant decoys.
    let kdf_params = match user.as_ref() {
        Some(existing) => LoginKdfParamsResponse {
            schema_version: u32::try_from(existing.kdf_schema_version)
                .map_err(|_| AppError::internal("Stored KDF profile violates server policy"))?,
            algorithm: existing.kdf_algorithm.clone(),
            iterations: u32::try_from(existing.kdf_iterations)
                .map_err(|_| AppError::internal("Stored KDF profile violates server policy"))?,
        },
        None => LoginKdfParamsResponse {
            schema_version: CURRENT_KDF_SCHEMA_VERSION,
            algorithm: CURRENT_KDF_ALGORITHM.to_string(),
            iterations: CURRENT_KDF_ITERATIONS,
        },
    };
    Ok(StartLoginResponse {
        attempt_id,
        salt,
        server_public_key: ephemeral.public.clone(),
        kdf_params,
    })
}

struct VerifiedLoginProof {
    user: DbLoginUserRow,
    server_proof: String,
}

async fn verify_login_proof_and_get_user(
    pool: &PgPool,
    input: &FinishLoginInput,
) -> Result<VerifiedLoginProof, AppError> {
    validate_login_attempt_id(&input.attempt_id)?;
    validate_hex_string(&input.client_public_key, "Invalid client public key")?;
    validate_hex_string(&input.client_proof, "Invalid client proof")?;
    let attempt = query_as::<_, DbLoginAttemptRow>(
		"DELETE FROM login_attempt WHERE id = $1 RETURNING id, user_id, normalized_email_hash, client_public_key, server_ephemeral_secret, expires_at",
	)
	.bind(&input.attempt_id)
	.fetch_optional(pool)
	.await
	.map_err(|e| { tracing::error!(error = %e, "Failed to consume login attempt"); AppError::internal("Failed to consume login attempt") })?
	.ok_or_else(|| AppError::unauthorized("Invalid credentials"))?;

    if attempt.expires_at <= now_utc() || attempt.client_public_key != input.client_public_key {
        return Err(AppError::unauthorized("Invalid credentials"));
    }

    let Some(user_id) = attempt.user_id.as_deref() else {
        return Err(AppError::unauthorized("Invalid credentials"));
    };
    let user = query_as::<_, DbLoginUserRow>(
		"SELECT u.id, u.email, u.name, u.secret_key_hint, u.srp_salt, u.srp_verifier, u.public_key, u.encrypted_private_key, u.kdf_algorithm, u.kdf_iterations, u.kdf_schema_version, t.name AS team_name, t.image_key AS team_image_key FROM \"user\" u LEFT JOIN team t ON u.team_id = t.id WHERE u.id = $1 LIMIT 1",
	)
	.bind(user_id)
	.fetch_optional(pool)
	.await
	.map_err(|e| { tracing::error!(error = %e, "Failed to load login account"); AppError::internal("Failed to load login account") })?
	.ok_or_else(|| AppError::unauthorized("Invalid credentials"))?;

    let server = SrpServer::new(HashAlgorithm::Sha256, PrimeGroup::G4096);
    let session_result = server
        .derive_session(
            &attempt.server_ephemeral_secret,
            &input.client_public_key,
            &user.srp_salt,
            "",
            &user.srp_verifier,
            &input.client_proof,
        )
        .map_err(|_| AppError::unauthorized("Invalid credentials"))?;

    Ok(VerifiedLoginProof {
        user,
        server_proof: session_result.proof.clone(),
    })
}

pub(crate) async fn verify_login_proof_for_user(
    pool: &PgPool,
    expected_user_id: &str,
    input: &FinishLoginInput,
) -> Result<(), AppError> {
    let verified = verify_login_proof_and_get_user(pool, input).await?;
    if verified.user.id != expected_user_id {
        return Err(AppError::unauthorized("Invalid credentials"));
    }
    Ok(())
}

pub(crate) async fn finish_login(
    app_state: &AppState,
    request: &RequestMetadata,
    input: FinishLoginInput,
) -> Result<FinishLoginResponse, AppError> {
    let pool = &app_state.db_pool;
    enforce_window_limit(
        app_state.rate_limiter.as_ref(),
        rate_limit::SCOPE_GENERIC_IP,
        &request_ip_key(request),
        generic_ip_limit(),
    )
    .await?;
    let verified = verify_login_proof_and_get_user(pool, &input).await?;
    let session = app_state
        .sessions
        .create_session(&verified.user.id, request)
        .await?;
    let vault_keys = load_auth_vault_keys_page(
        pool,
        app_state.object_storage.as_ref(),
        &verified.user.id,
        None,
        101,
    )
    .await?;

    Ok(FinishLoginResponse {
        token: session.token,
        session_id: session.session_id,
        expires_at: format_rfc3339(session.expires_at),
        server_proof: verified.server_proof,
        user: LoginUserResponse {
            id: verified.user.id,
            email: verified.user.email,
            name: verified.user.name,
            secret_key_hint: verified.user.secret_key_hint.unwrap_or_default(),
            public_key: verified.user.public_key,
            encrypted_private_key: verified.user.encrypted_private_key,
            team_name: verified.user.team_name,
            team_avatar_url: verified
                .user
                .team_image_key
                .as_deref()
                .and_then(|key| app_state.object_storage.public_url(key)),
        },
        vault_keys,
    })
}
pub(crate) async fn load_auth_vault_keys_page(
    pool: &PgPool,
    object_storage: &dyn storage::ObjectStorage,
    user_id: &str,
    cursor: Option<(OffsetDateTime, String)>,
    limit: i64,
) -> Result<AuthVaultKeyPage, AppError> {
    const PAGE_BYTES: i64 = 4 * 1024 * 1024 - 16 * 1024;
    let cursor_timestamp = cursor.as_ref().map(|(timestamp, _)| *timestamp);
    let cursor_id = cursor.as_ref().map(|(_, id)| id.as_str());
    let weights = query_as::<_, AuthVaultKeyPageWeight>(
        r#"WITH candidates AS (
            SELECT vk.vault_id,
                   ROW_NUMBER() OVER (ORDER BY v.created_at, vk.vault_id)::bigint AS position,
                   (8192 + octet_length(vk.vault_id) + octet_length(v.name)
                    + octet_length(v.type::text) + coalesce(octet_length(v.icon), 0)
                    + coalesce(octet_length(v.image_key), 0) + octet_length(vk.encrypted_vault_key)
                    + octet_length(vk.role::text))::bigint AS estimated_bytes
            FROM vault_key vk JOIN vault v ON v.id = vk.vault_id
            WHERE vk.user_id = $1
              AND ($2::timestamptz IS NULL OR (v.created_at, vk.vault_id) > ($2, $3))
            ORDER BY v.created_at, vk.vault_id LIMIT $4
        ), weighted AS (
            SELECT vault_id, position, count(*) OVER ()::bigint AS candidate_count,
                   sum(estimated_bytes) OVER (ORDER BY position)::bigint AS cumulative_bytes
            FROM candidates
        )
        SELECT vault_id, position, candidate_count, cumulative_bytes FROM weighted
        WHERE cumulative_bytes <= $5 OR position = 1 ORDER BY position"#,
    )
    .bind(user_id)
    .bind(cursor_timestamp)
    .bind(cursor_id)
    .bind(limit)
    .bind(PAGE_BYTES)
    .fetch_all(pool)
    .await
    .map_err(|e| {
        tracing::error!(error = %e, "Failed to size vault key page");
        AppError::internal("Failed to load vault keys")
    })?;
    let Some(first) = weights.first() else {
        return Ok(AuthVaultKeyPage {
            items: Vec::new(),
            has_more: false,
        });
    };
    if first.cumulative_bytes > PAGE_BYTES {
        return Err(AppError::payload_too_large(
            "A single vault key exceeds the response page byte budget.",
        ));
    }
    let has_more = weights
        .last()
        .is_some_and(|last| last.position < last.candidate_count);
    let vault_ids: Vec<String> = weights.into_iter().map(|row| row.vault_id).collect();
    let rows = query_as::<_, DbAuthVaultKeyRow>(
        "SELECT vk.vault_id, v.name AS vault_name, v.type::text AS vault_type, v.icon AS vault_icon, v.image_key AS vault_image_key, vk.encrypted_vault_key, vk.role::text AS role, v.created_at FROM vault_key vk INNER JOIN vault v ON v.id = vk.vault_id WHERE vk.user_id = $1 AND vk.vault_id = ANY($2) ORDER BY array_position($2::text[], vk.vault_id)",
    )
    .bind(user_id)
    .bind(&vault_ids)
    .fetch_all(pool)
    .await
    .map_err(|e| {
        tracing::error!(error = %e, "Failed to load vault keys");
        AppError::internal("Failed to load vault keys")
    })?;

    let items = rows
        .into_iter()
        .map(|row| AuthVaultKeyResponse {
            vault_id: row.vault_id,
            vault_name: row.vault_name,
            vault_type: row.vault_type,
            vault_icon: row.vault_icon,
            vault_image_url: row
                .vault_image_key
                .as_deref()
                .and_then(|key| object_storage.public_url(key)),
            encrypted_vault_key: row.encrypted_vault_key,
            role: row.role,
            created_at: row.created_at,
        })
        .collect();
    Ok(AuthVaultKeyPage { items, has_more })
}
#[derive(Clone, Debug, FromRow)]
struct DbAuthVaultKeyRow {
    vault_id: String,
    vault_name: String,
    vault_type: VaultType,
    vault_icon: Option<String>,
    vault_image_key: Option<String>,
    encrypted_vault_key: String,
    role: VaultRole,
    created_at: OffsetDateTime,
}

#[derive(Clone, Debug, FromRow)]
struct AuthVaultKeyPageWeight {
    vault_id: String,
    position: i64,
    candidate_count: i64,
    cumulative_bytes: i64,
}

#[allow(dead_code)]
#[derive(Clone, Debug, FromRow)]
struct DbLoginAttemptRow {
    id: String,
    user_id: Option<String>,
    normalized_email_hash: String,
    client_public_key: String,
    server_ephemeral_secret: String,
    expires_at: OffsetDateTime,
}

#[derive(Clone, Debug, FromRow)]
struct DbLoginUserRow {
    id: String,
    email: String,
    name: String,
    secret_key_hint: Option<String>,
    srp_salt: String,
    srp_verifier: String,
    public_key: String,
    encrypted_private_key: String,
    kdf_algorithm: String,
    kdf_iterations: i32,
    kdf_schema_version: i32,
    // The team badge the client stores in account metadata. Only the post-proof load joins
    // `team` for it: `start_login` answers an unauthenticated challenge and must keep the
    // decoy path's SELECT exactly as narrow as it already is.
    #[sqlx(default)]
    team_name: Option<String>,
    #[sqlx(default)]
    team_image_key: Option<String>,
}
