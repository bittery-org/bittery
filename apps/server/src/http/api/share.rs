use axum::{
    extract::{DefaultBodyLimit, Path, State},
    http::HeaderMap,
    Json,
};
use serde::{Deserialize, Serialize};
use utoipa::{IntoResponses, ToSchema};
use utoipa_axum::{router::OpenApiRouter, routes};

use crate::{
    config::db_pool,
    db::enums::ShareLinkAccessMode,
    services::share,
    shapes::{
        allowed_email_shape, create_share_link_shape, email_verification_shape,
        public_share_access_shape, public_share_info_shape, share_access_log_shape,
        share_link_list_entry_shape, share_link_list_shape,
    },
    AppState,
};

use super::{
    dto::{CursorPage, PageRequest, ProblemDetails, SuccessResponse},
    error::ApiError,
    error_code::ErrorCode,
    extract::{ApiJson, AuthenticatedRequest},
    idempotency,
    pagination::{
        decode_page_key, page_prefetched, query_limit, timestamp_cursor_key, ApiPageQuery,
    },
    ORDINARY_API_BODY_LIMIT_BYTES,
};

#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CreateShareLinkRequest {
    access_mode: ShareLinkAccessMode,
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

create_share_link_shape!(wire_struct {
    #[derive(Debug, Serialize, ToSchema)]
    #[serde(rename_all = "camelCase")]
    struct CreateShareLinkResponse
});
create_share_link_shape!(shape_from {
    share::CreateShareLinkResponse => CreateShareLinkResponse
});

allowed_email_shape!(wire_struct {
    #[derive(Debug, Serialize, ToSchema)]
    #[serde(rename_all = "camelCase")]
    struct AllowedEmailResponse
});
allowed_email_shape!(shape_from {
    share::ShareAllowedEmailSummary => AllowedEmailResponse
});

share_link_list_entry_shape!(wire_struct {
    #[derive(Debug, Serialize, ToSchema)]
    #[serde(rename_all = "camelCase")]
    struct ShareLinkListEntryResponse
}, email = AllowedEmailResponse);
share_link_list_entry_shape!(shape_from {
    share::ShareLinkListEntry => ShareLinkListEntryResponse
}, email = AllowedEmailResponse);

share_link_list_shape!(wire_struct {
    #[derive(Debug, Serialize, ToSchema)]
    #[serde(rename_all = "camelCase")]
    struct ShareLinkListResponse
}, link = ShareLinkListEntryResponse);
share_link_list_shape!(shape_from {
    share::ShareLinkListResponse => ShareLinkListResponse
}, link = ShareLinkListEntryResponse);

share_access_log_shape!(wire_struct {
    #[derive(Debug, Serialize, ToSchema)]
    #[serde(rename_all = "camelCase")]
    struct ShareAccessLogResponse
});
share_access_log_shape!(shape_from {
    share::ShareAccessLogResponse => ShareAccessLogResponse
});

public_share_info_shape!(wire_struct {
    #[derive(Debug, Serialize, ToSchema)]
    #[serde(rename_all = "camelCase")]
    struct PublicShareInfoResponse
});
public_share_info_shape!(shape_from {
    share::PublicShareInfoResponse => PublicShareInfoResponse
});

public_share_access_shape!(wire_struct {
    #[derive(Debug, Serialize, ToSchema)]
    #[serde(rename_all = "camelCase")]
    struct PublicShareAccessResponse
});
public_share_access_shape!(shape_from {
    share::PublicShareAccessResponse => PublicShareAccessResponse
});

email_verification_shape!(wire_struct {
    #[derive(Debug, Serialize, ToSchema)]
    #[serde(rename_all = "camelCase")]
    struct EmailVerificationResponse
});
email_verification_shape!(shape_from {
    share::RequestEmailVerificationResponse => EmailVerificationResponse
});

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
            ErrorCode::InvalidEmail,
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
            access_mode: body.access_mode,
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

#[utoipa::path(get, path = "/share-links/{linkId}/access-logs", operation_id = "listShareAccessLogs", tag = "share-links", params(("linkId" = String, Path), PageRequest), responses((status = 200, body = CursorPage<ShareAccessLogResponse>), ShareErrorResponses))]
async fn access_logs(
    State(state): State<AppState>,
    request: AuthenticatedRequest,
    Path(link_id): Path<String>,
    ApiPageQuery(page): ApiPageQuery,
) -> Result<Json<CursorPage<ShareAccessLogResponse>>, ApiError> {
    let cursor = decode_page_key(
        &page,
        &request.session.user_id,
        "share-access-logs",
        &link_id,
    )?
    .map(|key| timestamp_cursor_key(&key))
    .transpose()?;
    let values = share::get_share_access_logs(
        db_pool(&state)?,
        &request.session.user_id,
        share::LinkIdInput {
            link_id: link_id.clone(),
        },
        cursor,
        query_limit(&page)?,
    )
    .await?;
    let values: Vec<ShareAccessLogResponse> = values.into_iter().map(Into::into).collect();
    Ok(Json(page_prefetched(
        values,
        &page,
        &request.session.user_id,
        "share-access-logs",
        &link_id,
        |entry| format!("{}\0{}", entry.accessed_at, entry.id),
    )?))
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
    Ok((axum::http::StatusCode::ACCEPTED, Json(response.into())))
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
