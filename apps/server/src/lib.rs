pub(crate) mod config;
pub mod db;
pub mod error;
pub(crate) mod http;
pub(crate) mod integrations;
mod jobs;
pub(crate) mod repo;
pub(crate) mod rpc;
pub(crate) mod services;
#[cfg(test)]
pub(crate) mod test_support;

use config::format_timestamp;
use qubit::{handler, Router};
use sqlx::PgPool;
use ts_rs::TS;

use std::sync::Arc;

use fred::prelude::Pool as RedisPool;
use serde::Serialize;

use services::rate_limit::{NoopRateLimiter, PostgresRateLimiter};

pub use http::middleware::{
    edge_http_middleware, http_trace_layer, load_edge_http_config, rpc_request_guard_middleware,
};
pub use http::public::create_public_http_router;
pub use http::rpc_tracing::rpc_tracing_middleware;
pub use http::sync_sse::create_sync_http_router;
pub use jobs::JobRunner;
pub use rpc::audit::create_audit_router;
pub use rpc::auth::create_auth_router;
pub use rpc::billing::create_billing_router;
pub use rpc::share::create_share_router;
pub use rpc::sync::create_sync_router;
pub use rpc::team::create_team_router;
pub use rpc::travel_mode::create_travel_mode_router;
pub use rpc::vault::create_vault_router;
pub use services::auth::rpc_request_context_middleware;
pub use services::connection_registry::ConnectionRegistry;
pub use services::rate_limit::{build_rate_limiter, RateLimiter};
pub use services::redis::init_redis;
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

#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct PrivateDataUserResponse {
    pub token: String,
    pub session_id: String,
    pub user_id: String,
    pub expires_at: String,
    pub platform: String,
    pub client_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct PrivateDataResponse {
    pub message: String,
    pub user: PrivateDataUserResponse,
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

#[allow(non_snake_case)]
#[handler(query)]
pub async fn healthCheck() -> String {
    "OK".to_string()
}

#[allow(non_snake_case)]
#[handler(query)]
pub async fn privateData(ctx: services::auth::RefreshSessionContext) -> PrivateDataResponse {
    PrivateDataResponse {
        message: "This is private".to_string(),
        user: PrivateDataUserResponse {
            token: ctx.session.token,
            session_id: ctx.session.session_id,
            user_id: ctx.session.user_id,
            expires_at: format_timestamp(ctx.session.expires_at),
            platform: ctx.session.platform,
            client_id: ctx.session.client_id,
        },
    }
}

pub fn create_rpc_router() -> Router<AppState> {
    Router::new()
        .handler(healthCheck)
        .handler(privateData)
        .nest("auth", create_auth_router())
        .nest("audit", create_audit_router())
        .nest("billing", create_billing_router())
        .nest("share", create_share_router())
        .nest("sync", create_sync_router())
        .nest("team", create_team_router())
        .nest("travelMode", create_travel_mode_router())
        .nest("vault", create_vault_router())
}
