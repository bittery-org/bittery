use std::str::FromStr;

use axum::{
    extract::{DefaultBodyLimit, Path, Query, State},
    http::HeaderMap,
    response::{IntoResponse, Response},
    Json,
};
use serde::{Deserialize, Serialize};
use utoipa::{IntoResponses, ToSchema};
use utoipa_axum::{router::OpenApiRouter, routes};

use crate::http::{
    dto::ProblemDetails,
    error::ApiError,
    error_code::ErrorCode,
    extractors::{ApiJson, AuthenticatedRequest},
    idempotency,
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
        description = "Rotation plan is stale or conflicts with current state",
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
        description = "Idempotency key was reused with a different request",
        content_type = "application/problem+json"
    )]
    Unprocessable(ProblemDetails),
    #[response(
        status = 500,
        description = "Internal error",
        content_type = "application/problem+json"
    )]
    Internal(ProblemDetails),
    #[response(status = 503, description = "An identical idempotent request is still pending", content_type = "application/problem+json", headers(("Retry-After" = String, description = "Seconds before retrying")))]
    ServiceUnavailable(ProblemDetails),
}
use crate::{
    db::enums::VaultKeyRotationManifestKind,
    domains::vaults::rotation::{
        departure as member_departure, membership as vault_membership,
        plans::{
            self as vault_key_rotation, PreparationPage, RotationPlanSummary, RotationResult,
            StagedOutput,
        },
    },
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
#[derive(Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
struct FinalizeResponse {
    plan_id: String,
    vault_id: String,
    key_version: i32,
    rotation_id: String,
}

#[derive(Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
struct PlanSetResponse {
    plans: Vec<RotationPlanSummary>,
}

#[derive(Deserialize, Serialize, ToSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct FinalizePlanSetRequest {
    plan_ids: Vec<String>,
}

#[derive(Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
struct FinalizePlanSetResponse {
    personal_team_id: Option<String>,
    rotations: Vec<FinalizeResponse>,
}

impl From<RotationResult> for FinalizeResponse {
    fn from(v: RotationResult) -> Self {
        Self {
            plan_id: v.plan_id,
            vault_id: v.vault_id,
            key_version: v.key_version,
            rotation_id: v.rotation_id,
        }
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

#[utoipa::path(post, path="/vaults/{vaultId}/members/{userId}/removal-rotation-plans", operation_id="createVaultMemberRemovalRotationPlans", tag="vault-members", params(("vaultId"=String,Path),("userId"=String,Path),("Idempotency-Key"=Option<String>,Header)), responses((status=200,body=PlanSetResponse,headers(("Idempotency-Replayed"=String,description="true when this is a stored replay"))), RotationErrorResponses))]
async fn start_vault_member_removal(
    State(state): State<AppState>,
    auth: AuthenticatedRequest,
    headers: HeaderMap,
    Path((vault_id, user_id)): Path<(String, String)>,
) -> Result<Response, ApiError> {
    let pool = state.db_pool.clone();
    let deployment_mode = state.config.server.mode;
    let route = format!("/api/v1/vaults/{vault_id}/members/{user_id}/removal-rotation-plans");
    idempotency::execute(
        pool,
        &headers,
        auth.session.user_id.clone(),
        "POST",
        &route,
        &[],
        move |pool, actor| async move {
            let plan = vault_membership::create_removal_plan(
                &pool,
                deployment_mode,
                &actor,
                &vault_id,
                &user_id,
            )
            .await?;
            Ok(Json(PlanSetResponse { plans: vec![plan] }).into_response())
        },
    )
    .await
}

#[utoipa::path(post, path="/vaults/{vaultId}/members/{userId}/removal-rotation-plans/finalize", operation_id="finalizeVaultMemberRemovalRotationPlans", tag="vault-members", params(("vaultId"=String,Path),("userId"=String,Path),("Idempotency-Key"=Option<String>,Header)), request_body=FinalizePlanSetRequest, responses((status=200,body=FinalizePlanSetResponse,headers(("Idempotency-Replayed"=String,description="true when this is a stored replay"))), RotationErrorResponses))]
async fn finalize_vault_member_removal(
    State(state): State<AppState>,
    auth: AuthenticatedRequest,
    headers: HeaderMap,
    Path((vault_id, user_id)): Path<(String, String)>,
    ApiJson(body): ApiJson<FinalizePlanSetRequest>,
) -> Result<Response, ApiError> {
    if body.plan_ids.len() != 1 {
        return Err(ApiError::bad_request(
            ErrorCode::InvalidRequest,
            "Vault Member removal requires exactly one Rotation plan",
        ));
    }
    let bytes = serde_json::to_vec(&body).map_err(|_| ApiError::internal())?;
    let pool = state.db_pool.clone();
    let deployment_mode = state.config.server.mode;
    let plan_id = body.plan_ids[0].clone();
    let route =
        format!("/api/v1/vaults/{vault_id}/members/{user_id}/removal-rotation-plans/finalize");
    let response = idempotency::execute(
        pool,
        &headers,
        auth.session.user_id.clone(),
        "POST",
        &route,
        &bytes,
        move |pool, actor| async move {
            let result = vault_membership::finalize_removal(
                &pool,
                deployment_mode,
                &actor,
                &vault_id,
                &user_id,
                &plan_id,
            )
            .await?;
            Ok(Json(FinalizePlanSetResponse {
                personal_team_id: None,
                rotations: vec![result.rotation.into()],
            })
            .into_response())
        },
    )
    .await?;
    state.notify_sync();
    Ok(response)
}

#[utoipa::path(post, path="/teams/{teamId}/leave-rotation-plans", operation_id="createTeamLeaveRotationPlans", tag="teams", params(("teamId"=String,Path),("Idempotency-Key"=Option<String>,Header)), responses((status=200,body=PlanSetResponse,headers(("Idempotency-Replayed"=String,description="true when this is a stored replay"))), RotationErrorResponses))]
async fn start_team_leave(
    State(state): State<AppState>,
    auth: AuthenticatedRequest,
    headers: HeaderMap,
    Path(team_id): Path<String>,
) -> Result<Response, ApiError> {
    let pool = state.db_pool.clone();
    let deployment_mode = state.config.server.mode;
    let route = format!("/api/v1/teams/{team_id}/leave-rotation-plans");
    idempotency::execute(
        pool,
        &headers,
        auth.session.user_id.clone(),
        "POST",
        &route,
        &[],
        move |pool, actor| async move {
            let result =
                member_departure::create_voluntary_plans(&pool, deployment_mode, &team_id, &actor)
                    .await?;
            Ok(Json(PlanSetResponse {
                plans: result.plans,
            })
            .into_response())
        },
    )
    .await
}

#[utoipa::path(post, path="/teams/{teamId}/members/{userId}/removal-rotation-plans", operation_id="createTeamMemberRemovalRotationPlans", tag="team-members", params(("teamId"=String,Path),("userId"=String,Path),("Idempotency-Key"=Option<String>,Header)), responses((status=200,body=PlanSetResponse,headers(("Idempotency-Replayed"=String,description="true when this is a stored replay"))), RotationErrorResponses))]
async fn start_team_member_removal(
    State(state): State<AppState>,
    auth: AuthenticatedRequest,
    headers: HeaderMap,
    Path((team_id, user_id)): Path<(String, String)>,
) -> Result<Response, ApiError> {
    let pool = state.db_pool.clone();
    let deployment_mode = state.config.server.mode;
    let route = format!("/api/v1/teams/{team_id}/members/{user_id}/removal-rotation-plans");
    idempotency::execute(
        pool,
        &headers,
        auth.session.user_id.clone(),
        "POST",
        &route,
        &[],
        move |pool, actor| async move {
            let result = member_departure::create_administrative_plans(
                &pool,
                deployment_mode,
                &team_id,
                &actor,
                &user_id,
            )
            .await?;
            Ok(Json(PlanSetResponse {
                plans: result.plans,
            })
            .into_response())
        },
    )
    .await
}

async fn finalize_departure(
    state: &AppState,
    auth: &AuthenticatedRequest,
    headers: &HeaderMap,
    team_id: String,
    target_id: String,
    body: FinalizePlanSetRequest,
    administrative: bool,
) -> Result<Response, ApiError> {
    let bytes = serde_json::to_vec(&body).map_err(|_| ApiError::internal())?;
    let pool = state.db_pool.clone();
    let billing_gateway = state.billing_gateway.clone();
    let deployment_mode = state.config.server.mode;
    let route = if administrative {
        format!("/api/v1/teams/{team_id}/members/{target_id}/removal-rotation-plans/finalize")
    } else {
        format!("/api/v1/teams/{team_id}/leave-rotation-plans/finalize")
    };
    let response = idempotency::execute(
        pool,
        headers,
        auth.session.user_id.clone(),
        "POST",
        &route,
        &bytes,
        move |pool, actor| async move {
            let result = if administrative {
                member_departure::finalize_administrative(
                    &pool,
                    billing_gateway.as_deref(),
                    deployment_mode,
                    &team_id,
                    &actor,
                    &target_id,
                    &body.plan_ids,
                )
                .await?
            } else {
                member_departure::finalize_voluntary(
                    &pool,
                    billing_gateway.as_deref(),
                    deployment_mode,
                    &team_id,
                    &actor,
                    &body.plan_ids,
                )
                .await?
            };
            Ok(Json(FinalizePlanSetResponse {
                personal_team_id: Some(result.personal_team_id),
                rotations: result.rotations.into_iter().map(Into::into).collect(),
            })
            .into_response())
        },
    )
    .await?;
    state.notify_sync();
    Ok(response)
}

#[utoipa::path(post, path="/teams/{teamId}/leave-rotation-plans/finalize", operation_id="finalizeTeamLeaveRotationPlans", tag="teams", params(("teamId"=String,Path),("Idempotency-Key"=Option<String>,Header)), request_body=FinalizePlanSetRequest, responses((status=200,body=FinalizePlanSetResponse,headers(("Idempotency-Replayed"=String,description="true when this is a stored replay"))), RotationErrorResponses))]
async fn finalize_team_leave(
    State(state): State<AppState>,
    auth: AuthenticatedRequest,
    headers: HeaderMap,
    Path(team_id): Path<String>,
    ApiJson(body): ApiJson<FinalizePlanSetRequest>,
) -> Result<Response, ApiError> {
    let target = auth.session.user_id.clone();
    finalize_departure(&state, &auth, &headers, team_id, target, body, false).await
}

#[utoipa::path(post, path="/teams/{teamId}/members/{userId}/removal-rotation-plans/finalize", operation_id="finalizeTeamMemberRemovalRotationPlans", tag="team-members", params(("teamId"=String,Path),("userId"=String,Path),("Idempotency-Key"=Option<String>,Header)), request_body=FinalizePlanSetRequest, responses((status=200,body=FinalizePlanSetResponse,headers(("Idempotency-Replayed"=String,description="true when this is a stored replay"))), RotationErrorResponses))]
async fn finalize_team_member_removal(
    State(state): State<AppState>,
    auth: AuthenticatedRequest,
    headers: HeaderMap,
    Path((team_id, user_id)): Path<(String, String)>,
    ApiJson(body): ApiJson<FinalizePlanSetRequest>,
) -> Result<Response, ApiError> {
    finalize_departure(&state, &auth, &headers, team_id, user_id, body, true).await
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
