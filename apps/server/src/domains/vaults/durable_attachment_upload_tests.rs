use super::*;

#[path = "durable_attachment_upload_authority_tests.rs"]
mod authority_tests;
#[path = "durable_attachment_upload_cleanup_tests.rs"]
mod cleanup_tests;
#[path = "durable_attachment_upload_fence_tests.rs"]
mod fence_tests;
use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use bittery_crypto_core::{encrypt_with_aad, AadContext};
use sha2::{Digest, Sha256};

#[tokio::test]
async fn durable_attachment_grant_lost_response_retries_the_same_identity_and_bytes() {
    let storage = Arc::new(RecordingObjectStorage::succeeding(None));
    let observed_storage = storage.clone();
    with_api_test_app_state(
        "durable_attachment_grant_lost_response",
        move |state| state.with_object_storage(storage),
        |app| async move {
            let fixture = build_vault_router_fixture(&app.pool).await;
            let session = app.issue_session(&fixture.owner_user_id).await;
            let headers = authenticated_json_headers(&session.token);
            let path = format!(
                "/api/v1/items/{}/attachment-uploads",
                fixture.movable_item_id
            );
            let body = json!({
                "fileName": "opaque.enc",
                "contentType": "application/octet-stream",
                "fileSize": 4,
                "durableUpload": {
                    "attachmentId": "attachment_durable_fixed",
                    "ciphertextSha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
                }
            });
            let first = app
                .api_json(Method::POST, &path, Some(body.clone()), headers.clone())
                .await;
            assert_eq!(first.status, StatusCode::OK, "{}", first.body);
            let first_key: String = query_scalar(
                "SELECT storage_key FROM pending_attachment_upload WHERE attachment_id=$1",
            )
            .bind("attachment_durable_fixed")
            .fetch_one(&app.pool)
            .await
            .unwrap();
            // Simulate a committed response the caller cannot retain. Retry only the same intent.
            drop(first);
            let retried = app
                .api_json(Method::POST, &path, Some(body), headers)
                .await;
            assert_eq!(retried.status, StatusCode::OK, "{}", retried.body);
            assert_eq!(retried.body["attachmentId"], "attachment_durable_fixed");
            assert_eq!(retried.body["key"], first_key);
            assert_eq!(
                query_scalar::<_, i64>(
                    "SELECT COUNT(*) FROM pending_attachment_upload WHERE item_id=$1",
                )
                .bind(&fixture.movable_item_id)
                .fetch_one(&app.pool)
                .await
                .unwrap(),
                1
            );
            assert_eq!(retried.body["uploadHeaders"].as_array().unwrap().len(), 4);
            assert_eq!(observed_storage.calls().len(), 2);
            assert!(observed_storage
                .calls()
                .iter()
                .all(|call| call == &format!("presign_upload:{first_key}")));
        },
    )
    .await;
}

#[tokio::test]
async fn durable_attachment_registration_checks_nonempty_ciphertext_and_retains_its_claim() {
    let attachment_id = "attachment_durable_binary";
    let context = |entity_type: &str| AadContext {
        vault_id: "vault_main_team_vault".into(),
        user_id: "vault_owner_user".into(),
        entity_id: attachment_id.into(),
        entity_type: entity_type.into(),
        version: 1,
    };
    let file = b"file";
    let attachment_key = [31u8; 32];
    let vault_key = [42u8; 32];
    let blob = serde_json::to_vec(
        &encrypt_with_aad(
            &BASE64.encode(file),
            &attachment_key,
            &context("attachment_blob"),
        )
        .unwrap(),
    )
    .unwrap();
    assert_eq!(
        blob.len(),
        encrypted_attachment_storage_size(file.len() as i32) as usize
    );
    let digest = hex::encode(Sha256::digest(&blob));
    let name = encrypt_with_aad("file.txt", &vault_key, &context("attachment_name")).unwrap();
    let content_type = encrypt_with_aad(
        "text/plain",
        &vault_key,
        &context("attachment_content_type"),
    )
    .unwrap();
    let wrapped_key = encrypt_with_aad(
        &BASE64.encode(attachment_key),
        &vault_key,
        &context("attachment_key"),
    )
    .unwrap();
    let storage = Arc::new(RecordingObjectStorage::succeeding_exact_object(
        blob.len() as i64,
        "application/octet-stream",
        &digest,
    ));
    let observed_storage = storage.clone();
    with_api_test_app_state(
        "durable_attachment_registration_nonempty",
        move |state| state.with_object_storage(storage),
        |app| async move {
            let fixture = build_vault_router_fixture(&app.pool).await;
            let session = app.issue_session(&fixture.owner_user_id).await;
            let headers = authenticated_json_headers(&session.token);
            let path = format!("/api/v1/items/{}/attachment-uploads", fixture.movable_item_id);
            let grant_body = json!({
                "fileName": "opaque.enc", "contentType": "application/octet-stream",
                "fileSize": file.len(),
                "durableUpload": {"attachmentId": attachment_id, "ciphertextSha256": digest}
            });
            let grant = app.api_json(Method::POST, &path, Some(grant_body.clone()), headers.clone()).await;
            assert_eq!(grant.status, StatusCode::OK, "{}", grant.body);
            let original_claim: String = query_scalar("SELECT (to_jsonb(p)-'expires_at'-'next_cleanup_at')::text FROM pending_attachment_upload p WHERE attachment_id=$1")
                .bind(attachment_id).fetch_one(&app.pool).await.unwrap();
            query("UPDATE pending_attachment_upload SET expires_at=NOW()-INTERVAL '1 second',next_cleanup_at=NOW()-INTERVAL '1 second' WHERE attachment_id=$1")
                .bind(attachment_id).execute(&app.pool).await.unwrap();
            assert_eq!(
                crate::jobs::sql::cleanup_pending_attachment_uploads(&app.pool, app.state.object_storage.as_ref()).await.unwrap(),
                1,
                "expired durable object must be reclaimed while its immutable claim survives"
            );
            let retained_claim: String = query_scalar("SELECT (to_jsonb(p)-'expires_at'-'next_cleanup_at')::text FROM pending_attachment_upload p WHERE attachment_id=$1")
                .bind(attachment_id).fetch_one(&app.pool).await.unwrap();
            assert_eq!(retained_claim, original_claim);
            assert_eq!(
                crate::jobs::sql::cleanup_pending_attachment_uploads(&app.pool, app.state.object_storage.as_ref()).await.unwrap(),
                0,
                "cleanup reschedules the dormant duty instead of spinning"
            );
            let renewed = app.api_json(Method::POST, &path, Some(grant_body.clone()), headers.clone()).await;
            assert_eq!(renewed.status, StatusCode::OK, "{}", renewed.body);
            assert_eq!(renewed.body["attachmentId"], attachment_id);
            assert_eq!(renewed.body["key"], grant.body["key"]);
            assert_eq!(observed_storage.upload_requests().len(), 2);
            assert!(observed_storage.upload_requests().iter().all(|(_, _, size, hash)| *size == Some(blob.len() as i64) && hash.as_deref() == Some(digest.as_str())));
            assert!(observed_storage.calls().contains(&format!("delete:{}", grant.body["key"].as_str().unwrap())));
            let metadata = json!({
                "attachmentId": attachment_id, "storageKey": grant.body["key"],
                "encryptedAttachmentKey": wrapped_key.ciphertext,
                "attachmentKeyIv": wrapped_key.iv, "attachmentKeyAlgorithm": wrapped_key.algorithm,
                "envelopeVersion": 1, "encryptedName": name.ciphertext,
                "encryptionIv": name.iv, "encryptionAlgorithm": name.algorithm,
                "encryptedContentType": content_type.ciphertext,
                "encryptedContentTypeIv": content_type.iv, "fileSize": file.len()
            });
            let attachments_path = format!("/api/v1/items/{}/attachments", fixture.movable_item_id);
            let created = app.api_json(Method::POST, &attachments_path, Some(metadata.clone()), headers.clone()).await;
            assert_eq!(created.status, StatusCode::OK, "{}", created.body);
            assert_eq!(created.body["attachmentId"], attachment_id);
            let listed = app.api_json(Method::GET, &attachments_path, None, headers.clone()).await;
            assert_eq!(listed.status, StatusCode::OK, "{}", listed.body);
            let files = listed.body["items"].as_array().unwrap();
            assert_eq!(files.len(), 1);
            assert_eq!(files[0]["id"], attachment_id);
            for field in ["storageKey", "encryptedName", "encryptionIv", "encryptedContentType", "encryptedContentTypeIv", "encryptedAttachmentKey", "attachmentKeyIv", "attachmentKeyAlgorithm", "envelopeVersion", "fileSize"] {
                assert_eq!(files[0][field], metadata[field], "{field}");
            }
            let retained: (bool, bool) = query_as("SELECT consumed_at IS NOT NULL,next_cleanup_at IS NOT NULL FROM pending_attachment_upload WHERE attachment_id=$1")
                .bind(attachment_id).fetch_one(&app.pool).await.unwrap();
            assert_eq!(retained, (true, true));
            let refused = app.api_json(Method::POST, &path, Some(grant_body.clone()), headers.clone()).await;
            assert_eq!(refused.status, StatusCode::CONFLICT, "{}", refused.body);
            query("UPDATE pending_attachment_upload SET next_cleanup_at=NOW()-INTERVAL '1 second' WHERE attachment_id=$1")
                .bind(attachment_id).execute(&app.pool).await.unwrap();
            let protected_claim: String = query_scalar("SELECT to_jsonb(p)::text FROM pending_attachment_upload p WHERE attachment_id=$1")
                .bind(attachment_id).fetch_one(&app.pool).await.unwrap();
            let calls_before = observed_storage.calls();
            assert_eq!(crate::jobs::sql::cleanup_pending_attachment_uploads(&app.pool, app.state.object_storage.as_ref()).await.unwrap(), 0);
            assert_eq!(observed_storage.calls(), calls_before, "published exact object must never be deleted");
            assert_eq!(query_scalar::<_, String>("SELECT to_jsonb(p)::text FROM pending_attachment_upload p WHERE attachment_id=$1")
                .bind(attachment_id).fetch_one(&app.pool).await.unwrap(), protected_claim);
            let removed = app.api_json(Method::DELETE, &format!("/api/v1/attachments/{attachment_id}"), None, headers.clone()).await;
            assert_eq!(removed.status, StatusCode::OK, "{}", removed.body);
            assert_eq!(crate::jobs::sql::cleanup_pending_attachment_uploads(&app.pool, app.state.object_storage.as_ref()).await.unwrap(), 1,
                "Attachment deletion exposes the retained cleanup duty without another owner");
            let refused = app.api_json(Method::POST, &path, Some(grant_body), headers).await;
            assert_eq!(refused.status, StatusCode::CONFLICT, "consumed identity stays consumed after metadata deletion: {}", refused.body);
        },
    ).await;
}
