#[cfg(test)]
use bittery_crypto_core::normalize_email;
use jsonwebtoken::{encode, Algorithm, EncodingKey, Header};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use time::OffsetDateTime;

use crate::{
    db::enums::{TeamRole, TeamType, VaultRole, VaultType},
    error::AppError,
    services::{
        rate_limit::{self, rate_limited_error, RateLimiter, WindowLimit},
        session::{format_rfc3339, RequestMetadata},
        validate_resource_id,
    },
    shapes::{me_shape, reset_password_shape},
};

const JWT_ISSUER: &str = "bittery";
const CURRENT_KDF_SCHEMA_VERSION: u32 = 1;
const CURRENT_KDF_ALGORITHM: &str = "pbkdf2-sha256";
const CURRENT_KDF_ITERATIONS: u32 = 600_000;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RegistrationStatusResponse {
    pub mode: String,
    pub billing_enabled: bool,
    pub allow_public_signup: bool,
    pub requires_email_verification: bool,
    pub reason: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckEmailInput {
    pub email: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
#[serde(deny_unknown_fields)]
pub struct RequestSignupVerificationInput {
    pub email: String,
    pub invitation_token: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
#[serde(deny_unknown_fields)]
pub struct VerifySignupVerificationInput {
    pub email: String,
    pub code: String,
    pub invitation_token: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckEmailResponse {
    pub exists: bool,
    pub secret_key_hint: String,
}

me_shape!(service_struct {
    #[derive(Debug, Clone, Serialize)]
    #[serde(rename_all = "camelCase")]
    pub struct MeResponse
});

#[derive(Debug, Clone, Serialize)]
pub struct LogoutResponse {
    pub success: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VerifySignupVerificationResponse {
    pub success: bool,
    pub signup_verification_token: Option<String>,
}

/// KDF parameters the client derived its SRP verifier with.
///
/// The salt is transported separately as `srp_salt`; these fields describe the
/// algorithm/work factor so login can be reproduced and so verifier-producing
/// API requests can enforce the exact current server profile.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
#[serde(deny_unknown_fields)]
pub struct KdfParamsInput {
    pub schema_version: u32,
    pub algorithm: String,
    pub iterations: u32,
}

/// A client profile accepted for persistence by a verifier-producing request.
///
/// This is deliberately stricter than the client-side profile window: while
/// clients may validate a bounded future work factor, the server persists one
/// exact profile so known and unknown `startLogin` responses remain
/// indistinguishable. Introducing another stored profile requires a
/// deterministic decoy/negotiation design before deployment.
#[derive(Debug, Clone, Copy)]
pub(crate) struct ValidatedKdfProfile {
    pub(crate) schema_version: i32,
    pub(crate) algorithm: &'static str,
    pub(crate) iterations: i32,
}

impl TryFrom<&KdfParamsInput> for ValidatedKdfProfile {
    type Error = AppError;

    fn try_from(params: &KdfParamsInput) -> Result<Self, Self::Error> {
        if params.schema_version != CURRENT_KDF_SCHEMA_VERSION
            || params.algorithm != CURRENT_KDF_ALGORITHM
            || params.iterations != CURRENT_KDF_ITERATIONS
        {
            return Err(bad_request_handler_error("Invalid KDF parameters"));
        }

        Ok(Self {
            schema_version: CURRENT_KDF_SCHEMA_VERSION as i32,
            algorithm: CURRENT_KDF_ALGORITHM,
            iterations: CURRENT_KDF_ITERATIONS as i32,
        })
    }
}

#[derive(Debug, Clone, Deserialize, Serialize)]
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
    pub kdf_params: KdfParamsInput,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
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
    pub kdf_params: KdfParamsInput,
}

#[derive(Debug, Clone, Serialize)]
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
    pub team_type: Option<TeamType>,
    pub team_avatar_url: Option<String>,
    pub role: TeamRole,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthVaultKeyResponse {
    pub vault_id: String,
    pub vault_name: String,
    pub vault_type: VaultType,
    pub vault_icon: Option<String>,
    pub vault_image_url: Option<String>,
    pub encrypted_vault_key: String,
    pub role: VaultRole,
    #[serde(skip)]
    pub created_at: OffsetDateTime,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthVaultKeyPage {
    pub items: Vec<AuthVaultKeyResponse>,
    pub has_more: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SignupResponse {
    pub success: bool,
    pub user_id: String,
    pub token: String,
    pub session_id: String,
    pub expires_at: String,
    pub user: AuthSessionUserResponse,
    pub vault_keys: AuthVaultKeyPage,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
#[serde(deny_unknown_fields)]
pub struct StartLoginInput {
    pub email: String,
    pub client_public_key: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
#[serde(deny_unknown_fields)]
pub struct FinishLoginInput {
    pub attempt_id: String,
    pub client_public_key: String,
    pub client_proof: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoginKdfParamsResponse {
    pub schema_version: u32,
    pub algorithm: String,
    pub iterations: u32,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StartLoginResponse {
    pub attempt_id: String,
    pub salt: String,
    pub server_public_key: String,
    pub kdf_params: LoginKdfParamsResponse,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoginUserResponse {
    pub id: String,
    pub email: String,
    pub name: String,
    pub secret_key_hint: String,
    pub public_key: String,
    pub encrypted_private_key: String,
    /// The badge account metadata is written from. Every user has a team, so this is absent
    /// only for a row with no team at all — never as a function of the team's billing plan.
    pub team_name: Option<String>,
    pub team_avatar_url: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FinishLoginResponse {
    pub token: String,
    pub session_id: String,
    pub expires_at: String,
    pub server_proof: String,
    pub user: LoginUserResponse,
    pub vault_keys: AuthVaultKeyPage,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
#[serde(deny_unknown_fields)]
pub struct RequestRecoveryVerificationInput {
    pub email: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
#[serde(deny_unknown_fields)]
pub struct VerifyRecoveryCodeInput {
    pub email: String,
    pub code: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VerifyRecoveryCodeResponse {
    pub success: bool,
    pub recovery_token: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
#[serde(deny_unknown_fields)]
pub struct GetRecoveryDataInput {
    pub recovery_token: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecoveryVaultKeyResponse {
    pub vault_id: String,
    pub encrypted_vault_key: String,
    pub created_by_id: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GetRecoveryDataResponse {
    pub user_id: String,
    pub encrypted_master_key: String,
    pub encrypted_private_key: String,
    pub secret_key_hint: Option<String>,
    pub recovery_key_hint: Option<String>,
    pub vault_keys: Vec<RecoveryVaultKeyResponse>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EncryptedVaultKeyInput {
    pub vault_id: String,
    pub encrypted_vault_key: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
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
    pub kdf_params: KdfParamsInput,
}

reset_password_shape!(service_struct {
    #[derive(Debug, Clone, Serialize)]
    #[serde(rename_all = "camelCase")]
    pub struct ResetPasswordResponse
});

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
#[serde(deny_unknown_fields)]
pub struct UpdateEmailInput {
    pub new_email: String,
    pub srp_salt: String,
    pub srp_verifier: String,
    pub encrypted_private_key: String,
    pub encrypted_vault_keys: Vec<EncryptedVaultKeyInput>,
    pub kdf_params: KdfParamsInput,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
#[serde(deny_unknown_fields)]
pub struct ChangePasswordInput {
    pub srp_salt: String,
    pub srp_verifier: String,
    pub encrypted_private_key: String,
    pub encrypted_vault_keys: Vec<EncryptedVaultKeyInput>,
    pub kdf_params: KdfParamsInput,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
#[serde(deny_unknown_fields)]
pub struct RegenerateSecretKeyInput {
    pub secret_key_hint: String,
    pub srp_salt: String,
    pub srp_verifier: String,
    pub encrypted_private_key: String,
    pub encrypted_vault_keys: Vec<EncryptedVaultKeyInput>,
    pub kdf_params: KdfParamsInput,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
#[serde(deny_unknown_fields)]
pub struct StoreRecoveryKeyInput {
    pub encrypted_master_key: String,
    pub recovery_key_hint: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
#[serde(deny_unknown_fields)]
pub struct DeleteAccountInput {
    pub confirm_email: String,
}

mod credentials;
mod devices;
mod login;
mod recovery;
mod registration;
mod request_context;

#[cfg(test)]
use crate::services::team::parse_pending_vault_keys;
#[cfg(test)]
use bittery_crypto_core::srp6a::{HashAlgorithm, PrimeGroup};
#[cfg(test)]
use credentials::validate_encrypted_vault_keys;
pub(crate) use credentials::{
    change_password, delete_account, regenerate_secret_key, store_recovery_key, update_email,
};
pub(crate) use devices::{do_refresh_session, get_me, list_devices, rename_device, revoke_device};
#[cfg(test)]
use login::validate_login_attempt_id;
pub(crate) use login::{
    finish_login, load_auth_vault_keys_page, start_login, verify_login_proof_for_user,
};
pub(crate) use recovery::{
    get_recovery_data, request_recovery_verification, reset_password, verify_recovery_code,
};
pub(crate) use registration::{
    check_email, registration_status, request_signup_verification, signup, signup_with_invitation,
    verify_signup_verification,
};
#[cfg(test)]
use registration::{
    deterministic_fake_hint, map_plan_to_team_type, normalize_signup_plan, plan_member_limit,
    signup_team_name, validate_token,
};
pub use request_context::request_context_middleware;
#[cfg(test)]
use request_context::{header_value, parse_bearer_token};

fn request_ip_key(request: &RequestMetadata) -> String {
    request
        .ip_address
        .clone()
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| rate_limit::UNKNOWN_IP_KEY.to_string())
}

async fn enforce_window_limit(
    limiter: &dyn RateLimiter,
    scope: &str,
    key: &str,
    limit: WindowLimit,
) -> Result<(), AppError> {
    if limiter
        .check_and_increment(scope, key, limit.max, limit.window)
        .await?
        .is_limited()
    {
        return Err(rate_limited_error());
    }
    Ok(())
}

fn hash_normalized_email(normalized_email: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(normalized_email.as_bytes());
    hex::encode(hasher.finalize())
}

fn encode_hs256_token(
    claims: &impl Serialize,
    jwt_secret: &str,
    error_message: &'static str,
) -> Result<String, AppError> {
    encode(
        &Header::new(Algorithm::HS256),
        claims,
        &EncodingKey::from_secret(jwt_secret.as_bytes()),
    )
    .map_err(|error| {
        tracing::error!(error = %error, "{error_message}");
        AppError::internal(error_message)
    })
}

fn validate_hex_string(value: &str, message: &str) -> Result<(), AppError> {
    if value.is_empty()
        || !value.len().is_multiple_of(2)
        || !value.chars().all(|character| character.is_ascii_hexdigit())
    {
        return Err(bad_request_handler_error(message));
    }
    Ok(())
}

fn bad_request_handler_error(message: &str) -> AppError {
    AppError::bad_request(message)
}

#[cfg(test)]
#[path = "../auth_tests.rs"]
mod tests;
