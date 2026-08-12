pub(crate) mod audit;
pub(crate) mod auth;
pub(crate) mod billing;
pub(crate) mod dto;
pub(crate) mod error;
pub(crate) mod error_code;
pub(crate) mod extract;
pub(crate) mod idempotency;
pub(crate) mod limits;
pub(crate) mod pagination;
mod security;
pub(crate) mod share;
pub(crate) mod sync;
pub(crate) mod team;
pub(crate) mod travel_mode;
pub(crate) mod vault;
pub(crate) mod vault_key_rotation;

pub(crate) const ORDINARY_API_BODY_LIMIT_BYTES: usize = 1_048_576;

use axum::{
    extract::{Request, State},
    http::HeaderValue,
    middleware::Next,
    response::{IntoResponse, Response},
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
        error_code::ErrorCode,
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
    Ok(Json(ApiMetadata::current(
        RegistrationMetadata {
            mode: registration.mode,
            billing_enabled: registration.billing_enabled,
            allow_public_signup: registration.allow_public_signup,
            requires_email_verification: registration.requires_email_verification,
            reason: registration.reason,
        },
        crate::config::insecure_http_enabled(),
    )))
}

fn openapi_router() -> OpenApiRouter<AppState> {
    let mut router = OpenApiRouter::with_openapi(ApiDoc::openapi()).nest(
        "/api",
        OpenApiRouter::new().routes(routes!(get_meta)).nest(
            "/v1",
            auth::router()
                .merge(vault::router())
                .merge(vault_key_rotation::router())
                .merge(sync::router())
                .merge(team::router())
                .merge(share::router())
                .merge(billing::router())
                .merge(travel_mode::router())
                .merge(audit::router()),
        ),
    );
    security::apply_security_contract(router.get_openapi_mut());
    router
}

pub(crate) fn create_api_router() -> Router<AppState> {
    openapi_router()
        .split_for_parts()
        .0
        .method_not_allowed_fallback(api_method_not_allowed)
        .nest("/api", Router::new().fallback(api_route_not_found))
}

async fn api_route_not_found() -> Response {
    ApiError::api_route_not_found().into_response()
}

async fn api_method_not_allowed() -> Response {
    ApiError::method_not_allowed().into_response()
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

    use axum::{
        body::{to_bytes, Body},
        http::{header, Method, Request, StatusCode},
    };
    use serde_json::{json, Value};
    use tower::util::ServiceExt;

    use crate::AppState;

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

        assert_eq!(paths.len(), 90);
        assert_eq!(operation_count, 104);
    }

    /// Every `ToSchema` type reaches the document under its short Rust name, so two types that
    /// share a name are one component and only the last one merged survives. The runtime check
    /// below only sees the survivor, so catch the collision where both still exist: in the source.
    ///
    /// A name is counted when a `#[derive(..., ToSchema, ...)]` precedes its `struct`/`enum`, or
    /// when it is declared through the `request_dto!`/`response_dto!` macros, which always derive
    /// it. Anything the scan cannot resolve is simply not counted, so it never fails spuriously.
    #[test]
    fn every_schema_type_name_is_declared_once() {
        use std::collections::BTreeMap;

        let mut sources = vec![PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("src/db/enums.rs")];
        let api_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("src/http/api");
        for entry in std::fs::read_dir(&api_dir).expect("http/api should be readable") {
            let path = entry.expect("directory entry should be readable").path();
            if path.extension().is_some_and(|extension| extension == "rs") {
                sources.push(path);
            }
        }
        sources.sort();

        let mut declarations: BTreeMap<String, Vec<String>> = BTreeMap::new();
        for path in &sources {
            let source = std::fs::read_to_string(path).expect("source file should be readable");
            // Test fixtures are never registered as components and may reuse helper names.
            let source = source.split("\n#[cfg(test)]").next().unwrap_or_default();
            let file = path
                .file_name()
                .and_then(|name| name.to_str())
                .unwrap_or_default()
                .to_string();

            let mut derives_to_schema = false;
            for line in source.lines() {
                let trimmed = line.trim();
                if trimmed.is_empty() {
                    derives_to_schema = false;
                    continue;
                }
                if trimmed.starts_with("#[derive(") {
                    derives_to_schema = trimmed.contains("ToSchema");
                    continue;
                }
                let declared = if derives_to_schema {
                    let unqualified = trimmed
                        .strip_prefix("pub(crate) ")
                        .or_else(|| trimmed.strip_prefix("pub "))
                        .unwrap_or(trimmed);
                    unqualified
                        .strip_prefix("struct ")
                        .or_else(|| unqualified.strip_prefix("enum "))
                } else {
                    trimmed
                        .strip_prefix("request_dto!(")
                        .or_else(|| trimmed.strip_prefix("response_dto!("))
                };
                let Some(rest) = declared else {
                    continue;
                };
                let name = rest
                    .trim_start()
                    .split(|character: char| !character.is_alphanumeric() && character != '_')
                    .next()
                    .unwrap_or_default();
                if !name.is_empty() {
                    declarations
                        .entry(name.to_string())
                        .or_default()
                        .push(file.clone());
                }
                derives_to_schema = false;
            }
        }

        assert!(
            declarations.contains_key("PresignedUploadResponse"),
            "the scan stopped recognising schema declarations; it found {} names",
            declarations.len()
        );

        let duplicates = declarations
            .iter()
            .filter(|(_, files)| files.len() > 1)
            .map(|(name, files)| format!("{name} ({})", files.join(", ")))
            .collect::<Vec<_>>();
        assert!(
            duplicates.is_empty(),
            "these schema type names are declared more than once; utoipa keys components by short \
             name, so only one of each reaches openapi.v1.json. Share one declaration or rename \
             with #[schema(as = ...)]: {}",
            duplicates.join(", ")
        );
    }

    /// utoipa keys components by the type's short name, so two `ToSchema` types that share a name
    /// silently overwrite each other and the document publishes only the last one merged. Compare
    /// the per-module documents before they are merged, where both definitions still exist.
    #[test]
    fn no_two_schema_types_share_a_component_name() {
        use std::collections::BTreeMap;

        use utoipa::OpenApi;

        let modules = [
            ("<root>", super::ApiDoc::openapi()),
            ("audit", super::audit::router().into_openapi()),
            ("auth", super::auth::router().into_openapi()),
            ("billing", super::billing::router().into_openapi()),
            ("share", super::share::router().into_openapi()),
            ("sync", super::sync::router().into_openapi()),
            ("team", super::team::router().into_openapi()),
            ("travel_mode", super::travel_mode::router().into_openapi()),
            ("vault", super::vault::router().into_openapi()),
            (
                "vault_key_rotation",
                super::vault_key_rotation::router().into_openapi(),
            ),
        ];

        // name -> serialized schema -> modules that registered exactly that schema.
        let mut definitions: BTreeMap<String, BTreeMap<String, Vec<&str>>> = BTreeMap::new();
        for (module, document) in &modules {
            let Some(components) = document.components.as_ref() else {
                continue;
            };
            for (name, schema) in &components.schemas {
                let serialized =
                    serde_json::to_string(schema).expect("component schema should serialize");
                definitions
                    .entry(name.clone())
                    .or_default()
                    .entry(serialized)
                    .or_default()
                    .push(module);
            }
        }

        let collisions = definitions
            .iter()
            .filter(|(_, variants)| variants.len() > 1)
            .map(|(name, variants)| {
                let modules = variants
                    .values()
                    .map(|modules| modules.join("+"))
                    .collect::<Vec<_>>()
                    .join(" vs ");
                format!("{name} ({modules})")
            })
            .collect::<Vec<_>>();

        assert!(
            collisions.is_empty(),
            "these component names are registered with conflicting schemas, so only one survives \
             into openapi.v1.json; rename or unify them: {}",
            collisions.join(", ")
        );

        // A duplicate that survives the check above is still a name two modules both own, so the
        // merged document must publish every distinct name exactly once.
        let published = serde_json::to_value(super::openapi_router().split_for_parts().1)
            .expect("OpenAPI should serialize");
        assert_eq!(
            published["components"]["schemas"]
                .as_object()
                .expect("components.schemas should be an object")
                .len(),
            definitions.len(),
            "merged component count must match the number of distinct registered schema names"
        );
    }

    #[test]
    fn every_operation_has_exactly_one_explicit_security_classification() {
        let (_, document) = super::openapi_router().split_for_parts();
        let value = serde_json::to_value(document).expect("OpenAPI should serialize");
        assert_eq!(
            value["components"]["securitySchemes"]["bearerAuth"],
            json!({
                "type": "http",
                "scheme": "bearer",
                "bearerFormat": "opaque session token",
                "description": "Device-session bearer token. Client metadata headers are not credentials."
            })
        );
        assert!(value.get("security").is_none());

        let operations = value["paths"]
            .as_object()
            .unwrap()
            .values()
            .flat_map(|path| path.as_object().unwrap().values())
            .filter(|operation| operation.get("operationId").is_some())
            .collect::<Vec<_>>();
        let public = operations
            .iter()
            .filter(|operation| operation["security"] == json!([{}]))
            .count();
        let bearer = operations
            .iter()
            .filter(|operation| operation["security"] == json!([{ "bearerAuth": [] }]))
            .count();

        assert_eq!(public, 17);
        assert_eq!(bearer, 87);
        assert_eq!(public + bearer, operations.len());

        for operation_id in [
            "getApiMetadata",
            "getRegistrationStatus",
            "start_login",
            "getPublicShareInfo",
            "accessPublicShare",
            "getTeamInvitation",
        ] {
            let operation = operations
                .iter()
                .find(|operation| operation["operationId"] == operation_id)
                .unwrap_or_else(|| panic!("missing operation {operation_id}"));
            assert_eq!(operation["security"], json!([{}]));
        }
        for operation_id in [
            "me",
            "listVaults",
            "streamSyncEvents",
            "acceptTeamInvitation",
            "declineTeamInvitation",
        ] {
            let operation = operations
                .iter()
                .find(|operation| operation["operationId"] == operation_id)
                .unwrap_or_else(|| panic!("missing operation {operation_id}"));
            assert_eq!(operation["security"], json!([{ "bearerAuth": [] }]));
        }
    }

    #[test]
    fn every_retryable_overload_response_declares_retry_after() {
        let (_, document) = super::openapi_router().split_for_parts();
        let value = serde_json::to_value(document).expect("OpenAPI should serialize");
        let retryable_responses = value["paths"]
            .as_object()
            .expect("OpenAPI paths should be an object")
            .values()
            .flat_map(|path| {
                path.as_object()
                    .expect("OpenAPI path item should be an object")
                    .values()
            })
            .filter_map(|operation| operation.get("responses"))
            .flat_map(|responses| {
                ["429", "503"]
                    .into_iter()
                    .filter_map(|status| responses.get(status).map(|response| (status, response)))
            })
            .collect::<Vec<_>>();

        assert!(!retryable_responses.is_empty());
        for (status, response) in retryable_responses {
            assert_eq!(
                response["headers"]["Retry-After"]["schema"]["type"], "string",
                "status {status} must declare a delta-seconds Retry-After header"
            );
        }
    }

    async fn assert_api_problem(
        method: Method,
        uri: &str,
        expected_status: StatusCode,
        expected_code: &str,
    ) -> axum::http::HeaderMap {
        let response = super::create_api_router()
            .with_state(AppState::default())
            .oneshot(
                Request::builder()
                    .method(method)
                    .uri(uri)
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .expect("API fallback should respond");
        assert_eq!(response.status(), expected_status);
        assert_eq!(
            response.headers().get(header::CONTENT_TYPE).unwrap(),
            "application/problem+json"
        );
        let headers = response.headers().clone();
        let request_id = headers
            .get("bittery-request-id")
            .unwrap()
            .to_str()
            .unwrap()
            .to_string();
        let body: Value = serde_json::from_slice(
            &to_bytes(response.into_body(), usize::MAX)
                .await
                .expect("problem body should be readable"),
        )
        .expect("problem body should be JSON");
        assert_eq!(body["status"], expected_status.as_u16());
        assert_eq!(body["code"], expected_code);
        assert_eq!(body["requestId"], request_id);
        headers
    }

    #[tokio::test]
    async fn unknown_api_routes_use_problem_details_without_changing_non_api_fallbacks() {
        assert_api_problem(
            Method::GET,
            "/api/v1/does-not-exist",
            StatusCode::NOT_FOUND,
            "API_ROUTE_NOT_FOUND",
        )
        .await;

        let response = super::create_api_router()
            .with_state(AppState::default())
            .oneshot(
                Request::builder()
                    .uri("/does-not-exist")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::NOT_FOUND);
        assert_ne!(
            response.headers().get(header::CONTENT_TYPE),
            Some(&header::HeaderValue::from_static(
                "application/problem+json"
            ))
        );
    }

    #[tokio::test]
    async fn unsupported_api_methods_keep_allow_and_use_problem_details() {
        let headers = assert_api_problem(
            Method::POST,
            "/api/meta",
            StatusCode::METHOD_NOT_ALLOWED,
            "METHOD_NOT_ALLOWED",
        )
        .await;

        assert_eq!(headers.get(header::ALLOW).unwrap(), "GET,HEAD");
    }
}
