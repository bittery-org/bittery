use std::sync::Arc;

use fred::prelude::*;
use sqlx::PgPool;
use tokio::sync::RwLock;
use tracing::warn;

use crate::config::is_self_hosted_mode;
use crate::services::team_billing::{billing_is_active, load_team_billing_entitlement};

/// TTL for connection registry entries in seconds (90s).
const CONN_TTL_SECONDS: i64 = 90;

/// TTL for cached plan limits in seconds (300s / 5min).
const PLAN_LIMIT_CACHE_TTL_SECONDS: i64 = 300;

/// Lua script for atomic connection registration.
///
/// KEYS[1] = conn:user:{uid}
/// ARGV[1] = device_id
/// ARGV[2] = instance_id
/// ARGV[3] = ttl_seconds
/// ARGV[4] = plan_limit
///
/// Returns 1 on success, 0 if limit exceeded.
const REGISTER_SCRIPT: &str = r#"
local key = KEYS[1]
local device_id = ARGV[1]
local instance_id = ARGV[2]
local ttl = tonumber(ARGV[3])
local limit = tonumber(ARGV[4])
if redis.call('HEXISTS', key, device_id) == 1 then
  redis.call('HSET', key, device_id, instance_id)
  redis.call('EXPIRE', key, ttl)
  return 1
end
local current = redis.call('HLEN', key)
if current >= limit then
  return 0
end
redis.call('HSET', key, device_id, instance_id)
redis.call('EXPIRE', key, ttl)
return 1
"#;

#[derive(Clone)]
pub struct ConnectionRegistry {
    pool: Option<Pool>,
    script_sha: Arc<RwLock<Option<String>>>,
}

impl ConnectionRegistry {
    pub fn none() -> Self {
        Self {
            pool: None,
            script_sha: Arc::new(RwLock::new(None)),
        }
    }

    pub fn new(pool: Pool) -> Self {
        Self {
            pool: Some(pool),
            script_sha: Arc::new(RwLock::new(None)),
        }
    }

    /// Load the Lua registration script into Redis via SCRIPT LOAD.
    /// Must be called once on startup before any `try_register` calls.
    pub async fn load_scripts(&self) -> Result<(), Error> {
        let pool = match &self.pool {
            Some(p) => p,
            None => return Ok(()),
        };

        let sha: String = pool.script_load(REGISTER_SCRIPT).await?;
        let mut guard = self.script_sha.write().await;
        *guard = Some(sha);
        Ok(())
    }

    /// Attempt to register a connection atomically.
    /// Returns `Ok(true)` if registered, `Ok(false)` if limit exceeded.
    /// Returns `Ok(true)` if Redis is unavailable (graceful fallback).
    pub async fn try_register(
        &self,
        user_id: &str,
        device_id: &str,
        instance_id: &str,
        plan_limit: i64,
    ) -> Result<bool, Error> {
        let pool = match &self.pool {
            Some(p) => p,
            None => return Ok(true),
        };

        let sha = {
            let guard = self.script_sha.read().await;
            match guard.as_ref() {
                Some(sha) => sha.clone(),
                None => return Ok(true),
            }
        };

        let key = conn_key(user_id);
        let result: i64 = pool
            .evalsha(
                &sha,
                vec![key.as_str()],
                vec![
                    device_id.to_string(),
                    instance_id.to_string(),
                    CONN_TTL_SECONDS.to_string(),
                    plan_limit.to_string(),
                ],
            )
            .await?;

        Ok(result == 1)
    }

    /// Remove a device from the connection registry.
    pub async fn unregister(&self, user_id: &str, device_id: &str) {
        let pool = match &self.pool {
            Some(p) => p,
            None => return,
        };

        let key = conn_key(user_id);
        if let Err(error) = pool.hdel::<(), _, _>(&key, device_id).await {
            warn!(user_id = %user_id, error = %error, "failed to unregister SSE connection from Redis");
        }
    }

    /// Refresh the TTL on the user's connection hash.
    pub async fn refresh_ttl(&self, user_id: &str) {
        let pool = match &self.pool {
            Some(p) => p,
            None => return,
        };

        let key = conn_key(user_id);
        if let Err(error) = pool.expire::<(), _>(&key, CONN_TTL_SECONDS, None).await {
            warn!(user_id = %user_id, error = %error, "failed to refresh SSE connection TTL");
        }
    }

    /// Returns whether Redis-backed connection tracking is active.
    pub fn is_active(&self) -> bool {
        self.pool.is_some()
    }
}

/// Resolve the SSE connection limit for a user based on their billing plan.
/// Uses Redis cache with 300s TTL, falls back to DB query.
pub(crate) async fn resolve_connection_limit(
    redis: &Option<Pool>,
    db_pool: &PgPool,
    user_id: &str,
) -> i64 {
    if is_self_hosted_mode() {
        return i64::MAX;
    }

    let cache_key = plan_limit_key(user_id);

    // Check Redis cache first
    if let Some(pool) = redis {
        if let Ok(Some(cached)) = pool.get::<Option<i64>, _>(&cache_key).await {
            return cached;
        }
    }

    // Query DB for billing plan
    let limit = match load_team_billing_entitlement(
        db_pool,
        user_id,
        "Failed to load plan for connection limit",
    )
    .await
    {
        Ok(Some(row)) => {
            let plan = row.billing_plan.as_deref().unwrap_or("free");
            let status = row.billing_status.as_deref().unwrap_or("none");
            let is_active = billing_is_active(status);

            match plan {
                "personal" if is_active => 2,
                "family" if is_active => 3,
                "team" if is_active => i64::MAX,
                _ => 1,
            }
        }
        Ok(None) => 1,
        Err(error) => {
            warn!(user_id = %user_id, error = %error, "failed to resolve plan limit, defaulting to 1");
            1
        }
    };

    // Cache in Redis
    if let Some(pool) = redis {
        if let Err(error) = pool
            .set::<(), _, _>(
                &cache_key,
                limit,
                Some(Expiration::EX(PLAN_LIMIT_CACHE_TTL_SECONDS)),
                None,
                false,
            )
            .await
        {
            warn!(user_id = %user_id, error = %error, "failed to cache plan limit in Redis");
        }
    }

    limit
}

/// Guard that unregisters a connection when dropped.
pub(crate) struct ConnectionGuard {
    registry: ConnectionRegistry,
    user_id: String,
    device_id: String,
}

impl ConnectionGuard {
    pub fn new(registry: ConnectionRegistry, user_id: String, device_id: String) -> Self {
        Self {
            registry,
            user_id,
            device_id,
        }
    }
}

impl Drop for ConnectionGuard {
    fn drop(&mut self) {
        let registry = self.registry.clone();
        let user_id = self.user_id.clone();
        let device_id = self.device_id.clone();
        tokio::spawn(async move {
            registry.unregister(&user_id, &device_id).await;
        });
    }
}

fn conn_key(user_id: &str) -> String {
    format!("conn:user:{user_id}")
}

fn plan_limit_key(user_id: &str) -> String {
    format!("plan:limit:{user_id}")
}
