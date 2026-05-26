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
    config::{bittery_mode, db_pool},
    db::models::*,
    error::AppError,
    integrations::storage,
    repo::auth as repo_auth,
    repo::common::{generate_resource_id, insert_audit_event},
    services::billing::sync_team_seats_best_effort,
    services::session::{
        format_rfc3339, generate_opaque_session_token, hash_token, is_grouped_client_session,
        now_utc, DeviceSessionResponse, RefreshSessionResponse, RenameDeviceInput, RequestMetadata,
        SessionIdInput, VerifiedSession,
    },
    services::session_control::record_session_revocations,
    AppState,
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
    .map_err(|e| {
        tracing::error!(error = %e, "Failed to record recovery audit event");
        internal_handler_error("Failed to record recovery audit event")
    })?;

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
    .map_err(|e| { tracing::error!(error = %e, "Failed to record email change audit event"); internal_handler_error("Failed to record email change audit event") })?;

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
    .map_err(|e| {
        tracing::error!(error = %e, "Failed to record password change audit event");
        internal_handler_error("Failed to record password change audit event")
    })?;

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
    .map_err(|e| {
        tracing::error!(error = %e, "Failed to record secret key regeneration audit event");
        internal_handler_error("Failed to record secret key regeneration audit event")
    })?;

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
    .map_err(|e| {
        tracing::error!(error = %e, "Failed to record recovery key audit event");
        internal_handler_error("Failed to record recovery key audit event")
    })?;

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
    .map_err(|e| {
        tracing::error!(error = %e, "Failed to record account deletion audit event");
        internal_handler_error("Failed to record account deletion audit event")
    })?;

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

pub(crate) async fn get_me(
    app_state: &AppState,
    session: &VerifiedSession,
) -> Result<MeResponse, AppError> {
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
            .map_err(|e| {
                tracing::error!(error = %e, "Failed to record device revoke audit event");
                internal_handler_error("Failed to record device revoke audit event")
            })?;
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

pub(crate) async fn do_heartbeat(
    app_state: &AppState,
    session: &VerifiedSession,
) -> Result<LogoutResponse, AppError> {
    app_state.sessions.heartbeat(&session.session_id).await?;
    Ok(LogoutResponse { success: true })
}

pub(crate) async fn do_logout(
    app_state: &AppState,
    session: &VerifiedSession,
) -> Result<LogoutResponse, AppError> {
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

pub(crate) async fn do_logout_all(
    app_state: &AppState,
    session: &VerifiedSession,
) -> Result<LogoutResponse, AppError> {
    let revoked_session_ids = app_state
        .sessions
        .delete_all_user_sessions(&session.user_id)
        .await?;

    if let Some(pool) = app_state.db_pool.as_ref() {
        record_session_revocations(pool, &session.user_id, &revoked_session_ids, "logout_all")
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
        .map_err(|e| {
            tracing::error!(error = %e, "Failed to record logout audit event");
            internal_handler_error("Failed to record logout audit event")
        })?;
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
    let secret = jwt_signing_secret();
    let digest = Sha256::digest(format!("{secret}:{}", normalize_email(email)).as_bytes());
    format!("A3-{}", hex::encode_upper(&digest[..4]))
}

fn generate_signup_verification_code() -> String {
    rand::thread_rng().gen_range(100000..=999999).to_string()
}

fn jwt_signing_secret() -> String {
    match std::env::var("JWT_SECRET") {
        Ok(secret) if !secret.trim().is_empty() => secret,
        _ => {
            if is_production() {
                panic!("JWT_SECRET must be set in production (NODE_ENV=production)");
            }
            "bittery-dev-auth-secret".to_string()
        }
    }
}

fn is_production() -> bool {
    matches!(
        std::env::var("NODE_ENV").ok().as_deref(),
        Some("production")
    )
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
    .map_err(|e| {
        tracing::error!(error = %e, "Failed to create signup verification token");
        internal_handler_error("Failed to create signup verification token")
    })
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
    .map_err(|e| {
        tracing::error!(error = %e, "Failed to create recovery token");
        internal_handler_error("Failed to create recovery token")
    })
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
    repo_auth::get_pending_invitation_for_signup(
        pool,
        invitation_token,
        normalized_email,
        is_self_hosted,
    )
    .await
}

async fn create_signup_verification(
    pool: &PgPool,
    email: &str,
    invitation_token: Option<&str>,
) -> Result<String, AppError> {
    let code = generate_signup_verification_code();
    let id = format!(
        "signup_verify_{}",
        &hash_token(&generate_opaque_session_token())[..16]
    );
    let expires_at = now_utc() + Duration::minutes(SIGNUP_VERIFICATION_TTL_MINUTES);
    repo_auth::create_signup_verification(pool, &id, email, invitation_token, &code, expires_at)
        .await?;
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
    )
    .await
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
    )
    .await
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
    )
    .await
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
    )
    .await
}

async fn store_recovery_key_data(
    pool: &PgPool,
    user_id: &str,
    input: &StoreRecoveryKeyInput,
) -> Result<(), AppError> {
    repo_auth::store_recovery_key_data(
        pool,
        user_id,
        &input.encrypted_master_key,
        &input.recovery_key_hint,
    )
    .await
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
    repo_auth::get_pending_signup_invitation(
        pool,
        invitation_token,
        normalized_email,
        is_self_hosted,
    )
    .await
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
    repo_auth::insert_user_account(
        transaction,
        repo_auth::CreateUserParams {
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
        },
    )
    .await
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
    repo_auth::insert_team(
        transaction,
        team_id,
        team_name,
        owner_id,
        team_type,
        member_limit,
        billing_plan,
        billing_status,
    )
    .await
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
    static RE: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(
		r"^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|[A-Za-z0-9_-]{10,64})$",
	).expect("resource id regex should be valid")
    });
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
    repo_auth::assert_pending_vault_keys_authorized(pool, team_id, inviter_id, pending_vault_keys)
        .await
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
#[path = "auth_tests.rs"]
mod tests;
