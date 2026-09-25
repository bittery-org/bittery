use bittery_client_core::{ProfileAdmissionRequest, ProfileAdmissionResponse};
use serde_json::{json, Value};

fn scope() -> Value {
    json!({"version":1,"format":"desktopLegacyV1","profileIdentity":"profile-object-1","families":[
        {"family":"desktopStore","namespaceIdentity":"store-location-1","selectorPlanVersion":1,"file":{"type":"present","fileIdentity":"file-object-1"}},
        {"family":"desktopSyncStore","namespaceIdentity":"sync-location-1","selectorPlanVersion":1,"file":{"type":"absent"}},
        {"family":"desktopCredentials","namespaceIdentity":"protected-entry-1","selectorPlanVersion":1,"file":{"type":"notFile"}}
    ]})
}
fn prepare(expected: Value) -> Value {
    json!({"type":"prepareLegacyProfileReset","wipeId":"wipe-1","format":"desktopLegacyV1","expectedScope":expected})
}
#[test]
fn reset_controls_bind_independent_scope_and_roundtrip_without_account_payload() {
    for raw in [
        prepare(Value::Null),
        prepare(scope()),
        json!({"type":"resetLegacySourceFamily","resetHandle":"reset-1","wipeId":"wipe-1","family":"desktopCredentials"}),
    ] {
        let request: ProfileAdmissionRequest =
            serde_json::from_value(raw.clone()).expect("closed reset request");
        request.validate().unwrap();
        assert_eq!(serde_json::to_value(request).unwrap(), raw);
    }
    for raw in [
        json!({"type":"profileResetPrepared","result":{"type":"prepared","snapshot":{"resetHandle":"reset-1","wipeId":"wipe-1","scope":scope()}}}),
        json!({"type":"profileResetFamilyResult","resetHandle":"reset-1","wipeId":"wipe-1","family":"desktopStore","result":{"type":"alreadyAbsent"}}),
    ] {
        let response: ProfileAdmissionResponse =
            serde_json::from_value(raw.clone()).expect("closed reset response");
        assert_eq!(serde_json::to_value(response).unwrap(), raw);
    }
}
#[test]
fn reset_scope_refuses_unknown_versions_misordered_families_and_wrong_file_bindings() {
    for path in ["version", "family", "binding", "namespace", "plan"] {
        let mut value = scope();
        match path {
            "version" => value["version"] = json!(2),
            "family" => value["families"].as_array_mut().unwrap().swap(0, 1),
            "binding" => value["families"][0]["file"] = json!({"type":"notFile"}),
            "namespace" => value["families"][1]["namespaceIdentity"] = json!(""),
            "plan" => value["families"][2]["selectorPlanVersion"] = json!(2),
            _ => unreachable!(),
        }
        let result = serde_json::from_value::<ProfileAdmissionRequest>(prepare(value));
        assert!(
            result.is_err() || result.unwrap().validate().is_err(),
            "{path}"
        );
    }
}
#[test]
fn reset_expected_scope_is_required_nullable_and_all_objects_remain_closed() {
    let mut value = prepare(Value::Null);
    value.as_object_mut().unwrap().remove("expectedScope");
    assert!(serde_json::from_value::<ProfileAdmissionRequest>(value).is_err());
    let mut value = prepare(scope());
    value["expectedScope"]["families"][0]["file"] = json!(["present", "file-object-1"]);
    assert!(serde_json::from_value::<ProfileAdmissionRequest>(value).is_err());
    let mut value = prepare(scope());
    value["expectedScope"]["families"][1]["file"]["fileIdentity"] = json!("contradiction");
    assert!(serde_json::from_value::<ProfileAdmissionRequest>(value).is_err());
}
