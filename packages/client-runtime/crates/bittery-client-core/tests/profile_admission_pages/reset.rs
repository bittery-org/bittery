use super::*;
use bittery_client_core::{
    RequestCancellation, RuntimeRequest, RuntimeResponse, TeardownHostCleanup,
    TeardownHostCleanupRequest, TeardownHostCleanupResponse, TeardownStatus,
};
use serde_json::{json, Value};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
const CATALOG: &str = "bittery:runtime:platform-storage:device-catalog";
struct ResetPorts {
    storage: Arc<import::RetainingPlatform>,
    source_calls: Mutex<Vec<Value>>,
    deleted: Mutex<Vec<String>>,
    lose_initial_write: AtomicBool,
    fail_readback: AtomicBool,
    lose_family_reply: AtomicBool,
    wrong_scope: AtomicBool,
    tamper_host: AtomicBool,
    tamper_final_census: AtomicBool,
    session_inventories: AtomicUsize,
    lose_prepare_reply: AtomicBool,
    close_failures: AtomicUsize,
    changed_family: Mutex<Option<String>>,
    poison: Mutex<Option<(PathBuf, String)>>,
}
impl ResetPorts {
    fn malformed() -> Arc<Self> {
        let storage = Arc::new(import::RetainingPlatform::default());
        storage.values.lock().unwrap().insert(
            ("devicePlain".into(), CATALOG.into()),
            "{broken admission catalog".into(),
        );
        storage.values.lock().unwrap().insert(
            (
                "deviceSecret".into(),
                "bittery:runtime:platform-storage:orphan".into(),
            ),
            "{}".into(),
        );
        Arc::new(Self {
            storage,
            source_calls: Mutex::new(Vec::new()),
            deleted: Mutex::new(Vec::new()),
            lose_initial_write: AtomicBool::new(false),
            fail_readback: AtomicBool::new(false),
            lose_family_reply: AtomicBool::new(false),
            wrong_scope: AtomicBool::new(false),
            tamper_host: AtomicBool::new(false),
            tamper_final_census: AtomicBool::new(false),
            session_inventories: AtomicUsize::new(0),
            lose_prepare_reply: AtomicBool::new(false),
            close_failures: AtomicUsize::new(0),
            changed_family: Mutex::new(None),
            poison: Mutex::new(None),
        })
    }
    fn substitute_journal(&self) {
        let mut catalog = self.storage.catalog();
        catalog["profileAdmission"]["scope"]["scope"]["families"][0]["namespaceIdentity"] =
            json!("tampered-store-location");
        self.storage
            .values
            .lock()
            .unwrap()
            .insert(("devicePlain".into(), CATALOG.into()), catalog.to_string());
    }
    fn scope() -> Value {
        json!({"version":1,"format":"desktopLegacyV1","profileIdentity":"reset-profile","families":[
            {"family":"desktopStore","namespaceIdentity":"reset-store","selectorPlanVersion":1,"file":{"type":"present","fileIdentity":"store-object"}},
            {"family":"desktopSyncStore","namespaceIdentity":"reset-sync","selectorPlanVersion":1,"file":{"type":"absent"}},
            {"family":"desktopCredentials","namespaceIdentity":"reset-keyring","selectorPlanVersion":1,"file":{"type":"notFile"}}
        ]})
    }
}
fn unavailable(message: &str) -> RuntimeError {
    RuntimeError {
        code: RuntimeErrorCode::StorageUnavailable,
        message: message.into(),
        recovery_bound: None,
        team_page_problem: None,
    }
}
#[async_trait]
impl SerializedPlatformStorageExecutor for ResetPorts {
    async fn invoke(&self, input: Zeroizing<String>) -> Result<Zeroizing<String>, RuntimeError> {
        let request: PlatformStorageRequest = serde_json::from_str(&input).unwrap();
        if matches!(
            &request,
            PlatformStorageRequest::ListKeys {
                area: bittery_client_core::PlatformStorageArea::SessionSecret,
                ..
            }
        ) {
            let count = self.session_inventories.fetch_add(1, Ordering::SeqCst) + 1;
            if count == 3 && self.tamper_final_census.load(Ordering::SeqCst) {
                self.substitute_journal();
            }
            if count == 3 {
                if let Some((path, sql)) = self.poison.lock().unwrap().take() {
                    let connection = rusqlite::Connection::open(path).unwrap();
                    connection.execute_batch("PRAGMA foreign_keys=OFF").unwrap();
                    connection.execute_batch(&sql).unwrap();
                }
            }
        }
        match &request {
            PlatformStorageRequest::Get { key, .. }
                if key == CATALOG && self.fail_readback.swap(false, Ordering::SeqCst) =>
            {
                return Err(unavailable("lost reset journal readback"));
            }
            PlatformStorageRequest::DeletePrefix {
                area,
                prefix,
                preserve_key,
            } => {
                let catalog = self.storage.catalog();
                assert_eq!(
                    catalog["profileAdmission"]["phase"], "wiping",
                    "reset journal must precede Core deletion"
                );
                let area = serde_json::to_value(area)
                    .unwrap()
                    .as_str()
                    .unwrap()
                    .to_owned();
                let mut values = self.storage.values.lock().unwrap();
                if area == "devicePlain" {
                    assert_eq!(preserve_key.as_deref(), Some(CATALOG));
                } else {
                    assert!(preserve_key.is_none());
                }
                values.retain(|(stored, key), _| {
                    *stored != area
                        || !key.starts_with(prefix)
                        || Some(key) == preserve_key.as_ref()
                });
                return Ok(Zeroizing::new(
                    serde_json::to_string(&PlatformStorageResponse::Done).unwrap(),
                ));
            }
            _ => {}
        }
        let lose = matches!(&request,PlatformStorageRequest::Set{key,..} if key==CATALOG)
            && self.lose_initial_write.swap(false, Ordering::SeqCst);
        let response = self.storage.invoke(input).await?;
        if lose {
            self.fail_readback.store(true, Ordering::SeqCst);
            return Err(unavailable("lost reset journal write reply"));
        }
        Ok(response)
    }
}
#[async_trait]
impl SerializedProfileAdmissionExecutor for ResetPorts {
    async fn invoke(
        &self,
        input: Zeroizing<String>,
    ) -> Result<(Zeroizing<String>, Option<Zeroizing<Vec<u8>>>), RuntimeError> {
        let request: Value = serde_json::from_str(&input).unwrap();
        self.source_calls.lock().unwrap().push(request.clone());
        let response = match request["type"].as_str().unwrap() {
            "prepareLegacyProfileReset" => {
                if !request["expectedScope"].is_null() {
                    assert_eq!(request["expectedScope"], Self::scope());
                }
                if self.lose_prepare_reply.swap(false, Ordering::SeqCst) {
                    return Err(unavailable("lost reset Prepare capability reply"));
                }
                let mut scope = Self::scope();
                if self.wrong_scope.load(Ordering::SeqCst) {
                    scope["profileIdentity"] = json!("foreign-profile");
                }
                json!({"type":"profileResetPrepared","result":{"type":"prepared","snapshot":{"resetHandle":"reset-capability","wipeId":request["wipeId"],"scope":scope}}})
            }
            "resetLegacySourceFamily" => {
                let catalog = self.storage.catalog();
                assert_eq!(catalog["profileAdmission"]["phase"], "wiping");
                assert_eq!(catalog["profileAdmission"]["wipeId"], request["wipeId"]);
                assert_eq!(catalog["profileAdmission"]["scope"]["scope"], Self::scope());
                let family = request["family"].as_str().unwrap().to_owned();
                let mut deleted = self.deleted.lock().unwrap();
                let result = if self.changed_family.lock().unwrap().as_ref() == Some(&family) {
                    "changed"
                } else if deleted.contains(&family) {
                    "alreadyAbsent"
                } else {
                    deleted.push(family);
                    "reset"
                };
                if self.lose_family_reply.swap(false, Ordering::SeqCst) {
                    return Err(unavailable("lost reset family acknowledgement"));
                }
                json!({"type":"profileResetFamilyResult","resetHandle":"reset-capability","wipeId":request["wipeId"],"family":request["family"],"result":{"type":result}})
            }
            "closeSourceSnapshot" => {
                if self
                    .close_failures
                    .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |remaining| {
                        remaining.checked_sub(1)
                    })
                    .is_ok()
                {
                    return Err(unavailable("lost reset Close acknowledgement"));
                }
                json!({"type":"sourceSnapshotClosed"})
            }
            _ => panic!("Reset must not decode/import old Account evidence: {request}"),
        };
        Ok((Zeroizing::new(response.to_string()), None))
    }
}
#[async_trait]
impl TeardownHostCleanup for ResetPorts {
    async fn invoke(
        &self,
        request: TeardownHostCleanupRequest,
    ) -> Result<TeardownHostCleanupResponse, RuntimeError> {
        assert!(matches!(request, TeardownHostCleanupRequest::WipeDevice));
        if self.tamper_host.load(Ordering::SeqCst) {
            self.substitute_journal();
        }
        Ok(TeardownHostCleanupResponse::DeviceWiped)
    }
}
async fn runtime(directory: &TestDirectory, ports: Arc<ResetPorts>, legacy: bool) -> Arc<Runtime> {
    let runtime = if legacy {
        runtime_with_platform_and_source(directory, ports.clone(), ports.clone()).await
    } else {
        runtime_with_platform(directory, ports.clone()).await
    };
    runtime.install_teardown_host_cleanup(ports);
    runtime
}
async fn wipe(runtime: &Runtime) -> RuntimeResponse {
    runtime
        .request(RuntimeRequest::Wipe, RequestCancellation::new())
        .await
        .unwrap()
}
fn complete(response: RuntimeResponse) {
    assert!(
        matches!(
            response,
            RuntimeResponse::Teardown {
                status: TeardownStatus::Complete,
                ..
            }
        ),
        "{response:?}"
    );
}

#[tokio::test]
async fn malformed_catalog_wipe_prepares_independent_scope_before_any_destruction() {
    let directory = TestDirectory::new();
    let ports = ResetPorts::malformed();
    let owner = runtime(&directory, ports.clone(), true).await;
    complete(wipe(&owner).await);
    let catalog = ports.storage.catalog();
    assert_eq!(catalog["profileAdmission"]["phase"], "wiped");
    assert_eq!(catalog["accounts"], json!([]));
    assert_eq!(ports.deleted.lock().unwrap().len(), 3);
    assert_eq!(ports.storage.values.lock().unwrap().len(), 1);
    owner.close().await;
    let reopened = runtime(&directory, ports.clone(), true).await;
    reopened.open().await.unwrap();
    assert_eq!(ports.storage.catalog(), catalog);
    reopened.close().await;
}
#[tokio::test]
async fn lost_initial_reset_journal_reply_retains_identity_and_issues_no_deletions() {
    let directory = TestDirectory::new();
    let ports = ResetPorts::malformed();
    ports.lose_initial_write.store(true, Ordering::SeqCst);
    let owner = runtime(&directory, ports.clone(), true).await;
    assert!(matches!(
        wipe(&owner).await,
        RuntimeResponse::Teardown {
            status: TeardownStatus::Incomplete,
            ..
        }
    ));
    assert!(ports.deleted.lock().unwrap().is_empty());
    let before = ports.storage.catalog();
    assert_eq!(before["profileAdmission"]["phase"], "wiping");
    owner.close().await;
    let retry = runtime(&directory, ports.clone(), true).await;
    assert!(retry.open().await.is_err());
    complete(wipe(&retry).await);
    let after = ports.storage.catalog();
    assert_eq!(
        after["profileAdmission"]["wipeId"],
        before["profileAdmission"]["wipeId"]
    );
    assert_eq!(after["profileAdmission"]["phase"], "wiped");
    retry.close().await;
}
#[tokio::test]
async fn lost_reset_family_reply_retries_same_scope_and_proves_absence() {
    let directory = TestDirectory::new();
    let ports = ResetPorts::malformed();
    ports.lose_family_reply.store(true, Ordering::SeqCst);
    let owner = runtime(&directory, ports.clone(), true).await;
    assert!(matches!(
        wipe(&owner).await,
        RuntimeResponse::Teardown {
            status: TeardownStatus::Incomplete,
            ..
        }
    ));
    assert_eq!(ports.deleted.lock().unwrap().len(), 1);
    let before = ports.storage.catalog();
    assert_eq!(before["profileAdmission"]["phase"], "wiping");
    owner.close().await;
    let retry = runtime(&directory, ports.clone(), true).await;
    complete(wipe(&retry).await);
    assert_eq!(
        ports.storage.catalog()["profileAdmission"]["wipeId"],
        before["profileAdmission"]["wipeId"]
    );
    assert_eq!(ports.deleted.lock().unwrap().len(), 3);
    retry.close().await;
}
#[tokio::test]
async fn trusted_core_only_corrupt_catalog_recovery_uses_no_legacy_provider() {
    let directory = TestDirectory::new();
    let ports = ResetPorts::malformed();
    let owner = runtime(&directory, ports.clone(), false).await;
    complete(wipe(&owner).await);
    assert_eq!(
        ports.storage.catalog()["profileAdmission"]["scope"],
        json!({"type":"coreOnly","namespaceVersion":1})
    );
    assert!(ports.source_calls.lock().unwrap().is_empty());
    owner.close().await;
}

#[tokio::test]
async fn changed_reset_scope_refuses_retry_without_overwriting_journal_or_more_deletions() {
    let directory = TestDirectory::new();
    let ports = ResetPorts::malformed();
    ports.lose_family_reply.store(true, Ordering::SeqCst);
    let owner = runtime(&directory, ports.clone(), true).await;
    assert!(matches!(
        wipe(&owner).await,
        RuntimeResponse::Teardown {
            status: TeardownStatus::Incomplete,
            ..
        }
    ));
    let before = ports.storage.values.lock().unwrap().clone();
    owner.close().await;
    ports.wrong_scope.store(true, Ordering::SeqCst);
    let retry = runtime(&directory, ports.clone(), true).await;
    assert!(matches!(
        wipe(&retry).await,
        RuntimeResponse::Teardown {
            status: TeardownStatus::Incomplete,
            ..
        }
    ));
    assert_eq!(*ports.storage.values.lock().unwrap(), before);
    assert_eq!(ports.deleted.lock().unwrap().len(), 1);
    retry.close().await;
}
#[tokio::test]
async fn applicable_unavailable_provider_preserves_even_unreadable_catalog_bytes() {
    let directory = TestDirectory::new();
    let ports = ResetPorts::malformed();
    let before = ports.storage.values.lock().unwrap().clone();
    let owner = runtime(&directory, ports.clone(), false).await;
    owner
        .set_profile_admission_source(ProfileAdmissionSource::LegacyUnavailable {
            format: LegacyProfileFormat::DesktopLegacyV1,
        })
        .await
        .unwrap();
    assert!(matches!(
        wipe(&owner).await,
        RuntimeResponse::Teardown {
            status: TeardownStatus::Incomplete,
            ..
        }
    ));
    assert_eq!(*ports.storage.values.lock().unwrap(), before);
    assert!(ports.source_calls.lock().unwrap().is_empty());
    owner.close().await;
}

#[tokio::test]
async fn substituted_journal_after_host_cleanup_blocks_the_next_core_deletion() {
    let directory = TestDirectory::new();
    let ports = ResetPorts::malformed();
    ports.tamper_host.store(true, Ordering::SeqCst);
    let owner = runtime(&directory, ports.clone(), true).await;
    assert!(matches!(
        wipe(&owner).await,
        RuntimeResponse::Teardown {
            status: TeardownStatus::Incomplete,
            ..
        }
    ));
    assert!(ports.storage.values.lock().unwrap().contains_key(&(
        "deviceSecret".into(),
        "bittery:runtime:platform-storage:orphan".into()
    )));
    assert_eq!(
        ports.storage.catalog()["profileAdmission"]["scope"]["scope"]["families"][0]
            ["namespaceIdentity"],
        "tampered-store-location"
    );
    owner.close().await;
}
#[tokio::test]
async fn substituted_journal_during_final_census_cannot_be_overwritten_by_wiped() {
    let directory = TestDirectory::new();
    let ports = ResetPorts::malformed();
    ports.tamper_final_census.store(true, Ordering::SeqCst);
    let owner = runtime(&directory, ports.clone(), true).await;
    assert!(matches!(
        wipe(&owner).await,
        RuntimeResponse::Teardown {
            status: TeardownStatus::Incomplete,
            ..
        }
    ));
    assert_eq!(
        ports.storage.catalog()["profileAdmission"]["phase"],
        "wiping"
    );
    assert_eq!(
        ports.storage.catalog()["profileAdmission"]["scope"]["scope"]["families"][0]
            ["namespaceIdentity"],
        "tampered-store-location"
    );
    owner.close().await;
}

#[tokio::test]
async fn lost_prepare_capability_and_close_replies_drain_before_a_new_reset() {
    let directory = TestDirectory::new();
    let ports = ResetPorts::malformed();
    let before = ports.storage.values.lock().unwrap().clone();
    ports.lose_prepare_reply.store(true, Ordering::SeqCst);
    ports.close_failures.store(1, Ordering::SeqCst);
    let owner = runtime(&directory, ports.clone(), true).await;
    assert!(matches!(
        wipe(&owner).await,
        RuntimeResponse::Teardown {
            status: TeardownStatus::Incomplete,
            ..
        }
    ));
    assert_eq!(*ports.storage.values.lock().unwrap(), before);
    assert!(ports.deleted.lock().unwrap().is_empty());
    complete(wipe(&owner).await);
    {
        let calls = ports.source_calls.lock().unwrap();
        let types: Vec<_> = calls
            .iter()
            .map(|call| call["type"].as_str().unwrap())
            .collect();
        assert_eq!(
            &types[..4],
            [
                "prepareLegacyProfileReset",
                "closeSourceSnapshot",
                "closeSourceSnapshot",
                "prepareLegacyProfileReset"
            ]
        );
    }
    owner.close().await;
}
#[tokio::test]
async fn previously_completed_reset_family_changed_after_prepare_is_pending_again() {
    let directory = TestDirectory::new();
    let ports = ResetPorts::malformed();
    ports.close_failures.store(1, Ordering::SeqCst);
    let owner = runtime(&directory, ports.clone(), true).await;
    assert!(matches!(
        wipe(&owner).await,
        RuntimeResponse::Teardown {
            status: TeardownStatus::Incomplete,
            ..
        }
    ));
    assert_eq!(
        ports.storage.catalog()["profileAdmission"]["remainingFamilies"],
        json!([])
    );
    let wipe_id = ports.storage.catalog()["profileAdmission"]["wipeId"].clone();
    owner.close().await;
    *ports.changed_family.lock().unwrap() = Some("desktopStore".into());
    let retry = runtime(&directory, ports.clone(), true).await;
    assert!(matches!(
        wipe(&retry).await,
        RuntimeResponse::Teardown {
            status: TeardownStatus::Incomplete,
            ..
        }
    ));
    let catalog = ports.storage.catalog();
    assert_eq!(catalog["profileAdmission"]["wipeId"], wipe_id);
    assert_eq!(catalog["profileAdmission"]["phase"], "wiping");
    assert_eq!(
        catalog["profileAdmission"]["remainingFamilies"],
        json!(["desktopStore"])
    );
    retry.close().await;
}

struct JournalWriteFault {
    inner: Arc<ResetPorts>,
    target: usize,
    writes: AtomicUsize,
    lose_readback: bool,
    fail_read: AtomicBool,
}
#[async_trait]
impl SerializedPlatformStorageExecutor for JournalWriteFault {
    async fn invoke(&self, input: Zeroizing<String>) -> Result<Zeroizing<String>, RuntimeError> {
        let parsed: PlatformStorageRequest = serde_json::from_str(&input).unwrap();
        if matches!(&parsed,PlatformStorageRequest::Get{key,..} if key==CATALOG)
            && self.fail_read.swap(false, Ordering::SeqCst)
        {
            return Err(unavailable("lost matrix journal readback"));
        }
        let target = matches!(&parsed,PlatformStorageRequest::Set{key,..} if key==CATALOG)
            && self.writes.fetch_add(1, Ordering::SeqCst) + 1 == self.target;
        let result = SerializedPlatformStorageExecutor::invoke(self.inner.as_ref(), input).await?;
        if target {
            self.fail_read.store(self.lose_readback, Ordering::SeqCst);
            return Err(unavailable("lost matrix journal write reply"));
        }
        Ok(result)
    }
}
#[tokio::test]
async fn every_reset_receipt_and_wiped_write_reconciles_exactly_or_reopens_the_same_scope() {
    for target in 1..=5 {
        for lose_readback in [false, true] {
            let directory = TestDirectory::new();
            let ports = ResetPorts::malformed();
            let fault = Arc::new(JournalWriteFault {
                inner: ports.clone(),
                target,
                writes: AtomicUsize::new(0),
                lose_readback,
                fail_read: AtomicBool::new(false),
            });
            let owner =
                runtime_with_platform_and_source(&directory, fault.clone(), ports.clone()).await;
            owner.install_teardown_host_cleanup(ports.clone());
            let outcome = wipe(&owner).await;
            let before = ports.storage.catalog();
            assert!(fault.writes.load(Ordering::SeqCst) >= target);
            if !lose_readback {
                complete(outcome);
                assert_eq!(before["profileAdmission"]["phase"], "wiped");
            } else {
                assert!(
                    matches!(
                        outcome,
                        RuntimeResponse::Teardown {
                            status: TeardownStatus::Incomplete,
                            ..
                        }
                    ),
                    "target {target}"
                );
                owner.close().await;
                let retry = runtime(&directory, ports.clone(), true).await;
                if target == 5 {
                    retry.open().await.unwrap();
                } else {
                    assert!(retry.open().await.is_err());
                    complete(wipe(&retry).await);
                }
                let after = ports.storage.catalog();
                assert_eq!(
                    after["profileAdmission"]["wipeId"],
                    before["profileAdmission"]["wipeId"]
                );
                assert_eq!(
                    after["profileAdmission"]["scope"],
                    before["profileAdmission"]["scope"]
                );
                assert_eq!(after["profileAdmission"]["phase"], "wiped");
                retry.close().await;
            }
            owner.close().await;
        }
    }
}
#[tokio::test]
async fn actual_poisoned_replica_and_orphan_artifact_rows_prevent_wiped() {
    for (file, sql, table) in [
        (
            "replica.sqlite",
            "INSERT INTO replica_heads VALUES ('orphan','user','incarnation','not-a-revision','0',NULL)",
            "replica_heads",
        ),
        (
            "attachments.sqlite",
            "INSERT INTO attachment_move_artifact_chunks VALUES ('orphan','artifact',0,x'00','not-a-digest')",
            "attachment_move_artifact_chunks",
        ),
        (
            "vault-images.sqlite",
            "INSERT INTO vault_image_artifact_chunks (account_id,operation_id,publication_id,chunk_index,plaintext) VALUES ('orphan','operation','',0,x'00')",
            "vault_image_artifact_chunks",
        ),
    ] {
        let directory = TestDirectory::new();
        let ports = ResetPorts::malformed();
        let owner = runtime(&directory, ports.clone(), true).await;
        *ports.poison.lock().unwrap() = Some((directory.0.join(file), sql.into()));
        assert!(
            matches!(
                wipe(&owner).await,
                RuntimeResponse::Teardown {
                    status: TeardownStatus::Incomplete,
                    ..
                }
            ),
            "{file}"
        );
        assert_eq!(
            ports.storage.catalog()["profileAdmission"]["phase"],
            "wiping"
        );
        let count: i64 = rusqlite::Connection::open(directory.0.join(file))
            .unwrap()
            .query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(count, 1);
        owner.close().await;
        let retry = runtime(&directory, ports.clone(), true).await;
        let retried = wipe(&retry).await;
        assert!(matches!(retried, RuntimeResponse::Teardown { status: TeardownStatus::Complete, .. }), "{file}: {retried:?}");
        retry.close().await;
    }
}
#[tokio::test]
async fn known_legacy_wiped_scope_cannot_be_downgraded_by_missing_provider() {
    let directory = TestDirectory::new();
    let ports = ResetPorts::malformed();
    let owner = runtime(&directory, ports.clone(), true).await;
    complete(wipe(&owner).await);
    owner.close().await;
    let before = ports.storage.catalog();
    for applicable in [false, true] {
        let retry = runtime(&directory, ports.clone(), false).await;
        if applicable {
            retry
                .set_profile_admission_source(ProfileAdmissionSource::LegacyUnavailable {
                    format: LegacyProfileFormat::DesktopLegacyV1,
                })
                .await
                .unwrap();
        }
        retry.open().await.unwrap();
        assert!(matches!(
            wipe(&retry).await,
            RuntimeResponse::Teardown {
                status: TeardownStatus::Incomplete,
                ..
            }
        ));
        assert_eq!(ports.storage.catalog(), before);
        retry.close().await;
    }
}
