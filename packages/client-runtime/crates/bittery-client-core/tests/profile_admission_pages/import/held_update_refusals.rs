use super::held_update::{
    held_update_source, mutate_cached_item, mutate_queue, set_source_vault_role,
};
use super::*;

fn remove_cached_row(source: &mut Arc<Source>, suffix: &str) {
    let fixture = Arc::get_mut(source).unwrap();
    let mut store: Value = serde_json::from_str(&fixture.inner.store).unwrap();
    let key = store
        .as_object()
        .unwrap()
        .keys()
        .find(|key| key.ends_with(suffix))
        .unwrap()
        .clone();
    store.as_object_mut().unwrap().remove(&key);
    if suffix == ":items:item:offline" {
        let metadata_key = store
            .as_object()
            .unwrap()
            .keys()
            .find(|key| key.ends_with(":meta:meta"))
            .unwrap()
            .clone();
        let mut metadata: Value =
            serde_json::from_str(store[&metadata_key].as_str().unwrap()).unwrap();
        metadata["metadata"]["itemCount"] = json!(0);
        store[metadata_key] = json!(metadata.to_string());
    }
    fixture.inner.store = store.to_string();
}

async fn replica_evidence(directory: &TestDirectory) -> Value {
    let replica = SqliteReplica::open(directory.0.join("replica.sqlite")).unwrap();
    serde_json::from_str(
        &SerializedReplicaExecutor::invoke(
            &replica,
            json!({"type":"load","accountId":desktop::ACCOUNT}).to_string(),
        )
        .await
        .unwrap(),
    )
    .unwrap()
}

async fn refuses_without_staging(source: Arc<Source>, case: &str) {
    let directory = TestDirectory::new();
    let platform = Arc::new(RetainingPlatform::default());
    platform.values.lock().unwrap().insert(
        (
            "deviceSecret".into(),
            "unrelated-protected-reference".into(),
        ),
        "unchanged protected evidence".into(),
    );
    let protected_before = platform.values.lock().unwrap().clone();
    let replica_before = replica_evidence(&directory).await;
    let store_before = source.inner.store.clone();
    let sync_before = source.inner.sync.clone();
    let credentials_before = source.inner.credentials.clone();
    let runtime =
        runtime_with_platform_and_source(&directory, platform.clone(), source.clone()).await;
    let error = runtime.open().await.expect_err(case);
    assert_eq!(
        error.code,
        if case.ends_with("/missingVault") || case.ends_with("/missingKey") {
            RuntimeErrorCode::InvariantViolation
        } else {
            RuntimeErrorCode::SourceFailure
        },
        "{case}"
    );
    if case.ends_with("/missingItem") {
        assert_eq!(
            error.message, "Legacy Item command has no cached base",
            "{case}"
        );
    } else if ["/higherBase", "/lowerBase", "/deletedBase", "/movedVault"]
        .iter()
        .any(|suffix| case.ends_with(suffix))
    {
        assert_eq!(
            error.message, "Legacy Item command does not match its cached base",
            "{case}"
        );
    }
    assert!(platform.sets.lock().unwrap().is_empty(), "{case}");
    assert_eq!(*platform.values.lock().unwrap(), protected_before, "{case}");
    assert_eq!(replica_evidence(&directory).await, replica_before, "{case}");
    assert_eq!(source.inner.store, store_before, "{case}");
    assert_eq!(source.inner.sync, sync_before, "{case}");
    assert_eq!(source.inner.credentials, credentials_before, "{case}");
    runtime.close().await;
}

#[tokio::test]
async fn held_update_refuses_unproven_base_scope_and_inconsistent_request_before_preparing() {
    for status in ["failed", "conflicted"] {
        for fault in [
            "lowerBase",
            "missingItem",
            "missingVault",
            "missingKey",
            "deletedBase",
            "movedVault",
            "payloadVersion",
            "payloadWriter",
            "missingPayload",
            "category",
            "targetVault",
            "capturedFailureCode",
            "payloadCurrentVersion",
        ] {
            let mut source = held_update_source(status);
            match fault {
                "lowerBase" => mutate_cached_item(&mut source, |item| item["version"] = json!(5)),
                "missingItem" => remove_cached_row(&mut source, ":items:item:offline"),
                "missingVault" => remove_cached_row(&mut source, ":vaults:vault:offline"),
                "missingKey" => {
                    Arc::get_mut(&mut source).unwrap().inner.credentials[4] = Some("[]".into())
                }
                "deletedBase" => mutate_cached_item(&mut source, |item| {
                    item["deletedAt"] = json!("2026-09-20T01:00:00Z")
                }),
                "movedVault" => mutate_queue(&mut source, |queue| {
                    queue[0]["vaultId"] = json!("other-vault")
                }),
                "payloadVersion" => mutate_queue(&mut source, |queue| {
                    queue[0]["encryptedPayload"]["encryptionVersion"] = json!(8)
                }),
                "payloadWriter" => mutate_queue(&mut source, |queue| {
                    queue[0]["encryptedPayload"]["encryptedByUserId"] = json!("other-user")
                }),
                "missingPayload" => mutate_queue(&mut source, |queue| {
                    queue[0].as_object_mut().unwrap().remove("encryptedPayload");
                }),
                "category" => {
                    mutate_queue(&mut source, |queue| queue[0]["category"] = json!("login"))
                }
                "targetVault" => mutate_queue(&mut source, |queue| {
                    queue[0]["targetVaultId"] = json!("target-vault")
                }),
                "capturedFailureCode" => mutate_queue(&mut source, |queue| {
                    queue[0]["capturedFailureCode"] = json!("item_id_conflict")
                }),
                "payloadCurrentVersion" => {
                    mutate_cached_item(&mut source, |item| item["version"] = json!(9));
                    mutate_queue(&mut source, |queue| {
                        queue[0]["encryptedPayload"]["encryptionVersion"] = json!(10)
                    });
                }
                _ => unreachable!(),
            }
            refuses_without_staging(source, &format!("{status}/{fault}")).await;
        }
    }
}

#[tokio::test]
async fn newer_cache_remains_refused_for_normal_update_and_other_held_kinds() {
    let mut normal = queued_update::source_with_queued_update();
    mutate_cached_item(&mut normal, |item| {
        item["version"] = json!(9);
        item["encryptionVersion"] = json!(4);
    });
    refuses_without_staging(normal, "normalUpdate/higherBase").await;

    let mut metadata = queued_metadata::metadata_source("toggle_favorite", Some(true), false);
    mutate_queue(&mut metadata, |queue| queue[0]["status"] = json!("failed"));
    mutate_cached_item(&mut metadata, |item| {
        item["version"] = json!(9);
        item["encryptionVersion"] = json!(4);
    });
    refuses_without_staging(metadata, "heldFavorite/higherBase").await;

    let mut moved = queued_move::move_source(false, true);
    mutate_queue(&mut moved, |queue| queue[0]["status"] = json!("conflicted"));
    mutate_cached_item(&mut moved, |item| {
        item["version"] = json!(9);
        item["encryptionVersion"] = json!(4);
    });
    refuses_without_staging(moved, "heldMove/higherBase").await;
}

#[tokio::test]
async fn normal_update_still_requires_writable_vault_before_preparing() {
    let mut source = queued_update::source_with_queued_update();
    set_source_vault_role(&mut source, "read-only");
    refuses_without_staging(source, "normal ReadOnly Update").await;
}
