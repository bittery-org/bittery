use bittery_client_core::PlatformStorageRequest;
use serde_json::json;

#[test]
fn prefix_deletion_can_preserve_one_exact_marker_without_changing_ordinary_wire() {
    let ordinary = json!({"type":"deletePrefix","area":"devicePlain","prefix":"owned:"});
    let request: PlatformStorageRequest = serde_json::from_value(ordinary.clone()).unwrap();
    assert_eq!(serde_json::to_value(request).unwrap(), ordinary);
    let preserving = json!({"type":"deletePrefix","area":"devicePlain","prefix":"owned:","preserveKey":"owned:catalog"});
    let request: PlatformStorageRequest = serde_json::from_value(preserving.clone())
        .expect("Reset must preserve its durable marker inside prefix deletion");
    assert_eq!(serde_json::to_value(request).unwrap(), preserving);
}

#[test]
fn prefix_preservation_rejects_null_empty_and_fields_on_unrelated_operations() {
    for preserve in [json!(null), json!(""), json!(1), json!(["owned:catalog"])] {
        assert!(serde_json::from_value::<PlatformStorageRequest>(json!({
            "type":"deletePrefix","area":"devicePlain","prefix":"owned:","preserveKey":preserve
        }))
        .is_err());
    }
    for operation in ["get", "delete", "set", "listKeys"] {
        let mut value =
            json!({"type":operation,"area":"devicePlain","preserveKey":"owned:catalog"});
        if operation == "listKeys" {
            value["prefix"] = json!("owned:");
            value["cursor"] = json!(null);
        } else {
            value["key"] = json!("owned:value");
            if operation == "set" {
                value["value"] = json!("value");
            }
        }
        assert!(serde_json::from_value::<PlatformStorageRequest>(value).is_err());
    }
    assert!(serde_json::from_str::<PlatformStorageRequest>(
        r#"{"type":"deletePrefix","area":"devicePlain","prefix":"owned:","preserveKey":"owned:catalog","preserveKey":"other"}"#
    ).is_err());
}
