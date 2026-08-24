use super::{
    persistence_contract::{
        prepare_commit, prepare_install, PreparedReplicaWrite, ReplicaRowKey, ReplicaStore,
    },
    GuardedCommitPlan, InMemoryReplica, PlanMutation, PlanResult, Replica, ReplicaPersistence,
    ReplicaPersistenceRequest, ReplicaPersistenceResponse, SqliteReplica,
};
use crate::{protocol::Incarnation, AccountId, RuntimeError};
use std::{path::PathBuf, sync::Arc};

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
