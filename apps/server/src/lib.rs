mod app;
pub(crate) mod config;
pub mod db;
pub mod error;
pub(crate) mod http;
pub(crate) mod integrations;
mod jobs;
pub(crate) mod repo;
pub(crate) mod services;
pub(crate) mod shapes;
#[cfg(test)]
pub(crate) mod test_support;

use sqlx::PgPool;

use std::sync::Arc;

use fred::prelude::Pool as RedisPool;
use services::rate_limit::{NoopRateLimiter, PostgresRateLimiter};

pub use app::create_app;
pub(crate) use http::api::create_api_router;
pub use http::api::dto::{
    ApiLimits, ApiMetadata, ApiVersionMetadata, CursorPage, DecimalString, DecimalStringError,
    PageCursor, PageRequest, PatchField, ProblemDetails, ProblemFieldError, RegistrationMetadata,
    SyncCursor, API_MAJOR, BULK_IMPORT_BYTES, BULK_IMPORT_ITEMS, DEFAULT_AUDIT_EVENTS,
    DEFAULT_PAGE_SIZE, ENCRYPTED_VAULT_KEY_BYTES, ITEM_CIPHERTEXT_BYTES, MAX_AUDIT_EVENTS,
    MAX_AUDIT_SEARCH_BYTES, MAX_BATCH_ITEMS, MAX_CAPABILITIES, MAX_PAGE_SIZE, NAME_MAX_CHARS,
    SUPPORTED_MAJORS,
};
pub use http::api::openapi_json;
pub(crate) use http::api::response_headers as api_response_headers;
pub use http::middleware::{
    catch_panic_layer, edge_http_middleware, http_trace_layer, load_edge_http_config,
    EdgeHttpConfig,
};
pub use http::public::create_public_http_router;
pub use jobs::JobRunner;
pub use services::auth::request_context_middleware;
pub use services::connection_registry::ConnectionRegistry;
pub use services::rate_limit::{build_rate_limiter, RateLimiter};
pub use services::redis::{init_redis, validate_sync_fanout_requirement};
pub use services::session::{SeededSession, SessionService};
pub use services::sync_pubsub::SyncPubSub;

#[derive(Clone)]
pub struct AppState {
    pub db_pool: Option<PgPool>,
    pub redis: Option<RedisPool>,
    pub sessions: SessionService,
    pub connection_registry: ConnectionRegistry,
    pub sync_pubsub: SyncPubSub,
    pub instance_id: String,
    pub rate_limiter: Arc<dyn RateLimiter>,
}

impl Default for AppState {
    fn default() -> Self {
        Self {
            db_pool: None,
            redis: None,
            sessions: SessionService::default(),
            connection_registry: ConnectionRegistry::none(),
            sync_pubsub: SyncPubSub::new(),
            instance_id: uuid::Uuid::new_v4().to_string(),
            rate_limiter: Arc::new(NoopRateLimiter),
        }
    }
}

impl AppState {
    pub fn from_pool(pool: PgPool) -> Self {
        Self {
            db_pool: Some(pool.clone()),
            redis: None,
            sessions: SessionService::from_pool(pool.clone()),
            connection_registry: ConnectionRegistry::none(),
            sync_pubsub: SyncPubSub::new(),
            instance_id: uuid::Uuid::new_v4().to_string(),
            rate_limiter: Arc::new(PostgresRateLimiter::new(pool)),
        }
    }

    pub fn with_rate_limiter(mut self, rate_limiter: Arc<dyn RateLimiter>) -> Self {
        self.rate_limiter = rate_limiter;
        self
    }

    pub fn with_redis(mut self, redis: Option<RedisPool>) -> Self {
        if let Some(ref pool) = redis {
            self.connection_registry = ConnectionRegistry::new(pool.clone());
        }
        self.redis = redis;
        self
    }

    pub fn with_sync_pubsub(mut self, pubsub: SyncPubSub) -> Self {
        self.sync_pubsub = pubsub;
        self
    }

    /// Wake all SSE sync connections so they check for new events.
    pub fn notify_sync(&self) {
        self.sync_pubsub.notify_sync();
    }

    pub async fn from_env() -> Result<Self, sqlx::Error> {
        match db::connect_from_env().await? {
            Some(pool) => Ok(Self::from_pool(pool)),
            _ => Ok(Self::default()),
        }
    }
}

/// Extension trait: on `Ok`, wake SSE sync connections.
pub(crate) trait NotifySyncExt<T> {
    fn notify_sync(self, state: &AppState) -> Self;
}

impl<T> NotifySyncExt<T> for Result<T, error::AppError> {
    fn notify_sync(self, state: &AppState) -> Self {
        if self.is_ok() {
            state.notify_sync();
        }
        self
    }
}
