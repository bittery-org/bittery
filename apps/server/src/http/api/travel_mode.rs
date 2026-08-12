use axum::{
    extract::{DefaultBodyLimit, State},
    Json,
};
use serde::{Deserialize, Serialize};
use utoipa::{IntoResponses, ToSchema};
use utoipa_axum::{router::OpenApiRouter, routes};

use crate::{
    config::db_pool,
    services::{
        auth::{self, FinishLoginInput},
        travel_mode::{self, EnableTravelModeInput, SetTravelModeHiddenVaultsInput},
    },
    AppState, NotifySyncExt,
};

use super::{
    dto::ProblemDetails,
    error::ApiError,
    error_code::ErrorCode,
    extract::{ApiJson, AuthenticatedRequest},
    ORDINARY_API_BODY_LIMIT_BYTES,
};

use super::limits::MAX_BATCH_ITEMS as MAX_HIDDEN_VAULTS;

#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct HiddenVaultsRequest {
    #[schema(max_items = 100)]
    hidden_vault_ids: Vec<String>,
}

#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DisableTravelModeRequest {
    attempt_id: String,
    client_public_key: String,
    client_proof: String,
}

#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
struct TravelModeResponse {
    enabled: bool,
    #[schema(max_items = 100)]
    hidden_vault_ids: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    enabled_at: Option<String>,
    updated_at: String,
}

impl From<travel_mode::TravelModeResponse> for TravelModeResponse {
    fn from(value: travel_mode::TravelModeResponse) -> Self {
        Self {
            enabled: value.enabled,
            hidden_vault_ids: value.hidden_vault_ids,
            enabled_at: value.enabled_at,
            updated_at: value.updated_at,
        }
    }
}

#[derive(IntoResponses)]
#[allow(dead_code)]
enum TravelModeErrorResponses {
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
        status = 500,
        description = "Internal error",
        content_type = "application/problem+json"
    )]
    Internal(ProblemDetails),
}

fn enforce_hidden_vault_limit(hidden_vault_ids: &[String]) -> Result<(), ApiError> {
    if hidden_vault_ids.len() > MAX_HIDDEN_VAULTS {
        return Err(ApiError::bad_request(
            ErrorCode::TooManyHiddenVaults,
            format!("At most {MAX_HIDDEN_VAULTS} hidden vaults are allowed."),
        ));
    }
    Ok(())
}

#[utoipa::path(get, path = "/travel-mode", operation_id = "getTravelMode", tag = "travel-mode", responses((status = 200, body = TravelModeResponse), TravelModeErrorResponses))]
async fn get_travel_mode(
    State(state): State<AppState>,
    request: AuthenticatedRequest,
) -> Result<Json<TravelModeResponse>, ApiError> {
    Ok(Json(
        travel_mode::get_travel_mode(db_pool(&state)?, &request.session.user_id)
            .await?
            .into(),
    ))
}

#[utoipa::path(put, path = "/travel-mode/hidden-vaults", operation_id = "setTravelModeHiddenVaults", tag = "travel-mode", request_body = HiddenVaultsRequest, responses((status = 200, body = TravelModeResponse), TravelModeErrorResponses))]
async fn set_hidden_vaults(
    State(state): State<AppState>,
    request: AuthenticatedRequest,
    ApiJson(body): ApiJson<HiddenVaultsRequest>,
) -> Result<Json<TravelModeResponse>, ApiError> {
    enforce_hidden_vault_limit(&body.hidden_vault_ids)?;
    let response = travel_mode::set_travel_mode_hidden_vaults(
        db_pool(&state)?,
        &request.session.user_id,
        request.effective_client_id().as_deref(),
        SetTravelModeHiddenVaultsInput {
            hidden_vault_ids: body.hidden_vault_ids,
        },
    )
    .await
    .notify_sync(&state)?;
    Ok(Json(response.into()))
}

#[utoipa::path(post, path = "/travel-mode/enable", operation_id = "enableTravelMode", tag = "travel-mode", request_body = HiddenVaultsRequest, responses((status = 200, body = TravelModeResponse), TravelModeErrorResponses))]
async fn enable_travel_mode(
    State(state): State<AppState>,
    request: AuthenticatedRequest,
    ApiJson(body): ApiJson<HiddenVaultsRequest>,
) -> Result<Json<TravelModeResponse>, ApiError> {
    enforce_hidden_vault_limit(&body.hidden_vault_ids)?;
    let response = travel_mode::enable_travel_mode(
        db_pool(&state)?,
        &request.session.user_id,
        request.effective_client_id().as_deref(),
        EnableTravelModeInput {
            hidden_vault_ids: body.hidden_vault_ids,
        },
    )
    .await
    .notify_sync(&state)?;
    Ok(Json(response.into()))
}

#[utoipa::path(post, path = "/travel-mode/disable", operation_id = "disableTravelMode", tag = "travel-mode", request_body = DisableTravelModeRequest, responses((status = 200, body = TravelModeResponse), TravelModeErrorResponses))]
async fn disable_travel_mode(
    State(state): State<AppState>,
    request: AuthenticatedRequest,
    ApiJson(body): ApiJson<DisableTravelModeRequest>,
) -> Result<Json<TravelModeResponse>, ApiError> {
    let pool = db_pool(&state)?;
    auth::verify_login_proof_for_user(
        pool,
        &request.session.user_id,
        &FinishLoginInput {
            attempt_id: body.attempt_id,
            client_public_key: body.client_public_key,
            client_proof: body.client_proof,
        },
    )
    .await?;
    let response = travel_mode::disable_travel_mode(
        pool,
        &request.session.user_id,
        request.effective_client_id().as_deref(),
    )
    .await
    .notify_sync(&state)?;
    Ok(Json(response.into()))
}

pub(crate) fn router() -> OpenApiRouter<AppState> {
    OpenApiRouter::new()
        .routes(routes!(get_travel_mode))
        .routes(routes!(set_hidden_vaults))
        .routes(routes!(enable_travel_mode))
        .routes(routes!(disable_travel_mode))
        .route_layer(DefaultBodyLimit::max(ORDINARY_API_BODY_LIMIT_BYTES))
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::{enforce_hidden_vault_limit, router, HiddenVaultsRequest, MAX_HIDDEN_VAULTS};

    #[test]
    fn router_registers_all_travel_mode_operations() {
        let document = serde_json::to_value(router().split_for_parts().1).unwrap();
        assert_eq!(document.to_string().matches("operationId").count(), 4);
    }

    #[test]
    fn hidden_vault_request_is_bounded_and_rejects_unknown_fields() {
        assert!(enforce_hidden_vault_limit(&vec![String::new(); MAX_HIDDEN_VAULTS]).is_ok());
        assert!(enforce_hidden_vault_limit(&vec![String::new(); MAX_HIDDEN_VAULTS + 1]).is_err());
        assert!(serde_json::from_value::<HiddenVaultsRequest>(json!({
            "hiddenVaultIds": [],
            "unknown": true
        }))
        .is_err());
    }
}
