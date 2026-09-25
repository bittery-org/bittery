//! Later target cache content is retained independently of non-executable original Move evidence.
use super::*;

#[tokio::test]
async fn unavailable_source_preserves_changed_current_target_without_reinterpreting_original_intent(
) {
    let (mut source, command) = acknowledgement_crash_source();
    let oracle = acknowledgement_crash_oracle();
    // This is an explicit alternate valid capture, not a claim about the producer crash output:
    // the destination has subsequently cached a changed Item under the original target ID.
    let mut current = target_item();
    current["category"] = json!("login");
    current["version"] = json!(9);
    current["favorite"] = json!(true);
    current["encryptedData"] = json!("later-destination-ciphertext");
    current["encryptionIv"] = json!("later-destination-iv");
    current["updatedAt"] = json!("2026-09-20T12:00:00Z");
    current["accountEmail"] = oracle["accounts"]
        .as_array()
        .unwrap()
        .iter()
        .find(|account| account["accountId"] == SECOND_ACCOUNT)
        .unwrap()["email"]
        .clone();
    mutate_store(&mut source, |store| {
        let key = format!("record:{SECOND_ACCOUNT}:meta:meta");
        let mut metadata: Value = serde_json::from_str(store[&key].as_str().unwrap()).unwrap();
        let prefix = metadata["nativeView"]["itemsKeyPrefix"]
            .as_str()
            .unwrap()
            .to_owned();
        metadata["metadata"]["itemCount"] = json!(1);
        store[&key] = json!(metadata.to_string());
        store[format!("{prefix}{}", command["targetItemId"].as_str().unwrap())] =
            json!(current.to_string());
    });
    let frozen_store = source.inner.store.clone();
    let frozen_sync = source.inner.sync.clone();
    let directory = TestDirectory::new();
    let platform = Arc::new(RetainingPlatform::default());
    let runtime =
        runtime_with_platform_and_source(&directory, platform.clone(), source.clone()).await;
    runtime.open().await.unwrap();
    assert_two_locked(&runtime);
    let original = snapshot(&directory, desktop::ACCOUNT).await;
    let target = snapshot(&directory, SECOND_ACCOUNT).await;
    for key in ["accountId", "accountEmail", "serverUrl"] {
        current.as_object_mut().unwrap().remove(key);
    }
    assert_eq!(row(&target, "authorityItems"), current);
    let parked = row(&original, "crossAccountMoves");
    assert_eq!(parked["type"], "legacySourceUnavailable");
    assert_eq!(
        parked["legacyAdmission"]["sourceCommand"]["targetItemId"],
        command["targetItemId"]
    );
    let body: Vec<u8> =
        serde_json::from_value(parked["targetCreate"]["request"]["body"].clone()).unwrap();
    let accepted: Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(
        accepted["encryptedData"],
        command["encryptedPayload"]["encryptedData"]
    );
    assert_ne!(accepted["encryptedData"], current["encryptedData"]);
    assert!(parked.get("target").is_none());
    assert!(parked.get("source").is_none());
    assert!(original["rows"]
        .as_array()
        .unwrap()
        .iter()
        .all(|row| row["store"] != "authorityItems"
            && row["store"] != "optimisticItems"
            && row["store"] != "operations"));
    assert!(target["rows"]
        .as_array()
        .unwrap()
        .iter()
        .all(|row| row["store"] != "optimisticItems" && row["store"] != "crossAccountMoves"));
    assert_parked_projection(&runtime, command["operationId"].as_str().unwrap());
    assert_eq!(source.inner.store, frozen_store);
    assert_eq!(source.inner.sync, frozen_sync);
    runtime.close().await;
    let calls = source.calls.lock().unwrap().len();
    let reopened = runtime_with_platform(&directory, platform).await;
    reopened.open().await.unwrap();
    assert_two_locked(&reopened);
    assert_eq!(
        snapshot(&directory, desktop::ACCOUNT).await["rows"],
        original["rows"]
    );
    assert_eq!(
        snapshot(&directory, SECOND_ACCOUNT).await["rows"],
        target["rows"]
    );
    assert_eq!(source.calls.lock().unwrap().len(), calls);
    reopened.close().await;
}
