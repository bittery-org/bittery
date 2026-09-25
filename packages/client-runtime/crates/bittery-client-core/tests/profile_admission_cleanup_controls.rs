use bittery_client_core::{ProfileAdmissionRequest, ProfileAdmissionResponse};
use serde_json::{json, Value};

fn header() -> Value {
    json!({"version":1,"format":"desktopLegacyV1","profileIdentity":"profile",
        "recordedCaptureId":"original-capture","entryCount":"3","entriesSha256":"a".repeat(64)})
}

fn entry() -> Value {
    json!({"version":1,"family":"desktopStore","selector":{"type":"wholeFile"},
        "observation":{"type":"fileBytes","length":"17"},"fileIdentity":"file-identity",
        "evidenceSha256":"b".repeat(64)})
}

fn deletion() -> Value {
    json!({"type":"deleteCapturedSource","snapshotHandle":"cleanup-handle",
        "admissionId":"committed-admission","index":"0","expectedEntry":entry()})
}

#[test]
fn cleanup_controls_separate_committed_delete_authority_from_source_reading() {
    for step in [
        json!({"type":"start","verificationAttemptId":"attempt","admissionId":"committed-admission","header":header()}),
        json!({"type":"entry","verificationCursor":"cursor","index":"0","expectedEntry":entry()}),
        json!({"type":"finish","verificationCursor":"cursor"}),
    ] {
        let value = json!({"type":"reopenSourceForCleanup","step":step});
        let request: ProfileAdmissionRequest = serde_json::from_value(value.clone()).expect(
            "Committed cleanup requires its own bounded control, distinct from source proof",
        );
        request.validate().unwrap();
        assert_eq!(serde_json::to_value(request).unwrap(), value);
    }
    let request: ProfileAdmissionRequest = serde_json::from_value(deletion()).unwrap();
    request.validate().unwrap();
    assert_eq!(serde_json::to_value(request).unwrap(), deletion());

    for result in [
        json!({"type":"started","verificationCursor":"cursor","nextIndex":"0"}),
        json!({"type":"accepted","verificationCursor":"cursor","nextIndex":"1"}),
        json!({"type":"reopened","snapshot":{"format":"desktopLegacyV1",
            "snapshotHandle":"cleanup-handle","captureId":"fresh-capture",
            "profileIdentity":"profile","admissionId":"committed-admission"}}),
        json!({"type":"unavailable"}),
    ] {
        let value = json!({"type":"sourceCleanupReopen","result":result});
        let response: ProfileAdmissionResponse = serde_json::from_value(value.clone()).unwrap();
        assert_eq!(serde_json::to_value(response).unwrap(), value);
    }
    for result in ["deleted", "alreadyAbsent", "changed", "unavailable"] {
        let value = json!({"type":"sourceCleanupResult","snapshotHandle":"cleanup-handle",
            "admissionId":"committed-admission","index":"0","result":{"type":result}});
        let response: ProfileAdmissionResponse = serde_json::from_value(value.clone()).unwrap();
        assert_eq!(serde_json::to_value(response).unwrap(), value);
    }
}

#[test]
fn cleanup_delete_rejects_missing_evidence_and_unbound_controls() {
    let mut missing = deletion();
    missing["expectedEntry"]["observation"] = json!({"type":"missing"});
    missing["expectedEntry"]["fileIdentity"] = Value::Null;
    let request: ProfileAdmissionRequest = serde_json::from_value(missing).unwrap();
    assert!(
        request.validate().is_err(),
        "Missing at capture never authorizes a deletion"
    );
    for field in ["snapshotHandle", "admissionId"] {
        for invalid in ["".to_owned(), "x".repeat(4097)] {
            let mut value = deletion();
            value[field] = json!(invalid);
            let request: ProfileAdmissionRequest = serde_json::from_value(value).unwrap();
            assert!(request.validate().is_err());
        }
    }
    for index in [
        json!(0),
        json!("00"),
        json!("-1"),
        json!("18446744073709551616"),
    ] {
        let mut value = deletion();
        value["index"] = index;
        assert!(serde_json::from_value::<ProfileAdmissionRequest>(value).is_err());
    }
}

#[test]
fn cleanup_controls_reject_unknown_duplicate_and_positional_objects() {
    let mut value = deletion();
    value["path"] = json!("/arbitrary/path");
    assert!(serde_json::from_value::<ProfileAdmissionRequest>(value).is_err());
    let mut value = deletion();
    value["expectedEntry"] = json!([1,"desktopStore",{"type":"wholeFile"},
        {"type":"fileBytes","length":"17"},"file-identity","b".repeat(64)]);
    assert!(serde_json::from_value::<ProfileAdmissionRequest>(value).is_err());
    for invalid in [
        r#"{"type":"sourceCleanupResult","snapshotHandle":"h","admissionId":"a","index":"0","result":{"type":"deleted","path":"bad"}}"#,
        r#"{"type":"sourceCleanupReopen","result":{"type":"unavailable","snapshot":{}}}"#,
        r#"{"type":"sourceCleanupReopen","result":{"type":"reopened","snapshot":["desktopLegacyV1","h","p","c","a"]}}"#,
        r#"{"type":"sourceCleanupResult","snapshotHandle":"h","admissionId":"a","admissionId":"b","index":"0","result":{"type":"deleted"}}"#,
    ] {
        assert!(serde_json::from_str::<ProfileAdmissionResponse>(invalid).is_err());
    }
}
