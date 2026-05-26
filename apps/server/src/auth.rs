use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, RwLock,
    },
};

use axum::{
    extract::State,
    http::{header::HeaderName, HeaderValue, Request},
    middleware::Next,
    response::Response,
};
use base64::Engine;
use bittery_crypto_core::{
    default_login_kdf_params,
    srp6a::{HashAlgorithm, PrimeGroup, SrpServer},
};
use jsonwebtoken::{decode, encode, Algorithm, DecodingKey, EncodingKey, Header, Validation};
use qubit::{
    builder::IntoResponse,
    handler,
    server::{ErrorCode, Extensions, FromRequestExtensions, Router, RpcError},
};
use rand::{random, Rng, RngCore};
use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::json;
use sha2::{Digest, Sha256};
use sqlx::{query, query_as, query_scalar, PgPool};
use time::{format_description::well_known::Rfc3339, Duration, OffsetDateTime};
use tracing::info;
use ts_rs::TS;

use crate::{
    billing::sync_team_seats_best_effort,
    db::{self, models::*},
    server_support::{bittery_mode, db_pool as load_db_pool},
    session_control::{load_user_session_ids, record_session_revocations},
    storage, AppState,
};

const AUTHORIZATION_HEADER: &str = "authorization";
const CLIENT_ID_HEADER: &str = "x-client-id";
const APP_PLATFORM_HEADER: &str = "x-app-platform";
const SESSION_EXPIRY_HEADER: &str = "x-session-expires";
const UNAUTHORIZED_CODE: &str = "UNAUTHORIZED";
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

#[derive(Clone, Debug, Default)]
pub struct RequestMetadata {
    pub auth_token: Option<String>,
    pub client_id: Option<String>,
    pub app_platform: Option<String>,
    pub user_agent: Option<String>,
    pub ip_address: Option<String>,
}

#[derive(Clone, Debug)]
pub struct VerifiedSession {
    pub token: String,
    pub session_id: String,
    pub user_id: String,
    pub expires_at: OffsetDateTime,
    pub platform: String,
    pub client_id: Option<String>,
}

#[derive(Clone, Debug)]
struct SessionRecord {
    token: String,
    session_id: String,
    user_id: String,
    expires_at: OffsetDateTime,
    created_at: OffsetDateTime,
    last_active_at: OffsetDateTime,
    platform: String,
    client_id: Option<String>,
    device_name: Option<String>,
    ip_address: Option<String>,
    browser_name: Option<String>,
    browser_version: Option<String>,
    os_name: Option<String>,
    os_version: Option<String>,
}

#[derive(Clone)]
pub struct SessionService {
    backend: SessionBackend,
}

#[derive(Clone)]
enum SessionBackend {
    Memory(Arc<SessionServiceInner>),
    Postgres(PostgresSessionStore),
}

struct SessionServiceInner {
    sessions_by_token: RwLock<HashMap<String, SessionRecord>>,
    next_id: AtomicU64,
    seeded_session: SeededSession,
}

#[derive(Clone)]
struct PostgresSessionStore {
    pool: PgPool,
}

#[derive(Clone, Debug)]
pub struct SeededSession {
    pub token: String,
    pub session_id: String,
    pub user_id: String,
    pub expires_at: String,
}

#[derive(Clone)]
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
pub struct RefreshSessionResponse {
    pub token: String,
    pub session_id: String,
    pub expires_at: String,
}

#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct AuthRpcError {
    pub code: String,
    pub message: String,
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

#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct DeviceSessionResponse {
    pub id: String,
    pub device_name: Option<String>,
    pub platform: String,
    pub browser_name: Option<String>,
    pub browser_version: Option<String>,
    pub os_name: Option<String>,
    pub os_version: Option<String>,
    pub ip_address: Option<String>,
    pub last_active_at: String,
    pub created_at: String,
    pub is_current_session: bool,
}

#[derive(Debug, Clone, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct SessionIdInput {
    pub session_id: String,
}

#[derive(Debug, Clone, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct RenameDeviceInput {
    pub session_id: String,
    pub device_name: String,
}

#[derive(Clone, Debug)]
struct SessionSnapshot {
    id: String,
    user_id: String,
    expires_at: OffsetDateTime,
    created_at: OffsetDateTime,
    last_active_at: OffsetDateTime,
    platform: String,
    client_id: Option<String>,
    device_name: Option<String>,
    ip_address: Option<String>,
    browser_name: Option<String>,
    browser_version: Option<String>,
    os_name: Option<String>,
    os_version: Option<String>,
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

#[derive(Debug, Clone)]
struct CreatedSession {
    token: String,
    session_id: String,
    expires_at: OffsetDateTime,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct PendingVaultKeyEntry {
    #[serde(rename = "vaultId")]
    vault_id: String,
    #[serde(rename = "encryptedVaultKey")]
    encrypted_vault_key: String,
}

impl SessionService {
    pub async fn from_database_url(database_url: &str) -> Result<Self, sqlx::Error> {
        let pool = db::connect(database_url).await?;
        Ok(Self::from_pool(pool))
    }

    pub fn from_pool(pool: PgPool) -> Self {
        Self {
            backend: SessionBackend::Postgres(PostgresSessionStore { pool }),
        }
    }

    pub fn with_dev_seed() -> Self {
        let initial_expiry = now_utc() + session_duration_for_platform("desktop");
        let issued_at = now_utc();
        let seeded_record = SessionRecord {
            token: "dev-session-token".to_string(),
            session_id: "dev-session-1".to_string(),
            user_id: "dev-user".to_string(),
            expires_at: initial_expiry,
            created_at: issued_at,
            last_active_at: issued_at,
            platform: "desktop".to_string(),
            client_id: None,
            device_name: Some("Development Device".to_string()),
            ip_address: None,
            browser_name: None,
            browser_version: None,
            os_name: None,
            os_version: None,
        };
        let seeded_session = SeededSession {
            token: seeded_record.token.clone(),
            session_id: seeded_record.session_id.clone(),
            user_id: seeded_record.user_id.clone(),
            expires_at: format_rfc3339(seeded_record.expires_at),
        };

        let mut sessions_by_token = HashMap::new();
        sessions_by_token.insert(seeded_record.token.clone(), seeded_record);

        Self {
            backend: SessionBackend::Memory(Arc::new(SessionServiceInner {
                sessions_by_token: RwLock::new(sessions_by_token),
                next_id: AtomicU64::new(2),
                seeded_session,
            })),
        }
    }

    pub fn seeded_session(&self) -> Option<SeededSession> {
        match &self.backend {
            SessionBackend::Memory(inner) => Some(inner.seeded_session.clone()),
            SessionBackend::Postgres(_) => None,
        }
    }

    pub async fn verify_token(&self, token: &str) -> Option<VerifiedSession> {
        match &self.backend {
            SessionBackend::Memory(inner) => verify_memory_token(inner, token),
            SessionBackend::Postgres(store) => store.verify_token(token).await,
        }
    }

    pub async fn refresh_session(
        &self,
        current_session: &VerifiedSession,
    ) -> Result<RefreshSessionResponse, AuthRpcError> {
        match &self.backend {
            SessionBackend::Memory(inner) => refresh_memory_session(inner, current_session),
            SessionBackend::Postgres(store) => store.refresh_session(current_session).await,
        }
    }

    pub async fn delete_session(&self, session_id: &str) -> Result<Vec<String>, AuthRpcError> {
        match &self.backend {
            SessionBackend::Memory(inner) => Ok(delete_memory_session(inner, session_id)),
            SessionBackend::Postgres(store) => store.delete_session(session_id).await,
        }
    }

    pub async fn delete_all_user_sessions(
        &self,
        user_id: &str,
    ) -> Result<Vec<String>, AuthRpcError> {
        match &self.backend {
            SessionBackend::Memory(inner) => Ok(delete_all_memory_sessions(inner, user_id)),
            SessionBackend::Postgres(store) => store.delete_all_user_sessions(user_id).await,
        }
    }

    pub async fn delete_other_user_sessions(
        &self,
        user_id: &str,
        current_session_id: &str,
    ) -> Result<Vec<String>, AuthRpcError> {
        match &self.backend {
            SessionBackend::Memory(inner) => Ok(delete_other_memory_sessions(
                inner,
                user_id,
                current_session_id,
            )),
            SessionBackend::Postgres(store) => {
                store
                    .delete_other_user_sessions(user_id, current_session_id)
                    .await
            }
        }
    }

    pub async fn list_devices(
        &self,
        user_id: &str,
        current_session_id: &str,
    ) -> Result<Vec<DeviceSessionResponse>, AuthRpcError> {
        match &self.backend {
            SessionBackend::Memory(inner) => {
                Ok(list_memory_devices(inner, user_id, current_session_id))
            }
            SessionBackend::Postgres(store) => {
                store.list_devices(user_id, current_session_id).await
            }
        }
    }

    async fn get_owned_session(
        &self,
        session_id: &str,
        user_id: &str,
    ) -> Result<Option<SessionSnapshot>, AuthRpcError> {
        match &self.backend {
            SessionBackend::Memory(inner) => {
                Ok(get_owned_memory_session(inner, session_id, user_id))
            }
            SessionBackend::Postgres(store) => store.get_owned_session(session_id, user_id).await,
        }
    }

    pub async fn revoke_device(
        &self,
        session_id: &str,
        user_id: &str,
    ) -> Result<Vec<String>, AuthRpcError> {
        match &self.backend {
            SessionBackend::Memory(inner) => Ok(revoke_memory_device(inner, session_id, user_id)),
            SessionBackend::Postgres(store) => store.revoke_device(session_id, user_id).await,
        }
    }

    pub async fn rename_device(
        &self,
        session_id: &str,
        user_id: &str,
        device_name: &str,
    ) -> Result<(), AuthRpcError> {
        match &self.backend {
            SessionBackend::Memory(inner) => {
                rename_memory_device(inner, session_id, user_id, device_name);
                Ok(())
            }
            SessionBackend::Postgres(store) => {
                store.rename_device(session_id, user_id, device_name).await
            }
        }
    }

    pub async fn heartbeat(&self, session_id: &str) -> Result<(), AuthRpcError> {
        match &self.backend {
            SessionBackend::Memory(inner) => {
                touch_memory_session(inner, session_id);
                Ok(())
            }
            SessionBackend::Postgres(store) => store.heartbeat(session_id).await,
        }
    }

    pub async fn create_session(
        &self,
        user_id: &str,
        request: &RequestMetadata,
    ) -> Result<CreatedSession, AuthRpcError> {
        match &self.backend {
            SessionBackend::Memory(inner) => Ok(issue_memory_session(inner, user_id, request)),
            SessionBackend::Postgres(store) => store.create_session(user_id, request).await,
        }
    }

    #[cfg(test)]
    pub(crate) async fn issue_session_for_tests(
        &self,
        user_id: &str,
        platform: &str,
        client_id: Option<&str>,
    ) -> VerifiedSession {
        match &self.backend {
            SessionBackend::Memory(inner) => {
                issue_memory_session_for_tests(inner, user_id, platform, client_id)
            }
            SessionBackend::Postgres(store) => {
                let request = RequestMetadata {
                    auth_token: None,
                    client_id: client_id.map(ToOwned::to_owned),
                    app_platform: Some(platform.to_string()),
                    user_agent: Some("integration-test".to_string()),
                    ip_address: Some("127.0.0.1".to_string()),
                };
                let created = store
                    .create_session(user_id, &request)
                    .await
                    .expect("test session issuance should succeed");
                store
                    .verify_token(&created.token)
                    .await
                    .expect("created test session should verify")
            }
        }
    }
}

impl Default for SessionService {
    fn default() -> Self {
        Self::with_dev_seed()
    }
}

impl PostgresSessionStore {
    async fn create_session(
        &self,
        user_id: &str,
        request: &RequestMetadata,
    ) -> Result<CreatedSession, AuthRpcError> {
        let platform = normalize_session_platform(request.app_platform.as_deref());
        let client_id = normalized_session_client_id(
            request.app_platform.as_deref(),
            request.client_id.clone(),
        );
        let issued_at = now_utc();
        let expires_at = issued_at + session_duration_for_platform(&platform);
        let token = generate_opaque_session_token();
        let session_id = hash_token(&token);

        let mut transaction = self.pool.begin().await.map_err(|e| {
            tracing::error!(error = %e, "Session store is unavailable");
            internal_handler_error("Session store is unavailable")
        })?;

        if client_id.is_some() {
            query("DELETE FROM session WHERE user_id = $1 AND platform = $2 AND client_id = $3")
                .bind(user_id)
                .bind(&platform)
                .bind(client_id.as_deref())
                .execute(transaction.as_mut())
                .await
                .map_err(|e| {
                    tracing::error!(error = %e, "Session store is unavailable");
                    internal_handler_error("Session store is unavailable")
                })?;
        }

        let device_info = request
            .user_agent
            .as_deref()
            .map(|ua| parse_user_agent(ua, request.app_platform.as_deref()));

        query(
            r#"
			INSERT INTO session (
				id,
				expires_at,
				created_at,
				updated_at,
				ip_address,
				user_agent,
				device_name,
				platform,
				client_id,
				device_info,
				browser_name,
				browser_version,
				os_name,
				os_version,
				last_active_at,
				user_id
			) VALUES (
				$1, $2, $3, $3, $4, $5, $6, $7, $8, NULL, $9, $10, $11, $12, $3, $13
			)
			"#,
        )
        .bind(&session_id)
        .bind(expires_at)
        .bind(issued_at)
        .bind(request.ip_address.as_deref())
        .bind(request.user_agent.as_deref())
        .bind(device_info.as_ref().map(|d| d.device_name.as_str()))
        .bind(&platform)
        .bind(client_id.as_deref())
        .bind(device_info.as_ref().and_then(|d| d.browser_name.as_deref()))
        .bind(
            device_info
                .as_ref()
                .and_then(|d| d.browser_version.as_deref()),
        )
        .bind(device_info.as_ref().and_then(|d| d.os_name.as_deref()))
        .bind(device_info.as_ref().and_then(|d| d.os_version.as_deref()))
        .bind(user_id)
        .execute(transaction.as_mut())
        .await
        .map_err(|e| {
            tracing::error!(error = %e, "Session store is unavailable");
            internal_handler_error("Session store is unavailable")
        })?;

        transaction.commit().await.map_err(|e| {
            tracing::error!(error = %e, "Session store is unavailable");
            internal_handler_error("Session store is unavailable")
        })?;

        Ok(CreatedSession {
            token,
            session_id,
            expires_at,
        })
    }

    async fn verify_token(&self, token: &str) -> Option<VerifiedSession> {
        let hashed_id = hash_token(token);
        let session = sqlx::query_as::<_, DbSessionRecord>(
            r#"
			SELECT
				id,
				expires_at,
				created_at,
				last_active_at,
				user_id,
				ip_address,
				user_agent,
				device_name,
				platform,
				client_id,
				device_info,
				browser_name,
				browser_version,
				os_name,
				os_version
			FROM session
			WHERE id = $1 AND expires_at > NOW()
			LIMIT 1
			"#,
        )
        .bind(hashed_id)
        .fetch_optional(&self.pool)
        .await
        .ok()?;

        session.map(|row| VerifiedSession {
            token: token.to_string(),
            session_id: row.id,
            user_id: row.user_id,
            expires_at: row.expires_at,
            platform: normalize_session_platform(row.platform.as_deref()),
            client_id: normalized_session_client_id(row.platform.as_deref(), row.client_id),
        })
    }

    async fn refresh_session(
        &self,
        current_session: &VerifiedSession,
    ) -> Result<RefreshSessionResponse, AuthRpcError> {
        let mut transaction = self.pool.begin().await.map_err(|e| {
            tracing::error!(error = %e, "Session store is unavailable");
            internal_handler_error("Session store is unavailable")
        })?;

        let current = sqlx::query_as::<_, DbSessionRecord>(
            r#"
			SELECT
				id,
				expires_at,
				created_at,
				last_active_at,
				user_id,
				ip_address,
				user_agent,
				device_name,
				platform,
				client_id,
				device_info,
				browser_name,
				browser_version,
				os_name,
				os_version
			FROM session
			WHERE id = $1 AND expires_at > NOW()
			LIMIT 1
			FOR UPDATE
			"#,
        )
        .bind(&current_session.session_id)
        .fetch_optional(transaction.as_mut())
        .await
        .map_err(|e| {
            tracing::error!(error = %e, "Session store is unavailable");
            internal_handler_error("Session store is unavailable")
        })?
        .ok_or_else(|| handler_unauthorized_error("Session expired"))?;

        let platform = normalize_session_platform(current.platform.as_deref());
        let client_id =
            normalized_session_client_id(current.platform.as_deref(), current.client_id);
        let next_expiry = now_utc() + session_duration_for_platform(&platform);
        let next_token = generate_opaque_session_token();
        let next_session_id = hash_token(&next_token);
        let issued_at = now_utc();

        let device_name = if client_id.is_some() {
            let grouped = sqlx::query_as::<_, DbSessionRecord>(
                r#"
				SELECT
					id,
					expires_at,
					created_at,
					last_active_at,
					user_id,
					ip_address,
					user_agent,
					device_name,
					platform,
					client_id,
					device_info,
					browser_name,
					browser_version,
					os_name,
					os_version
				FROM session
				WHERE user_id = $1 AND platform = $2 AND client_id = $3
				ORDER BY last_active_at DESC, created_at DESC, id DESC
				"#,
            )
            .bind(&current.user_id)
            .bind(&platform)
            .bind(client_id.as_deref())
            .fetch_all(transaction.as_mut())
            .await
            .map_err(|e| {
                tracing::error!(error = %e, "Session store is unavailable");
                internal_handler_error("Session store is unavailable")
            })?;

            grouped
                .into_iter()
                .find_map(|session| session.device_name)
                .or(current.device_name.clone())
        } else {
            current.device_name.clone()
        };

        if client_id.is_some() {
            sqlx::query(
                r#"DELETE FROM session WHERE user_id = $1 AND platform = $2 AND client_id = $3"#,
            )
            .bind(&current.user_id)
            .bind(&platform)
            .bind(client_id.as_deref())
            .execute(transaction.as_mut())
            .await
            .map_err(|e| {
                tracing::error!(error = %e, "Session store is unavailable");
                internal_handler_error("Session store is unavailable")
            })?;
        } else {
            sqlx::query(r#"DELETE FROM session WHERE id = $1"#)
                .bind(&current.id)
                .execute(transaction.as_mut())
                .await
                .map_err(|e| {
                    tracing::error!(error = %e, "Session store is unavailable");
                    internal_handler_error("Session store is unavailable")
                })?;
        }

        sqlx::query(
            r#"
			INSERT INTO session (
				id,
				expires_at,
				created_at,
				updated_at,
				ip_address,
				user_agent,
				device_name,
				platform,
				client_id,
				device_info,
				browser_name,
				browser_version,
				os_name,
				os_version,
				last_active_at,
				user_id
			) VALUES (
				$1, $2, $3, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $3, $14
			)
			"#,
        )
        .bind(&next_session_id)
        .bind(next_expiry)
        .bind(issued_at)
        .bind(current.ip_address)
        .bind(current.user_agent)
        .bind(device_name)
        .bind(&platform)
        .bind(client_id.as_deref())
        .bind(current.device_info)
        .bind(current.browser_name)
        .bind(current.browser_version)
        .bind(current.os_name)
        .bind(current.os_version)
        .bind(&current.user_id)
        .execute(transaction.as_mut())
        .await
        .map_err(|e| {
            tracing::error!(error = %e, "Session store is unavailable");
            internal_handler_error("Session store is unavailable")
        })?;

        transaction.commit().await.map_err(|e| {
            tracing::error!(error = %e, "Session store is unavailable");
            internal_handler_error("Session store is unavailable")
        })?;

        Ok(RefreshSessionResponse {
            token: next_token,
            session_id: next_session_id,
            expires_at: format_rfc3339(next_expiry),
        })
    }

    async fn delete_session(&self, session_id: &str) -> Result<Vec<String>, AuthRpcError> {
        query_scalar::<_, String>("DELETE FROM session WHERE id = $1 RETURNING id")
            .bind(session_id)
            .fetch_all(&self.pool)
            .await
            .map_err(|_| internal_handler_error("Session store is unavailable"))
    }

    async fn delete_all_user_sessions(&self, user_id: &str) -> Result<Vec<String>, AuthRpcError> {
        query_scalar::<_, String>("DELETE FROM session WHERE user_id = $1 RETURNING id")
            .bind(user_id)
            .fetch_all(&self.pool)
            .await
            .map_err(|_| internal_handler_error("Session store is unavailable"))
    }

    async fn delete_other_user_sessions(
        &self,
        user_id: &str,
        current_session_id: &str,
    ) -> Result<Vec<String>, AuthRpcError> {
        query_scalar::<_, String>(
            "DELETE FROM session WHERE user_id = $1 AND id != $2 RETURNING id",
        )
        .bind(user_id)
        .bind(current_session_id)
        .fetch_all(&self.pool)
        .await
        .map_err(|_| internal_handler_error("Session store is unavailable"))
    }

    async fn list_devices(
        &self,
        user_id: &str,
        current_session_id: &str,
    ) -> Result<Vec<DeviceSessionResponse>, AuthRpcError> {
        let rows = query_as::<_, DbSessionRecord>(
            r#"
			SELECT
				id,
				expires_at,
				created_at,
				last_active_at,
				user_id,
				ip_address,
				user_agent,
				device_name,
				platform,
				client_id,
				device_info,
				browser_name,
				browser_version,
				os_name,
				os_version
			FROM session
			WHERE user_id = $1 AND expires_at > NOW()
			ORDER BY last_active_at ASC
			"#,
        )
        .bind(user_id)
        .fetch_all(&self.pool)
        .await
        .map_err(|e| {
            tracing::error!(error = %e, "Session store is unavailable");
            internal_handler_error("Session store is unavailable")
        })?;

        let sessions = rows
            .into_iter()
            .map(snapshot_from_db_session)
            .collect::<Vec<_>>();
        Ok(build_device_session_responses(sessions, current_session_id))
    }

    async fn get_owned_session(
        &self,
        session_id: &str,
        user_id: &str,
    ) -> Result<Option<SessionSnapshot>, AuthRpcError> {
        let row = query_as::<_, DbSessionRecord>(
            r#"
			SELECT
				id,
				expires_at,
				created_at,
				last_active_at,
				user_id,
				ip_address,
				user_agent,
				device_name,
				platform,
				client_id,
				device_info,
				browser_name,
				browser_version,
				os_name,
				os_version
			FROM session
			WHERE id = $1 AND user_id = $2
			LIMIT 1
			"#,
        )
        .bind(session_id)
        .bind(user_id)
        .fetch_optional(&self.pool)
        .await
        .map_err(|e| {
            tracing::error!(error = %e, "Session store is unavailable");
            internal_handler_error("Session store is unavailable")
        })?;

        Ok(row.map(snapshot_from_db_session))
    }

    async fn revoke_device(
        &self,
        session_id: &str,
        user_id: &str,
    ) -> Result<Vec<String>, AuthRpcError> {
        let Some(existing_session) = self.get_owned_session(session_id, user_id).await? else {
            return Ok(Vec::new());
        };

        if is_grouped_client_session(&existing_session) {
            let grouped_sessions = query_scalar::<_, String>(
                "SELECT id FROM session WHERE user_id = $1 AND platform = $2 AND client_id = $3",
            )
            .bind(user_id)
            .bind(&existing_session.platform)
            .bind(existing_session.client_id.as_deref())
            .fetch_all(&self.pool)
            .await
            .map_err(|e| {
                tracing::error!(error = %e, "Session store is unavailable");
                internal_handler_error("Session store is unavailable")
            })?;

            query("DELETE FROM session WHERE user_id = $1 AND platform = $2 AND client_id = $3")
                .bind(user_id)
                .bind(&existing_session.platform)
                .bind(existing_session.client_id.as_deref())
                .execute(&self.pool)
                .await
                .map_err(|e| {
                    tracing::error!(error = %e, "Session store is unavailable");
                    internal_handler_error("Session store is unavailable")
                })?;

            return Ok(grouped_sessions);
        }

        query("DELETE FROM session WHERE id = $1 AND user_id = $2")
            .bind(session_id)
            .bind(user_id)
            .execute(&self.pool)
            .await
            .map_err(|e| {
                tracing::error!(error = %e, "Session store is unavailable");
                internal_handler_error("Session store is unavailable")
            })?;

        Ok(vec![existing_session.id])
    }

    async fn rename_device(
        &self,
        session_id: &str,
        user_id: &str,
        device_name: &str,
    ) -> Result<(), AuthRpcError> {
        let Some(existing_session) = self.get_owned_session(session_id, user_id).await? else {
            return Ok(());
        };

        if is_grouped_client_session(&existing_session) {
            query(
				"UPDATE session SET device_name = $1 WHERE user_id = $2 AND platform = $3 AND client_id = $4 AND expires_at > NOW()",
			)
			.bind(device_name)
			.bind(user_id)
			.bind(&existing_session.platform)
			.bind(existing_session.client_id.as_deref())
			.execute(&self.pool)
			.await
			.map_err(|e| { tracing::error!(error = %e, "Session store is unavailable"); internal_handler_error("Session store is unavailable") })?;
            return Ok(());
        }

        query("UPDATE session SET device_name = $1 WHERE id = $2 AND user_id = $3")
            .bind(device_name)
            .bind(session_id)
            .bind(user_id)
            .execute(&self.pool)
            .await
            .map_err(|e| {
                tracing::error!(error = %e, "Session store is unavailable");
                internal_handler_error("Session store is unavailable")
            })?;
        Ok(())
    }

    async fn heartbeat(&self, session_id: &str) -> Result<(), AuthRpcError> {
        query("UPDATE session SET last_active_at = $1 WHERE id = $2")
            .bind(now_utc())
            .bind(session_id)
            .execute(&self.pool)
            .await
            .map_err(|e| {
                tracing::error!(error = %e, "Session store is unavailable");
                internal_handler_error("Session store is unavailable")
            })?;
        Ok(())
    }
}

fn verify_memory_token(inner: &Arc<SessionServiceInner>, token: &str) -> Option<VerifiedSession> {
    let sessions = inner.sessions_by_token.read().ok()?;
    let session = sessions.get(token)?;

    if session.expires_at <= now_utc() {
        return None;
    }

    Some(VerifiedSession {
        token: session.token.clone(),
        session_id: session.session_id.clone(),
        user_id: session.user_id.clone(),
        expires_at: session.expires_at,
        platform: session.platform.clone(),
        client_id: session.client_id.clone(),
    })
}

fn refresh_memory_session(
    inner: &Arc<SessionServiceInner>,
    current_session: &VerifiedSession,
) -> Result<RefreshSessionResponse, AuthRpcError> {
    if current_session.expires_at <= now_utc() {
        return Err(handler_unauthorized_error("Session expired"));
    }

    let next_id = inner.next_id.fetch_add(1, Ordering::Relaxed);
    let next_expiry = now_utc() + session_duration_for_platform(&current_session.platform);
    let issued_at = now_utc();
    let next_record = SessionRecord {
        token: format!("dev-session-token-{next_id}"),
        session_id: format!("dev-session-{next_id}"),
        user_id: current_session.user_id.clone(),
        expires_at: next_expiry,
        created_at: issued_at,
        last_active_at: issued_at,
        platform: current_session.platform.clone(),
        client_id: current_session.client_id.clone(),
        device_name: None,
        ip_address: None,
        browser_name: None,
        browser_version: None,
        os_name: None,
        os_version: None,
    };

    let mut sessions = inner.sessions_by_token.write().map_err(|e| {
        tracing::error!(error = %e, "Session store is unavailable");
        internal_handler_error("Session store is unavailable")
    })?;

    match sessions.remove(&current_session.token) {
        Some(existing) if existing.expires_at > now_utc() => {
            sessions.insert(next_record.token.clone(), next_record.clone());
        }
        _ => {
            return Err(handler_unauthorized_error("Session expired"));
        }
    }

    Ok(RefreshSessionResponse {
        token: next_record.token,
        session_id: next_record.session_id,
        expires_at: format_rfc3339(next_record.expires_at),
    })
}

fn list_memory_devices(
    inner: &Arc<SessionServiceInner>,
    user_id: &str,
    current_session_id: &str,
) -> Vec<DeviceSessionResponse> {
    let sessions = inner
        .sessions_by_token
        .read()
        .expect("memory session store poisoned")
        .values()
        .filter(|record| record.user_id == user_id && record.expires_at > now_utc())
        .cloned()
        .map(snapshot_from_memory_session)
        .collect::<Vec<_>>();

    build_device_session_responses(sessions, current_session_id)
}

fn get_owned_memory_session(
    inner: &Arc<SessionServiceInner>,
    session_id: &str,
    user_id: &str,
) -> Option<SessionSnapshot> {
    inner
        .sessions_by_token
        .read()
        .ok()?
        .values()
        .find(|record| record.session_id == session_id && record.user_id == user_id)
        .cloned()
        .map(snapshot_from_memory_session)
}

fn revoke_memory_device(
    inner: &Arc<SessionServiceInner>,
    session_id: &str,
    user_id: &str,
) -> Vec<String> {
    let Some(existing_session) = get_owned_memory_session(inner, session_id, user_id) else {
        return Vec::new();
    };

    let mut sessions = inner
        .sessions_by_token
        .write()
        .expect("memory session store poisoned");

    if is_grouped_client_session(&existing_session) {
        let revoked_ids = sessions
            .values()
            .filter(|record| {
                record.user_id == user_id
                    && record.platform == existing_session.platform
                    && record.client_id == existing_session.client_id
            })
            .map(|record| record.session_id.clone())
            .collect::<Vec<_>>();

        sessions.retain(|_, record| {
            !(record.user_id == user_id
                && record.platform == existing_session.platform
                && record.client_id == existing_session.client_id)
        });

        return revoked_ids;
    }

    sessions.retain(|_, record| !(record.user_id == user_id && record.session_id == session_id));
    vec![existing_session.id]
}

fn rename_memory_device(
    inner: &Arc<SessionServiceInner>,
    session_id: &str,
    user_id: &str,
    device_name: &str,
) {
    let Some(existing_session) = get_owned_memory_session(inner, session_id, user_id) else {
        return;
    };

    let mut sessions = inner
        .sessions_by_token
        .write()
        .expect("memory session store poisoned");

    for record in sessions.values_mut() {
        if is_grouped_client_session(&existing_session) {
            if record.user_id == user_id
                && record.platform == existing_session.platform
                && record.client_id == existing_session.client_id
                && record.expires_at > now_utc()
            {
                record.device_name = Some(device_name.to_string());
            }
        } else if record.user_id == user_id && record.session_id == session_id {
            record.device_name = Some(device_name.to_string());
        }
    }
}

fn touch_memory_session(inner: &Arc<SessionServiceInner>, session_id: &str) {
    let mut sessions = inner
        .sessions_by_token
        .write()
        .expect("memory session store poisoned");
    if let Some(record) = sessions
        .values_mut()
        .find(|record| record.session_id == session_id)
    {
        record.last_active_at = now_utc();
    }
}

fn delete_memory_session(inner: &Arc<SessionServiceInner>, session_id: &str) -> Vec<String> {
    let mut sessions = inner
        .sessions_by_token
        .write()
        .expect("memory session store poisoned");
    let mut revoked_ids = Vec::new();
    sessions.retain(|_, record| {
        let keep = record.session_id != session_id;
        if !keep {
            revoked_ids.push(record.session_id.clone());
        }
        keep
    });
    revoked_ids
}

fn delete_all_memory_sessions(inner: &Arc<SessionServiceInner>, user_id: &str) -> Vec<String> {
    let mut sessions = inner
        .sessions_by_token
        .write()
        .expect("memory session store poisoned");
    let mut revoked_ids = Vec::new();
    sessions.retain(|_, record| {
        let keep = record.user_id != user_id;
        if !keep {
            revoked_ids.push(record.session_id.clone());
        }
        keep
    });
    revoked_ids
}

fn delete_other_memory_sessions(
    inner: &Arc<SessionServiceInner>,
    user_id: &str,
    current_session_id: &str,
) -> Vec<String> {
    let mut sessions = inner
        .sessions_by_token
        .write()
        .expect("memory session store poisoned");
    let mut revoked_ids = Vec::new();
    sessions.retain(|_, record| {
        let keep = record.user_id != user_id || record.session_id == current_session_id;
        if !keep {
            revoked_ids.push(record.session_id.clone());
        }
        keep
    });
    revoked_ids
}

fn issue_memory_session(
    inner: &Arc<SessionServiceInner>,
    user_id: &str,
    request: &RequestMetadata,
) -> CreatedSession {
    let next_id = inner.next_id.fetch_add(1, Ordering::Relaxed);
    let issued_at = now_utc();
    let platform = normalize_session_platform(request.app_platform.as_deref());
    let client_id =
        normalized_session_client_id(request.app_platform.as_deref(), request.client_id.clone());
    let token = format!("session-token-{next_id}-{:#x}", random::<u64>());
    let session_id = hash_token(&token);
    let record = SessionRecord {
        token: token.clone(),
        session_id: session_id.clone(),
        user_id: user_id.to_string(),
        expires_at: issued_at + session_duration_for_platform(&platform),
        created_at: issued_at,
        last_active_at: issued_at,
        platform: platform.clone(),
        client_id: client_id.clone(),
        device_name: None,
        ip_address: None,
        browser_name: None,
        browser_version: None,
        os_name: None,
        os_version: None,
    };

    let mut sessions = inner
        .sessions_by_token
        .write()
        .expect("session store should be writable");
    if client_id.is_some() {
        sessions.retain(|_, existing| {
            !(existing.user_id == user_id
                && existing.platform == platform
                && existing.client_id == client_id)
        });
    }
    sessions.insert(token.clone(), record.clone());

    CreatedSession {
        token,
        session_id,
        expires_at: record.expires_at,
    }
}

#[cfg(test)]
fn issue_memory_session_for_tests(
    inner: &Arc<SessionServiceInner>,
    user_id: &str,
    platform: &str,
    client_id: Option<&str>,
) -> VerifiedSession {
    let next_id = inner.next_id.fetch_add(1, Ordering::Relaxed);
    let issued_at = now_utc();
    let record = SessionRecord {
        token: format!("test-token-{next_id}"),
        session_id: format!("test-session-{next_id}"),
        user_id: user_id.to_string(),
        expires_at: now_utc() + session_duration_for_platform(platform),
        created_at: issued_at,
        last_active_at: issued_at,
        platform: platform.to_string(),
        client_id: client_id.map(ToOwned::to_owned),
        device_name: None,
        ip_address: None,
        browser_name: None,
        browser_version: None,
        os_name: None,
        os_version: None,
    };

    inner
        .sessions_by_token
        .write()
        .expect("session store should be writable")
        .insert(record.token.clone(), record.clone());

    VerifiedSession {
        token: record.token,
        session_id: record.session_id,
        user_id: record.user_id,
        expires_at: record.expires_at,
        platform: record.platform,
        client_id: record.client_id,
    }
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

#[allow(non_snake_case)]
#[handler(mutation)]
pub async fn requestSignupVerification(
    ctx: PublicAuthContext,
    input: RequestSignupVerificationInput,
) -> Result<LogoutResponse, AuthRpcError> {
    let pool = ctx
        .app_state
        .db_pool
        .as_ref()
        .ok_or_else(|| internal_handler_error("Database is not configured"))?;
    let normalized_email = normalize_email(&input.email);

    if let Some(invitation_token) = input.invitation_token.as_deref() {
        let _ =
            get_pending_invitation_for_signup(pool, invitation_token, &normalized_email).await?;
    } else if bittery_mode() == "self-hosted" && has_any_registered_user(pool).await? {
        return Err(AuthRpcError {
            code: "FORBIDDEN".to_string(),
            message: "Public registration is disabled. Ask an admin for an invite link."
                .to_string(),
        });
    }

    let code =
        create_signup_verification(pool, &normalized_email, input.invitation_token.as_deref())
            .await?;
    send_signup_verification_code(&normalized_email, &code, input.invitation_token.as_deref())?;

    Ok(LogoutResponse { success: true })
}

#[allow(non_snake_case)]
#[handler(mutation)]
pub async fn verifySignupVerification(
    ctx: PublicAuthContext,
    input: VerifySignupVerificationInput,
) -> Result<VerifySignupVerificationResponse, AuthRpcError> {
    let pool = ctx
        .app_state
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

#[allow(non_snake_case)]
#[handler(mutation)]
pub async fn signup(
    ctx: PublicAuthContext,
    input: SignupInput,
) -> Result<SignupResponse, AuthRpcError> {
    validate_signup_input(&input)?;
    let pool = db_pool(&ctx.app_state)?;
    let normalized_email = normalize_email(&input.email);
    let self_hosted_mode = bittery_mode() == "self-hosted";

    if self_hosted_mode && has_any_registered_user(pool).await? {
        return Err(AuthRpcError {
            code: "FORBIDDEN".to_string(),
            message: "Public registration is disabled. Ask an admin for an invite link."
                .to_string(),
        });
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

    let session = ctx
        .app_state
        .sessions
        .create_session(&user_id, &ctx.request)
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

#[allow(non_snake_case)]
#[handler(mutation)]
pub async fn signupWithInvitation(
    ctx: PublicAuthContext,
    input: SignupWithInvitationInput,
) -> Result<SignupResponse, AuthRpcError> {
    validate_signup_with_invitation_input(&input)?;
    let pool = db_pool(&ctx.app_state)?;
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
            return Err(AuthRpcError {
                code: "BAD_REQUEST".to_string(),
                message: "Team has reached member limit".to_string(),
            });
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

    let session = ctx
        .app_state
        .sessions
        .create_session(&user_id, &ctx.request)
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

#[allow(non_snake_case)]
#[handler(mutation)]
pub async fn startLogin(
    ctx: PublicAuthContext,
    input: StartLoginInput,
) -> Result<StartLoginResponse, AuthRpcError> {
    let _request = ctx.request;
    validate_hex_string(&input.client_public_key, "Invalid client public key")?;
    let pool = db_pool(&ctx.app_state)?;
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

#[allow(non_snake_case)]
#[handler(mutation)]
pub async fn finishLogin(
    ctx: PublicAuthContext,
    input: FinishLoginInput,
) -> Result<FinishLoginResponse, AuthRpcError> {
    validate_login_attempt_id(&input.attempt_id)?;
    validate_hex_string(&input.client_public_key, "Invalid client public key")?;
    validate_hex_string(&input.client_proof, "Invalid client proof")?;
    let pool = db_pool(&ctx.app_state)?;
    let attempt = query_as::<_, DbLoginAttemptRow>(
		"SELECT id, user_id, normalized_email_hash, client_public_key, server_ephemeral_secret, expires_at FROM login_attempt WHERE id = $1 LIMIT 1",
	)
	.bind(&input.attempt_id)
	.fetch_optional(pool)
	.await
	.map_err(|e| { tracing::error!(error = %e, "Failed to load login attempt"); internal_handler_error("Failed to load login attempt") })?
	.ok_or_else(|| AuthRpcError {
		code: UNAUTHORIZED_CODE.to_string(),
		message: "Invalid credentials".to_string(),
	})?;

    query("DELETE FROM login_attempt WHERE id = $1")
        .bind(&attempt.id)
        .execute(pool)
        .await
        .map_err(|e| {
            tracing::error!(error = %e, "Failed to consume login attempt");
            internal_handler_error("Failed to consume login attempt")
        })?;

    if attempt.expires_at <= now_utc() || attempt.client_public_key != input.client_public_key {
        return Err(AuthRpcError {
            code: UNAUTHORIZED_CODE.to_string(),
            message: "Invalid credentials".to_string(),
        });
    }

    let Some(user_id) = attempt.user_id.as_deref() else {
        return Err(AuthRpcError {
            code: UNAUTHORIZED_CODE.to_string(),
            message: "Invalid credentials".to_string(),
        });
    };
    let user = query_as::<_, DbLoginUserRow>(
		"SELECT id, email, name, secret_key_hint, srp_salt, srp_verifier, public_key, encrypted_private_key FROM \"user\" WHERE id = $1 LIMIT 1",
	)
	.bind(user_id)
	.fetch_optional(pool)
	.await
	.map_err(|e| { tracing::error!(error = %e, "Failed to load login account"); internal_handler_error("Failed to load login account") })?
	.ok_or_else(|| AuthRpcError {
		code: UNAUTHORIZED_CODE.to_string(),
		message: "Invalid credentials".to_string(),
	})?;

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
        .map_err(|_| AuthRpcError {
            code: UNAUTHORIZED_CODE.to_string(),
            message: "Invalid credentials".to_string(),
        })?;
    let session = ctx
        .app_state
        .sessions
        .create_session(&user.id, &ctx.request)
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

#[allow(non_snake_case)]
#[handler(mutation)]
pub async fn requestRecoveryVerification(
    ctx: PublicAuthContext,
    input: RequestRecoveryVerificationInput,
) -> Result<LogoutResponse, AuthRpcError> {
    let _request = ctx.request;
    let pool = db_pool(&ctx.app_state)?;
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

#[allow(non_snake_case)]
#[handler(mutation)]
pub async fn verifyRecoveryCode(
    ctx: PublicAuthContext,
    input: VerifyRecoveryCodeInput,
) -> Result<VerifyRecoveryCodeResponse, AuthRpcError> {
    let _request = ctx.request;
    let pool = db_pool(&ctx.app_state)?;
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

#[allow(non_snake_case)]
#[handler(query)]
pub async fn getRecoveryData(
    ctx: PublicAuthContext,
    input: GetRecoveryDataInput,
) -> Result<GetRecoveryDataResponse, AuthRpcError> {
    let _request = ctx.request;
    let pool = db_pool(&ctx.app_state)?;
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

#[allow(non_snake_case)]
#[handler(mutation)]
pub async fn resetPassword(
    ctx: PublicAuthContext,
    input: ResetPasswordInput,
) -> Result<ResetPasswordResponse, AuthRpcError> {
    validate_hex_string(&input.srp_salt, "Invalid SRP salt")?;
    validate_hex_string(&input.srp_verifier, "Invalid SRP verifier")?;
    let pool = db_pool(&ctx.app_state)?;
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
    let session = ctx
        .app_state
        .sessions
        .create_session(&user_id, &ctx.request)
        .await?;

    query(
		"INSERT INTO audit_log (id, user_id, action, entity_type, entity_id, metadata, created_at) VALUES ($1, $2, 'password_reset_via_recovery', 'user', $3, $4, $5)",
	)
	.bind(generate_resource_id("audit"))
	.bind(&user_id)
	.bind(&user_id)
	.bind(json!({ "vaultKeysUpdated": input.encrypted_vault_keys.len() }))
	.bind(now_utc())
	.execute(pool)
	.await
	.map_err(|e| { tracing::error!(error = %e, "Failed to record recovery audit event"); internal_handler_error("Failed to record recovery audit event") })?;

    Ok(ResetPasswordResponse {
        token: session.token,
        session_id: session.session_id,
        expires_at: format_rfc3339(session.expires_at),
        user_id,
    })
}

#[allow(non_snake_case)]
#[handler(mutation)]
pub async fn updateEmail(
    ctx: RefreshSessionContext,
    input: UpdateEmailInput,
) -> Result<LogoutResponse, AuthRpcError> {
    validate_hex_string(&input.srp_salt, "Invalid SRP salt")?;
    validate_hex_string(&input.srp_verifier, "Invalid SRP verifier")?;
    validate_encrypted_vault_keys(&input.encrypted_vault_keys)?;
    let pool = db_pool(&ctx.app_state)?;
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
        .is_some_and(|value| value != ctx.session.user_id)
    {
        return Err(bad_request_handler_error("Email already in use"));
    }

    update_user_email_data(pool, &ctx.session.user_id, &normalized_new_email, &input).await?;
    let revoked_session_ids = ctx
        .app_state
        .sessions
        .delete_all_user_sessions(&ctx.session.user_id)
        .await?;
    record_session_revocations(
        pool,
        &ctx.session.user_id,
        &revoked_session_ids,
        "email_changed",
    )
    .await
    .map_err(|e| {
        tracing::error!(error = %e, "Failed to record session revocations");
        internal_handler_error("Failed to record session revocations")
    })?;
    query(
		"INSERT INTO audit_log (id, user_id, action, entity_type, entity_id, metadata, created_at) VALUES ($1, $2, 'email_changed', 'user', $3, $4, $5)",
	)
	.bind(generate_resource_id("audit"))
	.bind(&ctx.session.user_id)
	.bind(&ctx.session.user_id)
	.bind(json!({ "newEmail": normalized_new_email, "vaultKeysUpdated": input.encrypted_vault_keys.len() }))
	.bind(now_utc())
	.execute(pool)
	.await
	.map_err(|e| { tracing::error!(error = %e, "Failed to record email change audit event"); internal_handler_error("Failed to record email change audit event") })?;

    Ok(LogoutResponse { success: true })
}

#[allow(non_snake_case)]
#[handler(mutation)]
pub async fn changePassword(
    ctx: RefreshSessionContext,
    input: ChangePasswordInput,
) -> Result<LogoutResponse, AuthRpcError> {
    validate_hex_string(&input.srp_salt, "Invalid SRP salt")?;
    validate_hex_string(&input.srp_verifier, "Invalid SRP verifier")?;
    validate_encrypted_vault_keys(&input.encrypted_vault_keys)?;
    let pool = db_pool(&ctx.app_state)?;

    update_user_password_data(pool, &ctx.session.user_id, &input).await?;
    let revoked_session_ids = ctx
        .app_state
        .sessions
        .delete_all_user_sessions(&ctx.session.user_id)
        .await?;
    record_session_revocations(
        pool,
        &ctx.session.user_id,
        &revoked_session_ids,
        "password_changed",
    )
    .await
    .map_err(|e| {
        tracing::error!(error = %e, "Failed to record session revocations");
        internal_handler_error("Failed to record session revocations")
    })?;
    query(
		"INSERT INTO audit_log (id, user_id, action, entity_type, entity_id, metadata, created_at) VALUES ($1, $2, 'password_changed', 'user', $3, $4, $5)",
	)
	.bind(generate_resource_id("audit"))
	.bind(&ctx.session.user_id)
	.bind(&ctx.session.user_id)
	.bind(json!({ "vaultKeysUpdated": input.encrypted_vault_keys.len() }))
	.bind(now_utc())
	.execute(pool)
	.await
	.map_err(|e| { tracing::error!(error = %e, "Failed to record password change audit event"); internal_handler_error("Failed to record password change audit event") })?;

    Ok(LogoutResponse { success: true })
}

#[allow(non_snake_case)]
#[handler(mutation)]
pub async fn regenerateSecretKey(
    ctx: RefreshSessionContext,
    input: RegenerateSecretKeyInput,
) -> Result<LogoutResponse, AuthRpcError> {
    validate_hex_string(&input.srp_salt, "Invalid SRP salt")?;
    validate_hex_string(&input.srp_verifier, "Invalid SRP verifier")?;
    validate_encrypted_vault_keys(&input.encrypted_vault_keys)?;
    let pool = db_pool(&ctx.app_state)?;

    update_user_secret_key_data(pool, &ctx.session.user_id, &input).await?;
    let revoked_session_ids = ctx
        .app_state
        .sessions
        .delete_other_user_sessions(&ctx.session.user_id, &ctx.session.session_id)
        .await?;
    record_session_revocations(
        pool,
        &ctx.session.user_id,
        &revoked_session_ids,
        "secret_key_regenerated",
    )
    .await
    .map_err(|e| {
        tracing::error!(error = %e, "Failed to record session revocations");
        internal_handler_error("Failed to record session revocations")
    })?;
    query(
		"INSERT INTO audit_log (id, user_id, action, entity_type, entity_id, metadata, created_at) VALUES ($1, $2, 'secret_key_regenerated', 'user', $3, $4, $5)",
	)
	.bind(generate_resource_id("audit"))
	.bind(&ctx.session.user_id)
	.bind(&ctx.session.user_id)
	.bind(json!({ "vaultKeysUpdated": input.encrypted_vault_keys.len() }))
	.bind(now_utc())
	.execute(pool)
	.await
	.map_err(|e| { tracing::error!(error = %e, "Failed to record secret key regeneration audit event"); internal_handler_error("Failed to record secret key regeneration audit event") })?;

    Ok(LogoutResponse { success: true })
}

#[allow(non_snake_case)]
#[handler(mutation)]
pub async fn storeRecoveryKey(
    ctx: RefreshSessionContext,
    input: StoreRecoveryKeyInput,
) -> Result<LogoutResponse, AuthRpcError> {
    let pool = db_pool(&ctx.app_state)?;
    let user = query_as::<_, DbAccountMutationUserRow>(
		"SELECT u.id, u.email, u.encrypted_master_key, u.team_id, t.owner_id AS team_owner_id, t.type::text AS team_type FROM \"user\" u LEFT JOIN team t ON u.team_id = t.id WHERE u.id = $1 LIMIT 1",
	)
	.bind(&ctx.session.user_id)
	.fetch_optional(pool)
	.await
	.map_err(|e| { tracing::error!(error = %e, "Failed to load user"); internal_handler_error("Failed to load user") })?
	.ok_or_else(|| AuthRpcError {
		code: "NOT_FOUND".to_string(),
		message: "User not found".to_string(),
	})?;
    let had_recovery_key = user.encrypted_master_key.is_some();

    store_recovery_key_data(pool, &ctx.session.user_id, &input).await?;
    query(
		"INSERT INTO audit_log (id, user_id, action, entity_type, entity_id, created_at) VALUES ($1, $2, $3, 'user', $4, $5)",
	)
	.bind(generate_resource_id("audit"))
	.bind(&ctx.session.user_id)
	.bind(if had_recovery_key { "recovery_key_regenerated" } else { "recovery_key_setup" })
	.bind(&ctx.session.user_id)
	.bind(now_utc())
	.execute(pool)
	.await
	.map_err(|e| { tracing::error!(error = %e, "Failed to record recovery key audit event"); internal_handler_error("Failed to record recovery key audit event") })?;

    Ok(LogoutResponse { success: true })
}

#[allow(non_snake_case)]
#[handler(mutation)]
pub async fn deleteAccount(
    ctx: RefreshSessionContext,
    input: DeleteAccountInput,
) -> Result<LogoutResponse, AuthRpcError> {
    let pool = db_pool(&ctx.app_state)?;
    let user = query_as::<_, DbAccountMutationUserRow>(
		"SELECT u.id, u.email, u.encrypted_master_key, u.team_id, t.owner_id AS team_owner_id, t.type::text AS team_type FROM \"user\" u LEFT JOIN team t ON u.team_id = t.id WHERE u.id = $1 LIMIT 1",
	)
	.bind(&ctx.session.user_id)
	.fetch_optional(pool)
	.await
	.map_err(|e| { tracing::error!(error = %e, "Failed to load user"); internal_handler_error("Failed to load user") })?
	.ok_or_else(|| AuthRpcError {
		code: "NOT_FOUND".to_string(),
		message: "User not found".to_string(),
	})?;

    if normalize_email(&user.email) != normalize_email(&input.confirm_email) {
        return Err(bad_request_handler_error("Email does not match"));
    }
    if user.team_owner_id.as_deref() == Some(ctx.session.user_id.as_str())
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

    query(
		"INSERT INTO audit_log (id, user_id, action, entity_type, entity_id, created_at) VALUES ($1, $2, 'account_deleted', 'user', $3, $4)",
	)
	.bind(generate_resource_id("audit"))
	.bind(&ctx.session.user_id)
	.bind(&ctx.session.user_id)
	.bind(now_utc())
	.execute(pool)
	.await
	.map_err(|e| { tracing::error!(error = %e, "Failed to record account deletion audit event"); internal_handler_error("Failed to record account deletion audit event") })?;

    delete_user_account_data(pool, &ctx.session.user_id).await?;

    Ok(LogoutResponse { success: true })
}

#[allow(non_snake_case)]
#[handler(query)]
pub async fn registrationStatus(
    ctx: AppContext,
) -> Result<RegistrationStatusResponse, AuthRpcError> {
    let mode = bittery_mode().to_string();
    if mode == "cloud" {
        return Ok(RegistrationStatusResponse {
            mode,
            allow_public_signup: true,
            reason: None,
        });
    }

    let allow_public_signup = match ctx.app_state.db_pool.as_ref() {
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

#[allow(non_snake_case)]
#[handler(query)]
pub async fn checkEmail(
    ctx: AppContext,
    input: CheckEmailInput,
) -> Result<CheckEmailResponse, AuthRpcError> {
    let normalized_email = normalize_email(&input.email);
    let secret_key_hint = match ctx.app_state.db_pool.as_ref() {
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

#[allow(non_snake_case)]
#[handler(query)]
pub async fn me(ctx: RefreshSessionContext) -> Result<MeResponse, AuthRpcError> {
    let pool = ctx
        .app_state
        .db_pool
        .as_ref()
        .ok_or_else(|| internal_handler_error("Database is not configured"))?;
    let user = query_as::<_, DbMeRow>(
		"SELECT u.id, u.email, u.name, u.team_id, t.name AS team_name, t.type::text AS team_type, t.image_key AS team_image_key, u.role::text AS role, u.secret_key_hint, u.public_key, u.encrypted_private_key, u.encrypted_master_key, u.created_at FROM \"user\" u LEFT JOIN team t ON u.team_id = t.id WHERE u.id = $1 LIMIT 1",
	)
	.bind(&ctx.session.user_id)
	.fetch_optional(pool)
	.await
	.map_err(|e| { tracing::error!(error = %e, "Failed to load user"); internal_handler_error("Failed to load user") })?
	.ok_or_else(|| AuthRpcError {
		code: "NOT_FOUND".to_string(),
		message: "User not found".to_string(),
	})?;

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

#[allow(non_snake_case)]
#[handler(query)]
pub async fn listDevices(
    ctx: RefreshSessionContext,
) -> Result<Vec<DeviceSessionResponse>, AuthRpcError> {
    ctx.app_state
        .sessions
        .list_devices(&ctx.session.user_id, &ctx.session.session_id)
        .await
}

#[allow(non_snake_case)]
#[handler(mutation)]
pub async fn revokeDevice(
    ctx: RefreshSessionContext,
    input: SessionIdInput,
) -> Result<LogoutResponse, AuthRpcError> {
    if input.session_id == ctx.session.session_id {
        return Err(AuthRpcError {
            code: "BAD_REQUEST".to_string(),
            message: "Cannot revoke current session. Use logout instead.".to_string(),
        });
    }

    let target_session = ctx
        .app_state
        .sessions
        .get_owned_session(&input.session_id, &ctx.session.user_id)
        .await?;
    let current_session = ctx
        .app_state
        .sessions
        .get_owned_session(&ctx.session.session_id, &ctx.session.user_id)
        .await?;

    if let (Some(target_session), Some(current_session)) = (&target_session, &current_session) {
        if is_grouped_client_session(target_session)
            && is_grouped_client_session(current_session)
            && target_session.client_id == current_session.client_id
        {
            return Err(AuthRpcError {
                code: "BAD_REQUEST".to_string(),
                message: "Cannot revoke current session. Use logout instead.".to_string(),
            });
        }
    }

    let revoked_session_ids = ctx
        .app_state
        .sessions
        .revoke_device(&input.session_id, &ctx.session.user_id)
        .await?;

    if !revoked_session_ids.is_empty() {
        for revoked_session_id in &revoked_session_ids {
            ctx.app_state.sync_control.publish_session_revoked(
                &ctx.session.user_id,
                revoked_session_id,
                "device_revoked",
            );
        }

        if let Some(pool) = ctx.app_state.db_pool.as_ref() {
            record_session_revocations(
                pool,
                &ctx.session.user_id,
                &revoked_session_ids,
                "device_revoked",
            )
            .await
            .map_err(|e| {
                tracing::error!(error = %e, "Failed to record session revocations");
                internal_handler_error("Failed to record session revocations")
            })?;
            query(
				"INSERT INTO audit_log (id, user_id, action, entity_type, entity_id, created_at) VALUES ($1, $2, $3, $4, $5, $6)",
			)
			.bind(format!(
				"audit_{}",
				&hash_token(&generate_opaque_session_token())[..16]
			))
			.bind(&ctx.session.user_id)
			.bind("device_revoked")
			.bind("session")
			.bind(&input.session_id)
			.bind(now_utc())
			.execute(pool)
			.await
			.map_err(|e| { tracing::error!(error = %e, "Failed to record device revoke audit event"); internal_handler_error("Failed to record device revoke audit event") })?;
        }
    }

    Ok(LogoutResponse { success: true })
}

#[allow(non_snake_case)]
#[handler(mutation)]
pub async fn renameDevice(
    ctx: RefreshSessionContext,
    input: RenameDeviceInput,
) -> Result<LogoutResponse, AuthRpcError> {
    if input.device_name.trim().is_empty() || input.device_name.len() > 100 {
        return Err(AuthRpcError {
            code: "BAD_REQUEST".to_string(),
            message: "Device name must be between 1 and 100 characters".to_string(),
        });
    }

    ctx.app_state
        .sessions
        .rename_device(
            &input.session_id,
            &ctx.session.user_id,
            input.device_name.trim(),
        )
        .await?;
    Ok(LogoutResponse { success: true })
}

#[allow(non_snake_case)]
#[handler(mutation)]
pub async fn heartbeat(ctx: RefreshSessionContext) -> Result<LogoutResponse, AuthRpcError> {
    ctx.app_state
        .sessions
        .heartbeat(&ctx.session.session_id)
        .await?;
    Ok(LogoutResponse { success: true })
}

#[allow(non_snake_case)]
#[handler(mutation)]
pub async fn logout(ctx: RefreshSessionContext) -> Result<LogoutResponse, AuthRpcError> {
    let revoked_session_ids = ctx
        .app_state
        .sessions
        .delete_session(&ctx.session.session_id)
        .await?;
    if let Some(pool) = ctx.app_state.db_pool.as_ref() {
        record_session_revocations(pool, &ctx.session.user_id, &revoked_session_ids, "logout")
            .await
            .map_err(|e| {
                tracing::error!(error = %e, "Failed to record session revocations");
                internal_handler_error("Failed to record session revocations")
            })?;
    }
    Ok(LogoutResponse { success: true })
}

#[allow(non_snake_case)]
#[handler(mutation)]
pub async fn logoutAll(ctx: RefreshSessionContext) -> Result<LogoutResponse, AuthRpcError> {
    let revoked_session_ids = ctx
        .app_state
        .sessions
        .delete_all_user_sessions(&ctx.session.user_id)
        .await?;

    if let Some(pool) = ctx.app_state.db_pool.as_ref() {
        record_session_revocations(
            pool,
            &ctx.session.user_id,
            &revoked_session_ids,
            "logout_all",
        )
        .await
        .map_err(|e| {
            tracing::error!(error = %e, "Failed to record session revocations");
            internal_handler_error("Failed to record session revocations")
        })?;
        query(
			"INSERT INTO audit_log (id, user_id, action, entity_type, entity_id, created_at) VALUES ($1, $2, $3, $4, $5, $6)",
		)
		.bind(format!(
			"audit_{}",
			&hash_token(&generate_opaque_session_token())[..16]
		))
		.bind(&ctx.session.user_id)
		.bind("logout_all")
		.bind("session")
		.bind(&ctx.session.session_id)
		.bind(now_utc())
		.execute(pool)
		.await
		.map_err(|e| { tracing::error!(error = %e, "Failed to record logout audit event"); internal_handler_error("Failed to record logout audit event") })?;
    }

    Ok(LogoutResponse { success: true })
}

#[allow(non_snake_case)]
#[handler(mutation)]
pub async fn refreshSession(
    ctx: RefreshSessionContext,
) -> Result<RefreshSessionResponse, AuthRpcError> {
    let _request = ctx.request;
    ctx.app_state.sessions.refresh_session(&ctx.session).await
}

pub fn create_auth_router() -> Router<AppState> {
    Router::new()
        .handler(registrationStatus)
        .handler(requestSignupVerification)
        .handler(verifySignupVerification)
        .handler(signup)
        .handler(signupWithInvitation)
        .handler(startLogin)
        .handler(finishLogin)
        .handler(requestRecoveryVerification)
        .handler(verifyRecoveryCode)
        .handler(getRecoveryData)
        .handler(resetPassword)
        .handler(checkEmail)
        .handler(me)
        .handler(updateEmail)
        .handler(changePassword)
        .handler(regenerateSecretKey)
        .handler(storeRecoveryKey)
        .handler(deleteAccount)
        .handler(listDevices)
        .handler(revokeDevice)
        .handler(renameDevice)
        .handler(heartbeat)
        .handler(logout)
        .handler(logoutAll)
        .handler(refreshSession)
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

fn session_duration_for_platform(platform: &str) -> Duration {
    match platform {
        "web" => Duration::hours(24),
        "extension" => Duration::days(7),
        "ios" | "android" | "mobile" | "desktop" => Duration::days(30),
        _ => Duration::days(30),
    }
}

fn normalize_session_platform(platform: Option<&str>) -> String {
    match platform.map(|value| value.trim().to_lowercase()) {
        None => "desktop".to_string(),
        Some(normalized) if normalized == "ios" || normalized == "android" => "mobile".to_string(),
        Some(normalized)
            if normalized == "web"
                || normalized == "desktop"
                || normalized == "mobile"
                || normalized == "extension" =>
        {
            normalized
        }
        Some(_) => "desktop".to_string(),
    }
}

fn normalized_session_client_id(
    _platform: Option<&str>,
    client_id: Option<String>,
) -> Option<String> {
    client_id.and_then(|value| {
        let trimmed = value.trim().to_string();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed)
        }
    })
}

fn generate_opaque_session_token() -> String {
    let mut bytes = [0_u8; 32];
    rand::rngs::OsRng.fill_bytes(&mut bytes);
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}

fn hash_token(token: &str) -> String {
    let digest = Sha256::digest(token.as_bytes());
    hex::encode(digest)
}

fn format_rfc3339(value: OffsetDateTime) -> String {
    value
        .format(&Rfc3339)
        .expect("rfc3339 formatting should succeed")
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
) -> Result<String, AuthRpcError> {
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

fn create_recovery_token(email: &str) -> Result<String, AuthRpcError> {
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
) -> Result<DbTeamInvitationAcceptRow, AuthRpcError> {
    let invitation = query_as::<_, DbTeamInvitationAcceptRow>(
		"SELECT ti.id, ti.team_id, t.name AS team_name, ti.email, ti.role::text AS role, ti.invited_by_id, ti.expires_at, t.billing_plan::text AS billing_plan, t.billing_status::text AS billing_status, ti.pending_vault_keys FROM team_invitation ti INNER JOIN team t ON ti.team_id = t.id WHERE ti.token = $1 AND ti.status = 'pending' LIMIT 1",
	)
	.bind(invitation_token)
	.fetch_optional(pool)
	.await
	.map_err(|e| { tracing::error!(error = %e, "Failed to load invitation"); internal_handler_error("Failed to load invitation") })?
	.ok_or_else(|| AuthRpcError {
		code: "NOT_FOUND".to_string(),
		message: "Invitation not found or already used".to_string(),
	})?;

    if !team_management_enabled(&invitation.billing_plan, &invitation.billing_status) {
        return Err(AuthRpcError {
            code: "FORBIDDEN".to_string(),
            message: "This team cannot accept invitations on its current plan or billing status."
                .to_string(),
        });
    }
    if invitation.expires_at < now_utc() {
        return Err(AuthRpcError {
            code: "BAD_REQUEST".to_string(),
            message: "Invitation has expired".to_string(),
        });
    }
    if normalize_email(&invitation.email) != normalized_email {
        return Err(AuthRpcError {
            code: "BAD_REQUEST".to_string(),
            message: "Email does not match invitation".to_string(),
        });
    }

    Ok(invitation)
}

async fn create_signup_verification(
    pool: &PgPool,
    email: &str,
    invitation_token: Option<&str>,
) -> Result<String, AuthRpcError> {
    let code = generate_signup_verification_code();
    let now = now_utc();
    match invitation_token {
        Some(invitation_token) => {
            query(
				"UPDATE signup_verification SET used_at = $1, updated_at = $1 WHERE email = $2 AND invitation_token = $3 AND used_at IS NULL",
			)
			.bind(now)
			.bind(email)
			.bind(invitation_token)
			.execute(pool)
			.await
			.map_err(|e| { tracing::error!(error = %e, "Failed to update signup verification"); internal_handler_error("Failed to update signup verification") })?;
        }
        None => {
            query(
				"UPDATE signup_verification SET used_at = $1, updated_at = $1 WHERE email = $2 AND invitation_token IS NULL AND used_at IS NULL",
			)
			.bind(now)
			.bind(email)
			.execute(pool)
			.await
			.map_err(|e| { tracing::error!(error = %e, "Failed to update signup verification"); internal_handler_error("Failed to update signup verification") })?;
        }
    }

    query(
		"INSERT INTO signup_verification (id, email, invitation_token, code, expires_at) VALUES ($1, $2, $3, $4, $5)",
	)
	.bind(format!("signup_verify_{}", &hash_token(&generate_opaque_session_token())[..16]))
	.bind(email)
	.bind(invitation_token)
	.bind(&code)
	.bind(now + Duration::minutes(SIGNUP_VERIFICATION_TTL_MINUTES))
	.execute(pool)
	.await
	.map_err(|e| { tracing::error!(error = %e, "Failed to create signup verification"); internal_handler_error("Failed to create signup verification") })?;

    Ok(code)
}

async fn create_recovery_verification(pool: &PgPool, email: &str) -> Result<String, AuthRpcError> {
    let code = generate_signup_verification_code();
    let now = now_utc();
    query("UPDATE recovery_verification SET used_at = $1 WHERE email = $2 AND used_at IS NULL")
        .bind(now)
        .bind(email)
        .execute(pool)
        .await
        .map_err(|e| {
            tracing::error!(error = %e, "Failed to update recovery verification");
            internal_handler_error("Failed to update recovery verification")
        })?;

    query(
        "INSERT INTO recovery_verification (id, email, code, expires_at) VALUES ($1, $2, $3, $4)",
    )
    .bind(generate_resource_id("recovery_verification"))
    .bind(email)
    .bind(&code)
    .bind(now + Duration::minutes(RECOVERY_VERIFICATION_TTL_MINUTES))
    .execute(pool)
    .await
    .map_err(|e| {
        tracing::error!(error = %e, "Failed to create recovery verification");
        internal_handler_error("Failed to create recovery verification")
    })?;

    Ok(code)
}

async fn consume_signup_verification_code(
    pool: &PgPool,
    email: &str,
    code: &str,
    invitation_token: Option<&str>,
) -> Result<bool, AuthRpcError> {
    let now = now_utc();
    let valid = match invitation_token {
		Some(invitation_token) => query_as::<_, DbSignupVerificationRow>(
			"SELECT id, email, invitation_token, code, attempts, max_attempts, expires_at, used_at, created_at FROM signup_verification WHERE email = $1 AND invitation_token = $2 AND code = $3 AND expires_at > $4 AND used_at IS NULL ORDER BY created_at DESC LIMIT 1",
		)
		.bind(email)
		.bind(invitation_token)
		.bind(code)
		.bind(now)
		.fetch_optional(pool)
		.await,
		None => query_as::<_, DbSignupVerificationRow>(
			"SELECT id, email, invitation_token, code, attempts, max_attempts, expires_at, used_at, created_at FROM signup_verification WHERE email = $1 AND invitation_token IS NULL AND code = $2 AND expires_at > $3 AND used_at IS NULL ORDER BY created_at DESC LIMIT 1",
		)
		.bind(email)
		.bind(code)
		.bind(now)
		.fetch_optional(pool)
		.await,
	}
	.map_err(|e| { tracing::error!(error = %e, "Failed to load signup verification"); internal_handler_error("Failed to load signup verification") })?;

    if let Some(valid) = valid {
        if valid.attempts >= valid.max_attempts {
            return Ok(false);
        }
        query("UPDATE signup_verification SET attempts = $1, used_at = $2, updated_at = $2 WHERE id = $3")
			.bind(valid.attempts + 1)
			.bind(now)
			.bind(valid.id)
			.execute(pool)
			.await
			.map_err(|e| { tracing::error!(error = %e, "Failed to consume signup verification"); internal_handler_error("Failed to consume signup verification") })?;
        return Ok(true);
    }

    let active = match invitation_token {
		Some(invitation_token) => query_as::<_, DbSignupVerificationRow>(
			"SELECT id, email, invitation_token, code, attempts, max_attempts, expires_at, used_at, created_at FROM signup_verification WHERE email = $1 AND invitation_token = $2 AND expires_at > $3 AND used_at IS NULL ORDER BY created_at DESC LIMIT 1",
		)
		.bind(email)
		.bind(invitation_token)
		.bind(now)
		.fetch_optional(pool)
		.await,
		None => query_as::<_, DbSignupVerificationRow>(
			"SELECT id, email, invitation_token, code, attempts, max_attempts, expires_at, used_at, created_at FROM signup_verification WHERE email = $1 AND invitation_token IS NULL AND expires_at > $2 AND used_at IS NULL ORDER BY created_at DESC LIMIT 1",
		)
		.bind(email)
		.bind(now)
		.fetch_optional(pool)
		.await,
	}
	.map_err(|e| { tracing::error!(error = %e, "Failed to load active signup verification"); internal_handler_error("Failed to load active signup verification") })?;

    if let Some(active) = active {
        let next_attempts = active.attempts + 1;
        let used_at = if next_attempts >= active.max_attempts {
            Some(now)
        } else {
            None
        };
        query(
			"UPDATE signup_verification SET attempts = $1, used_at = $2, updated_at = $3 WHERE id = $4",
		)
		.bind(next_attempts)
		.bind(used_at)
		.bind(now)
		.bind(active.id)
		.execute(pool)
		.await
		.map_err(|e| { tracing::error!(error = %e, "Failed to update signup verification attempts"); internal_handler_error("Failed to update signup verification attempts") })?;
    }

    Ok(false)
}

async fn verify_recovery_code_attempt(
    pool: &PgPool,
    email: &str,
    code: &str,
) -> Result<bool, AuthRpcError> {
    let now = now_utc();
    let valid = query_as::<_, DbRecoveryVerificationRow>(
		"SELECT id, email, code, attempts, max_attempts, expires_at, used_at, created_at FROM recovery_verification WHERE email = $1 AND code = $2 AND expires_at > $3 AND used_at IS NULL ORDER BY created_at DESC LIMIT 1",
	)
	.bind(email)
	.bind(code)
	.bind(now)
	.fetch_optional(pool)
	.await
	.map_err(|e| { tracing::error!(error = %e, "Failed to load recovery verification"); internal_handler_error("Failed to load recovery verification") })?;

    if let Some(valid) = valid {
        if valid.attempts >= valid.max_attempts {
            return Ok(false);
        }
        return Ok(true);
    }

    let active = query_as::<_, DbRecoveryVerificationRow>(
		"SELECT id, email, code, attempts, max_attempts, expires_at, used_at, created_at FROM recovery_verification WHERE email = $1 AND expires_at > $2 AND used_at IS NULL ORDER BY created_at DESC LIMIT 1",
	)
	.bind(email)
	.bind(now)
	.fetch_optional(pool)
	.await
	.map_err(|e| { tracing::error!(error = %e, "Failed to load active recovery verification"); internal_handler_error("Failed to load active recovery verification") })?;

    if let Some(active) = active {
        let next_attempts = active.attempts + 1;
        let used_at = if next_attempts >= active.max_attempts {
            Some(now)
        } else {
            None
        };
        query("UPDATE recovery_verification SET attempts = $1, used_at = $2 WHERE id = $3")
            .bind(next_attempts)
            .bind(used_at)
            .bind(active.id)
            .execute(pool)
            .await
            .map_err(|e| {
                tracing::error!(error = %e, "Failed to update recovery verification attempts");
                internal_handler_error("Failed to update recovery verification attempts")
            })?;
    }

    Ok(false)
}

async fn load_recovery_data(
    pool: &PgPool,
    email: &str,
) -> Result<Option<DbRecoveryUserDataRow>, AuthRpcError> {
    let now = now_utc();
    let active = query_scalar::<_, String>(
		"SELECT id FROM recovery_verification WHERE email = $1 AND expires_at > $2 AND used_at IS NULL ORDER BY created_at DESC LIMIT 1",
	)
	.bind(email)
	.bind(now)
	.fetch_optional(pool)
	.await
	.map_err(|e| { tracing::error!(error = %e, "Failed to load recovery session"); internal_handler_error("Failed to load recovery session") })?;
    if active.is_none() {
        return Ok(None);
    }

    let user = query_as::<_, DbRecoveryUserDataRow>(
		"SELECT id, encrypted_master_key, encrypted_private_key, secret_key_hint, recovery_key_hint FROM \"user\" WHERE LOWER(email) = $1 LIMIT 1",
	)
	.bind(email)
	.fetch_optional(pool)
	.await
	.map_err(|e| { tracing::error!(error = %e, "Failed to load recovery account"); internal_handler_error("Failed to load recovery account") })?;

    Ok(user.filter(|record| record.encrypted_master_key.is_some()))
}

async fn load_recovery_vault_keys(
    pool: &PgPool,
    user_id: &str,
) -> Result<Vec<RecoveryVaultKeyResponse>, AuthRpcError> {
    let rows = query_as::<_, DbRecoveryVaultKeyRow>(
		"SELECT vk.vault_id, vk.encrypted_vault_key, v.created_by_id FROM vault_key vk INNER JOIN vault v ON v.id = vk.vault_id WHERE vk.user_id = $1 ORDER BY vk.created_at DESC",
	)
	.bind(user_id)
	.fetch_all(pool)
	.await
	.map_err(|e| { tracing::error!(error = %e, "Failed to load recovery vault keys"); internal_handler_error("Failed to load recovery vault keys") })?;

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
    email: &str,
    input: &ResetPasswordInput,
) -> Result<(String, Vec<String>), AuthRpcError> {
    let now = now_utc();
    let mut transaction = pool.begin().await.map_err(|e| {
        tracing::error!(error = %e, "Failed to start recovery reset transaction");
        internal_handler_error("Failed to start recovery reset transaction")
    })?;

    let verification = query_as::<_, DbRecoveryVerificationRow>(
		"SELECT id, email, code, attempts, max_attempts, expires_at, used_at, created_at FROM recovery_verification WHERE email = $1 AND expires_at > $2 AND used_at IS NULL ORDER BY created_at DESC LIMIT 1",
	)
	.bind(email)
	.bind(now)
	.fetch_optional(transaction.as_mut())
	.await
	.map_err(|e| { tracing::error!(error = %e, "Failed to load recovery verification"); internal_handler_error("Failed to load recovery verification") })?
	.ok_or_else(|| unauthorized_handler_error("Invalid recovery session"))?;

    let user_id =
        query_scalar::<_, String>("SELECT id FROM \"user\" WHERE LOWER(email) = $1 LIMIT 1")
            .bind(email)
            .fetch_optional(transaction.as_mut())
            .await
            .map_err(|e| {
                tracing::error!(error = %e, "Failed to load recovery account");
                internal_handler_error("Failed to load recovery account")
            })?
            .ok_or_else(|| unauthorized_handler_error("Invalid recovery session"))?;
    let revoked_session_ids = load_user_session_ids(pool, &user_id).await.map_err(|e| {
        tracing::error!(error = %e, "Failed to load recovery sessions");
        internal_handler_error("Failed to load recovery sessions")
    })?;

    query(
		"UPDATE \"user\" SET srp_salt = $1, srp_verifier = $2, encrypted_private_key = $3, encrypted_master_key = $4, recovery_key_hint = $5, secret_key_hint = COALESCE($6, secret_key_hint) WHERE id = $7",
	)
	.bind(&input.srp_salt)
	.bind(&input.srp_verifier)
	.bind(&input.encrypted_private_key)
	.bind(&input.encrypted_master_key)
	.bind(&input.recovery_key_hint)
	.bind(input.secret_key_hint.as_deref())
	.bind(&user_id)
	.execute(transaction.as_mut())
	.await
	.map_err(|e| { tracing::error!(error = %e, "Failed to update recovery credentials"); internal_handler_error("Failed to update recovery credentials") })?;

    for vault_key in &input.encrypted_vault_keys {
        query("UPDATE vault_key SET encrypted_vault_key = $1 WHERE vault_id = $2 AND user_id = $3")
            .bind(&vault_key.encrypted_vault_key)
            .bind(&vault_key.vault_id)
            .bind(&user_id)
            .execute(transaction.as_mut())
            .await
            .map_err(|e| {
                tracing::error!(error = %e, "Failed to update recovery vault keys");
                internal_handler_error("Failed to update recovery vault keys")
            })?;
    }

    query("DELETE FROM session WHERE user_id = $1")
        .bind(&user_id)
        .execute(transaction.as_mut())
        .await
        .map_err(|e| {
            tracing::error!(error = %e, "Failed to revoke sessions after recovery");
            internal_handler_error("Failed to revoke sessions after recovery")
        })?;
    query("UPDATE recovery_verification SET used_at = $1 WHERE id = $2")
        .bind(now)
        .bind(&verification.id)
        .execute(transaction.as_mut())
        .await
        .map_err(|e| {
            tracing::error!(error = %e, "Failed to finalize recovery verification");
            internal_handler_error("Failed to finalize recovery verification")
        })?;

    transaction.commit().await.map_err(|e| {
        tracing::error!(error = %e, "Failed to commit recovery reset");
        internal_handler_error("Failed to commit recovery reset")
    })?;

    Ok((user_id, revoked_session_ids))
}

fn validate_encrypted_vault_keys(
    encrypted_vault_keys: &[EncryptedVaultKeyInput],
) -> Result<(), AuthRpcError> {
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
) -> Result<(), AuthRpcError> {
    let mut transaction = pool.begin().await.map_err(|e| {
        tracing::error!(error = %e, "Failed to start email update transaction");
        internal_handler_error("Failed to start email update transaction")
    })?;
    query(
		"UPDATE \"user\" SET email = $1, srp_salt = $2, srp_verifier = $3, encrypted_private_key = $4, encrypted_master_key = NULL, recovery_key_hint = NULL WHERE id = $5",
	)
	.bind(new_email)
	.bind(&input.srp_salt)
	.bind(&input.srp_verifier)
	.bind(&input.encrypted_private_key)
	.bind(user_id)
	.execute(transaction.as_mut())
	.await
	.map_err(|e| { tracing::error!(error = %e, "Failed to update email"); internal_handler_error("Failed to update email") })?;
    apply_encrypted_vault_key_updates(&mut transaction, user_id, &input.encrypted_vault_keys)
        .await?;
    transaction.commit().await.map_err(|e| {
        tracing::error!(error = %e, "Failed to commit email update");
        internal_handler_error("Failed to commit email update")
    })?;
    Ok(())
}

async fn update_user_password_data(
    pool: &PgPool,
    user_id: &str,
    input: &ChangePasswordInput,
) -> Result<(), AuthRpcError> {
    let mut transaction = pool.begin().await.map_err(|e| {
        tracing::error!(error = %e, "Failed to start password update transaction");
        internal_handler_error("Failed to start password update transaction")
    })?;
    query(
		"UPDATE \"user\" SET srp_salt = $1, srp_verifier = $2, encrypted_private_key = $3, encrypted_master_key = NULL, recovery_key_hint = NULL WHERE id = $4",
	)
	.bind(&input.srp_salt)
	.bind(&input.srp_verifier)
	.bind(&input.encrypted_private_key)
	.bind(user_id)
	.execute(transaction.as_mut())
	.await
	.map_err(|e| { tracing::error!(error = %e, "Failed to update password"); internal_handler_error("Failed to update password") })?;
    apply_encrypted_vault_key_updates(&mut transaction, user_id, &input.encrypted_vault_keys)
        .await?;
    transaction.commit().await.map_err(|e| {
        tracing::error!(error = %e, "Failed to commit password update");
        internal_handler_error("Failed to commit password update")
    })?;
    Ok(())
}

async fn update_user_secret_key_data(
    pool: &PgPool,
    user_id: &str,
    input: &RegenerateSecretKeyInput,
) -> Result<(), AuthRpcError> {
    let mut transaction = pool.begin().await.map_err(|e| {
        tracing::error!(error = %e, "Failed to start secret key transaction");
        internal_handler_error("Failed to start secret key transaction")
    })?;
    query(
		"UPDATE \"user\" SET secret_key_hint = $1, srp_salt = $2, srp_verifier = $3, encrypted_private_key = $4, encrypted_master_key = NULL, recovery_key_hint = NULL WHERE id = $5",
	)
	.bind(&input.secret_key_hint)
	.bind(&input.srp_salt)
	.bind(&input.srp_verifier)
	.bind(&input.encrypted_private_key)
	.bind(user_id)
	.execute(transaction.as_mut())
	.await
	.map_err(|e| { tracing::error!(error = %e, "Failed to regenerate secret key"); internal_handler_error("Failed to regenerate secret key") })?;
    apply_encrypted_vault_key_updates(&mut transaction, user_id, &input.encrypted_vault_keys)
        .await?;
    transaction.commit().await.map_err(|e| {
        tracing::error!(error = %e, "Failed to commit secret key update");
        internal_handler_error("Failed to commit secret key update")
    })?;
    Ok(())
}

async fn store_recovery_key_data(
    pool: &PgPool,
    user_id: &str,
    input: &StoreRecoveryKeyInput,
) -> Result<(), AuthRpcError> {
    query("UPDATE \"user\" SET encrypted_master_key = $1, recovery_key_hint = $2 WHERE id = $3")
        .bind(&input.encrypted_master_key)
        .bind(&input.recovery_key_hint)
        .bind(user_id)
        .execute(pool)
        .await
        .map_err(|e| {
            tracing::error!(error = %e, "Failed to store recovery key");
            internal_handler_error("Failed to store recovery key")
        })?;
    Ok(())
}

async fn delete_user_account_data(pool: &PgPool, user_id: &str) -> Result<(), AuthRpcError> {
    query("DELETE FROM \"user\" WHERE id = $1")
        .bind(user_id)
        .execute(pool)
        .await
        .map_err(|e| {
            tracing::error!(error = %e, "Failed to delete account");
            internal_handler_error("Failed to delete account")
        })?;
    Ok(())
}

async fn apply_encrypted_vault_key_updates(
    transaction: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    user_id: &str,
    encrypted_vault_keys: &[EncryptedVaultKeyInput],
) -> Result<(), AuthRpcError> {
    for vault_key in encrypted_vault_keys {
        query("UPDATE vault_key SET encrypted_vault_key = $1 WHERE vault_id = $2 AND user_id = $3")
            .bind(&vault_key.encrypted_vault_key)
            .bind(&vault_key.vault_id)
            .bind(user_id)
            .execute(&mut **transaction)
            .await
            .map_err(|e| {
                tracing::error!(error = %e, "Failed to update vault keys");
                internal_handler_error("Failed to update vault keys")
            })?;
    }
    Ok(())
}

fn send_signup_verification_code(
    email: &str,
    code: &str,
    invitation_token: Option<&str>,
) -> Result<(), AuthRpcError> {
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

fn send_recovery_code(email: &str, code: &str) -> Result<(), AuthRpcError> {
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

fn team_management_enabled(billing_plan: &str, billing_status: &str) -> bool {
    if bittery_mode() == "self-hosted" {
        return true;
    }
    matches!(billing_plan, "family" | "team") && matches!(billing_status, "active" | "trialing")
}

async fn assert_valid_signup_verification_token(
    signup_verification_token: &str,
    email: &str,
    invitation_token: Option<&str>,
) -> Result<(), AuthRpcError> {
    let Some((token_email, token_invitation)) =
        verify_signup_verification_token(signup_verification_token).await
    else {
        return Err(AuthRpcError {
            code: UNAUTHORIZED_CODE.to_string(),
            message: "Invalid signup verification".to_string(),
        });
    };
    if token_email != email || token_invitation.as_deref() != invitation_token {
        return Err(AuthRpcError {
            code: UNAUTHORIZED_CODE.to_string(),
            message: "Invalid signup verification".to_string(),
        });
    }

    Ok(())
}

async fn ensure_user_does_not_exist(pool: &PgPool, email: &str) -> Result<(), AuthRpcError> {
    let existing =
        query_scalar::<_, String>("SELECT id FROM \"user\" WHERE LOWER(email) = $1 LIMIT 1")
            .bind(email)
            .fetch_optional(pool)
            .await
            .map_err(|e| {
                tracing::error!(error = %e, "Failed to check account");
                internal_handler_error("Failed to check account")
            })?;
    if existing.is_some() {
        return Err(AuthRpcError {
            code: "BAD_REQUEST".to_string(),
            message: "Unable to create account".to_string(),
        });
    }
    Ok(())
}

async fn get_pending_signup_invitation(
    pool: &PgPool,
    invitation_token: &str,
    normalized_email: &str,
) -> Result<DbSignupInvitationRow, AuthRpcError> {
    let invitation = query_as::<_, DbSignupInvitationRow>(
		"SELECT ti.id, ti.team_id, t.name AS team_name, t.type::text AS team_type, t.image_key AS team_image_key, ti.email, ti.role::text AS role, ti.invited_by_id, ti.expires_at, t.member_limit, t.billing_plan::text AS billing_plan, t.billing_status::text AS billing_status, ti.pending_vault_keys FROM team_invitation ti INNER JOIN team t ON ti.team_id = t.id WHERE ti.token = $1 AND ti.status = 'pending' LIMIT 1",
	)
	.bind(invitation_token)
	.fetch_optional(pool)
	.await
	.map_err(|e| { tracing::error!(error = %e, "Failed to load invitation"); internal_handler_error("Failed to load invitation") })?
	.ok_or_else(|| AuthRpcError {
		code: "NOT_FOUND".to_string(),
		message: "Invitation not found or already used".to_string(),
	})?;

    if !team_management_enabled(&invitation.billing_plan, &invitation.billing_status) {
        return Err(AuthRpcError {
            code: "FORBIDDEN".to_string(),
            message: "This team cannot accept invitations on its current plan or billing status."
                .to_string(),
        });
    }
    if invitation.expires_at < now_utc() {
        return Err(AuthRpcError {
            code: "BAD_REQUEST".to_string(),
            message: "Invitation has expired".to_string(),
        });
    }
    if normalize_email(&invitation.email) != normalized_email {
        return Err(AuthRpcError {
            code: "BAD_REQUEST".to_string(),
            message: "Email does not match invitation".to_string(),
        });
    }

    Ok(invitation)
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
) -> Result<(), AuthRpcError> {
    query(
		"INSERT INTO \"user\" (id, email, name, email_verified, secret_key_hint, srp_salt, srp_verifier, public_key, encrypted_private_key, encrypted_master_key, recovery_key_hint) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)",
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
	.execute(transaction.as_mut())
	.await
	.map_err(|_| AuthRpcError {
		code: "BAD_REQUEST".to_string(),
		message: "Unable to create account".to_string(),
	})?;

    Ok(())
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
) -> Result<(), AuthRpcError> {
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
	.map_err(|e| { tracing::error!(error = %e, "Failed to create team"); internal_handler_error("Failed to create team") })?;

    Ok(())
}

async fn insert_personal_vault(
    transaction: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    vault_id: &str,
    user_id: &str,
    encrypted_vault_key: &str,
) -> Result<(), AuthRpcError> {
    query(
		"INSERT INTO vault (id, name, type, icon, created_by_id) VALUES ($1, 'Personal', 'personal'::vault_type, 'lock', $2)",
	)
	.bind(vault_id)
	.bind(user_id)
	.execute(transaction.as_mut())
	.await
	.map_err(|e| { tracing::error!(error = %e, "Failed to create personal vault"); internal_handler_error("Failed to create personal vault") })?;
    query(
		"INSERT INTO vault_key (id, vault_id, user_id, encrypted_vault_key, role) VALUES ($1, $2, $3, $4, 'owner')",
	)
	.bind(generate_resource_id("vault_key"))
	.bind(vault_id)
	.bind(user_id)
	.bind(encrypted_vault_key)
	.execute(transaction.as_mut())
	.await
	.map_err(|e| { tracing::error!(error = %e, "Failed to create personal vault key"); internal_handler_error("Failed to create personal vault key") })?;

    Ok(())
}

async fn load_auth_vault_keys(
    pool: &PgPool,
    user_id: &str,
) -> Result<Vec<AuthVaultKeyResponse>, AuthRpcError> {
    let rows = query_as::<_, DbAuthVaultKeyRow>(
		"SELECT vk.vault_id, v.name AS vault_name, v.type::text AS vault_type, v.icon AS vault_icon, v.image_key AS vault_image_key, vk.encrypted_vault_key, vk.role::text AS role FROM vault_key vk INNER JOIN vault v ON v.id = vk.vault_id WHERE vk.user_id = $1 ORDER BY v.created_at ASC",
	)
	.bind(user_id)
	.fetch_all(pool)
	.await
	.map_err(|e| { tracing::error!(error = %e, "Failed to load vault keys"); internal_handler_error("Failed to load vault keys") })?;

    Ok(rows
        .into_iter()
        .map(|row| AuthVaultKeyResponse {
            vault_id: row.vault_id,
            vault_name: row.vault_name,
            vault_type: row.vault_type,
            vault_icon: row.vault_icon,
            vault_image_url: row.vault_image_key.map(storage_public_url),
            encrypted_vault_key: row.encrypted_vault_key,
            role: row.role,
        })
        .collect())
}

fn normalize_signup_plan(plan: Option<&str>) -> Result<&'static str, AuthRpcError> {
    match plan.map(|value| value.trim().to_ascii_lowercase()) {
        None => Ok("personal"),
        Some(value) if value == "free" => Ok("free"),
        Some(value) if value == "personal" => Ok("personal"),
        Some(value) if value == "family" => Ok("family"),
        Some(value) if value == "team" => Ok("team"),
        _ => Err(AuthRpcError {
            code: "BAD_REQUEST".to_string(),
            message: "Invalid plan".to_string(),
        }),
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

fn validate_signup_input(input: &SignupInput) -> Result<(), AuthRpcError> {
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
) -> Result<(), AuthRpcError> {
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

fn validate_resource_id(value: &str) -> Result<(), AuthRpcError> {
    let regex = Regex::new(
		r"^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|[A-Za-z0-9_-]{10,64})$",
	)
	.expect("resource id regex should be valid");
    if value.len() <= 64 && regex.is_match(value) {
        Ok(())
    } else {
        Err(bad_request_handler_error("Invalid resource ID"))
    }
}

fn validate_hex_string(value: &str, message: &str) -> Result<(), AuthRpcError> {
    if value.is_empty()
        || value.len() % 2 != 0
        || !value.chars().all(|character| character.is_ascii_hexdigit())
    {
        return Err(bad_request_handler_error(message));
    }
    Ok(())
}

fn validate_login_attempt_id(value: &str) -> Result<(), AuthRpcError> {
    let regex = Regex::new(r"^[a-f0-9]{64}:[A-Za-z0-9_-]{10,64}$")
        .expect("login attempt id regex should be valid");
    if regex.is_match(value) {
        Ok(())
    } else {
        Err(bad_request_handler_error("Invalid login attempt ID"))
    }
}

fn validate_token(token: &str) -> Result<(), AuthRpcError> {
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
) -> Result<Vec<PendingVaultKeyEntry>, AuthRpcError> {
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
) -> Result<(), AuthRpcError> {
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
        internal_handler_error("Failed to validate pendingVaultKeys vaults")
    })?;
    if team_vault_count != vault_ids.len() as i64 {
        return Err(bad_request_handler_error(
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
	.map_err(|e| { tracing::error!(error = %e, "Failed to validate inviter vault access"); internal_handler_error("Failed to validate inviter vault access") })?;
    let authorized_vault_ids: std::collections::HashSet<String> = authorized_roles
        .into_iter()
        .filter(|record| record.role == "owner" || record.role == "admin")
        .map(|record| record.vault_id)
        .collect();
    if authorized_vault_ids.len() != vault_ids.len() {
        return Err(AuthRpcError {
            code: "FORBIDDEN".to_string(),
            message: "You do not have permission to grant access for one or more vaults"
                .to_string(),
        });
    }
    Ok(())
}

fn storage_public_url(key: String) -> String {
    storage::public_url(key)
}

fn snapshot_from_db_session(row: DbSessionRecord) -> SessionSnapshot {
    SessionSnapshot {
        id: row.id,
        user_id: row.user_id,
        expires_at: row.expires_at,
        created_at: row.created_at,
        last_active_at: row.last_active_at,
        platform: normalize_session_platform(row.platform.as_deref()),
        client_id: normalized_session_client_id(row.platform.as_deref(), row.client_id),
        device_name: row.device_name,
        ip_address: row.ip_address,
        browser_name: row.browser_name,
        browser_version: row.browser_version,
        os_name: row.os_name,
        os_version: row.os_version,
    }
}

fn snapshot_from_memory_session(record: SessionRecord) -> SessionSnapshot {
    SessionSnapshot {
        id: record.session_id,
        user_id: record.user_id,
        expires_at: record.expires_at,
        created_at: record.created_at,
        last_active_at: record.last_active_at,
        platform: record.platform,
        client_id: record.client_id,
        device_name: record.device_name,
        ip_address: record.ip_address,
        browser_name: record.browser_name,
        browser_version: record.browser_version,
        os_name: record.os_name,
        os_version: record.os_version,
    }
}

fn build_device_session_responses(
    sessions: Vec<SessionSnapshot>,
    current_session_id: &str,
) -> Vec<DeviceSessionResponse> {
    let mut logical_sessions = Vec::new();
    let mut grouped_sessions = HashMap::<(String, String), Vec<SessionSnapshot>>::new();

    for session in sessions {
        if is_grouped_client_session(&session) {
            let client_id = session
                .client_id
                .clone()
                .expect("grouped session has client id");
            grouped_sessions
                .entry((session.platform.clone(), client_id))
                .or_default()
                .push(session);
        } else {
            logical_sessions.push(session);
        }
    }

    for group in grouped_sessions.values() {
        let representative = group
            .iter()
            .find(|candidate| candidate.id == current_session_id)
            .cloned()
            .or_else(|| {
                let mut sorted = group.clone();
                sorted.sort_by(compare_session_recency);
                sorted.into_iter().next()
            });

        if let Some(representative) = representative {
            logical_sessions.push(representative);
        }
    }

    logical_sessions.sort_by(compare_session_recency);
    logical_sessions
        .into_iter()
        .map(|session| DeviceSessionResponse {
            id: session.id.clone(),
            device_name: session.device_name,
            platform: session.platform,
            browser_name: session.browser_name,
            browser_version: session.browser_version,
            os_name: session.os_name,
            os_version: session.os_version,
            ip_address: session.ip_address,
            last_active_at: format_rfc3339(session.last_active_at),
            created_at: format_rfc3339(session.created_at),
            is_current_session: session.id == current_session_id,
        })
        .collect()
}

fn is_grouped_client_session(value: &SessionSnapshot) -> bool {
    value.client_id.is_some()
}

fn compare_session_recency(left: &SessionSnapshot, right: &SessionSnapshot) -> std::cmp::Ordering {
    right
        .last_active_at
        .cmp(&left.last_active_at)
        .then_with(|| right.created_at.cmp(&left.created_at))
        .then_with(|| right.id.cmp(&left.id))
}

async fn has_any_registered_user(pool: &PgPool) -> Result<bool, AuthRpcError> {
    let user_id = query_scalar::<_, String>("SELECT id FROM \"user\" LIMIT 1")
        .fetch_optional(pool)
        .await
        .map_err(|e| {
            tracing::error!(error = %e, "Failed to load registration status");
            internal_handler_error("Failed to load registration status")
        })?;
    Ok(user_id.is_some())
}

fn now_utc() -> OffsetDateTime {
    OffsetDateTime::now_utc()
}

fn unauthorized_error(message: &str) -> RpcError {
    RpcError {
        code: ErrorCode::ServerError(401),
        message: message.to_string(),
        data: Some(json!({ "code": UNAUTHORIZED_CODE })),
    }
}

fn handler_unauthorized_error(message: &str) -> AuthRpcError {
    AuthRpcError {
        code: UNAUTHORIZED_CODE.to_string(),
        message: message.to_string(),
    }
}

fn internal_handler_error(message: &str) -> AuthRpcError {
    AuthRpcError {
        code: "INTERNAL_SERVER_ERROR".to_string(),
        message: message.to_string(),
    }
}

fn unauthorized_handler_error(message: &str) -> AuthRpcError {
    AuthRpcError {
        code: UNAUTHORIZED_CODE.to_string(),
        message: message.to_string(),
    }
}

fn bad_request_handler_error(message: &str) -> AuthRpcError {
    AuthRpcError {
        code: "BAD_REQUEST".to_string(),
        message: message.to_string(),
    }
}

fn db_pool(app_state: &AppState) -> Result<&PgPool, AuthRpcError> {
    load_db_pool(app_state, internal_handler_error)
}

fn generate_resource_id(prefix: &str) -> String {
    format!("{prefix}_{:016x}", random::<u64>())
}

fn session_expiry_header_name() -> HeaderName {
    HeaderName::from_static(SESSION_EXPIRY_HEADER)
}

impl From<AuthRpcError> for RpcError {
    fn from(value: AuthRpcError) -> Self {
        let rpc_code = match value.code.as_str() {
            UNAUTHORIZED_CODE => ErrorCode::ServerError(401),
            "BAD_REQUEST" => ErrorCode::InvalidParams,
            "FORBIDDEN" => ErrorCode::ServerError(403),
            "NOT_FOUND" => ErrorCode::ServerError(404),
            _ => ErrorCode::InternalError,
        };

        RpcError {
            code: rpc_code,
            message: value.message,
            data: Some(json!({ "code": value.code })),
        }
    }
}

impl IntoResponse for AuthRpcError {
    type Output = <RpcError as IntoResponse>::Output;

    fn into_response(self) -> jsonrpsee::ResponsePayload<'static, Self::Output> {
        RpcError::from(self).into_response()
    }
}

// ---------------------------------------------------------------------------
// User-Agent parsing (mirrors packages/device/src/index.ts)
// ---------------------------------------------------------------------------

struct ParsedDeviceInfo {
    device_name: String,
    browser_name: Option<String>,
    browser_version: Option<String>,
    os_name: Option<String>,
    os_version: Option<String>,
}

fn parse_user_agent(user_agent: &str, app_platform: Option<&str>) -> ParsedDeviceInfo {
    let ua = user_agent.to_ascii_lowercase();

    let (os_name, os_version) = detect_os(user_agent, &ua);
    let (browser_name, browser_version) = detect_browser(user_agent, &ua);
    let platform = detect_platform(&ua, app_platform);

    let device_name = build_device_name(
        &platform,
        os_name.as_deref(),
        os_version.as_deref(),
        browser_name.as_deref(),
    );

    ParsedDeviceInfo {
        device_name,
        browser_name,
        browser_version,
        os_name,
        os_version,
    }
}

fn detect_os(user_agent: &str, ua: &str) -> (Option<String>, Option<String>) {
    if ua.contains("iphone") || ua.contains("ipad") {
        let os_name = if ua.contains("ipad") { "iPadOS" } else { "iOS" };
        let re = Regex::new(r"(?i)OS (\d+[._]\d+(?:[._]\d+)?)").unwrap();
        let version = re
            .captures(user_agent)
            .and_then(|c| c.get(1))
            .map(|m| m.as_str().replace('_', "."));
        return (Some(os_name.to_string()), version);
    }
    if ua.contains("windows") {
        let re = Regex::new(r"(?i)Windows NT (\d+\.?\d*)").unwrap();
        let version = re
            .captures(user_agent)
            .and_then(|c| c.get(1))
            .map(|m| match m.as_str() {
                "10.0" => "10/11".to_string(),
                "6.3" => "8.1".to_string(),
                "6.2" => "8".to_string(),
                "6.1" => "7".to_string(),
                "6.0" => "Vista".to_string(),
                "5.1" => "XP".to_string(),
                other => other.to_string(),
            });
        return (Some("Windows".to_string()), version);
    }
    if ua.contains("mac os x") || ua.contains("macos") {
        let re = Regex::new(r"(?i)Mac OS X (\d+[._]\d+(?:[._]\d+)?)").unwrap();
        let version = re
            .captures(user_agent)
            .and_then(|c| c.get(1))
            .map(|m| m.as_str().replace('_', "."));
        return (Some("macOS".to_string()), version);
    }
    if ua.contains("android") {
        let re = Regex::new(r"(?i)Android (\d+\.?\d*\.?\d*)").unwrap();
        let version = re
            .captures(user_agent)
            .and_then(|c| c.get(1))
            .map(|m| m.as_str().to_string());
        return (Some("Android".to_string()), version);
    }
    if ua.contains("linux") {
        return (Some("Linux".to_string()), None);
    }
    if ua.contains("cros") {
        return (Some("Chrome OS".to_string()), None);
    }
    (None, None)
}

fn detect_browser(user_agent: &str, ua: &str) -> (Option<String>, Option<String>) {
    if ua.contains("edg/") {
        let re = Regex::new(r"(?i)Edg/(\d+\.?\d*\.?\d*)").unwrap();
        let ver = re
            .captures(user_agent)
            .and_then(|c| c.get(1))
            .map(|m| m.as_str().to_string());
        return (Some("Edge".to_string()), ver);
    }
    if ua.contains("opr/") || ua.contains("opera") {
        let re = Regex::new(r"(?i)(?:OPR|Opera)/(\d+\.?\d*\.?\d*)").unwrap();
        let ver = re
            .captures(user_agent)
            .and_then(|c| c.get(1))
            .map(|m| m.as_str().to_string());
        return (Some("Opera".to_string()), ver);
    }
    if ua.contains("brave") {
        let re = Regex::new(r"(?i)Brave/(\d+\.?\d*\.?\d*)").unwrap();
        let ver = re
            .captures(user_agent)
            .and_then(|c| c.get(1))
            .map(|m| m.as_str().to_string());
        return (Some("Brave".to_string()), ver);
    }
    if ua.contains("vivaldi") {
        let re = Regex::new(r"(?i)Vivaldi/(\d+\.?\d*\.?\d*)").unwrap();
        let ver = re
            .captures(user_agent)
            .and_then(|c| c.get(1))
            .map(|m| m.as_str().to_string());
        return (Some("Vivaldi".to_string()), ver);
    }
    if ua.contains("firefox") || ua.contains("fxios") {
        let re = Regex::new(r"(?i)(?:Firefox|FxiOS)/(\d+\.?\d*\.?\d*)").unwrap();
        let ver = re
            .captures(user_agent)
            .and_then(|c| c.get(1))
            .map(|m| m.as_str().to_string());
        return (Some("Firefox".to_string()), ver);
    }
    if ua.contains("safari") && !ua.contains("chrome") && !ua.contains("chromium") {
        let re = Regex::new(r"(?i)Version/(\d+\.?\d*\.?\d*)").unwrap();
        let ver = re
            .captures(user_agent)
            .and_then(|c| c.get(1))
            .map(|m| m.as_str().to_string());
        return (Some("Safari".to_string()), ver);
    }
    if ua.contains("chrome") || ua.contains("crios") {
        let re = Regex::new(r"(?i)(?:Chrome|CriOS)/(\d+\.?\d*\.?\d*)").unwrap();
        let ver = re
            .captures(user_agent)
            .and_then(|c| c.get(1))
            .map(|m| m.as_str().to_string());
        return (Some("Chrome".to_string()), ver);
    }
    (None, None)
}

fn detect_platform(ua: &str, app_platform: Option<&str>) -> String {
    match app_platform {
        Some("desktop") => return "desktop".to_string(),
        Some("ios") => return "ios".to_string(),
        Some("android") => return "android".to_string(),
        Some("extension") => return "extension".to_string(),
        _ => {}
    }
    if ua.contains("iphone") || ua.contains("ipad") || (ua.contains("ios") && ua.contains("mobile"))
    {
        return "ios".to_string();
    }
    if ua.contains("android") {
        return "android".to_string();
    }
    "web".to_string()
}

fn build_device_name(
    platform: &str,
    os_name: Option<&str>,
    os_version: Option<&str>,
    browser_name: Option<&str>,
) -> String {
    match platform {
        "desktop" => {
            if let Some(os) = os_name {
                format!("Bittery Desktop on {os}")
            } else {
                "Bittery Desktop".to_string()
            }
        }
        "extension" => {
            let browser_label = browser_name.unwrap_or("Browser");
            let os_label = os_name.map(|os| format!(" on {os}")).unwrap_or_default();
            format!("Bittery Extension ({browser_label}{os_label})")
        }
        "ios" => {
            let os_label = os_name.unwrap_or("iOS");
            if let Some(ver) = os_version {
                format!("Bittery on {os_label} {ver}")
            } else {
                format!("Bittery on {os_label}")
            }
        }
        "android" => {
            let os_label = if let Some(ver) = os_version {
                format!("Android {ver}")
            } else {
                "Android".to_string()
            };
            format!("Bittery on {os_label}")
        }
        _ => {
            let mut parts = Vec::new();
            if let Some(browser) = browser_name {
                parts.push(browser.to_string());
            }
            if let Some(os) = os_name {
                parts.push(format!("on {os}"));
            }
            if parts.is_empty() {
                "Unknown Device".to_string()
            } else {
                parts.join(" ")
            }
        }
    }
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
        build_device_name, detect_platform, deterministic_fake_hint, header_value, normalize_email,
        normalize_session_platform, normalize_signup_plan, normalized_session_client_id, now_utc,
        parse_bearer_token, parse_pending_vault_keys, plan_member_limit,
        session_duration_for_platform, signup_team_name, validate_hex_string,
        validate_login_attempt_id, validate_resource_id, validate_token, RequestMetadata,
        SessionBackend, SessionService,
    };
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

    #[test]
    fn session_platform_helpers_normalize_inputs_and_web_client_ids() {
        assert_eq!(normalize_session_platform(None), "desktop");
        assert_eq!(normalize_session_platform(Some(" web ")), "web");
        assert_eq!(normalize_session_platform(Some(" iOS ")), "mobile");
        assert_eq!(normalize_session_platform(Some("unknown")), "desktop");

        assert_eq!(session_duration_for_platform("web"), Duration::hours(24));
        assert_eq!(
            session_duration_for_platform("extension"),
            Duration::days(7)
        );
        assert_eq!(session_duration_for_platform("desktop"), Duration::days(30));

        assert_eq!(
            normalized_session_client_id(Some("web"), Some(" browser-1 ".to_string())).as_deref(),
            Some("browser-1"),
        );
        assert_eq!(
            normalized_session_client_id(Some("desktop"), Some("desktop-client".to_string())),
            Some("desktop-client".to_string()),
        );
        assert_eq!(
            normalized_session_client_id(Some("web"), Some("   ".to_string())),
            None,
        );
    }

    #[test]
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
    fn device_helpers_prefer_explicit_platform_and_build_expected_labels() {
        assert_eq!(
            detect_platform("mozilla/5.0 (iphone)", Some("extension")),
            "extension"
        );
        assert_eq!(detect_platform("mozilla/5.0 (iphone)", None), "ios");
        assert_eq!(detect_platform("mozilla/5.0 (android)", None), "android");
        assert_eq!(detect_platform("mozilla/5.0 (macintosh)", None), "web");

        assert_eq!(
            build_device_name("extension", Some("macOS"), None, Some("Safari")),
            "Bittery Extension (Safari on macOS)",
        );
        assert_eq!(
            build_device_name("ios", Some("iOS"), Some("17.5"), None),
            "Bittery on iOS 17.5",
        );
        assert_eq!(
            build_device_name("web", Some("Windows"), None, Some("Chrome")),
            "Chrome on Windows",
        );
        assert_eq!(build_device_name("web", None, None, None), "Unknown Device");
    }

    #[tokio::test]
    async fn refresh_rotates_the_previous_session() {
        let sessions = SessionService::default();
        let seeded = sessions
            .seeded_session()
            .expect("memory backend should seed");
        let current = sessions
            .verify_token(&seeded.token)
            .await
            .expect("seeded session should be valid");

        let next = sessions
            .refresh_session(&current)
            .await
            .expect("refresh should succeed");

        assert_ne!(next.session_id, seeded.session_id);
        assert!(sessions.verify_token(&seeded.token).await.is_none());
        assert!(sessions.verify_token(&next.token).await.is_some());
    }

    #[tokio::test]
    async fn refresh_preserves_platform_duration_policy() {
        let sessions = SessionService::default();
        let current = sessions
            .issue_session_for_tests("extension-user", "extension", Some("extension-client"))
            .await;

        let next = sessions
            .refresh_session(&current)
            .await
            .expect("refresh should succeed");
        let refreshed = sessions
            .verify_token(&next.token)
            .await
            .expect("refreshed token should remain valid");

        assert_eq!(refreshed.platform, "extension");
        assert_eq!(refreshed.client_id.as_deref(), Some("extension-client"));

        let remaining_days = (refreshed.expires_at - time::OffsetDateTime::now_utc()).whole_days();
        assert!(remaining_days >= 6);
        assert!(remaining_days <= 7);
    }

    #[tokio::test]
    async fn expired_sessions_cannot_be_refreshed() {
        let sessions = SessionService::default();
        let mut expired = sessions
            .issue_session_for_tests("expired-user", "desktop", None)
            .await;
        expired.expires_at = time::OffsetDateTime::now_utc() - time::Duration::minutes(1);

        let error = sessions
            .refresh_session(&expired)
            .await
            .expect_err("expired session should fail");

        assert_eq!(error.message, "Session expired");
    }

    #[tokio::test]
    async fn delete_session_removes_only_the_target_session() {
        let sessions = SessionService::default();
        let seeded = sessions
            .seeded_session()
            .expect("memory backend should seed");
        let other = sessions
            .issue_session_for_tests("dev-user", "desktop", None)
            .await;

        sessions
            .delete_session(&seeded.session_id)
            .await
            .expect("delete_session should succeed");

        assert!(sessions.verify_token(&seeded.token).await.is_none());
        assert!(sessions.verify_token(&other.token).await.is_some());
    }

    #[tokio::test]
    async fn delete_all_user_sessions_keeps_other_users_signed_in() {
        let sessions = SessionService::default();
        let target = sessions
            .issue_session_for_tests("target-user", "desktop", None)
            .await;
        let other = sessions
            .issue_session_for_tests("other-user", "desktop", None)
            .await;

        sessions
            .delete_all_user_sessions("target-user")
            .await
            .expect("delete_all_user_sessions should succeed");

        assert!(sessions.verify_token(&target.token).await.is_none());
        assert!(sessions.verify_token(&other.token).await.is_some());
    }

    #[test]
    fn fake_hint_is_case_insensitive() {
        let lower = deterministic_fake_hint("case-test@example.com");
        let upper = deterministic_fake_hint("CASE-TEST@EXAMPLE.COM");

        assert_eq!(lower, upper);
        assert!(lower.starts_with("A3-"));
        assert_eq!(lower.len(), 11);
    }

    #[tokio::test]
    async fn list_devices_collapses_grouped_web_sessions() {
        let sessions = SessionService::default();
        let current = sessions
            .issue_session_for_tests("user-a", "desktop", None)
            .await;
        let web_a = sessions
            .issue_session_for_tests("user-a", "web", Some("web-group"))
            .await;
        let web_b = sessions
            .issue_session_for_tests("user-a", "web", Some("web-group"))
            .await;

        if let SessionBackend::Memory(inner) = &sessions.backend {
            let mut records = inner
                .sessions_by_token
                .write()
                .expect("memory session store should be writable");
            for record in records.values_mut() {
                if record.session_id == web_a.session_id {
                    record.last_active_at = OffsetDateTime::now_utc() - Duration::days(2);
                }
                if record.session_id == web_b.session_id {
                    record.last_active_at = OffsetDateTime::now_utc() - Duration::days(1);
                }
            }
        }

        let devices = sessions
            .list_devices("user-a", &current.session_id)
            .await
            .expect("list_devices should succeed");

        let web_ids = devices
            .iter()
            .filter(|device| device.platform == "web")
            .map(|device| device.id.clone())
            .collect::<Vec<_>>();

        assert_eq!(web_ids, vec![web_b.session_id]);
        assert!(devices
            .iter()
            .any(|device| device.id == current.session_id && device.is_current_session));
    }

    #[tokio::test]
    async fn create_session_reuses_existing_desktop_client_id() {
        let sessions = SessionService::default();
        let request = RequestMetadata {
            auth_token: None,
            client_id: Some("desktop-device-1".to_string()),
            app_platform: Some("desktop".to_string()),
            user_agent: Some("integration-test".to_string()),
            ip_address: Some("127.0.0.1".to_string()),
        };

        let first = sessions
            .create_session("user-desktop", &request)
            .await
            .expect("first session should be created");
        let second = sessions
            .create_session("user-desktop", &request)
            .await
            .expect("second session should be created");

        assert!(sessions.verify_token(&first.token).await.is_none());
        assert!(sessions.verify_token(&second.token).await.is_some());

        let devices = sessions
            .list_devices("user-desktop", &second.session_id)
            .await
            .expect("list_devices should succeed");

        assert_eq!(devices.len(), 1);
        assert_eq!(devices[0].id, second.session_id);
        assert_eq!(devices[0].platform, "desktop");
        assert!(devices[0].is_current_session);
    }

    #[tokio::test]
    async fn rename_device_updates_active_grouped_web_sessions() {
        let sessions = SessionService::default();
        let grouped_a = sessions
            .issue_session_for_tests("user-b", "web", Some("rename-group"))
            .await;
        let grouped_b = sessions
            .issue_session_for_tests("user-b", "web", Some("rename-group"))
            .await;

        sessions
            .rename_device(&grouped_a.session_id, "user-b", "Unified Browser")
            .await
            .expect("rename_device should succeed");

        let devices = sessions
            .list_devices("user-b", &grouped_a.session_id)
            .await
            .expect("list_devices should succeed");

        assert!(devices
            .iter()
            .filter(|device| device.platform == "web")
            .all(|device| device.device_name.as_deref() == Some("Unified Browser")));
        assert!(sessions.verify_token(&grouped_b.token).await.is_some());
    }

    #[tokio::test]
    async fn revoke_device_revokes_grouped_web_sessions() {
        let sessions = SessionService::default();
        let grouped_a = sessions
            .issue_session_for_tests("user-c", "web", Some("revoke-group"))
            .await;
        let grouped_b = sessions
            .issue_session_for_tests("user-c", "web", Some("revoke-group"))
            .await;

        let revoked = sessions
            .revoke_device(&grouped_a.session_id, "user-c")
            .await
            .expect("revoke_device should succeed");

        assert_eq!(revoked.len(), 2);
        assert!(sessions.verify_token(&grouped_a.token).await.is_none());
        assert!(sessions.verify_token(&grouped_b.token).await.is_none());
    }

    #[tokio::test]
    async fn heartbeat_updates_last_active_timestamp() {
        let sessions = SessionService::default();
        let current = sessions
            .issue_session_for_tests("user-d", "desktop", None)
            .await;
        let before = sessions
            .list_devices("user-d", &current.session_id)
            .await
            .expect("list_devices should succeed")
            .into_iter()
            .find(|device| device.id == current.session_id)
            .expect("current device should exist")
            .last_active_at;

        sessions
            .heartbeat(&current.session_id)
            .await
            .expect("heartbeat should succeed");

        let after = sessions
            .list_devices("user-d", &current.session_id)
            .await
            .expect("list_devices should succeed")
            .into_iter()
            .find(|device| device.id == current.session_id)
            .expect("current device should exist")
            .last_active_at;

        assert!(after >= before);
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
