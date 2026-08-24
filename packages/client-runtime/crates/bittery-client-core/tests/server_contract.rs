use bittery_client_core::server_contract::{ErrorCode, ItemOperationResult, OperationOutcome};
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
fn all_caps_openapi_enums_keep_wire_spelling_without_invalid_rust_names() {
    let code: ErrorCode = serde_json::from_str("\"INTERNAL_ERROR\"").unwrap();
    assert!(matches!(code, ErrorCode::InternalError));
    assert_eq!(serde_json::to_string(&code).unwrap(), "\"INTERNAL_ERROR\"");
}
