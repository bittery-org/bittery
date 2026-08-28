use super::{
    assert_item_write_access, attachment_quota_lock_key, base64_encoded_length,
    encrypted_attachment_storage_size, pending_attachment_upload_expiry,
};
use crate::db::enums::VaultRole;
use crate::error::AppErrorCode;
use crate::jobs::sql::cleanup_attachment_move_staging;
use crate::test_support::{
    assign_user_to_team, authenticated_json_headers, install_attachment_move_preflight_hook,
    seed_item, seed_team, seed_user, seed_vault, seed_vault_key, with_api_test_app,
    with_api_test_app_state, with_test_config, RecordingObjectStorage,
};
use axum::http::{
    header::{CONTENT_TYPE, ETAG, IF_MATCH},
    HeaderMap, HeaderValue, Method, StatusCode,
};
use serde_json::{json, Value};
use sqlx::{query, query_as, query_scalar, PgPool};
use time::{Duration, OffsetDateTime};

use std::sync::Arc;

fn with_if_match(mut headers: HeaderMap, version: impl std::fmt::Display) -> HeaderMap {
    headers.insert(
        IF_MATCH,
        HeaderValue::from_str(&format!("\"{version}\""))
            .expect("fixture version should produce a valid ETag"),
    );
    headers
}

fn unauthenticated_json_headers() -> HeaderMap {
    let mut headers = HeaderMap::new();
    headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
    headers.insert(
        "bittery-client-platform",
        HeaderValue::from_static("desktop"),
    );
    headers.insert(
        "bittery-client-id",
        HeaderValue::from_static("integration-test"),
    );
    headers
}

fn idempotent_item_headers(token: &str, version: i32, key: &str) -> HeaderMap {
    let mut headers = authenticated_json_headers(token);
    headers.insert(
        IF_MATCH,
        HeaderValue::from_str(&format!("\"{version}\"")).expect("version ETag should be valid"),
    );
    headers.insert(
        "idempotency-key",
        HeaderValue::from_str(key).expect("idempotency key should be valid"),
    );
    headers
}

fn idempotency_headers(token: &str, key: &str) -> HeaderMap {
    let mut headers = authenticated_json_headers(token);
    headers.insert(
        "idempotency-key",
        HeaderValue::from_str(key).expect("idempotency key should be valid"),
    );
    headers
}

/// Asserts one applied Operation outcome: the kind the caller asked for, the Item it names, and
/// the version the effect reached.
fn assert_applied(body: &Value, kind: &str, item_id: &str, version: i32) {
    assert_eq!(body["kind"], json!(kind), "unexpected outcome kind: {body}");
    assert_eq!(
        body["result"],
        json!({ "status": "applied", "itemId": item_id, "version": version }),
        "unexpected applied outcome: {body}"
    );
}

/// Asserts one retained semantic rejection.
fn assert_rejected(body: &Value, kind: &str, code: &str) {
    assert_eq!(body["kind"], json!(kind), "unexpected outcome kind: {body}");
    assert_eq!(
        body["result"],
        json!({ "status": "rejected", "code": code }),
        "unexpected rejected outcome: {body}"
    );
}

fn assert_transport_error(body: &Value, code: &str, message: &str) {
    assert_eq!(body["detail"], json!(message));
    assert_eq!(body["code"], json!(code));
}

fn assert_handler_error(body: &Value, code: &str, message: &str) {
    assert_eq!(body["code"], json!(code));
    assert_eq!(body["detail"], json!(message));
}

fn assert_invalid_params_error(body: &Value) {
    assert!(
        body["code"].is_string(),
        "unexpected invalid params body: {body}"
    );
    let message = body["detail"]
        .as_str()
        .unwrap_or_default()
        .to_ascii_lowercase();
    assert!(
        (matches!(
            body["code"].as_str(),
            Some("INVALID_REQUEST" | "INVALID_JSON")
        ) || message.contains("invalid")),
        "unexpected invalid params body: {body}"
    );
}

fn find_entry_by_id<'a>(values: &'a [Value], id: &str) -> &'a Value {
    values
        .iter()
        .find(|value| value["id"] == json!(id))
        .unwrap_or_else(|| panic!("entry {id} not found in {values:?}"))
}

struct VaultRouterFixture {
    owner_user_id: String,
    admin_user_id: String,
    member_user_id: String,
    readonly_user_id: String,
    addable_user_id: String,
    outsider_user_id: String,
    solo_user_id: String,
    paid_team_id: String,
    other_team_id: String,
    main_vault_id: String,
    target_vault_id: String,
    owner_personal_vault_id: String,
    active_item_id: String,
    deleted_item_id: String,
    movable_item_id: String,
    personal_item_id: String,
    attachment_id: String,
}

async fn build_vault_router_fixture(pool: &PgPool) -> VaultRouterFixture {
    let fixture = VaultRouterFixture {
        owner_user_id: "vault_owner_user".to_string(),
        admin_user_id: "vault_admin_user".to_string(),
        member_user_id: "vault_member_user".to_string(),
        readonly_user_id: "vault_readonly_user".to_string(),
        addable_user_id: "vault_addable_user".to_string(),
        outsider_user_id: "vault_outsider_user".to_string(),
        solo_user_id: "vault_solo_user".to_string(),
        paid_team_id: "vault_paid_team".to_string(),
        other_team_id: "vault_other_team".to_string(),
        main_vault_id: "vault_main_team_vault".to_string(),
        target_vault_id: "vault_target_team_vault".to_string(),
        owner_personal_vault_id: "vault_owner_personal_vault".to_string(),
        active_item_id: "vault_active_item".to_string(),
        deleted_item_id: "vault_deleted_item".to_string(),
        movable_item_id: "vault_movable_item".to_string(),
        personal_item_id: "vault_personal_item".to_string(),
        attachment_id: "vault_main_attachment".to_string(),
    };

    seed_user(
        pool,
        &fixture.owner_user_id,
        "Vault Owner",
        "vault-owner@example.com",
    )
    .await;
    seed_user(
        pool,
        &fixture.admin_user_id,
        "Vault Admin",
        "vault-admin@example.com",
    )
    .await;
    seed_user(
        pool,
        &fixture.member_user_id,
        "Vault Member",
        "vault-member@example.com",
    )
    .await;
    seed_user(
        pool,
        &fixture.readonly_user_id,
        "Vault Read Only",
        "vault-readonly@example.com",
    )
    .await;
    seed_user(
        pool,
        &fixture.addable_user_id,
        "Vault Addable",
        "vault-addable@example.com",
    )
    .await;
    seed_user(
        pool,
        &fixture.outsider_user_id,
        "Vault Outsider",
        "vault-outsider@example.com",
    )
    .await;
    seed_user(
        pool,
        &fixture.solo_user_id,
        "Vault Solo",
        "vault-solo@example.com",
    )
    .await;

    seed_team(
        pool,
        &fixture.paid_team_id,
        "Vault Paid Team",
        &fixture.owner_user_id,
        "family",
        "family",
        "active",
    )
    .await;
    seed_team(
        pool,
        &fixture.other_team_id,
        "Vault Other Team",
        &fixture.outsider_user_id,
        "family",
        "family",
        "active",
    )
    .await;

    assign_user_to_team(pool, &fixture.owner_user_id, &fixture.paid_team_id, "owner").await;
    assign_user_to_team(pool, &fixture.admin_user_id, &fixture.paid_team_id, "admin").await;
    assign_user_to_team(
        pool,
        &fixture.member_user_id,
        &fixture.paid_team_id,
        "member",
    )
    .await;
    assign_user_to_team(
        pool,
        &fixture.readonly_user_id,
        &fixture.paid_team_id,
        "member",
    )
    .await;
    assign_user_to_team(
        pool,
        &fixture.addable_user_id,
        &fixture.paid_team_id,
        "member",
    )
    .await;
    assign_user_to_team(
        pool,
        &fixture.outsider_user_id,
        &fixture.other_team_id,
        "owner",
    )
    .await;

    seed_vault(
        pool,
        &fixture.main_vault_id,
        "Main Team Vault",
        "team",
        &fixture.owner_user_id,
        Some(&fixture.paid_team_id),
    )
    .await;
    seed_vault(
        pool,
        &fixture.target_vault_id,
        "Target Team Vault",
        "team",
        &fixture.owner_user_id,
        Some(&fixture.paid_team_id),
    )
    .await;
    seed_vault(
        pool,
        &fixture.owner_personal_vault_id,
        "Owner Personal Vault",
        "personal",
        &fixture.owner_user_id,
        None,
    )
    .await;

    seed_vault_key(
        pool,
        "vault_key_main_owner",
        &fixture.main_vault_id,
        &fixture.owner_user_id,
        "main-owner-key",
        "owner",
    )
    .await;
    seed_vault_key(
        pool,
        "vault_key_main_admin",
        &fixture.main_vault_id,
        &fixture.admin_user_id,
        "main-admin-key",
        "admin",
    )
    .await;
    seed_vault_key(
        pool,
        "vault_key_main_member",
        &fixture.main_vault_id,
        &fixture.member_user_id,
        "main-member-key",
        "member",
    )
    .await;
    seed_vault_key(
        pool,
        "vault_key_main_readonly",
        &fixture.main_vault_id,
        &fixture.readonly_user_id,
        "main-readonly-key",
        "read-only",
    )
    .await;
    seed_vault_key(
        pool,
        "vault_key_target_owner",
        &fixture.target_vault_id,
        &fixture.owner_user_id,
        "target-owner-key",
        "owner",
    )
    .await;
    seed_vault_key(
        pool,
        "vault_key_personal_owner",
        &fixture.owner_personal_vault_id,
        &fixture.owner_user_id,
        "personal-owner-key",
        "owner",
    )
    .await;

    seed_item(
        pool,
        &fixture.active_item_id,
        &fixture.main_vault_id,
        "login",
        "active-encrypted-data",
        "active-iv",
        &fixture.owner_user_id,
    )
    .await;
    seed_item(
        pool,
        &fixture.deleted_item_id,
        &fixture.main_vault_id,
        "login",
        "deleted-encrypted-data",
        "deleted-iv",
        &fixture.owner_user_id,
    )
    .await;
    seed_item(
        pool,
        &fixture.movable_item_id,
        &fixture.main_vault_id,
        "login",
        "movable-encrypted-data",
        "movable-iv",
        &fixture.owner_user_id,
    )
    .await;
    seed_item(
        pool,
        &fixture.personal_item_id,
        &fixture.owner_personal_vault_id,
        "login",
        "personal-encrypted-data",
        "personal-iv",
        &fixture.owner_user_id,
    )
    .await;
    mark_item_deleted(pool, &fixture.deleted_item_id).await;
    seed_attachment(
        pool,
        &fixture.attachment_id,
        &fixture.active_item_id,
        &fixture.main_vault_id,
        &fixture.owner_user_id,
    )
    .await;

    fixture
}

async fn install_required_audit_failure_trigger(pool: &PgPool, action: &str) {
    query(
        r#"CREATE FUNCTION reject_required_audit_insert() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
            RAISE EXCEPTION 'required audit insert rejected by test';
        END;
        $$"#,
    )
    .execute(pool)
    .await
    .expect("audit failure function should install");
    query(&format!(
        "CREATE TRIGGER reject_required_audit_insert BEFORE INSERT ON audit_log FOR EACH ROW WHEN (NEW.action = '{action}') EXECUTE FUNCTION reject_required_audit_insert()"
    ))
    .execute(pool)
    .await
    .expect("audit failure trigger should install");
}

async fn install_operation_step_failure_trigger(pool: &PgPool, table: &str, when_clause: &str) {
    query(
        r#"CREATE FUNCTION reject_operation_step_insert() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
            RAISE EXCEPTION 'Operation step rejected by test';
        END;
        $$"#,
    )
    .execute(pool)
    .await
    .expect("Operation failure function should install");
    query(&format!(
        "CREATE TRIGGER reject_operation_step_insert BEFORE INSERT ON {table} FOR EACH ROW {when_clause} EXECUTE FUNCTION reject_operation_step_insert()"
    ))
    .execute(pool)
    .await
    .expect("Operation failure trigger should install");
}

async fn install_attachment_move_failure_trigger(
    pool: &PgPool,
    table: &str,
    event: &str,
    when_clause: &str,
) {
    query(
        r#"CREATE FUNCTION reject_attachment_move_step() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
            RAISE EXCEPTION 'Attachment Move step rejected by test';
        END;
        $$"#,
    )
    .execute(pool)
    .await
    .expect("Attachment Move failure function should install");
    query(&format!(
        "CREATE TRIGGER reject_attachment_move_step BEFORE {event} ON {table} FOR EACH ROW {when_clause} EXECUTE FUNCTION reject_attachment_move_step()"
    ))
    .execute(pool)
    .await
    .expect("Attachment Move failure trigger should install");
}

fn attachment_move_manifest_body(fixture: &VaultRouterFixture) -> Value {
    json!({
        "itemId": fixture.movable_item_id,
        "sourceVaultId": fixture.main_vault_id,
        "targetVaultId": fixture.target_vault_id,
        "attachments": [{
            "attachmentId": "move_attachment",
            "envelopeVersion": 1,
            "ciphertextSha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
        }]
    })
}

#[tokio::test]
async fn attachment_move_maintenance_queries_have_supporting_indexes() {
    with_api_test_app("attachment_move_maintenance_indexes", |app| async move {
        let index_names = query_scalar::<_, String>(
            "SELECT indexname FROM pg_indexes WHERE schemaname = 'public' AND indexname = ANY($1) ORDER BY indexname",
        )
        .bind(vec![
            "attachment_move_cleanup_claim_expiry_idx",
            "attachment_move_cleanup_unclaimed_idx",
            "attachment_move_manifest_expiry_idx",
        ])
        .fetch_all(&app.pool)
        .await
        .unwrap();
        assert_eq!(
            index_names,
            vec![
                "attachment_move_cleanup_claim_expiry_idx".to_string(),
                "attachment_move_cleanup_unclaimed_idx".to_string(),
                "attachment_move_manifest_expiry_idx".to_string(),
            ]
        );
        let mut transaction = app.pool.begin().await.unwrap();
        query("SET LOCAL enable_seqscan = off")
            .execute(&mut *transaction)
            .await
            .unwrap();
        let expiry_plan = query_scalar::<_, String>(
            "EXPLAIN (COSTS OFF) SELECT user_id, operation_id FROM attachment_move_manifest WHERE expires_at <= NOW() ORDER BY expires_at, user_id, operation_id LIMIT 100",
        )
        .fetch_all(&mut *transaction)
        .await
        .unwrap()
        .join("\n");
        assert!(
            expiry_plan.contains("attachment_move_manifest_expiry_idx"),
            "{expiry_plan}"
        );
        let cleanup_plan = query_scalar::<_, String>(
            "EXPLAIN (COSTS OFF) SELECT id, user_id, operation_id, storage_key FROM (SELECT id, user_id, operation_id, storage_key FROM attachment_move_cleanup WHERE claim_token IS NULL UNION ALL SELECT id, user_id, operation_id, storage_key FROM attachment_move_cleanup WHERE claim_token IS NOT NULL AND claimed_at <= NOW() - INTERVAL '5 minutes') eligible ORDER BY id LIMIT 100",
        )
        .fetch_all(&mut *transaction)
        .await
        .unwrap()
        .join("\n");
        assert!(
            cleanup_plan.contains("attachment_move_cleanup_unclaimed_idx"),
            "{cleanup_plan}"
        );
        assert!(
            cleanup_plan.contains("attachment_move_cleanup_claim_expiry_idx"),
            "{cleanup_plan}"
        );
    })
    .await;
}

fn attachment_move_final_body(fixture: &VaultRouterFixture) -> Value {
    json!({
        "mode": "prepared",
        "sourceVaultId": fixture.main_vault_id,
        "targetVaultId": fixture.target_vault_id,
        "encryptedData": "target-item-ciphertext",
        "encryptionIv": "target-item-iv",
        "encryptionAlgorithm": "AES-GCM-AAD-V1",
        "attachments": [{
            "attachmentId": "move_attachment",
            "expectedEnvelopeVersion": 1,
            "encryptedAttachmentKey": "target-wrapped-key",
            "attachmentKeyIv": "target-key-iv",
            "attachmentKeyAlgorithm": "AES-GCM-AAD-V1",
            "encryptedName": "target-name",
            "encryptedContentType": "target-content-type",
            "encryptionIv": "target-blob-iv",
            "encryptedContentTypeIv": "target-type-iv",
            "encryptionAlgorithm": "AES-GCM-AAD-V1"
        }]
    })
}

async fn seed_attachment(
    pool: &PgPool,
    attachment_id: &str,
    item_id: &str,
    vault_id: &str,
    uploaded_by: &str,
) {
    query(
			"INSERT INTO item_attachment (id, item_id, vault_id, storage_key, encrypted_attachment_key, attachment_key_iv, attachment_key_algorithm, envelope_version, encrypted_name, encrypted_content_type, encryption_iv, encrypted_content_type_iv, encryption_algorithm, file_size, storage_size, uploaded_by, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)",
		)
		.bind(attachment_id)
		.bind(item_id)
		.bind(vault_id)
		.bind(format!("attachments/{attachment_id}"))
		.bind("encrypted-attachment-key")
		.bind("attachment-key-iv")
		.bind("AES-GCM-AAD-V1")
		.bind(1_i32)
		.bind("encrypted-attachment-name")
		.bind("encrypted-content-type")
		.bind("attachment-iv")
		.bind(Some("attachment-content-type-iv"))
		.bind("AES-GCM-AAD-V1")
		.bind(128_i32)
		.bind(128_i32)
		.bind(uploaded_by)
		.bind(OffsetDateTime::now_utc())
		.execute(pool)
		.await
		.expect("attachment should seed");
}

async fn wait_for_advisory_waiters(pool: &PgPool, expected: i64) {
    for _ in 0..200 {
        let waiters = query_scalar::<_, i64>(
            "SELECT COUNT(*)::bigint FROM pg_stat_activity WHERE datname = current_database() AND wait_event = 'advisory'",
        )
        .fetch_one(pool)
        .await
        .unwrap();
        if waiters >= expected {
            return;
        }
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }
    panic!("expected {expected} advisory-lock waiters");
}

async fn acquire_test_item_attachment_writer_lock(
    pool: &PgPool,
    item_id: &str,
) -> sqlx::Transaction<'static, sqlx::Postgres> {
    let mut transaction = pool.begin().await.unwrap();
    query("SELECT pg_advisory_xact_lock(hashtext($1))")
        .bind(format!(
            "item-attachment-writer:{}:{}",
            item_id.len(),
            item_id
        ))
        .execute(&mut *transaction)
        .await
        .unwrap();
    transaction
}

#[tokio::test]
async fn attachment_move_manifest_fixes_stable_operation_scoped_uploads() {
    let storage = Arc::new(RecordingObjectStorage::succeeding(None));
    let observed_storage = storage.clone();
    with_api_test_app_state(
        "attachment_move_manifest_stable_uploads",
        move |state| state.with_object_storage(storage),
        |app| async move {
            let fixture = build_vault_router_fixture(&app.pool).await;
            seed_attachment(
                &app.pool,
                "move_attachment",
                &fixture.movable_item_id,
                &fixture.main_vault_id,
                &fixture.owner_user_id,
            )
            .await;
            let session = app.issue_session(&fixture.owner_user_id).await;
            let path = "/api/v1/operations/move-with-attachments/attachment-move-manifest";
            let body = json!({
                "itemId": fixture.movable_item_id,
                "sourceVaultId": fixture.main_vault_id,
                "targetVaultId": fixture.target_vault_id,
                "attachments": [{
                    "attachmentId": "move_attachment",
                    "envelopeVersion": 1,
                    "ciphertextSha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
                }]
            });

            let first = app
                .api_json(
                    Method::PUT,
                    path,
                    Some(body.clone()),
                    authenticated_json_headers(&session.token),
                )
                .await;
            first.assert_contract_status();
            assert_eq!(first.status, StatusCode::OK, "{}", first.body);
            assert_eq!(first.body["operationId"], json!("move-with-attachments"));
            assert_eq!(
                first.body["attachments"][0]["attachmentId"],
                json!("move_attachment")
            );
            let stable_key = first.body["attachments"][0]["storageKey"]
                .as_str()
                .expect("manifest should return a storage key")
                .to_string();

            let second = app
                .api_json(
                    Method::PUT,
                    path,
                    Some(body),
                    authenticated_json_headers(&session.token),
                )
                .await;
            second.assert_contract_status();
            assert_eq!(second.status, StatusCode::OK, "{}", second.body);
            assert_eq!(
                second.body["attachments"][0]["storageKey"],
                json!(stable_key)
            );
            assert_eq!(
                observed_storage.calls(),
                vec![
                    format!("presign_upload:{stable_key}"),
                    format!("presign_upload:{stable_key}")
                ]
            );
        },
    )
    .await;
}

#[tokio::test]
async fn attachment_move_manifest_rejects_malformed_ciphertext_sha256() {
    let storage = Arc::new(RecordingObjectStorage::succeeding(None));
    with_api_test_app_state(
        "attachment_move_manifest_bad_ciphertext_digest",
        move |state| state.with_object_storage(storage),
        |app| async move {
            let fixture = build_vault_router_fixture(&app.pool).await;
            seed_attachment(
                &app.pool,
                "move_attachment",
                &fixture.movable_item_id,
                &fixture.main_vault_id,
                &fixture.owner_user_id,
            )
            .await;
            let session = app.issue_session(&fixture.owner_user_id).await;
            for malformed in [
                "abc",
                "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
            ] {
                let response = app
                    .api_json(
                        Method::PUT,
                        "/api/v1/operations/bad-ciphertext-digest/attachment-move-manifest",
                        Some(json!({
                            "itemId": fixture.movable_item_id,
                            "sourceVaultId": fixture.main_vault_id,
                            "targetVaultId": fixture.target_vault_id,
                            "attachments": [{
                                "attachmentId": "move_attachment",
                                "envelopeVersion": 1,
                                "ciphertextSha256": malformed
                            }]
                        })),
                        authenticated_json_headers(&session.token),
                    )
                    .await;
                assert_eq!(
                    response.status,
                    StatusCode::BAD_REQUEST,
                    "{}",
                    response.body
                );
            }
        },
    )
    .await;
}

#[tokio::test]
async fn attachment_move_manifest_does_not_require_plaintext_content_type() {
    let storage = Arc::new(RecordingObjectStorage::succeeding(None));
    with_api_test_app_state(
        "attachment_move_manifest_opaque_upload",
        move |state| state.with_object_storage(storage),
        |app| async move {
            let fixture = build_vault_router_fixture(&app.pool).await;
            seed_attachment(
                &app.pool,
                "move_attachment",
                &fixture.movable_item_id,
                &fixture.main_vault_id,
                &fixture.owner_user_id,
            )
            .await;
            let session = app.issue_session(&fixture.owner_user_id).await;
            let response = app
                .api_json(
                    Method::PUT,
                    "/api/v1/operations/opaque-upload/attachment-move-manifest",
                    Some(json!({
                        "itemId": fixture.movable_item_id,
                        "sourceVaultId": fixture.main_vault_id,
                        "targetVaultId": fixture.target_vault_id,
                        "attachments": [{
                            "attachmentId": "move_attachment",
                            "envelopeVersion": 1,
                            "ciphertextSha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
                        }]
                    })),
                    authenticated_json_headers(&session.token),
                )
                .await;
            response.assert_contract_status();
            assert_eq!(response.status, StatusCode::OK, "{}", response.body);
        },
    )
    .await;
}

#[tokio::test]
async fn attachment_move_manifest_derives_current_encrypted_storage_size() {
    let storage = Arc::new(RecordingObjectStorage::succeeding(None));
    let observed_storage = storage.clone();
    with_api_test_app_state(
        "attachment_move_manifest_derived_size",
        move |state| state.with_object_storage(storage),
        |app| async move {
            let fixture = build_vault_router_fixture(&app.pool).await;
            seed_attachment(
                &app.pool,
                "move_attachment",
                &fixture.movable_item_id,
                &fixture.main_vault_id,
                &fixture.owner_user_id,
            )
            .await;
            let session = app.issue_session(&fixture.owner_user_id).await;
            let response = app
                .api_json(
                    Method::PUT,
                    "/api/v1/operations/derived-size/attachment-move-manifest",
                    Some(json!({
                        "itemId": fixture.movable_item_id,
                        "sourceVaultId": fixture.main_vault_id,
                        "targetVaultId": fixture.target_vault_id,
                        "attachments": [{
                            "attachmentId": "move_attachment",
                            "envelopeVersion": 1,
                            "ciphertextSha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
                        }]
                    })),
                    authenticated_json_headers(&session.token),
                )
                .await;
            response.assert_contract_status();
            assert_eq!(response.status, StatusCode::OK, "{}", response.body);
            assert_eq!(
                query_scalar::<_, i64>("SELECT storage_size::bigint FROM attachment_move_staging WHERE user_id = $1 AND operation_id = 'derived-size'")
                    .bind(&fixture.owner_user_id)
                    .fetch_one(&app.pool)
                    .await
                    .unwrap(),
                128
            );
            assert_eq!(
                observed_storage.upload_requests(),
                vec![(
                    response.body["attachments"][0]["storageKey"]
                        .as_str()
                        .unwrap()
                        .to_string(),
                    "application/octet-stream".to_string(),
                    Some(128),
                    Some("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa".to_string())
                )]
            );
        },
    )
    .await;
}

#[tokio::test]
async fn attachment_move_manifest_serializes_live_ownership_and_allows_expired_takeover() {
    let storage = Arc::new(RecordingObjectStorage::succeeding(None));
    with_api_test_app_state(
        "attachment_move_manifest_ownership",
        move |state| state.with_object_storage(storage),
        |app| async move {
            let fixture = build_vault_router_fixture(&app.pool).await;
            seed_attachment(
                &app.pool,
                "move_attachment",
                &fixture.movable_item_id,
                &fixture.main_vault_id,
                &fixture.owner_user_id,
            )
            .await;
            let session = app.issue_session(&fixture.owner_user_id).await;
            let body = json!({
                "itemId": fixture.movable_item_id,
                "sourceVaultId": fixture.main_vault_id,
                "targetVaultId": fixture.target_vault_id,
                "attachments": [{
                    "attachmentId": "move_attachment",
                    "envelopeVersion": 1,
                    "ciphertextSha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
                }]
            });
            let first = app
                .api_json(
                    Method::PUT,
                    "/api/v1/operations/first-owner/attachment-move-manifest",
                    Some(body.clone()),
                    authenticated_json_headers(&session.token),
                )
                .await;
            assert_eq!(first.status, StatusCode::OK, "{}", first.body);
            let first_key = first.body["attachments"][0]["storageKey"]
                .as_str()
                .unwrap()
                .to_string();

            let busy = app
                .api_json(
                    Method::PUT,
                    "/api/v1/operations/second-owner/attachment-move-manifest",
                    Some(body.clone()),
                    authenticated_json_headers(&session.token),
                )
                .await;
            busy.assert_contract_status();
            assert_eq!(busy.status, StatusCode::CONFLICT, "{}", busy.body);
            assert_eq!(busy.body["code"], json!("ATTACHMENT_STAGING_BUSY"));
            assert_eq!(
                query_scalar::<_, i64>("SELECT COUNT(*)::bigint FROM attachment_move_manifest WHERE user_id = $1")
                    .bind(&fixture.owner_user_id)
                    .fetch_one(&app.pool)
                    .await
                    .unwrap(),
                1
            );
            assert_eq!(
                retained_outcome_count(&app.pool, &fixture.owner_user_id, "second-owner").await,
                0
            );

            query("UPDATE attachment_move_manifest SET expires_at = NOW() - INTERVAL '1 second' WHERE user_id = $1 AND operation_id = 'first-owner'")
                .bind(&fixture.owner_user_id)
                .execute(&app.pool)
                .await
                .unwrap();
            let takeover = app
                .api_json(
                    Method::PUT,
                    "/api/v1/operations/second-owner/attachment-move-manifest",
                    Some(body),
                    authenticated_json_headers(&session.token),
                )
                .await;
            assert_eq!(takeover.status, StatusCode::OK, "{}", takeover.body);
            assert_eq!(
                query_scalar::<_, i64>("SELECT COUNT(*)::bigint FROM attachment_move_cleanup WHERE user_id = $1 AND operation_id = 'first-owner' AND storage_key = $2")
                    .bind(&fixture.owner_user_id)
                    .bind(first_key)
                    .fetch_one(&app.pool)
                    .await
                    .unwrap(),
                1
            );
            assert_eq!(
                query_scalar::<_, String>("SELECT operation_id FROM attachment_move_manifest WHERE user_id = $1")
                    .bind(&fixture.owner_user_id)
                    .fetch_one(&app.pool)
                    .await
                    .unwrap(),
                "second-owner"
            );
        },
    )
    .await;
}

#[tokio::test]
async fn attachment_move_resume_after_expired_cleanup_advances_physical_generation() {
    let storage = Arc::new(RecordingObjectStorage::succeeding(None));
    with_api_test_app_state(
        "attachment_move_generation_resume",
        move |state| state.with_object_storage(storage),
        |app| async move {
            let fixture = build_vault_router_fixture(&app.pool).await;
            seed_attachment(
                &app.pool,
                "move_attachment",
                &fixture.movable_item_id,
                &fixture.main_vault_id,
                &fixture.owner_user_id,
            )
            .await;
            let session = app.issue_session(&fixture.owner_user_id).await;
            let path = "/api/v1/operations/generation-resume/attachment-move-manifest";
            let first = app
                .api_json(
                    Method::PUT,
                    path,
                    Some(attachment_move_manifest_body(&fixture)),
                    authenticated_json_headers(&session.token),
                )
                .await;
            assert_eq!(first.status, StatusCode::OK, "{}", first.body);
            let first_key = first.body["attachments"][0]["storageKey"]
                .as_str()
                .unwrap()
                .to_string();
            query("UPDATE attachment_move_manifest SET expires_at = NOW() - INTERVAL '1 second' WHERE user_id = $1 AND operation_id = 'generation-resume'")
                .bind(&fixture.owner_user_id)
                .execute(&app.pool)
                .await
                .unwrap();
            assert_eq!(
                cleanup_attachment_move_staging(
                    &app.pool,
                    &RecordingObjectStorage::failing()
                )
                .await
                .unwrap(),
                0
            );
            assert_eq!(
                query_scalar::<_, i64>("SELECT generation FROM attachment_move_staging_generation WHERE user_id = $1 AND operation_id = 'generation-resume'")
                    .bind(&fixture.owner_user_id)
                    .fetch_one(&app.pool)
                    .await
                    .unwrap(),
                1
            );

            let resumed = app
                .api_json(
                    Method::PUT,
                    path,
                    Some(attachment_move_manifest_body(&fixture)),
                    authenticated_json_headers(&session.token),
                )
                .await;
            assert_eq!(resumed.status, StatusCode::OK, "{}", resumed.body);
            let resumed_key = resumed.body["attachments"][0]["storageKey"]
                .as_str()
                .unwrap();
            assert_ne!(resumed_key, first_key);
            assert_eq!(
                query_scalar::<_, i64>("SELECT COUNT(*)::bigint FROM attachment_move_cleanup WHERE storage_key = $1")
                    .bind(first_key)
                    .fetch_one(&app.pool)
                    .await
                    .unwrap(),
                1
            );
        },
    )
    .await;
}

#[tokio::test]
async fn delayed_old_generation_delete_cannot_remove_resumed_attachment_move_upload() {
    let delete_started = Arc::new(tokio::sync::Notify::new());
    let delete_release = Arc::new(tokio::sync::Notify::new());
    let storage = Arc::new(RecordingObjectStorage::succeeding_with_delayed_delete(
        128,
        delete_started.clone(),
        delete_release.clone(),
    ));
    let cleanup_storage = storage.clone();
    with_api_test_app_state(
        "attachment_move_delayed_old_delete",
        move |state| state.with_object_storage(storage),
        |app| async move {
            let fixture = build_vault_router_fixture(&app.pool).await;
            seed_attachment(
                &app.pool,
                "move_attachment",
                &fixture.movable_item_id,
                &fixture.main_vault_id,
                &fixture.owner_user_id,
            )
            .await;
            let session = app.issue_session(&fixture.owner_user_id).await;
            let operation_id = "delayed-generation-delete";
            let path = format!(
                "/api/v1/operations/{operation_id}/attachment-move-manifest"
            );
            let first = app
                .api_json(
                    Method::PUT,
                    &path,
                    Some(attachment_move_manifest_body(&fixture)),
                    authenticated_json_headers(&session.token),
                )
                .await;
            assert_eq!(first.status, StatusCode::OK, "{}", first.body);
            let first_key = first.body["attachments"][0]["storageKey"]
                .as_str()
                .unwrap()
                .to_string();
            query("UPDATE attachment_move_manifest SET expires_at = NOW() - INTERVAL '1 second' WHERE user_id = $1 AND operation_id = $2")
                .bind(&fixture.owner_user_id)
                .bind(operation_id)
                .execute(&app.pool)
                .await
                .unwrap();

            let cleanup_pool = app.pool.clone();
            let cleanup = tokio::spawn(async move {
                cleanup_attachment_move_staging(&cleanup_pool, cleanup_storage.as_ref()).await
            });
            delete_started.notified().await;

            let resumed = app
                .api_json(
                    Method::PUT,
                    &path,
                    Some(attachment_move_manifest_body(&fixture)),
                    authenticated_json_headers(&session.token),
                )
                .await;
            assert_eq!(resumed.status, StatusCode::OK, "{}", resumed.body);
            let resumed_key = resumed.body["attachments"][0]["storageKey"]
                .as_str()
                .unwrap()
                .to_string();
            assert_ne!(resumed_key, first_key);

            delete_release.notify_one();
            assert_eq!(cleanup.await.unwrap().unwrap(), 1);
            assert_eq!(
                query_scalar::<_, String>("SELECT storage_key FROM attachment_move_staging WHERE user_id = $1 AND operation_id = $2")
                    .bind(&fixture.owner_user_id)
                    .bind(operation_id)
                    .fetch_one(&app.pool)
                    .await
                    .unwrap(),
                resumed_key
            );
            assert_eq!(
                query_scalar::<_, i64>("SELECT generation FROM attachment_move_staging_generation WHERE user_id = $1 AND operation_id = $2")
                    .bind(&fixture.owner_user_id)
                    .bind(operation_id)
                    .fetch_one(&app.pool)
                    .await
                    .unwrap(),
                2
            );

            let finalized = app
                .api_json(
                    Method::POST,
                    &format!("/api/v1/items/{}/moves", fixture.movable_item_id),
                    Some(attachment_move_final_body(&fixture)),
                    idempotent_item_headers(&session.token, 1, operation_id),
                )
                .await;
            assert_eq!(finalized.status, StatusCode::OK, "{}", finalized.body);
            assert_applied(&finalized.body, "move_item", &fixture.movable_item_id, 2);
            assert_eq!(
                query_scalar::<_, i64>("SELECT COUNT(*)::bigint FROM attachment_move_staging_generation WHERE user_id = $1 AND operation_id = $2")
                    .bind(&fixture.owner_user_id)
                    .bind(operation_id)
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
async fn attachment_move_generation_advance_failure_preserves_old_cleanup_and_generation() {
    let storage = Arc::new(RecordingObjectStorage::succeeding(None));
    with_api_test_app_state(
        "attachment_move_generation_advance_boundary",
        move |state| state.with_object_storage(storage),
        |app| async move {
            let fixture = build_vault_router_fixture(&app.pool).await;
            seed_attachment(
                &app.pool,
                "move_attachment",
                &fixture.movable_item_id,
                &fixture.main_vault_id,
                &fixture.owner_user_id,
            )
            .await;
            let session = app.issue_session(&fixture.owner_user_id).await;
            let path = "/api/v1/operations/generation-boundary/attachment-move-manifest";
            let first = app
                .api_json(
                    Method::PUT,
                    path,
                    Some(attachment_move_manifest_body(&fixture)),
                    authenticated_json_headers(&session.token),
                )
                .await;
            assert_eq!(first.status, StatusCode::OK, "{}", first.body);
            query("UPDATE attachment_move_manifest SET expires_at = NOW() - INTERVAL '1 second' WHERE user_id = $1 AND operation_id = 'generation-boundary'")
                .bind(&fixture.owner_user_id)
                .execute(&app.pool)
                .await
                .unwrap();
            cleanup_attachment_move_staging(&app.pool, &RecordingObjectStorage::failing())
                .await
                .unwrap();
            install_attachment_move_failure_trigger(
                &app.pool,
                "attachment_move_staging_generation",
                "UPDATE",
                "",
            )
            .await;

            let resumed = app
                .api_json(
                    Method::PUT,
                    path,
                    Some(attachment_move_manifest_body(&fixture)),
                    authenticated_json_headers(&session.token),
                )
                .await;
            assert_eq!(resumed.status, StatusCode::INTERNAL_SERVER_ERROR);
            assert_eq!(
                query_scalar::<_, i64>("SELECT generation FROM attachment_move_staging_generation WHERE user_id = $1 AND operation_id = 'generation-boundary'")
                    .bind(&fixture.owner_user_id)
                    .fetch_one(&app.pool)
                    .await
                    .unwrap(),
                1
            );
            assert_eq!(
                query_scalar::<_, i64>("SELECT COUNT(*)::bigint FROM attachment_move_manifest WHERE operation_id = 'generation-boundary'")
                    .fetch_one(&app.pool)
                    .await
                    .unwrap(),
                0
            );
            assert_eq!(
                query_scalar::<_, i64>("SELECT COUNT(*)::bigint FROM attachment_move_cleanup WHERE operation_id = 'generation-boundary'")
                    .fetch_one(&app.pool)
                    .await
                    .unwrap(),
                1
            );
        },
    )
    .await;
}

#[tokio::test]
async fn attachment_move_manifest_does_not_reuse_staging_during_active_cleanup_claim() {
    let storage = Arc::new(RecordingObjectStorage::succeeding(None));
    with_api_test_app_state(
        "attachment_move_active_cleanup_claim",
        move |state| state.with_object_storage(storage),
        |app| async move {
            let fixture = build_vault_router_fixture(&app.pool).await;
            seed_attachment(
                &app.pool,
                "move_attachment",
                &fixture.movable_item_id,
                &fixture.main_vault_id,
                &fixture.owner_user_id,
            )
            .await;
            let session = app.issue_session(&fixture.owner_user_id).await;
            let path = "/api/v1/operations/claimed-cleanup/attachment-move-manifest";
            let first = app
                .api_json(
                    Method::PUT,
                    path,
                    Some(attachment_move_manifest_body(&fixture)),
                    authenticated_json_headers(&session.token),
                )
                .await;
            assert_eq!(first.status, StatusCode::OK, "{}", first.body);
            let storage_key = first.body["attachments"][0]["storageKey"]
                .as_str()
                .unwrap();
            query("INSERT INTO attachment_move_cleanup (user_id, operation_id, storage_key, claim_token, claimed_at) VALUES ($1, 'claimed-cleanup', $2, 'active-claim', NOW())")
                .bind(&fixture.owner_user_id)
                .bind(storage_key)
                .execute(&app.pool)
                .await
                .unwrap();

            let response = app
                .api_json(
                    Method::PUT,
                    path,
                    Some(attachment_move_manifest_body(&fixture)),
                    authenticated_json_headers(&session.token),
                )
                .await;
            response.assert_contract_status();
            assert_eq!(response.status, StatusCode::CONFLICT, "{}", response.body);
            assert_eq!(response.body["code"], json!("ATTACHMENT_STAGING_BUSY"));
        },
    )
    .await;
}

#[tokio::test]
async fn deleting_user_durably_queues_attachment_move_staging_cleanup() {
    let storage = Arc::new(RecordingObjectStorage::succeeding(None));
    with_api_test_app_state(
        "attachment_move_user_delete_cleanup",
        move |state| state.with_object_storage(storage),
        |app| async move {
            let fixture = build_vault_router_fixture(&app.pool).await;
            seed_attachment(
                &app.pool,
                "move_attachment",
                &fixture.movable_item_id,
                &fixture.main_vault_id,
                &fixture.owner_user_id,
            )
            .await;
            seed_vault_key(
                &app.pool,
                "vault_key_target_deleted_admin",
                &fixture.target_vault_id,
                &fixture.admin_user_id,
                "target-admin-key",
                "admin",
            )
            .await;
            let session = app.issue_session(&fixture.admin_user_id).await;
            let response = app
                .api_json(
                    Method::PUT,
                    "/api/v1/operations/user-delete-cleanup/attachment-move-manifest",
                    Some(attachment_move_manifest_body(&fixture)),
                    authenticated_json_headers(&session.token),
                )
                .await;
            assert_eq!(response.status, StatusCode::OK, "{}", response.body);
            let storage_key = response.body["attachments"][0]["storageKey"]
                .as_str()
                .unwrap()
                .to_string();

            query("DELETE FROM \"user\" WHERE id = $1")
                .bind(&fixture.admin_user_id)
                .execute(&app.pool)
                .await
                .unwrap();
            assert_eq!(
                query_scalar::<_, i64>("SELECT COUNT(*)::bigint FROM attachment_move_manifest WHERE operation_id = 'user-delete-cleanup'")
                    .fetch_one(&app.pool)
                    .await
                    .unwrap(),
                0
            );
            assert_eq!(
                query_scalar::<_, i64>("SELECT COUNT(*)::bigint FROM attachment_move_staging_generation WHERE operation_id = 'user-delete-cleanup'")
                    .fetch_one(&app.pool)
                    .await
                    .unwrap(),
                0
            );
            assert_eq!(
                query_scalar::<_, i64>("SELECT COUNT(*)::bigint FROM attachment_move_cleanup WHERE user_id = $1 AND operation_id = 'user-delete-cleanup' AND storage_key = $2")
                    .bind(&fixture.admin_user_id)
                    .bind(storage_key)
                    .fetch_one(&app.pool)
                    .await
                    .unwrap(),
                1
            );
        },
    )
    .await;
}

#[tokio::test]
async fn attachment_move_manifest_ownership_is_global_across_authorized_users() {
    let storage = Arc::new(RecordingObjectStorage::succeeding(None));
    with_api_test_app_state(
        "attachment_move_manifest_cross_user_ownership",
        move |state| state.with_object_storage(storage),
        |app| async move {
            let fixture = build_vault_router_fixture(&app.pool).await;
            seed_vault_key(
                &app.pool,
                "vault_key_target_admin",
                &fixture.target_vault_id,
                &fixture.admin_user_id,
                "target-admin-key",
                "admin",
            )
            .await;
            seed_attachment(
                &app.pool,
                "move_attachment",
                &fixture.movable_item_id,
                &fixture.main_vault_id,
                &fixture.owner_user_id,
            )
            .await;
            let owner = app.issue_session(&fixture.owner_user_id).await;
            let admin = app.issue_session(&fixture.admin_user_id).await;
            let body = json!({
                "itemId": fixture.movable_item_id,
                "sourceVaultId": fixture.main_vault_id,
                "targetVaultId": fixture.target_vault_id,
                "attachments": [{
                    "attachmentId": "move_attachment",
                    "envelopeVersion": 1,
                    "ciphertextSha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
                }]
            });
            let first = app
                .api_json(
                    Method::PUT,
                    "/api/v1/operations/owner-preparation/attachment-move-manifest",
                    Some(body.clone()),
                    authenticated_json_headers(&owner.token),
                )
                .await;
            assert_eq!(first.status, StatusCode::OK, "{}", first.body);
            let first_key = first.body["attachments"][0]["storageKey"]
                .as_str()
                .unwrap()
                .to_string();

            let busy = app
                .api_json(
                    Method::PUT,
                    "/api/v1/operations/admin-preparation/attachment-move-manifest",
                    Some(body.clone()),
                    authenticated_json_headers(&admin.token),
                )
                .await;
            busy.assert_contract_status();
            assert_eq!(busy.status, StatusCode::CONFLICT, "{}", busy.body);
            assert_eq!(busy.body["code"], json!("ATTACHMENT_STAGING_BUSY"));
            assert_eq!(
                retained_outcome_count(&app.pool, &fixture.admin_user_id, "admin-preparation").await,
                0
            );

            query("UPDATE attachment_move_manifest SET expires_at = NOW() - INTERVAL '1 second' WHERE user_id = $1 AND operation_id = 'owner-preparation'")
                .bind(&fixture.owner_user_id)
                .execute(&app.pool)
                .await
                .unwrap();
            let takeover = app
                .api_json(
                    Method::PUT,
                    "/api/v1/operations/admin-preparation/attachment-move-manifest",
                    Some(body),
                    authenticated_json_headers(&admin.token),
                )
                .await;
            assert_eq!(takeover.status, StatusCode::OK, "{}", takeover.body);
            assert_eq!(
                query_scalar::<_, i64>("SELECT COUNT(*)::bigint FROM attachment_move_cleanup WHERE user_id = $1 AND operation_id = 'owner-preparation' AND storage_key = $2")
                    .bind(&fixture.owner_user_id)
                    .bind(first_key)
                    .fetch_one(&app.pool)
                    .await
                    .unwrap(),
                1
            );
            assert_eq!(
                query_scalar::<_, String>("SELECT user_id FROM attachment_move_manifest WHERE operation_id = 'admin-preparation'")
                    .fetch_one(&app.pool)
                    .await
                    .unwrap(),
                fixture.admin_user_id
            );
        },
    )
    .await;
}

#[tokio::test]
async fn attachment_move_manifest_reports_pre_staging_stale_authority_without_outcome() {
    let storage = Arc::new(RecordingObjectStorage::succeeding(None));
    with_api_test_app_state(
        "attachment_move_manifest_stale_authority",
        move |state| state.with_object_storage(storage),
        |app| async move {
            let fixture = build_vault_router_fixture(&app.pool).await;
            seed_attachment(
                &app.pool,
                "move_attachment",
                &fixture.movable_item_id,
                &fixture.main_vault_id,
                &fixture.owner_user_id,
            )
            .await;
            query("UPDATE item_attachment SET envelope_version = 2 WHERE id = 'move_attachment'")
                .execute(&app.pool)
                .await
                .unwrap();
            let session = app.issue_session(&fixture.owner_user_id).await;
            let response = app
                .api_json(
                    Method::PUT,
                    "/api/v1/operations/pre-staging-stale/attachment-move-manifest",
                    Some(attachment_move_manifest_body(&fixture)),
                    authenticated_json_headers(&session.token),
                )
                .await;
            response.assert_contract_status();
            assert_eq!(response.status, StatusCode::CONFLICT, "{}", response.body);
            assert_eq!(response.body["code"], json!("ATTACHMENT_AUTHORITY_STALE"));
            assert_eq!(
                retained_outcome_count(&app.pool, &fixture.owner_user_id, "pre-staging-stale")
                    .await,
                0
            );

            let rejection_body = json!({
                "mode": "reject_stale_authority",
                "sourceVaultId": fixture.main_vault_id,
                "targetVaultId": fixture.target_vault_id,
                "attachments": [{
                    "attachmentId": "move_attachment",
                    "expectedEnvelopeVersion": 1
                }]
            });
            let rejected = app
                .api_json(
                    Method::POST,
                    &format!("/api/v1/items/{}/moves", fixture.movable_item_id),
                    Some(rejection_body.clone()),
                    idempotent_item_headers(&session.token, 1, "pre-staging-stale"),
                )
                .await;
            rejected.assert_contract_status();
            assert_eq!(rejected.status, StatusCode::OK, "{}", rejected.body);
            assert_rejected(&rejected.body, "move_item", "attachment_state_conflict");
            let replay = app
                .api_json(
                    Method::POST,
                    &format!("/api/v1/items/{}/moves", fixture.movable_item_id),
                    Some(rejection_body),
                    idempotent_item_headers(&session.token, 1, "pre-staging-stale"),
                )
                .await;
            assert_eq!(replay.status, StatusCode::OK, "{}", replay.body);
            assert_eq!(replay.body, rejected.body);
            assert_eq!(
                entity_event_count(&app.pool, "pre-staging-stale", "operation_resolved").await,
                1
            );
            assert_eq!(
                entity_event_count(&app.pool, &fixture.movable_item_id, "item_moved").await,
                0
            );
        },
    )
    .await;
}

#[tokio::test]
async fn attachment_move_stale_rejection_probe_requires_preparation_when_authority_matches() {
    with_api_test_app("attachment_move_false_stale_probe", |app| async move {
        let fixture = build_vault_router_fixture(&app.pool).await;
        seed_attachment(
            &app.pool,
            "move_attachment",
            &fixture.movable_item_id,
            &fixture.main_vault_id,
            &fixture.owner_user_id,
        )
        .await;
        let session = app.issue_session(&fixture.owner_user_id).await;
        let response = app
            .api_json(
                Method::POST,
                &format!("/api/v1/items/{}/moves", fixture.movable_item_id),
                Some(json!({
                    "mode": "reject_stale_authority",
                    "sourceVaultId": fixture.main_vault_id,
                    "targetVaultId": fixture.target_vault_id,
                    "attachments": [{
                        "attachmentId": "move_attachment",
                        "expectedEnvelopeVersion": 1
                    }]
                })),
                idempotent_item_headers(&session.token, 1, "false-stale-probe"),
            )
            .await;
        response.assert_contract_status();
        assert_eq!(response.status, StatusCode::CONFLICT, "{}", response.body);
        assert_eq!(
            response.body["code"],
            json!("ATTACHMENT_STAGING_INCOMPLETE")
        );
        assert_eq!(
            retained_outcome_count(&app.pool, &fixture.owner_user_id, "false-stale-probe").await,
            0
        );
        assert_eq!(
            query_scalar::<_, String>("SELECT vault_id FROM item WHERE id = $1")
                .bind(&fixture.movable_item_id)
                .fetch_one(&app.pool)
                .await
                .unwrap(),
            fixture.main_vault_id
        );

        let semantic_rejection = app
            .api_json(
                Method::POST,
                &format!("/api/v1/items/{}/moves", fixture.movable_item_id),
                Some(json!({
                    "mode": "reject_stale_authority",
                    "sourceVaultId": fixture.target_vault_id,
                    "targetVaultId": fixture.main_vault_id,
                    "attachments": [{
                        "attachmentId": "move_attachment",
                        "expectedEnvelopeVersion": 1
                    }]
                })),
                idempotent_item_headers(&session.token, 1, "stale-probe-source-mismatch"),
            )
            .await;
        assert_eq!(
            semantic_rejection.status,
            StatusCode::OK,
            "{}",
            semantic_rejection.body
        );
        assert_rejected(
            &semantic_rejection.body,
            "move_item",
            "source_vault_mismatch",
        );
    })
    .await;
}

#[tokio::test]
async fn attachment_move_finalization_treats_attachment_order_as_non_semantic() {
    let storage = Arc::new(RecordingObjectStorage::succeeding_with_object_size(128));
    with_api_test_app_state(
        "attachment_move_order_independent",
        move |state| state.with_object_storage(storage),
        |app| async move {
            let fixture = build_vault_router_fixture(&app.pool).await;
            for attachment_id in ["move_attachment_a", "move_attachment_b"] {
                seed_attachment(
                    &app.pool,
                    attachment_id,
                    &fixture.movable_item_id,
                    &fixture.main_vault_id,
                    &fixture.owner_user_id,
                )
                .await;
            }
            let session = app.issue_session(&fixture.owner_user_id).await;
            let operation_id = "order-independent-move";
            let manifest = app
                .api_json(
                    Method::PUT,
                    &format!("/api/v1/operations/{operation_id}/attachment-move-manifest"),
                    Some(json!({
                        "itemId": fixture.movable_item_id,
                        "sourceVaultId": fixture.main_vault_id,
                        "targetVaultId": fixture.target_vault_id,
                        "attachments": [
                            { "attachmentId": "move_attachment_a", "envelopeVersion": 1, "ciphertextSha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
                            { "attachmentId": "move_attachment_b", "envelopeVersion": 1, "ciphertextSha256": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" }
                        ]
                    })),
                    authenticated_json_headers(&session.token),
                )
                .await;
            assert_eq!(manifest.status, StatusCode::OK, "{}", manifest.body);
            let final_attachment = |attachment_id: &str| json!({
                "attachmentId": attachment_id,
                "expectedEnvelopeVersion": 1,
                "encryptedAttachmentKey": format!("target-key-{attachment_id}"),
                "attachmentKeyIv": "target-key-iv",
                "attachmentKeyAlgorithm": "AES-GCM-AAD-V1",
                "encryptedName": "target-name",
                "encryptedContentType": "target-content-type",
                "encryptionIv": "target-blob-iv",
                "encryptedContentTypeIv": "target-type-iv",
                "encryptionAlgorithm": "AES-GCM-AAD-V1"
            });
            let response = app
                .api_json(
                    Method::POST,
                    &format!("/api/v1/items/{}/moves", fixture.movable_item_id),
                    Some(json!({
                        "mode": "prepared",
                        "sourceVaultId": fixture.main_vault_id,
                        "targetVaultId": fixture.target_vault_id,
                        "encryptedData": "target-item-ciphertext",
                        "encryptionIv": "target-item-iv",
                        "encryptionAlgorithm": "AES-GCM-AAD-V1",
                        "attachments": [
                            final_attachment("move_attachment_b"),
                            final_attachment("move_attachment_a")
                        ]
                    })),
                    idempotent_item_headers(&session.token, 1, operation_id),
                )
                .await;
            assert_eq!(response.status, StatusCode::OK, "{}", response.body);
            assert_applied(&response.body, "move_item", &fixture.movable_item_id, 2);
            assert_eq!(
                query_scalar::<_, i64>("SELECT COUNT(*)::bigint FROM item_attachment WHERE item_id = $1 AND vault_id = $2")
                    .bind(&fixture.movable_item_id)
                    .bind(&fixture.target_vault_id)
                    .fetch_one(&app.pool)
                    .await
                    .unwrap(),
                2
            );
        },
    )
    .await;
}

#[tokio::test]
async fn attachment_move_finalization_switches_all_authority_and_retains_one_outcome() {
    let storage = Arc::new(RecordingObjectStorage::succeeding_with_object_size(128));
    with_api_test_app_state(
        "attachment_move_atomic_finalization",
        move |state| state.with_object_storage(storage),
        |app| async move {
            let fixture = build_vault_router_fixture(&app.pool).await;
            seed_attachment(
                &app.pool,
                "move_attachment",
                &fixture.movable_item_id,
                &fixture.main_vault_id,
                &fixture.owner_user_id,
            )
            .await;
            let session = app.issue_session(&fixture.owner_user_id).await;
            let operation_id = "atomic-attachment-move";
            let manifest = app
                .api_json(
                    Method::PUT,
                    &format!("/api/v1/operations/{operation_id}/attachment-move-manifest"),
                    Some(json!({
                        "itemId": fixture.movable_item_id,
                        "sourceVaultId": fixture.main_vault_id,
                        "targetVaultId": fixture.target_vault_id,
                        "attachments": [{
                            "attachmentId": "move_attachment",
                            "envelopeVersion": 1,
                            "ciphertextSha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
                        }]
                    })),
                    authenticated_json_headers(&session.token),
                )
                .await;
            assert_eq!(manifest.status, StatusCode::OK, "{}", manifest.body);
            let staged_key = manifest.body["attachments"][0]["storageKey"]
                .as_str()
                .unwrap()
                .to_string();
            let response = app
                .api_json(
                    Method::POST,
                    &format!("/api/v1/items/{}/moves", fixture.movable_item_id),
                    Some(json!({
                        "mode": "prepared",
                        "sourceVaultId": fixture.main_vault_id,
                        "targetVaultId": fixture.target_vault_id,
                        "encryptedData": "target-item-ciphertext",
                        "encryptionIv": "target-item-iv",
                        "encryptionAlgorithm": "AES-GCM-AAD-V1",
                        "attachments": [{
                            "attachmentId": "move_attachment",
                            "expectedEnvelopeVersion": 1,
                            "encryptedAttachmentKey": "target-wrapped-key",
                            "attachmentKeyIv": "target-key-iv",
                            "attachmentKeyAlgorithm": "AES-GCM-AAD-V1",
                            "encryptedName": "target-name",
                            "encryptedContentType": "target-content-type",
                            "encryptionIv": "target-blob-iv",
                            "encryptedContentTypeIv": "target-type-iv",
                            "encryptionAlgorithm": "AES-GCM-AAD-V1"
                        }]
                    })),
                    idempotent_item_headers(&session.token, 1, operation_id),
                )
                .await;
            response.assert_contract_status();
            assert_eq!(response.status, StatusCode::OK, "{}", response.body);
            assert_applied(&response.body, "move_item", &fixture.movable_item_id, 2);
            let replay = app
                .api_json(
                    Method::POST,
                    &format!("/api/v1/items/{}/moves", fixture.movable_item_id),
                    Some(attachment_move_final_body(&fixture)),
                    idempotent_item_headers(&session.token, 1, operation_id),
                )
                .await;
            assert_eq!(replay.status, StatusCode::OK, "{}", replay.body);
            assert_eq!(replay.body, response.body);

            let authority = query_as::<_, (String, String, i32, String)>(
                "SELECT vault_id, storage_key, envelope_version, encrypted_attachment_key FROM item_attachment WHERE id = 'move_attachment'",
            )
            .fetch_one(&app.pool)
            .await
            .unwrap();
            assert_eq!(
                authority,
                (fixture.target_vault_id, staged_key, 2, "target-wrapped-key".into())
            );
            assert_eq!(
                retained_outcome_count(&app.pool, &fixture.owner_user_id, operation_id).await,
                1
            );
            assert_eq!(
                query_scalar::<_, i64>("SELECT COUNT(*)::bigint FROM attachment_move_staging_generation WHERE user_id = $1 AND operation_id = $2")
                    .bind(&fixture.owner_user_id)
                    .bind(operation_id)
                    .fetch_one(&app.pool)
                    .await
                    .unwrap(),
                0
            );
            assert_eq!(
                query_scalar::<_, i64>("SELECT COUNT(*)::bigint FROM attachment_move_cleanup WHERE user_id = $1 AND operation_id = $2 AND storage_key = 'attachments/move_attachment'")
                    .bind(&fixture.owner_user_id)
                    .bind(operation_id)
                    .fetch_one(&app.pool)
                    .await
                    .unwrap(),
                1
            );
        },
    )
    .await;
}

#[tokio::test]
async fn concurrent_identical_attachment_move_finalizers_both_replay_retained_outcome() {
    let storage = Arc::new(RecordingObjectStorage::succeeding_with_object_size(128));
    with_api_test_app_state(
        "attachment_move_concurrent_finalization",
        move |state| state.with_object_storage(storage),
        |app| async move {
            let fixture = build_vault_router_fixture(&app.pool).await;
            seed_attachment(
                &app.pool,
                "move_attachment",
                &fixture.movable_item_id,
                &fixture.main_vault_id,
                &fixture.owner_user_id,
            )
            .await;
            let session = app.issue_session(&fixture.owner_user_id).await;
            let operation_id = "concurrent-attachment-move";
            let manifest = app
                .api_json(
                    Method::PUT,
                    &format!("/api/v1/operations/{operation_id}/attachment-move-manifest"),
                    Some(attachment_move_manifest_body(&fixture)),
                    authenticated_json_headers(&session.token),
                )
                .await;
            assert_eq!(manifest.status, StatusCode::OK, "{}", manifest.body);

            let path = format!("/api/v1/items/{}/moves", fixture.movable_item_id);
            let headers = idempotent_item_headers(&session.token, 1, operation_id);
            let body = attachment_move_final_body(&fixture);
            let preflight = install_attachment_move_preflight_hook(operation_id);
            let loser = app.api_json(Method::POST, &path, Some(body.clone()), headers.clone());
            let winner_then_release = async {
                preflight.wait_until_entered().await;
                let winner = app.api_json(Method::POST, &path, Some(body), headers).await;
                preflight.release();
                winner
            };
            let (first, second) = tokio::join!(loser, winner_then_release);

            assert_eq!(first.status, StatusCode::OK, "{}", first.body);
            assert_eq!(second.status, StatusCode::OK, "{}", second.body);
            assert_eq!(first.body, second.body);
            assert_eq!(
                retained_outcome_count(&app.pool, &fixture.owner_user_id, operation_id).await,
                1
            );
        },
    )
    .await;
}

#[tokio::test]
async fn empty_prepared_attachment_set_mismatches_nonempty_manifest_without_consuming_staging() {
    let storage = Arc::new(RecordingObjectStorage::succeeding_with_object_size(128));
    with_api_test_app_state(
        "attachment_move_empty_prepared_set_mismatch",
        move |state| state.with_object_storage(storage),
        |app| async move {
            let fixture = build_vault_router_fixture(&app.pool).await;
            seed_attachment(
                &app.pool,
                "move_attachment",
                &fixture.movable_item_id,
                &fixture.main_vault_id,
                &fixture.owner_user_id,
            )
            .await;
            let session = app.issue_session(&fixture.owner_user_id).await;
            let operation_id = "empty-prepared-set-mismatch";
            let manifest = app
                .api_json(
                    Method::PUT,
                    &format!("/api/v1/operations/{operation_id}/attachment-move-manifest"),
                    Some(attachment_move_manifest_body(&fixture)),
                    authenticated_json_headers(&session.token),
                )
                .await;
            assert_eq!(manifest.status, StatusCode::OK, "{}", manifest.body);

            let mut body = attachment_move_final_body(&fixture);
            body["attachments"] = json!([]);
            let response = app
                .api_json(
                    Method::POST,
                    &format!("/api/v1/items/{}/moves", fixture.movable_item_id),
                    Some(body),
                    idempotent_item_headers(&session.token, 1, operation_id),
                )
                .await;
            assert_eq!(response.status, StatusCode::CONFLICT, "{}", response.body);
            assert_eq!(response.body["code"], json!("ATTACHMENT_STAGING_MISMATCH"));
            assert_eq!(
                retained_outcome_count(&app.pool, &fixture.owner_user_id, operation_id).await,
                0
            );
            assert_eq!(
                query_scalar::<_, i64>("SELECT COUNT(*)::bigint FROM attachment_move_staging WHERE user_id = $1 AND operation_id = $2")
                    .bind(&fixture.owner_user_id)
                    .bind(operation_id)
                    .fetch_one(&app.pool)
                    .await
                    .unwrap(),
                1
            );
        },
    )
    .await;
}

#[tokio::test]
async fn move_serializes_a_stale_source_attachment_update_without_aad_overwrite() {
    let storage = Arc::new(RecordingObjectStorage::succeeding_with_object_size(128));
    with_api_test_app_state(
        "attachment_move_serializes_update",
        move |state| state.with_object_storage(storage),
        |app| async move {
            let fixture = build_vault_router_fixture(&app.pool).await;
            seed_attachment(&app.pool, "move_attachment", &fixture.movable_item_id, &fixture.main_vault_id, &fixture.owner_user_id).await;
            let session = app.issue_session(&fixture.owner_user_id).await;
            let operation_id = "move-before-stale-update";
            let manifest = app.api_json(Method::PUT, &format!("/api/v1/operations/{operation_id}/attachment-move-manifest"), Some(attachment_move_manifest_body(&fixture)), authenticated_json_headers(&session.token)).await;
            assert_eq!(manifest.status, StatusCode::OK, "{}", manifest.body);
            let blocker = acquire_test_item_attachment_writer_lock(&app.pool, &fixture.movable_item_id).await;
            let move_path = format!("/api/v1/items/{}/moves", fixture.movable_item_id);
            let move_request = app.api_json(Method::POST, &move_path, Some(attachment_move_final_body(&fixture)), idempotent_item_headers(&session.token, 1, operation_id));
            let competing_done = Arc::new(tokio::sync::Notify::new());
            let update_done = competing_done.clone();
            let update_request = async {
                wait_for_advisory_waiters(&app.pool, 1).await;
                let response = app.api_json(Method::PATCH, "/api/v1/attachments/move_attachment", Some(json!({
                    "encryptedName": "stale-source-name",
                    "encryptionIv": "stale-source-iv",
                    "encryptionAlgorithm": "AES-GCM-AAD-V1"
                })), authenticated_json_headers(&session.token)).await;
                update_done.notify_one();
                response
            };
            let release = async {
                tokio::select! {
                    () = wait_for_advisory_waiters(&app.pool, 2) => {}
                    () = competing_done.notified() => {}
                }
                blocker.commit().await.unwrap();
            };
            let (moved, updated, ()) = tokio::join!(move_request, update_request, release);
            assert_eq!(moved.status, StatusCode::OK, "{}", moved.body);
            assert_eq!(updated.status, StatusCode::CONFLICT, "{}", updated.body);
            assert_eq!(query_as::<_, (String, String)>("SELECT vault_id, encrypted_name FROM item_attachment WHERE id = 'move_attachment'").fetch_one(&app.pool).await.unwrap(), (fixture.target_vault_id, "target-name".into()));
        },
    ).await;
}

#[tokio::test]
async fn rename_committed_before_move_advances_attachment_authority_and_move_rejects() {
    let storage = Arc::new(RecordingObjectStorage::succeeding_with_object_size(128));
    with_api_test_app_state(
        "attachment_rename_before_move",
        move |state| state.with_object_storage(storage),
        |app| async move {
            let fixture = build_vault_router_fixture(&app.pool).await;
            seed_attachment(
                &app.pool,
                "move_attachment",
                &fixture.movable_item_id,
                &fixture.main_vault_id,
                &fixture.owner_user_id,
            )
            .await;
            let session = app.issue_session(&fixture.owner_user_id).await;
            let operation_id = "rename-before-move";
            let manifest = app
                .api_json(
                    Method::PUT,
                    &format!("/api/v1/operations/{operation_id}/attachment-move-manifest"),
                    Some(attachment_move_manifest_body(&fixture)),
                    authenticated_json_headers(&session.token),
                )
                .await;
            assert_eq!(manifest.status, StatusCode::OK, "{}", manifest.body);

            let blocker = acquire_test_item_attachment_writer_lock(
                &app.pool,
                &fixture.movable_item_id,
            )
            .await;
            let rename = app.api_json(
                Method::PATCH,
                "/api/v1/attachments/move_attachment",
                Some(json!({
                    "encryptedName": "newer-source-name",
                    "encryptionIv": "newer-source-iv",
                    "encryptionAlgorithm": "AES-GCM-AAD-V1"
                })),
                authenticated_json_headers(&session.token),
            );
            let move_path = format!("/api/v1/items/{}/moves", fixture.movable_item_id);
            let finalize = async {
                wait_for_advisory_waiters(&app.pool, 1).await;
                app.api_json(
                    Method::POST,
                    &move_path,
                    Some(attachment_move_final_body(&fixture)),
                    idempotent_item_headers(&session.token, 1, operation_id),
                )
                .await
            };
            let release = async {
                wait_for_advisory_waiters(&app.pool, 2).await;
                blocker.commit().await.unwrap();
            };
            let (renamed, moved, ()) = tokio::join!(rename, finalize, release);

            assert_eq!(renamed.status, StatusCode::OK, "{}", renamed.body);
            assert_eq!(moved.status, StatusCode::OK, "{}", moved.body);
            assert_rejected(&moved.body, "move_item", "attachment_state_conflict");
            assert_eq!(
                query_as::<_, (String, i32, String, String)>(
                    "SELECT vault_id, envelope_version, encrypted_name, encryption_iv FROM item_attachment WHERE id = 'move_attachment'",
                )
                .fetch_one(&app.pool)
                .await
                .unwrap(),
                (
                    fixture.main_vault_id.clone(),
                    2,
                    "newer-source-name".into(),
                    "newer-source-iv".into(),
                )
            );
            let projection = app
                .api_json(
                    Method::GET,
                    &format!("/api/v1/items/{}/attachments", fixture.movable_item_id),
                    None,
                    authenticated_json_headers(&session.token),
                )
                .await;
            assert_eq!(projection.status, StatusCode::OK, "{}", projection.body);
            assert_eq!(projection.body["items"][0]["envelopeVersion"], json!(2));
            assert_eq!(
                projection.body["items"][0]["encryptedName"],
                json!("newer-source-name")
            );
            assert_eq!(
                query_scalar::<_, i64>("SELECT COUNT(*)::bigint FROM sync_event WHERE event_type = 'item_updated'::sync_event_type AND entity_id = $1")
                    .bind(&fixture.movable_item_id)
                    .fetch_one(&app.pool)
                    .await
                    .unwrap(),
                1
            );
        },
    )
    .await;
}

#[tokio::test]
async fn move_serializes_a_stale_source_attachment_delete_without_row_loss() {
    let storage = Arc::new(RecordingObjectStorage::succeeding_with_object_size(128));
    with_api_test_app_state(
        "attachment_move_serializes_delete",
        move |state| state.with_object_storage(storage),
        |app| async move {
            let fixture = build_vault_router_fixture(&app.pool).await;
            seed_attachment(&app.pool, "move_attachment", &fixture.movable_item_id, &fixture.main_vault_id, &fixture.owner_user_id).await;
            let session = app.issue_session(&fixture.owner_user_id).await;
            let operation_id = "move-before-stale-delete";
            let manifest = app.api_json(Method::PUT, &format!("/api/v1/operations/{operation_id}/attachment-move-manifest"), Some(attachment_move_manifest_body(&fixture)), authenticated_json_headers(&session.token)).await;
            assert_eq!(manifest.status, StatusCode::OK, "{}", manifest.body);
            let blocker = acquire_test_item_attachment_writer_lock(&app.pool, &fixture.movable_item_id).await;
            let move_path = format!("/api/v1/items/{}/moves", fixture.movable_item_id);
            let move_request = app.api_json(Method::POST, &move_path, Some(attachment_move_final_body(&fixture)), idempotent_item_headers(&session.token, 1, operation_id));
            let competing_done = Arc::new(tokio::sync::Notify::new());
            let delete_done = competing_done.clone();
            let delete_request = async {
                wait_for_advisory_waiters(&app.pool, 1).await;
                let response = app.api_json(Method::DELETE, "/api/v1/attachments/move_attachment", None, authenticated_json_headers(&session.token)).await;
                delete_done.notify_one();
                response
            };
            let release = async {
                tokio::select! {
                    () = wait_for_advisory_waiters(&app.pool, 2) => {}
                    () = competing_done.notified() => {}
                }
                blocker.commit().await.unwrap();
            };
            let (moved, deleted, ()) = tokio::join!(move_request, delete_request, release);
            assert_eq!(moved.status, StatusCode::OK, "{}", moved.body);
            assert_eq!(deleted.status, StatusCode::CONFLICT, "{}", deleted.body);
            assert_eq!(query_scalar::<_, i64>("SELECT COUNT(*)::bigint FROM item_attachment WHERE id = 'move_attachment' AND vault_id = $1").bind(&fixture.target_vault_id).fetch_one(&app.pool).await.unwrap(), 1);
        },
    ).await;
}

#[tokio::test]
async fn move_serializes_a_concurrent_attachment_create_without_source_phantom() {
    let storage_size = i64::from(encrypted_attachment_storage_size(16));
    let storage = Arc::new(RecordingObjectStorage::succeeding_with_object_size(
        storage_size,
    ));
    with_api_test_app_state(
        "attachment_move_serializes_create",
        move |state| state.with_object_storage(storage),
        |app| async move {
            let fixture = build_vault_router_fixture(&app.pool).await;
            seed_attachment(&app.pool, "move_attachment", &fixture.movable_item_id, &fixture.main_vault_id, &fixture.owner_user_id).await;
            query("UPDATE item_attachment SET storage_size = $1 WHERE id = 'move_attachment'")
                .bind(storage_size)
                .execute(&app.pool)
                .await
                .unwrap();
            let session = app.issue_session(&fixture.owner_user_id).await;
            let upload = app.api_json(Method::POST, &format!("/api/v1/items/{}/attachment-uploads", fixture.movable_item_id), Some(json!({"fileName":"new.enc","contentType":"application/octet-stream","fileSize":16})), authenticated_json_headers(&session.token)).await;
            assert_eq!(upload.status, StatusCode::OK, "{}", upload.body);
            let operation_id = "move-before-phantom-create";
            let manifest = app.api_json(Method::PUT, &format!("/api/v1/operations/{operation_id}/attachment-move-manifest"), Some(attachment_move_manifest_body(&fixture)), authenticated_json_headers(&session.token)).await;
            assert_eq!(manifest.status, StatusCode::OK, "{}", manifest.body);
            let blocker = acquire_test_item_attachment_writer_lock(&app.pool, &fixture.movable_item_id).await;
            let move_path = format!("/api/v1/items/{}/moves", fixture.movable_item_id);
            let move_request = app.api_json(Method::POST, &move_path, Some(attachment_move_final_body(&fixture)), idempotent_item_headers(&session.token, 1, operation_id));
            let competing_done = Arc::new(tokio::sync::Notify::new());
            let create_done = competing_done.clone();
            let create_request = async {
                wait_for_advisory_waiters(&app.pool, 1).await;
                let response = app.api_json(Method::POST, &format!("/api/v1/items/{}/attachments", fixture.movable_item_id), Some(json!({
                    "attachmentId": upload.body["attachmentId"], "storageKey": upload.body["key"],
                    "encryptedAttachmentKey":"new-key", "attachmentKeyIv":"new-key-iv", "attachmentKeyAlgorithm":"AES-GCM-AAD-V1",
                    "envelopeVersion":1, "encryptedName":"new-name", "encryptedContentType":"new-type",
                    "encryptionIv":"new-iv", "encryptedContentTypeIv":"new-type-iv", "encryptionAlgorithm":"AES-GCM-AAD-V1", "fileSize":16
                })), authenticated_json_headers(&session.token)).await;
                create_done.notify_one();
                response
            };
            let release = async {
                tokio::select! {
                    () = wait_for_advisory_waiters(&app.pool, 2) => {}
                    () = competing_done.notified() => {}
                }
                blocker.commit().await.unwrap();
            };
            let (moved, created, ()) = tokio::join!(move_request, create_request, release);
            assert_eq!(moved.status, StatusCode::OK, "{}", moved.body);
            assert_eq!(created.status, StatusCode::CONFLICT, "{}", created.body);
            assert_eq!(query_scalar::<_, i64>("SELECT COUNT(*)::bigint FROM item_attachment WHERE item_id = $1 AND vault_id = $2").bind(&fixture.movable_item_id).bind(&fixture.main_vault_id).fetch_one(&app.pool).await.unwrap(), 0);
        },
    ).await;
}

#[tokio::test]
async fn attachment_move_finalization_preserves_server_file_size_without_client_input() {
    let storage = Arc::new(RecordingObjectStorage::succeeding_with_object_size(128));
    with_api_test_app_state(
        "attachment_move_preserves_file_size",
        move |state| state.with_object_storage(storage),
        |app| async move {
            let fixture = build_vault_router_fixture(&app.pool).await;
            seed_attachment(
                &app.pool,
                "move_attachment",
                &fixture.movable_item_id,
                &fixture.main_vault_id,
                &fixture.owner_user_id,
            )
            .await;
            let session = app.issue_session(&fixture.owner_user_id).await;
            let operation_id = "move-preserves-file-size";
            let manifest = app
                .api_json(
                    Method::PUT,
                    &format!("/api/v1/operations/{operation_id}/attachment-move-manifest"),
                    Some(attachment_move_manifest_body(&fixture)),
                    authenticated_json_headers(&session.token),
                )
                .await;
            assert_eq!(manifest.status, StatusCode::OK, "{}", manifest.body);

            let mut body = attachment_move_final_body(&fixture);
            body["attachments"][0]
                .as_object_mut()
                .expect("Attachment Finalize body should be an object")
                .remove("fileSize");
            let response = app
                .api_json(
                    Method::POST,
                    &format!("/api/v1/items/{}/moves", fixture.movable_item_id),
                    Some(body),
                    idempotent_item_headers(&session.token, 1, operation_id),
                )
                .await;
            response.assert_contract_status();
            assert_eq!(response.status, StatusCode::OK, "{}", response.body);
            assert_eq!(
                query_scalar::<_, i32>(
                    "SELECT file_size FROM item_attachment WHERE id = 'move_attachment'"
                )
                .fetch_one(&app.pool)
                .await
                .unwrap(),
                128
            );
        },
    )
    .await;
}

#[tokio::test]
async fn attachment_move_finalization_rejects_manifest_intent_mismatch_without_outcome() {
    let storage = Arc::new(RecordingObjectStorage::succeeding_with_object_size(128));
    with_api_test_app_state(
        "attachment_move_manifest_mismatch",
        move |state| state.with_object_storage(storage),
        |app| async move {
            let fixture = build_vault_router_fixture(&app.pool).await;
            seed_attachment(
                &app.pool,
                "move_attachment",
                &fixture.movable_item_id,
                &fixture.main_vault_id,
                &fixture.owner_user_id,
            )
            .await;
            let session = app.issue_session(&fixture.owner_user_id).await;
            let operation_id = "move-manifest-mismatch";
            let manifest = app
                .api_json(
                    Method::PUT,
                    &format!("/api/v1/operations/{operation_id}/attachment-move-manifest"),
                    Some(attachment_move_manifest_body(&fixture)),
                    authenticated_json_headers(&session.token),
                )
                .await;
            assert_eq!(manifest.status, StatusCode::OK, "{}", manifest.body);

            let mut body = attachment_move_final_body(&fixture);
            body["targetVaultId"] = json!(fixture.main_vault_id);
            let response = app
                .api_json(
                    Method::POST,
                    &format!("/api/v1/items/{}/moves", fixture.movable_item_id),
                    Some(body),
                    idempotent_item_headers(&session.token, 1, operation_id),
                )
                .await;
            response.assert_contract_status();
            assert_eq!(response.status, StatusCode::CONFLICT, "{}", response.body);
            assert_eq!(response.body["code"], json!("ATTACHMENT_STAGING_MISMATCH"));
            assert_eq!(
                retained_outcome_count(&app.pool, &fixture.owner_user_id, operation_id).await,
                0
            );
        },
    )
    .await;
}

#[tokio::test]
async fn incomplete_attachment_move_staging_is_non_terminal_and_retains_no_outcome() {
    let storage = Arc::new(RecordingObjectStorage::succeeding_with_object_size(1));
    with_api_test_app_state(
        "attachment_move_staging_incomplete",
        move |state| state.with_object_storage(storage),
        |app| async move {
            let fixture = build_vault_router_fixture(&app.pool).await;
            seed_attachment(
                &app.pool,
                "move_attachment",
                &fixture.movable_item_id,
                &fixture.main_vault_id,
                &fixture.owner_user_id,
            )
            .await;
            let session = app.issue_session(&fixture.owner_user_id).await;
            let operation_id = "incomplete-attachment-move";
            let response = app
                .api_json(
                    Method::POST,
                    &format!("/api/v1/items/{}/moves", fixture.movable_item_id),
                    Some(json!({
                        "mode": "prepared",
                        "sourceVaultId": fixture.main_vault_id,
                        "targetVaultId": fixture.target_vault_id,
                        "encryptedData": "target-item-ciphertext",
                        "encryptionIv": "target-item-iv",
                        "encryptionAlgorithm": "AES-GCM-AAD-V1",
                        "attachments": [{
                            "attachmentId": "move_attachment",
                            "expectedEnvelopeVersion": 1,
                            "encryptedAttachmentKey": "target-wrapped-key",
                            "attachmentKeyIv": "target-key-iv",
                            "attachmentKeyAlgorithm": "AES-GCM-AAD-V1",
                            "encryptedName": "target-name",
                            "encryptedContentType": "target-content-type",
                            "encryptionIv": "target-blob-iv",
                            "encryptedContentTypeIv": "target-type-iv",
                            "encryptionAlgorithm": "AES-GCM-AAD-V1"
                        }]
                    })),
                    idempotent_item_headers(&session.token, 1, operation_id),
                )
                .await;
            response.assert_contract_status();
            assert_eq!(response.status, StatusCode::CONFLICT, "{}", response.body);
            assert_eq!(
                response.body["code"],
                json!("ATTACHMENT_STAGING_INCOMPLETE")
            );
            assert_eq!(
                retained_outcome_count(&app.pool, &fixture.owner_user_id, operation_id).await,
                0
            );
            assert_eq!(
                query_scalar::<_, String>("SELECT vault_id FROM item WHERE id = $1")
                    .bind(&fixture.movable_item_id)
                    .fetch_one(&app.pool)
                    .await
                    .unwrap(),
                fixture.main_vault_id
            );
            let manifest = app
                .api_json(
                    Method::PUT,
                    &format!("/api/v1/operations/{operation_id}/attachment-move-manifest"),
                    Some(attachment_move_manifest_body(&fixture)),
                    authenticated_json_headers(&session.token),
                )
                .await;
            assert_eq!(manifest.status, StatusCode::OK, "{}", manifest.body);
            query("UPDATE attachment_move_manifest SET expires_at = NOW() - INTERVAL '1 second'")
                .execute(&app.pool)
                .await
                .unwrap();
            let expired = app
                .api_json(
                    Method::POST,
                    &format!("/api/v1/items/{}/moves", fixture.movable_item_id),
                    Some(attachment_move_final_body(&fixture)),
                    idempotent_item_headers(&session.token, 1, operation_id),
                )
                .await;
            assert_eq!(expired.status, StatusCode::CONFLICT, "{}", expired.body);
            assert_eq!(expired.body["code"], json!("ATTACHMENT_STAGING_INCOMPLETE"));
            assert_eq!(
                retained_outcome_count(&app.pool, &fixture.owner_user_id, operation_id).await,
                0
            );

            let incomplete_operation = "incomplete-object-attachment-move";
            let manifest = app
                .api_json(
                    Method::PUT,
                    &format!("/api/v1/operations/{incomplete_operation}/attachment-move-manifest"),
                    Some(attachment_move_manifest_body(&fixture)),
                    authenticated_json_headers(&session.token),
                )
                .await;
            assert_eq!(manifest.status, StatusCode::OK, "{}", manifest.body);
            let incomplete = app
                .api_json(
                    Method::POST,
                    &format!("/api/v1/items/{}/moves", fixture.movable_item_id),
                    Some(attachment_move_final_body(&fixture)),
                    idempotent_item_headers(&session.token, 1, incomplete_operation),
                )
                .await;
            assert_eq!(
                incomplete.status,
                StatusCode::CONFLICT,
                "{}",
                incomplete.body
            );
            assert_eq!(
                incomplete.body["code"],
                json!("ATTACHMENT_STAGING_INCOMPLETE")
            );
            assert_eq!(
                retained_outcome_count(&app.pool, &fixture.owner_user_id, incomplete_operation)
                    .await,
                0
            );
        },
    )
    .await;
}

#[tokio::test]
async fn attachment_move_database_boundaries_leave_no_partial_authority() {
    for (case, table, event, when_clause, during_manifest) in [
        (
            "generation_create",
            "attachment_move_staging_generation",
            "INSERT",
            "",
            true,
        ),
        ("manifest", "attachment_move_manifest", "INSERT", "", true),
        ("staging", "attachment_move_staging", "INSERT", "", true),
        ("item", "item", "UPDATE", "", false),
        ("attachment", "item_attachment", "UPDATE", "", false),
        ("cleanup", "attachment_move_cleanup", "INSERT", "", false),
        (
            "staging_consume",
            "attachment_move_staging",
            "DELETE",
            "",
            false,
        ),
        (
            "manifest_close",
            "attachment_move_manifest",
            "DELETE",
            "",
            false,
        ),
        (
            "generation_close",
            "attachment_move_staging_generation",
            "DELETE",
            "",
            false,
        ),
        (
            "audit",
            "audit_log",
            "INSERT",
            "WHEN (NEW.action = 'item_moved')",
            false,
        ),
        (
            "item_sync",
            "sync_event",
            "INSERT",
            "WHEN (NEW.event_type = 'item_moved')",
            false,
        ),
        (
            "operation_sync",
            "sync_event",
            "INSERT",
            "WHEN (NEW.event_type = 'operation_resolved')",
            false,
        ),
        ("outcome", "operation_outcome", "INSERT", "", false),
    ] {
        let storage = Arc::new(RecordingObjectStorage::succeeding_with_object_size(128));
        with_api_test_app_state(
            &format!("attachment_move_boundary_{case}"),
            move |state| state.with_object_storage(storage),
            |app| async move {
                let fixture = build_vault_router_fixture(&app.pool).await;
                seed_attachment(
                    &app.pool,
                    "move_attachment",
                    &fixture.movable_item_id,
                    &fixture.main_vault_id,
                    &fixture.owner_user_id,
                )
                .await;
                let session = app.issue_session(&fixture.owner_user_id).await;
                let operation_id = format!("boundary-{case}");
                if during_manifest {
                    install_attachment_move_failure_trigger(&app.pool, table, event, when_clause).await;
                }
                let manifest = app
                    .api_json(
                        Method::PUT,
                        &format!(
                            "/api/v1/operations/{operation_id}/attachment-move-manifest"
                        ),
                        Some(attachment_move_manifest_body(&fixture)),
                        authenticated_json_headers(&session.token),
                    )
                    .await;
                if during_manifest {
                    assert_eq!(manifest.status, StatusCode::INTERNAL_SERVER_ERROR);
                    assert_eq!(
                        query_scalar::<_, i64>("SELECT COUNT(*)::bigint FROM attachment_move_manifest")
                            .fetch_one(&app.pool)
                            .await
                            .unwrap(),
                        0
                    );
                    assert_eq!(
                        query_scalar::<_, i64>("SELECT COUNT(*)::bigint FROM attachment_move_staging")
                            .fetch_one(&app.pool)
                            .await
                            .unwrap(),
                        0
                    );
                    return;
                }
                assert_eq!(manifest.status, StatusCode::OK, "{}", manifest.body);
                install_attachment_move_failure_trigger(&app.pool, table, event, when_clause).await;
                let response = app
                    .api_json(
                        Method::POST,
                        &format!("/api/v1/items/{}/moves", fixture.movable_item_id),
                        Some(attachment_move_final_body(&fixture)),
                        idempotent_item_headers(&session.token, 1, &operation_id),
                    )
                    .await;
                assert_eq!(response.status, StatusCode::INTERNAL_SERVER_ERROR);
                assert_eq!(
                    query_as::<_, (String, i32)>(
                        "SELECT vault_id, version FROM item WHERE id = $1"
                    )
                    .bind(&fixture.movable_item_id)
                    .fetch_one(&app.pool)
                    .await
                    .unwrap(),
                    (fixture.main_vault_id.clone(), 1)
                );
                assert_eq!(
                    query_as::<_, (String, String, i32)>(
                        "SELECT vault_id, storage_key, envelope_version FROM item_attachment WHERE id = 'move_attachment'"
                    )
                    .fetch_one(&app.pool)
                    .await
                    .unwrap(),
                    (
                        fixture.main_vault_id,
                        "attachments/move_attachment".into(),
                        1
                    )
                );
                assert_eq!(
                    retained_outcome_count(&app.pool, &fixture.owner_user_id, &operation_id).await,
                    0
                );
            },
        )
        .await;
    }
}

#[tokio::test]
async fn attachment_move_manifest_renewal_boundaries_are_atomic() {
    for (case, table, event, seed_obsolete_cleanup) in [
        ("lease", "attachment_move_manifest", "UPDATE", false),
        (
            "obsolete_cleanup",
            "attachment_move_cleanup",
            "DELETE",
            true,
        ),
    ] {
        let storage = Arc::new(RecordingObjectStorage::succeeding(None));
        with_api_test_app_state(
            &format!("attachment_move_renewal_boundary_{case}"),
            move |state| state.with_object_storage(storage),
            |app| async move {
                let fixture = build_vault_router_fixture(&app.pool).await;
                seed_attachment(
                    &app.pool,
                    "move_attachment",
                    &fixture.movable_item_id,
                    &fixture.main_vault_id,
                    &fixture.owner_user_id,
                )
                .await;
                let session = app.issue_session(&fixture.owner_user_id).await;
                let operation_id = format!("renewal-boundary-{case}");
                let path = format!(
                    "/api/v1/operations/{operation_id}/attachment-move-manifest"
                );
                let body = attachment_move_manifest_body(&fixture);
                let first = app
                    .api_json(
                        Method::PUT,
                        &path,
                        Some(body.clone()),
                        authenticated_json_headers(&session.token),
                    )
                    .await;
                assert_eq!(first.status, StatusCode::OK, "{}", first.body);
                let original_expiry: OffsetDateTime = query_scalar(
                    "SELECT expires_at FROM attachment_move_manifest WHERE user_id = $1 AND operation_id = $2",
                )
                .bind(&fixture.owner_user_id)
                .bind(&operation_id)
                .fetch_one(&app.pool)
                .await
                .unwrap();
                if seed_obsolete_cleanup {
                    query("INSERT INTO attachment_move_cleanup (user_id, operation_id, storage_key) SELECT user_id, operation_id, storage_key FROM attachment_move_staging WHERE user_id = $1 AND operation_id = $2")
                        .bind(&fixture.owner_user_id)
                        .bind(&operation_id)
                        .execute(&app.pool)
                        .await
                        .unwrap();
                }
                install_attachment_move_failure_trigger(&app.pool, table, event, "").await;
                let renewal = app
                    .api_json(
                        Method::PUT,
                        &path,
                        Some(body),
                        authenticated_json_headers(&session.token),
                    )
                    .await;
                assert_eq!(renewal.status, StatusCode::INTERNAL_SERVER_ERROR);
                assert_eq!(
                    query_scalar::<_, OffsetDateTime>("SELECT expires_at FROM attachment_move_manifest WHERE user_id = $1 AND operation_id = $2")
                        .bind(&fixture.owner_user_id)
                        .bind(&operation_id)
                        .fetch_one(&app.pool)
                        .await
                        .unwrap(),
                    original_expiry
                );
                assert_eq!(
                    query_scalar::<_, i64>("SELECT COUNT(*)::bigint FROM attachment_move_cleanup WHERE user_id = $1 AND operation_id = $2")
                        .bind(&fixture.owner_user_id)
                        .bind(&operation_id)
                        .fetch_one(&app.pool)
                        .await
                        .unwrap(),
                    if seed_obsolete_cleanup { 1 } else { 0 }
                );
            },
        )
        .await;
    }
}

#[tokio::test]
async fn attachment_move_final_lease_renewal_failure_retains_no_outcome() {
    let storage = Arc::new(RecordingObjectStorage::succeeding_with_object_size(128));
    with_api_test_app_state(
        "attachment_move_final_lease_boundary",
        move |state| state.with_object_storage(storage),
        |app| async move {
            let fixture = build_vault_router_fixture(&app.pool).await;
            seed_attachment(
                &app.pool,
                "move_attachment",
                &fixture.movable_item_id,
                &fixture.main_vault_id,
                &fixture.owner_user_id,
            )
            .await;
            let session = app.issue_session(&fixture.owner_user_id).await;
            let operation_id = "final-lease-boundary";
            let manifest = app
                .api_json(
                    Method::PUT,
                    &format!("/api/v1/operations/{operation_id}/attachment-move-manifest"),
                    Some(attachment_move_manifest_body(&fixture)),
                    authenticated_json_headers(&session.token),
                )
                .await;
            assert_eq!(manifest.status, StatusCode::OK, "{}", manifest.body);
            install_attachment_move_failure_trigger(
                &app.pool,
                "attachment_move_manifest",
                "UPDATE",
                "",
            )
            .await;
            let final_response = app
                .api_json(
                    Method::POST,
                    &format!("/api/v1/items/{}/moves", fixture.movable_item_id),
                    Some(attachment_move_final_body(&fixture)),
                    idempotent_item_headers(&session.token, 1, operation_id),
                )
                .await;
            assert_eq!(final_response.status, StatusCode::INTERNAL_SERVER_ERROR);
            assert_eq!(
                retained_outcome_count(&app.pool, &fixture.owner_user_id, operation_id).await,
                0
            );
            assert_eq!(
                query_as::<_, (String, i32)>("SELECT vault_id, version FROM item WHERE id = $1")
                    .bind(&fixture.movable_item_id)
                    .fetch_one(&app.pool)
                    .await
                    .unwrap(),
                (fixture.main_vault_id, 1)
            );
        },
    )
    .await;
}

#[tokio::test]
async fn attachment_move_expired_takeover_boundaries_are_atomic() {
    for (case, table, event) in [
        ("queue", "attachment_move_cleanup", "INSERT"),
        ("release", "attachment_move_manifest", "DELETE"),
    ] {
        let storage = Arc::new(RecordingObjectStorage::succeeding(None));
        with_api_test_app_state(
            &format!("attachment_move_takeover_boundary_{case}"),
            move |state| state.with_object_storage(storage),
            |app| async move {
                let fixture = build_vault_router_fixture(&app.pool).await;
                seed_attachment(
                    &app.pool,
                    "move_attachment",
                    &fixture.movable_item_id,
                    &fixture.main_vault_id,
                    &fixture.owner_user_id,
                )
                .await;
                let session = app.issue_session(&fixture.owner_user_id).await;
                let body = attachment_move_manifest_body(&fixture);
                let first = app
                    .api_json(
                        Method::PUT,
                        "/api/v1/operations/expired-owner/attachment-move-manifest",
                        Some(body.clone()),
                        authenticated_json_headers(&session.token),
                    )
                    .await;
                assert_eq!(first.status, StatusCode::OK, "{}", first.body);
                query("UPDATE attachment_move_manifest SET expires_at = NOW() - INTERVAL '1 second' WHERE user_id = $1 AND operation_id = 'expired-owner'")
                    .bind(&fixture.owner_user_id)
                    .execute(&app.pool)
                    .await
                    .unwrap();
                install_attachment_move_failure_trigger(&app.pool, table, event, "").await;
                let takeover = app
                    .api_json(
                        Method::PUT,
                        "/api/v1/operations/new-owner/attachment-move-manifest",
                        Some(body),
                        authenticated_json_headers(&session.token),
                    )
                    .await;
                assert_eq!(takeover.status, StatusCode::INTERNAL_SERVER_ERROR);
                assert_eq!(
                    query_scalar::<_, i64>("SELECT COUNT(*)::bigint FROM attachment_move_manifest WHERE user_id = $1 AND operation_id = 'expired-owner'")
                        .bind(&fixture.owner_user_id)
                        .fetch_one(&app.pool)
                        .await
                        .unwrap(),
                    1
                );
                assert_eq!(
                    query_scalar::<_, i64>("SELECT COUNT(*)::bigint FROM attachment_move_manifest WHERE user_id = $1 AND operation_id = 'new-owner'")
                        .bind(&fixture.owner_user_id)
                        .fetch_one(&app.pool)
                        .await
                        .unwrap(),
                    0
                );
                assert_eq!(
                    query_scalar::<_, i64>("SELECT COUNT(*)::bigint FROM attachment_move_cleanup")
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

#[tokio::test]
async fn stale_attachment_authority_is_terminal_and_queues_staging_cleanup() {
    let storage = Arc::new(RecordingObjectStorage::succeeding_with_object_size(128));
    with_api_test_app_state(
        "attachment_move_stale_authority",
        move |state| state.with_object_storage(storage),
        |app| async move {
            let fixture = build_vault_router_fixture(&app.pool).await;
            seed_attachment(
                &app.pool,
                "move_attachment",
                &fixture.movable_item_id,
                &fixture.main_vault_id,
                &fixture.owner_user_id,
            )
            .await;
            let session = app.issue_session(&fixture.owner_user_id).await;
            let operation_id = "stale-attachment-authority";
            let manifest = app
                .api_json(
                    Method::PUT,
                    &format!("/api/v1/operations/{operation_id}/attachment-move-manifest"),
                    Some(attachment_move_manifest_body(&fixture)),
                    authenticated_json_headers(&session.token),
                )
                .await;
            assert_eq!(manifest.status, StatusCode::OK, "{}", manifest.body);
            let staged_key = manifest.body["attachments"][0]["storageKey"]
                .as_str()
                .unwrap()
                .to_string();
            query("UPDATE item_attachment SET envelope_version = 2 WHERE id = 'move_attachment'")
                .execute(&app.pool)
                .await
                .unwrap();
            let response = app
                .api_json(
                    Method::POST,
                    &format!("/api/v1/items/{}/moves", fixture.movable_item_id),
                    Some(attachment_move_final_body(&fixture)),
                    idempotent_item_headers(&session.token, 1, operation_id),
                )
                .await;
            assert_eq!(response.status, StatusCode::OK, "{}", response.body);
            assert_rejected(&response.body, "move_item", "attachment_state_conflict");
            assert_eq!(
                retained_outcome_count(&app.pool, &fixture.owner_user_id, operation_id).await,
                1
            );
            assert_eq!(
                query_scalar::<_, i64>("SELECT COUNT(*)::bigint FROM attachment_move_staging_generation WHERE user_id = $1 AND operation_id = $2")
                    .bind(&fixture.owner_user_id)
                    .bind(operation_id)
                    .fetch_one(&app.pool)
                    .await
                    .unwrap(),
                0
            );
            assert_eq!(
                query_scalar::<_, i64>("SELECT COUNT(*)::bigint FROM attachment_move_cleanup WHERE user_id = $1 AND operation_id = $2 AND storage_key = $3")
                    .bind(&fixture.owner_user_id)
                    .bind(operation_id)
                    .bind(staged_key)
                    .fetch_one(&app.pool)
                    .await
                    .unwrap(),
                1
            );
        },
    )
    .await;
}

#[tokio::test]
async fn reject_stale_authority_consumes_existing_staging_and_queues_its_key() {
    let storage = Arc::new(RecordingObjectStorage::succeeding_with_object_size(128));
    with_api_test_app_state(
        "attachment_move_reject_stale_cleans_existing_staging",
        move |state| state.with_object_storage(storage),
        |app| async move {
            let fixture = build_vault_router_fixture(&app.pool).await;
            seed_attachment(
                &app.pool,
                "move_attachment",
                &fixture.movable_item_id,
                &fixture.main_vault_id,
                &fixture.owner_user_id,
            )
            .await;
            let session = app.issue_session(&fixture.owner_user_id).await;
            let operation_id = "reject-stale-cleans-preparation";
            let manifest = app
                .api_json(
                    Method::PUT,
                    &format!("/api/v1/operations/{operation_id}/attachment-move-manifest"),
                    Some(attachment_move_manifest_body(&fixture)),
                    authenticated_json_headers(&session.token),
                )
                .await;
            assert_eq!(manifest.status, StatusCode::OK, "{}", manifest.body);
            let staged_key = manifest.body["attachments"][0]["storageKey"]
                .as_str()
                .unwrap()
                .to_string();
            query("UPDATE item_attachment SET envelope_version = 2 WHERE id = 'move_attachment'")
                .execute(&app.pool)
                .await
                .unwrap();
            let response = app
                .api_json(
                    Method::POST,
                    &format!("/api/v1/items/{}/moves", fixture.movable_item_id),
                    Some(json!({
                        "mode": "reject_stale_authority",
                        "sourceVaultId": fixture.main_vault_id,
                        "targetVaultId": fixture.target_vault_id,
                        "attachments": [{
                            "attachmentId": "move_attachment",
                            "expectedEnvelopeVersion": 1
                        }]
                    })),
                    idempotent_item_headers(&session.token, 1, operation_id),
                )
                .await;
            assert_eq!(response.status, StatusCode::OK, "{}", response.body);
            assert_rejected(&response.body, "move_item", "attachment_state_conflict");
            assert_eq!(
                query_scalar::<_, i64>("SELECT COUNT(*)::bigint FROM attachment_move_manifest WHERE user_id = $1 AND operation_id = $2")
                    .bind(&fixture.owner_user_id)
                    .bind(operation_id)
                    .fetch_one(&app.pool)
                    .await
                    .unwrap(),
                0
            );
            assert_eq!(
                query_scalar::<_, i64>("SELECT COUNT(*)::bigint FROM attachment_move_staging_generation WHERE user_id = $1 AND operation_id = $2")
                    .bind(&fixture.owner_user_id)
                    .bind(operation_id)
                    .fetch_one(&app.pool)
                    .await
                    .unwrap(),
                0
            );
            assert_eq!(
                query_scalar::<_, i64>("SELECT COUNT(*)::bigint FROM attachment_move_cleanup WHERE user_id = $1 AND operation_id = $2 AND storage_key = $3")
                    .bind(&fixture.owner_user_id)
                    .bind(operation_id)
                    .bind(staged_key)
                    .fetch_one(&app.pool)
                    .await
                    .unwrap(),
                1
            );
        },
    )
    .await;
}

async fn mark_item_deleted(pool: &PgPool, item_id: &str) {
    query("UPDATE item SET deleted_at = $1 WHERE id = $2")
        .bind(OffsetDateTime::now_utc())
        .bind(item_id)
        .execute(pool)
        .await
        .expect("item should mark deleted");
}

async fn set_team_billing(pool: &PgPool, team_id: &str, plan: &str, status: &str) {
    query(
			"UPDATE team SET billing_plan = $1::billing_plan, billing_status = $2::billing_status WHERE id = $3",
		)
		.bind(plan)
		.bind(status)
		.bind(team_id)
		.execute(pool)
		.await
		.expect("team billing should update");
}

#[test]
fn assert_item_write_access_rejects_read_only_access() {
    assert_item_write_access(VaultRole::Owner, "write denied").unwrap();
    assert_item_write_access(VaultRole::Admin, "write denied").unwrap();
    assert_item_write_access(VaultRole::Member, "write denied").unwrap();

    let error = assert_item_write_access(VaultRole::ReadOnly, "write denied").unwrap_err();
    assert_eq!(error.code, AppErrorCode::Forbidden);
    assert_eq!(error.message, "write denied");
}

#[test]
fn attachment_quota_lock_key_scopes_by_team() {
    assert_eq!(
        attachment_quota_lock_key("team_123"),
        "attachment-quota:team_123"
    );
}

#[test]
fn base64_encoded_length_uses_three_byte_chunks() {
    assert_eq!(base64_encoded_length(0), 0);
    assert_eq!(base64_encoded_length(1), 4);
    assert_eq!(base64_encoded_length(2), 4);
    assert_eq!(base64_encoded_length(3), 4);
    assert_eq!(base64_encoded_length(4), 8);
}

#[test]
fn encrypted_attachment_storage_size_accounts_for_metadata_overhead() {
    assert_eq!(encrypted_attachment_storage_size(1), 98);
    assert_eq!(encrypted_attachment_storage_size(3), 98);
    assert_eq!(encrypted_attachment_storage_size(4), 102);
}

#[test]
fn pending_attachment_upload_expiry_adds_fifteen_minutes() {
    let now = OffsetDateTime::from_unix_timestamp(1_717_171_717).unwrap();

    assert_eq!(
        pending_attachment_upload_expiry(now) - now,
        Duration::minutes(15)
    );
}

#[tokio::test]
async fn vault_handlers_require_authentication() {
    with_api_test_app("vault_handlers_require_authentication", |app| async move {
        let protected_calls = [
            (Method::GET, "/api/v1/vaults", None),
            (Method::GET, "/api/v1/vaults/vault_test", None),
            (
                Method::POST,
                "/api/v1/vaults/vault_test/image-uploads",
                Some(json!({})),
            ),
            (
                Method::POST,
                "/api/v1/items/item_test/attachment-uploads",
                Some(json!({})),
            ),
            (
                Method::POST,
                "/api/v1/items/item_test/attachments",
                Some(json!({})),
            ),
            (Method::GET, "/api/v1/items/item_test/attachments", None),
            (
                Method::POST,
                "/api/v1/attachments/attachment_test/download-urls",
                None,
            ),
            (
                Method::PATCH,
                "/api/v1/attachments/attachment_test",
                Some(json!({})),
            ),
            (Method::DELETE, "/api/v1/attachments/attachment_test", None),
            (Method::PUT, "/api/v1/vaults/vault_test", Some(json!({}))),
            (Method::PATCH, "/api/v1/vaults/vault_test", Some(json!({}))),
            (
                Method::POST,
                "/api/v1/vaults/vault_test/type-conversions",
                Some(json!({})),
            ),
            (Method::DELETE, "/api/v1/vaults/vault_test", None),
            (Method::GET, "/api/v1/vaults/vault_test/items", None),
            (Method::GET, "/api/v1/items", None),
            (Method::GET, "/api/v1/items/trashed", None),
            (Method::GET, "/api/v1/items/item_test", None),
            (
                Method::PUT,
                "/api/v1/vaults/vault_test/items/item_test",
                Some(json!({})),
            ),
            (
                Method::POST,
                "/api/v1/vaults/vault_test/item-imports",
                Some(json!({})),
            ),
            (Method::PATCH, "/api/v1/items/item_test", Some(json!({}))),
            (
                Method::PATCH,
                "/api/v1/items/item_test/favorite",
                Some(json!({})),
            ),
            (Method::DELETE, "/api/v1/items/item_test", None),
            (Method::GET, "/api/v1/vaults/vault_test/items/trashed", None),
            (Method::POST, "/api/v1/items/item_test/restore", None),
            (
                Method::POST,
                "/api/v1/items/item_test/moves",
                Some(json!({})),
            ),
            (Method::DELETE, "/api/v1/items/item_test/permanent", None),
            (Method::GET, "/api/v1/vault-stats", None),
            (Method::GET, "/api/v1/vaults/vault_test/members", None),
            (
                Method::GET,
                "/api/v1/vaults/vault_test/available-team-members",
                None,
            ),
            (
                Method::PATCH,
                "/api/v1/vaults/vault_test/members/user_test",
                Some(json!({})),
            ),
            (
                Method::PUT,
                "/api/v1/vaults/vault_test/members/user_test",
                Some(json!({})),
            ),
            (
                Method::POST,
                "/api/v1/vaults/vault_test/members/user_test/removal-rotation-plans",
                None,
            ),
            (
                Method::POST,
                "/api/v1/vaults/vault_test/members/user_test/removal-rotation-plans/finalize",
                Some(json!({ "planIds": [] })),
            ),
        ];

        for (method, path, payload) in protected_calls {
            let response = app
                .api_json(method, path, payload, unauthenticated_json_headers())
                .await;

            response.assert_contract_status();
            assert_transport_error(
                &response.body,
                "UNAUTHORIZED",
                "A valid bearer session is required.",
            );
        }
    })
    .await;
}

#[tokio::test]
async fn vault_handlers_reject_malformed_request_input() {
    with_api_test_app(
        "vault_handlers_reject_malformed_request_input",
        |app| async move {
            let fixture = build_vault_router_fixture(&app.pool).await;
            let owner_session = app.issue_session(&fixture.owner_user_id).await;
            let headers = authenticated_json_headers(&owner_session.token);

            for (method, path) in [
                (
                    Method::POST,
                    format!(
                        "/api/v1/items/{}/attachment-uploads",
                        fixture.active_item_id
                    ),
                ),
                (
                    Method::POST,
                    format!("/api/v1/items/{}/attachments", fixture.active_item_id),
                ),
                (
                    Method::PUT,
                    format!(
                        "/api/v1/vaults/{}/items/malformed-item!",
                        fixture.main_vault_id
                    ),
                ),
                (
                    Method::POST,
                    format!(
                        "/api/v1/vaults/{}/members/{}/removal-rotation-plans/finalize",
                        fixture.main_vault_id, fixture.member_user_id
                    ),
                ),
            ] {
                let response = app
                    .api_json(method, &path, Some(json!({})), headers.clone())
                    .await;

                response.assert_contract_status();
                assert_invalid_params_error(&response.body);
            }
        },
    )
    .await;
}

#[tokio::test]
async fn vault_query_handlers_return_expected_results() {
    with_api_test_app(
        "vault_query_handlers_return_expected_results",
        |app| async move {
            let fixture = build_vault_router_fixture(&app.pool).await;
            let owner_session = app.issue_session(&fixture.owner_user_id).await;
            let owner_headers = authenticated_json_headers(&owner_session.token);

            let list_response = app
                .api_json(Method::GET, "/api/v1/vaults", None, owner_headers.clone())
                .await;
            list_response.assert_contract_status();
            let listed_vaults = list_response
                .body
                .get("items")
                .and_then(Value::as_array)
                .expect("vault collection should contain items");
            assert_eq!(listed_vaults.len(), 3);
            let main_vault = find_entry_by_id(listed_vaults, &fixture.main_vault_id);
            assert_eq!(main_vault["role"], json!("owner"));
            assert_eq!(main_vault["encryptedVaultKey"], json!("main-owner-key"));
            assert_eq!(main_vault["itemCount"], json!("2"));

            let get_response = app
                .api_json(
                    Method::GET,
                    &format!("/api/v1/vaults/{}", fixture.main_vault_id),
                    None,
                    owner_headers.clone(),
                )
                .await;
            get_response.assert_contract_status();
            assert_eq!(get_response.body["id"], json!(fixture.main_vault_id));
            assert_eq!(get_response.body["itemCount"], json!("2"));
            assert_eq!(get_response.body["memberCount"], json!("4"));

            let list_items_response = app
                .api_json(
                    Method::GET,
                    &format!("/api/v1/vaults/{}/items", fixture.main_vault_id),
                    None,
                    owner_headers.clone(),
                )
                .await;
            list_items_response.assert_contract_status();
            let list_items = list_items_response
                .body
                .get("items")
                .and_then(Value::as_array)
                .expect("vault item collection should contain items");
            assert_eq!(list_items.len(), 2);
            let active_item = find_entry_by_id(list_items, &fixture.active_item_id);
            assert_eq!(active_item["attachments"].as_array().unwrap().len(), 1);
            assert_eq!(
                active_item["attachments"][0]["id"],
                json!(fixture.attachment_id)
            );

            query("UPDATE item SET updated_at = $1 WHERE vault_id = $2 AND deleted_at IS NULL")
                .bind(OffsetDateTime::from_unix_timestamp(1_710_000_000).unwrap())
                .bind(&fixture.main_vault_id)
                .execute(&app.pool)
                .await
                .expect("equal item timestamps should be set");
            let first_page = app
                .api_json(
                    Method::GET,
                    &format!("/api/v1/vaults/{}/items?limit={}", fixture.main_vault_id, 1),
                    None,
                    owner_headers.clone(),
                )
                .await;
            first_page.assert_contract_status();
            assert_eq!(first_page.body["items"].as_array().unwrap().len(), 1);
            assert_eq!(first_page.body["hasMore"], json!(true));
            let cursor = first_page.body["nextCursor"]
                .as_str()
                .expect("continued page should include a cursor");
            let second_page = app
                .api_json(
                    Method::GET,
                    &format!(
                        "/api/v1/vaults/{}/items?cursor={}&limit={}",
                        fixture.main_vault_id, cursor, 1
                    ),
                    None,
                    owner_headers.clone(),
                )
                .await;
            second_page.assert_contract_status();
            assert_ne!(
                first_page.body["items"][0]["id"],
                second_page.body["items"][0]["id"]
            );
            assert_eq!(second_page.body["hasMore"], json!(false));

            let tampered_page = app
                .api_json(
                    Method::GET,
                    &format!(
                        "/api/v1/vaults/{}/items?cursor={cursor}x&limit={}",
                        fixture.main_vault_id, 1
                    ),
                    None,
                    owner_headers.clone(),
                )
                .await;
            assert_eq!(tampered_page.status, StatusCode::BAD_REQUEST);
            assert_eq!(tampered_page.body["code"], json!("INVALID_CURSOR"));

            let list_all_items_response = app
                .api_json(Method::GET, "/api/v1/items", None, owner_headers.clone())
                .await;
            list_all_items_response.assert_contract_status();
            let all_items = list_all_items_response
                .body
                .get("items")
                .and_then(Value::as_array)
                .expect("item collection should contain items");
            assert_eq!(all_items.len(), 3);
            let personal_item = find_entry_by_id(all_items, &fixture.personal_item_id);
            assert_eq!(
                personal_item["vault"]["id"],
                json!(fixture.owner_personal_vault_id)
            );

            let invalid_query = app
                .api_json(
                    Method::GET,
                    "/api/v1/items?unknown=true",
                    None,
                    owner_headers.clone(),
                )
                .await;
            assert_eq!(invalid_query.status, StatusCode::BAD_REQUEST);
            assert_eq!(invalid_query.body["code"], json!("INVALID_QUERY"));
            assert_eq!(
                invalid_query.headers.get(CONTENT_TYPE),
                Some(&HeaderValue::from_static("application/problem+json"))
            );

            let list_all_deleted_response = app
                .api_json(
                    Method::GET,
                    "/api/v1/items/trashed",
                    None,
                    owner_headers.clone(),
                )
                .await;
            list_all_deleted_response.assert_contract_status();
            let all_deleted_items = list_all_deleted_response
                .body
                .get("items")
                .and_then(Value::as_array)
                .expect("trashed item collection should contain items");
            assert_eq!(all_deleted_items.len(), 1);
            assert_eq!(all_deleted_items[0]["id"], json!(fixture.deleted_item_id));

            let list_deleted_response = app
                .api_json(
                    Method::GET,
                    &format!("/api/v1/vaults/{}/items/trashed", fixture.main_vault_id),
                    None,
                    owner_headers.clone(),
                )
                .await;
            list_deleted_response.assert_contract_status();
            let deleted_items = list_deleted_response
                .body
                .get("items")
                .and_then(Value::as_array)
                .expect("trashed vault item collection should contain items");
            assert_eq!(deleted_items.len(), 1);
            assert_eq!(deleted_items[0]["id"], json!(fixture.deleted_item_id));

            let get_item_response = app
                .api_json(
                    Method::GET,
                    &format!("/api/v1/items/{}", fixture.active_item_id),
                    None,
                    owner_headers.clone(),
                )
                .await;
            get_item_response.assert_contract_status();
            assert_eq!(get_item_response.body["id"], json!(fixture.active_item_id));

            let stats_response = app
                .api_json(Method::GET, "/api/v1/vault-stats", None, owner_headers)
                .await;
            stats_response.assert_contract_status();
            assert_eq!(stats_response.body["teamCount"], json!(1));
            assert_eq!(stats_response.body["vaultCount"], json!("3"));
            assert_eq!(stats_response.body["itemCount"], json!("3"));
        },
    )
    .await;
}

#[tokio::test]
async fn max_ciphertext_item_pages_stay_byte_bounded_and_continue() {
    with_api_test_app("max_ciphertext_item_page_budget", |app| async move {
        let fixture = build_vault_router_fixture(&app.pool).await;
        let session = app.issue_session(&fixture.owner_user_id).await;
        let headers = authenticated_json_headers(&session.token);
        let ciphertext = "x".repeat(1_048_576);
        let expected_ids: Vec<String> = (0..6)
            .map(|index| format!("zz_item_budget_{index}"))
            .collect();
        for item_id in &expected_ids {
            seed_item(
                &app.pool,
                item_id,
                &fixture.main_vault_id,
                "login",
                &ciphertext,
                "budget-iv",
                &fixture.owner_user_id,
            )
            .await;
        }

        let mut cursor = None;
        let mut seen_ids = Vec::new();
        for _ in 0..4 {
            let query = cursor.as_deref().map_or_else(
                || "limit=500".to_string(),
                |cursor| format!("limit=500&cursor={cursor}"),
            );
            let response = app
                .api_json(
                    Method::GET,
                    &format!("/api/v1/vaults/{}/items?{query}", fixture.main_vault_id),
                    None,
                    headers.clone(),
                )
                .await;
            response.assert_contract_status();
            assert!(
                response.body_bytes <= crate::http::pagination::RESPONSE_PAGE_BYTES,
                "serialized page was {} bytes",
                response.body_bytes
            );
            let items = response.body["items"]
                .as_array()
                .expect("bounded item page should contain items");
            assert!(
                items
                    .iter()
                    .filter(|item| {
                        item["encryptedData"]
                            .as_str()
                            .is_some_and(|value| value.len() >= 1_048_576)
                    })
                    .count()
                    <= 3,
                "pre-budget query materialized too many maximum-size rows"
            );
            seen_ids.extend(
                items
                    .iter()
                    .filter_map(|item| item["id"].as_str().map(str::to_string)),
            );
            if response.body["hasMore"] == json!(false) {
                break;
            }
            cursor = Some(
                response.body["nextCursor"]
                    .as_str()
                    .expect("continued item page should have a cursor")
                    .to_string(),
            );
        }

        for item_id in expected_ids {
            assert_eq!(
                seen_ids.iter().filter(|seen| **seen == item_id).count(),
                1,
                "item {item_id} should occur exactly once across pages"
            );
        }
    })
    .await;
}

#[tokio::test]
async fn large_vault_metadata_pages_stay_byte_bounded_and_continue() {
    with_api_test_app("large_vault_metadata_page_budget", |app| async move {
        let fixture = build_vault_router_fixture(&app.pool).await;
        let session = app.issue_session(&fixture.owner_user_id).await;
        let headers = authenticated_json_headers(&session.token);
        let large_name = "n".repeat(super::VAULT_NAME_MAX_CHARS);
        let large_key = "k".repeat(super::key::ENCRYPTED_VAULT_KEY_MAX_BYTES);
        let expected_ids: Vec<String> = (0..70)
            .map(|index| format!("vault_metadata_budget_{index:03}"))
            .collect();
        for (index, vault_id) in expected_ids.iter().enumerate() {
            seed_vault(
                &app.pool,
                vault_id,
                &large_name,
                "personal",
                &fixture.owner_user_id,
                None,
            )
            .await;
            seed_vault_key(
                &app.pool,
                &format!("vault_key_metadata_budget_{index:03}"),
                vault_id,
                &fixture.owner_user_id,
                &large_key,
                "owner",
            )
            .await;
        }

        let mut cursor = None;
        let mut seen_ids = Vec::new();
        for _ in 0..4 {
            let query = cursor.as_deref().map_or_else(
                || "limit=500".to_string(),
                |cursor| format!("limit=500&cursor={cursor}"),
            );
            let response = app
                .api_json(
                    Method::GET,
                    &format!("/api/v1/vaults?{query}"),
                    None,
                    headers.clone(),
                )
                .await;
            response.assert_contract_status();
            assert!(response.body_bytes <= crate::http::pagination::RESPONSE_PAGE_BYTES);
            seen_ids.extend(
                response.body["items"]
                    .as_array()
                    .expect("vault page should contain items")
                    .iter()
                    .filter_map(|vault| vault["id"].as_str().map(str::to_string)),
            );
            if response.body["hasMore"] == json!(false) {
                break;
            }
            cursor = Some(
                response.body["nextCursor"]
                    .as_str()
                    .expect("continued vault page should have a cursor")
                    .to_string(),
            );
        }
        for vault_id in expected_ids {
            assert_eq!(seen_ids.iter().filter(|seen| **seen == vault_id).count(), 1);
        }
    })
    .await;
}

#[tokio::test]
async fn vault_query_handlers_enforce_access_and_not_found() {
    with_api_test_app(
        "vault_query_handlers_enforce_access_and_not_found",
        |app| async move {
            let fixture = build_vault_router_fixture(&app.pool).await;
            let owner_session = app.issue_session(&fixture.owner_user_id).await;
            let outsider_session = app.issue_session(&fixture.outsider_user_id).await;
            let owner_headers = authenticated_json_headers(&owner_session.token);
            let outsider_headers = authenticated_json_headers(&outsider_session.token);

            let missing_vault_response = app
                .api_json(
                    Method::GET,
                    &format!("/api/v1/vaults/{}", "vault_missing"),
                    None,
                    owner_headers.clone(),
                )
                .await;
            missing_vault_response.assert_contract_status();
            assert_handler_error(
                &missing_vault_response.body,
                "NOT_FOUND",
                "Vault not found or access denied",
            );

            let list_items_response = app
                .api_json(
                    Method::GET,
                    &format!("/api/v1/vaults/{}/items", fixture.main_vault_id),
                    None,
                    outsider_headers.clone(),
                )
                .await;
            list_items_response.assert_contract_status();
            assert_handler_error(
                &list_items_response.body,
                "FORBIDDEN",
                "Access denied to this vault",
            );

            let missing_item_response = app
                .api_json(
                    Method::GET,
                    &format!("/api/v1/items/{}", "item_missing"),
                    None,
                    owner_headers.clone(),
                )
                .await;
            missing_item_response.assert_contract_status();
            assert_handler_error(&missing_item_response.body, "NOT_FOUND", "Item not found");

            let outsider_item_response = app
                .api_json(
                    Method::GET,
                    &format!("/api/v1/items/{}", fixture.active_item_id),
                    None,
                    outsider_headers,
                )
                .await;
            outsider_item_response.assert_contract_status();
            assert_handler_error(&outsider_item_response.body, "FORBIDDEN", "Access denied");
        },
    )
    .await;
}

#[tokio::test]
async fn vault_create_audit_failure_rolls_back_mutation() {
    with_api_test_app("vault_create_audit_atomicity", |app| async move {
        let fixture = build_vault_router_fixture(&app.pool).await;
        install_required_audit_failure_trigger(&app.pool, "vault_created").await;
        let session = app.issue_session(&fixture.solo_user_id).await;
        let vault_id = "vault_rejected_audit";

        let response = app
            .api_json(
                Method::PUT,
                &format!("/api/v1/vaults/{vault_id}"),
                Some(json!({
                    "name": "Atomic Audit Vault",
                    "vaultType": "personal",
                    "encryptedVaultKey": "atomic-audit-key"
                })),
                authenticated_json_headers(&session.token),
            )
            .await;

        response.assert_contract_status();
        assert_eq!(response.status, StatusCode::INTERNAL_SERVER_ERROR);
        let vault_count: i64 = query_scalar("SELECT COUNT(*)::bigint FROM vault WHERE id = $1")
            .bind(vault_id)
            .fetch_one(&app.pool)
            .await
            .expect("vault count should load");
        assert_eq!(
            vault_count, 0,
            "vault mutation must roll back with its audit"
        );
        let sync_event_count: i64 = query_scalar(
            "SELECT COUNT(*)::bigint FROM sync_event WHERE entity_id = $1 AND event_type = 'vault_created'::sync_event_type",
        )
        .bind(vault_id)
        .fetch_one(&app.pool)
        .await
        .expect("vault sync event count should load");
        assert_eq!(
            sync_event_count, 0,
            "vault sync event must roll back with its audit"
        );
    })
    .await;
}

#[tokio::test]
async fn item_create_audit_failure_rolls_back_mutation() {
    with_api_test_app("item_create_audit_atomicity", |app| async move {
        let fixture = build_vault_router_fixture(&app.pool).await;
        install_required_audit_failure_trigger(&app.pool, "item_created").await;
        let session = app.issue_session(&fixture.owner_user_id).await;
        let item_id = "item_rejected_audit";

        let response = app
            .api_json(
                Method::PUT,
                &format!(
                    "/api/v1/vaults/{}/items/{item_id}",
                    fixture.owner_personal_vault_id
                ),
                Some(json!({
                    "category": "login",
                    "encryptedData": "atomic-audit-data",
                    "encryptionIv": "atomic-audit-iv",
                    "encryptionAlgorithm": "aes-gcm"
                })),
                idempotency_headers(&session.token, "item-create-audit-failure"),
            )
            .await;

        response.assert_contract_status();
        assert_eq!(response.status, StatusCode::INTERNAL_SERVER_ERROR);
        let item_count: i64 = query_scalar("SELECT COUNT(*)::bigint FROM item WHERE id = $1")
            .bind(item_id)
            .fetch_one(&app.pool)
            .await
            .expect("item count should load");
        assert_eq!(item_count, 0, "item mutation must roll back with its audit");
        let sync_event_count: i64 = query_scalar(
            "SELECT COUNT(*)::bigint FROM sync_event WHERE entity_id = $1 AND event_type = 'item_created'::sync_event_type",
        )
        .bind(item_id)
        .fetch_one(&app.pool)
        .await
        .expect("item sync event count should load");
        assert_eq!(
            sync_event_count, 0,
            "item sync event must roll back with its audit"
        );
    })
    .await;
}

#[tokio::test]
async fn create_item_rolls_back_when_a_late_operation_step_fails() {
    for (test_name, table, when_clause) in [
        (
            "item_create_item_event_failure",
            "sync_event",
            "WHEN (NEW.event_type = 'item_created')",
        ),
        ("item_create_outcome_failure", "operation_outcome", ""),
        (
            "item_create_operation_event_failure",
            "sync_event",
            "WHEN (NEW.event_type = 'operation_resolved')",
        ),
    ] {
        with_api_test_app(test_name, |app| async move {
            let fixture = build_vault_router_fixture(&app.pool).await;
            install_operation_step_failure_trigger(&app.pool, table, when_clause).await;
            let session = app.issue_session(&fixture.owner_user_id).await;
            let item_id = format!("{test_name}_item");
            let operation_id = format!("{test_name}_operation");
            let response = app
                .api_json(
                    Method::PUT,
                    &format!(
                        "/api/v1/vaults/{}/items/{item_id}",
                        fixture.owner_personal_vault_id
                    ),
                    Some(json!({
                        "category": "login",
                        "encryptedData": "atomic-ciphertext",
                        "encryptionIv": "atomic-iv",
                        "encryptionAlgorithm": "aes-gcm"
                    })),
                    idempotency_headers(&session.token, &operation_id),
                )
                .await;
            assert_eq!(response.status, StatusCode::INTERNAL_SERVER_ERROR);
            let item_count: i64 = query_scalar("SELECT COUNT(*)::bigint FROM item WHERE id = $1")
                .bind(&item_id)
                .fetch_one(&app.pool)
                .await
                .expect("Item count should load");
            let audit_count: i64 = query_scalar(
                "SELECT COUNT(*)::bigint FROM audit_log WHERE entity_id = $1 AND action = 'item_created'",
            )
            .bind(&item_id)
            .fetch_one(&app.pool)
            .await
            .expect("audit count should load");
            let event_count: i64 = query_scalar(
                "SELECT COUNT(*)::bigint FROM sync_event WHERE entity_id = $1 OR entity_id = $2",
            )
            .bind(&item_id)
            .bind(&operation_id)
            .fetch_one(&app.pool)
            .await
            .expect("event count should load");
            let outcome_count: i64 = query_scalar(
                "SELECT COUNT(*)::bigint FROM operation_outcome WHERE user_id = $1 AND operation_id = $2",
            )
            .bind(&fixture.owner_user_id)
            .bind(&operation_id)
            .fetch_one(&app.pool)
            .await
            .expect("outcome count should load");
            assert_eq!((item_count, audit_count, event_count, outcome_count), (0, 0, 0, 0));
        })
        .await;
    }
}

#[tokio::test]
async fn vault_item_mutation_handlers_manage_item_lifecycle() {
    with_api_test_app(
        "vault_item_mutation_handlers_manage_item_lifecycle",
        |app| async move {
            let fixture = build_vault_router_fixture(&app.pool).await;
            let owner_session = app.issue_session(&fixture.owner_user_id).await;
            let owner_headers = authenticated_json_headers(&owner_session.token);
            let created_item_id = "vault_created_item";
            let imported_item_a = "vault_import_item_a";
            let imported_item_b = "vault_import_item_b";

            let empty_import_response = app
                .api_json(Method::POST, &format!("/api/v1/vaults/{}/item-imports", fixture.owner_personal_vault_id), Some(json!({ "items": [] })), owner_headers.clone())
                .await;
            empty_import_response.assert_contract_status();
            assert_eq!(empty_import_response.body["importedCount"], json!(0));

            let create_item_response = app
                .api_json(Method::PUT, &format!("/api/v1/vaults/{}/items/{}", fixture.owner_personal_vault_id, created_item_id), Some(json!({ "category": "login", "encryptedData": "created-encrypted-data", "encryptionIv": "created-iv", "encryptionAlgorithm": "aes-gcm" })), idempotency_headers(&owner_session.token, "lifecycle-create-item"))
                .await;
            create_item_response.assert_contract_status();
            assert_eq!(create_item_response.body["result"]["itemId"], json!(created_item_id));

            let bulk_import_response = app
                .api_json(Method::POST, &format!("/api/v1/vaults/{}/item-imports", fixture.owner_personal_vault_id), Some(json!({ "items": [
                            {
                                "itemId": imported_item_a,
                                "category": "login",
                                "favorite": true,
                                "encryptedData": "imported-a-data",
                                "encryptionIv": "imported-a-iv",
                                "encryptionAlgorithm": "aes-gcm"
                            },
                            {
                                "itemId": imported_item_b,
                                "category": "login",
                                "encryptedData": "imported-b-data",
                                "encryptionIv": "imported-b-iv",
                                "encryptionAlgorithm": "aes-gcm"
                            }
                        ] })), owner_headers.clone())
                .await;
            bulk_import_response.assert_contract_status();
            assert_eq!(bulk_import_response.body["importedCount"], json!(2));

            let current_version: i32 = query_scalar("SELECT version FROM item WHERE id = $1")
                .bind(&fixture.active_item_id)
                .fetch_one(&app.pool)
                .await
                .expect("active item version should load");
            let update_response = app
                .api_json(Method::PATCH, &format!("/api/v1/items/{}", fixture.active_item_id), Some(json!({ "encryptedData": "active-encrypted-data-updated", "encryptionIv": "active-iv-updated" })), idempotent_item_headers(&owner_session.token, current_version, "lifecycle-update-item"))
                .await;
            update_response.assert_contract_status();
            assert_applied(&update_response.body, "update_item", &fixture.active_item_id, current_version + 1);
            let updated_data: String =
                query_scalar("SELECT encrypted_data FROM item WHERE id = $1")
                    .bind(&fixture.active_item_id)
                    .fetch_one(&app.pool)
                    .await
                    .expect("updated item data should load");
            assert_eq!(updated_data, "active-encrypted-data-updated");

            let toggle_response = app
                .api_json(Method::PATCH, &format!("/api/v1/items/{}/favorite", fixture.active_item_id), Some(json!({ "favorite": true })), idempotent_item_headers(&owner_session.token, current_version + 1, "lifecycle-favorite-item"))
                .await;
            toggle_response.assert_contract_status();
            assert_applied(&toggle_response.body, "set_item_favorite", &fixture.active_item_id, current_version + 2);
            let favorite: bool = query_scalar("SELECT favorite FROM item WHERE id = $1")
                .bind(&fixture.active_item_id)
                .fetch_one(&app.pool)
                .await
                .expect("favorite flag should load");
            assert!(favorite);

            let delete_response = app
                .api_json(Method::DELETE, &format!("/api/v1/items/{}", imported_item_a), None, idempotent_item_headers(&owner_session.token, 1, "lifecycle-trash-item"))
                .await;
            delete_response.assert_contract_status();
            assert_applied(&delete_response.body, "trash_item", imported_item_a, 2);
            let deleted_at: Option<OffsetDateTime> =
                query_scalar("SELECT deleted_at FROM item WHERE id = $1")
                    .bind(imported_item_a)
                    .fetch_one(&app.pool)
                    .await
                    .expect("deleted_at should load");
            assert!(deleted_at.is_some());

            let restore_response = app
                .api_json(Method::POST, &format!("/api/v1/items/{}/restore", fixture.deleted_item_id), None, idempotent_item_headers(&owner_session.token, 1, "lifecycle-restore-item"))
                .await;
            restore_response.assert_contract_status();
            assert_applied(&restore_response.body, "restore_item", &fixture.deleted_item_id, 2);
            let restored_deleted_at: Option<OffsetDateTime> =
                query_scalar("SELECT deleted_at FROM item WHERE id = $1")
                    .bind(&fixture.deleted_item_id)
                    .fetch_one(&app.pool)
                    .await
                    .expect("restored deleted_at should load");
            assert!(restored_deleted_at.is_none());

            let move_response = app
                .api_json(Method::POST, &format!("/api/v1/items/{}/moves", fixture.movable_item_id), Some(json!({ "mode": "prepared", "sourceVaultId": fixture.main_vault_id, "targetVaultId": fixture.target_vault_id, "encryptedData": "moved-encrypted-data", "encryptionIv": "moved-iv", "encryptionAlgorithm": "aes-gcm" })), idempotent_item_headers(&owner_session.token, 1, "lifecycle-move-item"))
                .await;
            move_response.assert_contract_status();
            assert_applied(&move_response.body, "move_item", &fixture.movable_item_id, 2);
            let moved_vault_id: String = query_scalar("SELECT vault_id FROM item WHERE id = $1")
                .bind(&fixture.movable_item_id)
                .fetch_one(&app.pool)
                .await
                .expect("moved item vault id should load");
            assert_eq!(moved_vault_id, fixture.target_vault_id);

            let permanent_delete_response = app
                .api_json(Method::DELETE, &format!("/api/v1/items/{}/permanent", imported_item_a), None, idempotent_item_headers(&owner_session.token, 2, "lifecycle-permanent-delete-item"))
                .await;
            permanent_delete_response.assert_contract_status();
            assert_applied(&permanent_delete_response.body, "permanently_delete_item", imported_item_a, 3);
            let remaining_rows: i64 =
                query_scalar("SELECT COUNT(*)::bigint FROM item WHERE id = $1")
                    .bind(imported_item_a)
                    .fetch_one(&app.pool)
                    .await
                    .expect("remaining item rows should load");
            assert_eq!(remaining_rows, 0);
        },
    )
    .await;
}

#[tokio::test]
async fn rest_item_mutations_require_and_advance_strong_versions() {
    with_api_test_app(
        "rest_item_mutations_require_and_advance_strong_versions",
        |app| async move {
            let fixture = build_vault_router_fixture(&app.pool).await;
            let owner_session = app.issue_session(&fixture.owner_user_id).await;
            let headers = authenticated_json_headers(&owner_session.token);
            let item_uri = format!("/api/v1/items/{}", fixture.active_item_id);

            let get = app
                .api_json(Method::GET, &item_uri, None, headers.clone())
                .await;
            get.assert_contract_status();
            assert_eq!(get.headers.get(ETAG).unwrap(), "\"1\"");

            let missing_patch = app
                .api_json(
                    Method::PATCH,
                    &item_uri,
                    Some(json!({ "encryptedData": "must-not-write" })),
                    headers.clone(),
                )
                .await;
            assert_eq!(missing_patch.status, StatusCode::PRECONDITION_REQUIRED);
            assert_eq!(missing_patch.body["code"], json!("PRECONDITION_REQUIRED"));

            let missing_delete = app
                .api_json(Method::DELETE, &item_uri, None, headers.clone())
                .await;
            assert_eq!(missing_delete.status, StatusCode::PRECONDITION_REQUIRED);

            // A well-formed precondition without a stable Operation ID is still malformed
            // transport, and it must not reach semantic execution.
            let missing_operation_id = app
                .api_json(
                    Method::PATCH,
                    &item_uri,
                    Some(json!({ "encryptedData": "must-not-write" })),
                    with_if_match(headers.clone(), 1),
                )
                .await;
            assert_eq!(missing_operation_id.status, StatusCode::BAD_REQUEST);
            assert_eq!(
                missing_operation_id.body["code"],
                json!("INVALID_OPERATION_ID")
            );

            let stale = app
                .api_json(
                    Method::PATCH,
                    &item_uri,
                    Some(json!({ "encryptedData": "stale-write" })),
                    idempotent_item_headers(
                        &owner_session.token,
                        99,
                        "strong-version-stale-update",
                    ),
                )
                .await;
            stale.assert_contract_status();
            assert_rejected(&stale.body, "update_item", "item_version_conflict");
            let stale_delete = app
                .api_json(
                    Method::DELETE,
                    &item_uri,
                    None,
                    idempotent_item_headers(&owner_session.token, 99, "strong-version-stale-trash"),
                )
                .await;
            stale_delete.assert_contract_status();
            assert_rejected(&stale_delete.body, "trash_item", "item_version_conflict");
            let unchanged: (String, i32, bool, Option<OffsetDateTime>) = sqlx::query_as(
                "SELECT encrypted_data, version, favorite, deleted_at FROM item WHERE id = $1",
            )
            .bind(&fixture.active_item_id)
            .fetch_one(&app.pool)
            .await
            .unwrap();
            assert_eq!(
                unchanged,
                ("active-encrypted-data".to_string(), 1, false, None)
            );

            let updated = app
                .api_json(
                    Method::PATCH,
                    &item_uri,
                    Some(json!({ "encryptedData": "version-two" })),
                    idempotent_item_headers(&owner_session.token, 1, "strong-version-update"),
                )
                .await;
            updated.assert_contract_status();
            assert_applied(&updated.body, "update_item", &fixture.active_item_id, 2);

            let favorite = app
                .api_json(
                    Method::PATCH,
                    &format!("{item_uri}/favorite"),
                    Some(json!({ "favorite": true })),
                    idempotent_item_headers(&owner_session.token, 2, "strong-version-favorite"),
                )
                .await;
            favorite.assert_contract_status();
            assert_applied(
                &favorite.body,
                "set_item_favorite",
                &fixture.active_item_id,
                3,
            );
            let after_favorite: (i32, bool) =
                sqlx::query_as("SELECT version, favorite FROM item WHERE id = $1")
                    .bind(&fixture.active_item_id)
                    .fetch_one(&app.pool)
                    .await
                    .unwrap();
            assert_eq!(after_favorite, (3, true));

            let trashed = app
                .api_json(
                    Method::DELETE,
                    &item_uri,
                    None,
                    idempotent_item_headers(&owner_session.token, 3, "strong-version-trash"),
                )
                .await;
            trashed.assert_contract_status();
            assert_applied(&trashed.body, "trash_item", &fixture.active_item_id, 4);
            let after_trash: (i32, Option<OffsetDateTime>) =
                sqlx::query_as("SELECT version, deleted_at FROM item WHERE id = $1")
                    .bind(&fixture.active_item_id)
                    .fetch_one(&app.pool)
                    .await
                    .unwrap();
            assert_eq!(after_trash.0, 4);
            assert!(after_trash.1.is_some());

            let restored = app
                .api_json(
                    Method::POST,
                    &format!("{item_uri}/restore"),
                    None,
                    idempotent_item_headers(&owner_session.token, 4, "strong-version-restore"),
                )
                .await;
            restored.assert_contract_status();
            assert_applied(&restored.body, "restore_item", &fixture.active_item_id, 5);
            let after_restore: (i32, Option<OffsetDateTime>) =
                sqlx::query_as("SELECT version, deleted_at FROM item WHERE id = $1")
                    .bind(&fixture.active_item_id)
                    .fetch_one(&app.pool)
                    .await
                    .unwrap();
            assert_eq!(after_restore, (5, None));
        },
    )
    .await;
}

#[tokio::test]
async fn favorite_service_advances_item_version() {
    with_api_test_app("favorite_service_advances_item_version", |app| async move {
        let fixture = build_vault_router_fixture(&app.pool).await;
        let session = app.issue_session(&fixture.owner_user_id).await;
        let response = app
            .api_json(
                Method::PATCH,
                &format!("/api/v1/items/{}/favorite", fixture.active_item_id),
                Some(json!({ "favorite": true })),
                idempotent_item_headers(&session.token, 1, "favorite-service-operation"),
            )
            .await;
        assert_applied(
            &response.body,
            "set_item_favorite",
            &fixture.active_item_id,
            2,
        );

        let version: i32 = query_scalar("SELECT version FROM item WHERE id = $1")
            .bind(&fixture.active_item_id)
            .fetch_one(&app.pool)
            .await
            .unwrap();
        assert_eq!(version, 2);
    })
    .await;
}

#[tokio::test]
async fn favorite_event_retains_the_request_client_id_and_encryption_context() {
    with_api_test_app("favorite_event_client_and_context", |app| async move {
        let fixture = build_vault_router_fixture(&app.pool).await;
        query(
            "UPDATE item SET encryption_version = 1, encrypted_by_user_id = $1 WHERE id = $2",
        )
        .bind(&fixture.owner_user_id)
        .bind(&fixture.active_item_id)
        .execute(&app.pool)
        .await
        .unwrap();
        let session = app.issue_session(&fixture.owner_user_id).await;
        let mut headers =
            idempotent_item_headers(&session.token, 1, "favorite-client-id-operation");
        headers.insert(
            "bittery-client-id",
            HeaderValue::from_static("favorite-regression-client"),
        );

        let response = app
            .api_json(
                Method::PATCH,
                &format!("/api/v1/items/{}/favorite", fixture.active_item_id),
                Some(json!({ "favorite": true })),
                headers,
            )
            .await;

        assert_applied(
            &response.body,
            "set_item_favorite",
            &fixture.active_item_id,
            2,
        );
        let event: (Option<String>, String) = sqlx::query_as(
            "SELECT client_id, entity_id FROM sync_event WHERE event_type = 'item_updated'::sync_event_type ORDER BY created_at DESC LIMIT 1",
        )
        .fetch_one(&app.pool)
        .await
        .unwrap();
        assert_eq!(event.0.as_deref(), Some("favorite-regression-client"));
        assert_eq!(event.1, fixture.active_item_id);
        let context: (Option<i32>, Option<String>) = sqlx::query_as(
            "SELECT encryption_version, encrypted_by_user_id FROM item WHERE id = $1",
        )
        .bind(&fixture.active_item_id)
        .fetch_one(&app.pool)
        .await
        .unwrap();
        assert_eq!(context, (Some(1), Some(fixture.owner_user_id)));
    })
    .await;
}

#[tokio::test]
async fn attachment_update_event_names_the_parent_item() {
    with_api_test_app("attachment_update_parent_item_event", |app| async move {
        let fixture = build_vault_router_fixture(&app.pool).await;
        let session = app.issue_session(&fixture.owner_user_id).await;

        let response = app
            .api_json(
                Method::PATCH,
                &format!("/api/v1/attachments/{}", fixture.attachment_id),
                Some(json!({
                    "encryptedName": "renamed-attachment",
                    "encryptionIv": "renamed-iv",
                    "encryptionAlgorithm": "aes-gcm"
                })),
                authenticated_json_headers(&session.token),
            )
            .await;

        assert_eq!(response.status, StatusCode::OK);
        let entity_id: String = query_scalar(
            "SELECT entity_id FROM sync_event WHERE event_type = 'item_updated'::sync_event_type ORDER BY created_at DESC LIMIT 1",
        )
        .fetch_one(&app.pool)
        .await
        .unwrap();
        assert_eq!(entity_id, fixture.active_item_id);
    })
    .await;
}

#[tokio::test]
async fn item_encryption_context_tracks_ciphertext_not_metadata_revisions() {
    with_api_test_app("item_encryption_context_revisions", |app| async move {
        let fixture = build_vault_router_fixture(&app.pool).await;
        let owner_session = app.issue_session(&fixture.owner_user_id).await;
        let member_session = app.issue_session(&fixture.member_user_id).await;
        let item_id = "item_encryption_context_revisions";
        let item_uri = format!("/api/v1/items/{item_id}");

        let created = app
            .api_json(
                Method::PUT,
                &format!("/api/v1/vaults/{}/items/{item_id}", fixture.main_vault_id),
                Some(json!({
                    "category": "login",
                    "encryptedData": "created-ciphertext",
                    "encryptionIv": "created-iv",
                    "encryptionAlgorithm": "aes-gcm"
                })),
                idempotency_headers(&owner_session.token, "encryption-context-create"),
            )
            .await;
        assert_eq!(created.status, StatusCode::OK);
        let created_context: (i32, Option<i32>, Option<String>) = sqlx::query_as(
            "SELECT version, encryption_version, encrypted_by_user_id FROM item WHERE id = $1",
        )
        .bind(item_id)
        .fetch_one(&app.pool)
        .await
        .unwrap();
        assert_eq!(
            created_context,
            (1, Some(1), Some(fixture.owner_user_id.clone()))
        );

        let favorite = app
            .api_json(
                Method::PATCH,
                &format!("{item_uri}/favorite"),
                Some(json!({ "favorite": true })),
                idempotent_item_headers(&owner_session.token, 1, "encryption-context-favorite"),
            )
            .await;
        assert_applied(&favorite.body, "set_item_favorite", item_id, 2);
        let trashed = app
            .api_json(
                Method::DELETE,
                &item_uri,
                None,
                idempotent_item_headers(&member_session.token, 2, "encryption-context-trash"),
            )
            .await;
        assert_applied(&trashed.body, "trash_item", item_id, 3);
        let restored = app
            .api_json(
                Method::POST,
                &format!("{item_uri}/restore"),
                None,
                idempotent_item_headers(&member_session.token, 3, "encryption-context-restore"),
            )
            .await;
        assert_applied(&restored.body, "restore_item", item_id, 4);
        let after_metadata: (i32, Option<i32>, Option<String>, Option<String>) =
            sqlx::query_as(
                "SELECT version, encryption_version, encrypted_by_user_id, last_modified_by FROM item WHERE id = $1",
            )
            .bind(item_id)
            .fetch_one(&app.pool)
            .await
            .unwrap();
        assert_eq!(after_metadata.0, 4);
        assert_eq!(after_metadata.1, Some(1));
        assert_eq!(after_metadata.2, Some(fixture.owner_user_id));
        assert_eq!(after_metadata.3, Some(fixture.member_user_id.clone()));

        let updated = app
            .api_json(
                Method::PATCH,
                &item_uri,
                Some(json!({
                    "encryptedData": "member-ciphertext",
                    "encryptionIv": "member-iv"
                })),
                idempotent_item_headers(&member_session.token, 4, "encryption-context-update"),
            )
            .await;
        assert_applied(&updated.body, "update_item", item_id, 5);
        let after_content: (i32, Option<i32>, Option<String>) = sqlx::query_as(
            "SELECT version, encryption_version, encrypted_by_user_id FROM item WHERE id = $1",
        )
        .bind(item_id)
        .fetch_one(&app.pool)
        .await
        .unwrap();
        assert_eq!(
            after_content,
            (5, Some(5), Some(fixture.member_user_id))
        );
    })
    .await;
}

#[tokio::test]
async fn move_item_requires_source_vault_write_access() {
    with_api_test_app(
        "move_item_requires_source_vault_write_access",
        |app| async move {
            let fixture = build_vault_router_fixture(&app.pool).await;
            seed_vault_key(
                &app.pool,
                "vault_key_target_readonly_source",
                &fixture.target_vault_id,
                &fixture.readonly_user_id,
                "target-member-key",
                "member",
            )
            .await;
            let readonly_session = app.issue_session(&fixture.readonly_user_id).await;

            let response = app
                .api_json(Method::POST, &format!("/api/v1/items/{}/moves", fixture.movable_item_id), Some(json!({ "mode": "prepared", "sourceVaultId": fixture.main_vault_id, "targetVaultId": fixture.target_vault_id, "encryptedData": "moved-encrypted-data", "encryptionIv": "moved-iv", "encryptionAlgorithm": "aes-gcm" })), idempotent_item_headers(&readonly_session.token, 1, "move-readonly-source"))
                .await;

            response.assert_contract_status();
            assert_rejected(&response.body, "move_item", "vault_read_only");
            let vault_id: String = query_scalar("SELECT vault_id FROM item WHERE id = $1")
                .bind(&fixture.movable_item_id)
                .fetch_one(&app.pool)
                .await
                .expect("item vault should load");
            assert_eq!(vault_id, fixture.main_vault_id);
        },
    )
    .await;
}

#[tokio::test]
async fn queued_item_create_replays_a_lost_success_without_duplicate_side_effects() {
    with_api_test_app("queued_item_create_replay", |app| async move {
        let fixture = build_vault_router_fixture(&app.pool).await;
        let session = app.issue_session(&fixture.owner_user_id).await;
        let item_id = "item_queued_create_replay";
        let uri = format!(
            "/api/v1/vaults/{}/items/{item_id}",
            fixture.main_vault_id
        );
        let body = json!({
            "category": "login",
            "encryptedData": "queued-create-ciphertext",
            "encryptionIv": "queued-create-iv",
            "encryptionAlgorithm": "aes-gcm"
        });
		let (mut sync_notifications, _control_notifications) = app
			.state
			.sync_pubsub
			.subscribe(&fixture.owner_user_id)
			.await;

        let first = app
            .api_json(
                Method::PUT,
                &uri,
                Some(body.clone()),
                idempotency_headers(&session.token, "queued-create-key"),
            )
            .await;
		tokio::time::timeout(
			std::time::Duration::from_secs(1),
			sync_notifications.recv(),
		)
		.await
		.expect("a newly committed outcome should wake Sync")
		.expect("Sync notification channel should stay open");
        let replay = app
            .api_json(
                Method::PUT,
                &uri,
                Some(body),
                idempotency_headers(&session.token, "queued-create-key"),
            )
            .await;
		assert!(
			tokio::time::timeout(
				std::time::Duration::from_millis(50),
				sync_notifications.recv(),
			)
			.await
			.is_err(),
			"a retained replay must not emit another Sync wake",
		);

        assert_eq!(first.status, StatusCode::OK, "{}", first.body);
        assert_eq!(replay.status, first.status);
        assert_eq!(replay.body, first.body);
        assert_eq!(
            first.body,
            json!({
                "operationId": "queued-create-key",
                "kind": "create_item",
                "result": {
                    "status": "applied",
                    "itemId": item_id,
                    "version": 1
                }
            })
        );
        let lookup = app
            .api_json(
                Method::GET,
                "/api/v1/operations/queued-create-key",
                None,
                authenticated_json_headers(&session.token),
            )
            .await;
        assert_eq!(lookup.status, StatusCode::OK);
        assert_eq!(lookup.body, first.body);
        query("UPDATE operation_outcome SET resolved_at = NOW() - INTERVAL '10 years' WHERE user_id = $1 AND operation_id = $2")
            .bind(&fixture.owner_user_id)
            .bind("queued-create-key")
            .execute(&app.pool)
            .await
            .expect("outcome age should be adjustable for retention test");
        let renewed_session = app.issue_session(&fixture.owner_user_id).await;
        let retained = app
            .api_json(
                Method::GET,
                "/api/v1/operations/queued-create-key",
                None,
                authenticated_json_headers(&renewed_session.token),
            )
            .await;
        assert_eq!(retained.status, StatusCode::OK);
        assert_eq!(retained.body, first.body);
        let outsider_session = app.issue_session(&fixture.outsider_user_id).await;
        let isolated = app
            .api_json(
                Method::GET,
                "/api/v1/operations/queued-create-key",
                None,
                authenticated_json_headers(&outsider_session.token),
            )
            .await;
        assert_eq!(isolated.status, StatusCode::NOT_FOUND);
        assert_eq!(isolated.body["code"], "OPERATION_OUTCOME_NOT_FOUND");
        let changes = app
            .api_json(
                Method::GET,
                "/api/v1/sync/changes",
                None,
                authenticated_json_headers(&renewed_session.token),
            )
            .await;
        changes.assert_contract_status();
        assert!(changes.body["events"]
            .as_array()
            .expect("changes events should be an array")
            .iter()
            .any(|event| {
                event["type"] == "operation_resolved"
                    && event["entityId"] == "queued-create-key"
            }));
        let bootstrap = app
            .api_json(
                Method::GET,
                "/api/v1/sync/bootstrap",
                None,
                authenticated_json_headers(&renewed_session.token),
            )
            .await;
        bootstrap.assert_contract_status();
        assert!(!bootstrap.body.to_string().contains("queued-create-key"));
        let item_count: i64 = query_scalar("SELECT COUNT(*)::bigint FROM item WHERE id = $1")
            .bind(item_id)
            .fetch_one(&app.pool)
            .await
            .expect("created item count should load");
        let event_count: i64 = query_scalar(
            "SELECT COUNT(*)::bigint FROM sync_event WHERE entity_id = $1 AND event_type = 'item_created'::sync_event_type",
        )
        .bind(item_id)
        .fetch_one(&app.pool)
        .await
        .expect("created event count should load");
        let outcome_count: i64 = query_scalar(
            "SELECT COUNT(*)::bigint FROM operation_outcome WHERE user_id = $1 AND operation_id = $2",
        )
        .bind(&fixture.owner_user_id)
        .bind("queued-create-key")
        .fetch_one(&app.pool)
        .await
        .expect("operation outcome count should load");
        let operation_event_count: i64 = query_scalar(
            "SELECT COUNT(*)::bigint FROM sync_event WHERE user_id = $1 AND entity_id = $2 AND event_type = 'operation_resolved'::sync_event_type",
        )
        .bind(&fixture.owner_user_id)
        .bind("queued-create-key")
        .fetch_one(&app.pool)
        .await
        .expect("operation event count should load");
        assert_eq!(item_count, 1);
        assert_eq!(event_count, 1);
        assert_eq!(outcome_count, 1);
        assert_eq!(operation_event_count, 1);
    })
    .await;
}

#[tokio::test]
async fn create_item_retains_a_semantic_rejection_even_after_authorization_changes() {
    with_api_test_app("create_item_retained_rejection", |app| async move {
        let fixture = build_vault_router_fixture(&app.pool).await;
        let session = app.issue_session(&fixture.readonly_user_id).await;
        let item_id = "item_retained_rejection";
        let uri = format!("/api/v1/vaults/{}/items/{item_id}", fixture.main_vault_id);
        let body = json!({
            "category": "login",
            "encryptedData": "rejected-ciphertext",
            "encryptionIv": "rejected-iv",
            "encryptionAlgorithm": "aes-gcm"
        });

        let first = app
            .api_json(
                Method::PUT,
                &uri,
                Some(body.clone()),
                idempotency_headers(&session.token, "retained-rejection-key"),
            )
            .await;
        assert_eq!(first.status, StatusCode::OK);
        assert_eq!(first.body["result"]["status"], "rejected");
        assert_eq!(first.body["result"]["code"], "vault_read_only");

        query("UPDATE vault_key SET role = 'member' WHERE vault_id = $1 AND user_id = $2")
            .bind(&fixture.main_vault_id)
            .bind(&fixture.readonly_user_id)
            .execute(&app.pool)
            .await
            .expect("test authorization should change");
        let replay = app
            .api_json(
                Method::PUT,
                &uri,
                Some(body),
                idempotency_headers(&session.token, "retained-rejection-key"),
            )
            .await;
        assert_eq!(replay.status, StatusCode::OK);
        assert_eq!(replay.body, first.body);

        let item_count: i64 = query_scalar("SELECT COUNT(*)::bigint FROM item WHERE id = $1")
            .bind(item_id)
            .fetch_one(&app.pool)
            .await
            .expect("rejected item count should load");
        let rejection_audits: i64 = query_scalar(
            "SELECT COUNT(*)::bigint FROM audit_log WHERE user_id = $1 AND entity_id = $2 AND action = 'item_create_rejected'",
        )
        .bind(&fixture.readonly_user_id)
        .bind(item_id)
        .fetch_one(&app.pool)
        .await
        .expect("rejection audit count should load");
        let operation_events: i64 = query_scalar(
            "SELECT COUNT(*)::bigint FROM sync_event WHERE user_id = $1 AND entity_id = $2 AND event_type = 'operation_resolved'::sync_event_type",
        )
        .bind(&fixture.readonly_user_id)
        .bind("retained-rejection-key")
        .fetch_one(&app.pool)
        .await
        .expect("rejection Operation event count should load");
        assert_eq!(item_count, 0);
        assert_eq!(rejection_audits, 1);
        assert_eq!(operation_events, 1);
    })
    .await;
}

#[tokio::test]
async fn create_item_requires_an_operation_id_before_semantic_execution() {
    with_api_test_app("create_item_requires_operation_id", |app| async move {
        let fixture = build_vault_router_fixture(&app.pool).await;
        let session = app.issue_session(&fixture.owner_user_id).await;
        let item_id = "item_without_operation_id";
        let response = app
            .api_json(
                Method::PUT,
                &format!("/api/v1/vaults/{}/items/{item_id}", fixture.main_vault_id),
                Some(json!({
                    "category": "login",
                    "encryptedData": "ciphertext",
                    "encryptionIv": "iv",
                    "encryptionAlgorithm": "aes-gcm"
                })),
                authenticated_json_headers(&session.token),
            )
            .await;
        assert_eq!(response.status, StatusCode::BAD_REQUEST);
        assert_eq!(response.body["code"], "INVALID_OPERATION_ID");
        let item_count: i64 = query_scalar("SELECT COUNT(*)::bigint FROM item WHERE id = $1")
            .bind(item_id)
            .fetch_one(&app.pool)
            .await
            .expect("Item count should load");
        assert_eq!(item_count, 0);
    })
    .await;
}

#[tokio::test]
async fn deleting_a_user_cascades_retained_operation_outcomes() {
    with_api_test_app("operation_outcome_user_cascade", |app| async move {
        let user_id = "operation_outcome_cascade_user";
        seed_user(
            &app.pool,
            user_id,
            "Outcome Cascade",
            "operation-outcome-cascade@example.com",
        )
        .await;
        query(
            "INSERT INTO operation_outcome (user_id, operation_id, operation_kind, request_fingerprint, result_status, rejection_code) VALUES ($1, 'cascade-operation', 'create_item', $2, 'rejected', 'vault_access_denied')",
        )
        .bind(user_id)
        .bind(vec![7_u8; 32])
        .execute(&app.pool)
        .await
        .expect("outcome fixture should insert");
        query("DELETE FROM \"user\" WHERE id = $1")
            .bind(user_id)
            .execute(&app.pool)
            .await
            .expect("standalone User should delete");
        let count: i64 = query_scalar(
            "SELECT COUNT(*)::bigint FROM operation_outcome WHERE user_id = $1",
        )
        .bind(user_id)
        .fetch_one(&app.pool)
        .await
        .expect("outcome count should load");
        assert_eq!(count, 0);
    })
    .await;
}

#[tokio::test]
async fn concurrent_queued_item_create_executes_once_and_then_replays() {
    with_api_test_app("concurrent_queued_item_create", |app| async move {
        let fixture = build_vault_router_fixture(&app.pool).await;
        let session = app.issue_session(&fixture.owner_user_id).await;
        let item_id = "item_concurrent_queued_create";
        let uri = format!(
            "/api/v1/vaults/{}/items/{item_id}",
            fixture.main_vault_id
        );
        let body = json!({
            "category": "login",
            "encryptedData": "concurrent-create",
            "encryptionIv": "concurrent-iv",
            "encryptionAlgorithm": "aes-gcm"
        });
        let first = app.api_json(
            Method::PUT,
            &uri,
            Some(body.clone()),
            idempotency_headers(&session.token, "concurrent-create-key"),
        );
        let second = app.api_json(
            Method::PUT,
            &uri,
            Some(body.clone()),
            idempotency_headers(&session.token, "concurrent-create-key"),
        );
        let (first, second) = tokio::join!(first, second);
        assert_eq!(first.status, StatusCode::OK);
        assert_eq!(second.status, StatusCode::OK);
        assert_eq!(first.body, second.body);

        let replay = app
            .api_json(
                Method::PUT,
                &uri,
                Some(body),
                idempotency_headers(&session.token, "concurrent-create-key"),
            )
            .await;
        assert_eq!(replay.status, StatusCode::OK);
        assert_eq!(replay.body, first.body);
        let item_count: i64 = query_scalar("SELECT COUNT(*)::bigint FROM item WHERE id = $1")
            .bind(item_id)
            .fetch_one(&app.pool)
            .await
            .expect("created item count should load");
        let event_count: i64 = query_scalar(
            "SELECT COUNT(*)::bigint FROM sync_event WHERE entity_id = $1 AND event_type = 'item_created'::sync_event_type",
        )
        .bind(item_id)
        .fetch_one(&app.pool)
        .await
        .expect("created event count should load");
        assert_eq!(item_count, 1);
        assert_eq!(event_count, 1);
    })
    .await;
}

#[tokio::test]
async fn different_operations_racing_for_one_item_retain_applied_and_rejected_outcomes() {
    with_api_test_app("different_create_operations_race", |app| async move {
        let fixture = build_vault_router_fixture(&app.pool).await;
        let session = app.issue_session(&fixture.owner_user_id).await;
        let item_id = "item_different_operation_race";
        let uri = format!("/api/v1/vaults/{}/items/{item_id}", fixture.main_vault_id);
        let body = json!({
            "category": "login",
            "encryptedData": "race-ciphertext",
            "encryptionIv": "race-iv",
            "encryptionAlgorithm": "aes-gcm"
        });
        let first = app.api_json(
            Method::PUT,
            &uri,
            Some(body.clone()),
            idempotency_headers(&session.token, "race-operation-a"),
        );
        let second = app.api_json(
            Method::PUT,
            &uri,
            Some(body),
            idempotency_headers(&session.token, "race-operation-b"),
        );
        let (first, second) = tokio::join!(first, second);
        assert_eq!(first.status, StatusCode::OK);
        assert_eq!(second.status, StatusCode::OK);
        let statuses = [
            first.body["result"]["status"].as_str().unwrap(),
            second.body["result"]["status"].as_str().unwrap(),
        ];
        assert!(statuses.contains(&"applied"));
        assert!(statuses.contains(&"rejected"));
        let rejected = if first.body["result"]["status"] == "rejected" {
            &first.body
        } else {
            &second.body
        };
        assert_eq!(rejected["result"]["code"], "item_id_conflict");

        let outcome_count: i64 = query_scalar(
            "SELECT COUNT(*)::bigint FROM operation_outcome WHERE user_id = $1 AND operation_id = ANY($2)",
        )
        .bind(&fixture.owner_user_id)
        .bind(vec!["race-operation-a", "race-operation-b"])
        .fetch_one(&app.pool)
        .await
        .expect("racing outcomes should load");
        let item_count: i64 = query_scalar("SELECT COUNT(*)::bigint FROM item WHERE id = $1")
            .bind(item_id)
            .fetch_one(&app.pool)
            .await
            .expect("racing Item count should load");
        assert_eq!(outcome_count, 2);
        assert_eq!(item_count, 1);
    })
    .await;
}

#[tokio::test]
async fn stale_idempotency_claims_fail_closed_and_completed_records_are_cleaned() {
    use crate::shared::idempotency::{claim, Claim, RequestScope};

    with_api_test_app("idempotency_claim_lifecycle", |app| async move {
        let fingerprint = [7_u8; 32];
        let scope = RequestScope {
            principal_id: "user_idempotency_lifecycle",
            method: "DELETE",
            route_target: "/api/v1/items/item_stale",
            key: "stale-key",
        };
        assert!(matches!(
            claim(&app.pool, &scope, &fingerprint).await.unwrap(),
            Claim::Execute
        ));
        query(
            "UPDATE idempotency_record SET claim_expires_at = NOW() - INTERVAL '1 second' WHERE idempotency_key = $1",
        )
        .bind(scope.key)
        .execute(&app.pool)
        .await
        .expect("claim should become stale");
        assert!(matches!(
            claim(&app.pool, &scope, &fingerprint).await.unwrap(),
            Claim::Indeterminate
        ));
        assert!(matches!(
            claim(&app.pool, &scope, &fingerprint).await.unwrap(),
            Claim::Indeterminate
        ));

        query(
            "INSERT INTO idempotency_record (principal_id, method, route_target, idempotency_key, request_fingerprint, state, response_status, response_content_type, response_body, expires_at) VALUES ($1, 'PATCH', '/api/v1/items/expired', 'expired-key', $2, 'completed', 200, 'application/json', $3, NOW() - INTERVAL '1 second')",
        )
        .bind(scope.principal_id)
        .bind(fingerprint.as_slice())
        .bind(b"{}".as_slice())
        .execute(&app.pool)
        .await
        .expect("expired completed record should insert");
        let maintenance_scope = RequestScope {
            principal_id: scope.principal_id,
            method: "POST",
            route_target: "/api/v1/items/maintenance",
            key: "maintenance-key",
        };
        assert!(matches!(
            claim(&app.pool, &maintenance_scope, &[8_u8; 32])
                .await
                .unwrap(),
            Claim::Execute
        ));
        let expired_count: i64 = query_scalar(
            "SELECT COUNT(*)::bigint FROM idempotency_record WHERE idempotency_key = 'expired-key'",
        )
        .fetch_one(&app.pool)
        .await
        .expect("expired record count should load");
        let stale_state: String = query_scalar(
            "SELECT state FROM idempotency_record WHERE idempotency_key = 'stale-key'",
        )
        .fetch_one(&app.pool)
        .await
        .expect("stale record should remain terminal");
        assert_eq!(expired_count, 0);
        assert_eq!(stale_state, "indeterminate");
    })
    .await;
}

#[tokio::test]
async fn vault_item_mutation_handlers_reject_invalid_state_and_access() {
    with_api_test_app(
        "vault_item_mutation_handlers_reject_invalid_state_and_access",
        |app| async move {
            let fixture = build_vault_router_fixture(&app.pool).await;
            let owner_session = app.issue_session(&fixture.owner_user_id).await;
            let readonly_session = app.issue_session(&fixture.readonly_user_id).await;
            let owner_headers = authenticated_json_headers(&owner_session.token);

            let readonly_create_response = app
                .api_json(Method::PUT, &format!("/api/v1/vaults/{}/items/{}", fixture.main_vault_id, "item_explicit_request"), Some(json!({ "category": "login", "encryptedData": "enc", "encryptionIv": "iv", "encryptionAlgorithm": "aes-gcm" })), idempotency_headers(&readonly_session.token, "readonly-create-item"))
                .await;
            readonly_create_response.assert_contract_status();
            assert_rejected(
                &readonly_create_response.body,
                "create_item",
                "vault_read_only",
            );

            let readonly_update_response = app
                .api_json(Method::PATCH, &format!("/api/v1/items/{}", fixture.active_item_id), Some(json!({ "encryptedData": "enc" })), idempotent_item_headers(&readonly_session.token, 1, "readonly-update-item"))
                .await;
            readonly_update_response.assert_contract_status();
            assert_rejected(
                &readonly_update_response.body,
                "update_item",
                "vault_read_only",
            );

            let duplicate_import_response = app
                .api_json(Method::POST, &format!("/api/v1/vaults/{}/item-imports", fixture.owner_personal_vault_id), Some(json!({ "items": [
                            {
                                "itemId": "duplicate_item",
                                "category": "login",
                                "encryptedData": "duplicate-a",
                                "encryptionIv": "duplicate-a-iv",
                                "encryptionAlgorithm": "aes-gcm"
                            },
                            {
                                "itemId": "duplicate_item",
                                "category": "login",
                                "encryptedData": "duplicate-b",
                                "encryptionIv": "duplicate-b-iv",
                                "encryptionAlgorithm": "aes-gcm"
                            }
                        ] })), owner_headers.clone())
                .await;
            duplicate_import_response.assert_contract_status();
            assert_handler_error(
                &duplicate_import_response.body,
                "BAD_REQUEST",
                "Duplicate item IDs in import payload",
            );

            let stale_update_response = app
                .api_json(Method::PATCH, &format!("/api/v1/items/{}", fixture.active_item_id), Some(json!({ "encryptedData": "stale-update" })), idempotent_item_headers(&owner_session.token, 99, "stale-update-item"))
                .await;
            stale_update_response.assert_contract_status();
            assert_rejected(
                &stale_update_response.body,
                "update_item",
                "item_version_conflict",
            );

            let restore_active_response = app
                .api_json(Method::POST, &format!("/api/v1/items/{}/restore", fixture.active_item_id), None, idempotent_item_headers(&owner_session.token, 1, "restore-active-item"))
                .await;
            restore_active_response.assert_contract_status();
            assert_rejected(
                &restore_active_response.body,
                "restore_item",
                "item_not_trashed",
            );

            let wrong_source_response = app
                .api_json(Method::POST, &format!("/api/v1/items/{}/moves", fixture.movable_item_id), Some(json!({ "mode": "prepared", "sourceVaultId": fixture.target_vault_id, "targetVaultId": fixture.main_vault_id, "encryptedData": "enc", "encryptionIv": "iv", "encryptionAlgorithm": "aes-gcm" })), idempotent_item_headers(&owner_session.token, 1, "move-wrong-source"))
                .await;
            wrong_source_response.assert_contract_status();
            assert_rejected(
                &wrong_source_response.body,
                "move_item",
                "source_vault_mismatch",
            );

            let permanent_delete_active_response = app
                .api_json(Method::DELETE, &format!("/api/v1/items/{}/permanent", fixture.active_item_id), None, idempotent_item_headers(&owner_session.token, 1, "permanent-delete-active-item"))
                .await;
            permanent_delete_active_response.assert_contract_status();
            assert_rejected(
                &permanent_delete_active_response.body,
                "permanently_delete_item",
                "item_not_trashed",
            );

            // Every one of those rejections is retained, and none of them wrote.
            let unchanged: (String, i32, Option<OffsetDateTime>) = sqlx::query_as(
                "SELECT encrypted_data, version, deleted_at FROM item WHERE id = $1",
            )
            .bind(&fixture.active_item_id)
            .fetch_one(&app.pool)
            .await
            .unwrap();
            assert_eq!(unchanged, ("active-encrypted-data".to_string(), 1, None));
            let retained: i64 = query_scalar(
                "SELECT COUNT(*)::bigint FROM operation_outcome WHERE result_status = 'rejected'::operation_outcome_status AND operation_id = ANY($1)",
            )
            .bind(vec![
                "readonly-create-item",
                "readonly-update-item",
                "stale-update-item",
                "restore-active-item",
                "move-wrong-source",
                "permanent-delete-active-item",
            ])
            .fetch_one(&app.pool)
            .await
            .expect("retained rejection count should load");
            assert_eq!(retained, 6);
        },
    )
    .await;
}

/// One Item Operation, described once so every contract test can drive all six routes.
struct ItemOperationCase {
    kind: &'static str,
    method: Method,
    path: String,
    body: Option<Value>,
    /// The same Operation with one byte or one precondition changed. Sending it under the first
    /// Operation ID is identity reuse, and the Server must refuse rather than answer.
    other_bytes: Option<Value>,
    other_precondition: i32,
    item_id: String,
    expected_version: i32,
    applied_version: i32,
    event_type: &'static str,
    /// The audit action an applied Operation writes, where the Domain writes one.
    applied_audit: Option<&'static str>,
}

/// Seeds one Item per case so the six Operations never contend for the same row.
async fn item_operation_cases(
    pool: &PgPool,
    fixture: &VaultRouterFixture,
) -> Vec<ItemOperationCase> {
    for (item_id, trashed) in [
        ("case_update_item", false),
        ("case_favorite_item", false),
        ("case_trash_item", false),
        ("case_restore_item", true),
        ("case_move_item", false),
        ("case_permanent_item", true),
    ] {
        seed_item(
            pool,
            item_id,
            &fixture.main_vault_id,
            "login",
            "case-ciphertext",
            "case-iv",
            &fixture.owner_user_id,
        )
        .await;
        if trashed {
            query("UPDATE item SET deleted_at = NOW() WHERE id = $1")
                .bind(item_id)
                .execute(pool)
                .await
                .expect("case item should trash");
        }
    }
    let move_body = |ciphertext: &str| {
        json!({
            "mode": "prepared",
            "sourceVaultId": fixture.main_vault_id,
            "targetVaultId": fixture.target_vault_id,
            "encryptedData": ciphertext,
            "encryptionIv": "case-iv",
            "encryptionAlgorithm": "aes-gcm"
        })
    };
    vec![
        ItemOperationCase {
            kind: "update_item",
            method: Method::PATCH,
            path: "/api/v1/items/case_update_item".into(),
            body: Some(json!({ "encryptedData": "case-updated", "encryptionIv": "case-iv" })),
            other_bytes: Some(json!({ "encryptedData": "case-other", "encryptionIv": "case-iv" })),
            other_precondition: 2,
            item_id: "case_update_item".into(),
            expected_version: 1,
            applied_version: 2,
            event_type: "item_updated",
            applied_audit: None,
        },
        ItemOperationCase {
            kind: "set_item_favorite",
            method: Method::PATCH,
            path: "/api/v1/items/case_favorite_item/favorite".into(),
            body: Some(json!({ "favorite": true })),
            other_bytes: Some(json!({ "favorite": false })),
            other_precondition: 2,
            item_id: "case_favorite_item".into(),
            expected_version: 1,
            applied_version: 2,
            event_type: "item_updated",
            applied_audit: None,
        },
        ItemOperationCase {
            kind: "trash_item",
            method: Method::DELETE,
            path: "/api/v1/items/case_trash_item".into(),
            body: None,
            other_bytes: None,
            other_precondition: 2,
            item_id: "case_trash_item".into(),
            expected_version: 1,
            applied_version: 2,
            event_type: "item_deleted",
            applied_audit: Some("item_deleted"),
        },
        ItemOperationCase {
            kind: "restore_item",
            method: Method::POST,
            path: "/api/v1/items/case_restore_item/restore".into(),
            body: None,
            other_bytes: None,
            other_precondition: 2,
            item_id: "case_restore_item".into(),
            expected_version: 1,
            applied_version: 2,
            event_type: "item_restored",
            applied_audit: Some("item_restored"),
        },
        ItemOperationCase {
            kind: "move_item",
            method: Method::POST,
            path: "/api/v1/items/case_move_item/moves".into(),
            body: Some(move_body("case-moved")),
            other_bytes: Some(move_body("case-moved-differently")),
            other_precondition: 2,
            item_id: "case_move_item".into(),
            expected_version: 1,
            applied_version: 2,
            event_type: "item_moved",
            applied_audit: Some("item_moved"),
        },
        ItemOperationCase {
            kind: "permanently_delete_item",
            method: Method::DELETE,
            path: "/api/v1/items/case_permanent_item/permanent".into(),
            body: None,
            other_bytes: None,
            other_precondition: 2,
            item_id: "case_permanent_item".into(),
            expected_version: 1,
            applied_version: 2,
            event_type: "item_permanently_deleted",
            applied_audit: Some("item_permanently_deleted"),
        },
    ]
}

async fn entity_event_count(pool: &PgPool, entity_id: &str, event_type: &str) -> i64 {
    query_scalar(
        "SELECT COUNT(*)::bigint FROM sync_event WHERE entity_id = $1 AND event_type::text = $2",
    )
    .bind(entity_id)
    .bind(event_type)
    .fetch_one(pool)
    .await
    .expect("entity event count should load")
}

async fn retained_outcome_count(pool: &PgPool, user_id: &str, operation_id: &str) -> i64 {
    query_scalar(
        "SELECT COUNT(*)::bigint FROM operation_outcome WHERE user_id = $1 AND operation_id = $2",
    )
    .bind(user_id)
    .bind(operation_id)
    .fetch_one(pool)
    .await
    .expect("retained outcome count should load")
}

#[tokio::test]
async fn create_share_outcome_schema_keeps_payload_and_rejection_sets_closed() {
    with_api_test_app("create_share_outcome_schema", |app| async move {
        let user_id = "share_outcome_schema_user";
        seed_user(
            &app.pool,
            user_id,
            "Share Outcome Schema User",
            "share-outcome-schema@example.com",
        )
        .await;

        let missing_payload = query(
            "INSERT INTO operation_outcome (user_id, operation_id, operation_kind, request_fingerprint, result_status, applied_payload) VALUES ($1, 'missing-share-payload', 'create_share', $2, 'applied', NULL)",
        )
        .bind(user_id)
        .bind(vec![0_u8; 32])
        .execute(&app.pool)
        .await;
        assert!(missing_payload.is_err());

        for (index, payload) in [
            Value::Null,
            json!({
                "shareLinkId": "share_link_1",
                "baseShareUrl": "https://app.example/share/"
            }),
            json!({
                "shareLinkId": "share_link_1",
                "baseShareUrl": "https://app.example/share/",
                "expiresAt": "2026-08-27T00:00:00Z",
                "token": "must-never-be-retained"
            }),
            json!({
                "shareLinkId": 1,
                "baseShareUrl": "https://app.example/share/",
                "expiresAt": "2026-08-27T00:00:00Z"
            }),
        ]
        .into_iter()
        .enumerate()
        {
            let result = query(
                "INSERT INTO operation_outcome (user_id, operation_id, operation_kind, request_fingerprint, result_status, applied_payload) VALUES ($1, $2, 'create_share', $3, 'applied', $4)",
            )
            .bind(user_id)
            .bind(format!("invalid-share-payload-{index}"))
            .bind(vec![index as u8; 32])
            .bind(payload)
            .execute(&app.pool)
            .await;
            assert!(result.is_err(), "invalid applied payload {index} was retained");
        }

        for (index, code) in [
            "item_not_found",
            "vault_read_only",
            "share_entitlement_denied",
            "share_limit_reached",
        ]
        .into_iter()
        .enumerate()
        {
            query(
                "INSERT INTO operation_outcome (user_id, operation_id, operation_kind, request_fingerprint, result_status, rejection_code) VALUES ($1, $2, 'create_share', $3, 'rejected', $4::operation_rejection_code)",
            )
            .bind(user_id)
            .bind(format!("valid-share-rejection-{index}"))
            .bind(vec![index as u8; 32])
            .bind(code)
            .execute(&app.pool)
            .await
            .expect("each decided Share rejection should be retained");
        }

        let foreign_share_rejection = query(
            "INSERT INTO operation_outcome (user_id, operation_id, operation_kind, request_fingerprint, result_status, rejection_code) VALUES ($1, 'foreign-share-rejection', 'create_share', $2, 'rejected', 'item_version_conflict')",
        )
        .bind(user_id)
        .bind(vec![8_u8; 32])
        .execute(&app.pool)
        .await;
        assert!(foreign_share_rejection.is_err());

        let share_only_item_rejection = query(
            "INSERT INTO operation_outcome (user_id, operation_id, operation_kind, request_fingerprint, result_status, rejection_code) VALUES ($1, 'share-only-item-rejection', 'update_item', $2, 'rejected', 'share_limit_reached')",
        )
        .bind(user_id)
        .bind(vec![9_u8; 32])
        .execute(&app.pool)
        .await;
        assert!(share_only_item_rejection.is_err());
    })
    .await;
}

#[tokio::test]
async fn operation_lookup_reads_preseeded_applied_and_rejected_share_outcomes() {
    with_api_test_app("create_share_outcome_lookup", |app| async move {
        let user_id = "share_outcome_lookup_user";
        seed_user(
            &app.pool,
            user_id,
            "Share Outcome Lookup User",
            "share-outcome-lookup@example.com",
        )
        .await;
        query(
            "INSERT INTO operation_outcome (user_id, operation_id, operation_kind, request_fingerprint, result_status, applied_payload) VALUES ($1, 'share-applied', 'create_share', $2, 'applied', $3)",
        )
        .bind(user_id)
        .bind(vec![1_u8; 32])
        .bind(json!({
            "shareLinkId": "share_link_1",
            "baseShareUrl": "https://app.example/share/",
            "expiresAt": "2026-08-27T00:00:00Z"
        }))
        .execute(&app.pool)
        .await
        .expect("applied Share outcome should seed");
        query(
            "INSERT INTO operation_outcome (user_id, operation_id, operation_kind, request_fingerprint, result_status, rejection_code) VALUES ($1, 'share-rejected', 'create_share', $2, 'rejected', 'share_limit_reached')",
        )
        .bind(user_id)
        .bind(vec![2_u8; 32])
        .execute(&app.pool)
        .await
        .expect("rejected Share outcome should seed");
        let session = app.issue_session(user_id).await;

        let applied = app
            .api_json(
                Method::GET,
                "/api/v1/operations/share-applied",
                None,
                authenticated_json_headers(&session.token),
            )
            .await;
        applied.assert_contract_status();
        assert_eq!(
            applied.body,
            json!({
                "kind": "create_share",
                "operationId": "share-applied",
                "result": {
                    "status": "applied",
                    "shareLinkId": "share_link_1",
                    "baseShareUrl": "https://app.example/share/",
                    "expiresAt": "2026-08-27T00:00:00Z"
                }
            })
        );

        let rejected = app
            .api_json(
                Method::GET,
                "/api/v1/operations/share-rejected",
                None,
                authenticated_json_headers(&session.token),
            )
            .await;
        rejected.assert_contract_status();
        assert_eq!(
            rejected.body,
            json!({
                "kind": "create_share",
                "operationId": "share-rejected",
                "result": { "status": "rejected", "code": "share_limit_reached" }
            })
        );
    })
    .await;
}

/// An identical retry answers the retained outcome, and a lost response is recoverable by lookup.
#[tokio::test]
async fn every_item_operation_replays_one_retained_outcome() {
    with_api_test_app("item_operation_replay", |app| async move {
        let fixture = build_vault_router_fixture(&app.pool).await;
        let cases = item_operation_cases(&app.pool, &fixture).await;
        let session = app.issue_session(&fixture.owner_user_id).await;
        let outsider = app.issue_session(&fixture.outsider_user_id).await;

        for case in cases {
            let operation_id = format!("replay-{}", case.kind);
            let headers =
                || idempotent_item_headers(&session.token, case.expected_version, &operation_id);
            let first = app
                .api_json(
                    case.method.clone(),
                    &case.path,
                    case.body.clone(),
                    headers(),
                )
                .await;
            first.assert_contract_status();
            assert_applied(&first.body, case.kind, &case.item_id, case.applied_version);

            let replay = app
                .api_json(
                    case.method.clone(),
                    &case.path,
                    case.body.clone(),
                    headers(),
                )
                .await;
            assert_eq!(replay.status, first.status);
            assert_eq!(replay.body, first.body, "{} must replay", case.kind);

            // The response the client lost is recoverable without replaying the effect, and a
            // renewed Session reads the same answer because identity is `(User, Operation ID)`.
            let renewed = app.issue_session(&fixture.owner_user_id).await;
            let lookup = app
                .api_json(
                    Method::GET,
                    &format!("/api/v1/operations/{operation_id}"),
                    None,
                    authenticated_json_headers(&renewed.token),
                )
                .await;
            lookup.assert_contract_status();
            assert_eq!(lookup.body, first.body);

            let isolated = app
                .api_json(
                    Method::GET,
                    &format!("/api/v1/operations/{operation_id}"),
                    None,
                    authenticated_json_headers(&outsider.token),
                )
                .await;
            assert_eq!(isolated.status, StatusCode::NOT_FOUND);
            assert_eq!(isolated.body["code"], json!("OPERATION_OUTCOME_NOT_FOUND"));

            assert_eq!(
                entity_event_count(&app.pool, &case.item_id, case.event_type).await,
                1,
                "{} must emit exactly one entity event",
                case.kind
            );
            assert_eq!(
                entity_event_count(&app.pool, &operation_id, "operation_resolved").await,
                1,
                "{} must resolve exactly once",
                case.kind
            );
            if let Some(action) = case.applied_audit {
                let audits: i64 = query_scalar(
                    "SELECT COUNT(*)::bigint FROM audit_log WHERE entity_id = $1 AND action = $2",
                )
                .bind(&case.item_id)
                .bind(action)
                .fetch_one(&app.pool)
                .await
                .expect("audit count should load");
                assert_eq!(audits, 1, "{} must audit exactly once", case.kind);
            }
        }
    })
    .await;
}

/// The same Operation ID with other immutable bytes is identity reuse, never a second answer.
#[tokio::test]
async fn every_item_operation_refuses_a_reused_id_with_other_bytes() {
    with_api_test_app("item_operation_id_reuse", |app| async move {
        let fixture = build_vault_router_fixture(&app.pool).await;
        let cases = item_operation_cases(&app.pool, &fixture).await;
        let session = app.issue_session(&fixture.owner_user_id).await;

        for case in cases {
            let operation_id = format!("reuse-{}", case.kind);
            let first = app
                .api_json(
                    case.method.clone(),
                    &case.path,
                    case.body.clone(),
                    idempotent_item_headers(&session.token, case.expected_version, &operation_id),
                )
                .await;
            assert_applied(&first.body, case.kind, &case.item_id, case.applied_version);

            // Body routes change one byte; the bodyless routes change the normalized precondition.
            let (changed_body, changed_version) = match case.other_bytes.clone() {
                Some(body) => (Some(body), case.expected_version),
                None => (case.body.clone(), case.other_precondition),
            };
            let reused = app
                .api_json(
                    case.method.clone(),
                    &case.path,
                    changed_body,
                    idempotent_item_headers(&session.token, changed_version, &operation_id),
                )
                .await;
            assert_eq!(
                reused.status,
                StatusCode::UNPROCESSABLE_ENTITY,
                "{} must refuse a reused Operation ID: {}",
                case.kind,
                reused.body
            );
            assert_eq!(reused.body["code"], json!("OPERATION_ID_REUSED"));

            let lookup = app
                .api_json(
                    Method::GET,
                    &format!("/api/v1/operations/{operation_id}"),
                    None,
                    authenticated_json_headers(&session.token),
                )
                .await;
            assert_eq!(
                lookup.body, first.body,
                "{} must leave the original outcome untouched",
                case.kind
            );
            assert_eq!(
                entity_event_count(&app.pool, &case.item_id, case.event_type).await,
                1
            );
        }
    })
    .await;
}

/// Two identical requests in flight at once resolve to one effect and one shared answer.
#[tokio::test]
async fn concurrent_duplicate_item_operations_execute_once() {
    with_api_test_app("item_operation_concurrency", |app| async move {
        let fixture = build_vault_router_fixture(&app.pool).await;
        let cases = item_operation_cases(&app.pool, &fixture).await;
        let session = app.issue_session(&fixture.owner_user_id).await;

        for case in cases {
            let operation_id = format!("concurrent-{}", case.kind);
            let headers =
                || idempotent_item_headers(&session.token, case.expected_version, &operation_id);
            let (first, second) = tokio::join!(
                app.api_json(
                    case.method.clone(),
                    &case.path,
                    case.body.clone(),
                    headers()
                ),
                app.api_json(
                    case.method.clone(),
                    &case.path,
                    case.body.clone(),
                    headers()
                ),
            );
            assert_eq!(first.status, StatusCode::OK, "{}", first.body);
            assert_eq!(second.status, StatusCode::OK, "{}", second.body);
            assert_eq!(first.body, second.body);
            assert_applied(&first.body, case.kind, &case.item_id, case.applied_version);
            assert_eq!(
                entity_event_count(&app.pool, &case.item_id, case.event_type).await,
                1,
                "{} must apply exactly once",
                case.kind
            );
            assert_eq!(
                retained_outcome_count(&app.pool, &fixture.owner_user_id, &operation_id).await,
                1
            );
        }
    })
    .await;
}

/// Malformed transport and failed authentication are refused before semantic execution, so they
/// retain nothing a later lookup could mistake for a decision.
#[tokio::test]
async fn item_operations_retain_nothing_for_malformed_or_unauthenticated_requests() {
    with_api_test_app("item_operation_no_retention", |app| async move {
        let fixture = build_vault_router_fixture(&app.pool).await;
        let cases = item_operation_cases(&app.pool, &fixture).await;
        let session = app.issue_session(&fixture.owner_user_id).await;

        for case in cases {
            let operation_id = format!("unretained-{}", case.kind);
            let without_operation_id = app
                .api_json(
                    case.method.clone(),
                    &case.path,
                    case.body.clone(),
                    with_if_match(
                        authenticated_json_headers(&session.token),
                        case.expected_version,
                    ),
                )
                .await;
            assert_eq!(without_operation_id.status, StatusCode::BAD_REQUEST);
            assert_eq!(
                without_operation_id.body["code"],
                json!("INVALID_OPERATION_ID")
            );

            let without_precondition = app
                .api_json(
                    case.method.clone(),
                    &case.path,
                    case.body.clone(),
                    idempotency_headers(&session.token, &operation_id),
                )
                .await;
            assert_eq!(
                without_precondition.status,
                StatusCode::PRECONDITION_REQUIRED
            );

            let mut unauthenticated = unauthenticated_json_headers();
            unauthenticated.insert(
                IF_MATCH,
                HeaderValue::from_str(&format!("\"{}\"", case.expected_version)).unwrap(),
            );
            unauthenticated.insert(
                "idempotency-key",
                HeaderValue::from_str(&operation_id).unwrap(),
            );
            let unauthorized = app
                .api_json(
                    case.method.clone(),
                    &case.path,
                    case.body.clone(),
                    unauthenticated,
                )
                .await;
            assert_eq!(unauthorized.status, StatusCode::UNAUTHORIZED);

            assert_eq!(
                retained_outcome_count(&app.pool, &fixture.owner_user_id, &operation_id).await,
                0,
                "{} must retain nothing for refused transport",
                case.kind
            );
            assert_eq!(
                entity_event_count(&app.pool, &case.item_id, case.event_type).await,
                0
            );
            let lookup = app
                .api_json(
                    Method::GET,
                    &format!("/api/v1/operations/{operation_id}"),
                    None,
                    authenticated_json_headers(&session.token),
                )
                .await;
            assert_eq!(lookup.status, StatusCode::NOT_FOUND);
        }
    })
    .await;
}

/// The effect, its audit, its entity Sync event, the retained outcome and `operation_resolved` all
/// commit together or not at all.
#[tokio::test]
async fn item_operations_roll_back_every_step_together() {
    for (kind, table, when_clause) in [
        ("update_item", "operation_outcome", ""),
        (
            "set_item_favorite",
            "sync_event",
            "WHEN (NEW.event_type = 'operation_resolved')",
        ),
        (
            "trash_item",
            "audit_log",
            "WHEN (NEW.action = 'item_deleted')",
        ),
        (
            "restore_item",
            "sync_event",
            "WHEN (NEW.event_type = 'item_restored')",
        ),
        ("move_item", "operation_outcome", ""),
        (
            "permanently_delete_item",
            "sync_event",
            "WHEN (NEW.event_type = 'operation_resolved')",
        ),
    ] {
        with_api_test_app(
            &format!("item_operation_atomicity_{kind}"),
            |app| async move {
                let fixture = build_vault_router_fixture(&app.pool).await;
                let cases = item_operation_cases(&app.pool, &fixture).await;
                let case = cases
                    .into_iter()
                    .find(|case| case.kind == kind)
                    .expect("every kind has a case");
                install_operation_step_failure_trigger(&app.pool, table, when_clause).await;
                let session = app.issue_session(&fixture.owner_user_id).await;
                let operation_id = format!("atomic-{kind}");

                let response = app
                    .api_json(
                        case.method.clone(),
                        &case.path,
                        case.body.clone(),
                        idempotent_item_headers(
                            &session.token,
                            case.expected_version,
                            &operation_id,
                        ),
                    )
                    .await;
                assert_eq!(response.status, StatusCode::INTERNAL_SERVER_ERROR);

                let version: Option<i32> = query_scalar("SELECT version FROM item WHERE id = $1")
                    .bind(&case.item_id)
                    .fetch_optional(&app.pool)
                    .await
                    .expect("case item version should load");
                assert_eq!(
                    version,
                    Some(case.expected_version),
                    "{kind} must leave the Item exactly where it was"
                );
                assert_eq!(
                    entity_event_count(&app.pool, &case.item_id, case.event_type).await,
                    0
                );
                assert_eq!(
                    entity_event_count(&app.pool, &operation_id, "operation_resolved").await,
                    0
                );
                assert_eq!(
                    retained_outcome_count(&app.pool, &fixture.owner_user_id, &operation_id).await,
                    0
                );
                if let Some(action) = case.applied_audit {
                    let audits: i64 = query_scalar(
                    "SELECT COUNT(*)::bigint FROM audit_log WHERE entity_id = $1 AND action = $2",
                )
                .bind(&case.item_id)
                .bind(action)
                .fetch_one(&app.pool)
                .await
                .expect("audit count should load");
                    assert_eq!(audits, 0, "{kind} must roll its audit back too");
                }
            },
        )
        .await;
    }
}

/// Every Item kind proves its own closed rejection set, and one fact keeps one name across kinds.
#[tokio::test]
async fn item_operations_prove_their_closed_rejection_sets() {
    with_api_test_app("item_operation_rejection_sets", |app| async move {
        let fixture = build_vault_router_fixture(&app.pool).await;
        let owner = app.issue_session(&fixture.owner_user_id).await;
        let readonly = app.issue_session(&fixture.readonly_user_id).await;
        let outsider = app.issue_session(&fixture.outsider_user_id).await;
        let missing = "item_that_never_existed";

        // `item_not_found` is the same fact for all five Operations that address an existing Item.
        for (index, (method, path, body, kind)) in [
            (
                Method::PATCH,
                format!("/api/v1/items/{missing}"),
                Some(json!({ "encryptedData": "enc" })),
                "update_item",
            ),
            (
                Method::PATCH,
                format!("/api/v1/items/{missing}/favorite"),
                Some(json!({ "favorite": true })),
                "set_item_favorite",
            ),
            (
                Method::DELETE,
                format!("/api/v1/items/{missing}"),
                None,
                "trash_item",
            ),
            (
                Method::POST,
                format!("/api/v1/items/{missing}/restore"),
                None,
                "restore_item",
            ),
            (
                Method::POST,
                format!("/api/v1/items/{missing}/moves"),
                Some(json!({
                    "mode": "prepared",
                    "sourceVaultId": fixture.main_vault_id,
                    "targetVaultId": fixture.target_vault_id,
                    "encryptedData": "enc",
                    "encryptionIv": "iv",
                    "encryptionAlgorithm": "aes-gcm"
                })),
                "move_item",
            ),
            (
                Method::DELETE,
                format!("/api/v1/items/{missing}/permanent"),
                None,
                "permanently_delete_item",
            ),
        ]
        .into_iter()
        .enumerate()
        {
            let response = app
                .api_json(
                    method,
                    &path,
                    body,
                    idempotent_item_headers(&owner.token, 1, &format!("missing-item-{index}")),
                )
                .await;
            response.assert_contract_status();
            assert_rejected(&response.body, kind, "item_not_found");
        }

        // `vault_access_denied` and `vault_read_only` likewise keep one name for every kind.
        for (index, (token, code)) in [
            (&outsider.token, "vault_access_denied"),
            (&readonly.token, "vault_read_only"),
        ]
        .into_iter()
        .enumerate()
        {
            let favorite = app
                .api_json(
                    Method::PATCH,
                    &format!("/api/v1/items/{}/favorite", fixture.active_item_id),
                    Some(json!({ "favorite": true })),
                    idempotent_item_headers(token, 1, &format!("favorite-access-{index}")),
                )
                .await;
            favorite.assert_contract_status();
            assert_rejected(&favorite.body, "set_item_favorite", code);

            let trash = app
                .api_json(
                    Method::DELETE,
                    &format!("/api/v1/items/{}", fixture.active_item_id),
                    None,
                    idempotent_item_headers(token, 1, &format!("trash-access-{index}")),
                )
                .await;
            trash.assert_contract_status();
            assert_rejected(&trash.body, "trash_item", code);

            let restore = app
                .api_json(
                    Method::POST,
                    &format!("/api/v1/items/{}/restore", fixture.deleted_item_id),
                    None,
                    idempotent_item_headers(token, 1, &format!("restore-access-{index}")),
                )
                .await;
            restore.assert_contract_status();
            assert_rejected(&restore.body, "restore_item", code);

            let permanent = app
                .api_json(
                    Method::DELETE,
                    &format!("/api/v1/items/{}/permanent", fixture.deleted_item_id),
                    None,
                    idempotent_item_headers(token, 1, &format!("permanent-access-{index}")),
                )
                .await;
            permanent.assert_contract_status();
            assert_rejected(&permanent.body, "permanently_delete_item", code);
        }

        // A move carries two Vaults, so the destination keeps its own two codes.
        seed_vault_key(
            &app.pool,
            "vault_key_member_readonly_target",
            &fixture.target_vault_id,
            &fixture.member_user_id,
            "target-readonly-key",
            "read-only",
        )
        .await;
        let member = app.issue_session(&fixture.member_user_id).await;
        let readonly_target = app
            .api_json(
                Method::POST,
                &format!("/api/v1/items/{}/moves", fixture.active_item_id),
                Some(json!({
                    "mode": "prepared",
                    "sourceVaultId": fixture.main_vault_id,
                    "targetVaultId": fixture.target_vault_id,
                    "encryptedData": "enc",
                    "encryptionIv": "iv",
                    "encryptionAlgorithm": "aes-gcm"
                })),
                idempotent_item_headers(&member.token, 1, "move-target-read-only"),
            )
            .await;
        readonly_target.assert_contract_status();
        assert_rejected(&readonly_target.body, "move_item", "target_vault_read_only");

        let denied_target = app
            .api_json(
                Method::POST,
                &format!("/api/v1/items/{}/moves", fixture.active_item_id),
                Some(json!({
                    "mode": "prepared",
                    "sourceVaultId": fixture.main_vault_id,
                    "targetVaultId": fixture.owner_personal_vault_id,
                    "encryptedData": "enc",
                    "encryptionIv": "iv",
                    "encryptionAlgorithm": "aes-gcm"
                })),
                idempotent_item_headers(&member.token, 1, "move-target-unreadable"),
            )
            .await;
        denied_target.assert_contract_status();
        assert_rejected(
            &denied_target.body,
            "move_item",
            "target_vault_access_denied",
        );

        // A trashed Item cannot move; that is the exact inverse of `item_not_trashed`.
        let trashed_move = app
            .api_json(
                Method::POST,
                &format!("/api/v1/items/{}/moves", fixture.deleted_item_id),
                Some(json!({
                    "mode": "prepared",
                    "sourceVaultId": fixture.main_vault_id,
                    "targetVaultId": fixture.target_vault_id,
                    "encryptedData": "enc",
                    "encryptionIv": "iv",
                    "encryptionAlgorithm": "aes-gcm"
                })),
                idempotent_item_headers(&owner.token, 1, "move-trashed-item"),
            )
            .await;
        trashed_move.assert_contract_status();
        assert_rejected(&trashed_move.body, "move_item", "item_trashed");

        // Oversized ciphertext is a retained semantic rejection on the two kinds that carry one.
        let oversized = "x".repeat(1_048_577);
        let oversized_update = app
            .api_json(
                Method::PATCH,
                &format!("/api/v1/items/{}", fixture.active_item_id),
                Some(json!({ "encryptedData": oversized })),
                idempotent_item_headers(&owner.token, 1, "oversized-update"),
            )
            .await;
        oversized_update.assert_contract_status();
        assert_rejected(&oversized_update.body, "update_item", "invalid_ciphertext");

        let oversized_move = app
            .api_json(
                Method::POST,
                &format!("/api/v1/items/{}/moves", fixture.active_item_id),
                Some(json!({
                    "mode": "prepared",
                    "sourceVaultId": fixture.main_vault_id,
                    "targetVaultId": fixture.target_vault_id,
                    "encryptedData": oversized,
                    "encryptionIv": "iv",
                    "encryptionAlgorithm": "aes-gcm"
                })),
                idempotent_item_headers(&owner.token, 1, "oversized-move"),
            )
            .await;
        oversized_move.assert_contract_status();
        assert_rejected(&oversized_move.body, "move_item", "invalid_ciphertext");
    })
    .await;
}

#[tokio::test]
async fn vault_management_handlers_manage_vault_lifecycle() {
    with_api_test_app(
            "vault_management_handlers_manage_vault_lifecycle",
            |app| async move {
                let fixture = build_vault_router_fixture(&app.pool).await;
                let owner_session = app.issue_session(&fixture.owner_user_id).await;
                let admin_session = app.issue_session(&fixture.admin_user_id).await;
                let solo_session = app.issue_session(&fixture.solo_user_id).await;
                let owner_headers = authenticated_json_headers(&owner_session.token);
                let admin_headers = authenticated_json_headers(&admin_session.token);
                let solo_headers = authenticated_json_headers(&solo_session.token);
                let created_personal_vault_id = "vault_created_personal";
                let created_team_vault_id = "vault_created_team";

                let create_personal_response = app
                    .api_json(Method::PUT, &format!("/api/v1/vaults/{}", created_personal_vault_id), Some(json!({ "name": "Created Personal Vault", "vaultType": "personal", "encryptedVaultKey": "created-personal-key" })), solo_headers.clone())
                    .await;
                create_personal_response.assert_contract_status();
                let created_personal_type: String =
                    query_scalar("SELECT type::text FROM vault WHERE id = $1")
                        .bind(created_personal_vault_id)
                        .fetch_one(&app.pool)
                        .await
                        .expect("created personal vault type should load");
                let created_personal_team_id: Option<String> =
                    query_scalar("SELECT team_id FROM vault WHERE id = $1")
                        .bind(created_personal_vault_id)
                        .fetch_one(&app.pool)
                        .await
                        .expect("created personal team id should load");
                assert_eq!(created_personal_type, "personal");
                assert!(created_personal_team_id.is_none());

                let create_team_response = app
                    .api_json(Method::PUT, &format!("/api/v1/vaults/{}", created_team_vault_id), Some(json!({ "name": "Created Team Vault", "vaultType": "team", "encryptedVaultKey": "created-team-key" })), owner_headers.clone())
                    .await;
                create_team_response.assert_contract_status();
                let created_team_type: String =
                    query_scalar("SELECT type::text FROM vault WHERE id = $1")
                        .bind(created_team_vault_id)
                        .fetch_one(&app.pool)
                        .await
                        .expect("created team vault type should load");
                let created_team_team_id: Option<String> =
                    query_scalar("SELECT team_id FROM vault WHERE id = $1")
                        .bind(created_team_vault_id)
                        .fetch_one(&app.pool)
                        .await
                        .expect("created team vault team id should load");
                assert_eq!(created_team_type, "team");
                assert_eq!(
                    created_team_team_id.as_deref(),
                    Some(fixture.paid_team_id.as_str())
                );

                let update_response = app
                    .api_json(Method::PATCH, &format!("/api/v1/vaults/{}", fixture.main_vault_id), Some(json!({ "name": "Updated Main Vault", "icon": "briefcase" })), admin_headers)
                    .await;
                update_response.assert_contract_status();
                assert_eq!(
                    update_response.body["name"],
                    json!("Updated Main Vault")
                );
                let updated_name: String = query_scalar("SELECT name FROM vault WHERE id = $1")
                    .bind(&fixture.main_vault_id)
                    .fetch_one(&app.pool)
                    .await
                    .expect("updated vault name should load");
                let updated_icon: Option<String> =
                    query_scalar("SELECT icon FROM vault WHERE id = $1")
                        .bind(&fixture.main_vault_id)
                        .fetch_one(&app.pool)
                        .await
                        .expect("updated vault icon should load");
                assert_eq!(updated_name, "Updated Main Vault");
                assert_eq!(updated_icon.as_deref(), Some("briefcase"));

                let convert_to_team_response = app
                    .api_json(Method::POST, &format!("/api/v1/vaults/{}/type-conversions", fixture.owner_personal_vault_id), Some(json!({ "targetType": "team" })), owner_headers.clone())
                    .await;
                convert_to_team_response.assert_contract_status();
                assert_eq!(
                    convert_to_team_response.body["previousType"],
                    json!("personal")
                );
                let converted_personal_type: String =
                    query_scalar("SELECT type::text FROM vault WHERE id = $1")
                        .bind(&fixture.owner_personal_vault_id)
                        .fetch_one(&app.pool)
                        .await
                        .expect("converted personal vault type should load");
                let converted_personal_team_id: Option<String> =
                    query_scalar("SELECT team_id FROM vault WHERE id = $1")
                        .bind(&fixture.owner_personal_vault_id)
                        .fetch_one(&app.pool)
                        .await
                        .expect("converted personal vault team id should load");
                assert_eq!(converted_personal_type, "team");
                assert_eq!(
                    converted_personal_team_id.as_deref(),
                    Some(fixture.paid_team_id.as_str())
                );

                let convert_to_personal_response = app
                    .api_json(Method::POST, &format!("/api/v1/vaults/{}/type-conversions", fixture.target_vault_id), Some(json!({ "targetType": "personal", "personalEncryptedVaultKey": "target-personal-key" })), owner_headers.clone())
                    .await;
                convert_to_personal_response.assert_contract_status();
                assert_eq!(
                    convert_to_personal_response.body["newType"],
                    json!("personal")
                );
                let converted_target_type: String =
                    query_scalar("SELECT type::text FROM vault WHERE id = $1")
                        .bind(&fixture.target_vault_id)
                        .fetch_one(&app.pool)
                        .await
                        .expect("converted target vault type should load");
                let converted_target_team_id: Option<String> =
                    query_scalar("SELECT team_id FROM vault WHERE id = $1")
                        .bind(&fixture.target_vault_id)
                        .fetch_one(&app.pool)
                        .await
                        .expect("converted target vault team id should load");
                let converted_target_key: String = query_scalar(
				"SELECT encrypted_vault_key FROM vault_key WHERE vault_id = $1 AND user_id = $2",
			)
			.bind(&fixture.target_vault_id)
			.bind(&fixture.owner_user_id)
			.fetch_one(&app.pool)
			.await
			.expect("converted target key should load");
                assert_eq!(converted_target_type, "personal");
                assert!(converted_target_team_id.is_none());
                assert_eq!(converted_target_key, "target-personal-key");

                let delete_response = app
                    .api_json(Method::DELETE, &format!("/api/v1/vaults/{}", created_personal_vault_id), None, solo_headers)
                    .await;
                delete_response.assert_contract_status();
                let remaining_rows: i64 =
                    query_scalar("SELECT COUNT(*)::bigint FROM vault WHERE id = $1")
                        .bind(created_personal_vault_id)
                        .fetch_one(&app.pool)
                        .await
                        .expect("remaining vault rows should load");
                assert_eq!(remaining_rows, 0);
            },
        )
        .await;
}

#[tokio::test]
async fn vault_management_handlers_enforce_access_and_validation() {
    with_api_test_app("vault_management_handlers_enforce_access_and_validation", |app| async move {
			let fixture = build_vault_router_fixture(&app.pool).await;
			let owner_session = app.issue_session(&fixture.owner_user_id).await;
			let admin_session = app.issue_session(&fixture.admin_user_id).await;
			let member_session = app.issue_session(&fixture.member_user_id).await;
			let solo_session = app.issue_session(&fixture.solo_user_id).await;
			let owner_headers = authenticated_json_headers(&owner_session.token);
			let admin_headers = authenticated_json_headers(&admin_session.token);
			let member_headers = authenticated_json_headers(&member_session.token);
			let solo_headers = authenticated_json_headers(&solo_session.token);

			let solo_team_create_response = app
				.api_json(Method::PUT, &format!("/api/v1/vaults/{}", "vault_explicit_request"), Some(json!({ "name": "No Team Vault", "vaultType": "team", "encryptedVaultKey": "wrapped" })), solo_headers)
				.await;
			solo_team_create_response.assert_contract_status();
			assert_handler_error(
				&solo_team_create_response.body,
				"BAD_REQUEST",
				"You must belong to a team to create a team vault",
			);

			let blank_update_response = app
				.api_json(Method::PATCH, &format!("/api/v1/vaults/{}", fixture.main_vault_id), Some(json!({ "name": "   " })), owner_headers.clone())
				.await;
			blank_update_response.assert_contract_status();
			assert_handler_error(&blank_update_response.body, "BAD_REQUEST", "Invalid params");

			let member_update_response = app
				.api_json(Method::PATCH, &format!("/api/v1/vaults/{}", fixture.main_vault_id), Some(json!({ "name": "Blocked Update" })), member_headers.clone())
				.await;
			member_update_response.assert_contract_status();
			assert_handler_error(&member_update_response.body, "FORBIDDEN", "Access denied");

			let admin_convert_response = app
				.api_json(Method::POST, &format!("/api/v1/vaults/{}/type-conversions", fixture.main_vault_id), Some(json!({ "targetType": "personal" })), admin_headers)
				.await;
			admin_convert_response.assert_contract_status();
			assert_handler_error(
				&admin_convert_response.body,
				"FORBIDDEN",
				"Only the vault owner can convert vault type",
			);

			let same_type_response = app
				.api_json(Method::POST, &format!("/api/v1/vaults/{}/type-conversions", fixture.main_vault_id), Some(json!({ "targetType": "team" })), owner_headers.clone())
				.await;
			same_type_response.assert_contract_status();
			assert_handler_error(
				&same_type_response.body,
				"BAD_REQUEST",
				"Vault is already the requested type",
			);

			let member_delete_response = app
				.api_json(Method::DELETE, &format!("/api/v1/vaults/{}", fixture.main_vault_id), None, member_headers)
				.await;
			member_delete_response.assert_contract_status();
			assert_handler_error(
				&member_delete_response.body,
				"FORBIDDEN",
				"Only the vault owner can delete the vault",
			);

			set_team_billing(&app.pool, &fixture.paid_team_id, "free", "active").await;
			let plan_forbidden_create_response = app
				.api_json(Method::PUT, &format!("/api/v1/vaults/{}", "vault_explicit_request"), Some(json!({ "name": "Blocked Team Vault", "vaultType": "team", "encryptedVaultKey": "blocked-key" })), owner_headers)
				.await;
			plan_forbidden_create_response.assert_contract_status();
			assert_handler_error(
				&plan_forbidden_create_response.body,
				"FORBIDDEN",
				"Shared vaults are only available on Family or Team plans with active billing.",
			);
		})
		.await;
}

#[tokio::test]
async fn vault_key_write_routes_reject_oversized_keys() {
    with_api_test_app("vault_key_write_limits", |app| async move {
        let fixture = build_vault_router_fixture(&app.pool).await;
        let session = app.issue_session(&fixture.owner_user_id).await;
        let headers = authenticated_json_headers(&session.token);
        let oversized =
            "k".repeat(super::key::ENCRYPTED_VAULT_KEY_MAX_BYTES + 1);
        let requests = [
            (
                Method::PUT,
                "/api/v1/vaults/vault_oversized_key".to_string(),
                json!({ "name": "Oversized", "vaultType": "personal", "encryptedVaultKey": oversized.clone() }),
            ),
            (
                Method::PUT,
                format!(
                    "/api/v1/vaults/{}/members/{}",
                    fixture.main_vault_id, fixture.addable_user_id
                ),
                json!({ "role": "member", "encryptedVaultKey": oversized.clone() }),
            ),
            (
                Method::POST,
                format!(
                    "/api/v1/vaults/{}/type-conversions",
                    fixture.main_vault_id
                ),
                json!({ "targetType": "personal", "personalEncryptedVaultKey": oversized.clone() }),
            ),
        ];
        for (method, path, body) in requests {
            let response = app
                .api_json(method, &path, Some(body), headers.clone())
                .await;
            assert_eq!(response.status, axum::http::StatusCode::BAD_REQUEST);
            assert_eq!(response.body["code"], json!("BAD_REQUEST"));
        }
    })
    .await;
}

#[tokio::test]
async fn vault_attachment_handlers_cover_presign_and_access_paths() {
    with_api_test_app_state(
        "vault_attachment_handlers_cover_presign_and_access_paths",
        |state| {
            with_test_config(
                state,
                &[
                    ("BITTERY_STORAGE_ENDPOINT", "https://storage.example.invalid"),
                    ("BITTERY_STORAGE_BUCKET", "bittery-test"),
                    ("BITTERY_STORAGE_ACCESS_KEY_ID", "test-access-key"),
                    ("BITTERY_STORAGE_SECRET_ACCESS_KEY", "test-secret-key"),
                    ("BITTERY_STORAGE_REGION", "auto"),
                    ("BITTERY_STORAGE_CDN_URL", "https://cdn.example.invalid/assets"),
                    ("BITTERY_ATTACHMENT_UPLOAD_SECRET", "test-attachment-secret"),
                ],
            )
        },
        |app| async move {
				let fixture = build_vault_router_fixture(&app.pool).await;
				let owner_session = app.issue_session(&fixture.owner_user_id).await;
				let readonly_session = app.issue_session(&fixture.readonly_user_id).await;
				let member_session = app.issue_session(&fixture.member_user_id).await;
				let owner_headers = authenticated_json_headers(&owner_session.token);
				let readonly_headers = authenticated_json_headers(&readonly_session.token);
				let member_headers = authenticated_json_headers(&member_session.token);

				let image_upload_response = app
					.api_json(Method::POST, &format!("/api/v1/vaults/{}/image-uploads", fixture.main_vault_id), Some(json!({ "fileName": "cover.png", "contentType": "image/png" })), owner_headers.clone())
					.await;
				image_upload_response.assert_contract_status();
				let image_key = image_upload_response.body["key"]
					.as_str()
					.expect("image upload key should exist");
				assert!(image_key.starts_with(&format!(
					"vaults/{}/{}/",
					fixture.owner_user_id, fixture.main_vault_id
				)));
				let image_public_url = image_upload_response.body["publicUrl"]
					.as_str()
					.expect("image public url should exist");
				assert!(image_public_url.contains("cdn.example.invalid/assets/vaults/"));

				let blocked_image_upload_response = app
					.api_json(Method::POST, &format!("/api/v1/vaults/{}/image-uploads", fixture.main_vault_id), Some(json!({ "fileName": "blocked.png", "contentType": "image/png" })), readonly_headers)
					.await;
				blocked_image_upload_response.assert_contract_status();
				assert_handler_error(&blocked_image_upload_response.body, "FORBIDDEN", "Access denied");

				let invalid_attachment_upload_response = app
					.api_json(Method::POST, &format!("/api/v1/items/{}/attachment-uploads", fixture.active_item_id), Some(json!({ "fileName": "   ", "contentType": "application/octet-stream", "fileSize": 4 })), owner_headers.clone())
					.await;
				invalid_attachment_upload_response.assert_contract_status();
				assert_handler_error(
					&invalid_attachment_upload_response.body,
					"BAD_REQUEST",
					"Invalid attachment upload request",
				);

				let attachment_upload_response = app
					.api_json(Method::POST, &format!("/api/v1/items/{}/attachment-uploads", fixture.active_item_id), Some(json!({ "fileName": "attachment.bin", "contentType": "application/octet-stream", "fileSize": 4 })), owner_headers.clone())
					.await;
				attachment_upload_response.assert_contract_status();
				let attachment_upload_key = attachment_upload_response.body["key"]
					.as_str()
					.expect("attachment upload key should exist");
				assert!(attachment_upload_key.starts_with(&format!(
					"attachments/{}/{}/",
					fixture.owner_user_id, fixture.active_item_id
				)));
				assert_eq!(attachment_upload_response.body["publicUrl"], Value::Null);
				let pending_storage_size: i32 = query_scalar(
					"SELECT storage_size FROM pending_attachment_upload WHERE item_id = $1 AND created_by = $2 ORDER BY created_at DESC LIMIT 1",
				)
				.bind(&fixture.active_item_id)
				.bind(&fixture.owner_user_id)
				.fetch_one(&app.pool)
				.await
				.expect("pending attachment storage size should load");
				assert_eq!(pending_storage_size, 102);

				let invalid_envelope_version = app
					.api_json(Method::POST, &format!("/api/v1/items/{}/attachments", fixture.active_item_id), Some(json!({ "attachmentId": "attachment_pending", "storageKey": "invalid-key", "encryptedAttachmentKey": "encrypted-attachment-key", "attachmentKeyIv": "attachment-key-iv", "attachmentKeyAlgorithm": "aes-gcm", "envelopeVersion": 0, "encryptedName": "encrypted-name", "encryptedContentType": "encrypted-content-type", "encryptionIv": "attachment-iv", "encryptedContentTypeIv": "content-type-iv", "encryptionAlgorithm": "aes-gcm", "fileSize": 4 })), owner_headers.clone())
					.await;
				invalid_envelope_version.assert_contract_status();
				assert_handler_error(
					&invalid_envelope_version.body,
					"BAD_REQUEST",
					"Unsupported attachment envelope version",
				);

				let create_attachment_response = app
					.api_json(Method::POST, &format!("/api/v1/items/{}/attachments", fixture.active_item_id), Some(json!({ "attachmentId": "attachment_pending", "storageKey": "invalid-key", "encryptedAttachmentKey": "encrypted-attachment-key", "attachmentKeyIv": "attachment-key-iv", "attachmentKeyAlgorithm": "aes-gcm", "envelopeVersion": 1, "encryptedName": "encrypted-name", "encryptedContentType": "encrypted-content-type", "encryptionIv": "attachment-iv", "encryptedContentTypeIv": "content-type-iv", "encryptionAlgorithm": "aes-gcm", "fileSize": 4 })), owner_headers.clone())
					.await;
				create_attachment_response.assert_contract_status();
				assert_handler_error(
					&create_attachment_response.body,
					"BAD_REQUEST",
					"Invalid or expired attachment upload key",
				);

				let list_attachments_response = app
					.api_json(Method::GET, &format!("/api/v1/items/{}/attachments", fixture.active_item_id), None, owner_headers.clone())
					.await;
				list_attachments_response.assert_contract_status();
				let attachments = list_attachments_response.body
					.get("items")
					.and_then(Value::as_array)
					.expect("attachments should be returned");
				assert_eq!(attachments.len(), 1);
				assert_eq!(attachments[0]["id"], json!(fixture.attachment_id));

				let download_response = app
					.api_json(Method::POST, &format!("/api/v1/attachments/{}/download-urls", fixture.attachment_id), None, owner_headers.clone())
					.await;
				download_response.assert_contract_status();
				let download_url = download_response.body["downloadUrl"]
					.as_str()
					.expect("download url should exist");
				assert!(download_url.contains("storage.example.invalid"));
				assert_eq!(download_response.body["fileSize"], json!(128));

				let original_authority: (String, String, String, i32, String, String, String) = query_as(
					"SELECT encrypted_name, encryption_iv, encryption_algorithm, envelope_version, encrypted_attachment_key, attachment_key_iv, attachment_key_algorithm FROM item_attachment WHERE id = $1",
				)
				.bind(&fixture.attachment_id)
				.fetch_one(&app.pool)
				.await
				.expect("original Attachment key authority should load");

				let update_attachment_response = app
					.api_json(Method::PATCH, &format!("/api/v1/attachments/{}", fixture.attachment_id), Some(json!({ "encryptedName": "first-renamed-encrypted-name", "encryptionIv": "first-renamed-attachment-iv", "encryptionAlgorithm": "first-rename-algorithm" })), owner_headers.clone())
					.await;
				update_attachment_response.assert_contract_status();
				let first_renamed_authority: (String, String, String, i32, String, String, String) = query_as(
					"SELECT encrypted_name, encryption_iv, encryption_algorithm, envelope_version, encrypted_attachment_key, attachment_key_iv, attachment_key_algorithm FROM item_attachment WHERE id = $1",
				)
				.bind(&fixture.attachment_id)
				.fetch_one(&app.pool)
				.await
				.expect("first renamed Attachment authority should load");
				assert_eq!(first_renamed_authority.0, "first-renamed-encrypted-name");
				assert_eq!(first_renamed_authority.1, "first-renamed-attachment-iv");
				assert_eq!(first_renamed_authority.2, "first-rename-algorithm");
				assert_ne!(first_renamed_authority.0, original_authority.0);
				assert_ne!(first_renamed_authority.1, original_authority.1);
				assert_ne!(first_renamed_authority.2, original_authority.2);
				assert_eq!(first_renamed_authority.3, original_authority.3);
				assert_eq!(
					(&first_renamed_authority.4, &first_renamed_authority.5, &first_renamed_authority.6),
					(&original_authority.4, &original_authority.5, &original_authority.6),
					"first Rename must not replace Attachment key-envelope authority",
				);
				let second_update_attachment_response = app
					.api_json(Method::PATCH, &format!("/api/v1/attachments/{}", fixture.attachment_id), Some(json!({ "encryptedName": "second-renamed-encrypted-name", "encryptionIv": "second-renamed-attachment-iv", "encryptionAlgorithm": "second-rename-algorithm" })), owner_headers.clone())
					.await;
				second_update_attachment_response.assert_contract_status();
				let renamed_authority: (String, String, String, i32, String, String, String) = query_as(
					"SELECT encrypted_name, encryption_iv, encryption_algorithm, envelope_version, encrypted_attachment_key, attachment_key_iv, attachment_key_algorithm FROM item_attachment WHERE id = $1",
				)
				.bind(&fixture.attachment_id)
				.fetch_one(&app.pool)
				.await
				.expect("renamed Attachment authority should load");
				assert_eq!(renamed_authority.0, "second-renamed-encrypted-name");
				assert_eq!(renamed_authority.1, "second-renamed-attachment-iv");
				assert_eq!(renamed_authority.2, "second-rename-algorithm");
				assert_ne!(renamed_authority.0, first_renamed_authority.0);
				assert_ne!(renamed_authority.1, first_renamed_authority.1);
				assert_ne!(renamed_authority.2, first_renamed_authority.2);
				assert_ne!(renamed_authority.0, original_authority.0);
				assert_ne!(renamed_authority.1, original_authority.1);
				assert_ne!(renamed_authority.2, original_authority.2);
				assert_eq!(renamed_authority.3, original_authority.3);
				assert_eq!(
					(&renamed_authority.4, &renamed_authority.5, &renamed_authority.6),
					(&original_authority.4, &original_authority.5, &original_authority.6),
					"second Rename must not replace Attachment key-envelope authority",
				);

				let blocked_delete_response = app
					.api_json(Method::DELETE, &format!("/api/v1/attachments/{}", fixture.attachment_id), None, member_headers)
					.await;
				blocked_delete_response.assert_contract_status();
				assert_handler_error(
					&blocked_delete_response.body,
					"FORBIDDEN",
					"You can only delete your own attachments",
				);
        },
    )
    .await;
}

#[tokio::test]
async fn attachment_download_grant_returns_the_presigned_row_authority() {
    with_api_test_app_state(
        "attachment_download_grant_returns_the_presigned_row_authority",
        |state| {
            with_test_config(
                state,
                &[
                    (
                        "BITTERY_STORAGE_ENDPOINT",
                        "https://storage.example.invalid",
                    ),
                    ("BITTERY_STORAGE_BUCKET", "bittery-test"),
                    ("BITTERY_STORAGE_ACCESS_KEY_ID", "test-access-key"),
                    ("BITTERY_STORAGE_SECRET_ACCESS_KEY", "test-secret-key"),
                    ("BITTERY_STORAGE_REGION", "auto"),
                ],
            )
        },
        |app| async move {
            let fixture = build_vault_router_fixture(&app.pool).await;
            let session = app.issue_session(&fixture.owner_user_id).await;
            let response = app
                .api_json(
                    Method::POST,
                    &format!(
                        "/api/v1/attachments/{}/download-urls",
                        fixture.attachment_id
                    ),
                    None,
                    authenticated_json_headers(&session.token),
                )
                .await;

            response.assert_contract_status();
            assert_eq!(response.status, StatusCode::OK);
            assert_eq!(
                response.body,
                json!({
                    "attachmentId": fixture.attachment_id,
                    "itemId": fixture.active_item_id,
                    "vaultId": fixture.main_vault_id,
                    "storageKey": "attachments/vault_main_attachment",
                    "envelopeVersion": 1,
                    "uploadedBy": fixture.owner_user_id,
                    "downloadUrl": response.body["downloadUrl"],
                    "encryptedName": "encrypted-attachment-name",
                    "encryptedContentType": "encrypted-content-type",
                    "encryptionIv": "attachment-iv",
                    "encryptedContentTypeIv": "attachment-content-type-iv",
                    "encryptionAlgorithm": "AES-GCM-AAD-V1",
                    "fileSize": 128,
                })
            );
            let download_url = response.body["downloadUrl"]
                .as_str()
                .expect("download URL should exist");
            let parsed = url::Url::parse(download_url).expect("download URL should parse");
            assert_eq!(
                parsed.path(),
                "/bittery-test/attachments/vault_main_attachment"
            );
        },
    )
    .await;
}

#[tokio::test]
async fn vault_member_handlers_manage_members() {
    with_api_test_app("vault_member_handlers_manage_members", |app| async move {
        let fixture = build_vault_router_fixture(&app.pool).await;
        let owner_session = app.issue_session(&fixture.owner_user_id).await;
        let owner_headers = authenticated_json_headers(&owner_session.token);
        let members_response = app
            .api_json(
                Method::GET,
                &format!("/api/v1/vaults/{}/members", fixture.main_vault_id),
                None,
                owner_headers.clone(),
            )
            .await;
        members_response.assert_contract_status();
        let members = members_response
            .body
            .get("items")
            .and_then(Value::as_array)
            .expect("members should be returned");
        assert_eq!(members.len(), 4);
        assert!(members
            .iter()
            .any(|member| member["userId"] == json!(fixture.readonly_user_id)));

        let available_members_response = app
            .api_json(
                Method::GET,
                &format!(
                    "/api/v1/vaults/{}/available-team-members",
                    fixture.main_vault_id
                ),
                None,
                owner_headers.clone(),
            )
            .await;
        available_members_response.assert_contract_status();
        let available_members = available_members_response
            .body
            .get("items")
            .and_then(Value::as_array)
            .expect("available members should be returned");
        assert!(available_members
            .iter()
            .any(|member| member["userId"] == json!(fixture.addable_user_id)));
        assert!(!available_members
            .iter()
            .any(|member| member["userId"] == json!(fixture.member_user_id)));

        let update_role_response = app
            .api_json(
                Method::PATCH,
                &format!(
                    "/api/v1/vaults/{}/members/{}",
                    fixture.main_vault_id, fixture.readonly_user_id
                ),
                Some(json!({ "role": "member" })),
                owner_headers.clone(),
            )
            .await;
        update_role_response.assert_contract_status();
        let updated_role: String =
            query_scalar("SELECT role::text FROM vault_key WHERE vault_id = $1 AND user_id = $2")
                .bind(&fixture.main_vault_id)
                .bind(&fixture.readonly_user_id)
                .fetch_one(&app.pool)
                .await
                .expect("updated vault role should load");
        assert_eq!(updated_role, "member");

        let add_member_response = app
            .api_json(
                Method::PUT,
                &format!(
                    "/api/v1/vaults/{}/members/{}",
                    fixture.main_vault_id, fixture.addable_user_id
                ),
                Some(json!({ "role": "member", "encryptedVaultKey": "addable-member-key" })),
                owner_headers.clone(),
            )
            .await;
        add_member_response.assert_contract_status();
        let added_member_count: i64 = query_scalar(
            "SELECT COUNT(*)::bigint FROM vault_key WHERE vault_id = $1 AND user_id = $2",
        )
        .bind(&fixture.main_vault_id)
        .bind(&fixture.addable_user_id)
        .fetch_one(&app.pool)
        .await
        .expect("added member count should load");
        assert_eq!(added_member_count, 1);
    })
    .await;
}

#[tokio::test]
async fn vault_member_handlers_reject_invalid_and_forbidden_requests() {
    with_api_test_app(
        "vault_member_handlers_reject_invalid_and_forbidden_requests",
        |app| async move {
            let fixture = build_vault_router_fixture(&app.pool).await;
            let owner_session = app.issue_session(&fixture.owner_user_id).await;
            let admin_session = app.issue_session(&fixture.admin_user_id).await;
            let member_session = app.issue_session(&fixture.member_user_id).await;
            let owner_headers = authenticated_json_headers(&owner_session.token);
            let admin_headers = authenticated_json_headers(&admin_session.token);
            let member_headers = authenticated_json_headers(&member_session.token);

            let blocked_available_response = app
                .api_json(
                    Method::GET,
                    &format!(
                        "/api/v1/vaults/{}/available-team-members",
                        fixture.main_vault_id
                    ),
                    None,
                    member_headers.clone(),
                )
                .await;
            blocked_available_response.assert_contract_status();
            assert_handler_error(
                &blocked_available_response.body,
                "FORBIDDEN",
                "Only vault owner or admin can manage members",
            );

            let self_role_response = app
                .api_json(
                    Method::PATCH,
                    &format!(
                        "/api/v1/vaults/{}/members/{}",
                        fixture.main_vault_id, fixture.owner_user_id
                    ),
                    Some(json!({ "role": "member" })),
                    owner_headers.clone(),
                )
                .await;
            self_role_response.assert_contract_status();
            assert_handler_error(
                &self_role_response.body,
                "BAD_REQUEST",
                "Cannot change your own role",
            );

            let owner_role_response = app
                .api_json(
                    Method::PATCH,
                    &format!(
                        "/api/v1/vaults/{}/members/{}",
                        fixture.main_vault_id, fixture.owner_user_id
                    ),
                    Some(json!({ "role": "member" })),
                    admin_headers,
                )
                .await;
            owner_role_response.assert_contract_status();
            assert_handler_error(
                &owner_role_response.body,
                "FORBIDDEN",
                "Cannot change vault owner's role",
            );

            let missing_member_response = app
                .api_json(
                    Method::PATCH,
                    &format!(
                        "/api/v1/vaults/{}/members/{}",
                        fixture.main_vault_id, "missing_member_user"
                    ),
                    Some(json!({ "role": "member" })),
                    owner_headers.clone(),
                )
                .await;
            missing_member_response.assert_contract_status();
            assert_handler_error(
                &missing_member_response.body,
                "NOT_FOUND",
                "Member not found",
            );

            let wrong_team_add_response = app
                .api_json(
                    Method::PUT,
                    &format!(
                        "/api/v1/vaults/{}/members/{}",
                        fixture.main_vault_id, fixture.outsider_user_id
                    ),
                    Some(json!({ "role": "member", "encryptedVaultKey": "outsider-key" })),
                    owner_headers.clone(),
                )
                .await;
            wrong_team_add_response.assert_contract_status();
            assert_handler_error(
                &wrong_team_add_response.body,
                "BAD_REQUEST",
                "User must belong to the same team as this vault",
            );
        },
    )
    .await;
}
