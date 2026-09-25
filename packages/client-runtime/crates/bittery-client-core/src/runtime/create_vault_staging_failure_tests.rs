//! Production dispatcher and HTTP adapter; failures are injected at the actual staging boundary.
use super::*;
use crate::replica::{GuardedCommitPlan, PlanMutation, PlanResult};
use crate::runtime::operation_fixtures::*;
use serde_json::{json, Value};

struct StagingHttp {
    stale_grant: bool,
    forbid_http: std::sync::atomic::AtomicBool,
    runtime: Mutex<std::sync::Weak<Runtime>>,
    operation: Mutex<Option<OperationRecord>>,
    newer: Mutex<Option<ReplicaSnapshot>>,
}
#[async_trait]
impl SerializedHttpExecutor for StagingHttp {
    async fn invoke(&self, text: zeroize::Zeroizing<String>) -> Result<String, RuntimeError> {
        assert!(
            !self.forbid_http.load(Ordering::SeqCst),
            "retired staging transport sent with its old Session"
        );
        let request: Value = serde_json::from_str(&text).unwrap();
        let operation = self.operation.lock().unwrap().clone().unwrap();
        let url = request["url"].as_str().unwrap();
        let response = if url.ends_with("/status") {
            if self.stale_grant {
                json!({"state":"absent"})
            } else {
                json!({"state":"confirmed", "generation":1, "leaseExpiresAt":"2026-09-10T00:00:00Z", "objectKey":operation.vault_image().unwrap().object_key})
            }
        } else if url.ends_with("/grants") && self.stale_grant {
            let runtime = self.runtime.lock().unwrap().upgrade().unwrap();
            let snapshot = runtime.replica.snapshot(&AccountId::from(ACCOUNT)).unwrap();
            let mut rescheduled = snapshot.operations[0].clone();
            rescheduled.scheduling.attempt_count += 1;
            assert!(matches!(
                runtime
                    .replica
                    .execute_exact(GuardedCommitPlan::new(
                        snapshot.account_id.clone(),
                        snapshot.incarnation,
                        snapshot.revision,
                        snapshot.lock_epoch,
                        vec![PlanMutation::RescheduleOperation(rescheduled)],
                    ))
                    .await
                    .unwrap(),
                PlanResult::Applied { .. }
            ));
            *self.newer.lock().unwrap() = runtime.replica.snapshot(&snapshot.account_id);
            json!({"generation":1, "leaseExpiresAt":"2026-09-10T00:00:00Z", "objectKey":"contradictory-object", "uploadUrl":"https://example.test/unused", "uploadHeaders":[]})
        } else {
            panic!("unexpected staging request: {url}");
        };
        Ok(completed(200, serde_json::to_vec(&response).unwrap()).to_string())
    }
    fn cancel(&self, _: &str) {}
}

async fn image_runtime(stale_grant: bool) -> (Harness, Arc<Runtime>, Arc<StagingHttp>) {
    image_runtime_with_lost_commit(stale_grant, None).await
}

async fn image_runtime_with_lost_commit(
    stale_grant: bool,
    lost: Option<Arc<std::sync::atomic::AtomicBool>>,
) -> (Harness, Arc<Runtime>, Arc<StagingHttp>) {
    let seed = seeded(false).await;
    let http = Arc::new(StagingHttp {
        stale_grant,
        forbid_http: std::sync::atomic::AtomicBool::new(false),
        runtime: Mutex::new(std::sync::Weak::new()),
        operation: Mutex::new(None),
        newer: Mutex::new(None),
    });
    let persistence: Arc<dyn crate::replica::SerializedReplicaExecutor> = match lost {
        Some(armed) => Arc::new(LostCheckpointReply {
            inner: seed.replica.clone(),
            armed,
        }),
        None => seed.replica.clone(),
    };
    let runtime = Runtime::with_test_dispatch_environment(
        persistence,
        seed.platform.clone(),
        http.clone(),
        auth_config(),
        seed.clock.clone(),
        seed.timer.clone(),
    );
    *http.runtime.lock().unwrap() = Arc::downgrade(&runtime);
    runtime
        .platform_storage
        .store_device_key(&DeviceKeyDocument::new([7; 32]))
        .await
        .unwrap();
    runtime.replica.load(&seed.account_id).await.unwrap();
    runtime.unlock_account(&seed.account_id).await.unwrap();
    runtime.install_vault_image_ingress(
        crate::VaultImageIngressFacade::new(
            "staging-failure-runtime",
            Arc::new(crate::runtime::create_vault_tests::ExactImageSourcePort),
            Arc::new(crate::MemoryVaultImageArtifactStore::default()),
        )
        .unwrap(),
    );
    runtime
        .request(
            RuntimeRequest::CreateVault {
                account_id: seed.account_id.clone(),
                name: "Staging retry".into(),
                vault_type: crate::CreateVaultType::Personal,
                icon: "lock".into(),
                image_source: Some(crate::VaultImageSourceInput {
                    capability_id: "opaque-image-source".into(),
                    byte_length: 11,
                    content_type: "image/png".into(),
                }),
            },
            RequestCancellation::new(),
        )
        .await
        .unwrap();
    *http.operation.lock().unwrap() = Some(
        runtime
            .replica
            .snapshot(&seed.account_id)
            .unwrap()
            .operations[0]
            .clone(),
    );
    (seed, runtime, http)
}

#[tokio::test]
async fn physical_staging_checkpoint_failure_retries_without_failing_the_account() {
    let (seed, runtime, _http) = image_runtime(false).await;
    let before = runtime.replica.snapshot(&seed.account_id).unwrap();
    seed.replica.fail_next_commits(1);
    let _pass = runtime.dispatch_eligible_operations().await;
    let current = runtime.replica.snapshot(&seed.account_id).unwrap();
    assert!(
        current.failure.is_none(),
        "physical checkpoint failure became permanent Account failure"
    );
    assert_eq!(current.operations[0].request, before.operations[0].request);
    assert_eq!(
        current.operations[0].request_fingerprint,
        before.operations[0].request_fingerprint
    );
    assert_eq!(
        current.operations[0].vault_image_checkpoint(),
        Some(CreateVaultCheckpoint::ArtifactReady)
    );
    assert!(current.operations[0].scheduling.not_before_ms > seed.clock.now_ms().unwrap());
    assert_eq!(seed.replica.failed_commits(), 1);
    runtime.close().await;
    seed.runtime.close().await;
}

#[tokio::test]
async fn stale_staging_grant_cannot_fail_the_newer_account_snapshot() {
    let (seed, runtime, http) = image_runtime(true).await;
    let _pass = runtime.dispatch_eligible_operations().await;
    let newer = http.newer.lock().unwrap().clone().unwrap();
    assert_eq!(
        runtime.replica.snapshot(&seed.account_id).unwrap(),
        newer,
        "late staging contradiction failed unrelated newer authority"
    );
    runtime.close().await;
    seed.runtime.close().await;
}

#[tokio::test]
async fn repeated_staging_storage_failure_keeps_a_bounded_retry_in_the_existing_dispatcher() {
    let (seed, runtime, _http) = image_runtime(false).await;
    let before = runtime.replica.snapshot(&seed.account_id).unwrap();
    seed.replica.fail_next_commits(3);
    let pass = runtime.dispatch_eligible_operations().await;
    assert!(
        matches!(
            pass,
            crate::runtime::dispatch::DispatchPass::WaitFor { milliseconds: 1000 }
        ),
        "checkpoint plus retry-write failure did not leave a bounded driver wait"
    );
    assert_eq!(seed.replica.failed_commits(), 3);
    assert_eq!(runtime.replica.snapshot(&seed.account_id).unwrap(), before);
    let other = AccountId::from("independent-cleanup-account");
    seed.replica
        .state
        .install(
            other.clone(),
            "other-user".into(),
            crate::Incarnation::from(INCARNATION),
        )
        .unwrap();
    seed.replica
        .state
        .seed_ready_authority(
            &other,
            vec![crate::test_fixtures::personal_vault(
                "other-vault",
                "other-user",
            )],
            vec![],
        )
        .unwrap();
    let other_snapshot = runtime.replica.load(&other).await.unwrap().unwrap();
    runtime
        .replica
        .execute_exact(GuardedCommitPlan::new(
            other.clone(),
            other_snapshot.incarnation,
            other_snapshot.revision,
            other_snapshot.lock_epoch,
            vec![PlanMutation::RetireVaults {
                vault_ids: vec!["other-vault".into()],
            }],
        ))
        .await
        .unwrap();
    assert!(matches!(
        runtime.dispatch_eligible_operations().await,
        crate::runtime::dispatch::DispatchPass::Progressed
    ));
    assert!(
        runtime
            .replica
            .snapshot(&other)
            .unwrap()
            .bootstrap
            .pending_vault_retirements
            .is_empty(),
        "failed Account storage prevented independent cleanup"
    );
    let pass = runtime.dispatch_eligible_operations().await;
    assert!(matches!(
        pass,
        crate::runtime::dispatch::DispatchPass::WaitFor { milliseconds: 1000 }
    ));
    assert_eq!(
        runtime.replica.snapshot(&seed.account_id).unwrap(),
        before,
        "an unrelated wake retried before the bounded deadline"
    );
    seed.clock.advance(1000);
    seed.replica.fail_next_commits(3);
    assert!(matches!(
        runtime.dispatch_eligible_operations().await,
        crate::runtime::dispatch::DispatchPass::WaitFor { milliseconds: 1000 }
    ));
    assert_eq!(seed.replica.failed_commits(), 6);
    assert_eq!(runtime.replica.snapshot(&seed.account_id).unwrap(), before);
    runtime.close().await;
    seed.runtime.close().await;
}

#[tokio::test]
async fn staging_transport_cannot_follow_retained_operation_ids_into_a_replacement_account() {
    let (seed, runtime, http) = image_runtime(false).await;
    let execution = runtime.account_execution_lock(&seed.account_id).unwrap();
    let held = execution.lock().await;
    let work = runtime.dispatch_eligible_operations();
    tokio::pin!(work);
    assert!(
        std::future::poll_fn(|context| std::task::Poll::Ready(
            std::future::Future::poll(work.as_mut(), context).is_pending()
        ))
        .await,
        "production attempt must be waiting at the existing Account execution fence"
    );
    let replacement = runtime
        .replica
        .install_or_replace(
            seed.account_id.clone(),
            USER.into(),
            crate::Incarnation::from("replacement-incarnation"),
        )
        .await
        .unwrap();
    assert!(
        !replacement.operations.is_empty(),
        "replacement preserves accepted Operation IDs"
    );
    runtime.replica.cache(replacement.clone());
    http.forbid_http.store(true, Ordering::SeqCst);
    drop(held);
    let _pass = work.await;
    assert_eq!(
        runtime.replica.snapshot(&seed.account_id).unwrap(),
        replacement
    );
    runtime.close().await;
    seed.runtime.close().await;
}

struct LostCheckpointReply {
    inner: Arc<PlainReplica>,
    armed: Arc<std::sync::atomic::AtomicBool>,
}
#[async_trait]
impl crate::replica::SerializedReplicaExecutor for LostCheckpointReply {
    async fn invoke(&self, text: String) -> Result<String, RuntimeError> {
        let request: crate::replica::ReplicaPersistenceRequest =
            serde_json::from_str(&text).unwrap();
        let lose = matches!(
            request,
            crate::replica::ReplicaPersistenceRequest::Commit { .. }
        ) && self.armed.swap(false, Ordering::SeqCst);
        let reply =
            crate::replica::SerializedReplicaExecutor::invoke(self.inner.as_ref(), text).await?;
        if lose {
            Err(RuntimeError::new(
                RuntimeErrorCode::InvariantViolation,
                "lost physical checkpoint reply",
            ))
        } else {
            Ok(reply)
        }
    }
}

#[tokio::test]
async fn lost_staging_checkpoint_reply_reloads_the_committed_checkpoint_before_backoff() {
    let armed = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let (seed, runtime, _http) = image_runtime_with_lost_commit(false, Some(armed.clone())).await;
    let before = runtime
        .replica
        .snapshot(&seed.account_id)
        .unwrap()
        .operations[0]
        .clone();
    armed.store(true, Ordering::SeqCst);
    let _pass = runtime.dispatch_eligible_operations().await;
    let current = runtime.replica.snapshot(&seed.account_id).unwrap();
    assert!(current.failure.is_none());
    assert_eq!(
        current.operations[0].vault_image_checkpoint(),
        Some(CreateVaultCheckpoint::RemoteUploadConfirmed)
    );
    assert_eq!(current.operations[0].request, before.request);
    assert_eq!(
        current.operations[0].request_fingerprint,
        before.request_fingerprint
    );
    assert!(current.operations[0].scheduling.not_before_ms > seed.clock.now_ms().unwrap());
    assert_eq!(current.operations[0].scheduling.attempt_count, 1);
    assert!(current.receipts.is_empty());
    runtime.close().await;
    seed.runtime.close().await;
}
