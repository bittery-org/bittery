use super::cleanup_tests::{grant_body, make_due, metadata};
use super::*;
use crate::jobs::sql::cleanup_pending_attachment_uploads;

#[tokio::test]
async fn ambiguous_remote_delete_cannot_authorize_renewal_or_registration_of_its_fixed_key() {
    let presence = Arc::new(std::sync::atomic::AtomicBool::new(true));
    let release = Arc::new(tokio::sync::Notify::new());
    let completed = Arc::new(tokio::sync::Notify::new());
    let storage = Arc::new(RecordingObjectStorage::failing_delete_with_delayed_effect(
        presence.clone(),
        release.clone(),
        completed.clone(),
    ));
    let observed = storage.clone();
    with_api_test_app_state(
        "durable_ambiguous_delete_fences_renewal",
        move |state| state.with_object_storage(storage),
        |app| async move {
            let fixture = build_vault_router_fixture(&app.pool).await;
            let session = app.issue_session(&fixture.owner_user_id).await;
            let headers = authenticated_json_headers(&session.token);
            let path = format!(
                "/api/v1/items/{}/attachment-uploads",
                fixture.movable_item_id
            );
            let id = "attachment_ambiguous_delete";
            let grant = app
                .api_json(Method::POST, &path, Some(grant_body(id)), headers.clone())
                .await;
            assert_eq!(grant.status, StatusCode::OK, "{}", grant.body);
            make_due(&app.pool, id).await;
            let cleanup =
                cleanup_pending_attachment_uploads(&app.pool, app.state.object_storage.as_ref())
                    .await;
            assert!(
                cleanup.is_err(),
                "provider lost its DELETE answer after accepting the effect"
            );
            let renewed = app
                .api_json(Method::POST, &path, Some(grant_body(id)), headers.clone())
                .await;
            // If incorrectly admitted, the new identical PUT finishes before the old DELETE.
            presence.store(true, std::sync::atomic::Ordering::SeqCst);
            let registered = app
                .api_json(
                    Method::POST,
                    &format!("/api/v1/items/{}/attachments", fixture.movable_item_id),
                    Some(metadata(id, &grant.body["key"])),
                    headers,
                )
                .await;
            release.notify_one();
            tokio::time::timeout(std::time::Duration::from_secs(5), completed.notified())
                .await
                .expect("detached remote DELETE must finish before assertions/fixture cleanup");
            assert!(!presence.load(std::sync::atomic::Ordering::SeqCst));
            assert_eq!(
                renewed.status,
                StatusCode::CONFLICT,
                "ambiguous old DELETE must forbid a new overwrite grant: {}",
                renewed.body
            );
            assert_eq!(
                registered.status,
                StatusCode::CONFLICT,
                "ambiguous old DELETE must forbid publication: {}",
                registered.body
            );
            assert_eq!(observed.upload_requests().len(), 1);
            assert_eq!(
                query_scalar::<_, i64>("SELECT COUNT(*) FROM item_attachment WHERE id=$1")
                    .bind(id)
                    .fetch_one(&app.pool)
                    .await
                    .unwrap(),
                0
            );
        },
    )
    .await;
}

#[tokio::test]
async fn durable_pre_io_fence_survives_owner_loss_and_recovery_never_clears_inherited_uncertainty()
{
    for lose_owner in [true, false] {
        let storage = Arc::new(RecordingObjectStorage::succeeding(None));
        let observed = storage.clone();
        with_api_test_app_state(&format!("durable_cleanup_owner_loss_{lose_owner}"),move |state|state.with_object_storage(storage),|app| async move {
            let fixture=build_vault_router_fixture(&app.pool).await;
            let session=app.issue_session(&fixture.owner_user_id).await;
            let headers=authenticated_json_headers(&session.token);
            let path=format!("/api/v1/items/{}/attachment-uploads",fixture.movable_item_id);
            let id=if lose_owner {"attachment_cleanup_owner_gone"} else {"attachment_cleanup_old_owner"};
            let grant=app.api_json(Method::POST,&path,Some(grant_body(id)),headers.clone()).await;
            assert_eq!(grant.status,StatusCode::OK,"{}",grant.body);
            make_due(&app.pool,id).await;
            let hook=crate::test_support::install_durable_attachment_cleanup_after_fence_hook(id);
            let old_pool=app.pool.clone();let old_storage=app.state.object_storage.clone();
            let old=tokio::spawn(async move {cleanup_pending_attachment_uploads(&old_pool,old_storage.as_ref()).await});
            let entered=tokio::time::timeout(std::time::Duration::from_secs(5),hook.wait_until_entered()).await;
            if entered.is_err() {hook.release();let _=old.await;panic!("cleanup must pause after durable fence commit before object I/O");}
            let original_token:Option<String>=query_scalar("SELECT cleanup_attempt_id FROM pending_attachment_upload WHERE attachment_id=$1").bind(id).fetch_one(&app.pool).await.unwrap();
            let calls_before=observed.calls();
            let mut old=Some(old);
            if lose_owner {let task=old.take().unwrap();task.abort();let _=task.await;}
            // Time passing only makes the cleanup duty due; it does not remove uncertainty.
            make_due(&app.pool,id).await;
            let recovery=cleanup_pending_attachment_uploads(&app.pool,app.state.object_storage.as_ref()).await;
            let recovered_token:Option<String>=query_scalar("SELECT cleanup_attempt_id FROM pending_attachment_upload WHERE attachment_id=$1").bind(id).fetch_one(&app.pool).await.unwrap();
            hook.release();
            let old_result=if let Some(old)=old {Some(tokio::time::timeout(std::time::Duration::from_secs(5),old).await.unwrap().unwrap().unwrap())} else {None};
            assert!(original_token.is_some(),"fence must be committed before external deletion can begin");
            assert!(calls_before.iter().all(|call|!call.starts_with("delete:")));
            assert_eq!(recovery.unwrap(),1);
            assert!(recovered_token.is_some());assert_ne!(recovered_token,original_token);
            assert!(old_result.is_none_or(|deleted|deleted==0),"paused old actor must reject the new token before I/O");
            assert_eq!(observed.calls().iter().filter(|call|call.starts_with("delete:")).count(),1);
            let refused=app.api_json(Method::POST,&path,Some(grant_body(id)),headers).await;
            assert_eq!(refused.status,StatusCode::CONFLICT,"confirmed recovery DELETE cannot rehabilitate an inherited fence: {}",refused.body);
            assert_eq!(query_scalar::<_,Option<String>>("SELECT cleanup_attempt_id FROM pending_attachment_upload WHERE attachment_id=$1").bind(id).fetch_one(&app.pool).await.unwrap(),recovered_token);
        }).await;
    }
}
