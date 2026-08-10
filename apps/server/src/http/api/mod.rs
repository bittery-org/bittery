pub(crate) mod audit;
pub(crate) mod auth;
pub(crate) mod billing;
pub(crate) mod dto;
pub(crate) mod error;
pub(crate) mod extract;
pub(crate) mod idempotency;
pub(crate) mod pagination;
pub(crate) mod share;
pub(crate) mod sync;
pub(crate) mod team;
pub(crate) mod travel_mode;
pub(crate) mod vault;

pub(crate) const ORDINARY_API_BODY_LIMIT_BYTES: usize = 1_048_576;

use axum::{
    extract::{Request, State},
    http::HeaderValue,
    middleware::Next,
    response::Response,
    Json, Router,
};
use utoipa::OpenApi;
use utoipa_axum::{router::OpenApiRouter, routes};

use crate::AppState;

use self::{
    dto::{ApiLimits, ApiMetadata, ApiVersionMetadata, RegistrationMetadata},
    error::ApiError,
};

#[derive(OpenApi)]
#[openapi(
    info(
        title = "Bittery API",
        version = "1.0.0",
        description = "The versioned Bittery HTTP API contract."
    ),
    components(schemas(
        ApiMetadata,
        ApiVersionMetadata,
        ApiLimits,
        RegistrationMetadata,
        dto::DecimalString,
        dto::PageCursor,
        dto::SyncCursor,
        dto::PageRequest,
        dto::ProblemDetails,
        dto::ProblemFieldError,
        share::ShareToken
    )),
    tags((name = "meta", description = "Protocol discovery and server capabilities"))
)]
struct ApiDoc;

#[utoipa::path(
    get,
    path = "/meta",
    operation_id = "getApiMetadata",
    tag = "meta",
    responses(
        (status = 200, description = "Server protocol metadata", body = ApiMetadata),
        (status = 500, description = "Metadata lookup failed", body = dto::ProblemDetails, content_type = "application/problem+json")
    )
)]
async fn get_meta(State(state): State<AppState>) -> Result<Json<ApiMetadata>, ApiError> {
    let registration = crate::services::auth::registration_status(&state).await?;
    Ok(Json(ApiMetadata::current(RegistrationMetadata {
        mode: registration.mode,
        billing_enabled: registration.billing_enabled,
        allow_public_signup: registration.allow_public_signup,
        requires_email_verification: registration.requires_email_verification,
        reason: registration.reason,
    })))
}

fn openapi_router() -> OpenApiRouter<AppState> {
    OpenApiRouter::with_openapi(ApiDoc::openapi()).nest(
        "/api",
        OpenApiRouter::new().routes(routes!(get_meta)).nest(
            "/v1",
            auth::router()
                .merge(vault::router())
                .merge(sync::router())
                .merge(team::router())
                .merge(share::router())
                .merge(billing::router())
                .merge(travel_mode::router())
                .merge(audit::router()),
        ),
    )
}

pub(crate) fn create_api_router() -> Router<AppState> {
    openapi_router().split_for_parts().0
}

pub(crate) async fn response_headers(request: Request, next: Next) -> Response {
    let mut response = next.run(request).await;
    response
        .headers_mut()
        .insert("bittery-api-version", HeaderValue::from_static("1"));
    if !response.headers().contains_key("bittery-request-id") {
        let request_id = uuid::Uuid::new_v4().to_string();
        if let Ok(value) = HeaderValue::from_str(&request_id) {
            response.headers_mut().insert("bittery-request-id", value);
        }
    }
    response
}

pub fn openapi_json() -> String {
    let mut output = serde_json::to_string_pretty(&openapi_router().split_for_parts().1)
        .expect("OpenAPI document should serialize");
    output.push('\n');
    output
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    #[test]
    fn openapi_generation_is_deterministic_and_current() {
        let first = super::openapi_json();
        let second = super::openapi_json();
        assert_eq!(first, second);

        let artifact = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../..")
            .join("packages/api-contract/openapi.v1.json");
        assert_eq!(
            std::fs::read_to_string(&artifact).expect("checked OpenAPI artifact should exist"),
            first,
            "run `cargo run --manifest-path apps/server/Cargo.toml --bin write-openapi`"
        );
    }

    #[test]
    fn route_registry_and_openapi_cover_the_complete_v1_surface() {
        let (_, document) = super::openapi_router().split_for_parts();
        let value = serde_json::to_value(document).expect("OpenAPI should serialize");
        let paths = value["paths"]
            .as_object()
            .expect("OpenAPI paths should be an object");
        let operation_count = paths
            .values()
            .map(|path| {
                path.as_object()
                    .expect("OpenAPI path item should be an object")
                    .values()
                    .filter(|operation| operation.get("operationId").is_some())
                    .count()
            })
            .sum::<usize>();

        assert_eq!(paths.len(), 85);
        assert_eq!(operation_count, 100);
    }
}
