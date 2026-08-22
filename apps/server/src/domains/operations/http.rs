use axum::{
    extract::{Path, State},
    http::{HeaderMap, HeaderValue},
    Json,
};
use utoipa_axum::{router::OpenApiRouter, routes};

use crate::{
    http::{
        dto::ProblemDetails, error::ApiError, error_code::ErrorCode,
        extractors::AuthenticatedRequest,
    },
    AppState,
};

use super::CreateItemOperationOutcome;

fn operation_id(headers: &HeaderMap) -> Result<String, ApiError> {
    let value = headers.get("idempotency-key").ok_or_else(|| {
        ApiError::bad_request(
            ErrorCode::InvalidOperationId,
            "Idempotency-Key is required and carries the stable Operation ID.",
        )
    })?;
    validate_operation_id(value)
}

fn validate_operation_id(value: &HeaderValue) -> Result<String, ApiError> {
    let value = value.to_str().map_err(|_| {
        ApiError::bad_request(
            ErrorCode::InvalidOperationId,
            "The Operation ID must contain visible ASCII characters.",
        )
    })?;
    validate_operation_id_str(value)
}

fn validate_operation_id_str(value: &str) -> Result<String, ApiError> {
    if value.is_empty()
        || value.len() > 255
        || !value.bytes().all(|byte| (0x21..=0x7e).contains(&byte))
    {
        return Err(ApiError::bad_request(
            ErrorCode::InvalidOperationId,
            "The Operation ID must be 1 to 255 visible ASCII characters.",
        ));
    }
    Ok(value.to_owned())
}

pub(crate) fn required_operation_id(headers: &HeaderMap) -> Result<String, ApiError> {
    operation_id(headers)
}

#[utoipa::path(
    get,
    path = "/operations/{operationId}",
    operation_id = "getOperationOutcome",
    tag = "operations",
    params(("operationId" = String, Path)),
    responses(
        (status = 200, description = "Retained semantic Operation outcome", body = CreateItemOperationOutcome),
        (status = 400, description = "Malformed Operation ID", body = ProblemDetails, content_type = "application/problem+json"),
        (status = 401, description = "Authentication required", body = ProblemDetails, content_type = "application/problem+json"),
        (status = 404, description = "No outcome exists for this User and Operation ID", body = ProblemDetails, content_type = "application/problem+json"),
        (status = 500, description = "Internal error", body = ProblemDetails, content_type = "application/problem+json")
    )
)]
async fn get_operation_outcome(
    State(state): State<AppState>,
    auth: AuthenticatedRequest,
    Path(operation_id): Path<String>,
) -> Result<Json<CreateItemOperationOutcome>, ApiError> {
    let operation_id = validate_operation_id_str(&operation_id)?;
    let outcome =
        super::get_create_item_outcome(&state.db_pool, &auth.session.user_id, &operation_id)
            .await?
            .ok_or_else(|| {
                ApiError::not_found(
                    ErrorCode::OperationOutcomeNotFound,
                    "Operation outcome not found.",
                )
            })?;
    Ok(Json(outcome))
}

pub(crate) fn router() -> OpenApiRouter<AppState> {
    OpenApiRouter::new().routes(routes!(get_operation_outcome))
}
