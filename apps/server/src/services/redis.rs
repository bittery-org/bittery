use std::env;

use fred::prelude::*;
use tracing::{info, warn};

pub async fn init_redis() -> Option<Pool> {
    let url = match env::var("REDIS_URL") {
        Ok(url) if !url.is_empty() => url,
        _ => {
            info!("REDIS_URL not set — running in local-only mode (no cross-instance sync)");
            return None;
        }
    };

    let pool_size: usize = env::var("REDIS_POOL_SIZE")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(4);

    let config = match Config::from_url(&url) {
        Ok(config) => config,
        Err(error) => {
            warn!(error = %error, "failed to parse REDIS_URL — running in local-only mode");
            return None;
        }
    };

    let pool = Builder::from_config(config)
        .with_connection_config(|config| {
            config.connection_timeout = std::time::Duration::from_secs(5);
        })
        .set_policy(ReconnectPolicy::new_exponential(0, 100, 30_000, 2))
        .build_pool(pool_size)
        .expect("failed to build Redis connection pool");

    match pool.init().await {
        Ok(_) => {
            info!(pool_size = pool_size, "redis connected");
            Some(pool)
        }
        Err(error) => {
            warn!(error = %error, "failed to connect to Redis — running in local-only mode");
            None
        }
    }
}
