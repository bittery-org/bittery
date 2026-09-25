//! Actual SQLite promotion boundaries; HTTP is a controlled authoritative Bootstrap feed.
use super::{operation_fixtures::*, *};
use crate::replica::{
    persistence_contract::{
        ExpectedReplicaInstall, PreparedReplicaInstall, PreparedReplicaWrite,
        ReplicaPersistenceResponse, ReplicaStore,
    },
    BootstrapGuard, MarkRefreshRequiredPlan, ReplicaPersistence, ReplicaPersistenceRequest,
    SerializedReplicaExecutor, SqliteReplica,
};
use async_trait::async_trait;
use serde_json::{json, Value};
use std::sync::atomic::{AtomicBool, AtomicUsize};
use tokio::sync::Semaphore;

struct HeldPromotion {
    sqlite: SqliteReplica,
    armed: AtomicBool,
    fail_before: AtomicBool,
    apply_then_fail: AtomicBool,
    reached: Semaphore,
    release: Semaphore,
}
#[async_trait]
impl SerializedReplicaExecutor for HeldPromotion {
    async fn invoke(&self, text: String) -> Result<String, RuntimeError> {
        let request: ReplicaPersistenceRequest = serde_json::from_str(&text).unwrap();
        let retires = matches!(&request, ReplicaPersistenceRequest::Commit { prepared }
            if prepared.writes.iter().any(|write| matches!(write,
                PreparedReplicaWrite::Put { row } if row.store == ReplicaStore::ReplicaMetadata && row.key.record_id == "vault-retirements")));
        let held = retires && self.armed.swap(false, Ordering::SeqCst);
        if held {
            self.reached.add_permits(1);
            self.release.acquire().await.unwrap().forget();
            if self.fail_before.swap(false, Ordering::SeqCst) {
                return Err(RuntimeError::new(
                    RuntimeErrorCode::InvariantViolation,
                    "injected physical promotion failure",
                ));
            }
        }
        let response = ReplicaPersistence::invoke(&self.sqlite, request).await?;
        if held && self.apply_then_fail.swap(false, Ordering::SeqCst) {
            return Err(RuntimeError::new(
                RuntimeErrorCode::InvariantViolation,
                "injected lost promotion acknowledgement",
            ));
        }
        Ok(serde_json::to_string(&response).unwrap())
    }
}
struct RetirementHttp {
    server: Arc<FakeServer>,
    visible: Arc<Mutex<Value>>,
    offline: Arc<AtomicBool>,
    policy_reads: Arc<AtomicUsize>,
}
#[async_trait]
impl SerializedHttpExecutor for RetirementHttp {
    async fn invoke(&self, text: zeroize::Zeroizing<String>) -> Result<String, RuntimeError> {
        assert!(
            !self.offline.load(Ordering::SeqCst),
            "retirement tried HTTP after complete authority was durable"
        );
        let request: Value = serde_json::from_str(&text).unwrap();
        if request["method"] == "GET"
            && request["url"]
                .as_str()
                .is_some_and(|url| url.ends_with("/api/v1/travel-mode"))
        {
            self.policy_reads.fetch_add(1, Ordering::SeqCst);
            return Ok(completed(
                200,
                serde_json::to_vec(&json!({
                    "enabled":false,"hiddenVaultIds":[],"enabledAt":null,
                    "updatedAt":"2023-11-14T22:13:20Z"
                }))
                .unwrap(),
            )
            .to_string());
        }
        if let Some(url) = request["url"]
            .as_str()
            .filter(|url| url.contains("/sync/bootstrap"))
        {
            let body = if url.contains("phase=items") {
                json!({"phase":"items","items":[],"hasMore":false,"nextCursor":null,"syncCursor":null})
            } else {
                json!({"phase":"vaults","vaults":self.visible.lock().unwrap().clone(),"hasMore":false,"nextCursor":null,"syncCursor":null})
            };
            return Ok(completed(200, serde_json::to_vec(&body).unwrap()).to_string());
        }
        self.server.invoke(text).await
    }
    fn cancel(&self, id: &str) {
        self.server.cancel(id);
    }
}

type RetirementHarness = (
    Harness,
    Arc<Runtime>,
    Arc<HeldPromotion>,
    Arc<AtomicBool>,
    Arc<Mutex<Value>>,
    Arc<AtomicUsize>,
);

async fn seeded_retirement() -> RetirementHarness {
    seeded_retirement_at(":memory:").await
}

async fn seeded_retirement_at(path: &str) -> RetirementHarness {
    let seed = seeded_with_existing_item(true, false).await;
    let loaded = seed
        .replica
        .state
        .invoke(ReplicaPersistenceRequest::Load {
            account_id: seed.account_id.clone(),
        })
        .await
        .unwrap();
    let ReplicaPersistenceResponse::Loaded {
        head: Some(head),
        rows,
    } = loaded
    else {
        panic!("seeded physical rows");
    };
    let sqlite = SqliteReplica::open(path).unwrap();
    ReplicaPersistence::invoke(
        &sqlite,
        ReplicaPersistenceRequest::Install {
            prepared: PreparedReplicaInstall {
                expected: ExpectedReplicaInstall::Missing {
                    account_id: seed.account_id.clone(),
                },
                next_head: head,
                writes: rows
                    .into_iter()
                    .map(|row| PreparedReplicaWrite::Put { row })
                    .collect(),
            },
        },
    )
    .await
    .unwrap();
    let persistence = Arc::new(HeldPromotion {
        sqlite,
        armed: AtomicBool::new(true),
        fail_before: AtomicBool::new(false),
        apply_then_fail: AtomicBool::new(false),
        reached: Semaphore::new(0),
        release: Semaphore::new(0),
    });
    let visible = seed
        .runtime
        .replica
        .snapshot(&seed.account_id)
        .unwrap()
        .bootstrap
        .snapshot()
        .visible_vaults
        .into_iter()
        .find(|vault| vault.id == "vault-2")
        .unwrap();
    let offline = Arc::new(AtomicBool::new(false));
    let visible = Arc::new(Mutex::new(json!([visible])));
    let policy_reads = Arc::new(AtomicUsize::new(0));
    let http = Arc::new(RetirementHttp {
        server: seed.server.clone(),
        visible: visible.clone(),
        offline: offline.clone(),
        policy_reads: policy_reads.clone(),
    });
    let runtime = Runtime::with_test_dispatch_environment(
        persistence.clone(),
        seed.platform.clone(),
        http,
        auth_config(),
        seed.clock.clone(),
        seed.timer.clone(),
    );
    runtime.replica.load(&seed.account_id).await.unwrap();
    runtime.unlock_account(&seed.account_id).await.unwrap();
    runtime.decrypt_visible_items(&seed.account_id).unwrap();
    let snapshot = runtime.replica.snapshot(&seed.account_id).unwrap();
    runtime
        .replica
        .mark_refresh_required(MarkRefreshRequiredPlan {
            guard: BootstrapGuard {
                account_id: snapshot.account_id.clone(),
                user_id: snapshot.user_id.clone(),
                incarnation: snapshot.incarnation.clone(),
                expected_replica_revision: snapshot.revision,
                expected_lock_epoch: snapshot.lock_epoch,
            },
        })
        .await
        .unwrap();
    (seed, runtime, persistence, offline, visible, policy_reads)
}

#[tokio::test]
async fn complete_bootstrap_fences_hidden_projection_before_physical_promotion() {
    let (seed, runtime, persistence, _offline, _visible, policy_reads) = seeded_retirement().await;
    let owner = runtime.clone();
    let account = seed.account_id.clone();
    let bootstrap = tokio::spawn(async move {
        owner
            .bootstrap_account(&account, RequestCancellation::new())
            .await
    });
    tokio::time::timeout(
        std::time::Duration::from_secs(5),
        persistence.reached.acquire(),
    )
    .await
    .unwrap()
    .unwrap()
    .forget();
    assert!(
        policy_reads.load(Ordering::SeqCst) > 0,
        "complete authority must pass the current policy verification route"
    );
    let snapshot = runtime.replica.snapshot(&seed.account_id).unwrap();
    assert!(
        snapshot.bootstrap.pending_vault_retirements.is_empty(),
        "physical promotion is still held"
    );
    assert!(
        snapshot.bootstrap.staging_generation.is_some(),
        "durable complete authority is the precommit proof"
    );
    let RuntimeProjection::Items(items) = runtime
        .projection(&ObservationRequest::Items {
            account_id: seed.account_id.clone(),
        })
        .unwrap()
        .projection
    else {
        panic!("Items");
    };
    // Release the controlled I/O before asserting so a failing reproduction cannot strand the task.
    persistence.release.add_permits(1);
    bootstrap.await.unwrap().unwrap();
    assert!(
        items
            .items
            .iter()
            .all(|item| item.vault_id != crate::test_fixtures::TEST_VAULT_ID),
        "hidden plaintext escaped before physical retirement commit"
    );
    assert!(
        items
            .vaults
            .iter()
            .all(|vault| vault.vault_id != crate::test_fixtures::TEST_VAULT_ID),
        "hidden Vault metadata escaped before physical retirement commit"
    );
    assert!(
        items.vaults.iter().any(|vault| vault.vault_id == "vault-2"),
        "unrelated visible Vault remains readable"
    );
    runtime.close().await;
    seed.runtime.close().await;
}

#[tokio::test]
async fn retirement_driver_resumes_failed_or_unacknowledged_promotion_without_session_or_operations(
) {
    for applied_before_failure in [false, true] {
        let (seed, runtime, persistence, offline, _visible, policy_reads) =
            seeded_retirement().await;
        persistence
            .fail_before
            .store(!applied_before_failure, Ordering::SeqCst);
        persistence
            .apply_then_fail
            .store(applied_before_failure, Ordering::SeqCst);
        let owner = runtime.clone();
        let account = seed.account_id.clone();
        let bootstrap = tokio::spawn(async move {
            owner
                .bootstrap_account(&account, RequestCancellation::new())
                .await
        });
        tokio::time::timeout(
            std::time::Duration::from_secs(5),
            persistence.reached.acquire(),
        )
        .await
        .unwrap()
        .unwrap()
        .forget();
        assert!(
            policy_reads.load(Ordering::SeqCst) > 0,
            "complete authority must pass the current policy verification route"
        );
        persistence.release.add_permits(1);
        assert!(bootstrap.await.unwrap().is_err());
        offline.store(true, Ordering::SeqCst);
        runtime
            .platform_storage
            .remove_current_session(&seed.account_id, &crate::Incarnation::from(INCARNATION))
            .await
            .unwrap();
        runtime.mark_reauthentication_required(&seed.account_id);
        assert!(runtime
            .replica
            .snapshot(&seed.account_id)
            .unwrap()
            .operations
            .is_empty());
        let _pass = runtime.dispatch_eligible_operations().await;
        let current = runtime.replica.snapshot(&seed.account_id).unwrap();
        assert!(
            current.bootstrap.staging_generation.is_none(),
            "complete durable staging was parked without a Session or Operation"
        );
        assert!(
            current.bootstrap.pending_vault_retirements.is_empty(),
            "physical retirement journal was not drained"
        );
        assert!(current
            .bootstrap
            .snapshot()
            .visible_vaults
            .iter()
            .all(|vault| vault.id != crate::test_fixtures::TEST_VAULT_ID));
        assert!(!runtime
            .foreground_attachments
            .has_pending_vault_retirement(&seed.account_id, &current.incarnation));
        runtime.close().await;
        seed.runtime.close().await;
    }
}

struct RetirementDatabase(std::path::PathBuf);
impl RetirementDatabase {
    fn new() -> Self {
        let id = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        Self(std::env::temp_dir().join(format!(
            "bittery-retirement-{}-{id}.sqlite",
            std::process::id()
        )))
    }
}
impl Drop for RetirementDatabase {
    fn drop(&mut self) {
        for suffix in ["", "-wal", "-shm"] {
            let _ = std::fs::remove_file(format!("{}{suffix}", self.0.display()));
        }
    }
}

#[tokio::test]
async fn reopening_sqlite_finishes_retirement_before_access_and_prunes_session_only_keys() {
    for committed in [false, true] {
        let database = RetirementDatabase::new();
        let (seed, runtime, persistence, offline, _visible, policy_reads) =
            seeded_retirement_at(database.0.to_str().unwrap()).await;
        let incarnation = crate::Incarnation::from(INCARNATION);
        runtime
            .platform_storage
            .store_device_catalog(
                &DeviceCatalogDocument::new(vec![DeviceCatalogAccount {
                    account_id: seed.account_id.clone(),
                    active_incarnation: Some(incarnation.clone()),
                    pending_retirement: None,
                    pending_install: None,
                }])
                .unwrap(),
            )
            .await
            .unwrap();
        let mut session = runtime
            .platform_storage
            .load_current_session(&seed.account_id, &incarnation)
            .await
            .unwrap()
            .unwrap();
        session.vault_keys = [
            crate::test_fixtures::TEST_VAULT_ID,
            "session-only",
            "vault-2",
        ]
        .into_iter()
        .map(|id| crate::server_contract::AuthVaultKeyResponse {
            encrypted_vault_key: crate::test_fixtures::personal_vault(id, USER).encrypted_vault_key,
            role: crate::server_contract::VaultRole::Owner,
            vault_icon: None,
            vault_id: id.into(),
            vault_image_url: None,
            vault_name: id.into(),
            vault_type: crate::server_contract::VaultType::Personal,
        })
        .collect();
        runtime
            .platform_storage
            .store_current_session(&session)
            .await
            .unwrap();
        persistence.fail_before.store(!committed, Ordering::SeqCst);
        persistence
            .apply_then_fail
            .store(committed, Ordering::SeqCst);
        let owner = runtime.clone();
        let account = seed.account_id.clone();
        let bootstrap = tokio::spawn(async move {
            owner
                .bootstrap_account(&account, RequestCancellation::new())
                .await
        });
        tokio::time::timeout(
            std::time::Duration::from_secs(5),
            persistence.reached.acquire(),
        )
        .await
        .unwrap()
        .unwrap()
        .forget();
        assert!(
            policy_reads.load(Ordering::SeqCst) > 0,
            "complete authority must pass the current policy verification route"
        );
        persistence.release.add_permits(1);
        assert!(bootstrap.await.unwrap().is_err());
        offline.store(true, Ordering::SeqCst);
        runtime.close().await;
        drop(runtime);
        drop(persistence);
        // A new SQLite connection and new Runtime; there is no surviving in-memory fence.
        let sqlite = Arc::new(SqliteReplica::open(database.0.to_str().unwrap()).unwrap());
        let http = Arc::new(RetirementHttp {
            server: seed.server.clone(),
            visible: Arc::new(Mutex::new(Value::Null)),
            offline,
            policy_reads: policy_reads.clone(),
        });
        let reopened = Runtime::with_test_dispatch_environment(
            sqlite,
            seed.platform.clone(),
            http,
            auth_config(),
            seed.clock.clone(),
            seed.timer.clone(),
        );
        reopened.ready.store(false, Ordering::SeqCst);
        reopened.open().await.unwrap();
        let current = reopened.replica.snapshot(&seed.account_id).unwrap();
        assert!(
            current.bootstrap.staging_generation.is_none(),
            "open published incomplete retirement staging"
        );
        assert!(
            current.bootstrap.pending_vault_retirements.is_empty(),
            "open published an undrained retirement journal"
        );
        let session = reopened
            .platform_storage
            .load_current_session(&seed.account_id, &incarnation)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            session
                .vault_keys
                .iter()
                .map(|key| key.vault_id.as_str())
                .collect::<Vec<_>>(),
            vec!["vault-2"],
            "hidden keys survived owner loss"
        );
        assert!(!current
            .bootstrap
            .vaults
            .keys()
            .any(|(_, id)| id == crate::test_fixtures::TEST_VAULT_ID));
        assert!(current
            .bootstrap
            .snapshot()
            .visible_vaults
            .iter()
            .any(|vault| vault.id == "vault-2"));
        reopened.close().await;
        seed.runtime.close().await;
    }
}

#[tokio::test]
async fn fresh_complete_bootstrap_readmits_a_retired_vault_without_reviving_old_access() {
    readmission(false).await;
}

#[tokio::test]
async fn failed_host_readmission_retries_with_bounded_backoff_without_session_or_operations() {
    readmission(true).await;
}

async fn readmission(fail_host: bool) {
    use super::foreground_attachment_lifecycle::ForegroundAttachmentTarget;
    let (seed, runtime, persistence, offline, visible, policy_reads) = seeded_retirement().await;
    let snapshot = runtime.replica.snapshot(&seed.account_id).unwrap();
    let target = ForegroundAttachmentTarget::Item {
        item_id: "item-existing".into(),
        vault_id: crate::test_fixtures::TEST_VAULT_ID.into(),
    };
    let cancellation = RequestCancellation::new();
    let loan = runtime
        .foreground_attachments
        .register_target(
            &seed.account_id,
            &snapshot.incarnation,
            target.clone(),
            cancellation.clone(),
        )
        .unwrap();
    let old_publication = runtime.foreground_attachments.publication(&loan);
    let original_vaults =
        serde_json::to_value(snapshot.bootstrap.snapshot().visible_vaults).unwrap();
    let owner = runtime.clone();
    let account = seed.account_id.clone();
    let bootstrap = tokio::spawn(async move {
        owner
            .bootstrap_account(&account, RequestCancellation::new())
            .await
    });
    tokio::time::timeout(
        std::time::Duration::from_secs(5),
        persistence.reached.acquire(),
    )
    .await
    .unwrap()
    .unwrap()
    .forget();
    assert!(
        policy_reads.load(Ordering::SeqCst) > 0,
        "complete authority must pass the current policy verification route"
    );
    let was_cancelled = cancellation.is_cancelled();
    drop(loan);
    persistence.release.add_permits(1);
    bootstrap.await.unwrap().unwrap();
    assert!(was_cancelled);
    assert!(!old_publication.begin());
    assert!(runtime.foreground_attachments.is_vault_fenced(
        &seed.account_id,
        &snapshot.incarnation,
        crate::test_fixtures::TEST_VAULT_ID
    ));
    let source = Arc::new(ReadmissionSource {
        fail: AtomicBool::new(fail_host),
        calls: std::sync::atomic::AtomicUsize::new(0),
    });
    runtime.install_vault_image_ingress(
        crate::vault_image::VaultImageIngressFacade::new(
            "readmission-runtime",
            source.clone(),
            Arc::new(crate::vault_image::MemoryVaultImageArtifactStore::default()),
        )
        .unwrap(),
    );
    *visible.lock().unwrap() = original_vaults;
    let current = runtime.replica.snapshot(&seed.account_id).unwrap();
    runtime
        .replica
        .mark_refresh_required(MarkRefreshRequiredPlan {
            guard: BootstrapGuard {
                account_id: current.account_id.clone(),
                user_id: current.user_id.clone(),
                incarnation: current.incarnation.clone(),
                expected_replica_revision: current.revision,
                expected_lock_epoch: current.lock_epoch,
            },
        })
        .await
        .unwrap();
    let result = runtime
        .bootstrap_account(&seed.account_id, RequestCancellation::new())
        .await;
    if fail_host {
        assert!(result.is_err());
        offline.store(true, Ordering::SeqCst);
        runtime
            .platform_storage
            .remove_current_session(&seed.account_id, &snapshot.incarnation)
            .await
            .unwrap();
        runtime.mark_reauthentication_required(&seed.account_id);
        let current = runtime.replica.snapshot(&seed.account_id).unwrap();
        assert!(current.operations.is_empty());
        assert!(current.bootstrap.staging_generation.is_none());
        assert!(current.bootstrap.pending_vault_retirements.is_empty());
        assert!(
            runtime.has_vault_retirement_work(&current),
            "completed promotion lost the failed host readmission duty"
        );
        let _pass = runtime.dispatch_eligible_operations().await;
        let attempts = source.calls.load(Ordering::SeqCst);
        assert_eq!(attempts, 2);
        let _pass = runtime.dispatch_eligible_operations().await;
        assert_eq!(
            source.calls.load(Ordering::SeqCst),
            attempts,
            "readmission ignored its existing fence deadline"
        );
        seed.clock.advance(1000);
        source.fail.store(false, Ordering::SeqCst);
        let _pass = runtime.dispatch_eligible_operations().await;
        assert_eq!(source.calls.load(Ordering::SeqCst), attempts + 1);
    } else {
        result.unwrap();
    }
    assert!(
        !runtime.foreground_attachments.is_vault_fenced(
            &seed.account_id,
            &snapshot.incarnation,
            crate::test_fixtures::TEST_VAULT_ID
        ),
        "fresh verified authority remained permanently fenced"
    );
    assert!(
        !old_publication.begin(),
        "readmission revived an old plaintext publication"
    );
    let new_loan = runtime
        .foreground_attachments
        .register_target(
            &seed.account_id,
            &snapshot.incarnation,
            target,
            RequestCancellation::new(),
        )
        .unwrap();
    drop(new_loan);
    let RuntimeProjection::Items(items) = runtime
        .projection(&ObservationRequest::Items {
            account_id: seed.account_id.clone(),
        })
        .unwrap()
        .projection
    else {
        panic!("Items");
    };
    assert_eq!(items.vaults.len(), 2);
    runtime.close().await;
    seed.runtime.close().await;
}

struct ReadmissionSource {
    fail: AtomicBool,
    calls: std::sync::atomic::AtomicUsize,
}
#[async_trait]
impl crate::vault_image::VaultImageSourcePort for ReadmissionSource {
    async fn claim(
        &self,
        _: &crate::vault_image::VaultImageSourceGrant,
    ) -> Result<
        Box<dyn crate::vault_image::VaultImageSource>,
        crate::vault_image::VaultImageSourceError,
    > {
        panic!("no image claim in readmission test")
    }
    async fn retire_account(
        &self,
        _: &str,
        _: &AccountId,
    ) -> Result<(), crate::vault_image::VaultImageSourceError> {
        Ok(())
    }
    async fn complete_account_retirement(
        &self,
        _: &str,
        _: &AccountId,
    ) -> Result<(), crate::vault_image::VaultImageSourceError> {
        Ok(())
    }
    async fn begin_acceptance(
        &self,
        _: &str,
        _: &AccountId,
        _: &str,
    ) -> Result<(), crate::vault_image::VaultImageSourceError> {
        panic!("no image acceptance")
    }
    async fn end_acceptance(
        &self,
        _: &str,
        _: &AccountId,
        _: &str,
    ) -> Result<(), crate::vault_image::VaultImageSourceError> {
        panic!("no image acceptance")
    }
    async fn retire_vaults(
        &self,
        _: &str,
        _: &AccountId,
        _: &[String],
    ) -> Result<(), crate::vault_image::VaultImageSourceError> {
        Ok(())
    }
    async fn complete_vault_retirement(
        &self,
        _: &str,
        _: &AccountId,
        _: &[String],
    ) -> Result<(), crate::vault_image::VaultImageSourceError> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        if self.fail.load(Ordering::SeqCst) {
            Err(crate::vault_image::VaultImageSourceError::Source)
        } else {
            Ok(())
        }
    }
    async fn forget_account_vault_retirements(
        &self,
        _: &str,
        _: &AccountId,
    ) -> Result<(), crate::vault_image::VaultImageSourceError> {
        Ok(())
    }
    async fn retire_runtime(
        &self,
        _: &str,
    ) -> Result<(), crate::vault_image::VaultImageSourceError> {
        Ok(())
    }
}
