use super::*;

pub(super) fn move_source(same_vault: bool, attachments: bool) -> Arc<Source> {
    let mut source = queued_update::source_with_queued_update();
    let inner = &mut Arc::get_mut(&mut source).unwrap().inner;
    let mut sync: Value = serde_json::from_str(inner.sync.as_ref().unwrap()).unwrap();
    let mut queues: Value =
        serde_json::from_str(sync["bittery_pending_mutation_queues_v3"].as_str().unwrap()).unwrap();
    let command = &mut queues[desktop::ACCOUNT][0];
    command["type"] = json!("move");
    command["targetVaultId"] = json!(if same_vault {
        "vault:offline"
    } else {
        "vault:target"
    });
    command["id"] = json!("source-command:move");
    command["operationId"] = json!("semantic:move");
    command["attemptId"] = json!("attempt:move");
    if same_vault {
        command.as_object_mut().unwrap().remove("attemptId");
    }
    sync["bittery_pending_mutation_queues_v3"] = json!(queues.to_string());
    inner.sync = Some(sync.to_string());
    let mut store: Value = serde_json::from_str(&inner.store).unwrap();
    let prefix = format!(
        "record:item-cache-stage:{}:source-generation:",
        desktop::ACCOUNT
    );
    if !same_vault {
        let mut vault: Value = serde_json::from_str(
            store[format!("{prefix}vaults:vault:offline")]
                .as_str()
                .unwrap(),
        )
        .unwrap();
        vault["id"] = json!("vault:target");
        vault["name"] = json!("Target Vault");
        store[format!("{prefix}vaults:vault:target")] = json!(vault.to_string());
        let mut keys: Vec<Value> =
            serde_json::from_str(inner.credentials[4].as_ref().unwrap()).unwrap();
        let mut target = keys[0].clone();
        target["vaultId"] = json!("vault:target");
        target["vaultName"] = json!("Target Vault");
        target["encryptedVaultKey"] = json!("wrapped-target-key");
        keys.push(target);
        inner.credentials[4] = Some(serde_json::to_string(&keys).unwrap());
    }
    if !attachments {
        let key = format!("{prefix}items:item:offline");
        let mut item: Value = serde_json::from_str(store[&key].as_str().unwrap()).unwrap();
        item["attachments"] = json!([]);
        store[&key] = json!(item.to_string());
    }
    inner.store = store.to_string();
    source
}

#[tokio::test]
async fn move_commands_keep_source_authority_and_attachment_bindings_across_locked_restart() {
    for same_vault in [false, true] {
        for attachments in [false, true] {
            let directory = TestDirectory::new();
            let platform = Arc::new(RetainingPlatform::default());
            let source = move_source(same_vault, attachments);
            let runtime =
                runtime_with_platform_and_source(&directory, platform.clone(), source.clone())
                    .await;
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
            let authority = row("authorityItems");
            let overlay = row("optimisticItems");
            let operation = row("operations");
            let target = if same_vault {
                "vault:offline"
            } else {
                "vault:target"
            };
            let wire_id = if same_vault {
                "source-command:move"
            } else {
                "attempt:move"
            };
            assert_eq!(operation["operationId"], wire_id);
            assert_eq!(operation["kind"], "move_item");
            assert_eq!(operation["target"]["vaultId"], target);
            assert_eq!(
                operation["legacyAdmission"]["sourceCommand"]["vaultId"],
                "vault:offline"
            );
            assert_eq!(operation["request"]["method"], "POST");
            assert_eq!(
                operation["request"]["path"],
                "/api/v1/items/item%3Aoffline/moves"
            );
            assert_eq!(
                operation["request"]["headers"],
                json!([{"name":"Content-Type", "value":"application/json"}, {"name":"If-Match", "value":"\"6\""}])
            );
            let expected_body = format!("{{\"mode\":\"prepared\",\"sourceVaultId\":\"vault:offline\",\"targetVaultId\":\"{target}\",\"encryptedData\":\"updated-ciphertext\",\"encryptionIv\":\"updated-iv\",\"encryptionAlgorithm\":\"AES-GCM-AAD-V1\"}}").into_bytes();
            assert_eq!(operation["request"]["body"], json!(expected_body));
            assert_eq!(authority["vaultId"], "vault:offline");
            assert_eq!(authority["version"], 6);
            assert_eq!(authority["encryptionVersion"], 3);
            assert_eq!(authority["encryptedData"], "offline-ciphertext");
            let mut expected = authority.clone();
            let fields = expected.as_object_mut().unwrap();
            let item_id = fields.remove("id").unwrap();
            fields.insert("itemId".into(), item_id);
            fields.remove("lastModifiedBy");
            fields.insert("accountId".into(), json!(desktop::ACCOUNT));
            fields.insert("operationId".into(), json!(wire_id));
            fields.insert("permanentlyDeleted".into(), json!(false));
            expected["vaultId"] = json!(target);
            expected["version"] = json!(7);
            expected["encryptionVersion"] = json!(7);
            expected["encryptedData"] = json!("updated-ciphertext");
            expected["encryptionIv"] = json!("updated-iv");
            expected["updatedAt"] = json!("2023-11-14T22:13:22Z");
            assert_eq!(overlay, expected);
            if attachments {
                assert_eq!(overlay["attachments"][0]["vaultId"], "vault:offline");
            }
        }
    }
}

#[tokio::test]
async fn move_commands_refuse_missing_scope_or_attachment_evidence_before_preparing() {
    for fault in [
        "missingTarget",
        "readOnlySource",
        "readOnlyTarget",
        "payloadVersion",
        "crossAccount",
        "missingAttachmentKey",
        "attachmentScope",
        "duplicateAttachment",
        "trashedSource",
    ] {
        let directory = TestDirectory::new();
        let platform = Arc::new(RetainingPlatform::default());
        let mut source = move_source(false, true);
        let inner = &mut Arc::get_mut(&mut source).unwrap().inner;
        let mut store: Value = serde_json::from_str(&inner.store).unwrap();
        let prefix = format!(
            "record:item-cache-stage:{}:source-generation:",
            desktop::ACCOUNT
        );
        let item_key = format!("{prefix}items:item:offline");
        let mut item: Value = serde_json::from_str(store[&item_key].as_str().unwrap()).unwrap();
        match fault {
            "missingTarget" => {
                store
                    .as_object_mut()
                    .unwrap()
                    .remove(&format!("{prefix}vaults:vault:target"));
            }
            "readOnlySource" | "readOnlyTarget" => {
                let mut keys: Value =
                    serde_json::from_str(inner.credentials[4].as_ref().unwrap()).unwrap();
                keys[if fault == "readOnlySource" { 0 } else { 1 }]["role"] = json!("read-only");
                inner.credentials[4] = Some(keys.to_string());
            }
            "payloadVersion" | "crossAccount" => {
                let mut sync: Value = serde_json::from_str(inner.sync.as_ref().unwrap()).unwrap();
                let mut queues: Value = serde_json::from_str(
                    sync["bittery_pending_mutation_queues_v3"].as_str().unwrap(),
                )
                .unwrap();
                if fault == "payloadVersion" {
                    queues[desktop::ACCOUNT][0]["encryptedPayload"]["encryptionVersion"] = json!(4);
                } else {
                    queues[desktop::ACCOUNT][0]["targetAccountId"] = json!("another-account");
                }
                sync["bittery_pending_mutation_queues_v3"] = json!(queues.to_string());
                inner.sync = Some(sync.to_string());
            }
            "missingAttachmentKey" => {
                item["attachments"][0]
                    .as_object_mut()
                    .unwrap()
                    .remove("encryptedAttachmentKey");
            }
            "attachmentScope" => item["attachments"][0]["vaultId"] = json!("vault:target"),
            "duplicateAttachment" => {
                let attachment = item["attachments"][0].clone();
                item["attachments"].as_array_mut().unwrap().push(attachment);
            }
            "trashedSource" => item["deletedAt"] = json!("2026-09-20T00:00:00Z"),
            _ => unreachable!(),
        }
        store[&item_key] = json!(item.to_string());
        inner.store = store.to_string();
        let runtime = runtime_with_platform_and_source(&directory, platform.clone(), source).await;
        assert!(runtime.open().await.is_err(), "{fault}");
        assert!(platform.sets.lock().unwrap().is_empty(), "{fault}");
        runtime.close().await;
    }
}
