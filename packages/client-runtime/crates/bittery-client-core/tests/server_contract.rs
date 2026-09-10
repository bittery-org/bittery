use bittery_client_core::server_contract::{
    ErrorCode, ItemOperationResult, OperationOutcome, VaultImageContentType,
    VaultImageStagingStatusResponse,
};
use serde_json::json;

#[test]
fn tagged_operation_result_round_trips_exact_camel_case_wire_fields() {
    let wire = json!({"status": "applied", "itemId": "item-1", "version": 7});
    let result: ItemOperationResult = serde_json::from_value(wire.clone()).unwrap();
    match &result {
        ItemOperationResult::Applied { item_id, version } => {
            assert_eq!(item_id, "item-1");
            assert_eq!(*version, 7);
        }
        ItemOperationResult::Rejected { .. } => panic!("expected applied outcome"),
    }
    assert_eq!(serde_json::to_value(result).unwrap(), wire);
}

/// The lookup route answers one union tagged on `kind`, and a kind this Runtime does not know is
/// a parse failure rather than another kind's answer read by accident.
#[test]
fn the_operation_outcome_union_is_discriminated_by_kind() {
    let wire = json!({
        "kind": "trash_item",
        "operationId": "operation-1",
        "result": {"status": "applied", "itemId": "item-1", "version": 2},
    });
    let outcome: OperationOutcome = serde_json::from_value(wire.clone()).unwrap();
    assert!(matches!(outcome, OperationOutcome::TrashItem { .. }));
    assert_eq!(serde_json::to_value(&outcome).unwrap(), wire);

    let unknown = json!({
        "kind": "rotate_vault_key",
        "operationId": "operation-1",
        "result": {"status": "applied", "itemId": "item-1", "version": 2},
    });
    assert!(serde_json::from_value::<OperationOutcome>(unknown).is_err());
}

#[test]
fn import_items_outcomes_parse_only_the_closed_generated_wire_shape() {
    use bittery_client_core::server_contract::{
        ImportItemsOperationRejectionCode, ImportItemsOperationResult,
    };

    let applied = json!({
        "kind": "import_items",
        "operationId": "operation-1",
        "result": {"status": "applied", "vaultId": "vault-1", "importedCount": 0},
    });
    let outcome: OperationOutcome = serde_json::from_value(applied.clone()).unwrap();
    assert!(matches!(
        &outcome,
        OperationOutcome::ImportItems {
            result: ImportItemsOperationResult::Applied {
                imported_count: 0,
                ..
            },
            ..
        }
    ));
    assert_eq!(serde_json::to_value(outcome).unwrap(), applied);

    let rejected: ImportItemsOperationResult = serde_json::from_value(json!({
        "status": "rejected",
        "code": "item_id_conflict"
    }))
    .unwrap();
    assert!(matches!(
        rejected,
        ImportItemsOperationResult::Rejected {
            code: ImportItemsOperationRejectionCode::ItemIdConflict
        }
    ));

    for malformed in [
        json!({"kind": "import_items", "operationId": "operation-1", "result": {"status": "applied", "vaultId": "vault-1"}}),
        json!({"kind": "import_items", "operationId": "operation-1", "result": {"status": "applied", "vaultId": "vault-1", "importedCount": 0, "extra": true}}),
        json!({"kind": "import_items", "operationId": "operation-1", "result": {"status": "rejected", "code": "item_not_found"}}),
        json!({"kind": "create_vault", "operationId": "operation-1", "result": {"status": "applied", "vaultId": "vault-1", "importedCount": 0}}),
    ] {
        assert!(serde_json::from_value::<OperationOutcome>(malformed).is_err());
    }
}

#[test]
fn all_caps_openapi_enums_keep_wire_spelling_without_invalid_rust_names() {
    let code: ErrorCode = serde_json::from_str("\"INTERNAL_ERROR\"").unwrap();
    assert!(matches!(code, ErrorCode::InternalError));
    assert_eq!(serde_json::to_string(&code).unwrap(), "\"INTERNAL_ERROR\"");
}

#[test]
fn vault_image_staging_closed_values_round_trip_and_reject_impossible_wire_shapes() {
    for mime in [
        "image/jpeg",
        "image/png",
        "image/webp",
        "image/gif",
        "image/avif",
    ] {
        let value: VaultImageContentType = serde_json::from_value(json!(mime)).unwrap();
        assert_eq!(serde_json::to_value(value).unwrap(), json!(mime));
    }
    assert!(serde_json::from_value::<VaultImageContentType>(json!("image/svg+xml")).is_err());

    let authority = json!({
        "objectKey": "vaults/image",
        "generation": 1,
        "leaseExpiresAt": "2026-08-31T12:00:00Z",
    });
    for state in ["absent", "unconfirmed", "confirmed", "cleanup_pending"] {
        let wire = if state == "absent" {
            json!({"state": state})
        } else {
            let mut value = authority.clone();
            value["state"] = json!(state);
            value
        };
        let status: VaultImageStagingStatusResponse = serde_json::from_value(wire.clone()).unwrap();
        assert_eq!(serde_json::to_value(status).unwrap(), wire);
    }
    for impossible in [
        json!({"state": "unknown"}),
        json!({"state": "absent", "objectKey": "vaults/image"}),
        json!({"state": "confirmed"}),
    ] {
        assert!(serde_json::from_value::<VaultImageStagingStatusResponse>(impossible).is_err());
    }
}

#[test]
fn rotation_outcomes_round_trip_closed_creation_finalization_and_per_kind_rejections() {
    for (suffix, create_rejection, final_rejection) in [
        (
            "vault_member_removal_rotation_plans",
            "vault_member_not_found",
            "vault_membership_changed",
        ),
        (
            "team_leave_rotation_plans",
            "team_member_not_found",
            "team_membership_changed",
        ),
        (
            "team_member_removal_rotation_plans",
            "team_member_not_found",
            "team_membership_changed",
        ),
    ] {
        for stage in ["create", "finalize"] {
            let kind = format!("{stage}_{suffix}");
            let applied = if stage == "create" {
                json!({"status":"applied","plans":[{"id":"plan-1","vaultId":"vault-1","initiatorUserId":"actor","expectedKeyVersion":2,"state":"preparing","idleExpiresAt":"2026-09-07T12:00:00Z","absoluteExpiresAt":"2026-09-08T12:00:00Z"}]})
            } else {
                let mut value = json!({"status":"applied","rotations":[{"planId":"plan-1","vaultId":"vault-1","keyVersion":3,"rotationId":"rotation-1"}]});
                if suffix.starts_with("team_") {
                    value["personalTeamId"] = json!("personal-1");
                }
                value
            };
            let rejected = json!({"status":"rejected","code":if stage == "create" {create_rejection} else {final_rejection}});
            for result in [applied.clone(), rejected.clone()] {
                let wire = json!({"operationId":"operation-1","kind":kind,"result":result});
                let decoded: OperationOutcome = serde_json::from_value(wire.clone()).unwrap();
                // Generated optional fields use Option: a missing detail decodes as None and
                // serializes as null. The Runtime only reads these Server response DTOs.
                let mut expected = wire;
                if stage == "finalize" && result["status"] == "rejected" {
                    expected["result"]["details"] = serde_json::Value::Null;
                }
                assert_eq!(serde_json::to_value(decoded).unwrap(), expected);
            }
            let mut invalid = json!({"operationId":"operation-1","kind":kind,"result":rejected});
            invalid["result"]["code"] = json!(if stage == "create" {
                final_rejection
            } else {
                create_rejection
            });
            assert!(serde_json::from_value::<OperationOutcome>(invalid).is_err());
            let mut extra = json!({"operationId":"operation-1","kind":kind,"result":applied});
            extra["result"]["responseBytes"] = json!("opaque");
            assert!(serde_json::from_value::<OperationOutcome>(extra).is_err());
            if stage == "finalize" {
                let stale = json!({"operationId":"operation-1","kind":kind,"result":{"status":"rejected","code":"rotation_plan_stale","details":{"planId":"plan-1","reason":"item_state"}}});
                let decoded: OperationOutcome = serde_json::from_value(stale.clone()).unwrap();
                assert_eq!(serde_json::to_value(decoded).unwrap(), stale);
                let mut invalid = stale;
                invalid["result"]["details"]["reason"] = json!("future_reason");
                assert!(serde_json::from_value::<OperationOutcome>(invalid).is_err());
            }
        }
    }
}
