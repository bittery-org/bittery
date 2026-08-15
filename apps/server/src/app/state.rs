use std::sync::Arc;

use fred::prelude::Pool as RedisPool;
use sqlx::PgPool;

use crate::{
    config::Config,
    domains::{sessions::service::SessionService, sync::pubsub::SyncPubSub},
    integrations::{
        favicon::{RemoteDocumentFetcher, ReqwestRemoteDocumentFetcher},
        storage::{ObjectStorage, UnavailableObjectStorage},
        stripe::BillingGateway,
    },
    shared::{
        connection_registry::ConnectionRegistry,
        rate_limit::{PostgresRateLimiter, RateLimiter},
    },
};

#[derive(Clone)]
pub struct AppState {
    pub(crate) config: Arc<Config>,
    pub db_pool: PgPool,
    pub redis: Option<RedisPool>,
    pub sessions: SessionService,
    pub connection_registry: ConnectionRegistry,
    pub sync_pubsub: SyncPubSub,
    pub instance_id: String,
    pub rate_limiter: Arc<dyn RateLimiter>,
    pub object_storage: Arc<dyn ObjectStorage>,
    pub remote_documents: Arc<dyn RemoteDocumentFetcher>,
    pub billing_gateway: Option<Arc<dyn BillingGateway>>,
}

impl AppState {
    pub(crate) fn from_pool_with_config(pool: PgPool, config: Arc<Config>) -> Self {
        Self {
            config,
            db_pool: pool.clone(),
            redis: None,
            sessions: SessionService::from_pool(pool.clone()),
            connection_registry: ConnectionRegistry::none(),
            sync_pubsub: SyncPubSub::new(),
            instance_id: uuid::Uuid::new_v4().to_string(),
            rate_limiter: Arc::new(PostgresRateLimiter::new(pool)),
            object_storage: Arc::new(UnavailableObjectStorage::new(None)),
            remote_documents: Arc::new(ReqwestRemoteDocumentFetcher::new()),
            billing_gateway: None,
        }
    }

    #[cfg(test)]
    pub(crate) fn from_pool(pool: PgPool) -> Self {
        Self::from_pool_with_config(pool, Arc::new(Config::for_test()))
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

    pub fn with_object_storage(mut self, storage: Arc<dyn ObjectStorage>) -> Self {
        self.object_storage = storage;
        self
    }

    pub fn with_remote_documents(mut self, fetcher: Arc<dyn RemoteDocumentFetcher>) -> Self {
        self.remote_documents = fetcher;
        self
    }

    pub fn with_billing_gateway(mut self, gateway: Arc<dyn BillingGateway>) -> Self {
        self.billing_gateway = Some(gateway);
        self
    }

    /// Wake all SSE sync connections so they check for new events.
    pub fn notify_sync(&self) {
        self.sync_pubsub.notify_sync();
    }

    #[cfg(test)]
    pub(crate) fn database_free_test() -> Self {
        use crate::shared::rate_limit::NoopRateLimiter;
        use sqlx::postgres::PgPoolOptions;

        let pool = PgPoolOptions::new()
            .connect_lazy("postgres://test:test@127.0.0.1:1/bittery_router_shape")
            .expect("fixed database-free test URL should parse");
        Self::from_pool(pool).with_rate_limiter(Arc::new(NoopRateLimiter))
    }
}

/// Extension trait: on `Ok`, wake SSE sync connections.
pub(crate) trait NotifySyncExt<T> {
    fn notify_sync(self, state: &AppState) -> Self;
}

impl<T> NotifySyncExt<T> for Result<T, crate::shared::error::AppError> {
    fn notify_sync(self, state: &AppState) -> Self {
        if self.is_ok() {
            state.notify_sync();
        }
        self
    }
}
