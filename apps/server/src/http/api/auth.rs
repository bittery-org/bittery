use axum::{
    extract::{DefaultBodyLimit, Path, State},
    Json,
};
use serde::{Deserialize, Serialize};
use time::format_description::well_known::Rfc3339;
use utoipa::ToSchema;
use utoipa_axum::{router::OpenApiRouter, routes};

use crate::{
    services::{
        auth::{self, KdfParamsInput},
        session::{RenameDeviceInput, SessionIdInput},
    },
    AppState,
};

use super::{
    dto::{CursorPage, PageRequest},
    error::ApiError,
    extract::{ApiJson, ApiMergePatch, AuthenticatedRequest, PublicRequest},
    pagination::{
        decode_page_key, page_prefetched_with_more, page_values, query_limit, timestamp_cursor_key,
        ApiPageQuery,
    },
    ORDINARY_API_BODY_LIMIT_BYTES,
};

macro_rules! request_dto {
    ($name:ident { $($(#[$meta:meta])* $field:ident: $type:ty),* $(,)? }) => {
        #[derive(Debug, Deserialize, ToSchema)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        pub(crate) struct $name {
            $($(#[$meta])* pub(crate) $field: $type),*
        }
    };
}

macro_rules! response_dto {
    ($name:ident { $($(#[$meta:meta])* $field:ident: $type:ty),* $(,)? }) => {
        #[derive(Debug, Serialize, ToSchema)]
        #[serde(rename_all = "camelCase")]
        pub(crate) struct $name {
            $($(#[$meta])* pub(crate) $field: $type),*
        }
    };
}

request_dto!(EmailCheckRequest { email: String });
request_dto!(SignupVerificationRequest {
    email: String,
    invitation_token: Option<String>,
});
request_dto!(VerifySignupVerificationRequest {
    email: String,
    code: String,
    invitation_token: Option<String>,
});
request_dto!(KdfParamsRequest {
    schema_version: u32,
    algorithm: String,
    iterations: u32,
});
request_dto!(SignupRequest {
    user_id: Option<String>,
    vault_id: Option<String>,
    email: String,
    signup_verification_token: String,
    invitation_token: Option<String>,
    name: String,
    plan: Option<String>,
    organization_name: Option<String>,
    secret_key_hint: String,
    srp_salt: String,
    srp_verifier: String,
    public_key: String,
    encrypted_private_key: String,
    encrypted_master_key: String,
    recovery_key_hint: String,
    #[schema(max_length = 65536)]
    encrypted_vault_key: String,
    kdf_params: KdfParamsRequest,
});
request_dto!(StartLoginRequest {
    email: String,
    client_public_key: String,
});
request_dto!(FinishLoginRequest {
    client_public_key: String,
    client_proof: String,
});
request_dto!(RecoveryVerificationRequest { email: String });
request_dto!(VerifyRecoveryRequest {
    email: String,
    code: String,
});
request_dto!(RecoverySessionRequest {
    recovery_token: String,
});
request_dto!(EncryptedVaultKeyRequest {
    vault_id: String,
    #[schema(max_length = 65536)]
    encrypted_vault_key: String,
});
request_dto!(ResetPasswordRequest {
    recovery_token: String,
    srp_salt: String,
    srp_verifier: String,
    encrypted_private_key: String,
    encrypted_master_key: String,
    recovery_key_hint: String,
    secret_key_hint: Option<String>,
    #[schema(max_items = 500)]
    encrypted_vault_keys: Vec<EncryptedVaultKeyRequest>,
    kdf_params: KdfParamsRequest,
});
request_dto!(EmailChangeRequest {
    new_email: String,
    srp_salt: String,
    srp_verifier: String,
    encrypted_private_key: String,
    #[schema(max_items = 500)]
    encrypted_vault_keys: Vec<EncryptedVaultKeyRequest>,
    kdf_params: KdfParamsRequest,
});
request_dto!(PasswordChangeRequest {
    srp_salt: String,
    srp_verifier: String,
    encrypted_private_key: String,
    #[schema(max_items = 500)]
    encrypted_vault_keys: Vec<EncryptedVaultKeyRequest>,
    kdf_params: KdfParamsRequest,
});
request_dto!(SecretKeyRotationRequest {
    secret_key_hint: String,
    srp_salt: String,
    srp_verifier: String,
    encrypted_private_key: String,
    #[schema(max_items = 500)]
    encrypted_vault_keys: Vec<EncryptedVaultKeyRequest>,
    kdf_params: KdfParamsRequest,
});
request_dto!(RecoveryKeyRequest {
    encrypted_master_key: String,
    recovery_key_hint: String,
});
request_dto!(DeleteAccountRequest {
    confirm_email: String,
});
request_dto!(RenameSessionRequest {
    device_name: String,
});

response_dto!(SuccessResponse { success: bool });
response_dto!(RegistrationStatusResponse {
    mode: String,
    billing_enabled: bool,
    allow_public_signup: bool,
    requires_email_verification: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    reason: Option<String>,
});
response_dto!(EmailCheckResponse {
    exists: bool,
    secret_key_hint: String,
});
response_dto!(VerifySignupVerificationResponse {
    success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    signup_verification_token: Option<String>,
});
response_dto!(KdfParamsResponse {
    schema_version: u32,
    algorithm: String,
    iterations: u32,
});
response_dto!(LoginAttemptResponse {
    attempt_id: String,
    salt: String,
    server_public_key: String,
    kdf_params: KdfParamsResponse,
});
response_dto!(LoginUserResponse {
    id: String,
    email: String,
    name: String,
    secret_key_hint: String,
    public_key: String,
    encrypted_private_key: String,
});
response_dto!(FinishLoginResponse {
    token: String,
    session_id: String,
    expires_at: String,
    server_proof: String,
    user: LoginUserResponse,
    vault_keys: CursorPage<AuthVaultKeyResponse>,
});
response_dto!(VerifyRecoveryResponse {
    success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    recovery_token: Option<String>,
});
response_dto!(RecoveryVaultKeyResponse {
    vault_id: String,
    #[schema(max_length = 65536)]
    encrypted_vault_key: String,
    created_by_id: String,
});
response_dto!(RecoveryDataResponse {
    user_id: String,
    encrypted_master_key: String,
    encrypted_private_key: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    secret_key_hint: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    recovery_key_hint: Option<String>,
    #[schema(max_items = 500)]
    vault_keys: Vec<RecoveryVaultKeyResponse>,
});
response_dto!(ResetPasswordResponse {
    token: String,
    session_id: String,
    expires_at: String,
    user_id: String,
});
response_dto!(AuthUserResponse {
    id: String,
    email: String,
    name: String,
    secret_key_hint: String,
    public_key: String,
    encrypted_private_key: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    team_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    team_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    team_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    team_avatar_url: Option<String>,
    role: String,
});
response_dto!(AuthVaultKeyResponse {
    vault_id: String,
    vault_name: String,
    vault_type: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    vault_icon: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    vault_image_url: Option<String>,
    #[schema(max_length = 65536)]
    encrypted_vault_key: String,
    role: String,
    #[serde(skip)]
    #[schema(ignore)]
    cursor_key: String,
});
response_dto!(SignupResponse {
    success: bool,
    user_id: String,
    token: String,
    session_id: String,
    expires_at: String,
    user: AuthUserResponse,
    vault_keys: CursorPage<AuthVaultKeyResponse>,
});
response_dto!(MeResponse {
    id: String,
    email: String,
    name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    team_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    team_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    team_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    team_avatar_url: Option<String>,
    role: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    secret_key_hint: Option<String>,
    public_key: String,
    encrypted_private_key: String,
    has_recovery_key: bool,
    created_at: String,
});
response_dto!(SessionResponse {
    id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    device_name: Option<String>,
    platform: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    browser_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    browser_version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    os_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    os_version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    ip_address: Option<String>,
    last_active_at: String,
    created_at: String,
    is_current_session: bool,
});
response_dto!(RefreshSessionResponse {
    token: String,
    session_id: String,
    expires_at: String,
});

impl From<KdfParamsRequest> for KdfParamsInput {
    fn from(value: KdfParamsRequest) -> Self {
        Self {
            schema_version: value.schema_version,
            algorithm: value.algorithm,
            iterations: value.iterations,
        }
    }
}

fn encrypted_vault_keys(
    values: Vec<EncryptedVaultKeyRequest>,
) -> Vec<auth::EncryptedVaultKeyInput> {
    values
        .into_iter()
        .map(|value| auth::EncryptedVaultKeyInput {
            vault_id: value.vault_id,
            encrypted_vault_key: value.encrypted_vault_key,
        })
        .collect()
}

#[utoipa::path(post, path = "/auth/email-checks", request_body = EmailCheckRequest, responses((status = 200, body = EmailCheckResponse), (status = 400, body = super::dto::ProblemDetails, content_type = "application/problem+json")))]
async fn check_email(
    State(state): State<AppState>,
    ApiJson(input): ApiJson<EmailCheckRequest>,
) -> Result<Json<EmailCheckResponse>, ApiError> {
    let response = auth::check_email(&state, auth::CheckEmailInput { email: input.email }).await?;
    Ok(Json(EmailCheckResponse {
        exists: response.exists,
        secret_key_hint: response.secret_key_hint,
    }))
}

#[utoipa::path(get, path = "/auth/registration-status", operation_id = "getRegistrationStatus", tag = "auth", responses((status = 200, body = RegistrationStatusResponse, headers(("Cache-Control" = String, description = "Public policy responses must not be stored"))), (status = 500, body = super::dto::ProblemDetails, content_type = "application/problem+json")))]
async fn registration_status(
    State(state): State<AppState>,
) -> Result<Json<RegistrationStatusResponse>, ApiError> {
    let response = auth::registration_status(&state).await?;
    Ok(Json(RegistrationStatusResponse {
        mode: response.mode,
        billing_enabled: response.billing_enabled,
        allow_public_signup: response.allow_public_signup,
        requires_email_verification: response.requires_email_verification,
        reason: response.reason,
    }))
}

#[utoipa::path(post, path = "/auth/signup-verifications", request_body = SignupVerificationRequest, responses((status = 202, body = SuccessResponse), (status = 400, body = super::dto::ProblemDetails, content_type = "application/problem+json"), (status = 403, body = super::dto::ProblemDetails, content_type = "application/problem+json"), (status = 429, body = super::dto::ProblemDetails, content_type = "application/problem+json", headers(("Retry-After" = String, description = "Seconds before retrying")))))]
async fn request_signup_verification(
    State(state): State<AppState>,
    request: PublicRequest,
    ApiJson(input): ApiJson<SignupVerificationRequest>,
) -> Result<(axum::http::StatusCode, Json<SuccessResponse>), ApiError> {
    let response = auth::request_signup_verification(
        &state,
        &request.metadata,
        auth::RequestSignupVerificationInput {
            email: input.email,
            invitation_token: input.invitation_token,
        },
    )
    .await?;
    Ok((
        axum::http::StatusCode::ACCEPTED,
        Json(SuccessResponse {
            success: response.success,
        }),
    ))
}

#[utoipa::path(post, path = "/auth/signup-verifications/verify", request_body = VerifySignupVerificationRequest, responses((status = 200, body = VerifySignupVerificationResponse), (status = 400, body = super::dto::ProblemDetails, content_type = "application/problem+json"), (status = 404, body = super::dto::ProblemDetails, content_type = "application/problem+json"), (status = 429, body = super::dto::ProblemDetails, content_type = "application/problem+json", headers(("Retry-After" = String, description = "Seconds before retrying")))))]
async fn verify_signup_verification(
    State(state): State<AppState>,
    request: PublicRequest,
    ApiJson(input): ApiJson<VerifySignupVerificationRequest>,
) -> Result<Json<VerifySignupVerificationResponse>, ApiError> {
    let response = auth::verify_signup_verification(
        &state,
        &request.metadata,
        auth::VerifySignupVerificationInput {
            email: input.email,
            code: input.code,
            invitation_token: input.invitation_token,
        },
    )
    .await?;
    Ok(Json(VerifySignupVerificationResponse {
        success: response.success,
        signup_verification_token: response.signup_verification_token,
    }))
}

#[utoipa::path(post, path = "/auth/signups", request_body = SignupRequest, responses((status = 201, body = SignupResponse), (status = 400, body = super::dto::ProblemDetails, content_type = "application/problem+json"), (status = 401, description = "Signup verification token is missing or invalid", body = super::dto::ProblemDetails, content_type = "application/problem+json"), (status = 403, body = super::dto::ProblemDetails, content_type = "application/problem+json"), (status = 404, body = super::dto::ProblemDetails, content_type = "application/problem+json"), (status = 409, body = super::dto::ProblemDetails, content_type = "application/problem+json"), (status = 429, description = "Signup rate limit exceeded", body = super::dto::ProblemDetails, content_type = "application/problem+json", headers(("Retry-After" = String, description = "Seconds before retrying")))))]
async fn signup(
    State(state): State<AppState>,
    request: PublicRequest,
    ApiJson(input): ApiJson<SignupRequest>,
) -> Result<(axum::http::StatusCode, Json<SignupResponse>), ApiError> {
    let response = if let Some(token) = input.invitation_token {
        auth::signup_with_invitation(
            &state,
            &request.metadata,
            auth::SignupWithInvitationInput {
                token,
                user_id: input.user_id,
                vault_id: input.vault_id,
                email: input.email,
                signup_verification_token: input.signup_verification_token,
                name: input.name,
                secret_key_hint: input.secret_key_hint,
                srp_salt: input.srp_salt,
                srp_verifier: input.srp_verifier,
                public_key: input.public_key,
                encrypted_private_key: input.encrypted_private_key,
                encrypted_master_key: input.encrypted_master_key,
                recovery_key_hint: input.recovery_key_hint,
                encrypted_vault_key: input.encrypted_vault_key,
                kdf_params: input.kdf_params.into(),
            },
        )
        .await?
    } else {
        auth::signup(
            &state,
            &request.metadata,
            auth::SignupInput {
                user_id: input.user_id,
                vault_id: input.vault_id,
                email: input.email,
                signup_verification_token: input.signup_verification_token,
                name: input.name,
                plan: input.plan,
                organization_name: input.organization_name,
                secret_key_hint: input.secret_key_hint,
                srp_salt: input.srp_salt,
                srp_verifier: input.srp_verifier,
                public_key: input.public_key,
                encrypted_private_key: input.encrypted_private_key,
                encrypted_master_key: input.encrypted_master_key,
                recovery_key_hint: input.recovery_key_hint,
                encrypted_vault_key: input.encrypted_vault_key,
                kdf_params: input.kdf_params.into(),
            },
        )
        .await?
    };
    Ok((
        axum::http::StatusCode::CREATED,
        Json(map_signup_response(response)?),
    ))
}

#[utoipa::path(post, path = "/auth/login-attempts", request_body = StartLoginRequest, responses((status = 201, body = LoginAttemptResponse), (status = 400, body = super::dto::ProblemDetails, content_type = "application/problem+json"), (status = 404, body = super::dto::ProblemDetails, content_type = "application/problem+json"), (status = 429, body = super::dto::ProblemDetails, content_type = "application/problem+json", headers(("Retry-After" = String, description = "Seconds before retrying")))))]
async fn start_login(
    State(state): State<AppState>,
    request: PublicRequest,
    ApiJson(input): ApiJson<StartLoginRequest>,
) -> Result<(axum::http::StatusCode, Json<LoginAttemptResponse>), ApiError> {
    let response = auth::start_login(
        &state,
        &request.metadata,
        auth::StartLoginInput {
            email: input.email,
            client_public_key: input.client_public_key,
        },
    )
    .await?;
    Ok((axum::http::StatusCode::CREATED, Json(response.into())))
}

#[utoipa::path(post, path = "/auth/login-attempts/{attemptId}/finish", params(("attemptId" = String, Path)), request_body = FinishLoginRequest, responses((status = 200, body = FinishLoginResponse), (status = 400, body = super::dto::ProblemDetails, content_type = "application/problem+json"), (status = 401, body = super::dto::ProblemDetails, content_type = "application/problem+json"), (status = 429, body = super::dto::ProblemDetails, content_type = "application/problem+json", headers(("Retry-After" = String, description = "Seconds before retrying")))))]
async fn finish_login(
    State(state): State<AppState>,
    request: PublicRequest,
    Path(attempt_id): Path<String>,
    ApiJson(input): ApiJson<FinishLoginRequest>,
) -> Result<Json<FinishLoginResponse>, ApiError> {
    let response = auth::finish_login(
        &state,
        &request.metadata,
        auth::FinishLoginInput {
            attempt_id,
            client_public_key: input.client_public_key,
            client_proof: input.client_proof,
        },
    )
    .await?;
    Ok(Json(map_finish_login_response(response)?))
}

#[utoipa::path(get, path = "/users/me/vault-keys", operation_id = "listCurrentUserVaultKeys", tag = "auth", params(PageRequest), responses((status = 200, body = CursorPage<AuthVaultKeyResponse>), (status = 400, body = super::dto::ProblemDetails, content_type = "application/problem+json"), (status = 401, body = super::dto::ProblemDetails, content_type = "application/problem+json"), (status = 413, body = super::dto::ProblemDetails, content_type = "application/problem+json"), (status = 500, body = super::dto::ProblemDetails, content_type = "application/problem+json")))]
async fn list_vault_keys(
    State(state): State<AppState>,
    request: AuthenticatedRequest,
    ApiPageQuery(page): ApiPageQuery,
) -> Result<Json<CursorPage<AuthVaultKeyResponse>>, ApiError> {
    let cursor_key = decode_page_key(
        &page,
        &request.session.user_id,
        "current-user-vault-keys",
        "",
    )?;
    let cursor = cursor_key
        .as_deref()
        .map(timestamp_cursor_key)
        .transpose()?;
    let service_page = auth::load_auth_vault_keys_page(
        crate::config::db_pool(&state)?,
        &request.session.user_id,
        cursor,
        query_limit(&page)?,
    )
    .await?;
    Ok(Json(map_vault_key_page(
        service_page,
        &page,
        &request.session.user_id,
    )?))
}

#[utoipa::path(post, path = "/auth/recovery-verifications", request_body = RecoveryVerificationRequest, responses((status = 202, body = SuccessResponse), (status = 400, body = super::dto::ProblemDetails, content_type = "application/problem+json"), (status = 404, body = super::dto::ProblemDetails, content_type = "application/problem+json"), (status = 429, body = super::dto::ProblemDetails, content_type = "application/problem+json", headers(("Retry-After" = String, description = "Seconds before retrying")))))]
async fn request_recovery_verification(
    State(state): State<AppState>,
    request: PublicRequest,
    ApiJson(input): ApiJson<RecoveryVerificationRequest>,
) -> Result<(axum::http::StatusCode, Json<SuccessResponse>), ApiError> {
    let response = auth::request_recovery_verification(
        &state,
        &request.metadata,
        auth::RequestRecoveryVerificationInput { email: input.email },
    )
    .await?;
    Ok((
        axum::http::StatusCode::ACCEPTED,
        Json(SuccessResponse {
            success: response.success,
        }),
    ))
}

#[utoipa::path(post, path = "/auth/recovery-verifications/verify", request_body = VerifyRecoveryRequest, responses((status = 200, body = VerifyRecoveryResponse), (status = 400, body = super::dto::ProblemDetails, content_type = "application/problem+json"), (status = 404, body = super::dto::ProblemDetails, content_type = "application/problem+json"), (status = 429, body = super::dto::ProblemDetails, content_type = "application/problem+json", headers(("Retry-After" = String, description = "Seconds before retrying")))))]
async fn verify_recovery(
    State(state): State<AppState>,
    request: PublicRequest,
    ApiJson(input): ApiJson<VerifyRecoveryRequest>,
) -> Result<Json<VerifyRecoveryResponse>, ApiError> {
    let response = auth::verify_recovery_code(
        &state,
        &request.metadata,
        auth::VerifyRecoveryCodeInput {
            email: input.email,
            code: input.code,
        },
    )
    .await?;
    Ok(Json(VerifyRecoveryResponse {
        success: response.success,
        recovery_token: response.recovery_token,
    }))
}

#[utoipa::path(post, path = "/auth/recovery-sessions/data", request_body = RecoverySessionRequest, responses((status = 200, body = RecoveryDataResponse), (status = 400, body = super::dto::ProblemDetails, content_type = "application/problem+json"), (status = 401, body = super::dto::ProblemDetails, content_type = "application/problem+json"), (status = 404, body = super::dto::ProblemDetails, content_type = "application/problem+json")))]
async fn recovery_data(
    State(state): State<AppState>,
    request: PublicRequest,
    ApiJson(input): ApiJson<RecoverySessionRequest>,
) -> Result<Json<RecoveryDataResponse>, ApiError> {
    let response = auth::get_recovery_data(
        &state,
        &request.metadata,
        auth::GetRecoveryDataInput {
            recovery_token: input.recovery_token,
        },
    )
    .await?;
    Ok(Json(response.into()))
}

#[utoipa::path(post, path = "/auth/recovery-sessions/reset-password", request_body = ResetPasswordRequest, responses((status = 200, body = ResetPasswordResponse), (status = 400, body = super::dto::ProblemDetails, content_type = "application/problem+json"), (status = 401, body = super::dto::ProblemDetails, content_type = "application/problem+json"), (status = 409, body = super::dto::ProblemDetails, content_type = "application/problem+json")))]
async fn reset_password(
    State(state): State<AppState>,
    request: PublicRequest,
    ApiJson(input): ApiJson<ResetPasswordRequest>,
) -> Result<Json<ResetPasswordResponse>, ApiError> {
    let response = auth::reset_password(
        &state,
        &request.metadata,
        auth::ResetPasswordInput {
            recovery_token: input.recovery_token,
            srp_salt: input.srp_salt,
            srp_verifier: input.srp_verifier,
            encrypted_private_key: input.encrypted_private_key,
            encrypted_master_key: input.encrypted_master_key,
            recovery_key_hint: input.recovery_key_hint,
            secret_key_hint: input.secret_key_hint,
            encrypted_vault_keys: encrypted_vault_keys(input.encrypted_vault_keys),
            kdf_params: input.kdf_params.into(),
        },
    )
    .await?;
    Ok(Json(response.into()))
}

#[utoipa::path(get, path = "/users/me", responses((status = 200, body = MeResponse), (status = 401, body = super::dto::ProblemDetails, content_type = "application/problem+json"), (status = 500, body = super::dto::ProblemDetails, content_type = "application/problem+json")))]
async fn me(
    State(state): State<AppState>,
    request: AuthenticatedRequest,
) -> Result<Json<MeResponse>, ApiError> {
    Ok(Json(auth::get_me(&state, &request.session).await?.into()))
}

#[utoipa::path(get, path = "/sessions", params(PageRequest), responses((status = 200, body = CursorPage<SessionResponse>), (status = 400, body = super::dto::ProblemDetails, content_type = "application/problem+json"), (status = 401, body = super::dto::ProblemDetails, content_type = "application/problem+json"), (status = 500, body = super::dto::ProblemDetails, content_type = "application/problem+json")))]
async fn list_sessions(
    State(state): State<AppState>,
    request: AuthenticatedRequest,
    ApiPageQuery(page): ApiPageQuery,
) -> Result<Json<CursorPage<SessionResponse>>, ApiError> {
    let values: Vec<SessionResponse> = auth::list_devices(&state, &request.session)
        .await?
        .into_iter()
        .map(Into::into)
        .collect();
    Ok(Json(page_values(
        values,
        &page,
        &request.session.user_id,
        "sessions",
        "",
        |session| session.id.clone(),
    )?))
}

#[utoipa::path(post, path = "/users/me/email-changes", request_body = EmailChangeRequest, responses((status = 200, body = SuccessResponse), (status = 400, body = super::dto::ProblemDetails, content_type = "application/problem+json"), (status = 401, body = super::dto::ProblemDetails, content_type = "application/problem+json"), (status = 409, body = super::dto::ProblemDetails, content_type = "application/problem+json")))]
async fn update_email(
    State(state): State<AppState>,
    request: AuthenticatedRequest,
    ApiJson(input): ApiJson<EmailChangeRequest>,
) -> Result<Json<SuccessResponse>, ApiError> {
    let response = auth::update_email(
        &state,
        &request.session,
        auth::UpdateEmailInput {
            new_email: input.new_email,
            srp_salt: input.srp_salt,
            srp_verifier: input.srp_verifier,
            encrypted_private_key: input.encrypted_private_key,
            encrypted_vault_keys: encrypted_vault_keys(input.encrypted_vault_keys),
            kdf_params: input.kdf_params.into(),
        },
    )
    .await?;
    Ok(Json(SuccessResponse {
        success: response.success,
    }))
}

#[utoipa::path(post, path = "/users/me/password-changes", request_body = PasswordChangeRequest, responses((status = 200, body = SuccessResponse), (status = 400, body = super::dto::ProblemDetails, content_type = "application/problem+json"), (status = 401, body = super::dto::ProblemDetails, content_type = "application/problem+json"), (status = 500, body = super::dto::ProblemDetails, content_type = "application/problem+json")))]
async fn change_password(
    State(state): State<AppState>,
    request: AuthenticatedRequest,
    ApiJson(input): ApiJson<PasswordChangeRequest>,
) -> Result<Json<SuccessResponse>, ApiError> {
    let response = auth::change_password(
        &state,
        &request.session,
        auth::ChangePasswordInput {
            srp_salt: input.srp_salt,
            srp_verifier: input.srp_verifier,
            encrypted_private_key: input.encrypted_private_key,
            encrypted_vault_keys: encrypted_vault_keys(input.encrypted_vault_keys),
            kdf_params: input.kdf_params.into(),
        },
    )
    .await?;
    Ok(Json(SuccessResponse {
        success: response.success,
    }))
}

#[utoipa::path(post, path = "/users/me/secret-key-rotations", request_body = SecretKeyRotationRequest, responses((status = 200, body = SuccessResponse), (status = 400, body = super::dto::ProblemDetails, content_type = "application/problem+json"), (status = 401, body = super::dto::ProblemDetails, content_type = "application/problem+json")))]
async fn regenerate_secret_key(
    State(state): State<AppState>,
    request: AuthenticatedRequest,
    ApiJson(input): ApiJson<SecretKeyRotationRequest>,
) -> Result<Json<SuccessResponse>, ApiError> {
    let response = auth::regenerate_secret_key(
        &state,
        &request.session,
        auth::RegenerateSecretKeyInput {
            secret_key_hint: input.secret_key_hint,
            srp_salt: input.srp_salt,
            srp_verifier: input.srp_verifier,
            encrypted_private_key: input.encrypted_private_key,
            encrypted_vault_keys: encrypted_vault_keys(input.encrypted_vault_keys),
            kdf_params: input.kdf_params.into(),
        },
    )
    .await?;
    Ok(Json(SuccessResponse {
        success: response.success,
    }))
}

#[utoipa::path(put, path = "/users/me/recovery-key", request_body = RecoveryKeyRequest, responses((status = 200, body = SuccessResponse), (status = 400, body = super::dto::ProblemDetails, content_type = "application/problem+json"), (status = 401, body = super::dto::ProblemDetails, content_type = "application/problem+json")))]
async fn store_recovery_key(
    State(state): State<AppState>,
    request: AuthenticatedRequest,
    ApiJson(input): ApiJson<RecoveryKeyRequest>,
) -> Result<Json<SuccessResponse>, ApiError> {
    let response = auth::store_recovery_key(
        &state,
        &request.session,
        auth::StoreRecoveryKeyInput {
            encrypted_master_key: input.encrypted_master_key,
            recovery_key_hint: input.recovery_key_hint,
        },
    )
    .await?;
    Ok(Json(SuccessResponse {
        success: response.success,
    }))
}

#[utoipa::path(delete, path = "/users/me", request_body = DeleteAccountRequest, responses((status = 200, body = SuccessResponse), (status = 400, body = super::dto::ProblemDetails, content_type = "application/problem+json"), (status = 401, body = super::dto::ProblemDetails, content_type = "application/problem+json"), (status = 403, body = super::dto::ProblemDetails, content_type = "application/problem+json"), (status = 409, body = super::dto::ProblemDetails, content_type = "application/problem+json")))]
async fn delete_account(
    State(state): State<AppState>,
    request: AuthenticatedRequest,
    ApiJson(input): ApiJson<DeleteAccountRequest>,
) -> Result<Json<SuccessResponse>, ApiError> {
    let response = auth::delete_account(
        &state,
        &request.session,
        auth::DeleteAccountInput {
            confirm_email: input.confirm_email,
        },
    )
    .await?;
    Ok(Json(SuccessResponse {
        success: response.success,
    }))
}

#[utoipa::path(delete, path = "/sessions/{sessionId}", params(("sessionId" = String, Path)), responses((status = 200, body = SuccessResponse), (status = 400, description = "The current session cannot revoke itself", body = super::dto::ProblemDetails, content_type = "application/problem+json"), (status = 401, body = super::dto::ProblemDetails, content_type = "application/problem+json"), (status = 403, body = super::dto::ProblemDetails, content_type = "application/problem+json"), (status = 404, body = super::dto::ProblemDetails, content_type = "application/problem+json")))]
async fn revoke_session(
    State(state): State<AppState>,
    request: AuthenticatedRequest,
    Path(session_id): Path<String>,
) -> Result<Json<SuccessResponse>, ApiError> {
    let response =
        auth::revoke_device(&state, &request.session, SessionIdInput { session_id }).await?;
    Ok(Json(SuccessResponse {
        success: response.success,
    }))
}

#[utoipa::path(patch, path = "/sessions/{sessionId}", params(("sessionId" = String, Path)), request_body(content = RenameSessionRequest, content_type = "application/merge-patch+json"), responses((status = 200, body = SuccessResponse), (status = 400, body = super::dto::ProblemDetails, content_type = "application/problem+json"), (status = 401, body = super::dto::ProblemDetails, content_type = "application/problem+json"), (status = 403, body = super::dto::ProblemDetails, content_type = "application/problem+json"), (status = 404, body = super::dto::ProblemDetails, content_type = "application/problem+json"), (status = 415, body = super::dto::ProblemDetails, content_type = "application/problem+json")))]
async fn rename_session(
    State(state): State<AppState>,
    request: AuthenticatedRequest,
    Path(session_id): Path<String>,
    ApiMergePatch(input): ApiMergePatch<RenameSessionRequest>,
) -> Result<Json<SuccessResponse>, ApiError> {
    let response = auth::rename_device(
        &state,
        &request.session,
        RenameDeviceInput {
            session_id,
            device_name: input.device_name,
        },
    )
    .await?;
    Ok(Json(SuccessResponse {
        success: response.success,
    }))
}

#[utoipa::path(post, path = "/sessions/current/refresh", responses((status = 200, body = RefreshSessionResponse), (status = 401, body = super::dto::ProblemDetails, content_type = "application/problem+json"), (status = 500, body = super::dto::ProblemDetails, content_type = "application/problem+json")))]
async fn refresh_session(
    State(state): State<AppState>,
    request: AuthenticatedRequest,
) -> Result<Json<RefreshSessionResponse>, ApiError> {
    Ok(Json(
        auth::do_refresh_session(&state, &request.session)
            .await?
            .into(),
    ))
}

pub(crate) fn router() -> OpenApiRouter<AppState> {
    OpenApiRouter::new()
        .routes(routes!(registration_status))
        .routes(routes!(check_email))
        .routes(routes!(request_signup_verification))
        .routes(routes!(verify_signup_verification))
        .routes(routes!(signup))
        .routes(routes!(start_login))
        .routes(routes!(finish_login))
        .routes(routes!(list_vault_keys))
        .routes(routes!(request_recovery_verification))
        .routes(routes!(verify_recovery))
        .routes(routes!(recovery_data))
        .routes(routes!(reset_password))
        .routes(routes!(me))
        .routes(routes!(list_sessions))
        .routes(routes!(update_email))
        .routes(routes!(change_password))
        .routes(routes!(regenerate_secret_key))
        .routes(routes!(store_recovery_key))
        .routes(routes!(delete_account))
        .routes(routes!(revoke_session))
        .routes(routes!(rename_session))
        .routes(routes!(refresh_session))
        .layer(DefaultBodyLimit::max(ORDINARY_API_BODY_LIMIT_BYTES))
}

impl From<auth::StartLoginResponse> for LoginAttemptResponse {
    fn from(value: auth::StartLoginResponse) -> Self {
        Self {
            attempt_id: value.attempt_id,
            salt: value.salt,
            server_public_key: value.server_public_key,
            kdf_params: KdfParamsResponse {
                schema_version: value.kdf_params.schema_version,
                algorithm: value.kdf_params.algorithm,
                iterations: value.kdf_params.iterations,
            },
        }
    }
}

fn map_auth_vault_key(value: auth::AuthVaultKeyResponse) -> Result<AuthVaultKeyResponse, ApiError> {
    let created_at = value
        .created_at
        .format(&Rfc3339)
        .map_err(|_| ApiError::internal())?;
    Ok(AuthVaultKeyResponse {
        cursor_key: format!("{created_at}\0{}", value.vault_id),
        vault_id: value.vault_id,
        vault_name: value.vault_name,
        vault_type: value.vault_type,
        vault_icon: value.vault_icon,
        vault_image_url: value.vault_image_url,
        encrypted_vault_key: value.encrypted_vault_key,
        role: value.role,
    })
}

fn map_vault_key_page(
    value: auth::AuthVaultKeyPage,
    request: &PageRequest,
    user_id: &str,
) -> Result<CursorPage<AuthVaultKeyResponse>, ApiError> {
    page_prefetched_with_more(
        value
            .items
            .into_iter()
            .map(map_auth_vault_key)
            .collect::<Result<Vec<_>, _>>()?,
        value.has_more,
        request,
        user_id,
        "current-user-vault-keys",
        "",
        |key| key.cursor_key.clone(),
    )
}

fn initial_vault_key_page(
    value: auth::AuthVaultKeyPage,
    user_id: &str,
) -> Result<CursorPage<AuthVaultKeyResponse>, ApiError> {
    map_vault_key_page(
        value,
        &PageRequest {
            cursor: None,
            limit: super::dto::DEFAULT_PAGE_SIZE,
        },
        user_id,
    )
}

fn map_finish_login_response(
    value: auth::FinishLoginResponse,
) -> Result<FinishLoginResponse, ApiError> {
    let user_id = value.user.id.clone();
    Ok(FinishLoginResponse {
        token: value.token,
        session_id: value.session_id,
        expires_at: value.expires_at,
        server_proof: value.server_proof,
        user: LoginUserResponse {
            id: value.user.id,
            email: value.user.email,
            name: value.user.name,
            secret_key_hint: value.user.secret_key_hint,
            public_key: value.user.public_key,
            encrypted_private_key: value.user.encrypted_private_key,
        },
        vault_keys: initial_vault_key_page(value.vault_keys, &user_id)?,
    })
}

impl From<auth::GetRecoveryDataResponse> for RecoveryDataResponse {
    fn from(value: auth::GetRecoveryDataResponse) -> Self {
        Self {
            user_id: value.user_id,
            encrypted_master_key: value.encrypted_master_key,
            encrypted_private_key: value.encrypted_private_key,
            secret_key_hint: value.secret_key_hint,
            recovery_key_hint: value.recovery_key_hint,
            vault_keys: value
                .vault_keys
                .into_iter()
                .map(|key| RecoveryVaultKeyResponse {
                    vault_id: key.vault_id,
                    encrypted_vault_key: key.encrypted_vault_key,
                    created_by_id: key.created_by_id,
                })
                .collect(),
        }
    }
}

impl From<auth::ResetPasswordResponse> for ResetPasswordResponse {
    fn from(value: auth::ResetPasswordResponse) -> Self {
        Self {
            token: value.token,
            session_id: value.session_id,
            expires_at: value.expires_at,
            user_id: value.user_id,
        }
    }
}

fn map_signup_response(value: auth::SignupResponse) -> Result<SignupResponse, ApiError> {
    let user_id = value.user.id.clone();
    Ok(SignupResponse {
        success: value.success,
        user_id: value.user_id,
        token: value.token,
        session_id: value.session_id,
        expires_at: value.expires_at,
        user: AuthUserResponse {
            id: value.user.id,
            email: value.user.email,
            name: value.user.name,
            secret_key_hint: value.user.secret_key_hint,
            public_key: value.user.public_key,
            encrypted_private_key: value.user.encrypted_private_key,
            team_id: value.user.team_id,
            team_name: value.user.team_name,
            team_type: value.user.team_type,
            team_avatar_url: value.user.team_avatar_url,
            role: value.user.role,
        },
        vault_keys: initial_vault_key_page(value.vault_keys, &user_id)?,
    })
}

impl From<auth::MeResponse> for MeResponse {
    fn from(value: auth::MeResponse) -> Self {
        Self {
            id: value.id,
            email: value.email,
            name: value.name,
            team_id: value.team_id,
            team_name: value.team_name,
            team_type: value.team_type,
            team_avatar_url: value.team_avatar_url,
            role: value.role,
            secret_key_hint: value.secret_key_hint,
            public_key: value.public_key,
            encrypted_private_key: value.encrypted_private_key,
            has_recovery_key: value.has_recovery_key,
            created_at: value.created_at,
        }
    }
}

impl From<crate::services::session::DeviceSessionResponse> for SessionResponse {
    fn from(value: crate::services::session::DeviceSessionResponse) -> Self {
        Self {
            id: value.id,
            device_name: value.device_name,
            platform: value.platform,
            browser_name: value.browser_name,
            browser_version: value.browser_version,
            os_name: value.os_name,
            os_version: value.os_version,
            ip_address: value.ip_address,
            last_active_at: value.last_active_at,
            created_at: value.created_at,
            is_current_session: value.is_current_session,
        }
    }
}

impl From<crate::services::session::RefreshSessionResponse> for RefreshSessionResponse {
    fn from(value: crate::services::session::RefreshSessionResponse) -> Self {
        Self {
            token: value.token,
            session_id: value.session_id,
            expires_at: value.expires_at,
        }
    }
}

#[cfg(test)]
mod tests {
    use axum::{
        body::{to_bytes, Body},
        http::{header, Request, StatusCode},
    };
    use serde_json::{json, Value};
    use tower::ServiceExt;

    use crate::{create_app, AppState, EdgeHttpConfig};

    #[test]
    fn all_used_auth_operations_are_registered() {
        let document = serde_json::to_value(super::router().split_for_parts().1).unwrap();
        let paths = document["paths"].as_object().unwrap();
        let expected = [
            ("/auth/registration-status", "get"),
            ("/auth/email-checks", "post"),
            ("/auth/signup-verifications", "post"),
            ("/auth/signup-verifications/verify", "post"),
            ("/auth/signups", "post"),
            ("/auth/login-attempts", "post"),
            ("/auth/login-attempts/{attemptId}/finish", "post"),
            ("/users/me/vault-keys", "get"),
            ("/auth/recovery-verifications", "post"),
            ("/auth/recovery-verifications/verify", "post"),
            ("/auth/recovery-sessions/data", "post"),
            ("/auth/recovery-sessions/reset-password", "post"),
            ("/users/me", "get"),
            ("/sessions", "get"),
            ("/users/me/email-changes", "post"),
            ("/users/me/password-changes", "post"),
            ("/users/me/secret-key-rotations", "post"),
            ("/users/me/recovery-key", "put"),
            ("/users/me", "delete"),
            ("/sessions/{sessionId}", "delete"),
            ("/sessions/{sessionId}", "patch"),
            ("/sessions/current/refresh", "post"),
        ];

        for (path, method) in expected {
            assert!(
                paths.get(path).and_then(|item| item.get(method)).is_some(),
                "missing {method} {path}"
            );
        }
        assert_eq!(
            paths
                .values()
                .map(|item| item.as_object().unwrap().len())
                .sum::<usize>(),
            expected.len()
        );
        assert!(!document.to_string().contains("heartbeat"));
        assert!(!document.to_string().contains("logout"));

        for (path, method, status) in [
            ("/auth/signups", "post", "401"),
            ("/auth/signups", "post", "429"),
            ("/users/me/password-changes", "post", "500"),
            ("/sessions/{sessionId}", "delete", "400"),
        ] {
            assert_eq!(
                document["paths"][path][method]["responses"][status]["content"]
                    ["application/problem+json"]["schema"]["$ref"],
                "#/components/schemas/ProblemDetails",
                "missing problem contract for {method} {path} status {status}"
            );
        }
    }

    #[tokio::test]
    async fn email_check_rejects_unknown_fields_as_problem_json() {
        let response = create_app(AppState::default(), EdgeHttpConfig::default())
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/v1/auth/email-checks")
                    .header(header::CONTENT_TYPE, "application/json")
                    .body(Body::from(r#"{"email":"user@example.com","extra":true}"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::UNPROCESSABLE_ENTITY);
        assert_eq!(
            response.headers().get(header::CONTENT_TYPE).unwrap(),
            "application/problem+json"
        );
        let body: Value =
            serde_json::from_slice(&to_bytes(response.into_body(), usize::MAX).await.unwrap())
                .unwrap();
        assert_eq!(body["code"], json!("INVALID_REQUEST"));
    }

    #[tokio::test]
    async fn authenticated_routes_reject_missing_sessions() {
        let response = create_app(AppState::default(), EdgeHttpConfig::default())
            .oneshot(
                Request::builder()
                    .uri("/api/v1/users/me")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
        assert_eq!(
            response.headers().get(header::CONTENT_TYPE).unwrap(),
            "application/problem+json"
        );
    }
}
