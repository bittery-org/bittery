use super::*;

const CASES: [(&str, Option<bool>, bool); 8] = [
    ("toggle_favorite", Some(true), false),
    ("toggle_favorite", Some(false), false),
    ("toggle_favorite", None, false),
    ("delete", None, false),
    ("restore", None, false),
    ("restore", None, true),
    ("permanent_delete", None, false),
    ("permanent_delete", None, true),
];

pub(super) fn metadata_source(kind: &str, favorite: Option<bool>, trashed: bool) -> Arc<Source> {
    let mut source = queued_update::source_with_queued_update();
    let inner = &mut Arc::get_mut(&mut source).unwrap().inner;
    let mut sync: Value = serde_json::from_str(inner.sync.as_ref().unwrap()).unwrap();
    let mut queues: Value =
        serde_json::from_str(sync["bittery_pending_mutation_queues_v3"].as_str().unwrap()).unwrap();
    let command = &mut queues[desktop::ACCOUNT][0];
    command["type"] = json!(kind);
    command["id"] = json!("source-command:metadata");
    command["operationId"] = json!("semantic:metadata");
    command["attemptId"] = json!("attempt:metadata");
    command.as_object_mut().unwrap().remove("encryptedPayload");
    if let Some(favorite) = favorite {
        command["favorite"] = json!(favorite);
    }
    if kind == "toggle_favorite" && favorite.is_none() {
        command.as_object_mut().unwrap().remove("attemptId");
        command.as_object_mut().unwrap().remove("status");
    }
    sync["bittery_pending_mutation_queues_v3"] = json!(queues.to_string());
    inner.sync = Some(sync.to_string());
    if trashed {
        let mut store: Value = serde_json::from_str(&inner.store).unwrap();
        let key = store
            .as_object()
            .unwrap()
            .keys()
            .find(|key| key.ends_with(":items:item:offline"))
            .unwrap()
            .clone();
        let mut item: Value = serde_json::from_str(store[&key].as_str().unwrap()).unwrap();
        item["deletedAt"] = json!("2026-09-20T01:00:00Z");
        store[&key] = json!(item.to_string());
        inner.store = store.to_string();
    }
    source
}

#[tokio::test]
async fn metadata_commands_preserve_legacy_projection_and_requests_across_locked_restart() {
    for (kind, favorite, trashed) in CASES {
        let directory = TestDirectory::new();
        let platform = Arc::new(RetainingPlatform::default());
        let source = metadata_source(kind, favorite, trashed);
        let runtime =
            runtime_with_platform_and_source(&directory, platform.clone(), source.clone()).await;
        runtime.open().await.unwrap();
        assert_locked(&runtime);
        runtime.close().await;
        let calls = source.calls.lock().unwrap().len();
        let restarted = Runtime::with_serialized_executors(
            Arc::new(SqliteReplica::open(directory.0.join("replica.sqlite")).unwrap()),
            platform,
            Arc::new(NoNetwork),
        );
        restarted.open().await.unwrap();
        assert_locked(&restarted);
        restarted.close().await;
        assert_eq!(source.calls.lock().unwrap().len(), calls);
        let replica = SqliteReplica::open(directory.0.join("replica.sqlite")).unwrap();
        let loaded = SerializedReplicaExecutor::invoke(
            &replica,
            json!({"type":"load", "accountId":desktop::ACCOUNT}).to_string(),
        )
        .await
        .unwrap();
        let loaded: Value = serde_json::from_str(&loaded).unwrap();
        let row = |store: &str| -> Value {
            serde_json::from_str(
                loaded["rows"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .find(|row| row["store"] == store)
                    .unwrap()["payloadJson"]
                    .as_str()
                    .unwrap(),
            )
            .unwrap()
        };
        let operation = row("operations");
        let authority = row("authorityItems");
        let overlay = row("optimisticItems");
        let wire_id = if kind == "toggle_favorite" && favorite.is_none() {
            "source-command:metadata"
        } else {
            "attempt:metadata"
        };
        assert_eq!(operation["operationId"], wire_id);
        assert_eq!(
            operation["legacyAdmission"]["sourceCommand"]["operationId"],
            "semantic:metadata"
        );
        assert_eq!(
            operation["legacyAdmission"]["sourceCommand"]
                .get("favorite")
                .cloned(),
            favorite.map(Value::Bool)
        );
        let (method, suffix, operation_kind) = match kind {
            "toggle_favorite" => ("PATCH", "/favorite", "set_item_favorite"),
            "delete" => ("DELETE", "", "trash_item"),
            "restore" => ("POST", "/restore", "restore_item"),
            "permanent_delete" => ("DELETE", "/permanent", "permanently_delete_item"),
            _ => unreachable!(),
        };
        assert_eq!(operation["kind"], operation_kind);
        assert_eq!(operation["request"]["method"], method);
        assert_eq!(
            operation["request"]["path"],
            format!("/api/v1/items/item%3Aoffline{suffix}")
        );
        let mut headers = Vec::new();
        if kind == "toggle_favorite" {
            headers.push(json!({"name":"Content-Type", "value":"application/merge-patch+json"}));
        }
        headers.push(json!({"name":"If-Match", "value":"\"6\""}));
        assert_eq!(operation["request"]["headers"], json!(headers));
        let body = if kind == "toggle_favorite" {
            format!("{{\"favorite\":{}}}", favorite.unwrap_or(false)).into_bytes()
        } else {
            Vec::new()
        };
        assert_eq!(operation["request"]["body"], json!(body));
        assert_eq!(authority["version"], 6);
        assert_eq!(authority["encryptionVersion"], 3);
        assert_eq!(authority["favorite"], true);
        assert_eq!(
            authority["deletedAt"],
            if trashed {
                json!("2026-09-20T01:00:00Z")
            } else {
                Value::Null
            }
        );
        let mut expected = authority.clone();
        let fields = expected.as_object_mut().unwrap();
        let item_id = fields.remove("id").unwrap();
        fields.insert("itemId".into(), item_id);
        fields.remove("lastModifiedBy");
        fields.insert("accountId".into(), json!(desktop::ACCOUNT));
        fields.insert("operationId".into(), json!(wire_id));
        fields.insert("permanentlyDeleted".into(), json!(false));
        if kind != "permanent_delete" {
            expected["updatedAt"] = json!("2023-11-14T22:13:22Z");
        }
        match kind {
            "toggle_favorite" => expected["favorite"] = json!(favorite.unwrap_or(false)),
            "delete" => expected["deletedAt"] = json!("2023-11-14T22:13:22Z"),
            "restore" => expected["deletedAt"] = Value::Null,
            "permanent_delete" => {}
            _ => unreachable!(),
        }
        assert_eq!(overlay, expected, "{kind} {favorite:?} {trashed}");
    }
}

#[tokio::test]
async fn metadata_commands_refuse_malformed_or_unrepresented_sources_before_preparing() {
    for kind in ["toggle_favorite", "delete", "restore", "permanent_delete"] {
        for fault in [
            "base",
            "payload",
            "category",
            "favoriteNull",
            "target",
            "readOnly",
            "deletedBase",
        ] {
            if fault == "deletedBase" && matches!(kind, "restore" | "permanent_delete") {
                continue;
            }
            let directory = TestDirectory::new();
            let platform = Arc::new(RetainingPlatform::default());
            let mut source = metadata_source(kind, None, fault == "deletedBase");
            let inner = &mut Arc::get_mut(&mut source).unwrap().inner;
            let mut sync: Value = serde_json::from_str(inner.sync.as_ref().unwrap()).unwrap();
            let mut queues: Value =
                serde_json::from_str(sync["bittery_pending_mutation_queues_v3"].as_str().unwrap())
                    .unwrap();
            let command = &mut queues[desktop::ACCOUNT][0];
            match fault {
                "base" => command["baseVersion"] = json!(5),
                "payload" => {
                    command["encryptedPayload"] = json!({"encryptedData":"ciphertext", "encryptionIv":"iv", "encryptionAlgorithm":"AES-GCM-AAD-V1", "encryptionVersion":3, "encryptedByUserId":"original-user"})
                }
                "category" => command["category"] = json!("login"),
                "favoriteNull" => command["favorite"] = Value::Null,
                "target" => command["targetVaultId"] = json!("other"),
                "readOnly" => {
                    let mut keys: Value =
                        serde_json::from_str(inner.credentials[4].as_ref().unwrap()).unwrap();
                    keys[0]["role"] = json!("read-only");
                    inner.credentials[4] = Some(keys.to_string());
                }
                "deletedBase" => {}
                _ => unreachable!(),
            }
            sync["bittery_pending_mutation_queues_v3"] = json!(queues.to_string());
            inner.sync = Some(sync.to_string());
            let runtime =
                runtime_with_platform_and_source(&directory, platform.clone(), source).await;
            assert!(runtime.open().await.is_err(), "{kind} {fault}");
            assert!(platform.sets.lock().unwrap().is_empty(), "{kind} {fault}");
            runtime.close().await;
        }
    }
}
