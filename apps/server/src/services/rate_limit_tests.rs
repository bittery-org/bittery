use std::time::Duration;

use super::*;
use crate::test_support::with_rpc_test_app;

const SHORT_WINDOW: Duration = Duration::from_secs(60);

#[tokio::test]
async fn postgres_check_and_increment_allows_up_to_limit_then_blocks() {
    with_rpc_test_app("rate_limit_pg_counter", |app| async move {
        let limiter = PostgresRateLimiter::new(app.pool.clone());
        let scope = "test_counter";
        let key = "subject-a";

        for _ in 0..3 {
            assert_eq!(
                limiter
                    .check_and_increment(scope, key, 3, SHORT_WINDOW)
                    .await
                    .expect("counter should run"),
                RateLimitOutcome::Allowed
            );
        }
        assert_eq!(
            limiter
                .check_and_increment(scope, key, 3, SHORT_WINDOW)
                .await
                .expect("counter should run"),
            RateLimitOutcome::Limited
        );

        // A different key is unaffected.
        assert_eq!(
            limiter
                .check_and_increment(scope, "subject-b", 3, SHORT_WINDOW)
                .await
                .expect("counter should run"),
            RateLimitOutcome::Allowed
        );
    })
    .await;
}

#[tokio::test]
async fn postgres_record_failure_locks_and_clear_resets() {
    with_rpc_test_app("rate_limit_pg_lockout", |app| async move {
        let limiter = PostgresRateLimiter::new(app.pool.clone());
        let scope = "test_lockout";
        let key = "account-a";
        let lock = Duration::from_secs(900);

        assert_eq!(
            limiter
                .is_locked(scope, key)
                .await
                .expect("lock check should run"),
            RateLimitOutcome::Allowed
        );

        assert_eq!(
            limiter
                .record_failure(scope, key, 3, lock)
                .await
                .expect("record failure should run"),
            RateLimitOutcome::Allowed
        );
        assert_eq!(
            limiter
                .record_failure(scope, key, 3, lock)
                .await
                .expect("record failure should run"),
            RateLimitOutcome::Allowed
        );
        assert_eq!(
            limiter
                .record_failure(scope, key, 3, lock)
                .await
                .expect("record failure should run"),
            RateLimitOutcome::Limited
        );

        // Now locked.
        assert_eq!(
            limiter
                .is_locked(scope, key)
                .await
                .expect("lock check should run"),
            RateLimitOutcome::Limited
        );

        limiter.clear(scope, key).await.expect("clear should run");

        assert_eq!(
            limiter
                .is_locked(scope, key)
                .await
                .expect("lock check should run"),
            RateLimitOutcome::Allowed
        );
        // Attempts reset after clear.
        assert_eq!(
            limiter
                .record_failure(scope, key, 3, lock)
                .await
                .expect("record failure should run"),
            RateLimitOutcome::Allowed
        );
    })
    .await;
}

/// Redis backend semantics, gated on `RATE_LIMIT_REDIS_URL` (skipped when absent),
/// mirroring how integration tests gate on `DATABASE_URL`.
#[tokio::test]
async fn redis_backend_counter_and_lockout_semantics() {
    let Ok(url) = std::env::var("RATE_LIMIT_REDIS_URL") else {
        eprintln!("skipping redis rate limit test: RATE_LIMIT_REDIS_URL not set");
        return;
    };
    if url.trim().is_empty() {
        eprintln!("skipping redis rate limit test: RATE_LIMIT_REDIS_URL empty");
        return;
    }

    let limiter = RedisRateLimiter::connect(url.trim())
        .await
        .expect("redis rate limiter should connect");

    // Unique keys per run so shared Redis instances do not collide.
    let suffix = uuid::Uuid::new_v4().to_string();
    let counter_scope = "test_counter";
    let counter_key = format!("counter-{suffix}");

    for _ in 0..3 {
        assert_eq!(
            limiter
                .check_and_increment(counter_scope, &counter_key, 3, SHORT_WINDOW)
                .await
                .expect("counter should run"),
            RateLimitOutcome::Allowed
        );
    }
    assert_eq!(
        limiter
            .check_and_increment(counter_scope, &counter_key, 3, SHORT_WINDOW)
            .await
            .expect("counter should run"),
        RateLimitOutcome::Limited
    );

    let lock_scope = "test_lockout";
    let lock_key = format!("account-{suffix}");
    let lock = Duration::from_secs(900);

    assert_eq!(
        limiter
            .record_failure(lock_scope, &lock_key, 3, lock)
            .await
            .expect("record failure should run"),
        RateLimitOutcome::Allowed
    );
    assert_eq!(
        limiter
            .record_failure(lock_scope, &lock_key, 3, lock)
            .await
            .expect("record failure should run"),
        RateLimitOutcome::Allowed
    );
    assert_eq!(
        limiter
            .record_failure(lock_scope, &lock_key, 3, lock)
            .await
            .expect("record failure should run"),
        RateLimitOutcome::Limited
    );
    assert_eq!(
        limiter
            .is_locked(lock_scope, &lock_key)
            .await
            .expect("lock check should run"),
        RateLimitOutcome::Limited
    );

    limiter
        .clear(lock_scope, &lock_key)
        .await
        .expect("clear should run");
    assert_eq!(
        limiter
            .is_locked(lock_scope, &lock_key)
            .await
            .expect("lock check should run"),
        RateLimitOutcome::Allowed
    );

    // Cleanup counter key.
    limiter
        .clear(counter_scope, &counter_key)
        .await
        .expect("clear should run");
}
