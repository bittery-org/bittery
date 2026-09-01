pub(crate) mod app;
pub(crate) mod config;
pub mod db;
pub(crate) mod domains;
pub(crate) mod http;
pub(crate) mod integrations;
mod jobs;
pub(crate) mod shared;
#[cfg(test)]
pub(crate) mod test_support;

pub(crate) mod shapes {
    pub(crate) use crate::domains::auth::shape::*;
    pub(crate) use crate::domains::shares::shape::*;
    pub(crate) use crate::domains::sync::shape::*;
    pub(crate) use crate::domains::vaults::shapes::*;
    pub(crate) use crate::shared::shapes::*;
}

pub use app::{create_app, AppState, ServerRuntime};
pub(crate) use domains::auth::request_context_middleware;
pub use domains::sessions::service::{SeededSession, SessionService};
pub use domains::sync::pubsub::SyncPubSub;
pub use http::dto::{
    ApiLimits, ApiMetadata, ApiVersionMetadata, CursorPage, DecimalString, DecimalStringError,
    PageCursor, PageRequest, PatchField, ProblemDetails, ProblemFieldError, RegistrationMetadata,
    SyncCursor, API_MAJOR, BULK_IMPORT_BYTES, BULK_IMPORT_ITEMS, DEFAULT_AUDIT_EVENTS,
    DEFAULT_PAGE_SIZE, ENCRYPTED_VAULT_KEY_BYTES, ITEM_CIPHERTEXT_BYTES, MAX_AUDIT_EVENTS,
    MAX_AUDIT_SEARCH_BYTES, MAX_BATCH_ITEMS, MAX_CAPABILITIES, MAX_PAGE_SIZE, NAME_MAX_CHARS,
    SUPPORTED_MAJORS,
};
#[cfg(test)]
pub use http::middleware::load_edge_http_config;
pub use http::middleware::{
    catch_panic_layer, edge_http_middleware, http_trace_layer, EdgeHttpConfig,
};
pub(crate) use http::openapi::create_api_router;
pub use http::openapi::openapi_json;
pub(crate) use http::openapi::response_headers as api_response_headers;
pub use http::public::create_public_http_router;
pub use jobs::JobRunner;
pub use shared::connection_registry::ConnectionRegistry;
pub use shared::rate_limit::{build_rate_limiter, RateLimiter};
pub use shared::redis::{init_redis, validate_sync_fanout_requirement};

/// Generate the production exact-upload authority used by the local Chromium S3 acceptance
/// adapter. Kept behind an explicit feature so the production Server interface does not acquire a
/// second signing policy or a generally callable test-credential path.
#[cfg(feature = "acceptance-adapter")]
#[doc(hidden)]
pub async fn exact_upload_chromium_acceptance_grant(endpoint: &str) -> Result<String, String> {
    use integrations::storage::{ObjectStorage, S3CompatibleStorage, S3StorageConfig};

    let storage = S3CompatibleStorage::new(
        S3StorageConfig {
            endpoint: endpoint.to_owned(),
            region: "auto".to_owned(),
            bucket: "chromium-bucket".to_owned(),
            access_key_id: "chromium-access-key".to_owned(),
            secret_access_key: "chromium-secret-key".to_owned(),
        },
        None,
    )
    .map_err(|error| error.to_string())?;
    let grant = storage
        .presign_exact_upload(
            "vaults/chromium-user/chromium-vault/create/chromium-operation-039058c6",
            "image/png",
            3,
            "039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81",
            Some(300),
        )
        .await
        .map_err(|error| error.to_string())?;
    serde_json::to_string(&grant).map_err(|error| error.to_string())
}

/// Stable public path for the crate's shared application error.
pub mod error {
    pub use crate::shared::error::*;
}
