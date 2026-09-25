//! Retained Vault mutations exercise the actual router and isolated PostgreSQL transactions.

use crate::test_support::{
    authenticated_json_headers, seed_user, seed_vault, seed_vault_key, with_api_test_app,
};
use axum::http::{Method, StatusCode};
use serde_json::json;
use sqlx::query_scalar;

#[tokio::test]
async fn retained_rename_replays_one_effect_and_does_not_roll_back_newer_legacy_metadata() {
    with_api_test_app("retained_vault_rename", |app| async move {
        let user = "retained_vault_rename_user";
        let vault = "retained_vault_rename_vault";
        let operation = "retained_vault_rename_operation";
        seed_user(
            &app.pool,
            user,
            "Vault Owner",
            "retained-vault-owner@example.com",
        )
        .await;
        seed_vault(&app.pool, vault, "Original", "personal", user, None).await;
        seed_vault_key(
            &app.pool,
            "retained_vault_rename_key",
            vault,
            user,
            "wrapped-key",
            "owner",
        )
        .await;
        let session = app.issue_session(user).await;
        let headers = || {
            let mut headers = authenticated_json_headers(&session.token);
            headers.insert("idempotency-key", operation.parse().unwrap());
            headers
        };
        let path = format!("/api/v1/vaults/{vault}/metadata-updates");
        let body = Some(json!({"name": "  Retained rename  "}));
        let (first, concurrent) = tokio::join!(
            app.api_json(Method::POST, &path, body.clone(), headers()),
            app.api_json(Method::POST, &path, body.clone(), headers()),
        );
        assert_eq!(first.status, StatusCode::OK);
        assert_eq!(concurrent.body, first.body);
        assert_eq!(
            first.body,
            json!({
                "kind": "update_vault", "operationId": operation,
                "result": {"status": "applied", "vaultId": vault},
            })
        );
        assert_eq!(
            query_scalar::<_, String>("SELECT name FROM vault WHERE id=$1")
                .bind(vault)
                .fetch_one(&app.pool)
                .await
                .unwrap(),
            "Retained rename"
        );
        let replay = app
            .api_json(Method::POST, &path, body.clone(), headers())
            .await;
        assert_eq!(replay.body, first.body);
        assert_eq!(
            query_scalar::<_, i64>(
                "SELECT COUNT(*) FROM sync_event WHERE entity_id=$1 AND event_type='vault_updated'"
            )
            .bind(vault)
            .fetch_one(&app.pool)
            .await
            .unwrap(),
            1
        );
        assert_eq!(
            query_scalar::<_, i64>(
                "SELECT COUNT(*) FROM operation_outcome WHERE user_id=$1 AND operation_id=$2"
            )
            .bind(user)
            .bind(operation)
            .fetch_one(&app.pool)
            .await
            .unwrap(),
            1
        );

        let equivalent_json = app
            .api_bytes(
                Method::POST,
                &path,
                br#"{ "name" : "  Retained rename  " }"#.to_vec(),
                headers(),
            )
            .await;
        assert_eq!(equivalent_json.status, StatusCode::UNPROCESSABLE_ENTITY);
        assert_eq!(equivalent_json.body["code"], "OPERATION_ID_REUSED");

        let legacy = app
            .api_json(
                Method::PATCH,
                &format!("/api/v1/vaults/{vault}"),
                Some(json!({"name":"Newer legacy rename"})),
                authenticated_json_headers(&session.token),
            )
            .await;
        assert_eq!(legacy.status, StatusCode::OK);
        let replay = app.api_json(Method::POST, &path, body, headers()).await;
        assert_eq!(replay.body, first.body);
        assert_eq!(
            query_scalar::<_, String>("SELECT name FROM vault WHERE id=$1")
                .bind(vault)
                .fetch_one(&app.pool)
                .await
                .unwrap(),
            "Newer legacy rename"
        );
        let lookup = app
            .api_json(
                Method::GET,
                &format!("/api/v1/operations/{operation}"),
                None,
                authenticated_json_headers(&session.token),
            )
            .await;
        assert_eq!(lookup.status, StatusCode::OK);
        assert_eq!(lookup.body, first.body);
    })
    .await;
}

#[tokio::test]
async fn retained_delete_replays_after_vault_removal_and_new_id_is_denied() {
    with_api_test_app("retained_vault_delete", |app| async move {
        let user = "retained_vault_delete_user";
        let vault = "retained_vault_delete_vault";
        let operation = "retained_vault_delete_operation";
        seed_user(&app.pool, user, "Owner", "retained-delete@example.com").await;
        seed_vault(&app.pool, vault, "Delete me", "personal", user, None).await;
        seed_vault_key(&app.pool, "retained_vault_delete_key", vault, user, "wrapped-key", "owner").await;
        let session = app.issue_session(user).await;
        let headers = |operation: &str| {
            let mut headers = authenticated_json_headers(&session.token);
            headers.insert("idempotency-key", operation.parse().unwrap());
            headers
        };
        let path = format!("/api/v1/vaults/{vault}/deletions");
        let first = app.api_json(Method::POST, &path, Some(json!({})), headers(operation)).await;
        assert_eq!(first.status, StatusCode::OK);
        assert_eq!(first.body, json!({"kind":"delete_vault","operationId":operation,"result":{"status":"applied","vaultId":vault}}));
        for table in ["vault", "vault_key"] {
            let column = if table == "vault" { "id" } else { "vault_id" };
            assert_eq!(query_scalar::<_,i64>(&format!("SELECT COUNT(*) FROM {table} WHERE {column}=$1")).bind(vault).fetch_one(&app.pool).await.unwrap(),0);
        }
        let replay = app.api_json(Method::POST, &path, Some(json!({})), headers(operation)).await;
        assert_eq!(replay.status, StatusCode::OK);
        assert_eq!(replay.body, first.body);
        let lookup = app.api_json(Method::GET, &format!("/api/v1/operations/{operation}"), None, authenticated_json_headers(&session.token)).await;
        assert_eq!(lookup.body, first.body);
        assert_eq!(query_scalar::<_,i64>("SELECT COUNT(*) FROM sync_event WHERE entity_id=$1 AND event_type='vault_deleted'").bind(vault).fetch_one(&app.pool).await.unwrap(),1);
        let denied = app.api_json(Method::POST, &path, Some(json!({})), headers("retained_vault_delete_new_operation")).await;
        assert_eq!(denied.status, StatusCode::OK);
        assert_eq!(denied.body["result"], json!({"status":"rejected","code":"vault_access_denied"}));
    }).await;
}

#[tokio::test]
async fn retained_metadata_preserves_patch_states_and_empty_patch_has_no_catalog_effect() {
    with_api_test_app("retained_vault_patch", |app| async move {
        let user = "retained_vault_patch_user";
        let vault = "retained_vault_patch_vault";
        seed_user(&app.pool, user, "Owner", "retained-patch@example.com").await;
        seed_vault(&app.pool, vault, "Original name", "personal", user, None).await;
        seed_vault_key(
            &app.pool,
            "retained_vault_patch_key",
            vault,
            user,
            "wrapped-key",
            "owner",
        )
        .await;
        let session = app.issue_session(user).await;
        let path = format!("/api/v1/vaults/{vault}/metadata-updates");
        for (operation, body, expected_icon) in [
            ("set_icon", json!({"icon":"star"}), Some("star")),
            ("omit_icon", json!({"name":"Changed name"}), Some("star")),
            ("clear_icon", json!({"icon":null}), None),
            ("empty_patch", json!({}), None),
        ] {
            let mut headers = authenticated_json_headers(&session.token);
            headers.insert("idempotency-key", operation.parse().unwrap());
            let response = app.api_json(Method::POST, &path, Some(body), headers).await;
            assert_eq!(response.status, StatusCode::OK);
            assert_eq!(
                query_scalar::<_, Option<String>>("SELECT icon FROM vault WHERE id=$1")
                    .bind(vault)
                    .fetch_one(&app.pool)
                    .await
                    .unwrap()
                    .as_deref(),
                expected_icon
            );
        }
        assert_eq!(
            query_scalar::<_, i64>(
                "SELECT COUNT(*) FROM sync_event WHERE entity_id=$1 AND event_type='vault_updated'"
            )
            .bind(vault)
            .fetch_one(&app.pool)
            .await
            .unwrap(),
            3
        );
        assert_eq!(
            query_scalar::<_, i64>("SELECT COUNT(*) FROM operation_outcome WHERE user_id=$1")
                .bind(user)
                .fetch_one(&app.pool)
                .await
                .unwrap(),
            4
        );
    })
    .await;
}

#[tokio::test]
async fn retained_mutations_recheck_roles_isolate_users_and_reject_changed_identity() {
    with_api_test_app("retained_vault_authority", |app| async move {
        let vault = "retained_vault_authority_vault";
        for (user, role) in [("mutation_owner","owner"),("mutation_admin","admin"),("mutation_reader","read-only")] {
            seed_user(&app.pool,user,user,&format!("{user}@example.com")).await;
            if role == "owner" { seed_vault(&app.pool,vault,"Original","personal",user,None).await; }
            seed_vault_key(&app.pool,&format!("{user}_key"),vault,user,"wrapped-key",role).await;
        }
        let path = format!("/api/v1/vaults/{vault}/metadata-updates");
        for (user, expected) in [("mutation_admin","applied"),("mutation_reader","rejected")] {
            let session=app.issue_session(user).await;
            let mut headers=authenticated_json_headers(&session.token);
            headers.insert("idempotency-key","same_per_user_operation".parse().unwrap());
            let result=app.api_json(Method::POST,&path,Some(json!({"name":"Admin rename"})),headers.clone()).await;
            assert_eq!(result.status,StatusCode::OK);
            assert_eq!(result.body["result"]["status"],expected);
            if expected=="rejected" { assert_eq!(result.body["result"]["code"],"vault_access_denied"); }
            let changed=app.api_json(Method::POST,&path,Some(json!({"name":"Different bytes"})),headers.clone()).await;
            assert_eq!(changed.status,StatusCode::UNPROCESSABLE_ENTITY);
            assert_eq!(changed.body["code"],"OPERATION_ID_REUSED");
            headers.insert("idempotency-key","denied_delete".parse().unwrap());
            let deletion=app.api_json(Method::POST,&format!("/api/v1/vaults/{vault}/deletions"),Some(json!({})),headers).await;
            assert_eq!(deletion.status,StatusCode::OK);
            assert_eq!(deletion.body["result"],json!({"status":"rejected","code":"vault_access_denied"}));
        }
        assert_eq!(query_scalar::<_,String>("SELECT name FROM vault WHERE id=$1").bind(vault).fetch_one(&app.pool).await.unwrap(),"Admin rename");
        assert_eq!(query_scalar::<_,i64>("SELECT COUNT(*) FROM operation_outcome WHERE operation_id='same_per_user_operation'").fetch_one(&app.pool).await.unwrap(),2);
    }).await;
}

#[tokio::test]
async fn syntactically_invalid_mutations_do_not_retain_outcomes() {
    with_api_test_app("retained_vault_invalid", |app| async move {
        let user = "mutation_invalid_user";
        seed_user(&app.pool, user, "Owner", "mutation-invalid@example.com").await;
        let session = app.issue_session(user).await;
        for (suffix, body) in [
            ("metadata-updates", json!({"name":null})),
            ("metadata-updates", json!({"name":" x "})),
            (
                "metadata-updates",
                json!({"imageSource":"not-a-wire-field"}),
            ),
            ("deletions", json!({"name":"unexpected"})),
        ] {
            let mut headers = authenticated_json_headers(&session.token);
            headers.insert("idempotency-key", "invalid_operation".parse().unwrap());
            let response = app
                .api_json(
                    Method::POST,
                    &format!("/api/v1/vaults/nonexistent_vault/{suffix}"),
                    Some(body),
                    headers,
                )
                .await;
            assert!(
                response.status.is_client_error(),
                "{}: {}",
                response.status,
                response.body
            );
        }
        assert_eq!(
            query_scalar::<_, i64>("SELECT COUNT(*) FROM operation_outcome WHERE user_id=$1")
                .bind(user)
                .fetch_one(&app.pool)
                .await
                .unwrap(),
            0
        );
    })
    .await;
}

#[tokio::test]
async fn retained_image_replacement_requires_shared_confirmation_and_replay_never_cleans_new_image()
{
    use crate::test_support::{with_api_test_app_state, RecordingObjectStorage};
    use std::sync::Arc;
    let digest = "a".repeat(64);
    let storage = Arc::new(RecordingObjectStorage::succeeding_exact_object(
        32,
        "image/png",
        &digest,
    ));
    let observed = storage.clone();
    with_api_test_app_state(
        "retained_vault_image",
        move |state| state.with_object_storage(storage),
        |app| async move {
            let user = "mutation_image_user";
            let vault = "mutation_image_vault";
            let operation = "mutation_image_operation";
            seed_user(&app.pool, user, "Owner", "mutation-image@example.com").await;
            seed_vault(&app.pool, vault, "Image Vault", "personal", user, None).await;
            seed_vault_key(
                &app.pool,
                "mutation_image_key",
                vault,
                user,
                "wrapped-key",
                "owner",
            )
            .await;
            sqlx::query("UPDATE vault SET image_key='old-public-image' WHERE id=$1")
                .bind(vault)
                .execute(&app.pool)
                .await
                .unwrap();
            let session = app.issue_session(user).await;
            let binding = super::VaultImageStagingBinding {
                operation_id: operation.to_owned(),
                vault_id: vault.to_owned(),
                raw_sha256: digest,
                raw_length: 32,
                content_type: "image/png".to_owned(),
            };
            let grant = super::grant_vault_image_staging(
                &app.pool,
                observed.as_ref(),
                user,
                binding.clone(),
            )
            .await
            .unwrap();
            let mut headers = authenticated_json_headers(&session.token);
            headers.insert("idempotency-key", operation.parse().unwrap());
            let path = format!("/api/v1/vaults/{vault}/metadata-updates");
            let body = json!({"imageKey":grant.object_key});
            let unconfirmed = app
                .api_json(Method::POST, &path, Some(body.clone()), headers.clone())
                .await;
            assert_eq!(
                unconfirmed.status,
                StatusCode::CONFLICT,
                "{}",
                unconfirmed.body
            );
            assert_eq!(
                query_scalar::<_, i64>("SELECT COUNT(*) FROM operation_outcome WHERE user_id=$1")
                    .bind(user)
                    .fetch_one(&app.pool)
                    .await
                    .unwrap(),
                0
            );
            super::confirm_vault_image_staging(&app.pool, observed.as_ref(), user, &binding)
                .await
                .unwrap();
            let first = app
                .api_json(Method::POST, &path, Some(body.clone()), headers.clone())
                .await;
            assert_eq!(first.status, StatusCode::OK, "{}", first.body);
            assert_eq!(
                query_scalar::<_, Option<String>>("SELECT image_key FROM vault WHERE id=$1")
                    .bind(vault)
                    .fetch_one(&app.pool)
                    .await
                    .unwrap(),
                Some(grant.object_key.clone())
            );
            assert_eq!(
                query_scalar::<_, i64>("SELECT COUNT(*) FROM vault_image_staging WHERE user_id=$1")
                    .bind(user)
                    .fetch_one(&app.pool)
                    .await
                    .unwrap(),
                0
            );
            let replay = app
                .api_json(Method::POST, &path, Some(body), headers.clone())
                .await;
            assert_eq!(replay.body, first.body);
            assert!(super::grant_vault_image_staging(
                &app.pool,
                observed.as_ref(),
                user,
                binding.clone()
            )
            .await
            .is_err());
            assert_eq!(
                observed.upload_requests().len(),
                1,
                "resolved image Operation cannot recreate its retired staging binding"
            );
            assert_eq!(
                observed
                    .calls()
                    .iter()
                    .filter(|call| call.as_str() == "delete:old-public-image")
                    .count(),
                1
            );
            assert!(!observed
                .calls()
                .contains(&format!("delete:{}", grant.object_key)));
            headers.insert("idempotency-key", "mutation_image_remove".parse().unwrap());
            let removed = app
                .api_json(Method::POST, &path, Some(json!({"imageKey":null})), headers)
                .await;
            assert_eq!(removed.status, StatusCode::OK);
            assert_eq!(
                query_scalar::<_, Option<String>>("SELECT image_key FROM vault WHERE id=$1")
                    .bind(vault)
                    .fetch_one(&app.pool)
                    .await
                    .unwrap(),
                None
            );
            assert_eq!(
                observed
                    .calls()
                    .iter()
                    .filter(|call| *call == &format!("delete:{}", grant.object_key))
                    .count(),
                1
            );
        },
    )
    .await;
}

#[tokio::test]
async fn vault_mutation_database_constraints_reject_open_or_mismatched_results() {
    with_api_test_app("vault_mutation_shapes",|app|async move {
        let user="mutation_shape_user";
        seed_user(&app.pool,user,"Owner","mutation-shape@example.com").await;
        for kind in ["update_vault","delete_vault"] {
            for (index,payload) in [json!({}),json!({"vaultId":null}),json!({"vaultId":42}),json!({"vaultId":"vault","name":"untrusted"}),json!({"vaultId":"x".repeat(5000)})].into_iter().enumerate() {
                let error=sqlx::query("INSERT INTO operation_outcome(user_id,operation_id,operation_kind,request_fingerprint,result_status,applied_payload) VALUES($1,$2,$3::operation_kind,$4,'applied',$5)")
                    .bind(user).bind(format!("{kind}_{index}")).bind(kind).bind(vec![1_u8;32]).bind(payload).execute(&app.pool).await.unwrap_err();
                assert_eq!(error.as_database_error().and_then(|error|error.code()).as_deref(),Some("23514"));
            }
            for (index,code,details) in [(0,"vault_read_only",None),(1,"vault_access_denied",Some(json!({"untrusted":true})))] {
                let error=sqlx::query("INSERT INTO operation_outcome(user_id,operation_id,operation_kind,request_fingerprint,result_status,rejection_code,rejection_details) VALUES($1,$2,$3::operation_kind,$4,'rejected',$5::operation_rejection_code,$6)")
                    .bind(user).bind(format!("{kind}_rejected_{index}")).bind(kind).bind(vec![1_u8;32]).bind(code).bind(details).execute(&app.pool).await.unwrap_err();
                assert_eq!(error.as_database_error().and_then(|error|error.code()).as_deref(),Some("23514"));
            }
        }
    }).await;
}

#[tokio::test]
async fn retained_mutation_waits_for_current_authority_before_applying() {
    with_api_test_app("vault_mutation_authority_lock", |app| async move {
        let user = "mutation_locked_user";
        let vault = "mutation_locked_vault";
        seed_user(&app.pool, user, "Owner", "mutation-locked@example.com").await;
        seed_vault(&app.pool, vault, "Original", "personal", user, None).await;
        seed_vault_key(
            &app.pool,
            "mutation_locked_key",
            vault,
            user,
            "wrapped-key",
            "owner",
        )
        .await;
        let session = app.issue_session(user).await;
        let mut transaction = app.pool.begin().await.unwrap();
        sqlx::query("SELECT id FROM \"user\" WHERE id=$1 FOR UPDATE")
            .bind(user)
            .execute(&mut *transaction)
            .await
            .unwrap();
        let mut headers = authenticated_json_headers(&session.token);
        headers.insert(
            "idempotency-key",
            "mutation_after_demotion".parse().unwrap(),
        );
        let path = format!("/api/v1/vaults/{vault}/metadata-updates");
        let response = app.api_json(
            Method::POST,
            &path,
            Some(json!({"name":"Must not apply"})),
            headers,
        );
        tokio::pin!(response);
        assert!(
            tokio::time::timeout(std::time::Duration::from_millis(50), &mut response)
                .await
                .is_err()
        );
        sqlx::query("UPDATE vault_key SET role='read-only' WHERE user_id=$1 AND vault_id=$2")
            .bind(user)
            .bind(vault)
            .execute(&mut *transaction)
            .await
            .unwrap();
        transaction.commit().await.unwrap();
        let response = response.await;
        assert_eq!(response.status, StatusCode::OK);
        assert_eq!(
            response.body["result"],
            json!({"status":"rejected","code":"vault_access_denied"})
        );
        assert_eq!(
            query_scalar::<_, String>("SELECT name FROM vault WHERE id=$1")
                .bind(vault)
                .fetch_one(&app.pool)
                .await
                .unwrap(),
            "Original"
        );
    })
    .await;
}

#[tokio::test]
async fn vault_deletion_preserves_prior_item_outcome_and_later_item_work_reaches_denial() {
    with_api_test_app("vault_delete_retained_item", |app| async move {
        let user = "mutation_item_user";
        let vault = "mutation_item_vault";
        let item = "mutation_item";
        seed_user(&app.pool, user, "Owner", "mutation-item@example.com").await;
        seed_vault(&app.pool, vault, "Delete with Item", "personal", user, None).await;
        seed_vault_key(
            &app.pool,
            "mutation_item_key",
            vault,
            user,
            "wrapped-key",
            "owner",
        )
        .await;
        crate::test_support::seed_item(&app.pool, item, vault, "login", "ciphertext", "iv", user)
            .await;
        let session = app.issue_session(user).await;
        let mut headers = authenticated_json_headers(&session.token);
        headers.insert(
            "idempotency-key",
            "mutation_item_before_delete".parse().unwrap(),
        );
        headers.insert("if-match", "\"1\"".parse().unwrap());
        let item_path = format!("/api/v1/items/{item}/favorite");
        let before = app
            .api_json(
                Method::PATCH,
                &item_path,
                Some(json!({"favorite":true})),
                headers.clone(),
            )
            .await;
        assert_eq!(before.status, StatusCode::OK, "{}", before.body);
        assert_eq!(before.body["result"]["status"], "applied");
        let mut delete_headers = authenticated_json_headers(&session.token);
        delete_headers.insert(
            "idempotency-key",
            "mutation_delete_with_item".parse().unwrap(),
        );
        let deletion = app
            .api_json(
                Method::POST,
                &format!("/api/v1/vaults/{vault}/deletions"),
                Some(json!({})),
                delete_headers,
            )
            .await;
        assert_eq!(deletion.status, StatusCode::OK, "{}", deletion.body);
        let replay = app
            .api_json(
                Method::PATCH,
                &item_path,
                Some(json!({"favorite":true})),
                headers.clone(),
            )
            .await;
        assert_eq!(replay.body, before.body);
        let lookup = app
            .api_json(
                Method::GET,
                "/api/v1/operations/mutation_item_before_delete",
                None,
                authenticated_json_headers(&session.token),
            )
            .await;
        assert_eq!(lookup.body, before.body);
        headers.insert(
            "idempotency-key",
            "mutation_item_after_delete".parse().unwrap(),
        );
        let after = app
            .api_json(
                Method::PATCH,
                &item_path,
                Some(json!({"favorite":false})),
                headers,
            )
            .await;
        assert_eq!(after.status, StatusCode::OK);
        assert_eq!(after.body["result"]["status"], "rejected");
        assert_eq!(after.body["result"]["code"], "item_not_found");
    })
    .await;
}

#[tokio::test]
async fn superseded_image_cleanup_survives_the_original_storage_failure() {
    use crate::test_support::{with_api_test_app_state, RecordingObjectStorage};
    use std::sync::Arc;
    let storage = Arc::new(RecordingObjectStorage::failing_delete());
    let observed = storage.clone();
    with_api_test_app_state(
        "vault_image_cleanup_retry",
        move |state| state.with_object_storage(storage),
        |app| async move {
            let user = "cleanup_retry_user";
            let vault = "cleanup_retry_vault";
            seed_user(&app.pool, user, "Owner", "cleanup-retry@example.com").await;
            seed_vault(&app.pool, vault, "Image cleanup", "personal", user, None).await;
            seed_vault_key(
                &app.pool,
                "cleanup_retry_key",
                vault,
                user,
                "wrapped-key",
                "owner",
            )
            .await;
            sqlx::query("UPDATE vault SET image_key='cleanup-retry-image' WHERE id=$1")
                .bind(vault)
                .execute(&app.pool)
                .await
                .unwrap();
            let session = app.issue_session(user).await;
            let mut headers = authenticated_json_headers(&session.token);
            headers.insert(
                "idempotency-key",
                "cleanup_retry_operation".parse().unwrap(),
            );
            let result = app
                .api_json(
                    Method::POST,
                    &format!("/api/v1/vaults/{vault}/metadata-updates"),
                    Some(json!({"imageKey":null})),
                    headers,
                )
                .await;
            assert_eq!(result.status, StatusCode::OK);
            assert!(observed
                .calls()
                .contains(&"delete:cleanup-retry-image".to_owned()));
            let retry = RecordingObjectStorage::succeeding(None);
            crate::jobs::sql::cleanup_vault_image_staging(&app.pool, &retry)
                .await
                .unwrap();
            assert!(
                retry
                    .calls()
                    .contains(&"delete:cleanup-retry-image".to_owned()),
                "committed cleanup duty must survive the failed first deletion"
            );
            let calls = retry.calls();
            crate::jobs::sql::cleanup_vault_image_staging(&app.pool, &retry)
                .await
                .unwrap();
            assert_eq!(retry.calls(), calls);
        },
    )
    .await;
}
