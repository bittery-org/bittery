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

/// Stable public path for the crate's shared application error.
pub mod error {
    pub use crate::shared::error::*;
}
