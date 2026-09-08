use std::str::FromStr;

use axum::{
    body::Bytes,
    extract::{DefaultBodyLimit, Path, Query, State},
    http::HeaderMap,
    Json,
};
use serde::{Deserialize, Serialize};
use utoipa::{IntoResponses, ToSchema};
use utoipa_axum::{router::OpenApiRouter, routes};

use crate::http::{
    dto::ProblemDetails,
    error::ApiError,
    error_code::ErrorCode,
    extractors::{ApiJson, ApiJsonBytes, AuthenticatedRequest},
    openapi::ORDINARY_API_BODY_LIMIT_BYTES,
};

#[derive(IntoResponses)]
#[allow(dead_code)]
enum RotationErrorResponses {
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
        status = 409,
        description = "Operation ID reused or concurrent update requires retry",
        content_type = "application/problem+json"
    )]
    Conflict(ProblemDetails),
    #[response(
        status = 413,
        description = "Payload too large",
        content_type = "application/problem+json"
    )]
    PayloadTooLarge(ProblemDetails),
    #[response(
        status = 415,
        description = "Unsupported media type",
        content_type = "application/problem+json"
    )]
    UnsupportedMediaType(ProblemDetails),
    #[response(
        status = 422,
        description = "JSON body does not match the request schema",
        content_type = "application/problem+json"
    )]
    Unprocessable(ProblemDetails),
    #[response(
        status = 500,
        description = "Internal error",
        content_type = "application/problem+json"
    )]
    Internal(ProblemDetails),
}
use crate::{
    db::enums::VaultKeyRotationManifestKind,
    domains::vaults::rotation::plans::{self as vault_key_rotation, PreparationPage, StagedOutput},
    AppState,
};

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct PageQuery {
    cursor: Option<String>,
    limit: Option<usize>,
}

#[cfg(test)]
mod page_query_tests {
    use serde_json::json;

    #[test]
    fn unknown_preparation_query_fields_are_rejected() {
        assert!(serde_json::from_value::<super::PageQuery>(json!({ "unknown": 1 })).is_err());
    }
}
#[derive(Deserialize, ToSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StageRequest {
    outputs: Vec<StagedOutputRequest>,
}
#[derive(Deserialize, ToSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StagedOutputRequest {
    id: String,
    payload: String,
}
#[derive(Deserialize, Serialize, ToSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct FinalizePlanSetRequest {
    plan_ids: Vec<String>,
}

use crate::domains::operations::{
    self,
    rotation::{RotationEffect, RotationOperationInput},
    OperationOutcome, OperationResolution,
};
fn empty_body(
    body: Result<Bytes, axum::extract::rejection::BytesRejection>,
) -> Result<Vec<u8>, ApiError> {
    let bytes = body.map_err(|_| {
        ApiError::payload_too_large("The request body exceeds this route's byte limit")
    })?;
    if !bytes.is_empty() {
        return Err(ApiError::bad_request(
            ErrorCode::InvalidRequest,
            "This operation requires an empty body",
        ));
    }
    Ok(bytes.to_vec())
}
fn validate_plan_ids(ids: &[String], vault: bool) -> Result<(), ApiError> {
    let mut unique = std::collections::HashSet::new();
    if (vault && ids.len() != 1)
        || ids
            .iter()
            .any(|id| uuid::Uuid::parse_str(id).is_err() || !unique.insert(id))
    {
        return Err(ApiError::bad_request(
            ErrorCode::InvalidRequest,
            "Expected distinct valid Rotation plan IDs; Vault removal requires exactly one",
        ));
    }
    Ok(())
}
async fn run_operation(
    state: &AppState,
    auth: &AuthenticatedRequest,
    headers: &HeaderMap,
    effect: RotationEffect,
    raw_body: Vec<u8>,
) -> Result<Json<OperationOutcome>, ApiError> {
    let input = RotationOperationInput {
        operation_id: operations::http::required_operation_id(headers)?,
        user_id: auth.session.user_id.clone(),
        effect,
        raw_body,
        deployment_mode: state.config.server.mode,
    };
    match operations::rotation::execute(&state.db_pool, state.billing_gateway.as_deref(), input)
        .await?
    {
        OperationResolution::Outcome {
            outcome,
            newly_committed,
        } => {
            if newly_committed {
                state.notify_sync();
            }
            Ok(Json(outcome))
        }
        OperationResolution::IdReused => Err(ApiError::conflict(
            ErrorCode::OperationIdReused,
            "The Operation ID is already bound to another request",
        )),
    }
}

fn kind(value: &str) -> Result<VaultKeyRotationManifestKind, ApiError> {
    VaultKeyRotationManifestKind::from_str(value)
        .map_err(|_| ApiError::bad_request(ErrorCode::InvalidRequest, "Unknown preparation kind"))
}

#[utoipa::path(get, path="/vault-key-rotation-plans/{planId}/preparation/{kind}", operation_id="getVaultKeyRotationPreparationPage", tag="vault-key-rotation", params(("planId"=String, Path),("kind"=String, Path),("cursor"=Option<String>, Query),("limit"=Option<usize>, Query)), responses((status=200, body=PreparationPage), RotationErrorResponses))]
async fn page(
    State(state): State<AppState>,
    auth: AuthenticatedRequest,
    Path((plan_id, raw_kind)): Path<(String, String)>,
    Query(query): Query<PageQuery>,
) -> Result<Json<PreparationPage>, ApiError> {
    Ok(Json(
        vault_key_rotation::read_preparation_page(
            &state.db_pool,
            &plan_id,
            &auth.session.user_id,
            kind(&raw_kind)?,
            query.cursor.as_deref(),
            query.limit.unwrap_or(100),
        )
        .await?,
    ))
}

#[utoipa::path(put, path="/vault-key-rotation-plans/{planId}/staged/{kind}", operation_id="stageVaultKeyRotationOutputs", tag="vault-key-rotation", params(("planId"=String,Path),("kind"=String,Path)), request_body=StageRequest, responses((status=204), RotationErrorResponses))]
async fn stage(
    State(state): State<AppState>,
    auth: AuthenticatedRequest,
    Path((plan_id, raw_kind)): Path<(String, String)>,
    ApiJson(body): ApiJson<StageRequest>,
) -> Result<(), ApiError> {
    let outputs: Vec<_> = body
        .outputs
        .into_iter()
        .map(|v| StagedOutput {
            id: v.id,
            payload: v.payload,
        })
        .collect();
    vault_key_rotation::stage_outputs(
        &state.db_pool,
        &plan_id,
        &auth.session.user_id,
        kind(&raw_kind)?,
        &outputs,
    )
    .await?;
    Ok(())
}

#[utoipa::path(delete, path="/vault-key-rotation-plans/{planId}", operation_id="abandonVaultKeyRotationPlan", tag="vault-key-rotation", params(("planId"=String,Path)), responses((status=204), RotationErrorResponses))]
async fn abandon(
    State(state): State<AppState>,
    auth: AuthenticatedRequest,
    Path(plan_id): Path<String>,
) -> Result<(), ApiError> {
    vault_key_rotation::abandon_plan(&state.db_pool, &plan_id, &auth.session.user_id).await?;
    Ok(())
}

#[utoipa::path(post, path="/vaults/{vaultId}/members/{userId}/removal-rotation-plans", operation_id="createVaultMemberRemovalRotationPlans", tag="vault-key-rotation", params(("vaultId"=String,Path),("userId"=String,Path),("Idempotency-Key"=String,Header)), responses((status=200,body=OperationOutcome), RotationErrorResponses))]
async fn start_vault_member_removal(
    State(state): State<AppState>,
    auth: AuthenticatedRequest,
    headers: HeaderMap,
    Path((vault_id, user_id)): Path<(String, String)>,
    body: Result<Bytes, axum::extract::rejection::BytesRejection>,
) -> Result<Json<OperationOutcome>, ApiError> {
    let body = empty_body(body)?;
    run_operation(
        &state,
        &auth,
        &headers,
        RotationEffect::CreateVaultRemoval {
            vault_id,
            target_id: user_id,
        },
        body,
    )
    .await
}

#[utoipa::path(post, path="/vaults/{vaultId}/members/{userId}/removal-rotation-plans/finalize", operation_id="finalizeVaultMemberRemovalRotationPlans", tag="vault-key-rotation", params(("vaultId"=String,Path),("userId"=String,Path),("Idempotency-Key"=String,Header)), request_body=FinalizePlanSetRequest, responses((status=200,body=OperationOutcome), RotationErrorResponses))]
async fn finalize_vault_member_removal(
    State(state): State<AppState>,
    auth: AuthenticatedRequest,
    headers: HeaderMap,
    Path((vault_id, user_id)): Path<(String, String)>,
    body: ApiJsonBytes<FinalizePlanSetRequest, ORDINARY_API_BODY_LIMIT_BYTES>,
) -> Result<Json<OperationOutcome>, ApiError> {
    validate_plan_ids(&body.value.plan_ids, true)?;
    run_operation(
        &state,
        &auth,
        &headers,
        RotationEffect::FinalizeVaultRemoval {
            vault_id,
            target_id: user_id,
            plan_id: body.value.plan_ids[0].clone(),
        },
        body.bytes,
    )
    .await
}

#[utoipa::path(post, path="/teams/{teamId}/leave-rotation-plans", operation_id="createTeamLeaveRotationPlans", tag="vault-key-rotation", params(("teamId"=String,Path),("Idempotency-Key"=String,Header)), responses((status=200,body=OperationOutcome), RotationErrorResponses))]
async fn start_team_leave(
    State(state): State<AppState>,
    auth: AuthenticatedRequest,
    headers: HeaderMap,
    Path(team_id): Path<String>,
    body: Result<Bytes, axum::extract::rejection::BytesRejection>,
) -> Result<Json<OperationOutcome>, ApiError> {
    let body = empty_body(body)?;
    run_operation(
        &state,
        &auth,
        &headers,
        RotationEffect::CreateTeamLeave { team_id },
        body,
    )
    .await
}

#[utoipa::path(post, path="/teams/{teamId}/members/{userId}/removal-rotation-plans", operation_id="createTeamMemberRemovalRotationPlans", tag="vault-key-rotation", params(("teamId"=String,Path),("userId"=String,Path),("Idempotency-Key"=String,Header)), responses((status=200,body=OperationOutcome), RotationErrorResponses))]
async fn start_team_member_removal(
    State(state): State<AppState>,
    auth: AuthenticatedRequest,
    headers: HeaderMap,
    Path((team_id, user_id)): Path<(String, String)>,
    body: Result<Bytes, axum::extract::rejection::BytesRejection>,
) -> Result<Json<OperationOutcome>, ApiError> {
    let body = empty_body(body)?;
    run_operation(
        &state,
        &auth,
        &headers,
        RotationEffect::CreateTeamRemoval {
            team_id,
            target_id: user_id,
        },
        body,
    )
    .await
}

#[utoipa::path(post, path="/teams/{teamId}/leave-rotation-plans/finalize", operation_id="finalizeTeamLeaveRotationPlans", tag="vault-key-rotation", params(("teamId"=String,Path),("Idempotency-Key"=String,Header)), request_body=FinalizePlanSetRequest, responses((status=200,body=OperationOutcome), RotationErrorResponses))]
async fn finalize_team_leave(
    State(state): State<AppState>,
    auth: AuthenticatedRequest,
    headers: HeaderMap,
    Path(team_id): Path<String>,
    body: ApiJsonBytes<FinalizePlanSetRequest, ORDINARY_API_BODY_LIMIT_BYTES>,
) -> Result<Json<OperationOutcome>, ApiError> {
    validate_plan_ids(&body.value.plan_ids, false)?;
    run_operation(
        &state,
        &auth,
        &headers,
        RotationEffect::FinalizeTeamLeave {
            team_id,
            plan_ids: body.value.plan_ids,
        },
        body.bytes,
    )
    .await
}

#[utoipa::path(post, path="/teams/{teamId}/members/{userId}/removal-rotation-plans/finalize", operation_id="finalizeTeamMemberRemovalRotationPlans", tag="vault-key-rotation", params(("teamId"=String,Path),("userId"=String,Path),("Idempotency-Key"=String,Header)), request_body=FinalizePlanSetRequest, responses((status=200,body=OperationOutcome), RotationErrorResponses))]
async fn finalize_team_member_removal(
    State(state): State<AppState>,
    auth: AuthenticatedRequest,
    headers: HeaderMap,
    Path((team_id, user_id)): Path<(String, String)>,
    body: ApiJsonBytes<FinalizePlanSetRequest, ORDINARY_API_BODY_LIMIT_BYTES>,
) -> Result<Json<OperationOutcome>, ApiError> {
    validate_plan_ids(&body.value.plan_ids, false)?;
    run_operation(
        &state,
        &auth,
        &headers,
        RotationEffect::FinalizeTeamRemoval {
            team_id,
            target_id: user_id,
            plan_ids: body.value.plan_ids,
        },
        body.bytes,
    )
    .await
}

pub(crate) fn router() -> OpenApiRouter<AppState> {
    OpenApiRouter::new()
        .routes(routes!(page))
        .routes(routes!(stage))
        .routes(routes!(abandon))
        .routes(routes!(start_vault_member_removal))
        .routes(routes!(finalize_vault_member_removal))
        .routes(routes!(start_team_leave))
        .routes(routes!(finalize_team_leave))
        .routes(routes!(start_team_member_removal))
        .routes(routes!(finalize_team_member_removal))
        .route_layer(DefaultBodyLimit::max(ORDINARY_API_BODY_LIMIT_BYTES))
}

#[cfg(test)]
mod body_limit_tests {
    use axum::http::{Method, StatusCode};

    use crate::http::openapi::ORDINARY_API_BODY_LIMIT_BYTES;
    use crate::test_support::{authenticated_json_headers, seed_user, with_api_test_app};

    #[tokio::test]
    async fn rotation_staging_rejects_an_oversized_body() {
        with_api_test_app("rotation_stage_body_limit", |app| async move {
            let user_id = "rotation-body-limit-user";
            seed_user(
                &app.pool,
                user_id,
                "Rotation Body Limit",
                "rotation-body-limit@example.com",
            )
            .await;
            let session = app.issue_session(user_id).await;
            let oversized_payload = "x".repeat(ORDINARY_API_BODY_LIMIT_BYTES);
            let body =
                format!(r#"{{"outputs":[{{"id":"item","payload":"{oversized_payload}"}}]}}"#)
                    .into_bytes();

            let response = app
                .api_bytes(
                    Method::PUT,
                    "/api/v1/vault-key-rotation-plans/missing/staged/item",
                    body,
                    authenticated_json_headers(&session.token),
                )
                .await;

            assert_eq!(response.status, StatusCode::PAYLOAD_TOO_LARGE);
            assert_eq!(response.body["code"], "PAYLOAD_TOO_LARGE");
        })
        .await;
    }
}

#[cfg(test)]
#[path = "rotation_tests.rs"]
mod rotation_tests;
