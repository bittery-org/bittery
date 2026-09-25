use super::cleanup_tests::{grant_body, make_due, metadata};
use super::*;

async fn entire_claim(pool: &PgPool, id: &str) -> String {
    query_scalar("SELECT to_jsonb(p)::text FROM pending_attachment_upload p WHERE attachment_id=$1")
        .bind(id)
        .fetch_one(pool)
        .await
        .unwrap()
}

#[tokio::test]
async fn durable_grant_refuses_changed_bytes_scope_permissions_and_global_collisions() {
    let storage = Arc::new(RecordingObjectStorage::succeeding(None));
    let observed = storage.clone();
    with_api_test_app_state(
        "durable_attachment_claim_refusals",
        move |state| state.with_object_storage(storage),
        |app| async move {
            let fixture = build_vault_router_fixture(&app.pool).await;
            let owner = app.issue_session(&fixture.owner_user_id).await;
            let headers = authenticated_json_headers(&owner.token);
            let path = format!(
                "/api/v1/items/{}/attachment-uploads",
                fixture.movable_item_id
            );
            let id = "attachment_fixed_claim";
            let body = grant_body(id);
            let granted = app
                .api_json(Method::POST, &path, Some(body.clone()), headers.clone())
                .await;
            assert_eq!(granted.status, StatusCode::OK, "{}", granted.body);
            let original = entire_claim(&app.pool, id).await;
            for (field, value) in [
                ("fileName", json!("changed.enc")),
                ("fileSize", json!(8)),
                ("contentType", json!("text/plain")),
            ] {
                let mut changed = body.clone();
                changed[field] = value;
                let response = app
                    .api_json(Method::POST, &path, Some(changed), headers.clone())
                    .await;
                assert!(
                    !response.status.is_success(),
                    "changed {field}: {}",
                    response.body
                );
                assert_eq!(entire_claim(&app.pool, id).await, original);
            }
            let mut changed = body.clone();
            changed["durableUpload"]["ciphertextSha256"] = json!("b".repeat(64));
            let response = app
                .api_json(Method::POST, &path, Some(changed), headers.clone())
                .await;
            assert_eq!(response.status, StatusCode::CONFLICT, "{}", response.body);
            let response = app
                .api_bytes(
                    Method::POST,
                    &path,
                    format!(" {} ", body).into_bytes(),
                    headers.clone(),
                )
                .await;
            assert_eq!(
                response.status,
                StatusCode::CONFLICT,
                "semantically equal changed raw bytes are another request: {}",
                response.body
            );
            let admin = app.issue_session(&fixture.admin_user_id).await;
            let response = app
                .api_json(
                    Method::POST,
                    &path,
                    Some(body.clone()),
                    authenticated_json_headers(&admin.token),
                )
                .await;
            assert_eq!(
                response.status,
                StatusCode::CONFLICT,
                "another writable User cannot claim the ID: {}",
                response.body
            );
            let response = app
                .api_json(
                    Method::POST,
                    &format!(
                        "/api/v1/items/{}/attachment-uploads",
                        fixture.active_item_id
                    ),
                    Some(body.clone()),
                    headers.clone(),
                )
                .await;
            assert_eq!(
                response.status,
                StatusCode::CONFLICT,
                "another writable Item cannot claim the ID: {}",
                response.body
            );
            query("UPDATE vault_key SET role='read-only' WHERE vault_id=$1 AND user_id=$2")
                .bind(&fixture.main_vault_id)
                .bind(&fixture.owner_user_id)
                .execute(&app.pool)
                .await
                .unwrap();
            let response = app
                .api_json(Method::POST, &path, Some(body.clone()), headers.clone())
                .await;
            assert_eq!(response.status, StatusCode::FORBIDDEN, "{}", response.body);
            query("UPDATE vault_key SET role='admin' WHERE vault_id=$1 AND user_id=$2")
                .bind(&fixture.main_vault_id)
                .bind(&fixture.owner_user_id)
                .execute(&app.pool)
                .await
                .unwrap();
            query("UPDATE team SET billing_plan='free' WHERE id=$1")
                .bind(&fixture.paid_team_id)
                .execute(&app.pool)
                .await
                .unwrap();
            let response = app
                .api_json(Method::POST, &path, Some(body.clone()), headers.clone())
                .await;
            assert_eq!(response.status, StatusCode::FORBIDDEN, "{}", response.body);
            query("UPDATE team SET billing_plan='family' WHERE id=$1")
                .bind(&fixture.paid_team_id)
                .execute(&app.pool)
                .await
                .unwrap();
            assert_eq!(entire_claim(&app.pool, id).await, original);
            assert_eq!(
                observed.upload_requests().len(),
                1,
                "refused requests never issue overwrite capability"
            );
            let mut ordinary = body.clone();
            ordinary.as_object_mut().unwrap().remove("durableUpload");
            let ordinary = app
                .api_json(Method::POST, &path, Some(ordinary), headers.clone())
                .await;
            assert_eq!(ordinary.status, StatusCode::OK, "{}", ordinary.body);
            assert!(ordinary.body.get("uploadHeaders").is_none());
            let ordinary_id = ordinary.body["attachmentId"].as_str().unwrap();
            let ordinary_claim = entire_claim(&app.pool, ordinary_id).await;
            let collision = app
                .api_json(
                    Method::POST,
                    &path,
                    Some(grant_body(ordinary_id)),
                    headers.clone(),
                )
                .await;
            assert_eq!(collision.status, StatusCode::CONFLICT, "{}", collision.body);
            assert_eq!(entire_claim(&app.pool, ordinary_id).await, ordinary_claim);
            let collision = app
                .api_json(
                    Method::POST,
                    &path,
                    Some(grant_body(&fixture.attachment_id)),
                    headers,
                )
                .await;
            assert_eq!(
                collision.status,
                StatusCode::CONFLICT,
                "published IDs are globally claimed: {}",
                collision.body
            );
        },
    )
    .await;
}

#[tokio::test]
async fn durable_concurrent_renewal_counts_active_quota_once_and_expired_lease_reacquires_it() {
    with_api_test_app_state("durable_attachment_exact_quota",|state|state.with_object_storage(Arc::new(RecordingObjectStorage::succeeding(None))),|app| async move {
        let fixture=build_vault_router_fixture(&app.pool).await;
        let owner=app.issue_session(&fixture.owner_user_id).await;
        let headers=authenticated_json_headers(&owner.token);
        let path=format!("/api/v1/items/{}/attachment-uploads",fixture.movable_item_id);
        let id="attachment_quota_claim";
        let body=grant_body(id);
        query("UPDATE item_attachment SET storage_size=$1 WHERE id=$2").bind(1024_i64*1024*1024-102).bind(&fixture.attachment_id).execute(&app.pool).await.unwrap();
        let first=app.api_json(Method::POST,&path,Some(body.clone()),headers.clone()).await;
        assert_eq!(first.status,StatusCode::OK,"{}",first.body);
        let (a,b)=tokio::join!(app.api_json(Method::POST,&path,Some(body.clone()),headers.clone()),app.api_json(Method::POST,&path,Some(body.clone()),headers.clone()));
        for response in [a,b] {assert_eq!(response.status,StatusCode::OK,"active reservation must count once: {}",response.body);assert_eq!(response.body["key"],first.body["key"]);}
        assert_eq!(query_scalar::<_,i64>("SELECT SUM(storage_size)::bigint FROM pending_attachment_upload WHERE team_id=$1 AND consumed_at IS NULL AND expires_at>NOW()").bind(&fixture.paid_team_id).fetch_one(&app.pool).await.unwrap(),102);
        let refused=app.api_json(Method::POST,&path,Some(grant_body("attachment_no_quota")),headers.clone()).await;
        assert!(!refused.status.is_success(),"new identity exceeds exact quota: {}",refused.body);
        make_due(&app.pool,id).await;
        let replacement=app.api_json(Method::POST,&path,Some(grant_body("attachment_new_quota")),headers.clone()).await;
        assert_eq!(replacement.status,StatusCode::OK,"expired lease releases its active quota: {}",replacement.body);
        let expired=entire_claim(&app.pool,id).await;
        let refused=app.api_json(Method::POST,&path,Some(body),headers).await;
        assert!(!refused.status.is_success(),"expired renewal must reacquire quota: {}",refused.body);
        assert_eq!(entire_claim(&app.pool,id).await,expired);
    }).await;
}

#[tokio::test]
async fn durable_registration_requires_exact_provider_size_digest_and_content_type() {
    for (label, size, content_type, digest) in [
        ("size", 103, "application/octet-stream", "a".repeat(64)),
        ("digest", 102, "application/octet-stream", "b".repeat(64)),
        ("type", 102, "text/plain", "a".repeat(64)),
    ] {
        with_api_test_app_state(
            &format!("durable_attachment_provider_{label}"),
            move |state| {
                state.with_object_storage(Arc::new(
                    RecordingObjectStorage::succeeding_exact_object(size, content_type, &digest),
                ))
            },
            |app| async move {
                let fixture = build_vault_router_fixture(&app.pool).await;
                let session = app.issue_session(&fixture.owner_user_id).await;
                let headers = authenticated_json_headers(&session.token);
                let id = "attachment_provider_bound";
                let grant = app
                    .api_json(
                        Method::POST,
                        &format!(
                            "/api/v1/items/{}/attachment-uploads",
                            fixture.movable_item_id
                        ),
                        Some(grant_body(id)),
                        headers.clone(),
                    )
                    .await;
                assert_eq!(grant.status, StatusCode::OK, "{}", grant.body);
                let claim = entire_claim(&app.pool, id).await;
                let response = app
                    .api_json(
                        Method::POST,
                        &format!("/api/v1/items/{}/attachments", fixture.movable_item_id),
                        Some(metadata(id, &grant.body["key"])),
                        headers,
                    )
                    .await;
                assert_eq!(
                    response.status,
                    StatusCode::BAD_REQUEST,
                    "provider {label} mismatch: {}",
                    response.body
                );
                assert_eq!(entire_claim(&app.pool, id).await, claim);
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
}
