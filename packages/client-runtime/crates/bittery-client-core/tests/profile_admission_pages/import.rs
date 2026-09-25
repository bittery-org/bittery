use super::*;
use bittery_client_core::{
    AccountAccessState, PlatformStorageArea, ProfileSourceReopenStep,
    ProfileSourceVerificationResult, ProfileSourceVerifyStep,
};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};

#[path = "import/staged_crashes.rs"]
mod staged_crashes;

#[path = "import/session_evidence.rs"]
mod session_evidence;

#[path = "import/queued_create.rs"]
mod queued_create;

#[path = "import/held_create.rs"]
mod held_create;

#[path = "import/failed_create_cache.rs"]
mod failed_create_cache;

#[path = "import/cross_account.rs"]
mod cross_account;

#[path = "import/queued_scheduling.rs"]
mod queued_scheduling;

#[path = "import/queued_move.rs"]
mod queued_move;

#[path = "import/queued_metadata.rs"]
mod queued_metadata;

#[path = "import/queued_update.rs"]
mod queued_update;

#[path = "import/held_update.rs"]
mod held_update;

#[path = "import/held_update_refusals.rs"]
mod held_update_refusals;

#[path = "import/held_existing_item.rs"]
mod held_existing_item;

#[path = "import/travel.rs"]
mod travel;

#[path = "import/cache_duplicate_stage.rs"]
mod cache_duplicate_stage;

fn area_name(area: PlatformStorageArea) -> String {
    serde_json::to_value(area)
        .unwrap()
        .as_str()
        .unwrap()
        .to_owned()
}
const CATALOG: &str = "bittery:runtime:platform-storage:device-catalog";

#[derive(Default)]
pub(super) struct RetainingPlatform {
    pub(super) values: Mutex<HashMap<(String, String), String>>,
    pub(super) sets: Mutex<Vec<(String, Value)>>,
    lose_preparing_reply: AtomicBool,
    lose_readback: AtomicBool,
    alter_preparing_reply: AtomicBool,
    lose_commit_reply: AtomicBool,
}
impl RetainingPlatform {
    pub(super) fn catalog(&self) -> Value {
        serde_json::from_str(
            self.values
                .lock()
                .unwrap()
                .get(&("devicePlain".into(), CATALOG.into()))
                .unwrap(),
        )
        .unwrap()
    }
    fn document(&self, suffix: &str) -> Value {
        let values = self.values.lock().unwrap();
        let value = values
            .iter()
            .find(|((_, key), _)| key.ends_with(suffix))
            .unwrap()
            .1;
        serde_json::from_str(value).unwrap()
    }
}
fn unavailable() -> RuntimeError {
    RuntimeError {
        code: RuntimeErrorCode::StorageUnavailable,
        message: "injected admission write reply loss".into(),
        recovery_bound: None,
        team_page_problem: None,
    }
}
#[async_trait]
impl SerializedPlatformStorageExecutor for RetainingPlatform {
    async fn invoke(&self, request: Zeroizing<String>) -> Result<Zeroizing<String>, RuntimeError> {
        let request: PlatformStorageRequest = serde_json::from_str(&request).unwrap();
        let response = match &request {
            PlatformStorageRequest::Get { area, key } => {
                if key == CATALOG && self.lose_readback.swap(false, Ordering::SeqCst) {
                    return Err(unavailable());
                }
                PlatformStorageResponse::Value {
                    value: self
                        .values
                        .lock()
                        .unwrap()
                        .get(&(area_name(*area), key.clone()))
                        .cloned()
                        .map(Into::into),
                }
            }
            PlatformStorageRequest::Set { area, key, value } => {
                let mut decoded: Value = serde_json::from_str(value).unwrap();
                self.sets
                    .lock()
                    .unwrap()
                    .push((key.clone(), decoded.clone()));
                if key == CATALOG
                    && decoded["profileAdmission"]["phase"] == "preparing"
                    && self.alter_preparing_reply.swap(false, Ordering::SeqCst)
                {
                    decoded["profileAdmission"]["legacyPresentation"]["syncClientId"] =
                        json!("different-content-same-admission-id");
                    self.values
                        .lock()
                        .unwrap()
                        .insert((area_name(*area), key.clone()), decoded.to_string());
                    return Err(unavailable());
                }
                self.values
                    .lock()
                    .unwrap()
                    .insert((area_name(*area), key.clone()), value.to_string());
                if key == CATALOG
                    && decoded["profileAdmission"]["phase"] == "preparing"
                    && self.lose_preparing_reply.swap(false, Ordering::SeqCst)
                {
                    self.lose_readback.store(true, Ordering::SeqCst);
                    return Err(unavailable());
                }
                if key == CATALOG
                    && decoded["profileAdmission"]["phase"] == "committed"
                    && self.lose_commit_reply.swap(false, Ordering::SeqCst)
                {
                    return Err(unavailable());
                }
                PlatformStorageResponse::Done
            }
            PlatformStorageRequest::ListKeys {
                area,
                prefix,
                cursor,
            } => {
                assert!(cursor.is_none());
                let mut keys: Vec<_> = self
                    .values
                    .lock()
                    .unwrap()
                    .keys()
                    .filter(|(stored, key)| {
                        *stored == area_name(*area) && key.starts_with(prefix.as_str())
                    })
                    .map(|(_, key)| key.clone())
                    .collect();
                keys.sort_by(|a, b| a.as_bytes().cmp(b.as_bytes()));
                PlatformStorageResponse::KeysPage(PlatformStorageKeysPage {
                    version: 1,
                    family: bittery_client_core::PlatformStorageInventoryFamily::PlatformStorage,
                    backing_areas: vec![*area],
                    keys,
                    continuation: PlatformStorageInventoryContinuation::End {},
                })
            }
            _ => panic!("admission must not delete source or destination evidence"),
        };
        Ok(Zeroizing::new(serde_json::to_string(&response).unwrap()))
    }
}

const SECOND_ACCOUNT: &str = "zz_second_account";
pub(super) struct Source {
    inner: desktop::Populated,
    calls: Mutex<Vec<ProfileAdmissionRequest>>,
    reopened: AtomicBool,
    second_account: bool,
    second_credentials: Option<Vec<Option<String>>>,
}
impl Source {
    pub(super) fn new() -> Arc<Self> {
        Self::build(false)
    }
    fn two_accounts() -> Arc<Self> {
        Self::build(true)
    }
    fn build(second_account: bool) -> Arc<Self> {
        let mut inner = desktop::Populated::valid();
        if second_account {
            let mut store: Value = serde_json::from_str(&inner.store).unwrap();
            let mut list: Value =
                serde_json::from_str(store["bittery_accounts_list"].as_str().unwrap()).unwrap();
            let mut account = list["accounts"][0].clone();
            account["accountId"] = json!(SECOND_ACCOUNT);
            account["serverUrl"] = json!("https://second.example.test");
            list["accounts"].as_array_mut().unwrap().push(account);
            store["bittery_accounts_list"] = json!(list.to_string());
            let first_prefix = format!("bittery_account_{}_", desktop::ACCOUNT);
            let second_prefix = format!("bittery_account_{SECOND_ACCOUNT}_");
            let fields: Vec<_> = store
                .as_object()
                .unwrap()
                .iter()
                .filter(|(key, _)| key.starts_with(&first_prefix))
                .map(|(key, value)| {
                    (
                        key.replacen(&first_prefix, &second_prefix, 1),
                        value.clone(),
                    )
                })
                .collect();
            for (key, value) in fields {
                store[key] = value;
            }
            store[format!("{second_prefix}server_url")] = json!("https://second.example.test");
            inner.store = store.to_string();
        }
        Arc::new(Self {
            inner,
            calls: Mutex::new(Vec::new()),
            reopened: AtomicBool::new(false),
            second_account,
            second_credentials: None,
        })
    }
    pub(super) fn with_cache(verified_baseline: bool) -> Arc<Self> {
        let mut inner = desktop::Populated::valid();
        let generation = "source-generation";
        let items_prefix = format!(
            "record:item-cache-stage:{}:{generation}:items:",
            desktop::ACCOUNT
        );
        let vaults_prefix = format!(
            "record:item-cache-stage:{}:{generation}:vaults:",
            desktop::ACCOUNT
        );
        let mut store: Value = serde_json::from_str(&inner.store).unwrap();
        let mut metadata = json!({
            "lastFullSyncAt":1700000001000_u64,"itemCount":1,"cacheVersion":1
        });
        if verified_baseline {
            metadata["syncBaseline"] = json!({
                "serverUrl":"https://example.test/","cursorId":"evt-cache"
            });
        }
        store[format!("record:{}:meta:meta", desktop::ACCOUNT)] = json!(json!({
            "v":2,"itemsPrimed":true,"vaultsPrimed":true,
            "metadata": metadata,
            "activeGeneration":generation,
            "nativeView":{"v":1,"itemsKeyPrefix":items_prefix,"vaultsKeyPrefix":vaults_prefix}
        })
        .to_string());
        store[format!("{vaults_prefix}vault:offline")] = json!(json!({
            "id":"vault:offline","name":"Offline Vault","type":"personal","icon":null,
            "imageUrl":null,"accountId":desktop::ACCOUNT,"accountEmail":"Person@example.test",
            "serverUrl":"https://EXAMPLE.test/"
        })
        .to_string());
        store[format!("{items_prefix}item:offline")] = json!(json!({
            "id":"item:offline","vaultId":"vault:offline","category":"login","favorite":false,
            "encryptedData":"offline-ciphertext","encryptionIv":"offline-iv",
            "encryptionAlgorithm":"AES-GCM-AAD-V1","version":7,"encryptionVersion":1,
            "encryptedByUserId":"original-user","lastModifiedBy":"original-user",
            "createdAt":"2026-09-20T00:00:00Z","updatedAt":"2026-09-20T00:01:00Z",
            "deletedAt":null,"accountId":desktop::ACCOUNT,"accountEmail":"Person@example.test",
            "serverUrl":"https://example.test/"
        })
        .to_string());
        inner.store = store.to_string();
        inner.credentials[3] = Some("retained-token".into());
        inner.credentials[4] = Some(json!([{
            "vaultId":"vault:offline","encryptedVaultKey":"wrapped-offline-key","role":"owner",
            "vaultIcon":null,"vaultImageUrl":null,"vaultName":"Offline Vault","vaultType":"personal"
        }]).to_string());
        inner.credentials[5] = Some("retained-private-key".into());
        let source_id = format!(
            "account:{}:server:{}",
            encode_component(desktop::ACCOUNT),
            encode_component("https://example.test")
        );
        let prefix = format!("sync_source_{}:", encode_component(&source_id));
        let mut sync = serde_json::Map::new();
        sync.insert("bittery_sync_client_id".into(), json!("cache-client"));
        if verified_baseline {
            sync.insert(
                format!("{prefix}syncBaselineV1"),
                json!(r#"{"initialized":true,"cursor":{"id":"evt-cache"}}"#),
            );
            sync.insert(
                format!("{prefix}lastSyncCursor"),
                json!(r#"{"id":"evt-cache"}"#),
            );
        }
        inner.sync = Some(Value::Object(sync).to_string());
        Arc::new(Self {
            inner,
            calls: Mutex::new(Vec::new()),
            reopened: AtomicBool::new(false),
            second_account: false,
            second_credentials: None,
        })
    }
    fn handle(&self) -> &'static str {
        if self.reopened.load(Ordering::SeqCst) {
            "fresh-reopened-handle"
        } else {
            SNAPSHOT_HANDLE
        }
    }
    fn manifest(&self) -> Vec<bittery_client_core::ProfileSourceManifestEntry> {
        let mut entries = self.inner.manifest();
        if self.second_account {
            let second_credentials = self
                .second_credentials
                .as_deref()
                .unwrap_or(&self.inner.credentials[1..]);
            for (entry, value) in self
                .inner
                .manifest()
                .into_iter()
                .skip(3)
                .zip(second_credentials)
            {
                let ProfileSourceSelector::AccountCredential { field, .. } = entry.selector else {
                    panic!("Account entry");
                };
                entries.push(
                    bittery_client_core::ProfileSourceManifestEntry::from_evidence(
                        LegacyProfileFormat::DesktopLegacyV1,
                        entry.family,
                        ProfileSourceSelector::AccountCredential {
                            account_id: SECOND_ACCOUNT.into(),
                            field,
                        },
                        value
                            .as_deref()
                            .map_or(ProfileSourceObservation::Missing {}, |value| {
                                ProfileSourceObservation::StoredString {
                                    encoding:
                                        bittery_client_core::ProfileSourceStringEncoding::Utf8,
                                    length: value.len() as u64,
                                }
                            }),
                        None,
                        value.as_deref().unwrap_or_default().as_bytes(),
                    )
                    .unwrap(),
                );
            }
        }
        entries
    }
    fn verify(&self, step: ProfileSourceVerifyStep) -> ProfileSourceVerificationResult {
        use ProfileSourceVerificationResult as Result;
        let entries = self.manifest();
        match step {
            ProfileSourceVerifyStep::Start {
                verification_attempt_id,
                snapshot_handle,
                header,
            } => {
                assert!(!verification_attempt_id.is_empty());
                assert_eq!(snapshot_handle, self.handle());
                assert_eq!(header.recorded_capture_id, "decoder-capture");
                assert_eq!(header.profile_identity, "decoder-profile");
                assert_eq!(header.entry_count, entries.len() as u64);
                let mut digest = header.digest().unwrap();
                for entry in &entries {
                    digest.append(entry).unwrap();
                }
                assert!(header.verify_digest(digest).unwrap());
                Result::Started {
                    verification_cursor: "import:0".into(),
                    next_index: 0,
                }
            }
            ProfileSourceVerifyStep::Entry {
                verification_cursor,
                index,
                expected_entry,
            } => {
                assert_eq!(verification_cursor, format!("import:{index}"));
                assert_eq!(expected_entry, entries[index as usize]);
                Result::Matched {
                    verification_cursor: format!("import:{}", index + 1),
                    next_index: index + 1,
                }
            }
            ProfileSourceVerifyStep::Finish {
                verification_cursor,
            } => {
                assert_eq!(verification_cursor, format!("import:{}", entries.len()));
                Result::Unchanged {
                    snapshot_handle: self.handle().into(),
                }
            }
        }
    }
    async fn fresh_snapshot(&self) -> bittery_client_core::ProfileSourceSnapshot {
        let begin = ProfileAdmissionRequest::BeginSourceSnapshot {
            format: LegacyProfileFormat::DesktopLegacyV1,
        };
        let (reply, _) = self
            .inner
            .invoke(Zeroizing::new(serde_json::to_string(&begin).unwrap()))
            .await
            .unwrap();
        let ProfileAdmissionResponse::SourceSnapshot { mut snapshot } =
            serde_json::from_str(&reply).unwrap()
        else {
            panic!("fixture snapshot")
        };
        snapshot.capture_id = "fresh-reopened-capture".into();
        snapshot.snapshot_handle = "fresh-reopened-handle".into();
        self.reopened.store(true, Ordering::SeqCst);
        snapshot
    }
}

fn encode_component(value: &str) -> String {
    let mut encoded = String::new();
    for byte in value.bytes() {
        if byte.is_ascii_alphanumeric()
            || matches!(
                byte,
                b'-' | b'_' | b'.' | b'!' | b'~' | b'*' | b'\'' | b'(' | b')'
            )
        {
            encoded.push(char::from(byte));
        } else {
            use std::fmt::Write;
            write!(&mut encoded, "%{byte:02X}").unwrap();
        }
    }
    encoded
}
#[async_trait]
impl SerializedProfileAdmissionExecutor for Source {
    async fn invoke(
        &self,
        request: Zeroizing<String>,
    ) -> Result<(Zeroizing<String>, Option<Zeroizing<Vec<u8>>>), RuntimeError> {
        let mut request: ProfileAdmissionRequest = serde_json::from_str(&request).unwrap();
        self.calls.lock().unwrap().push(request.clone());
        if let ProfileAdmissionRequest::ReadSourcePage {
            snapshot_handle,
            family: ProfileSourceFamily::DesktopCredentials,
            selector: ProfileSourceSelector::AccountCredential { account_id, field },
            cursor,
        } = &request
        {
            if account_id.as_str() == SECOND_ACCOUNT {
                if let Some(credentials) = &self.second_credentials {
                    assert_eq!(snapshot_handle, self.handle());
                    assert!(cursor.is_none());
                    let index = match field {
                        bittery_client_core::ProfileAccountCredentialField::SecretKey => 0,
                        bittery_client_core::ProfileAccountCredentialField::SessionData => 1,
                        bittery_client_core::ProfileAccountCredentialField::JwtToken => 2,
                        bittery_client_core::ProfileAccountCredentialField::VaultKeys => 3,
                        bittery_client_core::ProfileAccountCredentialField::EncryptedPrivateKey => {
                            4
                        }
                    };
                    let value = credentials[index].as_deref();
                    let observation = value.map_or(ProfileSourceObservation::Missing {}, |value| {
                        ProfileSourceObservation::StoredString {
                            encoding: bittery_client_core::ProfileSourceStringEncoding::Utf8,
                            length: value.len() as u64,
                        }
                    });
                    return Ok((
                        Zeroizing::new(
                            serde_json::to_string(&ProfileAdmissionResponse::SourcePage(
                                ProfileSourcePage {
                                    snapshot_handle: snapshot_handle.clone(),
                                    family: ProfileSourceFamily::DesktopCredentials,
                                    selector: ProfileSourceSelector::AccountCredential {
                                        account_id: account_id.clone(),
                                        field: *field,
                                    },
                                    observation,
                                    offset: 0,
                                    byte_length: value.map_or(0, |value| value.len() as u64),
                                    continuation: ProfileSourceContinuation::End {},
                                },
                            ))
                            .unwrap(),
                        ),
                        value.map(|value| Zeroizing::new(value.as_bytes().to_vec())),
                    ));
                }
            }
        }
        let result = match request.clone() {
            ProfileAdmissionRequest::VerifySourceSnapshot { step } => Some(self.verify(step)),
            ProfileAdmissionRequest::ReopenSourceSnapshot { step } => Some(match step {
                ProfileSourceReopenStep::Start {
                    verification_attempt_id,
                    header,
                } => self.verify(ProfileSourceVerifyStep::Start {
                    verification_attempt_id,
                    snapshot_handle: self.handle().into(),
                    header,
                }),
                ProfileSourceReopenStep::Entry {
                    verification_cursor,
                    index,
                    expected_entry,
                } => self.verify(ProfileSourceVerifyStep::Entry {
                    verification_cursor,
                    index,
                    expected_entry,
                }),
                ProfileSourceReopenStep::Finish {
                    verification_cursor,
                } => {
                    self.verify(ProfileSourceVerifyStep::Finish {
                        verification_cursor,
                    });
                    ProfileSourceVerificationResult::Reopened {
                        snapshot: self.fresh_snapshot().await,
                    }
                }
            }),
            _ => None,
        };
        if let Some(result) = result {
            return Ok((
                Zeroizing::new(
                    serde_json::to_string(&ProfileAdmissionResponse::SourceSnapshotVerification {
                        result,
                    })
                    .unwrap(),
                ),
                None,
            ));
        }
        let mut requested_selector = None;
        match &mut request {
            ProfileAdmissionRequest::ReadSourcePage {
                snapshot_handle,
                selector,
                ..
            } => {
                assert_eq!(snapshot_handle, self.handle());
                *snapshot_handle = SNAPSHOT_HANDLE.into();
                requested_selector = Some(selector.clone());
                if let ProfileSourceSelector::AccountCredential { account_id, .. } = selector {
                    if account_id.as_str() == SECOND_ACCOUNT {
                        assert!(self.second_account);
                        *account_id = desktop::ACCOUNT.into();
                    }
                }
            }
            ProfileAdmissionRequest::CloseSourceSnapshot {
                selector: ProfileSnapshotCloseSelector::Exact { handle },
            } => {
                assert_eq!(handle, self.handle());
                *handle = SNAPSHOT_HANDLE.into();
            }
            _ => {}
        }
        let (reply, binary) = self
            .inner
            .invoke(Zeroizing::new(serde_json::to_string(&request).unwrap()))
            .await?;
        let mut response: ProfileAdmissionResponse = serde_json::from_str(&reply).unwrap();
        if let ProfileAdmissionResponse::SourcePage(page) = &mut response {
            page.snapshot_handle = self.handle().into();
            page.selector = requested_selector.unwrap();
        }
        Ok((
            Zeroizing::new(serde_json::to_string(&response).unwrap()),
            binary,
        ))
    }
}

fn assert_locked(runtime: &Arc<Runtime>) {
    let sink = Arc::new(Sink::default());
    let observation = runtime
        .observe(
            ObservationRequest::RuntimeStatus { account_id: None },
            sink.clone(),
        )
        .unwrap();
    assert!(
        matches!(sink.0.lock().unwrap().last(),Some(RuntimeProjection::RuntimeStatus(status)) if !status.closed && status.accounts.len()==1 && status.accounts[0].account_id.as_str()==desktop::ACCOUNT && status.accounts[0].access==AccountAccessState::Locked)
    );
    observation.close();
}

#[tokio::test]
async fn admitted_cache_restarts_with_offline_ciphertext_and_only_verified_baseline() {
    for (verified, expected_state, expected_cursor_type) in [
        (true, "ready", "capturedValue"),
        (false, "refreshRequired", "cold"),
    ] {
        let directory = TestDirectory::new();
        let platform = Arc::new(RetainingPlatform::default());
        let source = Source::with_cache(verified);
        let runtime =
            runtime_with_platform_and_source(&directory, platform.clone(), source.clone()).await;
        runtime.open().await.unwrap();
        assert_locked(&runtime);
        runtime.close().await;

        let source_calls = source.calls.lock().unwrap().len();
        let restarted = Runtime::with_serialized_executors(
            Arc::new(SqliteReplica::open(directory.0.join("replica.sqlite")).unwrap()),
            platform,
            Arc::new(NoNetwork),
        );
        restarted.open().await.unwrap();
        assert_locked(&restarted);
        restarted.close().await;
        assert_eq!(source.calls.lock().unwrap().len(), source_calls);

        let replica = SqliteReplica::open(directory.0.join("replica.sqlite")).unwrap();
        let loaded = SerializedReplicaExecutor::invoke(
            &replica,
            json!({"type":"load","accountId":desktop::ACCOUNT}).to_string(),
        )
        .await
        .unwrap();
        let loaded: Value = serde_json::from_str(&loaded).unwrap();
        let rows = loaded["rows"].as_array().unwrap();
        assert!(rows.iter().all(|row| row["store"] != "bootstrapPages"));
        let metadata = rows
            .iter()
            .find(|row| row["store"] == "replicaMetadata" && row["key"]["recordId"] == "bootstrap")
            .map(|row| serde_json::from_str::<Value>(row["payloadJson"].as_str().unwrap()).unwrap())
            .unwrap();
        assert_eq!(metadata["state"], expected_state);
        assert_eq!(metadata["activeCursor"]["type"], expected_cursor_type);
        let generation = rows
            .iter()
            .find(|row| row["store"] == "bootstrapGenerations")
            .map(|row| serde_json::from_str::<Value>(row["payloadJson"].as_str().unwrap()).unwrap())
            .unwrap();
        assert_eq!(
            generation["legacyAdmission"]["sourceActiveGeneration"],
            "source-generation"
        );
        let item = rows
            .iter()
            .find(|row| row["store"] == "authorityItems")
            .map(|row| serde_json::from_str::<Value>(row["payloadJson"].as_str().unwrap()).unwrap())
            .unwrap();
        assert_eq!(item["id"], "item:offline");
        assert_eq!(item["encryptedData"], "offline-ciphertext");
        let vault = rows
            .iter()
            .find(|row| row["store"] == "authorityVaults")
            .map(|row| serde_json::from_str::<Value>(row["payloadJson"].as_str().unwrap()).unwrap())
            .unwrap();
        assert_eq!(vault["id"], "vault:offline");
        assert_eq!(vault["encryptedVaultKey"], "wrapped-offline-key");
    }
}

#[tokio::test]
async fn populated_desktop_commits_locked_with_fixed_documents_and_retains_source_cleanup() {
    let directory = TestDirectory::new();
    let platform = Arc::new(RetainingPlatform::default());
    let source = Source::new();
    platform.lose_commit_reply.store(true, Ordering::SeqCst);
    let runtime =
        runtime_with_platform_and_source(&directory, platform.clone(), source.clone()).await;
    runtime.open().await.unwrap();
    assert_locked(&runtime);
    let incarnation = {
        let sets = platform.sets.lock().unwrap();
        assert_eq!(sets[0].0, CATALOG);
        assert_eq!(sets[0].1["profileAdmission"]["phase"], "preparing");
        assert_eq!(sets[0].1["accounts"][0]["activeIncarnation"], Value::Null);
        sets[0].1["accounts"][0]["pendingInstall"]["incarnation"].clone()
    };
    let catalog = platform.catalog();
    assert_eq!(catalog["profileAdmission"]["phase"], "committed");
    assert_eq!(catalog["accounts"][0]["activeIncarnation"], incarnation);
    assert_eq!(
        catalog["profileAdmission"]["progress"]["accounts"][0]["checkpoint"],
        "verified"
    );
    let cleanup = catalog["profileAdmission"]["progress"]["sourceCleanup"]
        .as_array()
        .unwrap();
    assert_eq!(cleanup.len(), 4);
    assert!(cleanup
        .iter()
        .all(|value| value["disposition"] == "pending"));
    assert_eq!(
        platform.document(":device-key")["keyBytes"],
        json!((0..32).collect::<Vec<_>>())
    );
    assert_eq!(
        platform.document(":quick-unlock")["encryptedMasterUnlockKey"]["ciphertext"],
        "original-ciphertext"
    );
    assert_eq!(
        platform.document(":metadata")["normalizedServerUrl"],
        "https://example.test"
    );
    assert_eq!(
        platform.document(":platform-storage:local-security")["masterPasswordReentryPeriodMs"],
        0
    );
    assert_eq!(
        platform.document(&format!("{}:local-security", desktop::ACCOUNT))["inactivityTimeoutMs"],
        -1
    );
    assert_eq!(
        catalog["profileAdmission"]["legacyPresentation"]["selectedAccountId"],
        desktop::ACCOUNT
    );
    runtime.close().await;
    let calls = source.calls.lock().unwrap().len();
    let reopened =
        runtime_with_platform_and_source(&directory, platform.clone(), source.clone()).await;
    reopened.open().await.unwrap();
    assert_locked(&reopened);
    assert!(source.calls.lock().unwrap()[calls..]
        .iter()
        .all(|request| matches!(
            request,
            ProfileAdmissionRequest::ReopenSourceForCleanup { .. }
                | ProfileAdmissionRequest::CloseSourceSnapshot { .. }
        )));
    assert_eq!(platform.catalog(), catalog);
    reopened.close().await;
}

#[tokio::test]
async fn lost_preparing_reply_reopens_source_and_reuses_reserved_identity_before_any_staging() {
    let directory = TestDirectory::new();
    let platform = Arc::new(RetainingPlatform::default());
    let source = Source::new();
    platform.lose_preparing_reply.store(true, Ordering::SeqCst);
    let runtime =
        runtime_with_platform_and_source(&directory, platform.clone(), source.clone()).await;
    assert!(runtime.open().await.is_err());
    let before = platform.catalog();
    assert_eq!(before["profileAdmission"]["phase"], "preparing");
    assert_eq!(platform.sets.lock().unwrap().len(), 1);
    let replica = SqliteReplica::open(directory.0.join("replica.sqlite")).unwrap();
    let physical =
        SerializedReplicaExecutor::invoke(&replica, r#"{"type":"inventory","cursor":null}"#.into())
            .await
            .unwrap();
    let physical: Value = serde_json::from_str(&physical).unwrap();
    assert!(physical["entries"].as_array().unwrap().is_empty());
    assert!(runtime
        .observe(
            ObservationRequest::RuntimeStatus { account_id: None },
            Arc::new(Sink::default())
        )
        .is_err());
    runtime.close().await;
    let without_source = Runtime::with_serialized_executors(
        Arc::new(SqliteReplica::open(directory.0.join("replica.sqlite")).unwrap()),
        platform.clone(),
        Arc::new(NoNetwork),
    );
    let refusal = without_source.open().await.unwrap_err();
    assert_eq!(
        refusal.message,
        "Profile admission requires its matching source provider before startup"
    );
    assert_eq!(platform.sets.lock().unwrap().len(), 1);
    without_source.close().await;
    let reopened =
        runtime_with_platform_and_source(&directory, platform.clone(), source.clone()).await;
    reopened.open().await.unwrap();
    assert_locked(&reopened);
    let after = platform.catalog();
    assert_eq!(
        after["profileAdmission"]["admissionId"],
        before["profileAdmission"]["admissionId"]
    );
    assert_eq!(
        after["accounts"][0]["activeIncarnation"],
        before["accounts"][0]["pendingInstall"]["incarnation"]
    );
    assert!(source
        .calls
        .lock()
        .unwrap()
        .iter()
        .any(|call| matches!(call, ProfileAdmissionRequest::ReopenSourceSnapshot { .. })));
    reopened.close().await;
}

#[tokio::test]
async fn catalog_readback_with_same_identity_but_different_content_fences_before_staging() {
    let directory = TestDirectory::new();
    let platform = Arc::new(RetainingPlatform::default());
    let source = Source::new();
    platform.alter_preparing_reply.store(true, Ordering::SeqCst);
    let runtime = runtime_with_platform_and_source(&directory, platform.clone(), source).await;
    assert!(runtime.open().await.is_err());
    assert_eq!(platform.sets.lock().unwrap().len(), 1);
    assert_eq!(platform.catalog()["profileAdmission"]["phase"], "preparing");
    assert!(runtime
        .observe(
            ObservationRequest::RuntimeStatus { account_id: None },
            Arc::new(Sink::default())
        )
        .is_err());
    runtime.close().await;
}

#[tokio::test]
async fn resumed_two_account_conflict_is_found_before_recreating_an_earlier_missing_document() {
    let directory = TestDirectory::new();
    let platform = Arc::new(RetainingPlatform::default());
    let source = Source::two_accounts();
    platform.lose_preparing_reply.store(true, Ordering::SeqCst);
    let runtime =
        runtime_with_platform_and_source(&directory, platform.clone(), source.clone()).await;
    assert!(runtime.open().await.is_err());
    runtime.close().await;
    let catalog = platform.catalog();
    assert_eq!(catalog["accounts"].as_array().unwrap().len(), 2);
    let generation = catalog["accounts"][1]["pendingInstall"]["incarnation"]
        .as_str()
        .unwrap();
    let key = format!(
        "bittery:runtime:platform-storage:account:{}:{SECOND_ACCOUNT}:incarnation:{}:{generation}:metadata",
        SECOND_ACCOUNT.len(),
        generation.len()
    );
    let changed=json!({"version":1,"accountId":SECOND_ACCOUNT,"incarnation":generation,"userId":"original-user",
        "email":"Person@example.test","name":"foreign-content","normalizedServerUrl":"https://second.example.test",
        "teamName":null,"teamAvatarUrl":null,"secretKeyHint":"A3-ABCDEF","addedAtMs":1700000000000_u64,"lastActiveAtMs":1700000000123_u64,
        "biometricEnabled":false,"insecureTransportConfirmed":false,"pinnedKdfProfile":{"schemaVersion":1,"algorithm":"pbkdf2-sha256","iterations":600000},
        "verifiedTravelMode":null,"legacyDesktopEvidence":{"accountBiometricEnabled":false,"sessionBiometricEnabled":null,"lastBiometricAuth":null,"backgroundTimestamp":null}}).to_string();
    platform
        .values
        .lock()
        .unwrap()
        .insert(("devicePlain".into(), key), changed);
    platform.sets.lock().unwrap().clear();
    let before = platform.values.lock().unwrap().clone();
    let reopened = runtime_with_platform_and_source(&directory, platform.clone(), source).await;
    assert!(reopened.open().await.is_err());
    assert!(platform.sets.lock().unwrap().is_empty());
    assert_eq!(*platform.values.lock().unwrap(), before);
    reopened.close().await;
}

#[tokio::test]
async fn verified_checkpoint_missing_proof_refuses_without_restaging() {
    let directory = TestDirectory::new();
    let platform = Arc::new(RetainingPlatform::default());
    let source = Source::new();
    let runtime =
        runtime_with_platform_and_source(&directory, platform.clone(), source.clone()).await;
    runtime.open().await.unwrap();
    runtime.close().await;
    let checkpoint = platform
        .sets
        .lock()
        .unwrap()
        .iter()
        .find(|(key, value)| {
            key == CATALOG
                && value["profileAdmission"]["phase"] == "preparing"
                && value["profileAdmission"]["progress"]["accounts"][0]["checkpoint"] == "verified"
        })
        .unwrap()
        .1
        .clone();
    {
        let mut values = platform.values.lock().unwrap();
        values.insert(
            ("devicePlain".into(), CATALOG.into()),
            checkpoint.to_string(),
        );
        values.retain(|(_, key), _| !key.ends_with(":metadata"));
    }
    platform.sets.lock().unwrap().clear();
    let before = platform.values.lock().unwrap().clone();
    let reopened = runtime_with_platform_and_source(&directory, platform.clone(), source).await;
    assert!(reopened.open().await.is_err());
    assert!(platform.sets.lock().unwrap().is_empty());
    assert_eq!(*platform.values.lock().unwrap(), before);
    reopened.close().await;
}
