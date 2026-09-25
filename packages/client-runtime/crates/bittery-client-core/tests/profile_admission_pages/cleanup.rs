use super::*;
use serde_json::{json, Value};
use std::collections::HashSet;
use std::sync::atomic::{AtomicBool, Ordering};

const CATALOG: &str = "bittery:runtime:platform-storage:device-catalog";
const HANDLE: &str = "cleanup-only-fresh-handle";

struct CleanupSource {
    platform: Arc<import::RetainingPlatform>,
    manifest: Value,
    admission_id: Value,
    absent: Mutex<HashSet<u64>>,
    changed: Mutex<HashSet<u64>>,
    deletes: Mutex<Vec<u64>>,
    lose_delete_reply: AtomicBool,
    lose_close_reply: AtomicBool,
}
impl CleanupSource {
    fn new(platform: Arc<import::RetainingPlatform>) -> Arc<Self> {
        let catalog = platform.catalog();
        Arc::new(Self {
            manifest: catalog["profileAdmission"]["progress"]["manifest"].clone(),
            admission_id: catalog["profileAdmission"]["admissionId"].clone(),
            platform,
            absent: Mutex::new(HashSet::new()),
            changed: Mutex::new(HashSet::new()),
            deletes: Mutex::new(Vec::new()),
            lose_delete_reply: AtomicBool::new(false),
            lose_close_reply: AtomicBool::new(false),
        })
    }
}
#[async_trait]
impl SerializedProfileAdmissionExecutor for CleanupSource {
    async fn invoke(
        &self,
        request: Zeroizing<String>,
    ) -> Result<(Zeroizing<String>, Option<Zeroizing<Vec<u8>>>), RuntimeError> {
        let request: Value = serde_json::from_str(&request).unwrap();
        let response = match request["type"].as_str().unwrap() {
            "reopenSourceForCleanup" => {
                assert_eq!(
                    self.platform.catalog()["profileAdmission"]["phase"],
                    "committed"
                );
                let step = &request["step"];
                let result = match step["type"].as_str().unwrap() {
                    "start" => {
                        assert_eq!(step["admissionId"], self.admission_id);
                        assert_eq!(step["header"], self.manifest["header"]);
                        json!({"type":"started","verificationCursor":"cleanup:0","nextIndex":"0"})
                    }
                    "entry" => {
                        let index: usize = step["index"].as_str().unwrap().parse().unwrap();
                        assert_eq!(step["verificationCursor"], format!("cleanup:{index}"));
                        assert_eq!(step["expectedEntry"], self.manifest["entries"][index]);
                        json!({"type":"accepted","verificationCursor":format!("cleanup:{}",index+1),"nextIndex":(index+1).to_string()})
                    }
                    "finish" => {
                        assert_eq!(
                            step["verificationCursor"],
                            format!(
                                "cleanup:{}",
                                self.manifest["entries"].as_array().unwrap().len()
                            )
                        );
                        json!({"type":"reopened","snapshot":{"snapshotHandle":HANDLE,"captureId":"fresh-cleanup-capture","profileIdentity":self.manifest["header"]["profileIdentity"],"format":"desktopLegacyV1","admissionId":self.admission_id}})
                    }
                    _ => panic!("unexpected cleanup reopen step"),
                };
                json!({"type":"sourceCleanupReopen","result":result})
            }
            "deleteCapturedSource" => {
                let catalog = self.platform.catalog();
                assert_eq!(catalog["profileAdmission"]["phase"], "committed");
                assert_eq!(request["snapshotHandle"], HANDLE);
                assert_eq!(request["admissionId"], self.admission_id);
                let index: u64 = request["index"].as_str().unwrap().parse().unwrap();
                assert_eq!(
                    request["expectedEntry"],
                    self.manifest["entries"][index as usize]
                );
                assert_ne!(request["expectedEntry"]["observation"]["type"], "missing");
                self.deletes.lock().unwrap().push(index);
                let result = if self.changed.lock().unwrap().contains(&index) {
                    "changed"
                } else if self.absent.lock().unwrap().insert(index) {
                    "deleted"
                } else {
                    "alreadyAbsent"
                };
                if self.lose_delete_reply.swap(false, Ordering::SeqCst) {
                    return Err(RuntimeError {
                        code: RuntimeErrorCode::StorageUnavailable,
                        message: "lost source delete acknowledgement".into(),
                        recovery_bound: None,
                        team_page_problem: None,
                    });
                }
                json!({"type":"sourceCleanupResult","snapshotHandle":HANDLE,"admissionId":self.admission_id,"index":index.to_string(),"result":{"type":result}})
            }
            "closeSourceSnapshot" => {
                if self.lose_close_reply.swap(false, Ordering::SeqCst) {
                    return Err(RuntimeError {
                        code: RuntimeErrorCode::StorageUnavailable,
                        message: "lost cleanup Close acknowledgement".into(),
                        recovery_bound: None,
                        team_page_problem: None,
                    });
                }
                json!({"type":"sourceSnapshotClosed"})
            }
            _ => panic!("Committed cleanup must never read or import source: {request}"),
        };
        Ok((Zeroizing::new(response.to_string()), None))
    }
}
async fn committed() -> (TestDirectory, Arc<import::RetainingPlatform>) {
    let directory = TestDirectory::new();
    let platform = Arc::new(import::RetainingPlatform::default());
    let runtime =
        runtime_with_platform_and_source(&directory, platform.clone(), import::Source::new()).await;
    runtime.open().await.unwrap();
    runtime.close().await;
    assert_eq!(platform.catalog()["profileAdmission"]["phase"], "committed");
    (directory, platform)
}

#[tokio::test]
async fn committed_cleanup_compacts_exact_obligations_after_durable_receipts() {
    let (directory, platform) = committed().await;
    let before = platform.catalog();
    let source = CleanupSource::new(platform.clone());
    let runtime =
        runtime_with_platform_and_source(&directory, platform.clone(), source.clone()).await;
    runtime.open().await.unwrap();
    let after = platform.catalog();
    assert_eq!(after["profileAdmission"]["phase"], "complete");
    assert!(after["profileAdmission"].get("progress").is_none());
    assert_eq!(after["accounts"], before["accounts"]);
    assert_eq!(
        after["profileAdmission"]["admissionId"],
        before["profileAdmission"]["admissionId"]
    );
    assert_eq!(
        after["profileAdmission"]["legacyPresentation"],
        before["profileAdmission"]["legacyPresentation"]
    );
    assert_eq!(source.absent.lock().unwrap().len(), 4);
    assert!(cleanup_status(&runtime)
        .get("profileAdmissionCleanup")
        .is_none());
    runtime.close().await;
}

#[tokio::test]
async fn lost_source_delete_reply_reopens_exact_committed_scope_and_completes() {
    let (directory, platform) = committed().await;
    let source = CleanupSource::new(platform.clone());
    source.lose_delete_reply.store(true, Ordering::SeqCst);
    let runtime =
        runtime_with_platform_and_source(&directory, platform.clone(), source.clone()).await;
    runtime.open().await.unwrap();
    assert_eq!(platform.catalog()["profileAdmission"]["phase"], "committed");
    assert_eq!(source.absent.lock().unwrap().len(), 1);
    runtime.close().await;
    let retry =
        runtime_with_platform_and_source(&directory, platform.clone(), source.clone()).await;
    retry.open().await.unwrap();
    assert_eq!(platform.catalog()["profileAdmission"]["phase"], "complete");
    assert!(
        source
            .deletes
            .lock()
            .unwrap()
            .iter()
            .filter(|index| **index == 0)
            .count()
            >= 2
    );
    retry.close().await;
}

#[tokio::test]
async fn changed_source_stays_pending_without_blocking_core_and_last_account_removal() {
    let (directory, platform) = committed().await;
    let source = CleanupSource::new(platform.clone());
    source.changed.lock().unwrap().insert(0);
    let runtime =
        runtime_with_platform_and_source(&directory, platform.clone(), source.clone()).await;
    runtime.open().await.unwrap();
    assert_eq!(platform.catalog()["profileAdmission"]["phase"], "committed");
    assert!(!source.absent.lock().unwrap().contains(&0));
    runtime.close().await;
    // A formerly completed exact reference was replaced while another obligation stayed pending.
    source.absent.lock().unwrap().remove(&2);
    source.changed.lock().unwrap().insert(2);
    let replaced =
        runtime_with_platform_and_source(&directory, platform.clone(), source.clone()).await;
    replaced.open().await.unwrap();
    let catalog_after_recheck = platform.catalog();
    let replacement = catalog_after_recheck["profileAdmission"]["progress"]["sourceCleanup"]
        .as_array()
        .unwrap()
        .iter()
        .find(|entry| entry["manifestEntryIndex"] == "2")
        .unwrap();
    assert_eq!(replacement["disposition"], "pending");
    assert!(!source.absent.lock().unwrap().contains(&2));
    assert_eq!(
        cleanup_status(&replaced)["profileAdmissionCleanup"]["pendingObligations"],
        "2"
    );
    replaced.close().await;
    let mut catalog = platform.catalog();
    catalog["accounts"] = json!([]);
    platform
        .values
        .lock()
        .unwrap()
        .insert(("devicePlain".into(), CATALOG.into()), catalog.to_string());
    source.changed.lock().unwrap().clear();
    let retry =
        runtime_with_platform_and_source(&directory, platform.clone(), source.clone()).await;
    retry.open().await.unwrap();
    assert_eq!(platform.catalog()["profileAdmission"]["phase"], "complete");
    assert_eq!(platform.catalog()["accounts"], json!([]));
    retry.close().await;
}

fn cleanup_status(runtime: &Arc<Runtime>) -> Value {
    let sink = Arc::new(Sink::default());
    let observation = runtime
        .observe(
            ObservationRequest::RuntimeStatus { account_id: None },
            sink.clone(),
        )
        .unwrap();
    let projections = sink.0.lock().unwrap();
    let Some(RuntimeProjection::RuntimeStatus(status)) = projections.last() else {
        panic!("missing status");
    };
    let result = serde_json::to_value(status).unwrap();
    observation.close();
    result
}

#[tokio::test]
async fn provider_absent_committed_open_exposes_pending_and_fences_wipe() {
    let (directory, platform) = committed().await;
    let before = platform.catalog();
    let writes = platform.sets.lock().unwrap().len();
    let runtime = runtime_with_platform(&directory, platform.clone()).await;
    runtime.open().await.unwrap();
    assert_eq!(
        cleanup_status(&runtime)["profileAdmissionCleanup"],
        json!({"state":"pending","pendingObligations":"4"})
    );
    let result = runtime
        .request(
            bittery_client_core::RuntimeRequest::Wipe,
            bittery_client_core::RequestCancellation::new(),
        )
        .await
        .unwrap();
    assert!(matches!(
        result,
        bittery_client_core::RuntimeResponse::Teardown {
            status: bittery_client_core::TeardownStatus::Incomplete,
            ..
        }
    ));
    assert_eq!(platform.catalog(), before);
    assert_eq!(platform.sets.lock().unwrap().len(), writes);
    runtime.close().await;
}

#[tokio::test]
async fn cleanup_only_close_reply_loss_does_not_block_ready_or_erase_duty() {
    let (directory, platform) = committed().await;
    let source = CleanupSource::new(platform.clone());
    source.lose_close_reply.store(true, Ordering::SeqCst);
    let runtime =
        runtime_with_platform_and_source(&directory, platform.clone(), source.clone()).await;
    runtime.open().await.unwrap();
    assert_eq!(platform.catalog()["profileAdmission"]["phase"], "complete");
    assert_eq!(cleanup_status(&runtime)["closed"], false);
    runtime.close().await;
    assert!(!source.lose_close_reply.load(Ordering::SeqCst));
}

struct LostCatalogReply {
    inner: Arc<import::RetainingPlatform>,
    target_phase: &'static str,
    armed: AtomicBool,
    fail_read: AtomicBool,
}
#[async_trait]
impl SerializedPlatformStorageExecutor for LostCatalogReply {
    async fn invoke(&self, request: Zeroizing<String>) -> Result<Zeroizing<String>, RuntimeError> {
        let parsed: PlatformStorageRequest = serde_json::from_str(&request).unwrap();
        if matches!(&parsed,PlatformStorageRequest::Get{key,..} if key==CATALOG)
            && self.fail_read.swap(false, Ordering::SeqCst)
        {
            return Err(RuntimeError {
                code: RuntimeErrorCode::StorageUnavailable,
                message: "lost cleanup catalog readback".into(),
                recovery_bound: None,
                team_page_problem: None,
            });
        }
        let fail = match &parsed {
            PlatformStorageRequest::Set { key, value, .. } if key == CATALOG => {
                let value: Value = serde_json::from_str(value).unwrap();
                value["profileAdmission"]["phase"] == self.target_phase
                    && self.armed.swap(false, Ordering::SeqCst)
            }
            _ => false,
        };
        let response = self.inner.invoke(request).await?;
        if fail {
            self.fail_read.store(true, Ordering::SeqCst);
            return Err(RuntimeError {
                code: RuntimeErrorCode::StorageUnavailable,
                message: "lost cleanup catalog write acknowledgement".into(),
                recovery_bound: None,
                team_page_problem: None,
            });
        }
        Ok(response)
    }
}

#[tokio::test]
async fn lost_compaction_reply_and_readback_preserve_durable_tombstone_for_core_only_retry() {
    let (directory, platform) = committed().await;
    let source = CleanupSource::new(platform.clone());
    let fault = Arc::new(LostCatalogReply {
        inner: platform.clone(),
        target_phase: "complete",
        armed: AtomicBool::new(true),
        fail_read: AtomicBool::new(false),
    });
    let runtime = runtime_with_platform_and_source(&directory, fault, source.clone()).await;
    runtime
        .open()
        .await
        .expect_err("ambiguous catalog must fence this open");
    assert_eq!(source.absent.lock().unwrap().len(), 4);
    assert_eq!(platform.catalog()["profileAdmission"]["phase"], "complete");
    runtime.close().await;
    let retry = runtime_with_platform(&directory, platform.clone()).await;
    retry.open().await.unwrap();
    assert!(cleanup_status(&retry)
        .get("profileAdmissionCleanup")
        .is_none());
    retry.close().await;
}

#[tokio::test]
async fn lost_receipt_catalog_readback_stops_before_next_delete_and_rechecks_absence_on_retry() {
    let (directory, platform) = committed().await;
    let source = CleanupSource::new(platform.clone());
    let fault = Arc::new(LostCatalogReply {
        inner: platform.clone(),
        target_phase: "committed",
        armed: AtomicBool::new(true),
        fail_read: AtomicBool::new(false),
    });
    let runtime = runtime_with_platform_and_source(&directory, fault, source.clone()).await;
    runtime
        .open()
        .await
        .expect_err("ambiguous receipt must fence this open");
    assert_eq!(source.absent.lock().unwrap().len(), 1);
    assert_eq!(source.deletes.lock().unwrap().as_slice(), [0]);
    runtime.close().await;
    let retry =
        runtime_with_platform_and_source(&directory, platform.clone(), source.clone()).await;
    retry.open().await.unwrap();
    assert_eq!(platform.catalog()["profileAdmission"]["phase"], "complete");
    assert_eq!(
        source
            .deletes
            .lock()
            .unwrap()
            .iter()
            .filter(|index| **index == 0)
            .count(),
        2
    );
    retry.close().await;
}
