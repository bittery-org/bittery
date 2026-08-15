use std::{error::Error, sync::Arc};

use axum::Router;

use tokio::task::JoinHandle;

use crate::config::Config;
use crate::integrations::storage::object_storage_from_config;
use crate::integrations::stripe::StripeBillingGateway;
use crate::{
    build_rate_limiter, create_app, db, init_redis, validate_sync_fanout_requirement, AppState,
    EdgeHttpConfig, JobRunner, SyncPubSub,
};

type RuntimeError = Box<dyn Error + Send + Sync>;

/// Owns the complete production server lifetime behind one startup interface.
pub struct ServerRuntime {
    app: Router,
    bind_address: String,
    _job_runner: JobRunner,
    redis_dispatch: Option<JoinHandle<()>>,
}

impl ServerRuntime {
    pub async fn from_env() -> Result<Self, RuntimeError> {
        let config = Arc::new(Config::from_env()?);
        let edge_config =
            EdgeHttpConfig::from_server_config(&config.server).map_err(std::io::Error::other)?;
        let bind_address = config.server.bind_address();
        let pool = db::connect_with_config(&config.database).await?;
        db::run_migrations_with_config(&pool, &config.database).await?;

        let rate_limiter = build_rate_limiter(&pool, &config.rate_limit)
            .await
            .map_err(std::io::Error::other)?;
        let redis = init_redis(&config.redis).await;
        validate_sync_fanout_requirement(Some(&config.server.node_environment), redis.is_some())
            .map_err(std::io::Error::other)?;

        let object_storage = object_storage_from_config(&config.storage)?;
        let billing_gateway = StripeBillingGateway::from_config(&config.stripe)?;
        let mut state = AppState::from_pool_with_config(pool.clone(), Arc::clone(&config))
            .with_object_storage(object_storage)
            .with_rate_limiter(rate_limiter)
            .with_redis(redis.clone());
        if let Some(gateway) = billing_gateway {
            state = state.with_billing_gateway(Arc::new(gateway));
        }
        let mut redis_dispatch = None;
        if let Some(redis) = redis {
            state.connection_registry.load_scripts().await?;
            let sync_pubsub = Arc::new(SyncPubSub::with_redis(redis).await);
            redis_dispatch = sync_pubsub.start_dispatch();
            state = state.with_sync_pubsub((*sync_pubsub).clone());
        }

        let job_runner = JobRunner::start(
            pool,
            state.object_storage.clone(),
            state.remote_documents.clone(),
        )?;
        let app = create_app(state, edge_config);

        Ok(Self {
            app,
            bind_address,
            _job_runner: job_runner,
            redis_dispatch,
        })
    }

    pub fn app(&self) -> Router {
        self.app.clone()
    }

    pub fn bind_address(&self) -> &str {
        &self.bind_address
    }
}

impl Drop for ServerRuntime {
    fn drop(&mut self) {
        if let Some(dispatch) = &self.redis_dispatch {
            dispatch.abort();
        }
    }
}
