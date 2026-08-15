use std::sync::Arc;

use sqlx::{query, query_scalar};
use time::{Duration, OffsetDateTime};

use super::{
    cleanup_expired_sessions, cleanup_pending_attachment_uploads, cleanup_tombstones,
    prune_rate_limit_state, prune_sync_events,
};
use crate::services::vault_key_rotation::cleanup_rotation_plans;
use crate::test_support::{
    seed_item, seed_team, seed_user, seed_vault, with_api_test_app, RecordingObjectStorage,
};

#[tokio::test]
async fn time_based_pruning_deletes_only_expired_database_rows() {
    with_api_test_app("jobs_time_based_pruning", |app| async move {
        seed_user(
            &app.pool,
            "user_jobs_pruning",
            "Jobs Pruning",
            "jobs-pruning@example.com",
        )
        .await;
        let now = OffsetDateTime::now_utc();

        for (id, expires_at) in [
            ("session_jobs_expired", now - Duration::hours(1)),
            ("session_jobs_live", now + Duration::hours(1)),
        ] {
            query(
                "INSERT INTO session (id, expires_at, updated_at, user_id) VALUES ($1, $2, $3, $4)",
            )
            .bind(id)
            .bind(expires_at)
            .bind(now)
            .bind("user_jobs_pruning")
            .execute(&app.pool)
            .await
            .expect("session should seed");
        }

        for (id, created_at) in [
            ("sync_jobs_expired", now - Duration::days(31)),
            ("sync_jobs_live", now - Duration::days(29)),
        ] {
            query(
                "INSERT INTO sync_event (id, event_type, entity_id, entity_type, user_id, created_at) VALUES ($1, 'vault_updated', $2, 'vault', $3, $4)",
            )
            .bind(id)
            .bind(id)
            .bind("user_jobs_pruning")
            .bind(created_at)
            .execute(&app.pool)
            .await
            .expect("sync event should seed");
        }

        for (key, updated_at, locked_until) in [
            ("expired", now - Duration::days(3), None),
            ("recent", now - Duration::days(1), None),
            (
                "still-locked",
                now - Duration::days(3),
                Some(now + Duration::hours(1)),
            ),
        ] {
            query(
                "INSERT INTO rate_limit_state (scope, key, updated_at, locked_until) VALUES ('jobs', $1, $2, $3)",
            )
            .bind(key)
            .bind(updated_at)
            .bind(locked_until)
            .execute(&app.pool)
            .await
            .expect("rate-limit row should seed");
        }

        assert_eq!(cleanup_expired_sessions(&app.pool).await.unwrap(), 1);
        assert_eq!(prune_sync_events(&app.pool).await.unwrap(), 1);
        assert_eq!(prune_rate_limit_state(&app.pool).await.unwrap(), 1);

        let sessions = query_scalar::<_, String>("SELECT id FROM session ORDER BY id")
            .fetch_all(&app.pool)
            .await
            .unwrap();
        assert_eq!(sessions, ["session_jobs_live"]);
        let events = query_scalar::<_, String>("SELECT id FROM sync_event ORDER BY id")
            .fetch_all(&app.pool)
            .await
            .unwrap();
        assert_eq!(events, ["sync_jobs_live"]);
        let limiter_keys = query_scalar::<_, String>(
            "SELECT key FROM rate_limit_state WHERE scope = 'jobs' ORDER BY key",
        )
        .fetch_all(&app.pool)
        .await
        .unwrap();
        assert_eq!(limiter_keys, ["recent", "still-locked"]);
    })
    .await;
}

#[tokio::test]
async fn pending_attachment_cleanup_deletes_expired_reservations_and_storage_objects() {
    with_api_test_app("jobs_pending_attachment_cleanup", |app| async move {
        seed_user(
            &app.pool,
            "user_jobs_attachment",
            "Jobs Attachment",
            "jobs-attachment@example.com",
        )
        .await;
        seed_team(
            &app.pool,
            "team_jobs_attachment",
            "Jobs Attachment Team",
            "user_jobs_attachment",
            "organization",
            "team",
            "active",
        )
        .await;
        seed_vault(
            &app.pool,
            "vault_jobs_attachment",
            "Jobs Attachment Vault",
            "team",
            "user_jobs_attachment",
            Some("team_jobs_attachment"),
        )
        .await;
        seed_item(
            &app.pool,
            "item_jobs_attachment",
            "vault_jobs_attachment",
            "login",
            "encrypted",
            "iv",
            "user_jobs_attachment",
        )
        .await;
        let now = OffsetDateTime::now_utc();
        for (id, key, expires_at, consumed_at) in [
            (
                "upload_jobs_expired",
                "attachments/jobs/expired",
                now - Duration::hours(1),
                None,
            ),
            (
                "upload_jobs_live",
                "attachments/jobs/live",
                now + Duration::hours(1),
                None,
            ),
            (
                "upload_jobs_consumed",
                "attachments/jobs/consumed",
                now - Duration::hours(1),
                Some(now - Duration::minutes(30)),
            ),
        ] {
            query(
                "INSERT INTO pending_attachment_upload (id, team_id, vault_id, item_id, storage_key, file_size, storage_size, content_type, created_by, expires_at, consumed_at, attachment_id) VALUES ($1, $2, $3, $4, $5, 1, 1, 'text/plain', $6, $7, $8, $9)",
            )
            .bind(id)
            .bind("team_jobs_attachment")
            .bind("vault_jobs_attachment")
            .bind("item_jobs_attachment")
            .bind(key)
            .bind("user_jobs_attachment")
            .bind(expires_at)
            .bind(consumed_at)
            .bind(format!("attachment_{id}"))
            .execute(&app.pool)
            .await
            .expect("pending upload should seed");
        }

        let storage = Arc::new(RecordingObjectStorage::succeeding(None));
        assert_eq!(
            cleanup_pending_attachment_uploads(&app.pool, storage.as_ref())
                .await
                .unwrap(),
            1
        );
        assert_eq!(
            storage.calls(),
            ["delete:attachments/jobs/expired".to_string()]
        );
        let remaining = query_scalar::<_, String>(
            "SELECT id FROM pending_attachment_upload ORDER BY id",
        )
        .fetch_all(&app.pool)
        .await
        .unwrap();
        assert_eq!(remaining, ["upload_jobs_consumed", "upload_jobs_live"]);
    })
    .await;
}

#[tokio::test]
async fn tombstone_cleanup_deletes_only_old_items_and_emits_sync_events() {
    with_api_test_app("jobs_tombstone_cleanup", |app| async move {
        seed_user(
            &app.pool,
            "user_jobs_tombstone",
            "Jobs Tombstone",
            "jobs-tombstone@example.com",
        )
        .await;
        seed_vault(
            &app.pool,
            "vault_jobs_tombstone",
            "Jobs Tombstone Vault",
            "personal",
            "user_jobs_tombstone",
            None,
        )
        .await;
        for id in ["item_jobs_old_tombstone", "item_jobs_recent_tombstone"] {
            seed_item(
                &app.pool,
                id,
                "vault_jobs_tombstone",
                "login",
                "encrypted",
                "iv",
                "user_jobs_tombstone",
            )
            .await;
        }
        let now = OffsetDateTime::now_utc();
        query("UPDATE item SET deleted_at = $1 WHERE id = $2")
            .bind(now - Duration::days(91))
            .bind("item_jobs_old_tombstone")
            .execute(&app.pool)
            .await
            .unwrap();
        query("UPDATE item SET deleted_at = $1 WHERE id = $2")
            .bind(now - Duration::days(89))
            .bind("item_jobs_recent_tombstone")
            .execute(&app.pool)
            .await
            .unwrap();

        assert_eq!(cleanup_tombstones(&app.pool).await.unwrap(), 1);

        let remaining = query_scalar::<_, String>("SELECT id FROM item ORDER BY id")
            .fetch_all(&app.pool)
            .await
            .unwrap();
        assert_eq!(remaining, ["item_jobs_recent_tombstone"]);
        let event = query_scalar::<_, String>(
            "SELECT metadata FROM sync_event WHERE entity_id = $1 AND event_type = 'item_permanently_deleted'",
        )
        .bind("item_jobs_old_tombstone")
        .fetch_one(&app.pool)
        .await
        .expect("permanent deletion sync event should exist");
        assert_eq!(event, r#"{"reason":"tombstone_cleanup"}"#);
    })
    .await;
}

#[tokio::test]
async fn rotation_plan_cleanup_deletes_expired_plans_and_cascades_staged_data() {
    with_api_test_app("jobs_rotation_plan_cleanup", |app| async move {
        seed_user(
            &app.pool,
            "user_jobs_rotation",
            "Jobs Rotation",
            "jobs-rotation@example.com",
        )
        .await;
        seed_vault(
            &app.pool,
            "vault_jobs_rotation",
            "Jobs Rotation Vault",
            "personal",
            "user_jobs_rotation",
            None,
        )
        .await;
        let now = OffsetDateTime::now_utc();
        for (id, idle_expires_at, absolute_expires_at) in [
            (
                "rotation_plan_jobs_expired",
                now - Duration::hours(2),
                now - Duration::hours(1),
            ),
            (
                "rotation_plan_jobs_live",
                now + Duration::hours(1),
                now + Duration::hours(2),
            ),
        ] {
            query(
                "INSERT INTO vault_key_rotation_plan (id, vault_id, initiator_user_id, reason, authorization_context, expected_key_version, idle_expires_at, absolute_expires_at) VALUES ($1, $2, $3, 'manual', '{}', 1, $4, $5)",
            )
            .bind(id)
            .bind("vault_jobs_rotation")
            .bind("user_jobs_rotation")
            .bind(idle_expires_at)
            .bind(absolute_expires_at)
            .execute(&app.pool)
            .await
            .expect("rotation plan should seed");
        }
        query(
            "INSERT INTO vault_key_rotation_plan_manifest (plan_id, kind, entity_id, expected_version, payload) VALUES ($1, 'item', 'item_jobs_rotation', 1, '{}')",
        )
        .bind("rotation_plan_jobs_expired")
        .execute(&app.pool)
        .await
        .expect("rotation manifest should seed");
        query(
            "INSERT INTO vault_key_rotation_plan_staged_output (plan_id, kind, entity_id, payload, payload_hash) VALUES ($1, 'item', 'item_jobs_rotation', '{}', 'hash')",
        )
        .bind("rotation_plan_jobs_expired")
        .execute(&app.pool)
        .await
        .expect("rotation staged output should seed");

        assert_eq!(cleanup_rotation_plans(&app.pool, 10).await.unwrap(), 1);

        let plans = query_scalar::<_, String>(
            "SELECT id FROM vault_key_rotation_plan ORDER BY id",
        )
        .fetch_all(&app.pool)
        .await
        .unwrap();
        assert_eq!(plans, ["rotation_plan_jobs_live"]);
        let child_rows: i64 = query_scalar(
            "SELECT (SELECT COUNT(*) FROM vault_key_rotation_plan_manifest) + (SELECT COUNT(*) FROM vault_key_rotation_plan_staged_output)",
        )
        .fetch_one(&app.pool)
        .await
        .unwrap();
        assert_eq!(child_rows, 0);
    })
    .await;
}
