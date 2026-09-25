use super::*;
use crate::jobs::sql::cleanup_pending_attachment_uploads;

pub(super) fn grant_body(id: &str) -> Value {
    json!({
        "fileName":"opaque.enc", "contentType":"application/octet-stream", "fileSize":4,
        "durableUpload":{"attachmentId":id,"ciphertextSha256":"a".repeat(64)}
    })
}

async fn immutable_claim(pool: &PgPool, id: &str) -> String {
    query_scalar("SELECT (to_jsonb(p)-'expires_at'-'next_cleanup_at'-'created_by'-'item_id'-'vault_id'-'team_id'-'cleanup_attempt_id')::text FROM pending_attachment_upload p WHERE attachment_id=$1")
        .bind(id).fetch_one(pool).await.unwrap()
}

pub(super) async fn make_due(pool: &PgPool, id: &str) {
    query("UPDATE pending_attachment_upload SET expires_at=NOW()-INTERVAL '1 second',next_cleanup_at=NOW()-INTERVAL '1 second' WHERE attachment_id=$1")
        .bind(id).execute(pool).await.unwrap();
}

#[tokio::test]
async fn durable_claims_survive_each_parent_cascade_and_cannot_reattach_to_recreated_item() {
    for parent in ["item", "vault", "user", "team"] {
        with_api_test_app_state(
            &format!("durable_attachment_retired_{parent}"),
            |state| state.with_object_storage(Arc::new(RecordingObjectStorage::succeeding(None))),
            |app| async move {
                let fixture = build_vault_router_fixture(&app.pool).await;
                let actor_id = if parent == "user" { &fixture.admin_user_id } else { &fixture.owner_user_id };
                let session = app.issue_session(actor_id).await;
                let headers = authenticated_json_headers(&session.token);
                let item_id = if parent == "team" { &fixture.personal_item_id } else { &fixture.movable_item_id };
                let path = format!("/api/v1/items/{item_id}/attachment-uploads");
                let id = "attachment_retired";
                let body = grant_body(id);
                let durable = app.api_json(Method::POST, &path, Some(body.clone()), headers.clone()).await;
                assert_eq!(durable.status, StatusCode::OK, "{}", durable.body);
                let claim = immutable_claim(&app.pool, id).await;
                let mut ordinary_body = body.clone();
                ordinary_body.as_object_mut().unwrap().remove("durableUpload");
                let ordinary = app.api_json(Method::POST, &path, Some(ordinary_body), headers.clone()).await;
                assert_eq!(ordinary.status, StatusCode::OK, "{}", ordinary.body);
                // Exercise the database lifecycle used by every parent remover, including FK
                // cascades. Ordinary reservations still cascade; durable evidence survives.
                let (sql, parent_id) = match parent {
                    "item" => ("DELETE FROM item WHERE id=$1", &fixture.movable_item_id),
                    "vault" => ("DELETE FROM vault WHERE id=$1", &fixture.main_vault_id),
                    "user" => ("DELETE FROM \"user\" WHERE id=$1", &fixture.admin_user_id),
                    "team" => ("DELETE FROM team WHERE id=$1", &fixture.paid_team_id),
                    _ => unreachable!(),
                };
                if parent == "team" {
                    // Team removal first detaches live memberships; their existing RESTRICT FK
                    // is separate from the reservation's retained cleanup evidence.
                    query("UPDATE \"user\" SET team_id=NULL WHERE team_id=$1")
                        .bind(&fixture.paid_team_id).execute(&app.pool).await.unwrap();
                    query("DELETE FROM vault WHERE team_id=$1")
                        .bind(&fixture.paid_team_id).execute(&app.pool).await.unwrap();
                }
                query(sql).bind(parent_id).execute(&app.pool).await.unwrap();
                assert_eq!(immutable_claim(&app.pool, id).await, claim, "{parent}");
                assert!(query_scalar::<_, bool>("SELECT created_by IS NULL OR item_id IS NULL OR vault_id IS NULL OR team_id IS NULL FROM pending_attachment_upload WHERE attachment_id=$1")
                    .bind(id).fetch_one(&app.pool).await.unwrap());
                assert_eq!(query_scalar::<_, i64>("SELECT COUNT(*) FROM pending_attachment_upload WHERE attachment_id=$1")
                    .bind(ordinary.body["attachmentId"].as_str().unwrap()).fetch_one(&app.pool).await.unwrap(), 0);
                if parent == "item" {
                    seed_item(&app.pool, &fixture.movable_item_id, &fixture.main_vault_id, "login", "new ciphertext", "new iv", &fixture.owner_user_id).await;
                    let retry = app.api_json(Method::POST, &path, Some(body), headers).await;
                    assert_eq!(retry.status, StatusCode::CONFLICT, "a recreated Item cannot rebind the old claim: {}", retry.body);
                    assert_eq!(immutable_claim(&app.pool, id).await, claim);
                }
                make_due(&app.pool, id).await;
                assert_eq!(cleanup_pending_attachment_uploads(&app.pool, app.state.object_storage.as_ref()).await.unwrap(), 1);
                assert_eq!(immutable_claim(&app.pool, id).await, claim);
                assert_eq!(cleanup_pending_attachment_uploads(&app.pool, app.state.object_storage.as_ref()).await.unwrap(), 0);
            },
        ).await;
    }
}

#[tokio::test]
async fn durable_cleanup_reschedules_failures_and_retains_duty_for_a_late_object() {
    with_api_test_app_state(
        "durable_attachment_cleanup_retry",
        |state| state.with_object_storage(Arc::new(RecordingObjectStorage::succeeding(None))),
        |app| async move {
            let fixture = build_vault_router_fixture(&app.pool).await;
            let session = app.issue_session(&fixture.owner_user_id).await;
            let headers = authenticated_json_headers(&session.token);
            let path = format!("/api/v1/items/{}/attachment-uploads", fixture.movable_item_id);
            let id = "attachment_cleanup_retry";
            let grant = app.api_json(Method::POST, &path, Some(grant_body(id)), headers).await;
            assert_eq!(grant.status, StatusCode::OK, "{}", grant.body);
            let claim = immutable_claim(&app.pool, id).await;
            make_due(&app.pool, id).await;
            let failed = RecordingObjectStorage::failing_delete();
            assert!(cleanup_pending_attachment_uploads(&app.pool, &failed).await.is_err());
            assert_eq!(failed.calls(), vec![format!("delete:{}", grant.body["key"].as_str().unwrap())]);
            assert_eq!(immutable_claim(&app.pool, id).await, claim);
            let seconds: i64 = query_scalar("SELECT EXTRACT(EPOCH FROM (next_cleanup_at-NOW()))::bigint FROM pending_attachment_upload WHERE attachment_id=$1")
                .bind(id).fetch_one(&app.pool).await.unwrap();
            assert!((850..=900).contains(&seconds));
            assert_eq!(cleanup_pending_attachment_uploads(&app.pool, &failed).await.unwrap(), 0);
            make_due(&app.pool, id).await;
            let present = Arc::new(std::sync::atomic::AtomicBool::new(true));
            let storage = RecordingObjectStorage::succeeding_with_object_presence(present.clone());
            assert_eq!(cleanup_pending_attachment_uploads(&app.pool, &storage).await.unwrap(), 1);
            assert!(!present.load(std::sync::atomic::Ordering::SeqCst));
            let seconds: i64 = query_scalar("SELECT EXTRACT(EPOCH FROM (next_cleanup_at-NOW()))::bigint FROM pending_attachment_upload WHERE attachment_id=$1")
                .bind(id).fetch_one(&app.pool).await.unwrap();
            assert!((86_350..=86_400).contains(&seconds));
            // Complete an old external PUT after successful deletion. This controlled provider
            // recreates the object; the retained duty must remove it on the next scheduled visit.
            present.store(true, std::sync::atomic::Ordering::SeqCst);
            make_due(&app.pool, id).await;
            assert_eq!(cleanup_pending_attachment_uploads(&app.pool, &storage).await.unwrap(), 1);
            assert_eq!(storage.calls().len(), 2);
            assert!(!present.load(std::sync::atomic::Ordering::SeqCst), "late object must be reclaimed again");
            assert_eq!(immutable_claim(&app.pool, id).await, claim);
        },
    ).await;
}

pub(super) fn metadata(id: &str, key: &Value) -> Value {
    json!({
        "attachmentId":id,"storageKey":key,"fileSize":4,
        "encryptedAttachmentKey":"encrypted-key","attachmentKeyIv":"key-iv",
        "attachmentKeyAlgorithm":"AES-GCM-AAD-V1","envelopeVersion":1,
        "encryptedName":"encrypted-name","encryptionIv":"name-iv",
        "encryptionAlgorithm":"AES-GCM-AAD-V1","encryptedContentType":"encrypted-type",
        "encryptedContentTypeIv":"type-iv"
    })
}

#[tokio::test]
async fn durable_registration_cannot_consume_a_lease_that_expires_during_object_verification() {
    let started = Arc::new(tokio::sync::Notify::new());
    let release = Arc::new(tokio::sync::Notify::new());
    let storage = Arc::new(RecordingObjectStorage::succeeding_with_delayed_exact_head(
        102,
        "application/octet-stream",
        &"a".repeat(64),
        started.clone(),
        release.clone(),
    ));
    with_api_test_app_state(
        "durable_attachment_head_expiry",
        move |state| state.with_object_storage(storage),
        |app| async move {
            let fixture = build_vault_router_fixture(&app.pool).await;
            let session = app.issue_session(&fixture.owner_user_id).await;
            let headers = authenticated_json_headers(&session.token);
            let id = "attachment_head_expiry";
            let grant = app.api_json(Method::POST, &format!("/api/v1/items/{}/attachment-uploads", fixture.movable_item_id), Some(grant_body(id)), headers.clone()).await;
            assert_eq!(grant.status, StatusCode::OK, "{}", grant.body);
            let expires: OffsetDateTime = query_scalar("UPDATE pending_attachment_upload SET expires_at=NOW()+INTERVAL '2 seconds',next_cleanup_at=NOW()+INTERVAL '2 seconds' WHERE attachment_id=$1 RETURNING expires_at")
                .bind(id).fetch_one(&app.pool).await.unwrap();
            let claim = immutable_claim(&app.pool,id).await;
            let request_app = app.clone();
            let item_id = fixture.movable_item_id.clone();
            let request = tokio::spawn(async move {
                request_app.api_json(Method::POST, &format!("/api/v1/items/{item_id}/attachments"), Some(metadata(id, &grant.body["key"])), headers).await
            });
            let entered = tokio::time::timeout(std::time::Duration::from_secs(5),started.notified()).await;
            if entered.is_ok() {
                let remaining = (expires-OffsetDateTime::now_utc()).whole_milliseconds().max(0) as u64;
                tokio::time::sleep(std::time::Duration::from_millis(remaining+100)).await;
            }
            // Cleanup selected the now-expired lease must wait for the same lock throughout
            // HEAD. Once registration refuses, it can safely delete and reschedule the object.
            let cleanup_pool=app.pool.clone();
            let cleanup_storage=app.state.object_storage.clone();
            let cleanup=tokio::spawn(async move { cleanup_pending_attachment_uploads(&cleanup_pool,cleanup_storage.as_ref()).await });
            let cleanup_waiting=wait_for_advisory_waiters(&app.pool,1).await;
            release.notify_one();
            let result = tokio::time::timeout(std::time::Duration::from_secs(5),request).await.unwrap().unwrap();
            let cleaned=tokio::time::timeout(std::time::Duration::from_secs(5),cleanup).await.unwrap().unwrap().unwrap();
            entered.expect("registration should reach held object verification before expiry");
            assert!(cleanup_waiting,"cleanup must conserve the reservation lock across HEAD");
            assert_eq!(cleaned,1);
            assert_eq!(result.status, StatusCode::BAD_REQUEST, "expired lease cannot publish metadata: {}", result.body);
            assert_eq!(query_scalar::<_, i64>("SELECT COUNT(*) FROM item_attachment WHERE id=$1").bind(id).fetch_one(&app.pool).await.unwrap(),0);
            assert_eq!(immutable_claim(&app.pool,id).await,claim,"expired registration must not consume the reservation");
        },
    ).await;
}

#[tokio::test]
async fn durable_grant_cancellation_bounds_its_database_wait_before_the_first_sync_lock() {
    with_api_test_app_state(
        "durable_attachment_sync_wait_bound",
        |state| state.with_object_storage(Arc::new(RecordingObjectStorage::succeeding(None))),
        |app| async move {
            let fixture = build_vault_router_fixture(&app.pool).await;
            let session = app.issue_session(&fixture.owner_user_id).await;
            let hold = crate::db::events::begin_sync_event_transaction(&app.pool).await.unwrap();
            let request_app = app.clone();
            let path = format!("/api/v1/items/{}/attachment-uploads",fixture.movable_item_id);
            let request = tokio::spawn(async move {
                request_app.api_json(Method::POST,&path,Some(grant_body("attachment_cancelled_wait")),authenticated_json_headers(&session.token)).await
            });
            let wait_count = || async {
                query_scalar::<_, i64>("SELECT COUNT(*) FROM pg_stat_activity WHERE datname=current_database() AND wait_event='advisory'")
                    .fetch_one(&app.pool).await.unwrap()
            };
            let entered = tokio::time::timeout(std::time::Duration::from_secs(5),async {
                while wait_count().await == 0 { tokio::time::sleep(std::time::Duration::from_millis(10)).await; }
            }).await;
            // Drop the actual route future, like a disconnected HTTP caller. SQLx must not leave
            // a query waiting forever behind the held Sync lock after returning the connection.
            request.abort();
            let _ = request.await;
            let drained = if entered.is_ok() {
                tokio::time::timeout(std::time::Duration::from_secs(32),async {
                    while wait_count().await != 0 { tokio::time::sleep(std::time::Duration::from_millis(100)).await; }
                }).await.is_ok()
            } else { false };
            hold.rollback().await.unwrap();
            entered.expect("actual grant must wait for the first Sync lock");
            assert!(drained,"cancelled route left its database wait alive past the bounded statement lifetime");
            assert_eq!(query_scalar::<_,i64>("SELECT COUNT(*) FROM pending_attachment_upload WHERE attachment_id='attachment_cancelled_wait'").fetch_one(&app.pool).await.unwrap(),0);
        },
    ).await;
}

async fn wait_for_advisory_waiters(pool: &PgPool, minimum: i64) -> bool {
    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        loop {
            let waiting = query_scalar::<_,i64>("SELECT COUNT(*) FROM pg_stat_activity WHERE datname=current_database() AND wait_event='advisory'").fetch_one(pool).await.unwrap();
            if waiting >= minimum { break; }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
    }).await.is_ok()
}

#[tokio::test]
async fn held_durable_cleanup_finishes_before_exact_renewal_can_issue_a_new_grant() {
    let storage = Arc::new(RecordingObjectStorage::succeeding(None));
    let observed = storage.clone();
    with_api_test_app_state(
        "durable_cleanup_blocks_renewal",
        move |state| state.with_object_storage(storage),
        |app| async move {
            let fixture = build_vault_router_fixture(&app.pool).await;
            let session = app.issue_session(&fixture.owner_user_id).await;
            let headers = authenticated_json_headers(&session.token);
            let path = format!(
                "/api/v1/items/{}/attachment-uploads",
                fixture.movable_item_id
            );
            let id = "attachment_cleanup_held";
            let grant = app
                .api_json(Method::POST, &path, Some(grant_body(id)), headers.clone())
                .await;
            assert_eq!(grant.status, StatusCode::OK, "{}", grant.body);
            make_due(&app.pool, id).await;
            let claim = immutable_claim(&app.pool, id).await;
            let started = Arc::new(tokio::sync::Notify::new());
            let release = Arc::new(tokio::sync::Notify::new());
            let cleanup_storage = RecordingObjectStorage::succeeding_with_delayed_delete(
                102,
                started.clone(),
                release.clone(),
            );
            let cleanup_pool = app.pool.clone();
            let cleanup = tokio::spawn(async move {
                cleanup_pending_attachment_uploads(&cleanup_pool, &cleanup_storage).await
            });
            let entered =
                tokio::time::timeout(std::time::Duration::from_secs(5), started.notified()).await;
            let request_app = app.clone();
            let renewed = tokio::spawn(async move {
                request_app
                    .api_json(Method::POST, &path, Some(grant_body(id)), headers)
                    .await
            });
            let waiting = wait_for_advisory_waiters(&app.pool, 1).await;
            let presigns_during_delete = observed.upload_requests().len();
            release.notify_one();
            let cleanup_result = tokio::time::timeout(std::time::Duration::from_secs(5), cleanup)
                .await
                .unwrap()
                .unwrap()
                .unwrap();
            let renewed = tokio::time::timeout(std::time::Duration::from_secs(5), renewed)
                .await
                .unwrap()
                .unwrap();
            entered.expect("cleanup must reach held object deletion");
            assert!(waiting, "renewal must wait for the same reservation lock");
            assert_eq!(
                presigns_during_delete, 1,
                "a new grant cannot race ahead of old object deletion"
            );
            assert_eq!(cleanup_result, 1);
            assert_eq!(renewed.status, StatusCode::OK, "{}", renewed.body);
            assert_eq!(renewed.body["key"], grant.body["key"]);
            assert_eq!(immutable_claim(&app.pool, id).await, claim);
            assert_eq!(
                cleanup_pending_attachment_uploads(&app.pool, app.state.object_storage.as_ref())
                    .await
                    .unwrap(),
                0,
                "renewed active lease cannot be reclaimed"
            );
        },
    )
    .await;
}

#[tokio::test]
async fn stale_cleanup_selection_rechecks_a_renewed_lease_under_the_identity_lock() {
    let storage = Arc::new(RecordingObjectStorage::succeeding(None));
    let observed = storage.clone();
    with_api_test_app_state(
        "durable_cleanup_stale_selection",
        move |state| state.with_object_storage(storage),
        |app| async move {
            let fixture = build_vault_router_fixture(&app.pool).await;
            let session = app.issue_session(&fixture.owner_user_id).await;
            let headers = authenticated_json_headers(&session.token);
            let path = format!(
                "/api/v1/items/{}/attachment-uploads",
                fixture.movable_item_id
            );
            let id = "attachment_stale_selection";
            let grant = app
                .api_json(Method::POST, &path, Some(grant_body(id)), headers.clone())
                .await;
            assert_eq!(grant.status, StatusCode::OK, "{}", grant.body);
            make_due(&app.pool, id).await;
            let mut hold = app.pool.begin().await.unwrap();
            crate::shared::transaction::acquire_advisory_lock(
                &mut *hold,
                &format!("attachment-upload:{}:{id}", id.len()),
                "test holds reservation identity",
            )
            .await
            .unwrap();
            let request_app = app.clone();
            let renewed = tokio::spawn(async move {
                request_app
                    .api_json(Method::POST, &path, Some(grant_body(id)), headers)
                    .await
            });
            let renewal_waiting = wait_for_advisory_waiters(&app.pool, 1).await;
            let cleanup_pool = app.pool.clone();
            let cleanup_storage = app.state.object_storage.clone();
            let cleanup = tokio::spawn(async move {
                cleanup_pending_attachment_uploads(&cleanup_pool, cleanup_storage.as_ref()).await
            });
            let cleanup_waiting = wait_for_advisory_waiters(&app.pool, 2).await;
            // PostgreSQL's existing advisory wait queue admits the earlier renewal, then the cleanup
            // selected against the expired row. Rechecking must preserve the newly committed lease.
            hold.rollback().await.unwrap();
            let renewed = tokio::time::timeout(std::time::Duration::from_secs(5), renewed)
                .await
                .unwrap()
                .unwrap();
            let cleanup = tokio::time::timeout(std::time::Duration::from_secs(5), cleanup)
                .await
                .unwrap()
                .unwrap()
                .unwrap();
            assert!(
                renewal_waiting && cleanup_waiting,
                "both requests must reach the shared identity wait"
            );
            assert_eq!(renewed.status, StatusCode::OK, "{}", renewed.body);
            assert_eq!(cleanup, 0);
            assert!(
                observed
                    .calls()
                    .iter()
                    .all(|call| !call.starts_with("delete:")),
                "stale selection must not delete the renewed object"
            );
        },
    )
    .await;
}

#[tokio::test]
async fn durable_cleanup_bounds_each_fair_batch_and_protects_any_current_exact_key_reference() {
    let storage = Arc::new(RecordingObjectStorage::succeeding(None));
    let observed = storage.clone();
    with_api_test_app_state("durable_cleanup_bounded_batch",move |state|state.with_object_storage(storage),|app| async move {
        let fixture=build_vault_router_fixture(&app.pool).await;
        let session=app.issue_session(&fixture.owner_user_id).await;
        let headers=authenticated_json_headers(&session.token);
        let path=format!("/api/v1/items/{}/attachment-uploads",fixture.movable_item_id);
        let protected="attachment_batch_protected";
        let first=app.api_json(Method::POST,&path,Some(grant_body(protected)),headers.clone()).await;
        assert_eq!(first.status,StatusCode::OK,"{}",first.body);
        make_due(&app.pool,protected).await;
        // Existing current metadata may refer to this key under a different Attachment ID.
        // The object's current reference, rather than ID equality, governs reclamation.
        query("UPDATE item_attachment SET storage_key=$1 WHERE id=$2").bind(first.body["key"].as_str().unwrap()).bind(&fixture.attachment_id).execute(&app.pool).await.unwrap();
        for index in 0..101 {
            let id=format!("attachment_batch_{index:03}");
            let grant=app.api_json(Method::POST,&path,Some(grant_body(&id)),headers.clone()).await;
            assert_eq!(grant.status,StatusCode::OK,"batch{index}: {}",grant.body);
            make_due(&app.pool,&id).await;
        }
        let calls_before=observed.calls().len();
        assert_eq!(cleanup_pending_attachment_uploads(&app.pool,app.state.object_storage.as_ref()).await.unwrap(),100);
        let deleted=observed.calls()[calls_before..].to_vec();
        assert_eq!(deleted.len(),100,"visit a bounded selection once");
        assert_eq!(deleted.iter().collect::<std::collections::BTreeSet<_>>().len(),100);
        assert!(!deleted.contains(&format!("delete:{}",first.body["key"].as_str().unwrap())));
        assert_eq!(cleanup_pending_attachment_uploads(&app.pool,app.state.object_storage.as_ref()).await.unwrap(),1,"current reference must not monopolize the next batch");
        assert_eq!(cleanup_pending_attachment_uploads(&app.pool,app.state.object_storage.as_ref()).await.unwrap(),0);
        assert_eq!(query_scalar::<_,i64>("SELECT COUNT(*) FROM pending_attachment_upload WHERE durable_request_fingerprint IS NOT NULL").fetch_one(&app.pool).await.unwrap(),102,"cleanup never deletes accepted identity");
        // A same-Account Move changes the published key while keeping the Attachment ID. The old
        // key's retained duty becomes eligible without modifying its reservation.
        query("UPDATE item_attachment SET storage_key='attachments/current-moved-key' WHERE id=$1").bind(&fixture.attachment_id).execute(&app.pool).await.unwrap();
        assert_eq!(cleanup_pending_attachment_uploads(&app.pool,app.state.object_storage.as_ref()).await.unwrap(),1);
        assert_eq!(observed.calls().last().unwrap(),&format!("delete:{}",first.body["key"].as_str().unwrap()));
    }).await;
}

#[tokio::test]
async fn durable_cleanup_retries_exact_object_after_database_rescheduling_failure() {
    let presence = Arc::new(std::sync::atomic::AtomicBool::new(true));
    let storage = Arc::new(RecordingObjectStorage::succeeding_with_object_presence(
        presence.clone(),
    ));
    let observed = storage.clone();
    with_api_test_app_state("durable_cleanup_reschedule_failure",move |state|state.with_object_storage(storage),|app| async move {
        let fixture=build_vault_router_fixture(&app.pool).await;
        let session=app.issue_session(&fixture.owner_user_id).await;
        let id="attachment_reschedule_failure";
        let granted=app.api_json(Method::POST,&format!("/api/v1/items/{}/attachment-uploads",fixture.movable_item_id),Some(grant_body(id)),authenticated_json_headers(&session.token)).await;
        assert_eq!(granted.status,StatusCode::OK,"{}",granted.body);
        make_due(&app.pool,id).await;
        let before:String=query_scalar("SELECT to_jsonb(p)::text FROM pending_attachment_upload p WHERE attachment_id=$1").bind(id).fetch_one(&app.pool).await.unwrap();
        // Reject only the post-delete durable transition in this isolated database. Successful
        // external deletion cannot erase the original due row when its database commit fails.
        query("ALTER TABLE pending_attachment_upload ADD CONSTRAINT test_reject_cleanup_reschedule CHECK (cleanup_attempt_id IS NOT NULL OR next_cleanup_at <= expires_at)").execute(&app.pool).await.unwrap();
        let failed=cleanup_pending_attachment_uploads(&app.pool,app.state.object_storage.as_ref()).await;
        let after:String=query_scalar("SELECT to_jsonb(p)::text FROM pending_attachment_upload p WHERE attachment_id=$1").bind(id).fetch_one(&app.pool).await.unwrap();
        query("ALTER TABLE pending_attachment_upload DROP CONSTRAINT test_reject_cleanup_reschedule").execute(&app.pool).await.unwrap();
        assert!(failed.is_err());
        assert!(!presence.load(std::sync::atomic::Ordering::SeqCst),"physical deletion preceded failed durable transition");
        let mut before_json:Value=serde_json::from_str(&before).unwrap();
        let mut after_json:Value=serde_json::from_str(&after).unwrap();
        assert!(after_json["cleanup_attempt_id"].is_string(),"pre-I/O fence survives failed final commit");
        for value in [&mut before_json,&mut after_json] { value.as_object_mut().unwrap().remove("cleanup_attempt_id");value.as_object_mut().unwrap().remove("next_cleanup_at"); }
        assert_eq!(after_json,before_json);
        make_due(&app.pool,id).await;
        assert_eq!(cleanup_pending_attachment_uploads(&app.pool,app.state.object_storage.as_ref()).await.unwrap(),1);
        let deletes=observed.calls().into_iter().filter(|call|call.starts_with("delete:")).collect::<Vec<_>>();
        assert_eq!(deletes,vec![format!("delete:{}",granted.body["key"].as_str().unwrap());2]);
        assert_eq!(cleanup_pending_attachment_uploads(&app.pool,app.state.object_storage.as_ref()).await.unwrap(),0);
    }).await;
}
