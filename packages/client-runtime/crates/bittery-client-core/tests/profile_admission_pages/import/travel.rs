use super::*;

fn with_policy(policy: &str) -> Arc<Source> {
    let mut source = Source::with_cache(true);
    let inner = &mut Arc::get_mut(&mut source).unwrap().inner;
    let mut store: Value = serde_json::from_str(&inner.store).unwrap();
    store[format!("bittery_account_{}_travel_mode_cache", desktop::ACCOUNT)] = json!(policy);
    inner.store = store.to_string();
    source
}

pub(super) fn with_enabled_policy(complete_session: bool, hidden_key_present: bool) -> Arc<Source> {
    let mut source = with_policy(
        &json!({
            "enabled":true,"hiddenVaultIds":["vault:offline","vault:unknown"],
            "enabledAt":1700000000000_u64,"updatedAt":1700000001000_u64
        })
        .to_string(),
    );
    let inner = &mut Arc::get_mut(&mut source).unwrap().inner;
    let mut store: Value = serde_json::from_str(&inner.store).unwrap();
    let prefix = format!(
        "record:item-cache-stage:{}:source-generation:",
        desktop::ACCOUNT
    );
    let mut vault: Value = serde_json::from_str(
        store[format!("{prefix}vaults:vault:offline")]
            .as_str()
            .unwrap(),
    )
    .unwrap();
    vault["id"] = json!("vault:visible");
    vault["name"] = json!("Visible Vault");
    store[format!("{prefix}vaults:vault:visible")] = json!(vault.to_string());
    let mut item: Value = serde_json::from_str(
        store[format!("{prefix}items:item:offline")]
            .as_str()
            .unwrap(),
    )
    .unwrap();
    item["id"] = json!("item:visible");
    item["vaultId"] = json!("vault:visible");
    item["encryptedData"] = json!("visible-ciphertext");
    store[format!("{prefix}items:item:visible")] = json!(item.to_string());
    let state_key = format!("record:{}:meta:meta", desktop::ACCOUNT);
    let mut state: Value = serde_json::from_str(store[&state_key].as_str().unwrap()).unwrap();
    state["metadata"]["itemCount"] = json!(2);
    store[state_key] = json!(state.to_string());
    inner.store = store.to_string();
    let mut keys: Vec<Value> =
        serde_json::from_str(inner.credentials[4].as_deref().unwrap()).unwrap();
    let mut visible = keys[0].clone();
    visible["vaultId"] = json!("vault:visible");
    visible["vaultName"] = json!("Visible Vault");
    visible["encryptedVaultKey"] = json!("wrapped-visible-key");
    if !hidden_key_present {
        keys.clear();
    }
    keys.push(visible);
    inner.credentials[4] = Some(serde_json::to_string(&keys).unwrap());
    if !complete_session {
        inner.credentials[5] = None;
    }
    source
}

struct VisibleReplica(SqliteReplica);

#[async_trait]
impl SerializedReplicaExecutor for VisibleReplica {
    async fn invoke(&self, request: String) -> Result<String, RuntimeError> {
        assert!(!request.contains("offline-ciphertext"));
        assert!(!request.contains("wrapped-offline-key"));
        self.0.invoke(request).await
    }
}

#[tokio::test]
async fn enabled_legacy_travel_erases_hidden_authority_before_staging_and_reopens_locked() {
    for complete in [false, true] {
        for hidden_key_present in [false, true] {
            let directory = TestDirectory::new();
            let platform = Arc::new(RetainingPlatform::default());
            let source = with_enabled_policy(complete, hidden_key_present);
            let runtime = runtime_with_platform_and_replica(
                &directory,
                platform.clone(),
                Arc::new(VisibleReplica(
                    SqliteReplica::open(directory.0.join("replica.sqlite")).unwrap(),
                )),
            )
            .await;
            runtime
                .set_profile_admission_source(ProfileAdmissionSource::Legacy {
                    format: LegacyProfileFormat::DesktopLegacyV1,
                    executor: source,
                })
                .await
                .unwrap();
            runtime.open().await.unwrap();
            assert_locked(&runtime);
            let metadata = platform.document(":metadata");
            assert_eq!(metadata["verifiedTravelMode"]["enabled"], true);
            assert_eq!(
                metadata["verifiedTravelMode"]["serverEnabledAtMs"],
                1700000000000_u64
            );
            assert!(metadata["verifiedTravelMode"]["verifiedAtMs"].is_null());
            let suffix = if complete {
                ":current-session"
            } else {
                ":legacy-session-evidence"
            };
            let session = platform.document(suffix);
            assert_eq!(session["vaultKeys"].as_array().unwrap().len(), 1);
            assert_eq!(session["vaultKeys"][0]["vaultId"], "vault:visible");
            assert_eq!(
                session["vaultKeys"][0]["encryptedVaultKey"],
                "wrapped-visible-key"
            );
            assert!(platform
                .sets
                .lock()
                .unwrap()
                .iter()
                .all(|(_, value)| !value.to_string().contains("wrapped-offline-key")));
            runtime.close().await;
            let reopened = Runtime::with_serialized_executors(
                Arc::new(SqliteReplica::open(directory.0.join("replica.sqlite")).unwrap()),
                platform.clone(),
                Arc::new(NoNetwork),
            );
            reopened.open().await.unwrap();
            assert_locked(&reopened);
            assert_eq!(platform.document(suffix), session);
            assert_eq!(platform.document(":metadata"), metadata);
            reopened.close().await;
            let replica = SqliteReplica::open(directory.0.join("replica.sqlite")).unwrap();
            let loaded = SerializedReplicaExecutor::invoke(
                &replica,
                json!({"type":"load","accountId":desktop::ACCOUNT}).to_string(),
            )
            .await
            .unwrap();
            let loaded: Value = serde_json::from_str(&loaded).unwrap();
            let rows = loaded["rows"].as_array().unwrap();
            for store in ["authorityItems", "authorityVaults"] {
                let rows = rows
                    .iter()
                    .filter(|row| row["store"] == store)
                    .collect::<Vec<_>>();
                assert_eq!(rows.len(), 1);
                let value: Value =
                    serde_json::from_str(rows[0]["payloadJson"].as_str().unwrap()).unwrap();
                assert_eq!(
                    value["id"],
                    if store == "authorityItems" {
                        "item:visible"
                    } else {
                        "vault:visible"
                    }
                );
            }
            assert!(!loaded.to_string().contains("offline-ciphertext"));
            assert!(!loaded.to_string().contains("wrapped-offline-key"));
            let generation = rows
                .iter()
                .find(|row| row["store"] == "bootstrapGenerations")
                .unwrap();
            let generation: Value =
                serde_json::from_str(generation["payloadJson"].as_str().unwrap()).unwrap();
            assert_eq!(generation["legacyAdmission"]["metadata"]["itemCount"], 2);
        }
    }
}

#[test]
fn public_and_native_travel_receipts_preserve_required_null_and_original_values() {
    for receipt in [Value::Null, json!("1700000000000")] {
        let value = json!({
            "enabled":false,"hiddenVaultIds":[],"serverEnabledAtMs":null,
            "serverUpdatedAtMs":null,"verifiedAtMs":receipt
        });
        let public: bittery_client_core::TravelModePolicy =
            serde_json::from_value(value.clone()).unwrap();
        let native: bittery_client_core::NativeTravelEvidence =
            serde_json::from_value(value.clone()).unwrap();
        assert_eq!(serde_json::to_value(public).unwrap(), value);
        assert_eq!(serde_json::to_value(native).unwrap(), value);
        let mut missing = value;
        missing.as_object_mut().unwrap().remove("verifiedAtMs");
        assert!(
            serde_json::from_value::<bittery_client_core::TravelModePolicy>(missing.clone())
                .is_err()
        );
        assert!(
            serde_json::from_value::<bittery_client_core::NativeTravelEvidence>(missing).is_err()
        );
    }
}

#[tokio::test]
async fn malformed_hidden_rows_and_keys_cannot_disappear_through_travel_filtering() {
    for fault in [
        "attachmentScope",
        "attachmentDuplicate",
        "attachmentSize",
        "missingVault",
        "keys",
    ] {
        let directory = TestDirectory::new();
        let platform = Arc::new(RetainingPlatform::default());
        let mut source = with_enabled_policy(false, true);
        let inner = &mut Arc::get_mut(&mut source).unwrap().inner;
        if fault == "keys" {
            let mut keys: Vec<Value> =
                serde_json::from_str(inner.credentials[4].as_deref().unwrap()).unwrap();
            keys.push(keys[0].clone());
            inner.credentials[4] = Some(serde_json::to_string(&keys).unwrap());
        } else {
            let mut store: Value = serde_json::from_str(&inner.store).unwrap();
            let key = format!(
                "record:item-cache-stage:{}:source-generation:items:item:offline",
                desktop::ACCOUNT
            );
            let mut item: Value = serde_json::from_str(store[&key].as_str().unwrap()).unwrap();
            if fault == "missingVault" {
                item["vaultId"] = json!("vault:unknown");
            }
            let attachment = json!({
                "id":"attachment","itemId":if fault == "attachmentScope" {"other-item"} else {"item:offline"},
                "vaultId":if fault == "missingVault" {"vault:unknown"} else {"vault:offline"},
                "storageKey":"opaque","encryptedName":"name",
                "encryptionIv":"iv","encryptionAlgorithm":"AES-GCM-AAD-V1",
                "encryptedAttachmentKey":"wrapped-key","attachmentKeyIv":"key-iv",
                "attachmentKeyAlgorithm":"AES-GCM-AAD-V1","encryptedContentType":"type",
                "encryptedContentTypeIv":"type-iv","envelopeVersion":1,
                "fileSize":if fault == "attachmentSize" {-1} else {10},
                "uploadedBy":"original-user","createdAt":"2026-09-20T00:00:00Z"
            });
            item["attachments"] = if fault == "attachmentDuplicate" {
                json!([attachment.clone(), attachment])
            } else {
                json!([attachment])
            };
            store[key] = json!(item.to_string());
            inner.store = store.to_string();
        }
        let runtime = runtime_with_platform_and_source(&directory, platform.clone(), source).await;
        let error = runtime.open().await.unwrap_err();
        assert_eq!(error.code, RuntimeErrorCode::InvariantViolation);
        if fault == "missingVault" {
            assert_eq!(
                error.message,
                "Legacy Desktop cached Item references a missing Vault"
            );
        }
        assert!(platform.sets.lock().unwrap().is_empty());
        runtime.close().await;
    }
}

#[tokio::test]
async fn enabled_travel_with_pending_work_remains_a_recoverable_prewrite_refusal() {
    let directory = TestDirectory::new();
    let platform = Arc::new(RetainingPlatform::default());
    let mut source = with_enabled_policy(true, true);
    let inner = &mut Arc::get_mut(&mut source).unwrap().inner;
    let mut sync: Value = serde_json::from_str(inner.sync.as_deref().unwrap()).unwrap();
    sync["bittery_pending_mutation_queues_v3"] = json!(json!({ desktop::ACCOUNT: [{
        "accountId":desktop::ACCOUNT,"id":"retained-pending-work","type":"create",
        "entityId":"item:queued","vaultId":"vault:visible","category":"login",
        "encryptedPayload":{"encryptedData":"ciphertext","encryptionIv":"iv",
            "encryptionAlgorithm":"AES-GCM-AAD-V1","encryptionVersion":1,"encryptedByUserId":"original-user"},
        "baseVersion":0,"timestamp":1700000002000_u64,"retryCount":0
    }]}).to_string());
    inner.sync = Some(sync.to_string());
    let runtime = runtime_with_platform_and_source(&directory, platform.clone(), source).await;
    let error = runtime.open().await.unwrap_err();
    assert_eq!(error.code, RuntimeErrorCode::InvariantViolation);
    assert_eq!(
        error.message,
        "Legacy Desktop enabled Travel policy with pending work is not yet supported"
    );
    assert!(platform.sets.lock().unwrap().is_empty());
    runtime.close().await;
}

#[tokio::test]
async fn disabled_legacy_travel_policy_survives_admission_and_reopen_without_a_new_receipt() {
    for policy in [
        json!({"enabled":false,"hiddenVaultIds":["vault:offline"]}),
        json!({"enabled":false,"hiddenVaultIds":[],"enabledAt":null,"updatedAt":0}),
        json!({"enabled":false,"hiddenVaultIds":["vault:future","vault:offline"],
            "enabledAt":null,"updatedAt":9_007_199_254_740_991_u64}),
    ] {
        let directory = TestDirectory::new();
        let platform = Arc::new(RetainingPlatform::default());
        let source = with_policy(&policy.to_string());
        let runtime =
            runtime_with_platform_and_source(&directory, platform.clone(), source.clone()).await;
        runtime.open().await.unwrap();
        assert_locked(&runtime);
        let metadata = platform.document(":metadata");
        let retained = &metadata["verifiedTravelMode"];
        assert_eq!(retained["enabled"], false);
        assert_eq!(retained["hiddenVaultIds"], policy["hiddenVaultIds"]);
        assert!(retained["serverEnabledAtMs"].is_null());
        assert_eq!(retained["serverUpdatedAtMs"], policy["updatedAt"]);
        assert!(retained.as_object().unwrap().contains_key("verifiedAtMs"));
        assert!(retained["verifiedAtMs"].is_null());
        assert_eq!(
            platform.document(":current-session")["vaultKeys"][0]["vaultId"],
            "vault:offline"
        );
        let catalog = platform.catalog();
        assert!(
            catalog["profileAdmission"]["progress"]["accounts"][0]["expected"]["metadataSha256"]
                .is_string()
        );
        runtime.close().await;

        let source_calls = source.calls.lock().unwrap().len();
        let reopened = Runtime::with_serialized_executors(
            Arc::new(SqliteReplica::open(directory.0.join("replica.sqlite")).unwrap()),
            platform.clone(),
            Arc::new(NoNetwork),
        );
        reopened.open().await.unwrap();
        assert_locked(&reopened);
        assert_eq!(platform.document(":metadata"), metadata);
        assert_eq!(platform.catalog(), catalog);
        assert_eq!(source.calls.lock().unwrap().len(), source_calls);
        reopened.close().await;

        let replica = SqliteReplica::open(directory.0.join("replica.sqlite")).unwrap();
        let loaded = SerializedReplicaExecutor::invoke(
            &replica,
            json!({"type":"load","accountId":desktop::ACCOUNT}).to_string(),
        )
        .await
        .unwrap();
        let loaded: Value = serde_json::from_str(&loaded).unwrap();
        let item: Value = serde_json::from_str(
            loaded["rows"]
                .as_array()
                .unwrap()
                .iter()
                .find(|row| row["store"] == "authorityItems")
                .unwrap()["payloadJson"]
                .as_str()
                .unwrap(),
        )
        .unwrap();
        assert_eq!(item["encryptedData"], "offline-ciphertext");
    }
}

#[tokio::test]
async fn unsupported_or_malformed_legacy_travel_policy_refuses_before_staging() {
    for policy in [
        r#"{"enabled":true,"hiddenVaultIds":[]}"#,
        r#"{"enabled":true,"hiddenVaultIds":[],"enabledAt":9007199254740992}"#,
        r#"{"enabled":false,"hiddenVaultIds":[],"enabledAt":100}"#,
        r#"{"enabled":false,"hiddenVaultIds":[],"updatedAt":null}"#,
        r#"{"enabled":false,"hiddenVaultIds":[],"updatedAt":-1}"#,
        r#"{"enabled":false,"hiddenVaultIds":[],"updatedAt":0.5}"#,
        r#"{"enabled":false,"hiddenVaultIds":[],"updatedAt":9007199254740992}"#,
        r#"{"enabled":false,"hiddenVaultIds":[""]}"#,
        r#"{"enabled":false,"hiddenVaultIds":["same","same"]}"#,
        r#"{"enabled":false,"enabled":false,"hiddenVaultIds":[]}"#,
        r#"{"enabled":false,"hiddenVaultIds":[],"unrecognized":true}"#,
        r#"[false,[],null,100]"#,
    ] {
        let directory = TestDirectory::new();
        let platform = Arc::new(RetainingPlatform::default());
        let runtime =
            runtime_with_platform_and_source(&directory, platform.clone(), with_policy(policy))
                .await;
        assert_eq!(
            runtime.open().await.unwrap_err().code,
            RuntimeErrorCode::InvariantViolation
        );
        assert!(platform.sets.lock().unwrap().is_empty());
        assert!(platform.values.lock().unwrap().is_empty());
        runtime.close().await;
    }
}
