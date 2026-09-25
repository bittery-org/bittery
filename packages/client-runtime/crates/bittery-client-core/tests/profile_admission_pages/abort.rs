//! Explicit lifecycle controls remain available when ordinary startup is fenced.
use super::*;
use bittery_client_core::{RequestCancellation, RuntimeRequest};
use serde_json::{json, Value};

async fn control(runtime: &Runtime, value: Value) -> Result<Value, RuntimeError> {
    let request: RuntimeRequest =
        serde_json::from_value(value).expect("generated lifecycle request");
    runtime
        .request(request, RequestCancellation::new())
        .await
        .map(|response| serde_json::to_value(response).unwrap())
}

#[tokio::test]
async fn inspection_reads_strict_catalog_without_opening_or_writing() {
    let directory = TestDirectory::new();
    let platform = Arc::new(import::RetainingPlatform::default());
    let runtime = runtime_with_platform(&directory, platform.clone()).await;
    assert_eq!(
        control(&runtime, json!({"type":"inspectProfileAdmission"}))
            .await
            .unwrap(),
        json!({"type":"profileAdmissionInspection","state":{"type":"notStarted"}})
    );
    assert!(platform.sets.lock().unwrap().is_empty());
    assert!(runtime
        .observe(
            ObservationRequest::RuntimeStatus { account_id: None },
            Arc::new(Sink::default())
        )
        .is_err());
    platform.values.lock().unwrap().insert(
        (
            "devicePlain".into(),
            "bittery:runtime:platform-storage:device-catalog".into(),
        ),
        "{broken".into(),
    );
    assert!(control(&runtime, json!({"type":"inspectProfileAdmission"}))
        .await
        .is_err());
    assert!(platform.sets.lock().unwrap().is_empty());
    runtime.close().await;
}

struct PreparingOnly {
    inner: Arc<import::RetainingPlatform>,
    stop: std::sync::atomic::AtomicBool,
}
#[async_trait]
impl SerializedPlatformStorageExecutor for PreparingOnly {
    async fn invoke(&self, request: Zeroizing<String>) -> Result<Zeroizing<String>, RuntimeError> {
        let parsed: PlatformStorageRequest = serde_json::from_str(&request).unwrap();
        if let PlatformStorageRequest::DeleteIfUnchanged {
            area,
            key,
            expected_value,
        } = &parsed
        {
            assert_eq!(
                self.inner.catalog()["profileAdmission"]["phase"],
                "aborting"
            );
            let area = serde_json::to_value(area)
                .unwrap()
                .as_str()
                .unwrap()
                .to_owned();
            let mut values = self.inner.values.lock().unwrap();
            let target = (area, key.clone());
            let result = match values.get(&target) {
                None => "alreadyAbsent",
                Some(actual) if actual == &expected_value.to_string() => {
                    values.remove(&target);
                    "deleted"
                }
                Some(_) => "conflict",
            };
            return Ok(Zeroizing::new(
                json!({"type":"deleteResult","result":result}).to_string(),
            ));
        }
        if let PlatformStorageRequest::Set { key, .. } = &parsed {
            if !key.ends_with(":device-catalog")
                && self.stop.load(std::sync::atomic::Ordering::SeqCst)
            {
                return Err(RuntimeError {
                    code: RuntimeErrorCode::StorageUnavailable,
                    message: "stop before private staging".into(),
                    recovery_bound: None,
                    team_page_problem: None,
                });
            }
        }
        self.inner.invoke(request).await
    }
}

#[tokio::test]
async fn explicit_abort_records_intent_and_aborted_without_source_or_readiness() {
    let directory = TestDirectory::new();
    let platform = Arc::new(import::RetainingPlatform::default());
    let ports = Arc::new(PreparingOnly {
        inner: platform.clone(),
        stop: std::sync::atomic::AtomicBool::new(true),
    });
    let runtime =
        runtime_with_platform_and_source(&directory, ports.clone(), import::Source::new()).await;
    assert!(runtime.open().await.is_err());
    let before = platform.catalog();
    let id = before["profileAdmission"]["admissionId"].as_str().unwrap();
    assert_eq!(
        control(&runtime, json!({"type":"inspectProfileAdmission"}))
            .await
            .unwrap(),
        json!({"type":"profileAdmissionInspection","state":{"type":"import","admissionId":id,"phase":"preparing"}})
    );
    ports.stop.store(false, std::sync::atomic::Ordering::SeqCst);
    let command = json!({"type":"abortProfileAdmission","admissionId":id});
    assert_eq!(
        control(&runtime, command.clone()).await.unwrap(),
        json!({"type":"profileAdmissionAborted","admissionId":id})
    );
    let after = platform.catalog();
    assert_eq!(after["profileAdmission"]["phase"], "aborted");
    assert_eq!(after["accounts"], json!([]));
    assert!(platform
        .sets
        .lock()
        .unwrap()
        .iter()
        .any(|(_, value)| value["profileAdmission"]["phase"] == "aborting"));
    assert_eq!(
        control(&runtime, command).await.unwrap(),
        json!({"type":"profileAdmissionAborted","admissionId":id})
    );
    assert!(runtime
        .observe(
            ObservationRequest::RuntimeStatus { account_id: None },
            Arc::new(Sink::default())
        )
        .is_err());
    runtime.close().await;
}

struct TracedSource {
    inner: Arc<import::Source>,
    calls: std::sync::atomic::AtomicUsize,
    verifies: std::sync::atomic::AtomicUsize,
    fail_final: bool,
}
#[async_trait]
impl SerializedProfileAdmissionExecutor for TracedSource {
    async fn invoke(
        &self,
        request: Zeroizing<String>,
    ) -> Result<(Zeroizing<String>, Option<Zeroizing<Vec<u8>>>), RuntimeError> {
        self.calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        let parsed: ProfileAdmissionRequest = serde_json::from_str(&request).unwrap();
        if matches!(
            parsed,
            ProfileAdmissionRequest::VerifySourceSnapshot {
                step: bittery_client_core::ProfileSourceVerifyStep::Start { .. }
            }
        ) && self
            .verifies
            .fetch_add(1, std::sync::atomic::Ordering::SeqCst)
            == 1
            && self.fail_final
        {
            return Err(RuntimeError {
                code: RuntimeErrorCode::StorageUnavailable,
                message: "stop after staging before commit".into(),
                recovery_bound: None,
                team_page_problem: None,
            });
        }
        self.inner.invoke(request).await
    }
}
#[tokio::test]
async fn abort_removes_exact_verified_staging_and_fresh_open_allocates_new_identity() {
    abort_verified_staging(false).await;
}
#[tokio::test]
async fn abort_removes_populated_cache_and_session_before_fresh_import() {
    abort_verified_staging(true).await;
}
async fn abort_verified_staging(cached: bool) {
    let directory = TestDirectory::new();
    let platform = Arc::new(import::RetainingPlatform::default());
    let ports = Arc::new(PreparingOnly {
        inner: platform.clone(),
        stop: std::sync::atomic::AtomicBool::new(false),
    });
    let source = Arc::new(TracedSource {
        inner: if cached {
            import::Source::with_cache(true)
        } else {
            import::Source::new()
        },
        calls: 0.into(),
        verifies: 0.into(),
        fail_final: true,
    });
    let runtime = runtime_with_platform_and_source(&directory, ports.clone(), source.clone()).await;
    assert!(runtime.open().await.is_err());
    let before = platform.catalog();
    assert_eq!(before["profileAdmission"]["phase"], "preparing");
    assert_eq!(
        before["profileAdmission"]["progress"]["accounts"][0]["checkpoint"],
        "verified"
    );
    let id = before["profileAdmission"]["admissionId"].as_str().unwrap();
    let calls = source.calls.load(std::sync::atomic::Ordering::SeqCst);
    control(
        &runtime,
        json!({"type":"abortProfileAdmission","admissionId":id}),
    )
    .await
    .unwrap();
    assert_eq!(
        source.calls.load(std::sync::atomic::Ordering::SeqCst),
        calls
    );
    assert_eq!(platform.values.lock().unwrap().len(), 1);
    let connection = rusqlite::Connection::open(directory.0.join("replica.sqlite")).unwrap();
    assert_eq!(
        connection
            .query_row("SELECT count(*) FROM replica_heads", [], |row| row
                .get::<_, i64>(0))
            .unwrap(),
        0
    );
    assert_eq!(
        connection
            .query_row("SELECT count(*) FROM replica_rows", [], |row| row
                .get::<_, i64>(0))
            .unwrap(),
        0
    );
    runtime.close().await;
    let fresh = runtime_with_platform_and_source(
        &directory,
        ports,
        if cached {
            import::Source::with_cache(true)
        } else {
            import::Source::new()
        },
    )
    .await;
    fresh.open().await.unwrap();
    let after = platform.catalog();
    assert_ne!(
        after["profileAdmission"]["admissionId"],
        before["profileAdmission"]["admissionId"]
    );
    assert_ne!(
        after["accounts"][0]["activeIncarnation"],
        before["accounts"][0]["pendingInstall"]["incarnation"]
    );
    fresh.close().await;
}

#[tokio::test]
async fn abort_preserves_original_matching_device_documents_and_rejects_wrong_identity() {
    let directory = TestDirectory::new();
    let platform = Arc::new(import::RetainingPlatform::default());
    let key = json!({"version":1,"keyBytes":(0..32).collect::<Vec<_>>()}).to_string();
    let security = json!({"version":1,"masterPasswordReentryPeriodMs":0}).to_string();
    platform.values.lock().unwrap().extend([
        (
            (
                "deviceSecret".into(),
                "bittery:runtime:platform-storage:device-key".into(),
            ),
            key.clone(),
        ),
        (
            (
                "devicePlain".into(),
                "bittery:runtime:platform-storage:local-security".into(),
            ),
            security.clone(),
        ),
    ]);
    let ports = Arc::new(PreparingOnly {
        inner: platform.clone(),
        stop: false.into(),
    });
    let source = Arc::new(TracedSource {
        inner: import::Source::new(),
        calls: 0.into(),
        verifies: 0.into(),
        fail_final: true,
    });
    let runtime = runtime_with_platform_and_source(&directory, ports, source.clone()).await;
    assert!(runtime.open().await.is_err());
    let before = platform.catalog();
    let id = before["profileAdmission"]["admissionId"].as_str().unwrap();
    let bytes = platform.values.lock().unwrap().clone();
    assert!(control(
        &runtime,
        json!({"type":"abortProfileAdmission","admissionId":"wrong-admission"})
    )
    .await
    .is_err());
    assert_eq!(*platform.values.lock().unwrap(), bytes);
    let calls = source.calls.load(std::sync::atomic::Ordering::SeqCst);
    control(
        &runtime,
        json!({"type":"abortProfileAdmission","admissionId":id}),
    )
    .await
    .unwrap();
    assert_eq!(
        source.calls.load(std::sync::atomic::Ordering::SeqCst),
        calls
    );
    {
        let remaining = platform.values.lock().unwrap();
        assert_eq!(remaining.len(), 3);
        assert_eq!(
            remaining.get(&(
                "deviceSecret".into(),
                "bittery:runtime:platform-storage:device-key".into()
            )),
            Some(&key)
        );
        assert_eq!(
            remaining.get(&(
                "devicePlain".into(),
                "bittery:runtime:platform-storage:local-security".into()
            )),
            Some(&security)
        );
    }
    runtime.close().await;
}

struct AbortFault {
    inner: Arc<PreparingOnly>,
    target_write: usize,
    writes: std::sync::atomic::AtomicUsize,
    lose_readback: bool,
    fail_next_get: std::sync::atomic::AtomicBool,
    conflict_delete: std::sync::atomic::AtomicBool,
    lose_delete_reply: std::sync::atomic::AtomicBool,
}
impl AbortFault {
    fn new(inner: Arc<PreparingOnly>, target_write: usize, lose_readback: bool) -> Arc<Self> {
        Arc::new(Self {
            inner,
            target_write,
            writes: 0.into(),
            lose_readback,
            fail_next_get: false.into(),
            conflict_delete: false.into(),
            lose_delete_reply: false.into(),
        })
    }
}
fn injected() -> RuntimeError {
    RuntimeError {
        code: RuntimeErrorCode::StorageUnavailable,
        message: "injected Abort acknowledgement loss".into(),
        recovery_bound: None,
        team_page_problem: None,
    }
}
#[async_trait]
impl SerializedPlatformStorageExecutor for AbortFault {
    async fn invoke(&self, request: Zeroizing<String>) -> Result<Zeroizing<String>, RuntimeError> {
        use std::sync::atomic::Ordering::SeqCst;
        let parsed: PlatformStorageRequest = serde_json::from_str(&request).unwrap();
        if matches!(parsed, PlatformStorageRequest::Get { .. })
            && self.fail_next_get.swap(false, SeqCst)
        {
            return Err(injected());
        }
        let abort_write = match &parsed {
            PlatformStorageRequest::Set { value, .. } => {
                let value: Value = serde_json::from_str(value).unwrap();
                matches!(
                    value["profileAdmission"]["phase"].as_str(),
                    Some("aborting" | "aborted")
                )
            }
            _ => false,
        };
        let target_write = abort_write && self.writes.fetch_add(1, SeqCst) + 1 == self.target_write;
        let delete = matches!(parsed, PlatformStorageRequest::DeleteIfUnchanged { .. });
        if let PlatformStorageRequest::DeleteIfUnchanged { area, key, .. } = &parsed {
            if self.conflict_delete.swap(false, SeqCst) {
                let area = serde_json::to_value(area)
                    .unwrap()
                    .as_str()
                    .unwrap()
                    .to_owned();
                let mut values = self.inner.inner.values.lock().unwrap();
                let value = values.get_mut(&(area, key.clone())).unwrap();
                let mut changed: Value = serde_json::from_str(value).unwrap();
                changed["version"] = json!(99);
                *value = changed.to_string();
            }
        }
        let response = self.inner.invoke(request).await?;
        if target_write || (delete && self.lose_delete_reply.swap(false, SeqCst)) {
            self.fail_next_get.store(self.lose_readback, SeqCst);
            return Err(injected());
        }
        Ok(response)
    }
}
async fn staged(
    directory: &TestDirectory,
    platform: Arc<dyn SerializedPlatformStorageExecutor>,
) -> Arc<Runtime> {
    let source = Arc::new(TracedSource {
        inner: import::Source::with_cache(true),
        calls: 0.into(),
        verifies: 0.into(),
        fail_final: true,
    });
    let runtime = runtime_with_platform_and_source(directory, platform, source).await;
    assert!(runtime.open().await.is_err());
    runtime
}

#[tokio::test]
async fn every_abort_journal_write_recovers_with_the_same_identity_without_a_provider() {
    let directory = TestDirectory::new();
    let baseline = Arc::new(import::RetainingPlatform::default());
    let ports = Arc::new(PreparingOnly {
        inner: baseline.clone(),
        stop: false.into(),
    });
    let owner = staged(&directory, ports).await;
    let id = baseline.catalog()["profileAdmission"]["admissionId"]
        .as_str()
        .unwrap()
        .to_owned();
    control(
        &owner,
        json!({"type":"abortProfileAdmission","admissionId":id}),
    )
    .await
    .unwrap();
    let count = baseline
        .sets
        .lock()
        .unwrap()
        .iter()
        .filter(|(_, document)| {
            matches!(
                document["profileAdmission"]["phase"].as_str(),
                Some("aborting" | "aborted")
            )
        })
        .count();
    owner.close().await;
    assert!(count > 5);
    for target in 1..=count {
        for lose_readback in [false, true] {
            let directory = TestDirectory::new();
            let storage = Arc::new(import::RetainingPlatform::default());
            let ports = Arc::new(PreparingOnly {
                inner: storage.clone(),
                stop: false.into(),
            });
            let fault = AbortFault::new(ports, target, lose_readback);
            let owner = staged(&directory, fault.clone()).await;
            let before = storage.catalog();
            let id = before["profileAdmission"]["admissionId"].as_str().unwrap();
            let command = json!({"type":"abortProfileAdmission","admissionId":id});
            let outcome = control(&owner, command.clone()).await;
            assert_eq!(outcome.is_err(), lose_readback, "write {target}");
            owner.close().await;
            if lose_readback {
                let retry = runtime_with_platform(&directory, fault.clone()).await;
                assert!(retry.open().await.is_err());
                control(&retry, command).await.unwrap();
                retry.close().await;
            }
            let after = storage.catalog();
            assert_eq!(
                after["profileAdmission"]["admissionId"],
                before["profileAdmission"]["admissionId"]
            );
            assert_eq!(after["profileAdmission"]["phase"], "aborted");
            assert_eq!(storage.values.lock().unwrap().len(), 1);
        }
    }
}

#[tokio::test]
async fn guarded_abort_preserves_a_replacement_and_lost_delete_replies_resume() {
    for conflict in [false, true] {
        let directory = TestDirectory::new();
        let storage = Arc::new(import::RetainingPlatform::default());
        let ports = Arc::new(PreparingOnly {
            inner: storage.clone(),
            stop: false.into(),
        });
        let fault = AbortFault::new(ports, usize::MAX, !conflict);
        let owner = staged(&directory, fault.clone()).await;
        let before = storage.catalog();
        let id = before["profileAdmission"]["admissionId"].as_str().unwrap();
        fault
            .conflict_delete
            .store(conflict, std::sync::atomic::Ordering::SeqCst);
        fault
            .lose_delete_reply
            .store(!conflict, std::sync::atomic::Ordering::SeqCst);
        let command = json!({"type":"abortProfileAdmission","admissionId":id});
        assert!(control(&owner, command.clone()).await.is_err());
        assert_eq!(storage.catalog()["profileAdmission"]["phase"], "aborting");
        owner.close().await;
        let retry = runtime_with_platform(&directory, fault).await;
        if conflict {
            let bytes = storage.values.lock().unwrap().clone();
            assert!(control(&retry, command).await.is_err());
            assert_eq!(*storage.values.lock().unwrap(), bytes);
            assert!(bytes
                .iter()
                .any(|((_, key), value)| key.ends_with(":device-key")
                    && serde_json::from_str::<Value>(value).unwrap()["version"] == 99));
        } else {
            control(&retry, command).await.unwrap();
            assert_eq!(storage.values.lock().unwrap().len(), 1);
        }
        let connection = rusqlite::Connection::open(directory.0.join("replica.sqlite")).unwrap();
        let rows = connection
            .query_row("SELECT count(*) FROM replica_rows", [], |row| {
                row.get::<_, i64>(0)
            })
            .unwrap();
        if conflict {
            assert!(rows > 1);
        } else {
            assert_eq!(rows, 0);
        }
        retry.close().await;
    }
}

#[tokio::test]
async fn abort_preflight_refuses_later_corruption_before_any_earlier_cleanup() {
    let directory = TestDirectory::new();
    let storage = Arc::new(import::RetainingPlatform::default());
    let ports = Arc::new(PreparingOnly {
        inner: storage.clone(),
        stop: false.into(),
    });
    let owner = staged(&directory, ports).await;
    let before = storage.catalog();
    let id = before["profileAdmission"]["admissionId"].as_str().unwrap();
    {
        let mut values = storage.values.lock().unwrap();
        values.remove(&(
            "deviceSecret".into(),
            "bittery:runtime:platform-storage:device-key".into(),
        ));
        let (_, value) = values
            .iter_mut()
            .find(|((_, key), _)| key.ends_with(":quick-unlock"))
            .unwrap();
        let mut changed: Value = serde_json::from_str(value).unwrap();
        changed["version"] = json!(99);
        *value = changed.to_string();
    }
    let bytes = storage.values.lock().unwrap().clone();
    assert!(control(
        &owner,
        json!({"type":"abortProfileAdmission","admissionId":id})
    )
    .await
    .is_err());
    assert_eq!(*storage.values.lock().unwrap(), bytes);
    assert_eq!(storage.catalog(), before);
    owner.close().await;
}

#[tokio::test]
async fn aborted_staging_reappearance_blocks_replay_and_fresh_source_capture() {
    let directory = TestDirectory::new();
    let storage = Arc::new(import::RetainingPlatform::default());
    let ports = Arc::new(PreparingOnly {
        inner: storage.clone(),
        stop: false.into(),
    });
    let owner = staged(&directory, ports.clone()).await;
    let before = storage.catalog();
    let id = before["profileAdmission"]["admissionId"].as_str().unwrap();
    let evidence = storage
        .values
        .lock()
        .unwrap()
        .iter()
        .find(|((_, key), _)| key.ends_with(":metadata"))
        .map(|(key, value)| (key.clone(), value.clone()))
        .unwrap();
    let command = json!({"type":"abortProfileAdmission","admissionId":id});
    control(&owner, command.clone()).await.unwrap();
    storage
        .values
        .lock()
        .unwrap()
        .insert(evidence.0, evidence.1);
    let bytes = storage.values.lock().unwrap().clone();
    assert!(control(&owner, command).await.is_err());
    assert_eq!(*storage.values.lock().unwrap(), bytes);
    owner.close().await;
    let source = Arc::new(TracedSource {
        inner: import::Source::with_cache(true),
        calls: 0.into(),
        verifies: 0.into(),
        fail_final: false,
    });
    let fresh = runtime_with_platform_and_source(&directory, ports, source.clone()).await;
    assert!(fresh.open().await.is_err());
    assert_eq!(source.calls.load(std::sync::atomic::Ordering::SeqCst), 0);
    assert_eq!(*storage.values.lock().unwrap(), bytes);
    fresh.close().await;
}

#[tokio::test]
async fn abort_refuses_committed_and_reset_and_cancelled_preparing_without_writes() {
    for committed in [false, true] {
        let directory = TestDirectory::new();
        let storage = Arc::new(import::RetainingPlatform::default());
        let ports = Arc::new(PreparingOnly {
            inner: storage.clone(),
            stop: false.into(),
        });
        let source = Arc::new(TracedSource {
            inner: import::Source::with_cache(true),
            calls: 0.into(),
            verifies: 0.into(),
            fail_final: !committed,
        });
        let owner = runtime_with_platform_and_source(&directory, ports, source.clone()).await;
        assert_eq!(owner.open().await.is_ok(), committed);
        let before = storage.catalog();
        let id = before["profileAdmission"]["admissionId"].as_str().unwrap();
        let bytes = storage.values.lock().unwrap().clone();
        let calls = source.calls.load(std::sync::atomic::Ordering::SeqCst);
        let cancellation = RequestCancellation::new();
        if !committed {
            cancellation.cancel();
        }
        let request =
            serde_json::from_value(json!({"type":"abortProfileAdmission","admissionId":id}))
                .unwrap();
        assert!(owner.request(request, cancellation).await.is_err());
        assert_eq!(*storage.values.lock().unwrap(), bytes);
        assert_eq!(
            source.calls.load(std::sync::atomic::Ordering::SeqCst),
            calls
        );
        owner.close().await;
    }
    let directory = TestDirectory::new();
    let storage = Arc::new(import::RetainingPlatform::default());
    let catalog = json!({"version":1,"accounts":[],"profileAdmission":{"kind":"reset","version":1,"wipeId":"fixed-reset","revision":"0","phase":"wiped","scope":{"type":"coreOnly","namespaceVersion":1},"remainingFamilies":[]}});
    storage.values.lock().unwrap().insert(
        (
            "devicePlain".into(),
            "bittery:runtime:platform-storage:device-catalog".into(),
        ),
        catalog.to_string(),
    );
    let owner = runtime_with_platform(&directory, storage.clone()).await;
    assert_eq!(
        control(&owner, json!({"type":"inspectProfileAdmission"}))
            .await
            .unwrap(),
        json!({"type":"profileAdmissionInspection","state":{"type":"reset","wipeId":"fixed-reset","phase":"wiped"}})
    );
    assert!(control(
        &owner,
        json!({"type":"abortProfileAdmission","admissionId":"fixed-reset"})
    )
    .await
    .is_err());
    assert!(storage.sets.lock().unwrap().is_empty());
    assert_eq!(storage.catalog(), catalog);
    owner.close().await;
}
