use bittery_client_core::server_contract::{CreateItemOperationResult, ErrorCode};
use serde_json::json;

#[test]
fn tagged_operation_result_round_trips_exact_camel_case_wire_fields() {
    let wire = json!({"status": "applied", "itemId": "item-1", "version": 7});
    let result: CreateItemOperationResult = serde_json::from_value(wire.clone()).unwrap();
    match &result {
        CreateItemOperationResult::Applied { item_id, version } => {
            assert_eq!(item_id, "item-1");
            assert_eq!(*version, 7);
        }
        CreateItemOperationResult::Rejected { .. } => panic!("expected applied outcome"),
    }
    assert_eq!(serde_json::to_value(result).unwrap(), wire);
}

#[test]
fn all_caps_openapi_enums_keep_wire_spelling_without_invalid_rust_names() {
    let code: ErrorCode = serde_json::from_str("\"INTERNAL_ERROR\"").unwrap();
    assert!(matches!(code, ErrorCode::InternalError));
    assert_eq!(serde_json::to_string(&code).unwrap(), "\"INTERNAL_ERROR\"");
}
