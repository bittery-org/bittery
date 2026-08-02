//! Shared rate limiting service.
//!
//! Provides a backend-agnostic [`RateLimiter`] with two families of operations:
//! - a windowed counter (`check_and_increment`) for "N requests per window" limits, and
//! - an attempt/lockout counter (`record_failure` / `is_locked` / `clear`) for
//!   brute-force protection (e.g. recovery-code verification).
//!
//! Two backends are provided:
//! - [`PostgresRateLimiter`], which uses the `rate_limit_state` table, and
//! - [`RedisRateLimiter`], which uses `INCR`/`EXPIRE` and small atomic Lua scripts.
//!
//! The active backend is chosen at startup from `RATE_LIMIT_ADAPTER`
//! (`auto` | `postgres` | `redis`) and `RATE_LIMIT_REDIS_URL`.

use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use fred::prelude::*;
use sqlx::{query, query_as, query_scalar, PgPool};
use time::OffsetDateTime;
use tracing::info;

use crate::error::AppError;

// ---------------------------------------------------------------------------
// Scope names
// ---------------------------------------------------------------------------

pub const SCOPE_LOGIN_IP: &str = "auth_login_ip";
pub const SCOPE_LOGIN_EMAIL: &str = "auth_login_email";
pub const SCOPE_SIGNUP_IP: &str = "auth_signup_ip";
pub const SCOPE_SIGNUP_EMAIL: &str = "auth_signup_email";
pub const SCOPE_SIGNUP_VERIFY_REQUEST_EMAIL: &str = "auth_signup_verify_request_email";
pub const SCOPE_SIGNUP_VERIFY_REQUEST_IP: &str = "auth_signup_verify_request_ip";
pub const SCOPE_SIGNUP_VERIFY: &str = "auth_signup_verify";
pub const SCOPE_RECOVERY_REQUEST_EMAIL: &str = "auth_recovery_request_email";
pub const SCOPE_RECOVERY_REQUEST_IP: &str = "auth_recovery_request_ip";
pub const SCOPE_RECOVERY_VERIFY: &str = "auth_recovery_verify";
pub const SCOPE_SHARE_EMAIL_VERIFY: &str = "share_email_verify";
pub const SCOPE_GENERIC_IP: &str = "auth_generic_ip";
pub const SCOPE_SHARE_CREATE_DAILY: &str = "share_create_daily";

/// Sentinel key used when a per-IP scope has no client IP available, so
/// unproxied deployments still get a shared global backstop rather than no limit.
pub const UNKNOWN_IP_KEY: &str = "unknown";

/// Generic, non-enumerating message surfaced to clients when a limit trips.
pub const RATE_LIMITED_MESSAGE: &str = "Too many requests. Please try again later.";

pub fn rate_limited_error() -> AppError {
    AppError::too_many_requests(RATE_LIMITED_MESSAGE)
}

// ---------------------------------------------------------------------------
// Configuration (hardcoded defaults + RATE_LIMIT_* env overrides)
// ---------------------------------------------------------------------------

/// A windowed-counter limit: at most `max` requests per `window`.
#[derive(Debug, Clone, Copy)]
pub struct WindowLimit {
    pub max: i64,
    pub window: Duration,
}

fn env_i64(name: &str, default: i64) -> i64 {
    std::env::var(name)
        .ok()
        .and_then(|value| value.trim().parse::<i64>().ok())
        .filter(|value| *value > 0)
        .unwrap_or(default)
}

const FIFTEEN_MINUTES: Duration = Duration::from_secs(15 * 60);
const ONE_HOUR: Duration = Duration::from_secs(60 * 60);
const ONE_DAY: Duration = Duration::from_secs(24 * 60 * 60);

pub fn login_ip_limit() -> WindowLimit {
    WindowLimit {
        max: env_i64("RATE_LIMIT_LOGIN_IP", 20),
        window: FIFTEEN_MINUTES,
    }
}

pub fn login_email_limit() -> WindowLimit {
    WindowLimit {
        max: env_i64("RATE_LIMIT_LOGIN_EMAIL", 10),
        window: FIFTEEN_MINUTES,
    }
}

pub fn signup_ip_limit() -> WindowLimit {
    WindowLimit {
        max: env_i64("RATE_LIMIT_SIGNUP_IP", 10),
        window: ONE_HOUR,
    }
}

pub fn signup_email_limit() -> WindowLimit {
    WindowLimit {
        max: env_i64("RATE_LIMIT_SIGNUP_EMAIL", 5),
        window: ONE_HOUR,
    }
}

/// Caps how often a signup verification code may be *requested*. Each request
/// sends an email and mints a fresh code, so this is both an email-abuse limit
/// and the outer bound on how many independent codes an attacker can guess
/// against (the per-email lockout below caps guesses within that budget).
pub fn signup_verification_request_limit() -> WindowLimit {
    WindowLimit {
        max: env_i64("RATE_LIMIT_SIGNUP_VERIFY_REQUEST", 5),
        window: ONE_HOUR,
    }
}

pub fn recovery_request_limit() -> WindowLimit {
    WindowLimit {
        max: env_i64("RATE_LIMIT_RECOVERY_REQUEST", 5),
        window: ONE_HOUR,
    }
}

pub fn generic_ip_limit() -> WindowLimit {
    WindowLimit {
        max: env_i64("RATE_LIMIT_AUTH_IP", 30),
        window: FIFTEEN_MINUTES,
    }
}

pub fn share_create_daily_limit() -> WindowLimit {
    // `SHARE_LINK_DAILY_LIMIT` keeps working (previous env var name is preserved).
    WindowLimit {
        max: env_i64("SHARE_LINK_DAILY_LIMIT", 50),
        window: ONE_DAY,
    }
}

pub fn signup_verify_max_attempts() -> i64 {
    // Lifetime lockout threshold for signup-code guessing, keyed on the email
    // hash rather than the code row. The per-code database cap
    // (`signup_verification.max_attempts`, default 5) resets whenever a new code
    // is requested, so on its own it bounds guesses per code, not per identity.
    // This limiter is what makes the ~19.8-bit code space unguessable.
    env_i64("RATE_LIMIT_SIGNUP_VERIFY_MAX", 10)
}

pub fn signup_verify_lock_duration() -> Duration {
    let minutes = env_i64("RATE_LIMIT_SIGNUP_VERIFY_LOCK_MINUTES", 15);
    Duration::from_secs((minutes as u64) * 60)
}

pub fn recovery_verify_max_attempts() -> i64 {
    // This is the rate-limiter lockout threshold that also throttles/locks the
    // caller across recovery-code attempts. It is independent of the per-code
    // database cap enforced by `recovery_verification.max_attempts` (default 5),
    // which invalidates a single code after too many guesses regardless of this
    // limiter. Both caps apply; the stricter one trips first.
    env_i64("RATE_LIMIT_RECOVERY_VERIFY_MAX", 5)
}

pub fn recovery_verify_lock_duration() -> Duration {
    let minutes = env_i64("RATE_LIMIT_RECOVERY_LOCK_MINUTES", 15);
    Duration::from_secs((minutes as u64) * 60)
}

pub fn share_email_verify_max_attempts() -> i64 {
    env_i64("RATE_LIMIT_SHARE_EMAIL_VERIFY_MAX", 5)
}

pub fn share_email_verify_lock_duration() -> Duration {
    let minutes = env_i64("RATE_LIMIT_SHARE_EMAIL_VERIFY_LOCK_MINUTES", 15);
    Duration::from_secs((minutes as u64) * 60)
}

// ---------------------------------------------------------------------------
// Trait
// ---------------------------------------------------------------------------

/// Outcome of a rate-limit check.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RateLimitOutcome {
    Allowed,
    Limited,
}

impl RateLimitOutcome {
    pub fn is_limited(self) -> bool {
        matches!(self, RateLimitOutcome::Limited)
    }
}

#[async_trait]
pub trait RateLimiter: Send + Sync {
    /// Windowed counter. Records one request against `(scope, key)` and returns
    /// [`RateLimitOutcome::Limited`] once more than `limit` requests occur within
    /// `window`. Exactly `limit` requests are allowed per window.
    async fn check_and_increment(
        &self,
        scope: &str,
        key: &str,
        limit: i64,
        window: Duration,
    ) -> Result<RateLimitOutcome, AppError>;

    /// Records a failed attempt against `(scope, key)`. Once `max_attempts` failures
    /// accumulate, a lock lasting `lock_duration` is set. Returns
    /// [`RateLimitOutcome::Limited`] when the lock is (now) active.
    async fn record_failure(
        &self,
        scope: &str,
        key: &str,
        max_attempts: i64,
        lock_duration: Duration,
    ) -> Result<RateLimitOutcome, AppError>;

    /// Returns [`RateLimitOutcome::Limited`] if `(scope, key)` is currently locked,
    /// without recording an attempt.
    async fn is_locked(&self, scope: &str, key: &str) -> Result<RateLimitOutcome, AppError>;

    /// Clears any attempt/lock state for `(scope, key)`.
    async fn clear(&self, scope: &str, key: &str) -> Result<(), AppError>;
}

// ---------------------------------------------------------------------------
// No-op backend (used when no database/redis is configured)
// ---------------------------------------------------------------------------

/// Always-allow limiter. Only used by `AppState::default()` where no database is
/// configured (in which case the endpoints themselves fail before any real work).
pub struct NoopRateLimiter;

#[async_trait]
impl RateLimiter for NoopRateLimiter {
    async fn check_and_increment(
        &self,
        _scope: &str,
        _key: &str,
        _limit: i64,
        _window: Duration,
    ) -> Result<RateLimitOutcome, AppError> {
        Ok(RateLimitOutcome::Allowed)
    }

    async fn record_failure(
        &self,
        _scope: &str,
        _key: &str,
        _max_attempts: i64,
        _lock_duration: Duration,
    ) -> Result<RateLimitOutcome, AppError> {
        Ok(RateLimitOutcome::Allowed)
    }

    async fn is_locked(&self, _scope: &str, _key: &str) -> Result<RateLimitOutcome, AppError> {
        Ok(RateLimitOutcome::Allowed)
    }

    async fn clear(&self, _scope: &str, _key: &str) -> Result<(), AppError> {
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// Postgres backend
// ---------------------------------------------------------------------------

pub struct PostgresRateLimiter {
    pool: PgPool,
}

impl PostgresRateLimiter {
    pub fn new(pool: PgPool) -> Self {
        Self { pool }
    }
}

#[async_trait]
impl RateLimiter for PostgresRateLimiter {
    async fn check_and_increment(
        &self,
        scope: &str,
        key: &str,
        limit: i64,
        window: Duration,
    ) -> Result<RateLimitOutcome, AppError> {
        let now = OffsetDateTime::now_utc();
        let window_cutoff = now - time::Duration::seconds(window.as_secs() as i64);

        // Generalized from services/share.rs: seed the row, then atomically reset the
        // window or increment the counter, returning the new count (or nothing when
        // the limit is already reached within the current window).
        query(
            "INSERT INTO rate_limit_state (scope, key, subject, count, window_start_at, updated_at) VALUES ($1, $2, $2, 0, $3, $4) ON CONFLICT DO NOTHING",
        )
        .bind(scope)
        .bind(key)
        .bind(now)
        .bind(now)
        .execute(&self.pool)
        .await
        .map_err(|e| {
            tracing::error!(error = %e, scope, "Failed to initialize rate limit state");
            AppError::internal("Failed to initialize rate limit state")
        })?;

        let count = query_scalar::<_, Option<i32>>(
            "UPDATE rate_limit_state SET count = CASE WHEN window_start_at IS NULL OR window_start_at < $3 THEN 1 ELSE count + 1 END, window_start_at = CASE WHEN window_start_at IS NULL OR window_start_at < $3 THEN $4 ELSE window_start_at END, updated_at = $4 WHERE scope = $1 AND key = $2 AND ((window_start_at IS NULL OR window_start_at < $3) OR count < $5) RETURNING count",
        )
        .bind(scope)
        .bind(key)
        .bind(window_cutoff)
        .bind(now)
        .bind(limit as i32)
        .fetch_optional(&self.pool)
        .await
        .map_err(|e| {
            tracing::error!(error = %e, scope, "Failed to increment rate limit window");
            AppError::internal("Failed to increment rate limit window")
        })?;

        if count.flatten().is_none() {
            Ok(RateLimitOutcome::Limited)
        } else {
            Ok(RateLimitOutcome::Allowed)
        }
    }

    async fn record_failure(
        &self,
        scope: &str,
        key: &str,
        max_attempts: i64,
        lock_duration: Duration,
    ) -> Result<RateLimitOutcome, AppError> {
        // Note: unlike the windowed counter, the attempt count here persists in
        // `rate_limit_state` until the lock trips (setting `locked_until`) or
        // `clear()` is called. There is no sliding expiry on the attempt count, so
        // a slow drip of failures still accumulates toward the lock. The Redis
        // backend approximates this with a fixed `ATTEMPTS_RETENTION` TTL set once
        // on the first failure (it cannot retain keys forever), so idle counters
        // there self-evict after a day while paced attempts still accumulate.
        let now = OffsetDateTime::now_utc();

        let mut tx = self.pool.begin().await.map_err(|e| {
            tracing::error!(error = %e, scope, "Failed to start rate limit transaction");
            AppError::internal("Failed to start rate limit transaction")
        })?;

        query(
            "INSERT INTO rate_limit_state (scope, key, subject, attempts, updated_at) VALUES ($1, $2, $2, 0, $3) ON CONFLICT DO NOTHING",
        )
        .bind(scope)
        .bind(key)
        .bind(now)
        .execute(&mut *tx)
        .await
        .map_err(|e| {
            tracing::error!(error = %e, scope, "Failed to initialize lockout state");
            AppError::internal("Failed to initialize lockout state")
        })?;

        let row = query_as::<_, (i32, Option<OffsetDateTime>)>(
            "SELECT attempts, locked_until FROM rate_limit_state WHERE scope = $1 AND key = $2 FOR UPDATE",
        )
        .bind(scope)
        .bind(key)
        .fetch_one(&mut *tx)
        .await
        .map_err(|e| {
            tracing::error!(error = %e, scope, "Failed to load lockout state");
            AppError::internal("Failed to load lockout state")
        })?;

        let (attempts, locked_until) = row;

        // Already locked: report Limited without recording another attempt.
        if locked_until.is_some_and(|until| until > now) {
            tx.commit().await.map_err(|e| {
                tracing::error!(error = %e, scope, "Failed to commit lockout transaction");
                AppError::internal("Failed to commit lockout transaction")
            })?;
            return Ok(RateLimitOutcome::Limited);
        }

        // A stale lock (or no lock) resets the attempt counter.
        let lock_expired = locked_until.is_some_and(|until| until <= now);
        let base_attempts = if lock_expired { 0 } else { attempts };
        let new_attempts = base_attempts + 1;
        let now_locked = i64::from(new_attempts) >= max_attempts;
        let new_locked_until = if now_locked {
            Some(now + time::Duration::seconds(lock_duration.as_secs() as i64))
        } else {
            None
        };

        query(
            "UPDATE rate_limit_state SET attempts = $3, locked_until = $4, last_attempt_at = $5, updated_at = $5 WHERE scope = $1 AND key = $2",
        )
        .bind(scope)
        .bind(key)
        .bind(new_attempts)
        .bind(new_locked_until)
        .bind(now)
        .execute(&mut *tx)
        .await
        .map_err(|e| {
            tracing::error!(error = %e, scope, "Failed to update lockout state");
            AppError::internal("Failed to update lockout state")
        })?;

        tx.commit().await.map_err(|e| {
            tracing::error!(error = %e, scope, "Failed to commit lockout transaction");
            AppError::internal("Failed to commit lockout transaction")
        })?;

        if now_locked {
            Ok(RateLimitOutcome::Limited)
        } else {
            Ok(RateLimitOutcome::Allowed)
        }
    }

    async fn is_locked(&self, scope: &str, key: &str) -> Result<RateLimitOutcome, AppError> {
        let now = OffsetDateTime::now_utc();
        let locked_until = query_scalar::<_, Option<OffsetDateTime>>(
            "SELECT locked_until FROM rate_limit_state WHERE scope = $1 AND key = $2",
        )
        .bind(scope)
        .bind(key)
        .fetch_optional(&self.pool)
        .await
        .map_err(|e| {
            tracing::error!(error = %e, scope, "Failed to read lockout state");
            AppError::internal("Failed to read lockout state")
        })?
        .flatten();

        if locked_until.is_some_and(|until| until > now) {
            Ok(RateLimitOutcome::Limited)
        } else {
            Ok(RateLimitOutcome::Allowed)
        }
    }

    async fn clear(&self, scope: &str, key: &str) -> Result<(), AppError> {
        query(
            "UPDATE rate_limit_state SET attempts = 0, locked_until = NULL, updated_at = $3 WHERE scope = $1 AND key = $2",
        )
        .bind(scope)
        .bind(key)
        .bind(OffsetDateTime::now_utc())
        .execute(&self.pool)
        .await
        .map_err(|e| {
            tracing::error!(error = %e, scope, "Failed to clear lockout state");
            AppError::internal("Failed to clear lockout state")
        })?;
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// Redis backend
// ---------------------------------------------------------------------------

/// Atomic windowed counter: INCR then EXPIRE on first hit; returns 1 when over limit.
const COUNTER_SCRIPT: &str = r#"
local c = redis.call('INCR', KEYS[1])
if c == 1 then
  redis.call('EXPIRE', KEYS[1], tonumber(ARGV[1]))
end
if c > tonumber(ARGV[2]) then
  return 1
end
return 0
"#;

/// Atomic failure/lockout: returns 1 when locked (already or newly), else 0.
/// How long an un-tripped attempt counter is retained. Long enough that a
/// drip-fed brute force still accumulates toward the lock, short enough that
/// abandoned counters evict themselves.
const ATTEMPTS_RETENTION: Duration = Duration::from_secs(24 * 60 * 60);

const FAILURE_SCRIPT: &str = r#"
local akey = KEYS[1]
local lkey = KEYS[2]
local max = tonumber(ARGV[1])
local lock_secs = tonumber(ARGV[2])
if redis.call('EXISTS', lkey) == 1 then
  return 1
end
local a = redis.call('INCR', akey)
-- Set the retention TTL once, on the first failure, instead of refreshing it on
-- every increment. Refreshing per-increment made the counter expire `lock_secs`
-- after the LAST failure, so failures drip-fed slower than that reset forever and
-- never reached the lock. Setting it once means attempts accumulate for a fixed
-- retention window regardless of pacing, approximating the Postgres backend
-- (where attempts persist until the lock trips or clear() is called) while still
-- letting idle keys self-evict.
if a == 1 then
  redis.call('EXPIRE', akey, tonumber(ARGV[3]))
end
if a >= max then
  redis.call('SET', lkey, '1', 'EX', lock_secs)
  redis.call('DEL', akey)
  return 1
end
return 0
"#;

pub struct RedisRateLimiter {
    pool: Pool,
}

impl RedisRateLimiter {
    /// Connects to Redis using the provided URL. Fails fast on connection error.
    pub async fn connect(url: &str) -> Result<Self, String> {
        let config =
            Config::from_url(url).map_err(|e| format!("invalid RATE_LIMIT_REDIS_URL: {e}"))?;
        let pool = Builder::from_config(config)
            .with_connection_config(|config| {
                config.connection_timeout = Duration::from_secs(5);
            })
            .set_policy(ReconnectPolicy::new_exponential(0, 100, 30_000, 2))
            .build_pool(4)
            .map_err(|e| format!("failed to build Redis rate-limit pool: {e}"))?;
        pool.init()
            .await
            .map_err(|e| format!("failed to connect to Redis rate-limit backend: {e}"))?;
        Ok(Self { pool })
    }

    fn counter_key(scope: &str, key: &str) -> String {
        format!("rl:c:{scope}:{key}")
    }

    // The attempts and lock keys are passed together as multiple KEYS to
    // FAILURE_SCRIPT and to clear(), so they share a hash tag to stay in the same
    // slot on a clustered Redis (otherwise those calls fail with CROSSSLOT).
    fn attempts_key(scope: &str, key: &str) -> String {
        format!("rl:a:{{{scope}:{key}}}")
    }

    fn lock_key(scope: &str, key: &str) -> String {
        format!("rl:l:{{{scope}:{key}}}")
    }
}

#[async_trait]
impl RateLimiter for RedisRateLimiter {
    async fn check_and_increment(
        &self,
        scope: &str,
        key: &str,
        limit: i64,
        window: Duration,
    ) -> Result<RateLimitOutcome, AppError> {
        let redis_key = Self::counter_key(scope, key);
        let limited: i64 = self
            .pool
            .eval(
                COUNTER_SCRIPT,
                vec![redis_key],
                vec![window.as_secs() as i64, limit],
            )
            .await
            .map_err(|e| {
                tracing::error!(error = %e, scope, "Redis rate limit counter failed");
                AppError::internal("Failed to evaluate rate limit")
            })?;
        Ok(if limited == 1 {
            RateLimitOutcome::Limited
        } else {
            RateLimitOutcome::Allowed
        })
    }

    async fn record_failure(
        &self,
        scope: &str,
        key: &str,
        max_attempts: i64,
        lock_duration: Duration,
    ) -> Result<RateLimitOutcome, AppError> {
        let attempts_key = Self::attempts_key(scope, key);
        let lock_key = Self::lock_key(scope, key);
        let limited: i64 = self
            .pool
            .eval(
                FAILURE_SCRIPT,
                vec![attempts_key, lock_key],
                vec![
                    max_attempts,
                    lock_duration.as_secs() as i64,
                    ATTEMPTS_RETENTION.as_secs() as i64,
                ],
            )
            .await
            .map_err(|e| {
                tracing::error!(error = %e, scope, "Redis lockout failed");
                AppError::internal("Failed to record failed attempt")
            })?;
        Ok(if limited == 1 {
            RateLimitOutcome::Limited
        } else {
            RateLimitOutcome::Allowed
        })
    }

    async fn is_locked(&self, scope: &str, key: &str) -> Result<RateLimitOutcome, AppError> {
        let lock_key = Self::lock_key(scope, key);
        let exists: i64 = self.pool.exists(lock_key).await.map_err(|e| {
            tracing::error!(error = %e, scope, "Redis lock check failed");
            AppError::internal("Failed to read lockout state")
        })?;
        Ok(if exists > 0 {
            RateLimitOutcome::Limited
        } else {
            RateLimitOutcome::Allowed
        })
    }

    async fn clear(&self, scope: &str, key: &str) -> Result<(), AppError> {
        let attempts_key = Self::attempts_key(scope, key);
        let lock_key = Self::lock_key(scope, key);
        self.pool
            .del::<(), _>(vec![attempts_key, lock_key])
            .await
            .map_err(|e| {
                tracing::error!(error = %e, scope, "Redis clear failed");
                AppError::internal("Failed to clear lockout state")
            })?;
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// Startup selection
// ---------------------------------------------------------------------------

/// Builds the configured rate limiter from `RATE_LIMIT_ADAPTER` /
/// `RATE_LIMIT_REDIS_URL`. Fails fast on invalid combinations (e.g. `redis`
/// without a URL, or an unreachable Redis).
pub async fn build_rate_limiter(pool: &PgPool) -> Result<Arc<dyn RateLimiter>, String> {
    let adapter = std::env::var("RATE_LIMIT_ADAPTER")
        .ok()
        .map(|value| value.trim().to_ascii_lowercase())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "auto".to_string());
    let redis_url = std::env::var("RATE_LIMIT_REDIS_URL")
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());

    match adapter.as_str() {
        "postgres" => {
            info!("rate limiter: postgres backend");
            Ok(Arc::new(PostgresRateLimiter::new(pool.clone())))
        }
        "redis" => {
            let url = redis_url.ok_or_else(|| {
                "RATE_LIMIT_ADAPTER=redis requires RATE_LIMIT_REDIS_URL to be set".to_string()
            })?;
            let limiter = RedisRateLimiter::connect(&url).await?;
            info!("rate limiter: redis backend");
            Ok(Arc::new(limiter))
        }
        "auto" => match redis_url {
            Some(url) => {
                let limiter = RedisRateLimiter::connect(&url).await?;
                info!("rate limiter: redis backend (auto)");
                Ok(Arc::new(limiter))
            }
            None => {
                info!("rate limiter: postgres backend (auto)");
                Ok(Arc::new(PostgresRateLimiter::new(pool.clone())))
            }
        },
        other => Err(format!(
            "invalid RATE_LIMIT_ADAPTER '{other}' (expected auto, postgres, or redis)"
        )),
    }
}

#[cfg(test)]
#[path = "rate_limit_tests.rs"]
mod rate_limit_tests;
