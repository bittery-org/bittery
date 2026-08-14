use std::{env, error::Error, sync::Arc};

use axum::Router;

use tokio::task::JoinHandle;

use crate::integrations::storage::object_storage_from_env;
use crate::{
    build_rate_limiter, create_app, db, init_redis, load_edge_http_config,
    validate_sync_fanout_requirement, AppState, JobRunner, SyncPubSub,
};

type RuntimeError = Box<dyn Error + Send + Sync>;

/// Owns the complete production server lifetime behind one startup interface.
pub struct ServerRuntime {
    app: Router,
    _job_runner: JobRunner,
    redis_dispatch: Option<JoinHandle<()>>,
}

impl ServerRuntime {
    pub async fn from_env() -> Result<Self, RuntimeError> {
        let edge_config = load_edge_http_config().map_err(std::io::Error::other)?;
        let pool = db::connect_required_from_env().await?;
        db::run_migrations(&pool).await?;

        let rate_limiter = build_rate_limiter(&pool)
            .await
            .map_err(std::io::Error::other)?;
        let redis = init_redis().await;
        validate_sync_fanout_requirement(env::var("NODE_ENV").ok().as_deref(), redis.is_some())
            .map_err(std::io::Error::other)?;

        let object_storage = object_storage_from_env()?;
        let mut state = AppState::from_pool(pool.clone())
            .with_object_storage(object_storage)
            .with_rate_limiter(rate_limiter)
            .with_redis(redis.clone());
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
            _job_runner: job_runner,
            redis_dispatch,
        })
    }

    pub fn app(&self) -> Router {
        self.app.clone()
    }
}

impl Drop for ServerRuntime {
    fn drop(&mut self) {
        if let Some(dispatch) = &self.redis_dispatch {
            dispatch.abort();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::ServerRuntime;
    use crate::test_support::{acquire_env_lock_async, EnvVarGuard};

    #[tokio::test]
    async fn construction_requires_database_url() {
        let _lock = acquire_env_lock_async().await;
        let _database_url = EnvVarGuard::remove(&["DATABASE_URL"]);

        let error = ServerRuntime::from_env()
            .await
            .err()
            .expect("runtime construction should fail without a database URL");

        assert!(error.to_string().contains("DATABASE_URL is required"));
    }
}
