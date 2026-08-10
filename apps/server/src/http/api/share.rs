use axum::{
    extract::{DefaultBodyLimit, Path, State},
    http::HeaderMap,
    Json,
};
use serde::{Deserialize, Serialize};
use utoipa::{IntoResponses, ToSchema};
use utoipa_axum::{router::OpenApiRouter, routes};

use crate::{config::db_pool, services::share, AppState};

use super::{
    dto::ProblemDetails,
    error::ApiError,
    extract::{ApiJson, AuthenticatedRequest},
    idempotency, ORDINARY_API_BODY_LIMIT_BYTES,
};

#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CreateShareLinkRequest {
    access_mode: ShareAccessMode,
    #[serde(default)]
    is_one_time_use: bool,
    expires_in: ShareExpiration,
    #[schema(max_items = 100)]
    allowed_emails: Option<Vec<EmailAddress>>,
    encrypted_item_data: String,
    encryption_iv: String,
    encrypted_share_key: String,
    share_key_iv: String,
}

#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "kebab-case")]
enum ShareAccessMode {
    Anyone,
    EmailRestricted,
}

impl ShareAccessMode {
    fn as_wire_value(&self) -> &'static str {
        match self {
            Self::Anyone => "anyone",
            Self::EmailRestricted => "email-restricted",
        }
    }
}

#[derive(Debug, Deserialize, ToSchema)]
enum ShareExpiration {
    #[serde(rename = "1hour")]
    OneHour,
    #[serde(rename = "1day")]
    OneDay,
    #[serde(rename = "7days")]
    SevenDays,
    #[serde(rename = "14days")]
    FourteenDays,
    #[serde(rename = "30days")]
    ThirtyDays,
}

impl ShareExpiration {
    fn as_wire_value(&self) -> &'static str {
        match self {
            Self::OneHour => "1hour",
            Self::OneDay => "1day",
            Self::SevenDays => "7days",
            Self::FourteenDays => "14days",
            Self::ThirtyDays => "30days",
        }
    }
}

#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct EmailVerificationRequest {
    email: EmailAddress,
}

#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct EmailAccessRequest {
    email: EmailAddress,
    code: String,
}

#[derive(Debug, Deserialize, ToSchema)]
#[serde(transparent)]
#[schema(value_type = String, pattern = r"^.{1,320}$")]
struct EmailAddress(String);

#[derive(Debug, Deserialize, ToSchema)]
#[serde(transparent)]
#[schema(value_type = String, pattern = r"^[A-Za-z0-9_-]{32}$")]
pub(crate) struct ShareToken(String);

#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
struct CreateShareLinkResponse {
    id: String,
    token: String,
    expires_at: String,
    base_share_url: String,
}

impl From<share::CreateShareLinkResponse> for CreateShareLinkResponse {
    fn from(value: share::CreateShareLinkResponse) -> Self {
        Self {
            id: value.id,
            token: value.token,
            expires_at: value.expires_at,
            base_share_url: value.base_share_url,
        }
    }
}

#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
struct AllowedEmailResponse {
    email: String,
    verified: bool,
}

#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
struct ShareLinkListEntryResponse {
    id: String,
    status: String,
    access_mode: String,
    is_one_time_use: bool,
    access_count: i32,
    #[serde(skip_serializing_if = "Option::is_none")]
    max_access_count: Option<i32>,
    #[schema(max_items = 100)]
    allowed_emails: Vec<AllowedEmailResponse>,
    expires_at: String,
    created_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    last_accessed_at: Option<String>,
}

#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
struct ShareLinkListResponse {
    #[schema(max_items = 100)]
    links: Vec<ShareLinkListEntryResponse>,
    base_share_url: String,
}

impl From<share::ShareLinkListResponse> for ShareLinkListResponse {
    fn from(value: share::ShareLinkListResponse) -> Self {
        Self {
            links: value
                .links
                .into_iter()
                .map(|link| ShareLinkListEntryResponse {
                    id: link.id,
                    status: link.status,
                    access_mode: link.access_mode,
                    is_one_time_use: link.is_one_time_use,
                    access_count: link.access_count,
                    max_access_count: link.max_access_count,
                    allowed_emails: link
                        .allowed_emails
                        .into_iter()
                        .map(|email| AllowedEmailResponse {
                            email: email.email,
                            verified: email.verified,
                        })
                        .collect(),
                    expires_at: link.expires_at,
                    created_at: link.created_at,
                    last_accessed_at: link.last_accessed_at,
                })
                .collect(),
            base_share_url: value.base_share_url,
        }
    }
}

#[derive(Debug, Serialize, ToSchema)]
struct SuccessResponse {
    success: bool,
}

#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
struct ShareAccessLogResponse {
    id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    accessed_by_email: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    ip_address: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    user_agent: Option<String>,
    success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    failure_reason: Option<String>,
    accessed_at: String,
}

impl From<share::ShareAccessLogResponse> for ShareAccessLogResponse {
    fn from(value: share::ShareAccessLogResponse) -> Self {
        Self {
            id: value.id,
            accessed_by_email: value.accessed_by_email,
            ip_address: value.ip_address,
            user_agent: value.user_agent,
            success: value.success,
            failure_reason: value.failure_reason,
            accessed_at: value.accessed_at,
        }
    }
}

#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
struct PublicShareInfoResponse {
    valid: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    reason: Option<String>,
    access_mode: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    is_one_time_use: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    expires_at: Option<String>,
}

impl From<share::PublicShareInfoResponse> for PublicShareInfoResponse {
    fn from(value: share::PublicShareInfoResponse) -> Self {
        Self {
            valid: value.valid,
            reason: value.reason,
            access_mode: value.access_mode,
            is_one_time_use: value.is_one_time_use,
            expires_at: value.expires_at,
        }
    }
}

#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
struct PublicShareAccessResponse {
    encrypted_item_data: String,
    encryption_iv: String,
    encrypted_share_key: String,
    share_key_iv: String,
}

impl From<share::PublicShareAccessResponse> for PublicShareAccessResponse {
    fn from(value: share::PublicShareAccessResponse) -> Self {
        Self {
            encrypted_item_data: value.encrypted_item_data,
            encryption_iv: value.encryption_iv,
            encrypted_share_key: value.encrypted_share_key,
            share_key_iv: value.share_key_iv,
        }
    }
}

#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
struct EmailVerificationResponse {
    success: bool,
    message: String,
}

#[derive(IntoResponses)]
#[allow(dead_code)]
enum ShareErrorResponses {
    #[response(
        status = 400,
        description = "Bad request",
        content_type = "application/problem+json"
    )]
    BadRequest(ProblemDetails),
    #[response(
        status = 401,
        description = "Authentication required",
        content_type = "application/problem+json"
    )]
    Unauthorized(ProblemDetails),
    #[response(
        status = 403,
        description = "Forbidden",
        content_type = "application/problem+json"
    )]
    Forbidden(ProblemDetails),
    #[response(
        status = 404,
        description = "Not found",
        content_type = "application/problem+json"
    )]
    NotFound(ProblemDetails),
    #[response(
        status = 415,
        description = "Unsupported media type",
        content_type = "application/problem+json"
    )]
    UnsupportedMediaType(ProblemDetails),
    #[response(
        status = 429,
        description = "Rate limited",
        content_type = "application/problem+json",
        headers(("Retry-After" = String, description = "Seconds before retrying"))
    )]
    RateLimited(ProblemDetails),
    #[response(
        status = 500,
        description = "Internal error",
        content_type = "application/problem+json"
    )]
    Internal(ProblemDetails),
}

fn validate_email_length(email: &str) -> Result<(), ApiError> {
    if email.len() > 320 {
        Err(ApiError::bad_request(
            "INVALID_EMAIL",
            "Email addresses cannot exceed 320 bytes.",
        ))
    } else {
        Ok(())
    }
}

#[utoipa::path(post, path = "/items/{itemId}/share-links", operation_id = "createShareLink", tag = "share-links", params(("itemId" = String, Path), ("Idempotency-Key" = Option<String>, Header, description = "Not accepted because this operation returns a one-time secret")), request_body = CreateShareLinkRequest, responses((status = 201, body = CreateShareLinkResponse), (status = 422, description = "Idempotency is not allowed for one-time-secret responses", body = ProblemDetails, content_type = "application/problem+json"), ShareErrorResponses))]
async fn create_share_link(
    State(state): State<AppState>,
    request: AuthenticatedRequest,
    headers: HeaderMap,
    Path(item_id): Path<String>,
    ApiJson(body): ApiJson<CreateShareLinkRequest>,
) -> Result<(axum::http::StatusCode, Json<CreateShareLinkResponse>), ApiError> {
    idempotency::reject_one_time_secret(&headers)?;
    if let Some(emails) = &body.allowed_emails {
        for email in emails {
            validate_email_length(&email.0)?;
        }
    }
    let response = share::create_share_link(
        &state,
        &request.session.user_id,
        share::CreateShareLinkInput {
            item_id,
            access_mode: body.access_mode.as_wire_value().to_string(),
            is_one_time_use: body.is_one_time_use,
            expires_in: body.expires_in.as_wire_value().to_string(),
            allowed_emails: body
                .allowed_emails
                .map(|emails| emails.into_iter().map(|email| email.0).collect()),
            encrypted_item_data: body.encrypted_item_data,
            encryption_iv: body.encryption_iv,
            encrypted_share_key: body.encrypted_share_key,
            share_key_iv: body.share_key_iv,
        },
    )
    .await?;
    Ok((axum::http::StatusCode::CREATED, Json(response.into())))
}

#[utoipa::path(get, path = "/items/{itemId}/share-links", operation_id = "listItemShareLinks", tag = "share-links", params(("itemId" = String, Path)), responses((status = 200, body = ShareLinkListResponse), ShareErrorResponses))]
async fn list_share_links(
    State(state): State<AppState>,
    request: AuthenticatedRequest,
    Path(item_id): Path<String>,
) -> Result<Json<ShareLinkListResponse>, ApiError> {
    Ok(Json(
        share::list_share_links_by_item(
            db_pool(&state)?,
            &request.session.user_id,
            share::ItemIdInput { item_id },
        )
        .await?
        .into(),
    ))
}

#[utoipa::path(delete, path = "/share-links/{linkId}", operation_id = "revokeShareLink", tag = "share-links", params(("linkId" = String, Path)), responses((status = 200, body = SuccessResponse), ShareErrorResponses))]
async fn revoke_share_link(
    State(state): State<AppState>,
    request: AuthenticatedRequest,
    Path(link_id): Path<String>,
) -> Result<Json<SuccessResponse>, ApiError> {
    let response = share::revoke_share_link(
        db_pool(&state)?,
        &request.session.user_id,
        share::LinkIdInput { link_id },
    )
    .await?;
    Ok(Json(SuccessResponse {
        success: response.success,
    }))
}

#[utoipa::path(get, path = "/share-links/{linkId}/access-logs", operation_id = "listShareAccessLogs", tag = "share-links", params(("linkId" = String, Path)), responses((status = 200, body = [ShareAccessLogResponse]), ShareErrorResponses))]
async fn access_logs(
    State(state): State<AppState>,
    request: AuthenticatedRequest,
    Path(link_id): Path<String>,
) -> Result<Json<Vec<ShareAccessLogResponse>>, ApiError> {
    Ok(Json(
        share::get_share_access_logs(
            db_pool(&state)?,
            &request.session.user_id,
            share::LinkIdInput { link_id },
        )
        .await?
        .into_iter()
        .map(Into::into)
        .collect(),
    ))
}

#[utoipa::path(get, path = "/public/share-links/{token}", operation_id = "getPublicShareInfo", tag = "public-share-links", params(("token" = ShareToken, Path)), responses((status = 200, body = PublicShareInfoResponse), ShareErrorResponses))]
async fn public_info(
    State(state): State<AppState>,
    Path(token): Path<ShareToken>,
) -> Result<Json<PublicShareInfoResponse>, ApiError> {
    Ok(Json(
        share::get_public_info(db_pool(&state)?, share::PublicTokenInput { token: token.0 })
            .await?
            .into(),
    ))
}

#[utoipa::path(post, path = "/public/share-links/{token}/accesses", operation_id = "accessPublicShare", tag = "public-share-links", params(("token" = ShareToken, Path)), responses((status = 200, body = PublicShareAccessResponse), ShareErrorResponses))]
async fn access_public(
    State(state): State<AppState>,
    Path(token): Path<ShareToken>,
) -> Result<Json<PublicShareAccessResponse>, ApiError> {
    Ok(Json(
        share::access_public(db_pool(&state)?, share::PublicTokenInput { token: token.0 })
            .await?
            .into(),
    ))
}

#[utoipa::path(post, path = "/public/share-links/{token}/email-verifications", operation_id = "requestShareEmailVerification", tag = "public-share-links", params(("token" = ShareToken, Path)), request_body = EmailVerificationRequest, responses((status = 202, body = EmailVerificationResponse), ShareErrorResponses))]
async fn request_email_verification(
    State(state): State<AppState>,
    Path(token): Path<ShareToken>,
    ApiJson(body): ApiJson<EmailVerificationRequest>,
) -> Result<(axum::http::StatusCode, Json<EmailVerificationResponse>), ApiError> {
    validate_email_length(&body.email.0)?;
    let response = share::request_email_verification(
        &state,
        share::RequestEmailVerificationInput {
            token: token.0,
            email: body.email.0,
        },
    )
    .await?;
    Ok((
        axum::http::StatusCode::ACCEPTED,
        Json(EmailVerificationResponse {
            success: response.success,
            message: response.message,
        }),
    ))
}

#[utoipa::path(post, path = "/public/share-links/{token}/email-accesses", operation_id = "verifyShareEmailAndAccess", tag = "public-share-links", params(("token" = ShareToken, Path)), request_body = EmailAccessRequest, responses((status = 200, body = PublicShareAccessResponse), ShareErrorResponses))]
async fn verify_email_and_access(
    State(state): State<AppState>,
    Path(token): Path<ShareToken>,
    ApiJson(body): ApiJson<EmailAccessRequest>,
) -> Result<Json<PublicShareAccessResponse>, ApiError> {
    validate_email_length(&body.email.0)?;
    Ok(Json(
        share::verify_email_and_access(
            &state,
            share::VerifyEmailAndAccessInput {
                token: token.0,
                email: body.email.0,
                code: body.code,
            },
        )
        .await?
        .into(),
    ))
}

pub(crate) fn router() -> OpenApiRouter<AppState> {
    OpenApiRouter::new()
        .routes(routes!(create_share_link))
        .routes(routes!(list_share_links))
        .routes(routes!(revoke_share_link))
        .routes(routes!(access_logs))
        .routes(routes!(public_info))
        .routes(routes!(access_public))
        .routes(routes!(request_email_verification))
        .routes(routes!(verify_email_and_access))
        .route_layer(DefaultBodyLimit::max(ORDINARY_API_BODY_LIMIT_BYTES))
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::{router, CreateShareLinkRequest};

    #[test]
    fn all_used_share_operations_are_registered_without_get_or_update() {
        let document = serde_json::to_value(router().split_for_parts().1).unwrap();
        let paths = document["paths"].as_object().unwrap();
        let operation_count = paths
            .values()
            .map(|path| path.as_object().unwrap().len())
            .sum::<usize>();
        assert_eq!(operation_count, 8);
        assert!(paths
            .get("/share-links/{linkId}")
            .unwrap()
            .get("get")
            .is_none());
        assert!(paths
            .get("/share-links/{linkId}")
            .unwrap()
            .get("patch")
            .is_none());
        assert_eq!(
            paths["/items/{itemId}/share-links"]["post"]["responses"]["415"]["content"]
                ["application/problem+json"]["schema"]["$ref"],
            "#/components/schemas/ProblemDetails"
        );
    }

    #[test]
    fn create_request_rejects_unknown_fields_and_caps_allowed_emails_in_schema() {
        assert!(serde_json::from_value::<CreateShareLinkRequest>(json!({
            "accessMode": "anyone",
            "expiresIn": "1day",
            "encryptedItemData": "ciphertext",
            "encryptionIv": "iv",
            "encryptedShareKey": "key",
            "shareKeyIv": "key-iv",
            "unexpected": true,
        }))
        .is_err());

        let document = serde_json::to_value(router().split_for_parts().1).unwrap();
        let schema = &document["components"]["schemas"]["CreateShareLinkRequest"]["properties"]
            ["allowedEmails"];
        assert_eq!(schema["maxItems"], 100);
    }

    #[test]
    fn non_creation_schemas_cannot_expose_the_raw_token() {
        let document = serde_json::to_value(router().split_for_parts().1).unwrap();
        let schemas = document["components"]["schemas"].as_object().unwrap();
        for (name, schema) in schemas {
            if name != "CreateShareLinkResponse" {
                assert!(
                    schema["properties"].get("token").is_none(),
                    "{name} exposes token"
                );
            }
        }
    }
}
