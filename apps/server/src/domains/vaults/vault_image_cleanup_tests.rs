//! PostgreSQL locking/ownership regressions; object storage remains an explicit capability fixture.
use super::{vault_image_cleanup, UpdateVaultInput};
use crate::test_support::{
    seed_user, seed_vault, seed_vault_key, with_api_test_app, RecordingObjectStorage,
};
use sqlx::{query, query_scalar};
use std::sync::Arc;

#[tokio::test]
async fn physical_cleanup_fences_late_legacy_adoption_and_missing_object_cannot_be_published() {
    with_api_test_app("image_cleanup_adoption_fence", |app| async move {
        let user = "image_fence_user";
        let vault = "image_fence_vault";
        let key = "image-fence-object";
        seed_user(&app.pool, user, "Owner", "image-fence@example.com").await;
        seed_vault(&app.pool, vault, "Vault", "personal", user, None).await;
        seed_vault_key(
            &app.pool,
            "image_fence_key",
            vault,
            user,
            "wrapped-key",
            "owner",
        )
        .await;
        query("INSERT INTO vault_image_cleanup(object_key) VALUES($1)")
            .bind(key)
            .execute(&app.pool)
            .await
            .unwrap();
        let started = Arc::new(tokio::sync::Notify::new());
        let release = Arc::new(tokio::sync::Notify::new());
        let deleting = Arc::new(RecordingObjectStorage::succeeding_with_delayed_delete(
            1,
            started.clone(),
            release.clone(),
        ));
        let pool = app.pool.clone();
        let cleaner = tokio::spawn(async move {
            vault_image_cleanup::cleanup_key(&pool, deleting.as_ref(), key).await
        });
        started.notified().await;
        let absent = RecordingObjectStorage::succeeding_with_absent_object();
        let adoption = super::update_vault(
            &app.pool,
            &absent,
            user,
            None,
            UpdateVaultInput {
                vault_id: vault.to_owned(),
                name: None,
                icon: None,
                image_key: Some(Some(key.to_owned())),
                client_id: None,
            },
        );
        tokio::pin!(adoption);
        assert!(
            tokio::time::timeout(std::time::Duration::from_millis(50), &mut adoption)
                .await
                .is_err()
        );
        assert!(
            absent.calls().is_empty(),
            "HEAD must wait for the physical deletion fence"
        );
        release.notify_one();
        assert_eq!(cleaner.await.unwrap().unwrap(), 1);
        assert!(
            adoption.await.is_err(),
            "deleted object cannot be reattached after cleanup wins"
        );
        assert_eq!(
            query_scalar::<_, Option<String>>("SELECT image_key FROM vault WHERE id=$1")
                .bind(vault)
                .fetch_one(&app.pool)
                .await
                .unwrap(),
            None
        );
    })
    .await;
}

#[tokio::test]
async fn legacy_readoption_cancels_obsolete_cleanup_before_the_worker_can_delete() {
    with_api_test_app("image_readoption_wins", |app| async move {
        let user = "image_readoption_user";
        let vault = "image_readoption_vault";
        let key = "image-readoption-object";
        seed_user(&app.pool, user, "Owner", "image-readoption@example.com").await;
        seed_vault(&app.pool, vault, "Vault", "personal", user, None).await;
        seed_vault_key(
            &app.pool,
            "image_readoption_key",
            vault,
            user,
            "wrapped-key",
            "owner",
        )
        .await;
        query("INSERT INTO vault_image_cleanup(object_key) VALUES($1)")
            .bind(key)
            .execute(&app.pool)
            .await
            .unwrap();
        let storage = RecordingObjectStorage::succeeding(None);
        super::update_vault(
            &app.pool,
            &storage,
            user,
            None,
            UpdateVaultInput {
                vault_id: vault.to_owned(),
                name: None,
                icon: None,
                image_key: Some(Some(key.to_owned())),
                client_id: None,
            },
        )
        .await
        .unwrap();
        crate::jobs::sql::cleanup_vault_image_staging(&app.pool, &storage)
            .await
            .unwrap();
        assert!(!storage.calls().contains(&format!("delete:{key}")));
        assert_eq!(
            query_scalar::<_, Option<String>>("SELECT image_key FROM vault WHERE id=$1")
                .bind(vault)
                .fetch_one(&app.pool)
                .await
                .unwrap(),
            Some(key.to_owned())
        );
        assert_eq!(
            query_scalar::<_, i64>("SELECT COUNT(*) FROM vault_image_cleanup")
                .fetch_one(&app.pool)
                .await
                .unwrap(),
            0
        );
    })
    .await;
}

#[tokio::test]
async fn staged_cleanup_transfers_ownership_when_legacy_catalog_adopted_the_object() {
    with_api_test_app("image_stage_reference_cleanup", |app| async move {
        let user = "image_stage_adopter_user";
        let vault = "image_stage_adopter_vault";
        seed_user(&app.pool, user, "Owner", "image-stage-adopter@example.com").await;
        seed_vault(&app.pool, vault, "Vault", "personal", user, None).await;
        seed_vault_key(
            &app.pool,
            "image_stage_adopter_key",
            vault,
            user,
            "wrapped-key",
            "owner",
        )
        .await;
        let storage = RecordingObjectStorage::succeeding(None);
        let binding = super::VaultImageStagingBinding {
            operation_id: "image_stage_aborted_operation".to_owned(),
            vault_id: vault.to_owned(),
            raw_sha256: "a".repeat(64),
            raw_length: 1,
            content_type: "image/png".to_owned(),
        };
        let grant = super::grant_vault_image_staging(&app.pool, &storage, user, binding.clone())
            .await
            .unwrap();
        super::update_vault(
            &app.pool,
            &storage,
            user,
            None,
            UpdateVaultInput {
                vault_id: vault.to_owned(),
                name: None,
                icon: None,
                image_key: Some(Some(grant.object_key.clone())),
                client_id: None,
            },
        )
        .await
        .unwrap();
        super::request_vault_image_staging_cleanup(&app.pool, user, &binding)
            .await
            .unwrap();
        crate::jobs::sql::cleanup_vault_image_staging(&app.pool, &storage)
            .await
            .unwrap();
        assert!(!storage
            .calls()
            .contains(&format!("delete:{}", grant.object_key)));
        assert_eq!(
            query_scalar::<_, i64>("SELECT COUNT(*) FROM vault_image_staging WHERE user_id=$1")
                .bind(user)
                .fetch_one(&app.pool)
                .await
                .unwrap(),
            0
        );
        assert_eq!(
            query_scalar::<_, Option<String>>("SELECT image_key FROM vault WHERE id=$1")
                .bind(vault)
                .fetch_one(&app.pool)
                .await
                .unwrap(),
            Some(grant.object_key)
        );
    })
    .await;
}

#[tokio::test]
async fn failing_oldest_cleanup_batch_does_not_starve_later_objects() {
    with_api_test_app("image_cleanup_fair_progress",|app|async move {
        query("INSERT INTO vault_image_cleanup(object_key) SELECT 'fair-image-' || lpad(value::text,3,'0') FROM generate_series(0,100) value").execute(&app.pool).await.unwrap();
        let failing=RecordingObjectStorage::failing_delete();
        vault_image_cleanup::cleanup_pending(&app.pool,&failing).await.unwrap();
        assert_eq!(failing.calls().len(),100);
        let succeeding=RecordingObjectStorage::succeeding(None);
        vault_image_cleanup::cleanup_pending(&app.pool,&succeeding).await.unwrap();
        assert!(succeeding.calls().contains(&"delete:fair-image-100".to_owned()),"later work must get a turn after the oldest batch failed");
    }).await;
}

#[tokio::test]
async fn successful_object_delete_with_failed_database_finish_retains_the_duty() {
    with_api_test_app("image_cleanup_commit_retry",|app|async move {
        query("INSERT INTO vault_image_cleanup(object_key) VALUES('commit-retry-image')").execute(&app.pool).await.unwrap();
        query("CREATE FUNCTION fail_image_cleanup_finish() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected cleanup finish failure'; END $$").execute(&app.pool).await.unwrap();
        query("CREATE TRIGGER fail_image_cleanup_finish BEFORE DELETE ON vault_image_cleanup FOR EACH ROW EXECUTE FUNCTION fail_image_cleanup_finish()").execute(&app.pool).await.unwrap();
        let storage=RecordingObjectStorage::succeeding(None);
        assert!(vault_image_cleanup::cleanup_key(&app.pool,&storage,"commit-retry-image").await.is_err());
        assert_eq!(storage.calls(),vec!["delete:commit-retry-image"]);
        assert_eq!(query_scalar::<_,i64>("SELECT COUNT(*) FROM vault_image_cleanup").fetch_one(&app.pool).await.unwrap(),1);
        query("DROP TRIGGER fail_image_cleanup_finish ON vault_image_cleanup").execute(&app.pool).await.unwrap();
        assert_eq!(vault_image_cleanup::cleanup_key(&app.pool,&storage,"commit-retry-image").await.unwrap(),1);
        assert_eq!(storage.calls(),vec!["delete:commit-retry-image","delete:commit-retry-image"]);
        assert_eq!(query_scalar::<_,i64>("SELECT COUNT(*) FROM vault_image_cleanup").fetch_one(&app.pool).await.unwrap(),0);
    }).await;
}
