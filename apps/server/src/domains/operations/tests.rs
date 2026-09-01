use super::{item_operation_fingerprint, ItemOperationEffect, ItemOperationInput};
use crate::{
    db::enums::ItemCategory,
    domains::vaults::{
        CreateItemEffectInput, FavoriteItemEffectInput, ItemEffectInput, UpdateItemEffectInput,
    },
};

fn input(effect: ItemOperationEffect, raw_body: &[u8]) -> ItemOperationInput {
    ItemOperationInput {
        operation_id: "ignored".into(),
        user_id: "ignored".into(),
        effect,
        raw_body: raw_body.to_vec(),
    }
}

#[test]
fn create_share_outcomes_serialize_only_the_decided_payload_and_rejections() {
    use super::{CreateShareOperationRejectionCode, CreateShareOperationResult, OperationOutcome};
    use serde_json::json;

    assert_eq!(
        serde_json::to_value(OperationOutcome::new_create_share(
            "share-operation".into(),
            CreateShareOperationResult::Applied {
                share_link_id: "share_link_1".into(),
                base_share_url: "https://app.example/share/".into(),
                expires_at: "2026-08-27T00:00:00Z".into(),
            },
        ))
        .unwrap(),
        json!({
            "kind": "create_share",
            "operationId": "share-operation",
            "result": {
                "status": "applied",
                "shareLinkId": "share_link_1",
                "baseShareUrl": "https://app.example/share/",
                "expiresAt": "2026-08-27T00:00:00Z"
            }
        })
    );

    for code in [
        CreateShareOperationRejectionCode::ItemNotFound,
        CreateShareOperationRejectionCode::VaultReadOnly,
        CreateShareOperationRejectionCode::ShareEntitlementDenied,
        CreateShareOperationRejectionCode::ShareLimitReached,
    ] {
        let wire = serde_json::to_value(OperationOutcome::new_create_share(
            "share-operation".into(),
            CreateShareOperationResult::Rejected { code },
        ))
        .unwrap();
        assert_eq!(
            wire["result"]["code"],
            json!(match code {
                CreateShareOperationRejectionCode::ItemNotFound => "item_not_found",
                CreateShareOperationRejectionCode::VaultReadOnly => "vault_read_only",
                CreateShareOperationRejectionCode::ShareEntitlementDenied =>
                    "share_entitlement_denied",
                CreateShareOperationRejectionCode::ShareLimitReached => "share_limit_reached",
            })
        );
    }
}

#[test]
fn create_vault_outcomes_serialize_the_exact_closed_wire_shape() {
    use super::{CreateVaultOperationRejectionCode, CreateVaultOperationResult, OperationOutcome};
    use serde_json::json;

    assert_eq!(
        serde_json::to_value(OperationOutcome::new_create_vault(
            "vault-operation".into(),
            CreateVaultOperationResult::Applied {
                vault_id: "vault_1".into(),
            },
        ))
        .unwrap(),
        json!({
            "kind": "create_vault",
            "operationId": "vault-operation",
            "result": { "status": "applied", "vaultId": "vault_1" }
        })
    );

    for (code, wire) in [
        (
            CreateVaultOperationRejectionCode::VaultIdConflict,
            "vault_id_conflict",
        ),
        (
            CreateVaultOperationRejectionCode::TeamMembershipRequired,
            "team_membership_required",
        ),
        (
            CreateVaultOperationRejectionCode::VaultSharingEntitlementDenied,
            "vault_sharing_entitlement_denied",
        ),
        (
            CreateVaultOperationRejectionCode::SharedVaultLimitReached,
            "shared_vault_limit_reached",
        ),
    ] {
        let outcome = OperationOutcome::new_create_vault(
            "vault-operation".into(),
            CreateVaultOperationResult::Rejected { code },
        );
        assert_eq!(
            serde_json::to_value(outcome).unwrap()["result"]["code"],
            wire
        );
    }
}

#[test]
fn import_items_outcomes_serialize_the_exact_closed_wire_shape() {
    use super::{ImportItemsOperationRejectionCode, ImportItemsOperationResult, OperationOutcome};
    use serde_json::json;

    for imported_count in [0, 200] {
        let outcome = OperationOutcome::new_import_items(
            "import-operation".into(),
            ImportItemsOperationResult::Applied {
                vault_id: "vault_1".into(),
                imported_count,
            },
        );
        let wire = serde_json::to_value(&outcome).unwrap();
        assert_eq!(
            wire,
            json!({
                "kind": "import_items",
                "operationId": "import-operation",
                "result": {
                    "status": "applied",
                    "vaultId": "vault_1",
                    "importedCount": imported_count
                }
            })
        );
        assert_eq!(
            serde_json::from_value::<OperationOutcome>(wire).unwrap(),
            outcome
        );
    }

    for (code, wire) in [
        (
            ImportItemsOperationRejectionCode::InvalidCiphertext,
            "invalid_ciphertext",
        ),
        (
            ImportItemsOperationRejectionCode::VaultAccessDenied,
            "vault_access_denied",
        ),
        (
            ImportItemsOperationRejectionCode::VaultReadOnly,
            "vault_read_only",
        ),
        (
            ImportItemsOperationRejectionCode::ItemIdConflict,
            "item_id_conflict",
        ),
    ] {
        assert_eq!(
            serde_json::to_value(OperationOutcome::new_import_items(
                "import-operation".into(),
                ImportItemsOperationResult::Rejected { code },
            ))
            .unwrap(),
            json!({
                "kind": "import_items",
                "operationId": "import-operation",
                "result": { "status": "rejected", "code": wire }
            })
        );
    }
}

fn create(item_id: &str) -> ItemOperationEffect {
    ItemOperationEffect::Create(CreateItemEffectInput {
        item_id: item_id.into(),
        vault_id: "vault".into(),
        category: ItemCategory::Login,
        encrypted_data: "ciphertext".into(),
        encryption_iv: "iv".into(),
        encryption_algorithm: "aes-gcm".into(),
        client_id: None,
        ciphertext_limit: 1024,
    })
}

fn update(expected_version: i32) -> ItemOperationEffect {
    ItemOperationEffect::Update(UpdateItemEffectInput {
        item_id: "item".into(),
        encrypted_data: Some("ciphertext".into()),
        encryption_iv: None,
        encryption_algorithm: None,
        expected_version,
        client_id: None,
        ciphertext_limit: 1024,
    })
}

#[test]
fn fingerprint_is_exactly_sensitive_to_raw_body_bytes() {
    assert_ne!(
        item_operation_fingerprint(&input(create("item"), br#"{"a":1}"#)),
        item_operation_fingerprint(&input(create("item"), br#"{ "a": 1 }"#)),
    );
}

#[test]
fn fingerprint_separates_routes_that_share_a_path() {
    let trash = ItemOperationEffect::Trash(ItemEffectInput {
        item_id: "item".into(),
        expected_version: 3,
        client_id: None,
    });
    let restore = ItemOperationEffect::Restore(ItemEffectInput {
        item_id: "item".into(),
        expected_version: 3,
        client_id: None,
    });
    assert_ne!(
        item_operation_fingerprint(&input(trash, b"")),
        item_operation_fingerprint(&input(restore, b"")),
    );
}

#[test]
fn fingerprint_covers_the_normalized_precondition() {
    assert_ne!(
        item_operation_fingerprint(&input(update(1), br#"{"encryptedData":"a"}"#)),
        item_operation_fingerprint(&input(update(2), br#"{"encryptedData":"a"}"#)),
    );
}

#[test]
fn fingerprint_separates_kinds_that_share_a_body_and_a_path() {
    let favorite = ItemOperationEffect::SetFavorite(FavoriteItemEffectInput {
        item_id: "item".into(),
        favorite: true,
        expected_version: 3,
        client_id: None,
    });
    let trash = ItemOperationEffect::Trash(ItemEffectInput {
        item_id: "item".into(),
        expected_version: 3,
        client_id: None,
    });
    assert_ne!(
        item_operation_fingerprint(&input(favorite, b"")),
        item_operation_fingerprint(&input(trash, b"")),
    );
}

#[test]
fn every_kind_serializes_the_documented_wire_shape() {
    use super::{ItemOperationRejectionCode, ItemOperationResult, OperationOutcome};
    use crate::db::enums::OperationKind;
    use serde_json::json;

    for (kind, wire) in [
        (OperationKind::CreateItem, "create_item"),
        (OperationKind::UpdateItem, "update_item"),
        (OperationKind::SetItemFavorite, "set_item_favorite"),
        (OperationKind::TrashItem, "trash_item"),
        (OperationKind::RestoreItem, "restore_item"),
        (OperationKind::MoveItem, "move_item"),
        (
            OperationKind::PermanentlyDeleteItem,
            "permanently_delete_item",
        ),
    ] {
        let applied = OperationOutcome::new(
            kind,
            "operation-1".into(),
            ItemOperationResult::Applied {
                item_id: "item-1".into(),
                version: 4,
            },
        );
        assert_eq!(
            serde_json::to_value(&applied).unwrap(),
            json!({
                "kind": wire,
                "operationId": "operation-1",
                "result": { "status": "applied", "itemId": "item-1", "version": 4 },
            }),
        );
        assert_eq!(
            serde_json::from_value::<OperationOutcome>(serde_json::to_value(&applied).unwrap())
                .unwrap(),
            applied,
        );

        let rejected = OperationOutcome::new(
            kind,
            "operation-2".into(),
            ItemOperationResult::Rejected {
                code: ItemOperationRejectionCode::VaultReadOnly,
                details: None,
            },
        );
        assert_eq!(
            serde_json::to_value(&rejected).unwrap(),
            json!({
                "kind": wire,
                "operationId": "operation-2",
                "result": { "status": "rejected", "code": "vault_read_only" },
            }),
        );
    }
}

/// An unknown `kind` must fail to parse rather than be read as some other Operation's answer.
#[test]
fn an_unknown_kind_is_refused_rather_than_misread() {
    use super::OperationOutcome;
    use serde_json::json;

    let unknown = json!({
        "kind": "rotate_vault_key",
        "operationId": "operation-1",
        "result": { "status": "applied", "itemId": "item-1", "version": 1 },
    });
    assert!(serde_json::from_value::<OperationOutcome>(unknown).is_err());
}

#[tokio::test]
async fn create_vault_applied_outcome_requires_the_exact_vault_id_payload() {
    use crate::test_support::{seed_user, with_api_test_app};
    use serde_json::json;
    use sqlx::query;

    with_api_test_app("create_vault_outcome_applied_shape", |app| async move {
        let user_id = "create_vault_outcome_shape_user";
        seed_user(
            &app.pool,
            user_id,
            "Create Vault Outcome Shape User",
            "create-vault-outcome-shape@example.com",
        )
        .await;
        query(
            "INSERT INTO operation_outcome (user_id, operation_id, operation_kind, request_fingerprint, result_status, applied_payload) VALUES ($1, 'valid-create-vault', 'create_vault', $2, 'applied', $3)",
        )
        .bind(user_id)
        .bind(vec![1_u8; 32])
        .bind(json!({ "vaultId": "vault_1" }))
        .execute(&app.pool)
        .await
        .expect("the exact create-Vault payload should be retained");
    })
    .await;
}

#[tokio::test]
async fn create_vault_outcome_accepts_only_its_closed_rejection_codes() {
    use crate::test_support::{seed_user, with_api_test_app};
    use sqlx::query;

    with_api_test_app("create_vault_outcome_rejections", |app| async move {
        let user_id = "create_vault_outcome_rejection_user";
        seed_user(
            &app.pool,
            user_id,
            "Create Vault Outcome Rejection User",
            "create-vault-outcome-rejection@example.com",
        )
        .await;

        for (index, code) in [
            "vault_id_conflict",
            "team_membership_required",
            "vault_sharing_entitlement_denied",
            "shared_vault_limit_reached",
        ]
        .into_iter()
        .enumerate()
        {
            query(
                "INSERT INTO operation_outcome (user_id, operation_id, operation_kind, request_fingerprint, result_status, rejection_code) VALUES ($1, $2, 'create_vault', $3, 'rejected', $4::operation_rejection_code)",
            )
            .bind(user_id)
            .bind(format!("valid-create-vault-rejection-{index}"))
            .bind(vec![index as u8; 32])
            .bind(code)
            .execute(&app.pool)
            .await
            .expect("each decided create-Vault rejection should be retained");
        }
    })
    .await;
}

#[tokio::test]
async fn operation_lookup_returns_the_exact_users_create_vault_outcome_identity() {
    use crate::test_support::{authenticated_json_headers, seed_user, with_api_test_app};
    use axum::http::Method;
    use serde_json::json;
    use sqlx::query;

    with_api_test_app("create_vault_outcome_lookup_identity", |app| async move {
        for (user_id, email, vault_id, fingerprint) in [
            ("create_vault_lookup_user_a", "vault-a@example.com", "vault_a", 1_u8),
            ("create_vault_lookup_user_b", "vault-b@example.com", "vault_b", 2_u8),
        ] {
            seed_user(&app.pool, user_id, user_id, email).await;
            query(
                "INSERT INTO operation_outcome (user_id, operation_id, operation_kind, request_fingerprint, result_status, applied_payload) VALUES ($1, 'shared-operation-id', 'create_vault', $2, 'applied', $3)",
            )
            .bind(user_id)
            .bind(vec![fingerprint; 32])
            .bind(json!({ "vaultId": vault_id }))
            .execute(&app.pool)
            .await
            .expect("create-Vault outcome fixture should seed");

            let session = app.issue_session(user_id).await;
            let response = app
                .api_json(
                    Method::GET,
                    "/api/v1/operations/shared-operation-id",
                    None,
                    authenticated_json_headers(&session.token),
                )
                .await;
            response.assert_contract_status();
            assert_eq!(
                response.body,
                json!({
                    "kind": "create_vault",
                    "operationId": "shared-operation-id",
                    "result": { "status": "applied", "vaultId": vault_id }
                })
            );
        }

        query(
            "INSERT INTO operation_outcome (user_id, operation_id, operation_kind, request_fingerprint, result_status, rejection_code) VALUES ('create_vault_lookup_user_a', 'rejected-operation-id', 'create_vault', $1, 'rejected', 'shared_vault_limit_reached')",
        )
        .bind(vec![3_u8; 32])
        .execute(&app.pool)
        .await
        .expect("rejected create-Vault outcome fixture should seed");
        let session = app.issue_session("create_vault_lookup_user_a").await;
        let rejected = app
            .api_json(
                Method::GET,
                "/api/v1/operations/rejected-operation-id",
                None,
                authenticated_json_headers(&session.token),
            )
            .await;
        rejected.assert_contract_status();
        assert_eq!(
            rejected.body,
            json!({
                "kind": "create_vault",
                "operationId": "rejected-operation-id",
                "result": {
                    "status": "rejected",
                    "code": "shared_vault_limit_reached"
                }
            })
        );
    })
    .await;
}

#[tokio::test]
async fn create_vault_schema_rejects_malformed_cross_kind_and_unknown_rows_atomically() {
    use crate::test_support::{seed_user, with_api_test_app};
    use serde_json::{json, Value};
    use sqlx::{query, query_scalar};

    with_api_test_app("create_vault_outcome_closed_schema", |app| async move {
        let user_id = "create_vault_closed_schema_user";
        seed_user(
            &app.pool,
            user_id,
            "Create Vault Closed Schema User",
            "create-vault-closed-schema@example.com",
        )
        .await;

        for (index, payload) in [
            Value::Null,
            json!({}),
            json!({ "vaultId": 1 }),
            json!({ "vaultId": "vault_1", "extra": true }),
            json!({
                "shareLinkId": "share_1",
                "baseShareUrl": "https://app.example/share/",
                "expiresAt": "2026-08-31T00:00:00Z"
            }),
        ]
        .into_iter()
        .enumerate()
        {
            let result = query(
                "INSERT INTO operation_outcome (user_id, operation_id, operation_kind, request_fingerprint, result_status, applied_payload) VALUES ($1, $2, 'create_vault', $3, 'applied', $4)",
            )
            .bind(user_id)
            .bind(format!("malformed-create-vault-{index}"))
            .bind(vec![index as u8; 32])
            .bind(payload)
            .execute(&app.pool)
            .await;
            assert!(result.is_err(), "malformed payload {index} was retained");
        }

        for (operation_id, kind, code) in [
            ("foreign-create-vault-code", "create_vault", "vault_read_only"),
            ("vault-code-on-item", "update_item", "vault_id_conflict"),
            ("vault-code-on-share", "create_share", "shared_vault_limit_reached"),
        ] {
            let result = query(
                "INSERT INTO operation_outcome (user_id, operation_id, operation_kind, request_fingerprint, result_status, rejection_code) VALUES ($1, $2, $3::operation_kind, $4, 'rejected', $5::operation_rejection_code)",
            )
            .bind(user_id)
            .bind(operation_id)
            .bind(kind)
            .bind(vec![9_u8; 32])
            .bind(code)
            .execute(&app.pool)
            .await;
            assert!(result.is_err(), "cross-kind rejection {operation_id} was retained");
        }

        let unknown_kind = query(
            "INSERT INTO operation_outcome (user_id, operation_id, operation_kind, request_fingerprint, result_status, applied_payload) VALUES ($1, 'unknown-kind', 'future_vault_kind', $2, 'applied', $3)",
        )
        .bind(user_id)
        .bind(vec![10_u8; 32])
        .bind(json!({ "vaultId": "vault_1" }))
        .execute(&app.pool)
        .await;
        assert!(unknown_kind.is_err());

        let mut transaction = app.pool.begin().await.expect("transaction should begin");
        query(
            "INSERT INTO operation_outcome (user_id, operation_id, operation_kind, request_fingerprint, result_status, applied_payload) VALUES ($1, 'rolled-back-create-vault', 'create_vault', $2, 'applied', $3)",
        )
        .bind(user_id)
        .bind(vec![11_u8; 32])
        .bind(json!({ "vaultId": "vault_rollback" }))
        .execute(&mut *transaction)
        .await
        .expect("valid row should enter the uncommitted transaction");
        let invalid = query(
            "INSERT INTO operation_outcome (user_id, operation_id, operation_kind, request_fingerprint, result_status, applied_payload) VALUES ($1, 'forces-rollback', 'create_vault', $2, 'applied', $3)",
        )
        .bind(user_id)
        .bind(vec![12_u8; 32])
        .bind(json!({ "vaultId": "vault_rollback", "foreign": true }))
        .execute(&mut *transaction)
        .await;
        assert!(invalid.is_err());
        transaction.rollback().await.expect("rollback should succeed");

        let retained: i64 = query_scalar(
            "SELECT COUNT(*)::bigint FROM operation_outcome WHERE user_id = $1 AND operation_id = 'rolled-back-create-vault'",
        )
        .bind(user_id)
        .fetch_one(&app.pool)
        .await
        .expect("rollback probe should load");
        assert_eq!(retained, 0);
    })
    .await;
}

#[tokio::test]
async fn import_items_persistence_lookup_and_rollback_are_closed() {
    use crate::test_support::{authenticated_json_headers, seed_user, with_api_test_app};
    use axum::http::Method;
    use serde_json::{json, Value};
    use sqlx::{query, query_scalar};

    with_api_test_app("import_items_outcome_foundation", |app| async move {
        let user_id = "import_items_outcome_user";
        seed_user(
            &app.pool,
            user_id,
            "Import Items Outcome User",
            "import-items-outcome@example.com",
        )
        .await;
        let other_user_id = "import_items_outcome_other_user";
        seed_user(
            &app.pool,
            other_user_id,
            "Import Items Outcome Other User",
            "import-items-outcome-other@example.com",
        )
        .await;

        for (index, imported_count) in [0, 200].into_iter().enumerate() {
            query("INSERT INTO operation_outcome (user_id, operation_id, operation_kind, request_fingerprint, result_status, applied_payload) VALUES ($1, $2, 'import_items', $3, 'applied', $4)")
                .bind(user_id)
                .bind(format!("applied-import-{index}"))
                .bind(vec![index as u8; 32])
                .bind(json!({ "vaultId": "vault_1", "importedCount": imported_count }))
                .execute(&app.pool)
                .await
                .expect("the exact Import payload should be retained");
        }
        query("INSERT INTO operation_outcome (user_id, operation_id, operation_kind, request_fingerprint, result_status, applied_payload) VALUES ($1, 'applied-import-0', 'import_items', $2, 'applied', $3)")
            .bind(other_user_id)
            .bind(vec![8_u8; 32])
            .bind(json!({ "vaultId": "vault_other", "importedCount": 17 }))
            .execute(&app.pool)
            .await
            .expect("the same Operation ID remains scoped to the other User");
        for (index, code) in [
            "invalid_ciphertext",
            "vault_access_denied",
            "vault_read_only",
            "item_id_conflict",
        ]
        .into_iter()
        .enumerate()
        {
            query("INSERT INTO operation_outcome (user_id, operation_id, operation_kind, request_fingerprint, result_status, rejection_code) VALUES ($1, $2, 'import_items', $3, 'rejected', $4::operation_rejection_code)")
                .bind(user_id)
                .bind(format!("rejected-import-{index}"))
                .bind(vec![(index + 2) as u8; 32])
                .bind(code)
                .execute(&app.pool)
                .await
                .expect("each closed Import rejection should be retained");
        }

        let session = app.issue_session(user_id).await;
        for (operation_id, expected) in [
            (
                "applied-import-0",
                json!({
                    "kind": "import_items",
                    "operationId": "applied-import-0",
                    "result": { "status": "applied", "vaultId": "vault_1", "importedCount": 0 }
                }),
            ),
            (
                "rejected-import-2",
                json!({
                    "kind": "import_items",
                    "operationId": "rejected-import-2",
                    "result": { "status": "rejected", "code": "vault_read_only" }
                }),
            ),
        ] {
            let response = app
                .api_json(
                    Method::GET,
                    &format!("/api/v1/operations/{operation_id}"),
                    None,
                    authenticated_json_headers(&session.token),
                )
                .await;
            response.assert_contract_status();
            assert_eq!(response.body, expected);
        }
        let other_session = app.issue_session(other_user_id).await;
        let other_response = app
            .api_json(
                Method::GET,
                "/api/v1/operations/applied-import-0",
                None,
                authenticated_json_headers(&other_session.token),
            )
            .await;
        other_response.assert_contract_status();
        assert_eq!(
            other_response.body,
            json!({
                "kind": "import_items",
                "operationId": "applied-import-0",
                "result": { "status": "applied", "vaultId": "vault_other", "importedCount": 17 }
            })
        );

        for (index, payload) in [
            Value::Null,
            json!({}),
            json!({ "vaultId": "vault_1" }),
            json!({ "vaultId": "vault_1", "importedCount": -1 }),
            json!({ "vaultId": "vault_1", "importedCount": 1.5 }),
            json!({ "vaultId": "vault_1", "importedCount": 201 }),
            json!({ "vaultId": 1, "importedCount": 1 }),
            json!({ "vaultId": "vault_1", "importedCount": 1, "extra": true }),
            json!({ "itemId": "item_1", "version": 1 }),
        ]
        .into_iter()
        .enumerate()
        {
            let result = query("INSERT INTO operation_outcome (user_id, operation_id, operation_kind, request_fingerprint, result_status, applied_payload) VALUES ($1, $2, 'import_items', $3, 'applied', $4)")
                .bind(user_id)
                .bind(format!("malformed-import-{index}"))
                .bind(vec![(index + 9) as u8; 32])
                .bind(payload)
                .execute(&app.pool)
                .await;
            assert!(result.is_err(), "malformed Import payload {index} was retained");
        }
        for (operation_id, kind, code) in [
            ("foreign-import-code", "import_items", "item_not_found"),
            ("import-code-on-vault", "create_vault", "vault_access_denied"),
            ("import-code-on-share", "create_share", "vault_access_denied"),
        ] {
            let result = query("INSERT INTO operation_outcome (user_id, operation_id, operation_kind, request_fingerprint, result_status, rejection_code) VALUES ($1, $2, $3::operation_kind, $4, 'rejected', $5::operation_rejection_code)")
                .bind(user_id)
                .bind(operation_id)
                .bind(kind)
                .bind(vec![20_u8; 32])
                .bind(code)
                .execute(&app.pool)
                .await;
            assert!(result.is_err(), "cross-kind rejection {operation_id} was retained");
        }

        let mut transaction = app.pool.begin().await.expect("transaction should begin");
        query("INSERT INTO operation_outcome (user_id, operation_id, operation_kind, request_fingerprint, result_status, applied_payload) VALUES ($1, 'rolled-back-import', 'import_items', $2, 'applied', $3)")
            .bind(user_id)
            .bind(vec![21_u8; 32])
            .bind(json!({ "vaultId": "vault_1", "importedCount": 1 }))
            .execute(&mut *transaction)
            .await
            .expect("valid row should enter the uncommitted transaction");
        let invalid = query("INSERT INTO operation_outcome (user_id, operation_id, operation_kind, request_fingerprint, result_status, applied_payload) VALUES ($1, 'forces-import-rollback', 'import_items', $2, 'applied', $3)")
            .bind(user_id)
            .bind(vec![22_u8; 32])
            .bind(json!({ "vaultId": "vault_1", "importedCount": 1, "foreign": true }))
            .execute(&mut *transaction)
            .await;
        assert!(invalid.is_err());
        transaction.rollback().await.expect("rollback should succeed");
        let retained: i64 = query_scalar("SELECT COUNT(*)::bigint FROM operation_outcome WHERE user_id = $1 AND operation_id = 'rolled-back-import'")
            .bind(user_id)
            .fetch_one(&app.pool)
            .await
            .expect("rollback probe should load");
        assert_eq!(retained, 0);
    })
    .await;
}
