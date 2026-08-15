use fred::prelude::*;
use tracing::{info, warn};

use crate::config::RedisConfig;

pub fn validate_sync_fanout_requirement(
    node_env: Option<&str>,
    redis_available: bool,
) -> Result<(), &'static str> {
    let production = node_env.is_some_and(|value| value.trim().eq_ignore_ascii_case("production"));
    if production && !redis_available {
        return Err("REDIS_URL must connect successfully in production because durable Item catch-up notifications require cross-instance fan-out");
    }
    Ok(())
}

pub async fn init_redis(settings: &RedisConfig) -> Option<Pool> {
    let url = match settings.url.as_deref() {
        Some(url) => url,
        None => {
            info!("REDIS_URL not set — running in local-only mode (no cross-instance sync)");
            return None;
        }
    };
    let pool_size = settings.pool_size;

    let config = match Config::from_url(url) {
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

#[cfg(test)]
mod tests {
    use super::validate_sync_fanout_requirement;

    #[test]
    fn production_requires_redis_for_cross_instance_sync() {
        assert!(validate_sync_fanout_requirement(Some("production"), false).is_err());
        assert!(validate_sync_fanout_requirement(Some("production"), true).is_ok());
        assert!(validate_sync_fanout_requirement(Some("development"), false).is_ok());
        assert!(validate_sync_fanout_requirement(Some("test"), false).is_ok());
        assert!(validate_sync_fanout_requirement(None, false).is_ok());
    }
}
