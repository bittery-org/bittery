
use axum::{
    extract::State,
    http::{header::HeaderName, HeaderValue, Request},
    middleware::Next,
    response::Response,
};
use bittery_crypto_core::{
    default_login_kdf_params,
    srp6a::{HashAlgorithm, PrimeGroup, SrpServer},
};
use jsonwebtoken::{decode, encode, Algorithm, DecodingKey, EncodingKey, Header, Validation};
use qubit::server::{Extensions, FromRequestExtensions, RpcError};
use rand::Rng;
use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::json;
use sha2::{Digest, Sha256};
use sqlx::{query, query_as, query_scalar, PgPool};
use std::sync::LazyLock;
use time::{Duration, OffsetDateTime};
use tracing::info;
use ts_rs::TS;

use crate::{
    services::session::{
        DeviceSessionResponse, RefreshSessionResponse, RequestMetadata,
        RenameDeviceInput, SessionIdInput,
        VerifiedSession, format_rfc3339, generate_opaque_session_token, hash_token,
        is_grouped_client_session, now_utc,
    },
    services::billing::sync_team_seats_best_effort,
    db::models::*,
    error::AppError,
    repo::common::{generate_resource_id, insert_audit_event},
    repo::auth as repo_auth,
    config::{bittery_mode, db_pool},
    services::session_control::record_session_revocations,
    integrations::storage, AppState,
};

const AUTHORIZATION_HEADER: &str = "authorization";
const CLIENT_ID_HEADER: &str = "x-client-id";
const APP_PLATFORM_HEADER: &str = "x-app-platform";
const SESSION_EXPIRY_HEADER: &str = "x-session-expires";
const JWT_ISSUER: &str = "bittery";
const SIGNUP_VERIFICATION_JWT_AUDIENCE: &str = "bittery-signup-verification";
const RECOVERY_JWT_AUDIENCE: &str = "bittery-recovery";
const SIGNUP_VERIFICATION_TTL_MINUTES: i64 = 15;
const RECOVERY_VERIFICATION_TTL_MINUTES: i64 = 15;
const LOGIN_ATTEMPT_TTL_SECONDS: i64 = 60;
const FAKE_SRP_VERIFIER: &str = concat!(
    "1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef",
    "1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef",
    "1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef",
    "1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef"
);

pub struct RefreshSessionContext {
    pub app_state: AppState,
    pub session: VerifiedSession,
    pub request: RequestMetadata,
}

#[derive(Clone)]
pub struct AppContext {
    pub app_state: AppState,
}

#[derive(Clone)]
pub struct PublicAuthContext {
    pub app_state: AppState,
    pub request: RequestMetadata,
}

#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct RegistrationStatusResponse {
    pub mode: String,
    pub allow_public_signup: bool,
    pub reason: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct CheckEmailInput {
    pub email: String,
}

#[derive(Debug, Clone, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[serde(deny_unknown_fields)]
pub struct RequestSignupVerificationInput {
    pub email: String,
    pub invitation_token: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[serde(deny_unknown_fields)]
pub struct VerifySignupVerificationInput {
    pub email: String,
    pub code: String,
    pub invitation_token: Option<String>,
}

#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct CheckEmailResponse {
    pub exists: bool,
    pub secret_key_hint: String,
}

#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct MeResponse {
    pub id: String,
    pub email: String,
    pub name: String,
    pub team_id: Option<String>,
    pub team_name: Option<String>,
    pub team_type: Option<String>,
    pub team_avatar_url: Option<String>,
    pub role: String,
    pub secret_key_hint: Option<String>,
    pub public_key: String,
    pub encrypted_private_key: String,
    pub has_recovery_key: bool,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, TS)]
pub struct LogoutResponse {
    pub success: bool,
}

#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct VerifySignupVerificationResponse {
    pub success: bool,
    pub signup_verification_token: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[serde(deny_unknown_fields)]
pub struct SignupInput {
    pub user_id: Option<String>,
    pub vault_id: Option<String>,
    pub email: String,
    pub signup_verification_token: String,
    pub name: String,
    pub plan: Option<String>,
    pub organization_name: Option<String>,
    pub secret_key_hint: String,
    pub srp_salt: String,
    pub srp_verifier: String,
    pub public_key: String,
    pub encrypted_private_key: String,
    pub encrypted_master_key: String,
    pub recovery_key_hint: String,
    pub encrypted_vault_key: String,
}

#[derive(Debug, Clone, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[serde(deny_unknown_fields)]
pub struct SignupWithInvitationInput {
    pub token: String,
    pub user_id: Option<String>,
    pub vault_id: Option<String>,
    pub email: String,
    pub signup_verification_token: String,
    pub name: String,
    pub secret_key_hint: String,
    pub srp_salt: String,
    pub srp_verifier: String,
    pub public_key: String,
    pub encrypted_private_key: String,
    pub encrypted_master_key: String,
    pub recovery_key_hint: String,
    pub encrypted_vault_key: String,
}

#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct AuthSessionUserResponse {
    pub id: String,
    pub email: String,
    pub name: String,
    pub secret_key_hint: String,
    pub public_key: String,
    pub encrypted_private_key: String,
    pub team_id: Option<String>,
    pub team_name: Option<String>,
    pub team_type: Option<String>,
    pub team_avatar_url: Option<String>,
    pub role: String,
}

#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct AuthVaultKeyResponse {
    pub vault_id: String,
    pub vault_name: String,
    pub vault_type: String,
    pub vault_icon: Option<String>,
    pub vault_image_url: Option<String>,
    pub encrypted_vault_key: String,
    pub role: String,
}

#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct SignupResponse {
    pub success: bool,
    pub user_id: String,
    pub token: String,
    pub session_id: String,
    pub expires_at: String,
    pub user: AuthSessionUserResponse,
    pub vault_keys: Vec<AuthVaultKeyResponse>,
}

#[derive(Debug, Clone, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[serde(deny_unknown_fields)]
pub struct StartLoginInput {
    pub email: String,
    pub client_public_key: String,
}

#[derive(Debug, Clone, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[serde(deny_unknown_fields)]
pub struct FinishLoginInput {
    pub attempt_id: String,
    pub client_public_key: String,
    pub client_proof: String,
}

#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct LoginKdfParamsResponse {
    pub schema_version: u32,
    pub algorithm: String,
    pub iterations: u32,
    pub salt: String,
}

#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct StartLoginResponse {
    pub attempt_id: String,
    pub salt: String,
    pub server_public_key: String,
    pub kdf_params: LoginKdfParamsResponse,
}

#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct LoginUserResponse {
    pub id: String,
    pub email: String,
    pub name: String,
    pub secret_key_hint: String,
    pub public_key: String,
    pub encrypted_private_key: String,
}

#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct FinishLoginResponse {
    pub token: String,
    pub session_id: String,
    pub expires_at: String,
    pub server_proof: String,
    pub user: LoginUserResponse,
}

#[derive(Debug, Clone, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[serde(deny_unknown_fields)]
pub struct RequestRecoveryVerificationInput {
    pub email: String,
}

#[derive(Debug, Clone, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[serde(deny_unknown_fields)]
pub struct VerifyRecoveryCodeInput {
    pub email: String,
    pub code: String,
}

#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct VerifyRecoveryCodeResponse {
    pub success: bool,
    pub recovery_token: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[serde(deny_unknown_fields)]
pub struct GetRecoveryDataInput {
    pub recovery_token: String,
}

#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct RecoveryVaultKeyResponse {
    pub vault_id: String,
    pub encrypted_vault_key: String,
    pub created_by_id: String,
}

#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct GetRecoveryDataResponse {
    pub user_id: String,
    pub encrypted_master_key: String,
    pub encrypted_private_key: String,
    pub secret_key_hint: Option<String>,
    pub recovery_key_hint: Option<String>,
    pub vault_keys: Vec<RecoveryVaultKeyResponse>,
}

#[derive(Debug, Clone, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct EncryptedVaultKeyInput {
    pub vault_id: String,
    pub encrypted_vault_key: String,
}

#[derive(Debug, Clone, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[serde(deny_unknown_fields)]
pub struct ResetPasswordInput {
    pub recovery_token: String,
    pub srp_salt: String,
    pub srp_verifier: String,
    pub encrypted_private_key: String,
    pub encrypted_master_key: String,
    pub recovery_key_hint: String,
    pub secret_key_hint: Option<String>,
    pub encrypted_vault_keys: Vec<EncryptedVaultKeyInput>,
}

#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ResetPasswordResponse {
    pub token: String,
    pub session_id: String,
    pub expires_at: String,
    pub user_id: String,
}

#[derive(Debug, Clone, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[serde(deny_unknown_fields)]
pub struct UpdateEmailInput {
    pub new_email: String,
    pub srp_salt: String,
    pub srp_verifier: String,
    pub encrypted_private_key: String,
    pub encrypted_vault_keys: Vec<EncryptedVaultKeyInput>,
}

#[derive(Debug, Clone, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[serde(deny_unknown_fields)]
pub struct ChangePasswordInput {
    pub srp_salt: String,
    pub srp_verifier: String,
    pub encrypted_private_key: String,
    pub encrypted_vault_keys: Vec<EncryptedVaultKeyInput>,
}

#[derive(Debug, Clone, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[serde(deny_unknown_fields)]
pub struct RegenerateSecretKeyInput {
    pub secret_key_hint: String,
    pub srp_salt: String,
    pub srp_verifier: String,
    pub encrypted_private_key: String,
    pub encrypted_vault_keys: Vec<EncryptedVaultKeyInput>,
}

#[derive(Debug, Clone, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[serde(deny_unknown_fields)]
pub struct StoreRecoveryKeyInput {
    pub encrypted_master_key: String,
    pub recovery_key_hint: String,
}

#[derive(Debug, Clone, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[serde(deny_unknown_fields)]
pub struct DeleteAccountInput {
    pub confirm_email: String,
}

#[derive(Debug, sqlx::FromRow)]
struct DbCheckEmailRow {
    secret_key_hint: Option<String>,
}

#[derive(Debug, sqlx::FromRow)]
struct DbMeRow {
    id: String,
    email: String,
    name: String,
    team_id: Option<String>,
    team_name: Option<String>,
    team_type: Option<String>,
    team_image_key: Option<String>,
    role: String,
    secret_key_hint: Option<String>,
    public_key: String,
    encrypted_private_key: String,
    encrypted_master_key: Option<String>,
    created_at: OffsetDateTime,
}

#[derive(Debug, sqlx::FromRow)]
struct DbAccountMutationUserRow {
    id: String,
    email: String,
    encrypted_master_key: Option<String>,
    team_id: Option<String>,
    team_owner_id: Option<String>,
    team_type: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct SignupVerificationTokenClaims {
    email: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    invitation_token: Option<String>,
    #[serde(rename = "type")]
    token_type: String,
    iss: String,
    aud: String,
    exp: usize,
    iat: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct RecoveryTokenClaims {
    email: String,
    #[serde(rename = "type")]
    token_type: String,
    iss: String,
    aud: String,
    exp: usize,
    iat: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct PendingVaultKeyEntry {
    #[serde(rename = "vaultId")]
    pub(crate) vault_id: String,
    #[serde(rename = "encryptedVaultKey")]
    pub(crate) encrypted_vault_key: String,
}

impl FromRequestExtensions<AppState> for RefreshSessionContext {
    async fn from_request_extensions(
        ctx: AppState,
        extensions: Extensions,
    ) -> Result<Self, RpcError> {
        let request = extensions
            .get::<RequestMetadata>()
            .cloned()
            .unwrap_or_default();
        let session = extensions
            .get::<VerifiedSession>()
            .cloned()
            .ok_or_else(|| unauthorized_error("Authentication required"))?;

        Ok(Self {
            app_state: ctx,
            session,
            request,
        })
    }
}

impl FromRequestExtensions<AppState> for AppContext {
    async fn from_request_extensions(
        ctx: AppState,
        _extensions: Extensions,
    ) -> Result<Self, RpcError> {
        Ok(Self { app_state: ctx })
    }
}

impl FromRequestExtensions<AppState> for PublicAuthContext {
    async fn from_request_extensions(
        ctx: AppState,
        extensions: Extensions,
    ) -> Result<Self, RpcError> {
        Ok(Self {
            app_state: ctx,
            request: extensions
                .get::<RequestMetadata>()
                .cloned()
                .unwrap_or_default(),
        })
    }
}

pub(crate) async fn request_signup_verification(
    app_state: &AppState,
    _request: &RequestMetadata,
    input: RequestSignupVerificationInput,
) -> Result<LogoutResponse, AppError> {
    let pool = app_state
        .db_pool
        .as_ref()
        .ok_or_else(|| internal_handler_error("Database is not configured"))?;
    let normalized_email = normalize_email(&input.email);

    if let Some(invitation_token) = input.invitation_token.as_deref() {
        let _ =
            get_pending_invitation_for_signup(pool, invitation_token, &normalized_email).await?;
    } else if bittery_mode() == "self-hosted" && has_any_registered_user(pool).await? {
        return Err(AppError::forbidden(
            "Public registration is disabled. Ask an admin for an invite link.",
        ));
    }

    let code =
        create_signup_verification(pool, &normalized_email, input.invitation_token.as_deref())
            .await?;
    send_signup_verification_code(&normalized_email, &code, input.invitation_token.as_deref())?;

    Ok(LogoutResponse { success: true })
}

pub(crate) async fn verify_signup_verification(
    app_state: &AppState,
    _request: &RequestMetadata,
    input: VerifySignupVerificationInput,
) -> Result<VerifySignupVerificationResponse, AppError> {
    let pool = app_state
        .db_pool
        .as_ref()
        .ok_or_else(|| internal_handler_error("Database is not configured"))?;
    let normalized_email = normalize_email(&input.email);

    if let Some(invitation_token) = input.invitation_token.as_deref() {
        let _ =
            get_pending_invitation_for_signup(pool, invitation_token, &normalized_email).await?;
    }

    let success = consume_signup_verification_code(
        pool,
        &normalized_email,
        &input.code,
        input.invitation_token.as_deref(),
    )
    .await?;
    if !success {
        return Ok(VerifySignupVerificationResponse {
            success: false,
            signup_verification_token: None,
        });
    }

    Ok(VerifySignupVerificationResponse {
        success: true,
        signup_verification_token: Some(create_signup_verification_token(
            &normalized_email,
            input.invitation_token.as_deref(),
        )?),
    })
}

pub(crate) async fn signup(
    app_state: &AppState,
    request: &RequestMetadata,
    input: SignupInput,
) -> Result<SignupResponse, AppError> {
    validate_signup_input(&input)?;
    let pool = db_pool(app_state)?;
    let normalized_email = normalize_email(&input.email);
    let self_hosted_mode = bittery_mode() == "self-hosted";

    if self_hosted_mode && has_any_registered_user(pool).await? {
        return Err(AppError::forbidden(
            "Public registration is disabled. Ask an admin for an invite link.",
        ));
    }

    assert_valid_signup_verification_token(
        &input.signup_verification_token,
        &normalized_email,
        None,
    )
    .await?;
    ensure_user_does_not_exist(pool, &normalized_email).await?;

    let selected_plan = if self_hosted_mode {
        "free"
    } else {
        normalize_signup_plan(input.plan.as_deref())?
    };
    let team_type = if self_hosted_mode {
        "organization"
    } else {
        map_plan_to_team_type(selected_plan)
    };
    let team_name = signup_team_name(
        self_hosted_mode,
        team_type,
        input.organization_name.as_deref(),
    );
    let member_limit = if self_hosted_mode {
        None
    } else {
        plan_member_limit(selected_plan)
    };
    let billing_status = if selected_plan == "free" {
        "none"
    } else {
        "incomplete"
    };
    let user_id = input
        .user_id
        .clone()
        .unwrap_or_else(|| generate_resource_id("user"));
    let team_id = generate_resource_id("team");
    let vault_id = input
        .vault_id
        .clone()
        .unwrap_or_else(|| generate_resource_id("vault"));

    let mut transaction = pool.begin().await.map_err(|e| {
        tracing::error!(error = %e, "Failed to start signup transaction");
        internal_handler_error("Failed to start signup transaction")
    })?;

    insert_user_account(
        &mut transaction,
        CreateUserParams {
            user_id: &user_id,
            email: &normalized_email,
            name: &input.name,
            email_verified: true,
            secret_key_hint: &input.secret_key_hint,
            srp_salt: &input.srp_salt,
            srp_verifier: &input.srp_verifier,
            public_key: &input.public_key,
            encrypted_private_key: &input.encrypted_private_key,
            encrypted_master_key: Some(&input.encrypted_master_key),
            recovery_key_hint: Some(&input.recovery_key_hint),
        },
    )
    .await?;
    insert_team(
        &mut transaction,
        &team_id,
        &team_name,
        &user_id,
        team_type,
        member_limit,
        selected_plan,
        billing_status,
    )
    .await?;
    query("UPDATE \"user\" SET team_id = $1, role = 'owner' WHERE id = $2")
        .bind(&team_id)
        .bind(&user_id)
        .execute(transaction.as_mut())
        .await
        .map_err(|e| {
            tracing::error!(error = %e, "Failed to link user to team");
            internal_handler_error("Failed to link user to team")
        })?;
    insert_personal_vault(
        &mut transaction,
        &vault_id,
        &user_id,
        &input.encrypted_vault_key,
    )
    .await?;

    transaction.commit().await.map_err(|e| {
        tracing::error!(error = %e, "Failed to commit signup");
        internal_handler_error("Failed to commit signup")
    })?;

    let session = app_state
        .sessions
        .create_session(&user_id, &request)
        .await?;
    let vault_keys = load_auth_vault_keys(pool, &user_id).await?;

    Ok(SignupResponse {
        success: true,
        user_id: user_id.clone(),
        token: session.token,
        session_id: session.session_id,
        expires_at: format_rfc3339(session.expires_at),
        user: AuthSessionUserResponse {
            id: user_id,
            email: normalized_email,
            name: input.name,
            secret_key_hint: input.secret_key_hint,
            public_key: input.public_key,
            encrypted_private_key: input.encrypted_private_key,
            team_id: Some(team_id),
            team_name: Some(team_name),
            team_type: Some(team_type.to_string()),
            team_avatar_url: None,
            role: "owner".to_string(),
        },
        vault_keys,
    })
}

pub(crate) async fn signup_with_invitation(
    app_state: &AppState,
    request: &RequestMetadata,
    input: SignupWithInvitationInput,
) -> Result<SignupResponse, AppError> {
    validate_signup_with_invitation_input(&input)?;
    let pool = db_pool(app_state)?;
    let normalized_email = normalize_email(&input.email);
    let invitation = get_pending_signup_invitation(pool, &input.token, &normalized_email).await?;

    assert_valid_signup_verification_token(
        &input.signup_verification_token,
        &normalized_email,
        Some(&input.token),
    )
    .await?;
    ensure_user_does_not_exist(pool, &normalized_email).await?;

    if let Some(member_limit) = invitation.member_limit {
        let current_members =
            query_scalar::<_, i64>("SELECT COUNT(*)::bigint FROM \"user\" WHERE team_id = $1")
                .bind(&invitation.team_id)
                .fetch_one(pool)
                .await
                .map_err(|e| {
                    tracing::error!(error = %e, "Failed to load team members");
                    internal_handler_error("Failed to load team members")
                })?;
        if current_members >= i64::from(member_limit) {
            return Err(AppError::bad_request("Team has reached member limit"));
        }
    }

    let pending_keys = parse_pending_vault_keys(invitation.pending_vault_keys.as_deref())?;
    assert_pending_vault_keys_authorized(
        pool,
        &invitation.team_id,
        &invitation.invited_by_id,
        &pending_keys,
    )
    .await?;

    let user_id = input
        .user_id
        .clone()
        .unwrap_or_else(|| generate_resource_id("user"));
    let personal_vault_id = input
        .vault_id
        .clone()
        .unwrap_or_else(|| generate_resource_id("vault"));
    let vault_role = if invitation.role == "admin" {
        "admin"
    } else {
        "member"
    };

    let mut transaction = pool.begin().await.map_err(|e| {
        tracing::error!(error = %e, "Failed to start invited signup transaction");
        internal_handler_error("Failed to start invited signup transaction")
    })?;

    insert_user_account(
        &mut transaction,
        CreateUserParams {
            user_id: &user_id,
            email: &normalized_email,
            name: &input.name,
            email_verified: true,
            secret_key_hint: &input.secret_key_hint,
            srp_salt: &input.srp_salt,
            srp_verifier: &input.srp_verifier,
            public_key: &input.public_key,
            encrypted_private_key: &input.encrypted_private_key,
            encrypted_master_key: Some(&input.encrypted_master_key),
            recovery_key_hint: Some(&input.recovery_key_hint),
        },
    )
    .await?;
    query("UPDATE \"user\" SET team_id = $1, role = $2::team_role WHERE id = $3")
        .bind(&invitation.team_id)
        .bind(&invitation.role)
        .bind(&user_id)
        .execute(transaction.as_mut())
        .await
        .map_err(|e| {
            tracing::error!(error = %e, "Failed to link invited user to team");
            internal_handler_error("Failed to link invited user to team")
        })?;
    insert_personal_vault(
        &mut transaction,
        &personal_vault_id,
        &user_id,
        &input.encrypted_vault_key,
    )
    .await?;

    for pending_key in &pending_keys {
        query(
			"INSERT INTO vault_key (id, vault_id, user_id, encrypted_vault_key, role) VALUES ($1, $2, $3, $4, $5::vault_role)",
		)
		.bind(generate_resource_id("vault_key"))
		.bind(&pending_key.vault_id)
		.bind(&user_id)
		.bind(&pending_key.encrypted_vault_key)
		.bind(vault_role)
		.execute(transaction.as_mut())
		.await
		.map_err(|e| { tracing::error!(error = %e, "Failed to provision invited vault access"); internal_handler_error("Failed to provision invited vault access") })?;
    }

    query("UPDATE team_invitation SET status = 'accepted', accepted_at = $1 WHERE id = $2")
        .bind(now_utc())
        .bind(&invitation.id)
        .execute(transaction.as_mut())
        .await
        .map_err(|e| {
            tracing::error!(error = %e, "Failed to accept invitation");
            internal_handler_error("Failed to accept invitation")
        })?;

    transaction.commit().await.map_err(|e| {
        tracing::error!(error = %e, "Failed to commit invited signup");
        internal_handler_error("Failed to commit invited signup")
    })?;

    sync_team_seats_best_effort(pool, &invitation.team_id, &invitation.billing_plan).await;

    let session = app_state
        .sessions
        .create_session(&user_id, &request)
        .await?;
    let vault_keys = load_auth_vault_keys(pool, &user_id).await?;

    Ok(SignupResponse {
        success: true,
        user_id: user_id.clone(),
        token: session.token,
        session_id: session.session_id,
        expires_at: format_rfc3339(session.expires_at),
        user: AuthSessionUserResponse {
            id: user_id,
            email: normalized_email,
            name: input.name,
            secret_key_hint: input.secret_key_hint,
            public_key: input.public_key,
            encrypted_private_key: input.encrypted_private_key,
            team_id: Some(invitation.team_id),
            team_name: Some(invitation.team_name),
            team_type: Some(invitation.team_type),
            team_avatar_url: invitation.team_image_key.map(storage_public_url),
            role: invitation.role,
        },
        vault_keys,
    })
}

pub(crate) async fn start_login(
    app_state: &AppState,
    request: &RequestMetadata,
    input: StartLoginInput,
) -> Result<StartLoginResponse, AppError> {
    let _request = request;
    validate_hex_string(&input.client_public_key, "Invalid client public key")?;
    let pool = db_pool(app_state)?;
    let normalized_email = normalize_email(&input.email);
    let normalized_email_hash = hash_normalized_email(&normalized_email);
    let server = SrpServer::new(HashAlgorithm::Sha256, PrimeGroup::G4096);
    let now = now_utc();

    query("DELETE FROM login_attempt WHERE expires_at <= $1")
        .bind(now)
        .execute(pool)
        .await
        .map_err(|e| {
            tracing::error!(error = %e, "Failed to prune login attempts");
            internal_handler_error("Failed to prune login attempts")
        })?;

    let user = query_as::<_, DbLoginUserRow>(
		"SELECT id, email, name, secret_key_hint, srp_salt, srp_verifier, public_key, encrypted_private_key FROM \"user\" WHERE LOWER(email) = $1 LIMIT 1",
	)
	.bind(&normalized_email)
	.fetch_optional(pool)
	.await
	.map_err(|e| { tracing::error!(error = %e, "Failed to load login account"); internal_handler_error("Failed to load login account") })?;

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
        internal_handler_error("Failed to create login challenge")
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
	.map_err(|e| { tracing::error!(error = %e, "Failed to create login attempt"); internal_handler_error("Failed to create login attempt") })?;

    let kdf_params = default_login_kdf_params(&salt);
    Ok(StartLoginResponse {
        attempt_id,
        salt: salt.clone(),
        server_public_key: ephemeral.public.clone(),
        kdf_params: LoginKdfParamsResponse {
            schema_version: kdf_params.schema_version,
            algorithm: kdf_params.algorithm,
            iterations: kdf_params.iterations,
            salt,
        },
    })
}

pub(crate) async fn finish_login(
    app_state: &AppState,
    request: &RequestMetadata,
    input: FinishLoginInput,
) -> Result<FinishLoginResponse, AppError> {
    validate_login_attempt_id(&input.attempt_id)?;
    validate_hex_string(&input.client_public_key, "Invalid client public key")?;
    validate_hex_string(&input.client_proof, "Invalid client proof")?;
    let pool = db_pool(app_state)?;
    let attempt = query_as::<_, DbLoginAttemptRow>(
		"SELECT id, user_id, normalized_email_hash, client_public_key, server_ephemeral_secret, expires_at FROM login_attempt WHERE id = $1 LIMIT 1",
	)
	.bind(&input.attempt_id)
	.fetch_optional(pool)
	.await
	.map_err(|e| { tracing::error!(error = %e, "Failed to load login attempt"); internal_handler_error("Failed to load login attempt") })?
	.ok_or_else(|| AppError::unauthorized("Invalid credentials"))?;

    query("DELETE FROM login_attempt WHERE id = $1")
        .bind(&attempt.id)
        .execute(pool)
        .await
        .map_err(|e| {
            tracing::error!(error = %e, "Failed to consume login attempt");
            internal_handler_error("Failed to consume login attempt")
        })?;

    if attempt.expires_at <= now_utc() || attempt.client_public_key != input.client_public_key {
        return Err(AppError::unauthorized("Invalid credentials"));
    }

    let Some(user_id) = attempt.user_id.as_deref() else {
        return Err(AppError::unauthorized("Invalid credentials"));
    };
    let user = query_as::<_, DbLoginUserRow>(
		"SELECT id, email, name, secret_key_hint, srp_salt, srp_verifier, public_key, encrypted_private_key FROM \"user\" WHERE id = $1 LIMIT 1",
	)
	.bind(user_id)
	.fetch_optional(pool)
	.await
	.map_err(|e| { tracing::error!(error = %e, "Failed to load login account"); internal_handler_error("Failed to load login account") })?
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
    let session = app_state
        .sessions
        .create_session(&user.id, &request)
        .await?;

    Ok(FinishLoginResponse {
        token: session.token,
        session_id: session.session_id,
        expires_at: format_rfc3339(session.expires_at),
        server_proof: session_result.proof.clone(),
        user: LoginUserResponse {
            id: user.id,
            email: user.email,
            name: user.name,
            secret_key_hint: user.secret_key_hint.unwrap_or_default(),
            public_key: user.public_key,
            encrypted_private_key: user.encrypted_private_key,
        },
    })
}

pub(crate) async fn request_recovery_verification(
    app_state: &AppState,
    request: &RequestMetadata,
    input: RequestRecoveryVerificationInput,
) -> Result<LogoutResponse, AppError> {
    let _request = request;
    let pool = db_pool(app_state)?;
    let normalized_email = normalize_email(&input.email);
    let existing_user = query_as::<_, DbRecoveryUserDataRow>(
		"SELECT id, encrypted_master_key, encrypted_private_key, secret_key_hint, recovery_key_hint FROM \"user\" WHERE LOWER(email) = $1 LIMIT 1",
	)
	.bind(&normalized_email)
	.fetch_optional(pool)
	.await
	.map_err(|e| { tracing::error!(error = %e, "Failed to load recovery account"); internal_handler_error("Failed to load recovery account") })?;

    if existing_user
        .as_ref()
        .and_then(|row| row.encrypted_master_key.as_ref())
        .is_some()
    {
        let code = create_recovery_verification(pool, &normalized_email).await?;
        send_recovery_code(&normalized_email, &code)?;
    }

    Ok(LogoutResponse { success: true })
}

pub(crate) async fn verify_recovery_code(
    app_state: &AppState,
    request: &RequestMetadata,
    input: VerifyRecoveryCodeInput,
) -> Result<VerifyRecoveryCodeResponse, AppError> {
    let _request = request;
    let pool = db_pool(app_state)?;
    let normalized_email = normalize_email(&input.email);
    let is_valid = verify_recovery_code_attempt(pool, &normalized_email, &input.code).await?;

    if !is_valid {
        return Ok(VerifyRecoveryCodeResponse {
            success: false,
            recovery_token: None,
        });
    }

    Ok(VerifyRecoveryCodeResponse {
        success: true,
        recovery_token: Some(create_recovery_token(&normalized_email)?),
    })
}

pub(crate) async fn get_recovery_data(
    app_state: &AppState,
    request: &RequestMetadata,
    input: GetRecoveryDataInput,
) -> Result<GetRecoveryDataResponse, AppError> {
    let _request = request;
    let pool = db_pool(app_state)?;
    let recovery_email = verify_recovery_token(&input.recovery_token)
        .await
        .ok_or_else(|| unauthorized_handler_error("Invalid recovery session"))?;
    let recovery_data = load_recovery_data(pool, &recovery_email)
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
    let pool = db_pool(app_state)?;
    let recovery_email = verify_recovery_token(&input.recovery_token)
        .await
        .ok_or_else(|| unauthorized_handler_error("Invalid recovery session"))?;
    let (user_id, revoked_session_ids) =
        reset_user_password_with_recovery(pool, &recovery_email, &input)
            .await
            .map_err(|_| unauthorized_handler_error("Invalid recovery session"))?;
    record_session_revocations(
        pool,
        &user_id,
        &revoked_session_ids,
        "password_reset_via_recovery",
    )
    .await
    .map_err(|e| {
        tracing::error!(error = %e, "Failed to record session revocations");
        internal_handler_error("Failed to record session revocations")
    })?;
    let session = app_state
        .sessions
        .create_session(&user_id, &request)
        .await?;

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
    .map_err(|_| internal_handler_error("Failed to record recovery audit event"))?;

    Ok(ResetPasswordResponse {
        token: session.token,
        session_id: session.session_id,
        expires_at: format_rfc3339(session.expires_at),
        user_id,
    })
}

pub(crate) async fn update_email(
    app_state: &AppState,
    session: &VerifiedSession,
    input: UpdateEmailInput,
) -> Result<LogoutResponse, AppError> {
    validate_hex_string(&input.srp_salt, "Invalid SRP salt")?;
    validate_hex_string(&input.srp_verifier, "Invalid SRP verifier")?;
    validate_encrypted_vault_keys(&input.encrypted_vault_keys)?;
    let pool = db_pool(app_state)?;
    let normalized_new_email = normalize_email(&input.new_email);
    let existing_user_id =
        query_scalar::<_, String>("SELECT id FROM \"user\" WHERE LOWER(email) = $1 LIMIT 1")
            .bind(&normalized_new_email)
            .fetch_optional(pool)
            .await
            .map_err(|e| {
                tracing::error!(error = %e, "Failed to check email");
                internal_handler_error("Failed to check email")
            })?;
    if existing_user_id
        .as_deref()
        .is_some_and(|value| value != session.user_id)
    {
        return Err(bad_request_handler_error("Email already in use"));
    }

    update_user_email_data(pool, &session.user_id, &normalized_new_email, &input).await?;
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
    .map_err(|e| {
        tracing::error!(error = %e, "Failed to record session revocations");
        internal_handler_error("Failed to record session revocations")
    })?;
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
    .map_err(|_| internal_handler_error("Failed to record email change audit event"))?;

    Ok(LogoutResponse { success: true })
}

pub(crate) async fn change_password(
    app_state: &AppState,
    session: &VerifiedSession,
    input: ChangePasswordInput,
) -> Result<LogoutResponse, AppError> {
    validate_hex_string(&input.srp_salt, "Invalid SRP salt")?;
    validate_hex_string(&input.srp_verifier, "Invalid SRP verifier")?;
    validate_encrypted_vault_keys(&input.encrypted_vault_keys)?;
    let pool = db_pool(app_state)?;

    update_user_password_data(pool, &session.user_id, &input).await?;
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
    .map_err(|e| {
        tracing::error!(error = %e, "Failed to record session revocations");
        internal_handler_error("Failed to record session revocations")
    })?;
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
    .map_err(|_| internal_handler_error("Failed to record password change audit event"))?;

    Ok(LogoutResponse { success: true })
}

pub(crate) async fn regenerate_secret_key(
    app_state: &AppState,
    session: &VerifiedSession,
    input: RegenerateSecretKeyInput,
) -> Result<LogoutResponse, AppError> {
    validate_hex_string(&input.srp_salt, "Invalid SRP salt")?;
    validate_hex_string(&input.srp_verifier, "Invalid SRP verifier")?;
    validate_encrypted_vault_keys(&input.encrypted_vault_keys)?;
    let pool = db_pool(app_state)?;

    update_user_secret_key_data(pool, &session.user_id, &input).await?;
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
    .map_err(|e| {
        tracing::error!(error = %e, "Failed to record session revocations");
        internal_handler_error("Failed to record session revocations")
    })?;
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
    .map_err(|_| internal_handler_error("Failed to record secret key regeneration audit event"))?;

    Ok(LogoutResponse { success: true })
}

pub(crate) async fn store_recovery_key(
    app_state: &AppState,
    session: &VerifiedSession,
    input: StoreRecoveryKeyInput,
) -> Result<LogoutResponse, AppError> {
    let pool = db_pool(app_state)?;
    let user = query_as::<_, DbAccountMutationUserRow>(
		"SELECT u.id, u.email, u.encrypted_master_key, u.team_id, t.owner_id AS team_owner_id, t.type::text AS team_type FROM \"user\" u LEFT JOIN team t ON u.team_id = t.id WHERE u.id = $1 LIMIT 1",
	)
	.bind(&session.user_id)
	.fetch_optional(pool)
	.await
	.map_err(|e| { tracing::error!(error = %e, "Failed to load user"); internal_handler_error("Failed to load user") })?
	.ok_or_else(|| AppError::not_found("User not found"))?;
    let had_recovery_key = user.encrypted_master_key.is_some();

    store_recovery_key_data(pool, &session.user_id, &input).await?;
    insert_audit_event(
        pool,
        &generate_resource_id("audit"),
        &session.user_id,
        if had_recovery_key { "recovery_key_regenerated" } else { "recovery_key_setup" },
        "user",
        &session.user_id,
        None,
    )
    .await
    .map_err(|_| internal_handler_error("Failed to record recovery key audit event"))?;

    Ok(LogoutResponse { success: true })
}

pub(crate) async fn delete_account(
    app_state: &AppState,
    session: &VerifiedSession,
    input: DeleteAccountInput,
) -> Result<LogoutResponse, AppError> {
    let pool = db_pool(app_state)?;
    let user = query_as::<_, DbAccountMutationUserRow>(
		"SELECT u.id, u.email, u.encrypted_master_key, u.team_id, t.owner_id AS team_owner_id, t.type::text AS team_type FROM \"user\" u LEFT JOIN team t ON u.team_id = t.id WHERE u.id = $1 LIMIT 1",
	)
	.bind(&session.user_id)
	.fetch_optional(pool)
	.await
	.map_err(|e| { tracing::error!(error = %e, "Failed to load user"); internal_handler_error("Failed to load user") })?
	.ok_or_else(|| AppError::not_found("User not found"))?;

    if normalize_email(&user.email) != normalize_email(&input.confirm_email) {
        return Err(bad_request_handler_error("Email does not match"));
    }
    if user.team_owner_id.as_deref() == Some(session.user_id.as_str())
        && user.team_type.as_deref() != Some("personal")
    {
        if let Some(team_id) = user.team_id.as_deref() {
            let remaining_members =
                query_scalar::<_, i64>("SELECT COUNT(*)::bigint FROM \"user\" WHERE team_id = $1")
                    .bind(team_id)
                    .fetch_one(pool)
                    .await
                    .map_err(|e| {
                        tracing::error!(error = %e, "Failed to load team members");
                        internal_handler_error("Failed to load team members")
                    })?;
            let remaining_vaults =
                query_scalar::<_, i64>("SELECT COUNT(*)::bigint FROM vault WHERE team_id = $1")
                    .bind(team_id)
                    .fetch_one(pool)
                    .await
                    .map_err(|e| {
                        tracing::error!(error = %e, "Failed to load team vaults");
                        internal_handler_error("Failed to load team vaults")
                    })?;
            if remaining_members > 1 || remaining_vaults > 0 {
                return Err(bad_request_handler_error(
					"You cannot delete your account while you still own a non-personal team with members or team vaults. Dismantle the team or transfer ownership first.",
				));
            }
        }
    }

    insert_audit_event(
        pool,
        &generate_resource_id("audit"),
        &session.user_id,
        "account_deleted",
        "user",
        &session.user_id,
        None,
    )
    .await
    .map_err(|_| internal_handler_error("Failed to record account deletion audit event"))?;

    delete_user_account_data(pool, &session.user_id).await?;

    Ok(LogoutResponse { success: true })
}

pub(crate) async fn registration_status(
    app_state: &AppState,
) -> Result<RegistrationStatusResponse, AppError> {
    let mode = bittery_mode().to_string();
    if mode == "cloud" {
        return Ok(RegistrationStatusResponse {
            mode,
            allow_public_signup: true,
            reason: None,
        });
    }

    let allow_public_signup = match app_state.db_pool.as_ref() {
        Some(pool) => !has_any_registered_user(pool).await?,
        None => true,
    };

    Ok(RegistrationStatusResponse {
        mode,
        allow_public_signup,
        reason: if allow_public_signup {
            None
        } else {
            Some("invite_only_after_bootstrap".to_string())
        },
    })
}

pub(crate) async fn check_email(
    app_state: &AppState,
    input: CheckEmailInput,
) -> Result<CheckEmailResponse, AppError> {
    let normalized_email = normalize_email(&input.email);
    let secret_key_hint = match app_state.db_pool.as_ref() {
        Some(pool) => query_as::<_, DbCheckEmailRow>(
            "SELECT secret_key_hint FROM \"user\" WHERE LOWER(email) = $1 LIMIT 1",
        )
        .bind(&normalized_email)
        .fetch_optional(pool)
        .await
        .map_err(|e| {
            tracing::error!(error = %e, "Failed to load account");
            internal_handler_error("Failed to load account")
        })?
        .and_then(|row| row.secret_key_hint)
        .unwrap_or_else(|| deterministic_fake_hint(&normalized_email)),
        None => deterministic_fake_hint(&normalized_email),
    };

    Ok(CheckEmailResponse {
        exists: true,
        secret_key_hint,
    })
}

pub(crate) async fn get_me(app_state: &AppState, session: &VerifiedSession) -> Result<MeResponse, AppError> {
    let pool = app_state
        .db_pool
        .as_ref()
        .ok_or_else(|| internal_handler_error("Database is not configured"))?;
    let user = query_as::<_, DbMeRow>(
		"SELECT u.id, u.email, u.name, u.team_id, t.name AS team_name, t.type::text AS team_type, t.image_key AS team_image_key, u.role::text AS role, u.secret_key_hint, u.public_key, u.encrypted_private_key, u.encrypted_master_key, u.created_at FROM \"user\" u LEFT JOIN team t ON u.team_id = t.id WHERE u.id = $1 LIMIT 1",
	)
	.bind(&session.user_id)
	.fetch_optional(pool)
	.await
	.map_err(|e| { tracing::error!(error = %e, "Failed to load user"); internal_handler_error("Failed to load user") })?
	.ok_or_else(|| AppError::not_found("User not found"))?;

    Ok(MeResponse {
        id: user.id,
        email: user.email,
        name: user.name,
        team_id: user.team_id,
        team_name: user.team_name,
        team_type: user.team_type,
        team_avatar_url: user.team_image_key.map(storage_public_url),
        role: user.role,
        secret_key_hint: user.secret_key_hint,
        public_key: user.public_key,
        encrypted_private_key: user.encrypted_private_key,
        has_recovery_key: user.encrypted_master_key.is_some(),
        created_at: format_rfc3339(user.created_at),
    })
}

pub(crate) async fn list_devices(
    app_state: &AppState,
    session: &VerifiedSession,
) -> Result<Vec<DeviceSessionResponse>, AppError> {
    app_state
        .sessions
        .list_devices(&session.user_id, &session.session_id)
        .await
}

pub(crate) async fn revoke_device(
    app_state: &AppState,
    session: &VerifiedSession,
    input: SessionIdInput,
) -> Result<LogoutResponse, AppError> {
    if input.session_id == session.session_id {
        return Err(AppError::bad_request(
            "Cannot revoke current session. Use logout instead.",
        ));
    }

    let target_session = app_state
        .sessions
        .get_owned_session(&input.session_id, &session.user_id)
        .await?;
    let current_session = app_state
        .sessions
        .get_owned_session(&session.session_id, &session.user_id)
        .await?;

    if let (Some(target_session), Some(current_session)) = (&target_session, &current_session) {
        if is_grouped_client_session(target_session)
            && is_grouped_client_session(current_session)
            && target_session.client_id == current_session.client_id
        {
            return Err(AppError::bad_request(
                "Cannot revoke current session. Use logout instead.",
            ));
        }
    }

    let revoked_session_ids = app_state
        .sessions
        .revoke_device(&input.session_id, &session.user_id)
        .await?;

    if !revoked_session_ids.is_empty() {
        for revoked_session_id in &revoked_session_ids {
            app_state.sync_control.publish_session_revoked(
                &session.user_id,
                revoked_session_id,
                "device_revoked",
            );
        }

        if let Some(pool) = app_state.db_pool.as_ref() {
            record_session_revocations(
                pool,
                &session.user_id,
                &revoked_session_ids,
                "device_revoked",
            )
            .await
            .map_err(|e| {
                tracing::error!(error = %e, "Failed to record session revocations");
                internal_handler_error("Failed to record session revocations")
            })?;
            insert_audit_event(
                pool,
                &format!(
                    "audit_{}",
                    &hash_token(&generate_opaque_session_token())[..16]
                ),
                &session.user_id,
                "device_revoked",
                "session",
                &input.session_id,
                None,
            )
            .await
            .map_err(|_| internal_handler_error("Failed to record device revoke audit event"))?;
        }
    }

    Ok(LogoutResponse { success: true })
}

pub(crate) async fn rename_device(
    app_state: &AppState,
    session: &VerifiedSession,
    input: RenameDeviceInput,
) -> Result<LogoutResponse, AppError> {
    if input.device_name.trim().is_empty() || input.device_name.len() > 100 {
        return Err(AppError::bad_request(
            "Device name must be between 1 and 100 characters",
        ));
    }

    app_state
        .sessions
        .rename_device(
            &input.session_id,
            &session.user_id,
            input.device_name.trim(),
        )
        .await?;
    Ok(LogoutResponse { success: true })
}

pub(crate) async fn do_heartbeat(app_state: &AppState, session: &VerifiedSession) -> Result<LogoutResponse, AppError> {
    app_state
        .sessions
        .heartbeat(&session.session_id)
        .await?;
    Ok(LogoutResponse { success: true })
}

pub(crate) async fn do_logout(app_state: &AppState, session: &VerifiedSession) -> Result<LogoutResponse, AppError> {
    let revoked_session_ids = app_state
        .sessions
        .delete_session(&session.session_id)
        .await?;
    if let Some(pool) = app_state.db_pool.as_ref() {
        record_session_revocations(pool, &session.user_id, &revoked_session_ids, "logout")
            .await
            .map_err(|e| {
                tracing::error!(error = %e, "Failed to record session revocations");
                internal_handler_error("Failed to record session revocations")
            })?;
    }
    Ok(LogoutResponse { success: true })
}

pub(crate) async fn do_logout_all(app_state: &AppState, session: &VerifiedSession) -> Result<LogoutResponse, AppError> {
    let revoked_session_ids = app_state
        .sessions
        .delete_all_user_sessions(&session.user_id)
        .await?;

    if let Some(pool) = app_state.db_pool.as_ref() {
        record_session_revocations(
            pool,
            &session.user_id,
            &revoked_session_ids,
            "logout_all",
        )
        .await
        .map_err(|e| {
            tracing::error!(error = %e, "Failed to record session revocations");
            internal_handler_error("Failed to record session revocations")
        })?;
        insert_audit_event(
            pool,
            &format!(
                "audit_{}",
                &hash_token(&generate_opaque_session_token())[..16]
            ),
            &session.user_id,
            "logout_all",
            "session",
            &session.session_id,
            None,
        )
        .await
        .map_err(|_| internal_handler_error("Failed to record logout audit event"))?;
    }

    Ok(LogoutResponse { success: true })
}

pub(crate) async fn do_refresh_session(
    app_state: &AppState,
    session: &VerifiedSession,
) -> Result<RefreshSessionResponse, AppError> {
    app_state.sessions.refresh_session(session).await
}

pub async fn rpc_request_context_middleware(
    State(state): State<AppState>,
    mut request: Request<axum::body::Body>,
    next: Next,
) -> Response {
    let metadata = RequestMetadata {
        auth_token: parse_bearer_token(&request),
        client_id: header_value(&request, CLIENT_ID_HEADER),
        app_platform: header_value(&request, APP_PLATFORM_HEADER),
        user_agent: header_value(&request, "user-agent"),
        ip_address: header_value(&request, "x-forwarded-for")
            .map(|v| v.split(',').next().unwrap_or("").trim().to_owned())
            .filter(|v| !v.is_empty())
            .or_else(|| header_value(&request, "x-real-ip")),
    };

    let auth_token = metadata.auth_token.clone();
    let verified_session = auth_token
        .as_deref()
        .map(|token| state.sessions.verify_token(token));

    let verified_session = match verified_session {
        Some(future) => future.await,
        None => None,
    };

    request.extensions_mut().insert(metadata);
    if let Some(session) = verified_session.clone() {
        request.extensions_mut().insert(session);
    }

    let mut response = next.run(request).await;
    if let Some(session) = verified_session {
        if let Ok(value) = HeaderValue::from_str(&format_rfc3339(session.expires_at)) {
            response
                .headers_mut()
                .insert(session_expiry_header_name(), value);
        }
    }

    response
}

fn parse_bearer_token(request: &Request<axum::body::Body>) -> Option<String> {
    header_value(request, AUTHORIZATION_HEADER).and_then(|value| {
        value
            .strip_prefix("Bearer ")
            .or_else(|| value.strip_prefix("bearer "))
            .map(ToOwned::to_owned)
    })
}

fn header_value(request: &Request<axum::body::Body>, name: &str) -> Option<String> {
    request
        .headers()
        .get(name)
        .and_then(|value| value.to_str().ok())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
}

fn normalize_email(email: &str) -> String {
    email.trim().to_ascii_lowercase()
}

fn hash_normalized_email(normalized_email: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(normalized_email.as_bytes());
    hex::encode(hasher.finalize())
}

fn build_login_attempt_id(normalized_email_hash: &str) -> String {
    format!(
        "{normalized_email_hash}:{}",
        generate_resource_id("attempt")
    )
}

fn build_fake_login_salt(normalized_email: &str) -> String {
    let secret = jwt_signing_secret();
    let mut hasher = Sha256::new();
    hasher.update(secret.as_bytes());
    hasher.update(normalized_email.as_bytes());
    hex::encode(hasher.finalize())
}

fn deterministic_fake_hint(email: &str) -> String {
    let secret =
        std::env::var("JWT_SECRET").unwrap_or_else(|_| "bittery-dev-email-hint-secret".to_string());
    let digest = Sha256::digest(format!("{secret}:{}", normalize_email(email)).as_bytes());
    format!("A3-{}", hex::encode_upper(&digest[..4]))
}

fn generate_signup_verification_code() -> String {
    rand::thread_rng().gen_range(100000..=999999).to_string()
}

fn jwt_signing_secret() -> String {
    std::env::var("JWT_SECRET").unwrap_or_else(|_| "bittery-dev-auth-secret".to_string())
}

fn is_dev_auth_stub_enabled() -> bool {
    matches!(
        std::env::var("BITTERY_ENABLE_DEV_AUTH_STUBS")
            .ok()
            .as_deref(),
        Some("true")
    ) && !matches!(
        std::env::var("NODE_ENV").ok().as_deref(),
        Some("production")
    )
}

fn create_signup_verification_token(
    email: &str,
    invitation_token: Option<&str>,
) -> Result<String, AppError> {
    let issued_at = now_utc().unix_timestamp() as usize;
    let expires_at =
        (now_utc() + Duration::minutes(SIGNUP_VERIFICATION_TTL_MINUTES)).unix_timestamp() as usize;
    let claims = SignupVerificationTokenClaims {
        email: email.to_string(),
        invitation_token: invitation_token.map(ToOwned::to_owned),
        token_type: "signup_verification".to_string(),
        iss: JWT_ISSUER.to_string(),
        aud: SIGNUP_VERIFICATION_JWT_AUDIENCE.to_string(),
        exp: expires_at,
        iat: issued_at,
    };

    encode(
        &Header::new(Algorithm::HS256),
        &claims,
        &EncodingKey::from_secret(jwt_signing_secret().as_bytes()),
    )
    .map_err(|_| internal_handler_error("Failed to create signup verification token"))
}

fn create_recovery_token(email: &str) -> Result<String, AppError> {
    let issued_at = now_utc().unix_timestamp() as usize;
    let expires_at = (now_utc() + Duration::minutes(RECOVERY_VERIFICATION_TTL_MINUTES))
        .unix_timestamp() as usize;
    let claims = RecoveryTokenClaims {
        email: email.to_string(),
        token_type: "recovery".to_string(),
        iss: JWT_ISSUER.to_string(),
        aud: RECOVERY_JWT_AUDIENCE.to_string(),
        exp: expires_at,
        iat: issued_at,
    };

    encode(
        &Header::new(Algorithm::HS256),
        &claims,
        &EncodingKey::from_secret(jwt_signing_secret().as_bytes()),
    )
    .map_err(|_| internal_handler_error("Failed to create recovery token"))
}

async fn verify_recovery_token(token: &str) -> Option<String> {
    let mut validation = Validation::new(Algorithm::HS256);
    validation.set_audience(&[RECOVERY_JWT_AUDIENCE]);
    validation.set_issuer(&[JWT_ISSUER]);

    decode::<RecoveryTokenClaims>(
        token,
        &DecodingKey::from_secret(jwt_signing_secret().as_bytes()),
        &validation,
    )
    .ok()
    .and_then(|data| {
        if data.claims.token_type != "recovery" {
            None
        } else {
            Some(data.claims.email)
        }
    })
}

pub async fn verify_signup_verification_token(token: &str) -> Option<(String, Option<String>)> {
    let mut validation = Validation::new(Algorithm::HS256);
    validation.set_audience(&[SIGNUP_VERIFICATION_JWT_AUDIENCE]);
    validation.set_issuer(&[JWT_ISSUER]);

    decode::<SignupVerificationTokenClaims>(
        token,
        &DecodingKey::from_secret(jwt_signing_secret().as_bytes()),
        &validation,
    )
    .ok()
    .and_then(|data| {
        if data.claims.token_type != "signup_verification" {
            None
        } else {
            Some((data.claims.email, data.claims.invitation_token))
        }
    })
}

async fn get_pending_invitation_for_signup(
    pool: &PgPool,
    invitation_token: &str,
    normalized_email: &str,
) -> Result<DbTeamInvitationAcceptRow, AppError> {
    let is_self_hosted = bittery_mode() == "self-hosted";
    repo_auth::get_pending_invitation_for_signup(pool, invitation_token, normalized_email, is_self_hosted).await
}

async fn create_signup_verification(
    pool: &PgPool,
    email: &str,
    invitation_token: Option<&str>,
) -> Result<String, AppError> {
    let code = generate_signup_verification_code();
    let id = format!("signup_verify_{}", &hash_token(&generate_opaque_session_token())[..16]);
    let expires_at = now_utc() + Duration::minutes(SIGNUP_VERIFICATION_TTL_MINUTES);
    repo_auth::create_signup_verification(pool, &id, email, invitation_token, &code, expires_at).await?;
    Ok(code)
}

async fn create_recovery_verification(pool: &PgPool, email: &str) -> Result<String, AppError> {
    let code = generate_signup_verification_code();
    let expires_at = now_utc() + Duration::minutes(RECOVERY_VERIFICATION_TTL_MINUTES);
    repo_auth::create_recovery_verification(pool, email, &code, expires_at).await?;
    Ok(code)
}

async fn consume_signup_verification_code(
    pool: &PgPool,
    email: &str,
    code: &str,
    invitation_token: Option<&str>,
) -> Result<bool, AppError> {
    repo_auth::consume_signup_verification_code(pool, email, code, invitation_token).await
}

async fn verify_recovery_code_attempt(
    pool: &PgPool,
    email: &str,
    code: &str,
) -> Result<bool, AppError> {
    repo_auth::verify_recovery_code_attempt(pool, email, code).await
}

async fn load_recovery_data(
    pool: &PgPool,
    email: &str,
) -> Result<Option<DbRecoveryUserDataRow>, AppError> {
    repo_auth::load_recovery_data(pool, email).await
}

async fn load_recovery_vault_keys(
    pool: &PgPool,
    user_id: &str,
) -> Result<Vec<RecoveryVaultKeyResponse>, AppError> {
    repo_auth::load_recovery_vault_keys(pool, user_id).await
}

async fn reset_user_password_with_recovery(
    pool: &PgPool,
    email: &str,
    input: &ResetPasswordInput,
) -> Result<(String, Vec<String>), AppError> {
    repo_auth::reset_user_password_with_recovery(
        pool,
        email,
        &input.srp_salt,
        &input.srp_verifier,
        &input.encrypted_private_key,
        &input.encrypted_master_key,
        &input.recovery_key_hint,
        input.secret_key_hint.as_deref(),
        &input.encrypted_vault_keys,
    ).await
}

fn validate_encrypted_vault_keys(
    encrypted_vault_keys: &[EncryptedVaultKeyInput],
) -> Result<(), AppError> {
    for entry in encrypted_vault_keys {
        validate_resource_id(&entry.vault_id)?;
        if entry.encrypted_vault_key.trim().is_empty() {
            return Err(bad_request_handler_error("Invalid encrypted vault key"));
        }
    }
    Ok(())
}

async fn update_user_email_data(
    pool: &PgPool,
    user_id: &str,
    new_email: &str,
    input: &UpdateEmailInput,
) -> Result<(), AppError> {
    repo_auth::update_user_email_data(
        pool,
        user_id,
        new_email,
        &input.srp_salt,
        &input.srp_verifier,
        &input.encrypted_private_key,
        &input.encrypted_vault_keys,
    ).await
}

async fn update_user_password_data(
    pool: &PgPool,
    user_id: &str,
    input: &ChangePasswordInput,
) -> Result<(), AppError> {
    repo_auth::update_user_password_data(
        pool,
        user_id,
        &input.srp_salt,
        &input.srp_verifier,
        &input.encrypted_private_key,
        &input.encrypted_vault_keys,
    ).await
}

async fn update_user_secret_key_data(
    pool: &PgPool,
    user_id: &str,
    input: &RegenerateSecretKeyInput,
) -> Result<(), AppError> {
    repo_auth::update_user_secret_key_data(
        pool,
        user_id,
        &input.secret_key_hint,
        &input.srp_salt,
        &input.srp_verifier,
        &input.encrypted_private_key,
        &input.encrypted_vault_keys,
    ).await
}

async fn store_recovery_key_data(
    pool: &PgPool,
    user_id: &str,
    input: &StoreRecoveryKeyInput,
) -> Result<(), AppError> {
    repo_auth::store_recovery_key_data(pool, user_id, &input.encrypted_master_key, &input.recovery_key_hint).await
}

async fn delete_user_account_data(pool: &PgPool, user_id: &str) -> Result<(), AppError> {
    repo_auth::delete_user_account_data(pool, user_id).await
}

fn send_signup_verification_code(
    email: &str,
    code: &str,
    invitation_token: Option<&str>,
) -> Result<(), AppError> {
    if !is_dev_auth_stub_enabled() {
        return Err(internal_handler_error(
			"Auth email delivery is not configured. Set BITTERY_ENABLE_DEV_AUTH_STUBS=true for local development or configure a real email provider.",
		));
    }
    let _ = email;
    let _ = code;
    let _ = invitation_token;
    info!("[auth-email] Signup verification requested via enabled dev stub");
    Ok(())
}

fn send_recovery_code(email: &str, code: &str) -> Result<(), AppError> {
    if !is_dev_auth_stub_enabled() {
        return Err(internal_handler_error(
			"Auth email delivery is not configured. Set BITTERY_ENABLE_DEV_AUTH_STUBS=true for local development or configure a real email provider.",
		));
    }
    let _ = email;
    let _ = code;
    info!("[auth-email] Recovery code requested via enabled dev stub");
    Ok(())
}

async fn assert_valid_signup_verification_token(
    signup_verification_token: &str,
    email: &str,
    invitation_token: Option<&str>,
) -> Result<(), AppError> {
    let Some((token_email, token_invitation)) =
        verify_signup_verification_token(signup_verification_token).await
    else {
        return Err(AppError::unauthorized("Invalid signup verification"));
    };
    if token_email != email || token_invitation.as_deref() != invitation_token {
        return Err(AppError::unauthorized("Invalid signup verification"));
    }

    Ok(())
}

async fn ensure_user_does_not_exist(pool: &PgPool, email: &str) -> Result<(), AppError> {
    repo_auth::ensure_user_does_not_exist(pool, email).await
}

async fn get_pending_signup_invitation(
    pool: &PgPool,
    invitation_token: &str,
    normalized_email: &str,
) -> Result<DbSignupInvitationRow, AppError> {
    let is_self_hosted = bittery_mode() == "self-hosted";
    repo_auth::get_pending_signup_invitation(pool, invitation_token, normalized_email, is_self_hosted).await
}

#[derive(Clone, Copy)]
struct CreateUserParams<'a> {
    user_id: &'a str,
    email: &'a str,
    name: &'a str,
    email_verified: bool,
    secret_key_hint: &'a str,
    srp_salt: &'a str,
    srp_verifier: &'a str,
    public_key: &'a str,
    encrypted_private_key: &'a str,
    encrypted_master_key: Option<&'a str>,
    recovery_key_hint: Option<&'a str>,
}

async fn insert_user_account(
    transaction: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    params: CreateUserParams<'_>,
) -> Result<(), AppError> {
    repo_auth::insert_user_account(transaction, repo_auth::CreateUserParams {
        user_id: params.user_id,
        email: params.email,
        name: params.name,
        email_verified: params.email_verified,
        secret_key_hint: params.secret_key_hint,
        srp_salt: params.srp_salt,
        srp_verifier: params.srp_verifier,
        public_key: params.public_key,
        encrypted_private_key: params.encrypted_private_key,
        encrypted_master_key: params.encrypted_master_key,
        recovery_key_hint: params.recovery_key_hint,
    }).await
}

async fn insert_team(
    transaction: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    team_id: &str,
    team_name: &str,
    owner_id: &str,
    team_type: &str,
    member_limit: Option<i32>,
    billing_plan: &str,
    billing_status: &str,
) -> Result<(), AppError> {
    repo_auth::insert_team(transaction, team_id, team_name, owner_id, team_type, member_limit, billing_plan, billing_status).await
}

async fn insert_personal_vault(
    transaction: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    vault_id: &str,
    user_id: &str,
    encrypted_vault_key: &str,
) -> Result<(), AppError> {
    repo_auth::insert_personal_vault(transaction, vault_id, user_id, encrypted_vault_key).await
}

async fn load_auth_vault_keys(
    pool: &PgPool,
    user_id: &str,
) -> Result<Vec<AuthVaultKeyResponse>, AppError> {
    repo_auth::load_auth_vault_keys(pool, user_id).await
}

fn normalize_signup_plan(plan: Option<&str>) -> Result<&'static str, AppError> {
    match plan.map(|value| value.trim().to_ascii_lowercase()) {
        None => Ok("personal"),
        Some(value) if value == "free" => Ok("free"),
        Some(value) if value == "personal" => Ok("personal"),
        Some(value) if value == "family" => Ok("family"),
        Some(value) if value == "team" => Ok("team"),
        _ => Err(AppError::bad_request("Invalid plan")),
    }
}

fn map_plan_to_team_type(plan: &str) -> &'static str {
    match plan {
        "family" => "family",
        "team" => "organization",
        _ => "personal",
    }
}

fn plan_member_limit(plan: &str) -> Option<i32> {
    match plan {
        "free" | "personal" => Some(1),
        "family" => Some(6),
        "team" => None,
        _ => Some(1),
    }
}

fn signup_team_name(
    self_hosted_mode: bool,
    team_type: &str,
    organization_name: Option<&str>,
) -> String {
    let provided = organization_name
        .map(str::trim)
        .filter(|value| !value.is_empty());
    if self_hosted_mode {
        return provided.unwrap_or("Bittery Instance").to_string();
    }
    if let Some(name) = provided {
        return name.to_string();
    }
    if team_type == "family" {
        "My Family".to_string()
    } else {
        "My Team".to_string()
    }
}

fn validate_signup_input(input: &SignupInput) -> Result<(), AppError> {
    if let Some(user_id) = input.user_id.as_deref() {
        validate_resource_id(user_id)?;
    }
    if let Some(vault_id) = input.vault_id.as_deref() {
        validate_resource_id(vault_id)?;
    }
    validate_hex_string(&input.srp_salt, "Invalid SRP salt")?;
    validate_hex_string(&input.srp_verifier, "Invalid SRP verifier")?;
    Ok(())
}

fn validate_signup_with_invitation_input(
    input: &SignupWithInvitationInput,
) -> Result<(), AppError> {
    validate_token(&input.token)?;
    if let Some(user_id) = input.user_id.as_deref() {
        validate_resource_id(user_id)?;
    }
    if let Some(vault_id) = input.vault_id.as_deref() {
        validate_resource_id(vault_id)?;
    }
    validate_hex_string(&input.srp_salt, "Invalid SRP salt")?;
    validate_hex_string(&input.srp_verifier, "Invalid SRP verifier")?;
    Ok(())
}

fn validate_resource_id(value: &str) -> Result<(), AppError> {
    static RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(
		r"^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|[A-Za-z0-9_-]{10,64})$",
	).expect("resource id regex should be valid"));
    if value.len() <= 64 && RE.is_match(value) {
        Ok(())
    } else {
        Err(bad_request_handler_error("Invalid resource ID"))
    }
}

fn validate_hex_string(value: &str, message: &str) -> Result<(), AppError> {
    if value.is_empty()
        || value.len() % 2 != 0
        || !value.chars().all(|character| character.is_ascii_hexdigit())
    {
        return Err(bad_request_handler_error(message));
    }
    Ok(())
}

fn validate_login_attempt_id(value: &str) -> Result<(), AppError> {
    static RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[a-f0-9]{64}:[A-Za-z0-9_-]{10,64}$")
        .expect("login attempt id regex should be valid"));
    if RE.is_match(value) {
        Ok(())
    } else {
        Err(bad_request_handler_error("Invalid login attempt ID"))
    }
}

fn validate_token(token: &str) -> Result<(), AppError> {
    if token.len() != 32
        || !token.chars().all(|character| {
            character.is_ascii_alphanumeric() || character == '_' || character == '-'
        })
    {
        return Err(bad_request_handler_error("Invalid token"));
    }

    Ok(())
}

fn parse_pending_vault_keys(
    raw_pending_vault_keys: Option<&str>,
) -> Result<Vec<PendingVaultKeyEntry>, AppError> {
    let Some(raw_value) = raw_pending_vault_keys else {
        return Ok(Vec::new());
    };
    if raw_value.trim().is_empty() {
        return Ok(Vec::new());
    }
    let parsed = serde_json::from_str::<Vec<PendingVaultKeyEntry>>(raw_value)
        .map_err(|_| bad_request_handler_error("Invalid pendingVaultKeys payload"))?;
    let mut seen_vault_ids = std::collections::HashSet::with_capacity(parsed.len());
    for (index, entry) in parsed.iter().enumerate() {
        if entry.vault_id.trim().is_empty() || entry.encrypted_vault_key.trim().is_empty() {
            return Err(bad_request_handler_error(&format!(
                "Invalid pendingVaultKeys entry at index {index}",
            )));
        }
        if !seen_vault_ids.insert(entry.vault_id.trim().to_string()) {
            return Err(bad_request_handler_error(
                "Duplicate vault IDs are not allowed in pendingVaultKeys",
            ));
        }
    }
    Ok(parsed
        .into_iter()
        .map(|entry| PendingVaultKeyEntry {
            vault_id: entry.vault_id.trim().to_string(),
            encrypted_vault_key: entry.encrypted_vault_key.trim().to_string(),
        })
        .collect())
}

async fn assert_pending_vault_keys_authorized(
    pool: &PgPool,
    team_id: &str,
    inviter_id: &str,
    pending_vault_keys: &[PendingVaultKeyEntry],
) -> Result<(), AppError> {
    repo_auth::assert_pending_vault_keys_authorized(pool, team_id, inviter_id, pending_vault_keys).await
}

fn storage_public_url(key: String) -> String {
    storage::public_url(key)
}

async fn has_any_registered_user(pool: &PgPool) -> Result<bool, AppError> {
    repo_auth::has_any_registered_user(pool).await
}

fn unauthorized_error(message: &str) -> RpcError {
    AppError::unauthorized(message).into()
}

fn internal_handler_error(message: &str) -> AppError {
    AppError::internal(message)
}

fn unauthorized_handler_error(message: &str) -> AppError {
    AppError::unauthorized(message)
}

fn bad_request_handler_error(message: &str) -> AppError {
    AppError::bad_request(message)
}

fn session_expiry_header_name() -> HeaderName {
    HeaderName::from_static(SESSION_EXPIRY_HEADER)
}

#[cfg(test)]
mod tests {
    use axum::{
        body::Body,
        http::{
            header::{AUTHORIZATION, CONTENT_TYPE},
            HeaderMap, HeaderValue, Request, StatusCode,
        },
    };
    use bittery_crypto_core::srp6a::SrpClient;
    use serde_json::json;
    use sqlx::{query, query_scalar, PgPool};
    use std::{
        future::Future,
        sync::{Mutex, OnceLock},
    };

    use super::{
        deterministic_fake_hint, header_value, normalize_email,
        normalize_signup_plan,
        parse_bearer_token, parse_pending_vault_keys, plan_member_limit,
        signup_team_name, validate_hex_string,
        validate_login_attempt_id, validate_resource_id, validate_token,
    };
    use crate::services::session::now_utc;
    use crate::test_support::{
        assign_user_to_team, authenticated_json_headers, seed_team, seed_user, seed_vault,
        seed_vault_key, with_rpc_test_app, RpcTestApp,
    };
    use time::{Duration, OffsetDateTime};

    const TEST_SRP_ITERATIONS: u32 = 1_000;

    #[derive(Clone)]
    struct AuthCryptoFixture {
        auth_password: String,
        srp_salt: String,
        srp_verifier: String,
        secret_key_hint: String,
        public_key: String,
        encrypted_private_key: String,
        encrypted_master_key: String,
        recovery_key_hint: String,
        encrypted_vault_key: String,
    }

    struct AuthAccountFixture {
        user_id: String,
        email: String,
        vault_id: String,
    }

    struct AuthInvitationFixture {
        team_id: String,
        team_vault_id: String,
        invitation_token: String,
        invited_email: String,
    }

    struct LoginEphemeralFixture {
        public_key: String,
        secret: String,
    }

    #[tokio::test]
    async fn auth_public_signup_login_and_logout_flow() {
        with_auth_test_env_async(Some("cloud"), async {
            with_rpc_test_app(
                "auth_public_signup_login_and_logout_flow",
                |app| async move {
                    let email = "MixedCase.Auth@example.com";
                    let normalized_email = normalize_email(email);
                    let crypto = build_auth_crypto_fixture("public-signup", "signup-password-123");

                    let registration = app
                        .rpc_call(
                            "auth.registrationStatus",
                            json!([]),
                            unauthenticated_json_headers(),
                        )
                        .await;
                    assert_eq!(registration.status, StatusCode::OK);
                    assert_eq!(registration.body["result"]["Ok"]["mode"], json!("cloud"));
                    assert_eq!(
                        registration.body["result"]["Ok"]["allowPublicSignup"],
                        json!(true)
                    );

                    let unknown_email = app
                        .rpc_call(
                            "auth.checkEmail",
                            json!([{ "email": email }]),
                            unauthenticated_json_headers(),
                        )
                        .await;
                    assert_eq!(unknown_email.status, StatusCode::OK);
                    assert_eq!(unknown_email.body["result"]["Ok"]["exists"], json!(true));
                    assert_eq!(
                        unknown_email.body["result"]["Ok"]["secretKeyHint"],
                        json!(deterministic_fake_hint(&normalized_email)),
                    );

                    let request_verification = app
                        .rpc_call(
                            "auth.requestSignupVerification",
                            json!([{ "email": email, "invitationToken": null }]),
                            unauthenticated_json_headers(),
                        )
                        .await;
                    assert_eq!(request_verification.status, StatusCode::OK);
                    assert_eq!(
                        request_verification.body["result"]["Ok"]["success"],
                        json!(true)
                    );

                    let code = latest_signup_verification_code(&app.pool, email, None).await;

                    let wrong_code = app
                        .rpc_call(
                            "auth.verifySignupVerification",
                            json!([{ "email": email, "code": "000000", "invitationToken": null }]),
                            unauthenticated_json_headers(),
                        )
                        .await;
                    assert_eq!(wrong_code.status, StatusCode::OK);
                    assert_eq!(wrong_code.body["result"]["Ok"]["success"], json!(false));
                    assert_eq!(
                        wrong_code.body["result"]["Ok"]["signupVerificationToken"],
                        json!(null)
                    );

                    let verify = app
                        .rpc_call(
                            "auth.verifySignupVerification",
                            json!([{ "email": email, "code": code, "invitationToken": null }]),
                            unauthenticated_json_headers(),
                        )
                        .await;
                    assert_eq!(verify.status, StatusCode::OK);
                    assert_eq!(verify.body["result"]["Ok"]["success"], json!(true));
                    let signup_verification_token = verify.body["result"]["Ok"]
                        ["signupVerificationToken"]
                        .as_str()
                        .expect("signup verification token should be returned")
                        .to_string();

                    let signup = app
                        .rpc_call(
                            "auth.signup",
                            json!([{
                                "email": email,
                                "signupVerificationToken": signup_verification_token,
                                "name": "Auth Public User",
                                "plan": "personal",
                                "organizationName": null,
                                "secretKeyHint": crypto.secret_key_hint,
                                "srpSalt": crypto.srp_salt,
                                "srpVerifier": crypto.srp_verifier,
                                "publicKey": crypto.public_key,
                                "encryptedPrivateKey": crypto.encrypted_private_key,
                                "encryptedMasterKey": crypto.encrypted_master_key,
                                "recoveryKeyHint": crypto.recovery_key_hint,
                                "encryptedVaultKey": crypto.encrypted_vault_key,
                            }]),
                            unauthenticated_json_headers(),
                        )
                        .await;
                    assert_eq!(signup.status, StatusCode::OK);
                    assert_eq!(signup.body["result"]["Ok"]["success"], json!(true));
                    assert_eq!(
                        signup.body["result"]["Ok"]["user"]["email"],
                        json!(normalized_email)
                    );
                    assert_eq!(
                        signup.body["result"]["Ok"]["user"]["teamType"],
                        json!("personal")
                    );
                    let signup_token = signup.body["result"]["Ok"]["token"]
                        .as_str()
                        .expect("signup token should exist")
                        .to_string();

                    let me = app
                        .rpc_call(
                            "auth.me",
                            json!([]),
                            authenticated_json_headers(&signup_token),
                        )
                        .await;
                    assert_eq!(me.status, StatusCode::OK);
                    assert_eq!(me.body["result"]["Ok"]["email"], json!(normalized_email));
                    assert_eq!(me.body["result"]["Ok"]["hasRecoveryKey"], json!(true));

                    let existing_email = app
                        .rpc_call(
                            "auth.checkEmail",
                            json!([{ "email": normalized_email }]),
                            unauthenticated_json_headers(),
                        )
                        .await;
                    assert_eq!(existing_email.status, StatusCode::OK);
                    assert_eq!(
                        existing_email.body["result"]["Ok"]["secretKeyHint"],
                        json!(crypto.secret_key_hint),
                    );

                    let malformed_start = app
                        .rpc_call(
                            "auth.startLogin",
                            json!([{ "email": normalized_email, "clientPublicKey": "not-hex" }]),
                            unauthenticated_json_headers(),
                        )
                        .await;
                    assert_eq!(malformed_start.status, StatusCode::OK);
                    assert_handler_error(
                        &malformed_start.body,
                        "BAD_REQUEST",
                        "Invalid client public key",
                    );

                    let ephemeral = build_login_ephemeral_fixture();
                    let start_login = app
					.rpc_call(
						"auth.startLogin",
						json!([{ "email": normalized_email, "clientPublicKey": ephemeral.public_key }]),
						unauthenticated_json_headers(),
					)
					.await;
                    assert_eq!(start_login.status, StatusCode::OK);
                    let start_ok = &start_login.body["result"]["Ok"];
                    let start_salt = start_ok["salt"].as_str().expect("salt should be returned");
                    let server_public_key = start_ok["serverPublicKey"]
                        .as_str()
                        .expect("server public key should be returned");
                    let client_proof = derive_login_proof(
                        &ephemeral,
                        start_salt,
                        server_public_key,
                        &crypto.auth_password,
                        TEST_SRP_ITERATIONS,
                    );

                    let finish_login = app
                        .rpc_call(
                            "auth.finishLogin",
                            json!([{
                                "attemptId": start_ok["attemptId"],
                                "clientPublicKey": ephemeral.public_key,
                                "clientProof": client_proof,
                            }]),
                            unauthenticated_json_headers(),
                        )
                        .await;
                    assert_eq!(finish_login.status, StatusCode::OK);
                    assert_eq!(
                        finish_login.body["result"]["Ok"]["user"]["email"],
                        json!(normalized_email)
                    );
                    let login_token = finish_login.body["result"]["Ok"]["token"]
                        .as_str()
                        .expect("login token should exist")
                        .to_string();

                    let refreshed = app
                        .rpc_call(
                            "auth.refreshSession",
                            json!([]),
                            authenticated_json_headers(&login_token),
                        )
                        .await;
                    assert_eq!(refreshed.status, StatusCode::OK);
                    let refreshed_token = refreshed.body["result"]["Ok"]["token"]
                        .as_str()
                        .expect("refresh token should exist")
                        .to_string();
                    assert_ne!(refreshed_token, login_token);

                    let logout = app
                        .rpc_call(
                            "auth.logout",
                            json!([]),
                            authenticated_json_headers(&refreshed_token),
                        )
                        .await;
                    assert_eq!(logout.status, StatusCode::OK);
                    assert_eq!(logout.body["result"]["Ok"]["success"], json!(true));

                    let me_after_logout = app
                        .rpc_call(
                            "auth.me",
                            json!([]),
                            authenticated_json_headers(&refreshed_token),
                        )
                        .await;
                    assert_eq!(me_after_logout.status, StatusCode::OK);
                    assert_rpc_error(
                        &me_after_logout.body,
                        "UNAUTHORIZED",
                        "Authentication required",
                    );
                },
            )
            .await;
        })
        .await;
    }

    #[tokio::test]
    async fn auth_protected_handlers_require_authentication() {
        with_rpc_test_app("auth_protected_handlers_require_authentication", |app| async move {
			let protected_calls = vec![
				("auth.me", json!([])),
				("auth.updateEmail", json!([{ "newEmail": "new@example.com", "srpSalt": "aa", "srpVerifier": "bb", "encryptedPrivateKey": "cipher", "encryptedVaultKeys": [] }])),
				("auth.changePassword", json!([{ "srpSalt": "aa", "srpVerifier": "bb", "encryptedPrivateKey": "cipher", "encryptedVaultKeys": [] }])),
				("auth.regenerateSecretKey", json!([{ "secretKeyHint": "SK1-TEST", "srpSalt": "aa", "srpVerifier": "bb", "encryptedPrivateKey": "cipher", "encryptedVaultKeys": [] }])),
				("auth.storeRecoveryKey", json!([{ "encryptedMasterKey": "master", "recoveryKeyHint": "hint" }])),
				("auth.deleteAccount", json!([{ "confirmEmail": "user@example.com" }])),
				("auth.listDevices", json!([])),
				("auth.revokeDevice", json!([{ "sessionId": "session_target_01" }])),
				("auth.renameDevice", json!([{ "sessionId": "session_target_01", "deviceName": "Laptop" }])),
				("auth.heartbeat", json!([])),
				("auth.logout", json!([])),
				("auth.logoutAll", json!([])),
				("auth.refreshSession", json!([])),
			];

			for (method, params) in protected_calls {
				let response = app
					.rpc_call(method, params, unauthenticated_json_headers())
					.await;
				assert_eq!(response.status, StatusCode::OK, "unexpected status for {method}");
				assert_rpc_error(
					&response.body,
					"UNAUTHORIZED",
					"Authentication required",
				);
			}
		})
		.await;
    }

    #[tokio::test]
    async fn auth_self_hosted_registration_requires_bootstrap_invite() {
        with_auth_test_env_async(Some("self-hosted"), async {
            with_rpc_test_app(
                "auth_self_hosted_registration_requires_bootstrap_invite",
                |app| async move {
                    seed_user(
                        &app.pool,
                        "bootstrap_user_seed",
                        "Bootstrap User",
                        "bootstrap@example.com",
                    )
                    .await;

                    let registration = app
                        .rpc_call(
                            "auth.registrationStatus",
                            json!([]),
                            unauthenticated_json_headers(),
                        )
                        .await;
                    assert_eq!(registration.status, StatusCode::OK);
                    assert_eq!(
                        registration.body["result"]["Ok"]["mode"],
                        json!("self-hosted")
                    );
                    assert_eq!(
                        registration.body["result"]["Ok"]["allowPublicSignup"],
                        json!(false)
                    );
                    assert_eq!(
                        registration.body["result"]["Ok"]["reason"],
                        json!("invite_only_after_bootstrap")
                    );

                    let verification = app
                        .rpc_call(
                            "auth.requestSignupVerification",
                            json!([{ "email": "new-user@example.com", "invitationToken": null }]),
                            unauthenticated_json_headers(),
                        )
                        .await;
                    assert_eq!(verification.status, StatusCode::OK);
                    assert_handler_error(
                        &verification.body,
                        "FORBIDDEN",
                        "Public registration is disabled. Ask an admin for an invite link.",
                    );
                },
            )
            .await;
        })
        .await;
    }

    #[tokio::test]
    async fn auth_invited_signup_handles_missing_and_valid_invitations() {
        with_auth_test_env_async(Some("cloud"), async {
            with_rpc_test_app(
                "auth_invited_signup_handles_missing_and_valid_invitations",
                |app| async move {
                    let fixture = build_auth_invitation_fixture(&app.pool, "signup").await;
                    let missing_crypto =
                        build_auth_crypto_fixture("invitation-missing", "invite-missing-pass");

                    let missing = app
                        .rpc_call(
                            "auth.signupWithInvitation",
                            json!([{
                                "token": build_valid_token("missing_invite"),
                                "email": fixture.invited_email,
                                "signupVerificationToken": "invalid-token",
                                "name": "Invited User",
                                "secretKeyHint": missing_crypto.secret_key_hint,
                                "srpSalt": missing_crypto.srp_salt,
                                "srpVerifier": missing_crypto.srp_verifier,
                                "publicKey": missing_crypto.public_key,
                                "encryptedPrivateKey": missing_crypto.encrypted_private_key,
                                "encryptedMasterKey": missing_crypto.encrypted_master_key,
                                "recoveryKeyHint": missing_crypto.recovery_key_hint,
                                "encryptedVaultKey": missing_crypto.encrypted_vault_key,
                            }]),
                            unauthenticated_json_headers(),
                        )
                        .await;
                    assert_eq!(missing.status, StatusCode::OK);
                    assert_handler_error(
                        &missing.body,
                        "NOT_FOUND",
                        "Invitation not found or already used",
                    );

                    let signup_verification_token = issue_signup_verification_token(
                        &app,
                        &fixture.invited_email,
                        Some(&fixture.invitation_token),
                    )
                    .await;
                    let crypto =
                        build_auth_crypto_fixture("invitation-success", "invite-success-pass");

                    let signup = app
                        .rpc_call(
                            "auth.signupWithInvitation",
                            json!([{
                                "token": fixture.invitation_token,
                                "email": fixture.invited_email,
                                "signupVerificationToken": signup_verification_token,
                                "name": "Invited User",
                                "secretKeyHint": crypto.secret_key_hint,
                                "srpSalt": crypto.srp_salt,
                                "srpVerifier": crypto.srp_verifier,
                                "publicKey": crypto.public_key,
                                "encryptedPrivateKey": crypto.encrypted_private_key,
                                "encryptedMasterKey": crypto.encrypted_master_key,
                                "recoveryKeyHint": crypto.recovery_key_hint,
                                "encryptedVaultKey": crypto.encrypted_vault_key,
                            }]),
                            unauthenticated_json_headers(),
                        )
                        .await;
                    assert_eq!(signup.status, StatusCode::OK);
                    assert_eq!(signup.body["result"]["Ok"]["success"], json!(true));
                    assert_eq!(
                        signup.body["result"]["Ok"]["user"]["teamId"],
                        json!(fixture.team_id)
                    );
                    assert_eq!(signup.body["result"]["Ok"]["user"]["role"], json!("member"));
                    assert!(signup.body["result"]["Ok"]["vaultKeys"]
                        .as_array()
                        .expect("vault keys should be an array")
                        .iter()
                        .any(|entry| entry["vaultId"] == json!(fixture.team_vault_id)));
                },
            )
            .await;
        })
        .await;
    }

    #[tokio::test]
    async fn auth_recovery_flow_verifies_codes_returns_data_and_resets_password() {
        with_auth_test_env_async(Some("cloud"), async {
            with_rpc_test_app(
                "auth_recovery_flow_verifies_codes_returns_data_and_resets_password",
                |app| async move {
                    let fixture = build_seeded_auth_account_fixture(&app.pool, "recovery").await;
                    let existing_session = app.issue_session(&fixture.user_id).await;

                    let request_recovery = app
                        .rpc_call(
                            "auth.requestRecoveryVerification",
                            json!([{ "email": fixture.email }]),
                            unauthenticated_json_headers(),
                        )
                        .await;
                    assert_eq!(request_recovery.status, StatusCode::OK);
                    assert_eq!(
                        request_recovery.body["result"]["Ok"]["success"],
                        json!(true)
                    );

                    let code = latest_recovery_code(&app.pool, &fixture.email).await;

                    let wrong_code = app
                        .rpc_call(
                            "auth.verifyRecoveryCode",
                            json!([{ "email": fixture.email, "code": "000000" }]),
                            unauthenticated_json_headers(),
                        )
                        .await;
                    assert_eq!(wrong_code.status, StatusCode::OK);
                    assert_eq!(wrong_code.body["result"]["Ok"]["success"], json!(false));

                    let verified = app
                        .rpc_call(
                            "auth.verifyRecoveryCode",
                            json!([{ "email": fixture.email, "code": code }]),
                            unauthenticated_json_headers(),
                        )
                        .await;
                    assert_eq!(verified.status, StatusCode::OK);
                    assert_eq!(verified.body["result"]["Ok"]["success"], json!(true));
                    let recovery_token = verified.body["result"]["Ok"]["recoveryToken"]
                        .as_str()
                        .expect("recovery token should exist")
                        .to_string();

                    let invalid_recovery = app
                        .rpc_call(
                            "auth.getRecoveryData",
                            json!([{ "recoveryToken": "invalid-token" }]),
                            unauthenticated_json_headers(),
                        )
                        .await;
                    assert_eq!(invalid_recovery.status, StatusCode::OK);
                    assert_handler_error(
                        &invalid_recovery.body,
                        "UNAUTHORIZED",
                        "Invalid recovery session",
                    );

                    let recovery_data = app
                        .rpc_call(
                            "auth.getRecoveryData",
                            json!([{ "recoveryToken": recovery_token }]),
                            unauthenticated_json_headers(),
                        )
                        .await;
                    assert_eq!(recovery_data.status, StatusCode::OK);
                    assert_eq!(
                        recovery_data.body["result"]["Ok"]["userId"],
                        json!(fixture.user_id)
                    );
                    assert!(recovery_data.body["result"]["Ok"]["vaultKeys"]
                        .as_array()
                        .expect("vault keys should be an array")
                        .iter()
                        .any(|entry| entry["vaultId"] == json!(fixture.vault_id)));

                    let next_crypto =
                        build_auth_crypto_fixture("recovery-reset", "reset-password-123");
                    let reset = app
                        .rpc_call(
                            "auth.resetPassword",
                            json!([{
                                "recoveryToken": verified.body["result"]["Ok"]["recoveryToken"],
                                "srpSalt": next_crypto.srp_salt,
                                "srpVerifier": next_crypto.srp_verifier,
                                "encryptedPrivateKey": next_crypto.encrypted_private_key,
                                "encryptedMasterKey": next_crypto.encrypted_master_key,
                                "recoveryKeyHint": next_crypto.recovery_key_hint,
                                "secretKeyHint": next_crypto.secret_key_hint,
                                "encryptedVaultKeys": [{
                                    "vaultId": fixture.vault_id,
                                    "encryptedVaultKey": "rotated-recovery-vault-key"
                                }],
                            }]),
                            unauthenticated_json_headers(),
                        )
                        .await;
                    assert_eq!(reset.status, StatusCode::OK);
                    assert_eq!(reset.body["result"]["Ok"]["userId"], json!(fixture.user_id));

                    let session_count = query_scalar::<_, i64>(
                        "SELECT COUNT(*)::bigint FROM session WHERE user_id = $1",
                    )
                    .bind(&fixture.user_id)
                    .fetch_one(&app.pool)
                    .await
                    .expect("session count should load");
                    assert_eq!(session_count, 1);
                    assert!(app
                        .state
                        .sessions
                        .verify_token(&existing_session.token)
                        .await
                        .is_none());
                },
            )
            .await;
        })
        .await;
    }

    #[tokio::test]
    async fn auth_account_mutations_update_credentials_and_revoke_sessions() {
        with_rpc_test_app(
            "auth_account_mutations_update_credentials_and_revoke_sessions",
            |app| async move {
                let fixture = build_seeded_auth_account_fixture(&app.pool, "mutations").await;
                seed_user(
                    &app.pool,
                    "auth_conflict_user",
                    "Conflict User",
                    "conflict@example.com",
                )
                .await;

                let update_session = app.issue_session(&fixture.user_id).await;
                let update_crypto = build_auth_crypto_fixture("update-email", "update-email-pass");

                let conflict = app
                    .rpc_call(
                        "auth.updateEmail",
                        json!([{
                            "newEmail": "conflict@example.com",
                            "srpSalt": update_crypto.srp_salt,
                            "srpVerifier": update_crypto.srp_verifier,
                            "encryptedPrivateKey": update_crypto.encrypted_private_key,
                            "encryptedVaultKeys": [{
                                "vaultId": fixture.vault_id,
                                "encryptedVaultKey": "updated-vault-key"
                            }],
                        }]),
                        authenticated_json_headers(&update_session.token),
                    )
                    .await;
                assert_eq!(conflict.status, StatusCode::OK);
                assert_handler_error(&conflict.body, "BAD_REQUEST", "Email already in use");

                let update_email = app
                    .rpc_call(
                        "auth.updateEmail",
                        json!([{
                            "newEmail": "updated-auth@example.com",
                            "srpSalt": update_crypto.srp_salt,
                            "srpVerifier": update_crypto.srp_verifier,
                            "encryptedPrivateKey": update_crypto.encrypted_private_key,
                            "encryptedVaultKeys": [{
                                "vaultId": fixture.vault_id,
                                "encryptedVaultKey": "updated-vault-key"
                            }],
                        }]),
                        authenticated_json_headers(&update_session.token),
                    )
                    .await;
                assert_eq!(update_email.status, StatusCode::OK);
                assert_eq!(update_email.body["result"]["Ok"]["success"], json!(true));
                assert!(app
                    .state
                    .sessions
                    .verify_token(&update_session.token)
                    .await
                    .is_none());

                let updated_email =
                    query_scalar::<_, String>("SELECT email FROM \"user\" WHERE id = $1")
                        .bind(&fixture.user_id)
                        .fetch_one(&app.pool)
                        .await
                        .expect("updated email should load");
                assert_eq!(updated_email, "updated-auth@example.com");

                let change_session = app.issue_session(&fixture.user_id).await;
                let change_crypto =
                    build_auth_crypto_fixture("change-password", "change-password-pass");
                let change_password = app
                    .rpc_call(
                        "auth.changePassword",
                        json!([{
                            "srpSalt": change_crypto.srp_salt,
                            "srpVerifier": change_crypto.srp_verifier,
                            "encryptedPrivateKey": change_crypto.encrypted_private_key,
                            "encryptedVaultKeys": [{
                                "vaultId": fixture.vault_id,
                                "encryptedVaultKey": "password-rotated-vault-key"
                            }],
                        }]),
                        authenticated_json_headers(&change_session.token),
                    )
                    .await;
                assert_eq!(change_password.status, StatusCode::OK);
                assert_eq!(change_password.body["result"]["Ok"]["success"], json!(true));
                assert!(app
                    .state
                    .sessions
                    .verify_token(&change_session.token)
                    .await
                    .is_none());

                let current_session = app.issue_session(&fixture.user_id).await;
                let other_session = app.issue_session(&fixture.user_id).await;
                let regenerate_crypto =
                    build_auth_crypto_fixture("regen-secret-key", "regen-secret-pass");
                let regenerate = app
                    .rpc_call(
                        "auth.regenerateSecretKey",
                        json!([{
                            "secretKeyHint": regenerate_crypto.secret_key_hint,
                            "srpSalt": regenerate_crypto.srp_salt,
                            "srpVerifier": regenerate_crypto.srp_verifier,
                            "encryptedPrivateKey": regenerate_crypto.encrypted_private_key,
                            "encryptedVaultKeys": [{
                                "vaultId": fixture.vault_id,
                                "encryptedVaultKey": "secret-key-rotated-vault-key"
                            }],
                        }]),
                        authenticated_json_headers(&current_session.token),
                    )
                    .await;
                assert_eq!(regenerate.status, StatusCode::OK);
                assert_eq!(regenerate.body["result"]["Ok"]["success"], json!(true));
                assert!(app
                    .state
                    .sessions
                    .verify_token(&current_session.token)
                    .await
                    .is_some());
                assert!(app
                    .state
                    .sessions
                    .verify_token(&other_session.token)
                    .await
                    .is_none());

                let recovery_session = app.issue_session(&fixture.user_id).await;
                let store_recovery = app
                    .rpc_call(
                        "auth.storeRecoveryKey",
                        json!([{
                            "encryptedMasterKey": "stored-master-key",
                            "recoveryKeyHint": "stored-hint"
                        }]),
                        authenticated_json_headers(&recovery_session.token),
                    )
                    .await;
                assert_eq!(store_recovery.status, StatusCode::OK);
                assert_eq!(store_recovery.body["result"]["Ok"]["success"], json!(true));

                let stored_hint = query_scalar::<_, Option<String>>(
                    "SELECT recovery_key_hint FROM \"user\" WHERE id = $1",
                )
                .bind(&fixture.user_id)
                .fetch_one(&app.pool)
                .await
                .expect("recovery hint should load");
                assert_eq!(stored_hint.as_deref(), Some("stored-hint"));
            },
        )
        .await;
    }

    #[tokio::test]
    async fn auth_session_management_and_account_deletion_flow() {
        with_rpc_test_app(
            "auth_session_management_and_account_deletion_flow",
            |app| async move {
                let fixture = build_seeded_auth_account_fixture(&app.pool, "sessions").await;
                let current_session = app.issue_session(&fixture.user_id).await;
                let other_session = app.issue_session(&fixture.user_id).await;

                let devices = app
                    .rpc_call(
                        "auth.listDevices",
                        json!([]),
                        authenticated_json_headers(&current_session.token),
                    )
                    .await;
                assert_eq!(devices.status, StatusCode::OK);
                assert_eq!(
                    devices.body["result"]["Ok"]
                        .as_array()
                        .expect("devices should be an array")
                        .len(),
                    2,
                );

                let invalid_rename = app
                    .rpc_call(
                        "auth.renameDevice",
                        json!([{ "sessionId": other_session.session_id, "deviceName": "   " }]),
                        authenticated_json_headers(&current_session.token),
                    )
                    .await;
                assert_eq!(invalid_rename.status, StatusCode::OK);
                assert_handler_error(
                    &invalid_rename.body,
                    "BAD_REQUEST",
                    "Device name must be between 1 and 100 characters",
                );

                let rename = app
				.rpc_call(
					"auth.renameDevice",
					json!([{ "sessionId": other_session.session_id, "deviceName": "Work Laptop" }]),
					authenticated_json_headers(&current_session.token),
				)
				.await;
                assert_eq!(rename.status, StatusCode::OK);
                assert_eq!(rename.body["result"]["Ok"]["success"], json!(true));

                let before_heartbeat = query_scalar::<_, OffsetDateTime>(
                    "SELECT last_active_at FROM session WHERE id = $1",
                )
                .bind(&current_session.session_id)
                .fetch_one(&app.pool)
                .await
                .expect("current session last_active_at should load");

                let heartbeat = app
                    .rpc_call(
                        "auth.heartbeat",
                        json!([]),
                        authenticated_json_headers(&current_session.token),
                    )
                    .await;
                assert_eq!(heartbeat.status, StatusCode::OK);
                assert_eq!(heartbeat.body["result"]["Ok"]["success"], json!(true));

                let after_heartbeat = query_scalar::<_, OffsetDateTime>(
                    "SELECT last_active_at FROM session WHERE id = $1",
                )
                .bind(&current_session.session_id)
                .fetch_one(&app.pool)
                .await
                .expect("updated last_active_at should load");
                assert!(after_heartbeat >= before_heartbeat);

                let current_revoke = app
                    .rpc_call(
                        "auth.revokeDevice",
                        json!([{ "sessionId": current_session.session_id }]),
                        authenticated_json_headers(&current_session.token),
                    )
                    .await;
                assert_eq!(current_revoke.status, StatusCode::OK);
                assert_handler_error(
                    &current_revoke.body,
                    "BAD_REQUEST",
                    "Cannot revoke current session. Use logout instead.",
                );

                let revoke = app
                    .rpc_call(
                        "auth.revokeDevice",
                        json!([{ "sessionId": other_session.session_id }]),
                        authenticated_json_headers(&current_session.token),
                    )
                    .await;
                assert_eq!(revoke.status, StatusCode::OK);
                assert_eq!(revoke.body["result"]["Ok"]["success"], json!(true));
                assert!(app
                    .state
                    .sessions
                    .verify_token(&other_session.token)
                    .await
                    .is_none());

                let extra_session = app.issue_session(&fixture.user_id).await;
                let logout_all = app
                    .rpc_call(
                        "auth.logoutAll",
                        json!([]),
                        authenticated_json_headers(&current_session.token),
                    )
                    .await;
                assert_eq!(logout_all.status, StatusCode::OK);
                assert_eq!(logout_all.body["result"]["Ok"]["success"], json!(true));
                assert!(app
                    .state
                    .sessions
                    .verify_token(&current_session.token)
                    .await
                    .is_none());
                assert!(app
                    .state
                    .sessions
                    .verify_token(&extra_session.token)
                    .await
                    .is_none());

                let delete_session = app.issue_session(&fixture.user_id).await;
                let wrong_confirm = app
                    .rpc_call(
                        "auth.deleteAccount",
                        json!([{ "confirmEmail": "wrong@example.com" }]),
                        authenticated_json_headers(&delete_session.token),
                    )
                    .await;
                assert_eq!(wrong_confirm.status, StatusCode::OK);
                assert_handler_error(&wrong_confirm.body, "BAD_REQUEST", "Email does not match");

                let delete_account = app
                    .rpc_call(
                        "auth.deleteAccount",
                        json!([{ "confirmEmail": fixture.email }]),
                        authenticated_json_headers(&delete_session.token),
                    )
                    .await;
                assert_eq!(delete_account.status, StatusCode::OK);
                assert_eq!(delete_account.body["result"]["Ok"]["success"], json!(true));

                let remaining_users =
                    query_scalar::<_, i64>("SELECT COUNT(*)::bigint FROM \"user\" WHERE id = $1")
                        .bind(&fixture.user_id)
                        .fetch_one(&app.pool)
                        .await
                        .expect("remaining user count should load");
                assert_eq!(remaining_users, 0);
            },
        )
        .await;
    }

    fn header_helpers_trim_values_and_extract_bearer_tokens() {
        let request = Request::builder()
            .header(AUTHORIZATION, "  bearer session-token  ")
            .header("x-client-id", "  browser-1  ")
            .body(Body::empty())
            .expect("request should build");

        assert_eq!(
            header_value(&request, "x-client-id").as_deref(),
            Some("browser-1")
        );
        assert_eq!(
            parse_bearer_token(&request).as_deref(),
            Some("session-token"),
        );

        let non_bearer = Request::builder()
            .header(AUTHORIZATION, "Basic abc123")
            .body(Body::empty())
            .expect("request should build");
        assert_eq!(parse_bearer_token(&non_bearer), None);

        let invalid_header = Request::builder()
            .header(
                "x-client-id",
                HeaderValue::from_bytes(&[0xff]).expect("header value should build"),
            )
            .body(Body::empty())
            .expect("request should build");
        assert_eq!(header_value(&invalid_header, "x-client-id"), None);
    }

    #[test]
    fn signup_helpers_normalize_plans_member_limits_and_names() {
        assert_eq!(
            normalize_signup_plan(None).expect("default plan should be valid"),
            "personal"
        );
        assert_eq!(
            normalize_signup_plan(Some(" Team ")).expect("team plan should be valid"),
            "team",
        );
        assert_eq!(
            normalize_signup_plan(Some("enterprise"))
                .expect_err("unknown plan should fail")
                .message,
            "Invalid plan",
        );

        assert_eq!(super::map_plan_to_team_type("family"), "family");
        assert_eq!(super::map_plan_to_team_type("team"), "organization");
        assert_eq!(super::map_plan_to_team_type("personal"), "personal");

        assert_eq!(plan_member_limit("personal"), Some(1));
        assert_eq!(plan_member_limit("family"), Some(6));
        assert_eq!(plan_member_limit("team"), None);

        assert_eq!(
            signup_team_name(true, "organization", None),
            "Bittery Instance"
        );
        assert_eq!(
            signup_team_name(true, "organization", Some("  Example Org  ")),
            "Example Org",
        );
        assert_eq!(signup_team_name(false, "family", None), "My Family");
        assert_eq!(signup_team_name(false, "personal", None), "My Team");
    }

    #[test]
    fn validation_helpers_reject_invalid_ids_hex_attempt_ids_and_tokens() {
        validate_resource_id("resource_123").expect("resource id should be valid");
        assert_eq!(
            validate_resource_id("short")
                .expect_err("short ids should fail")
                .message,
            "Invalid resource ID",
        );

        validate_hex_string("a0ff", "Invalid hex").expect("hex should be valid");
        assert_eq!(
            validate_hex_string("abc", "Invalid hex")
                .expect_err("odd-length hex should fail")
                .message,
            "Invalid hex",
        );

        let valid_attempt_id = format!("{}:attempt_token", "a".repeat(64));
        validate_login_attempt_id(&valid_attempt_id).expect("attempt id should be valid");
        assert_eq!(
            validate_login_attempt_id("not-an-attempt-id")
                .expect_err("invalid attempt ids should fail")
                .message,
            "Invalid login attempt ID",
        );

        validate_token("abcdEFGHijklMNOPqrstUVWXyz012345").expect("token should be valid");
        assert_eq!(
            validate_token("short-token")
                .expect_err("short tokens should fail")
                .message,
            "Invalid token",
        );
    }

    #[test]
    fn pending_vault_key_parser_accepts_valid_payloads() {
        assert!(parse_pending_vault_keys(None)
            .expect("missing payload should succeed")
            .is_empty());
        assert!(parse_pending_vault_keys(Some("  "))
            .expect("blank payload should succeed")
            .is_empty());

        let parsed = parse_pending_vault_keys(Some(
			r#"[{"vaultId":"vault-1","encryptedVaultKey":"key-1"},{"vaultId":"vault-2","encryptedVaultKey":"key-2"}]"#,
		))
		.expect("valid payload should parse");

        assert_eq!(parsed.len(), 2);
        assert_eq!(parsed[0].vault_id, "vault-1");
        assert_eq!(parsed[1].encrypted_vault_key, "key-2");
    }

    #[test]
    fn pending_vault_key_parser_rejects_invalid_entries_and_duplicates() {
        assert_eq!(
            parse_pending_vault_keys(Some(r#"[{"vaultId":"vault-1","encryptedVaultKey":"   "}]"#))
                .expect_err("blank encrypted keys should fail")
                .message,
            "Invalid pendingVaultKeys entry at index 0",
        );

        assert_eq!(
			parse_pending_vault_keys(Some(
				r#"[{"vaultId":"vault-1","encryptedVaultKey":"key-1"},{"vaultId":" vault-1 ","encryptedVaultKey":"key-2"}]"#,
			))
				.expect_err("duplicate vault ids should fail")
				.message,
			"Duplicate vault IDs are not allowed in pendingVaultKeys",
		);
    }

    #[test]
    fn fake_hint_is_case_insensitive() {
        let lower = deterministic_fake_hint("case-test@example.com");
        let upper = deterministic_fake_hint("CASE-TEST@EXAMPLE.COM");

        assert_eq!(lower, upper);
        assert!(lower.starts_with("A3-"));
        assert_eq!(lower.len(), 11);
    }

    fn build_auth_crypto_fixture(label: &str, auth_password: &str) -> AuthCryptoFixture {
        let client = SrpClient::new(super::HashAlgorithm::Sha256, super::PrimeGroup::G4096);
        let srp_salt = client.generate_salt();
        let private_key = client
            .derive_safe_private_key(&srp_salt, auth_password, Some(TEST_SRP_ITERATIONS))
            .expect("private key should derive");
        let srp_verifier = client
            .derive_verifier(&private_key)
            .expect("verifier should derive");

        AuthCryptoFixture {
            auth_password: auth_password.to_string(),
            srp_salt,
            srp_verifier,
            secret_key_hint: format!("SKH-{label}"),
            public_key: format!("public-key-{label}"),
            encrypted_private_key: format!("encrypted-private-key-{label}"),
            encrypted_master_key: format!("encrypted-master-key-{label}"),
            recovery_key_hint: format!("recovery-key-hint-{label}"),
            encrypted_vault_key: format!("encrypted-vault-key-{label}"),
        }
    }

    fn build_login_ephemeral_fixture() -> LoginEphemeralFixture {
        let client = SrpClient::new(super::HashAlgorithm::Sha256, super::PrimeGroup::G4096);
        let ephemeral = client.generate_ephemeral();
        LoginEphemeralFixture {
            public_key: ephemeral.public.clone(),
            secret: ephemeral.secret.clone(),
        }
    }

    fn derive_login_proof(
        ephemeral: &LoginEphemeralFixture,
        salt: &str,
        server_public_key: &str,
        auth_password: &str,
        iterations: u32,
    ) -> String {
        let client = SrpClient::new(super::HashAlgorithm::Sha256, super::PrimeGroup::G4096);
        let private_key = client
            .derive_safe_private_key(salt, auth_password, Some(iterations))
            .expect("private key should derive");
        let session = client
            .derive_session(&ephemeral.secret, server_public_key, salt, "", &private_key)
            .expect("login proof should derive");
        session.proof.clone()
    }

    async fn with_auth_test_env_async<T, F>(mode: Option<&str>, future: F) -> T
    where
        F: Future<Output = T>,
    {
        let _guard = crate::test_support::acquire_env_lock();
        let previous_mode = std::env::var("BITTERY_MODE").ok();
        let previous_stubs = std::env::var("BITTERY_ENABLE_DEV_AUTH_STUBS").ok();
        let previous_node_env = std::env::var("NODE_ENV").ok();

        match mode {
            Some(value) => unsafe { std::env::set_var("BITTERY_MODE", value) },
            None => unsafe { std::env::remove_var("BITTERY_MODE") },
        }
        unsafe { std::env::set_var("BITTERY_ENABLE_DEV_AUTH_STUBS", "true") };
        unsafe { std::env::remove_var("NODE_ENV") };

        let result = future.await;

        match previous_mode.as_deref() {
            Some(value) => unsafe { std::env::set_var("BITTERY_MODE", value) },
            None => unsafe { std::env::remove_var("BITTERY_MODE") },
        }
        match previous_stubs.as_deref() {
            Some(value) => unsafe { std::env::set_var("BITTERY_ENABLE_DEV_AUTH_STUBS", value) },
            None => unsafe { std::env::remove_var("BITTERY_ENABLE_DEV_AUTH_STUBS") },
        }
        match previous_node_env.as_deref() {
            Some(value) => unsafe { std::env::set_var("NODE_ENV", value) },
            None => unsafe { std::env::remove_var("NODE_ENV") },
        }

        result
    }

    fn unauthenticated_json_headers() -> HeaderMap {
        let mut headers = HeaderMap::new();
        headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
        headers.insert("x-app-platform", HeaderValue::from_static("desktop"));
        headers.insert("x-client-id", HeaderValue::from_static("integration-test"));
        headers
    }

    fn assert_handler_error(body: &serde_json::Value, code: &str, message: &str) {
        assert_eq!(body["jsonrpc"], json!("2.0"));
        assert_eq!(body["result"]["Err"]["code"], json!(code));
        assert_eq!(body["result"]["Err"]["message"], json!(message));
    }

    fn assert_rpc_error(body: &serde_json::Value, code: &str, message: &str) {
        assert_eq!(body["jsonrpc"], json!("2.0"));
        assert_eq!(body["error"]["message"], json!(message));
        assert_eq!(body["error"]["data"]["code"], json!(code));
    }

    fn build_valid_token(label: &str) -> String {
        let mut token = label
            .chars()
            .map(|character| {
                if character.is_ascii_alphanumeric() {
                    character.to_ascii_lowercase()
                } else {
                    '_'
                }
            })
            .collect::<String>();
        while token.len() < 32 {
            token.push('x');
        }
        token.truncate(32);
        token
    }

    async fn latest_signup_verification_code(
        pool: &PgPool,
        email: &str,
        invitation_token: Option<&str>,
    ) -> String {
        match invitation_token {
			Some(invitation_token) => query_scalar::<_, String>(
				"SELECT code FROM signup_verification WHERE email = $1 AND invitation_token = $2 ORDER BY created_at DESC LIMIT 1",
			)
			.bind(normalize_email(email))
			.bind(invitation_token)
			.fetch_one(pool)
			.await
			.expect("signup verification code should load"),
			None => query_scalar::<_, String>(
				"SELECT code FROM signup_verification WHERE email = $1 AND invitation_token IS NULL ORDER BY created_at DESC LIMIT 1",
			)
			.bind(normalize_email(email))
			.fetch_one(pool)
			.await
			.expect("signup verification code should load"),
		}
    }

    async fn latest_recovery_code(pool: &PgPool, email: &str) -> String {
        query_scalar::<_, String>(
			"SELECT code FROM recovery_verification WHERE email = $1 ORDER BY created_at DESC LIMIT 1",
		)
		.bind(normalize_email(email))
		.fetch_one(pool)
		.await
		.expect("recovery code should load")
    }

    async fn issue_signup_verification_token(
        app: &RpcTestApp,
        email: &str,
        invitation_token: Option<&str>,
    ) -> String {
        let request = app
            .rpc_call(
                "auth.requestSignupVerification",
                json!([{ "email": email, "invitationToken": invitation_token }]),
                unauthenticated_json_headers(),
            )
            .await;
        assert_eq!(request.status, StatusCode::OK);
        assert_eq!(request.body["result"]["Ok"]["success"], json!(true));

        let code = latest_signup_verification_code(&app.pool, email, invitation_token).await;
        let verified = app
            .rpc_call(
                "auth.verifySignupVerification",
                json!([{ "email": email, "code": code, "invitationToken": invitation_token }]),
                unauthenticated_json_headers(),
            )
            .await;
        assert_eq!(verified.status, StatusCode::OK);
        assert_eq!(verified.body["result"]["Ok"]["success"], json!(true));
        verified.body["result"]["Ok"]["signupVerificationToken"]
            .as_str()
            .expect("signup verification token should exist")
            .to_string()
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
    ) {
        query(
			"INSERT INTO team_invitation (id, team_id, email, role, invited_by_id, token, pending_vault_keys, expires_at) VALUES ($1, $2, $3, $4::team_role, $5, $6, $7, $8)",
		)
		.bind(invitation_id)
		.bind(team_id)
		.bind(normalize_email(email))
		.bind(role)
		.bind(invited_by_id)
		.bind(token)
		.bind(pending_vault_keys)
		.bind(now_utc() + Duration::days(1))
		.execute(pool)
		.await
		.expect("team invitation should seed");
    }

    async fn build_seeded_auth_account_fixture(pool: &PgPool, label: &str) -> AuthAccountFixture {
        let user_id = format!("auth_user_{label}");
        let email = format!("auth-{label}@example.com");
        let team_id = format!("auth_team_{label}");
        let vault_id = format!("auth_vault_{label}");

        seed_user(pool, &user_id, &format!("Auth {label}"), &email).await;
        seed_team(
            pool,
            &team_id,
            &format!("Auth Team {label}"),
            &user_id,
            "personal",
            "personal",
            "active",
        )
        .await;
        assign_user_to_team(pool, &user_id, &team_id, "owner").await;
        seed_vault(
            pool,
            &vault_id,
            "Personal Vault",
            "personal",
            &user_id,
            None,
        )
        .await;
        seed_vault_key(
            pool,
            &format!("auth_vault_key_{label}"),
            &vault_id,
            &user_id,
            "seed-encrypted-vault-key",
            "owner",
        )
        .await;
        query(
			"UPDATE \"user\" SET secret_key_hint = $1, encrypted_master_key = $2, recovery_key_hint = $3 WHERE id = $4",
		)
		.bind(format!("SEED-HINT-{label}"))
		.bind(format!("seed-master-key-{label}"))
		.bind(format!("seed-recovery-hint-{label}"))
		.bind(&user_id)
		.execute(pool)
		.await
		.expect("seeded account should update");

        AuthAccountFixture {
            user_id,
            email,
            vault_id,
        }
    }

    async fn build_auth_invitation_fixture(pool: &PgPool, label: &str) -> AuthInvitationFixture {
        let inviter_user_id = format!("auth_inviter_{label}");
        let team_id = format!("auth_invite_team_{label}");
        let team_vault_id = format!("auth_invite_vault_{label}");
        let invitation_token = build_valid_token(&format!("invite_{label}"));
        let invited_email = format!("invited-{label}@example.com");
        let pending_vault_keys = json!([{
            "vaultId": team_vault_id,
            "encryptedVaultKey": format!("pending-vault-key-{label}")
        }])
        .to_string();

        seed_user(
            pool,
            &inviter_user_id,
            "Inviter User",
            &format!("inviter-{label}@example.com"),
        )
        .await;
        seed_team(
            pool,
            &team_id,
            "Invited Team",
            &inviter_user_id,
            "organization",
            "team",
            "active",
        )
        .await;
        assign_user_to_team(pool, &inviter_user_id, &team_id, "owner").await;
        seed_vault(
            pool,
            &team_vault_id,
            "Shared Team Vault",
            "team",
            &inviter_user_id,
            Some(&team_id),
        )
        .await;
        seed_vault_key(
            pool,
            &format!("auth_invite_vault_key_{label}"),
            &team_vault_id,
            &inviter_user_id,
            "inviter-vault-key",
            "owner",
        )
        .await;
        seed_team_invitation(
            pool,
            &format!("auth_invitation_{label}"),
            &team_id,
            &invited_email,
            "member",
            &inviter_user_id,
            &invitation_token,
            Some(&pending_vault_keys),
        )
        .await;

        AuthInvitationFixture {
            team_id,
            team_vault_id,
            invitation_token,
            invited_email,
        }
    }
}
