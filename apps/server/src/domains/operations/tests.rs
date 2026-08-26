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
