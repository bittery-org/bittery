use super::*;
fn reset(phase: &str) -> Value {
    json!({"kind":"reset","version":1,"wipeId":"wipe-1","revision":"1","phase":phase,
        "scope":{"type":"coreOnly","namespaceVersion":1},"remainingFamilies":[]})
}
#[tokio::test]
async fn wiped_catalog_suppresses_import_and_preserves_empty_owner() {
    let directory = Directory::new();
    let expected = json!({"version":1,"accounts":[],"profileAdmission":reset("wiped")});
    let ports = Ports::seed(expected.to_string());
    let runtime = make_runtime(&directory, ports.clone()).await;
    runtime
        .open()
        .await
        .expect("Wiped is a durable fresh-owner tombstone");
    assert_eq!(ports.catalog(), expected);
    assert!(ports.mutations.lock().unwrap().is_empty());
    runtime.close().await;
}
#[tokio::test]
async fn wiping_catalog_fences_before_any_source_or_ordinary_startup() {
    let directory = Directory::new();
    let expected = json!({"version":1,"accounts":[],"profileAdmission":reset("wiping")});
    let ports = Ports::seed(expected.to_string());
    let runtime = make_runtime(&directory, ports.clone()).await;
    let error = runtime.open().await.unwrap_err();
    assert_eq!(error.message, "Profile reset must finish before startup");
    assert_eq!(ports.catalog(), expected);
    assert!(ports.mutations.lock().unwrap().is_empty());
    runtime.close().await;
}
#[tokio::test]
async fn malformed_reset_scope_cannot_be_a_completed_suppression_marker() {
    for field in ["version", "scope", "remaining", "phase"] {
        let directory = Directory::new();
        let mut record = reset("wiped");
        match field {
            "version" => record["version"] = json!(2),
            "scope" => record["scope"] = Value::Null,
            "remaining" => record["remainingFamilies"] = json!(["desktopStore"]),
            "phase" => record["phase"] = json!("complete"),
            _ => unreachable!(),
        }
        let expected = json!({"version":1,"accounts":[],"profileAdmission":record});
        let ports = Ports::seed(expected.to_string());
        let runtime = make_runtime(&directory, ports.clone()).await;
        assert!(runtime.open().await.is_err());
        assert_eq!(ports.catalog(), expected);
        assert!(ports.mutations.lock().unwrap().is_empty());
        runtime.close().await;
    }
}
