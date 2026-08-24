use super::{
    persistence_contract::{
        prepare_commit, prepare_install, PreparedReplicaWrite, ReplicaRowKey, ReplicaStore,
    },
    AuthorityItemCategory, AuthorityItemRecord, BeginBootstrapPlan, BootstrapContinuation,
    BootstrapGenerationId, BootstrapGuard, BootstrapPageCursor, BootstrapPageIdentity,
    GuardedCommitPlan, InMemoryReplica, ObservedOutcome, OperationOutcomeResult, PlanMutation,
    PlanResult, PromoteBootstrapPlan, Replica, ReplicaPersistence, ReplicaPersistenceRequest,
    ReplicaPersistenceResponse, Sha256Fingerprint, SqliteReplica, StageBootstrapPagePlan,
    StageBootstrapPageResult, SyncCursor,
};
use crate::{protocol::Incarnation, AccountId, RuntimeError};
use async_trait::async_trait;
use std::{
    path::PathBuf,
    sync::{Arc, Mutex},
};

struct TestDatabase {
    path: PathBuf,
}

impl TestDatabase {
    fn new(test_name: &str) -> Self {
        let path = std::env::temp_dir().join(format!(
            "bittery-client-core-{test_name}-{}.sqlite3",
            std::process::id(),
        ));
        let _ = std::fs::remove_file(&path);
        Self { path }
    }
}

impl Drop for TestDatabase {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.path);
    }
}

fn operation(operation_id: &str, item_id: &str) -> super::OperationRecord {
    crate::test_fixtures::test_operation(operation_id, item_id)
}

fn item(account_id: &str, item_id: &str, operation_id: &str) -> super::ReplicaItemRecord {
    crate::test_fixtures::test_overlay(AccountId::from(account_id), item_id, operation_id)
}

async fn install(replica: &Replica, account_id: &str) {
    replica
        .install_or_replace(
            AccountId::from(account_id),
            format!("user-{account_id}"),
            Incarnation::from(format!("incarnation-{account_id}")),
        )
        .await
        .unwrap();
}

fn plan(account_id: &str, revision: u64, operation_id: &str) -> GuardedCommitPlan {
    GuardedCommitPlan::new(
        AccountId::from(account_id),
        Incarnation::from(format!("incarnation-{account_id}")),
        revision,
        0,
        vec![
            PlanMutation::AcceptOperation(operation(operation_id, "item-1")),
            PlanMutation::PutOptimisticItem(item(account_id, "item-1", operation_id)),
        ],
    )
}

#[tokio::test]
async fn sqlite_loads_a_missing_account_without_rows() {
    let database = TestDatabase::new("missing-account");
    let replica = SqliteReplica::open(&database.path).unwrap();

    let response = replica
        .invoke(ReplicaPersistenceRequest::Load {
            account_id: AccountId::from("account-missing"),
        })
        .await
        .unwrap();

    assert_eq!(
        response,
        ReplicaPersistenceResponse::Loaded {
            head: None,
            rows: vec![],
        }
    );
}

#[tokio::test]
async fn sqlite_matches_in_memory_for_install_commit_replay_lock_and_account_scope() {
    let database = TestDatabase::new("representative-history");
    let sqlite_persistence: Arc<dyn ReplicaPersistence> =
        Arc::new(SqliteReplica::open(&database.path).unwrap());
    let memory_persistence: Arc<dyn ReplicaPersistence> = Arc::new(InMemoryReplica::default());
    let sqlite = Replica::new(sqlite_persistence);
    let memory = Replica::new(memory_persistence);

    for replica in [&memory, &sqlite] {
        install(replica, "account-1").await;
        install(replica, "account-2").await;
    }
    for account_id in ["account-1", "account-2"] {
        assert_eq!(
            memory.load(&AccountId::from(account_id)).await.unwrap(),
            sqlite.load(&AccountId::from(account_id)).await.unwrap()
        );
    }

    let missing = GuardedCommitPlan::new(
        AccountId::from("account-missing"),
        Incarnation::from("incarnation-account-missing"),
        0,
        0,
        vec![],
    );
    assert_eq!(
        memory.execute(missing.clone()).await.unwrap(),
        PlanResult::Missing
    );
    assert_eq!(sqlite.execute(missing).await.unwrap(), PlanResult::Missing);

    let accepted = plan("account-1", 0, "operation-1");
    assert_eq!(
        memory.execute(accepted.clone()).await.unwrap(),
        sqlite.execute(accepted.clone()).await.unwrap()
    );
    assert_eq!(
        memory.load(&AccountId::from("account-1")).await.unwrap(),
        sqlite.load(&AccountId::from("account-1")).await.unwrap()
    );
    assert_eq!(
        memory.load(&AccountId::from("account-2")).await.unwrap(),
        sqlite.load(&AccountId::from("account-2")).await.unwrap()
    );

    assert_eq!(
        memory.execute(accepted.clone()).await.unwrap(),
        PlanResult::Stale { actual_revision: 1 }
    );
    assert_eq!(
        sqlite.execute(accepted).await.unwrap(),
        PlanResult::Stale { actual_revision: 1 }
    );
    assert_eq!(
        sqlite
            .load(&AccountId::from("account-1"))
            .await
            .unwrap()
            .unwrap()
            .revision,
        1
    );

    for replica in [&memory, &sqlite] {
        let advanced = replica
            .advance_lock_epoch(
                &AccountId::from("account-1"),
                "user-account-1",
                &Incarnation::from("incarnation-account-1"),
                1,
            )
            .await
            .unwrap();
        assert_eq!(advanced.lock_epoch, 1);
        assert_eq!(advanced.revision, 1);
    }
    assert_eq!(
        memory.load(&AccountId::from("account-1")).await.unwrap(),
        sqlite.load(&AccountId::from("account-1")).await.unwrap()
    );

    let cross_scope = GuardedCommitPlan::new(
        AccountId::from("account-2"),
        Incarnation::from("incarnation-account-2"),
        0,
        0,
        vec![PlanMutation::PutOptimisticItem(item(
            "account-1",
            "cross-account-item",
            "cross-account-operation",
        ))],
    );
    let memory_error = memory.execute(cross_scope.clone()).await.unwrap_err();
    let sqlite_error = sqlite.execute(cross_scope).await.unwrap_err();
    assert_eq!(memory_error.code, sqlite_error.code);
    assert_eq!(
        memory.load(&AccountId::from("account-2")).await.unwrap(),
        sqlite.load(&AccountId::from("account-2")).await.unwrap()
    );
}

#[tokio::test]
async fn sqlite_rolls_back_every_write_when_a_commit_boundary_fails() {
    let database = TestDatabase::new("atomic-failure");
    let initial: Arc<dyn ReplicaPersistence> =
        Arc::new(SqliteReplica::open(&database.path).unwrap());
    let initial_replica = Replica::new(initial);
    install(&initial_replica, "account-1").await;
    drop(initial_replica);

    let untouched = Replica::new(Arc::new(InMemoryReplica::default()));
    install(&untouched, "account-1").await;
    let expected = untouched.load(&AccountId::from("account-1")).await.unwrap();

    // Head, Operation, and optimistic overlay are three separate SQLite statements inside one
    // transaction. Failure after each boundary must expose exactly the old in-memory state.
    for boundary in 1..=3 {
        let failing: Arc<dyn ReplicaPersistence> =
            Arc::new(SqliteReplica::open_failing_after(&database.path, boundary).unwrap());
        let sqlite = Replica::new(failing);
        let failure: RuntimeError = sqlite
            .execute(plan("account-1", 0, "operation-failed"))
            .await
            .unwrap_err();
        assert!(failure
            .message
            .contains("injected SQLite Replica write failure"));
        assert_eq!(
            sqlite.load(&AccountId::from("account-1")).await.unwrap(),
            expected
        );
    }
}

struct RecordingPersistence {
    inner: InMemoryReplica,
    writes: Mutex<Vec<ReplicaPersistenceRequest>>,
}

impl RecordingPersistence {
    fn new() -> Self {
        Self {
            inner: InMemoryReplica::default(),
            writes: Mutex::new(Vec::new()),
        }
    }

    fn recorded(&self) -> Vec<ReplicaPersistenceRequest> {
        self.writes.lock().unwrap().clone()
    }
}

#[async_trait]
impl ReplicaPersistence for RecordingPersistence {
    async fn invoke(
        &self,
        request: ReplicaPersistenceRequest,
    ) -> Result<ReplicaPersistenceResponse, RuntimeError> {
        if !matches!(request, ReplicaPersistenceRequest::Load { .. }) {
            self.writes.lock().unwrap().push(request.clone());
        }
        self.inner.invoke(request).await
    }
}

struct FailureScenario {
    name: &'static str,
    setup: Vec<ReplicaPersistenceRequest>,
    request: ReplicaPersistenceRequest,
    before: Vec<u8>,
    after: Vec<u8>,
}

async fn canonical_account_bytes(
    persistence: &dyn ReplicaPersistence,
    account_id: &AccountId,
) -> Vec<u8> {
    let response = persistence
        .invoke(ReplicaPersistenceRequest::Load {
            account_id: account_id.clone(),
        })
        .await
        .unwrap();
    let ReplicaPersistenceResponse::Loaded { head, mut rows } = response else {
        panic!("load returned a write response");
    };
    rows.sort_by(|left, right| {
        serde_json::to_vec(left)
            .unwrap()
            .cmp(&serde_json::to_vec(right).unwrap())
    });
    serde_json::to_vec(&ReplicaPersistenceResponse::Loaded { head, rows }).unwrap()
}

fn authority_item(account_id: &str, item_id: &str, version: i32) -> AuthorityItemRecord {
    AuthorityItemRecord {
        id: item_id.to_owned(),
        vault_id: "vault-1".to_owned(),
        category: AuthorityItemCategory::Login,
        favorite: false,
        encrypted_data: format!("authoritative-sealed-{item_id}"),
        encryption_iv: "BBBBBBBBBBBBBBBB".to_owned(),
        encryption_algorithm: "AES-GCM-AAD-V1".to_owned(),
        version,
        encryption_version: 1,
        encrypted_by_user_id: format!("user-{account_id}"),
        last_modified_by: format!("user-{account_id}"),
        created_at: "2026-08-24T00:00:00Z".to_owned(),
        updated_at: "2026-08-24T00:01:00Z".to_owned(),
        deleted_at: None,
        attachments: Vec::new(),
    }
}

fn bootstrap_guard(account_id: &str, revision: u64) -> BootstrapGuard {
    BootstrapGuard {
        account_id: AccountId::from(account_id),
        user_id: format!("user-{account_id}"),
        incarnation: Incarnation::from(format!("incarnation-{account_id}")),
        expected_replica_revision: revision,
        expected_lock_epoch: 0,
    }
}

async fn ready_recording_replica() -> (Arc<RecordingPersistence>, Replica, AccountId) {
    let account_id = AccountId::from("account-matrix");
    let persistence = Arc::new(RecordingPersistence::new());
    let replica = Replica::new(persistence.clone());
    install(&replica, account_id.as_str()).await;
    assert_eq!(
        replica
            .begin_bootstrap(BeginBootstrapPlan {
                guard: bootstrap_guard(account_id.as_str(), 0),
                generation_id: BootstrapGenerationId("generation-matrix".to_owned()),
            })
            .await
            .unwrap(),
        PlanResult::Applied {
            replica_revision: 1
        }
    );
    let watermark = SyncCursor::CapturedValue {
        id: "cursor-matrix".to_owned(),
    };
    assert_eq!(
        replica
            .stage_bootstrap_page(StageBootstrapPagePlan {
                guard: bootstrap_guard(account_id.as_str(), 1),
                generation_id: BootstrapGenerationId("generation-matrix".to_owned()),
                page_identity: BootstrapPageIdentity::vaults(0),
                request_cursor: BootstrapPageCursor::VaultsInitial,
                raw_response_fingerprint: Sha256Fingerprint::of_bytes(b"vault-page"),
                pinned_watermark: watermark.clone(),
                continuation: BootstrapContinuation::Final,
                vaults: vec![crate::test_fixtures::personal_vault(
                    "vault-1",
                    "user-account-matrix",
                )],
                items: Vec::new(),
            })
            .await
            .unwrap(),
        StageBootstrapPageResult::Applied
    );
    assert_eq!(
        replica
            .stage_bootstrap_page(StageBootstrapPagePlan {
                guard: bootstrap_guard(account_id.as_str(), 1),
                generation_id: BootstrapGenerationId("generation-matrix".to_owned()),
                page_identity: BootstrapPageIdentity::items(0),
                request_cursor: BootstrapPageCursor::ItemsInitial,
                raw_response_fingerprint: Sha256Fingerprint::of_bytes(b"item-page"),
                pinned_watermark: watermark,
                continuation: BootstrapContinuation::Final,
                vaults: Vec::new(),
                items: vec![authority_item(account_id.as_str(), "item-existing", 1)],
            })
            .await
            .unwrap(),
        StageBootstrapPageResult::Applied
    );
    assert_eq!(
        replica
            .promote_bootstrap(PromoteBootstrapPlan {
                guard: bootstrap_guard(account_id.as_str(), 1),
                generation_id: BootstrapGenerationId("generation-matrix".to_owned()),
            })
            .await
            .unwrap(),
        PlanResult::Applied {
            replica_revision: 2
        }
    );
    (persistence, replica, account_id)
}

async fn finish_scenario(
    name: &'static str,
    persistence: Arc<RecordingPersistence>,
    account_id: &AccountId,
    before: Vec<u8>,
) -> FailureScenario {
    let after = canonical_account_bytes(&persistence.inner, account_id).await;
    let mut requests = persistence.recorded();
    let request = requests.pop().expect("scenario records its target request");
    FailureScenario {
        name,
        setup: requests,
        request,
        before,
        after,
    }
}

async fn failure_scenarios() -> [FailureScenario; 4] {
    let (persistence, replica, account_id) = ready_recording_replica().await;
    let before = canonical_account_bytes(&persistence.inner, &account_id).await;
    replica
        .install_or_replace(
            account_id.clone(),
            "user-account-matrix".to_owned(),
            Incarnation::from("replacement-account-matrix"),
        )
        .await
        .unwrap();
    let replacement =
        finish_scenario("replacement Install", persistence, &account_id, before).await;

    let (persistence, replica, account_id) = ready_recording_replica().await;
    let before = canonical_account_bytes(&persistence.inner, &account_id).await;
    assert_eq!(
        replica
            .execute(plan(account_id.as_str(), 2, "operation-accepted"))
            .await
            .unwrap(),
        PlanResult::Applied {
            replica_revision: 3
        }
    );
    let accepted = finish_scenario(
        "accepted Operation Commit",
        persistence,
        &account_id,
        before,
    )
    .await;

    let (persistence, replica, account_id) = ready_recording_replica().await;
    assert_eq!(
        replica
            .execute(plan(account_id.as_str(), 2, "operation-reconciled"))
            .await
            .unwrap(),
        PlanResult::Applied {
            replica_revision: 3
        }
    );
    let before = canonical_account_bytes(&persistence.inner, &account_id).await;
    let accepted_operation = operation("operation-reconciled", "item-1");
    assert_eq!(
        replica
            .execute(GuardedCommitPlan::new(
                account_id.clone(),
                Incarnation::from("incarnation-account-matrix"),
                3,
                0,
                vec![PlanMutation::ReconcileAppliedCreate {
                    outcome: ObservedOutcome {
                        operation_id: accepted_operation.operation_id.clone(),
                        request_fingerprint: accepted_operation.request_fingerprint,
                        result: OperationOutcomeResult::Applied {
                            entity_id: accepted_operation.item_id.clone(),
                            version: 1,
                        },
                    },
                    item: Box::new(authority_item(account_id.as_str(), "item-1", 1)),
                    cursor: None,
                }],
            ))
            .await
            .unwrap(),
        PlanResult::Applied {
            replica_revision: 4
        }
    );
    let reconciliation = finish_scenario(
        "authoritative reconciliation Commit",
        persistence,
        &account_id,
        before,
    )
    .await;

    let (persistence, replica, account_id) = ready_recording_replica().await;
    let before = canonical_account_bytes(&persistence.inner, &account_id).await;
    replica
        .advance_lock_epoch(
            &account_id,
            "user-account-matrix",
            &Incarnation::from("incarnation-account-matrix"),
            1,
        )
        .await
        .unwrap();
    let lock = finish_scenario("Lock", persistence, &account_id, before).await;

    [replacement, accepted, reconciliation, lock]
}

fn sqlite_write_boundaries(request: &ReplicaPersistenceRequest) -> usize {
    match request {
        ReplicaPersistenceRequest::Install { prepared } => 1 + prepared.writes.len(),
        ReplicaPersistenceRequest::Commit { prepared } => 1 + prepared.writes.len(),
        ReplicaPersistenceRequest::AdvanceLockEpoch { .. } => 1,
        ReplicaPersistenceRequest::Load { .. } => panic!("a load has no SQLite write boundary"),
    }
}

#[tokio::test]
async fn sqlite_failure_matrix_covers_every_replica_write_boundary() {
    let scenarios = failure_scenarios().await;
    for scenario in scenarios {
        let account_id = AccountId::from("account-matrix");
        for boundary in 1..=sqlite_write_boundaries(&scenario.request) {
            let database = TestDatabase::new(&format!(
                "complete-failure-{}-{boundary}",
                scenario.name.replace(' ', "-")
            ));
            let initial = SqliteReplica::open(&database.path).unwrap();
            for request in &scenario.setup {
                initial.invoke(request.clone()).await.unwrap();
            }
            assert_eq!(
                canonical_account_bytes(&initial, &account_id).await,
                scenario.before,
                "{} boundary {boundary} did not start from the Domain pre-state",
                scenario.name
            );
            drop(initial);

            let failing = SqliteReplica::open_failing_after(&database.path, boundary).unwrap();
            let error = failing.invoke(scenario.request.clone()).await.unwrap_err();
            assert!(error
                .message
                .contains("injected SQLite Replica write failure"));
            drop(failing);

            let reopened = SqliteReplica::open(&database.path).unwrap();
            assert_eq!(
                canonical_account_bytes(&reopened, &account_id).await,
                scenario.before,
                "{} boundary {boundary} exposed a partial Account",
                scenario.name
            );
            reopened.invoke(scenario.request.clone()).await.unwrap();
            drop(reopened);

            let completed = SqliteReplica::open(&database.path).unwrap();
            assert_eq!(
                canonical_account_bytes(&completed, &account_id).await,
                scenario.after,
                "{} boundary {boundary} did not reach the complete Domain post-state",
                scenario.name
            );
        }
    }
}

#[tokio::test]
async fn sqlite_rejects_commit_and_install_writes_outside_the_guarded_account() {
    let database = TestDatabase::new("cross-account-delete");
    let persistence = Arc::new(SqliteReplica::open(&database.path).unwrap());
    let replica = Replica::new(persistence.clone());
    install(&replica, "account-1").await;
    install(&replica, "account-2").await;
    replica
        .execute(plan("account-2", 0, "operation-account-2"))
        .await
        .unwrap();
    let account_2_before = replica.load(&AccountId::from("account-2")).await.unwrap();

    let account_1 = replica
        .load(&AccountId::from("account-1"))
        .await
        .unwrap()
        .unwrap();
    let mut prepared = prepare_commit(
        account_1,
        GuardedCommitPlan::new(
            AccountId::from("account-1"),
            Incarnation::from("incarnation-account-1"),
            0,
            0,
            vec![],
        ),
    )
    .unwrap()
    .wire;
    prepared.writes.push(PreparedReplicaWrite::Delete {
        store: ReplicaStore::Operations,
        key: ReplicaRowKey {
            account_id: AccountId::from("account-2"),
            record_id: "operation-account-2".into(),
        },
    });

    persistence
        .invoke(ReplicaPersistenceRequest::Commit { prepared })
        .await
        .unwrap_err();
    assert_eq!(
        replica.load(&AccountId::from("account-2")).await.unwrap(),
        account_2_before
    );

    let account_1 = replica
        .load(&AccountId::from("account-1"))
        .await
        .unwrap()
        .unwrap();
    let mut replacement = prepare_install(
        Some(&account_1),
        AccountId::from("account-1"),
        "user-account-1".into(),
        Incarnation::from("replacement-account-1"),
    )
    .unwrap();
    replacement.writes.push(PreparedReplicaWrite::Delete {
        store: ReplicaStore::Operations,
        key: ReplicaRowKey {
            account_id: AccountId::from("account-2"),
            record_id: "operation-account-2".into(),
        },
    });
    persistence
        .invoke(ReplicaPersistenceRequest::Install {
            prepared: replacement,
        })
        .await
        .unwrap_err();
    assert_eq!(
        replica.load(&AccountId::from("account-2")).await.unwrap(),
        account_2_before
    );
}
