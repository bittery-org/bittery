use crate::{
    protocol::Incarnation,
    replica::{
        GuardedCommitPlan, InMemoryReplica, OperationRecord, PlanMutation, PlanResult,
        ReplicaItemRecord, ReplicaPersistence, ReplicaPersistenceRequest,
        SerializedReplicaExecutor,
    },
    AccountAccessState, AccountId, CustomFieldKind, LoginItemDraft, ObservationHandle,
    ObservationRequest, ObservationSink, RequestCancellation, Runtime, RuntimeError,
    RuntimeErrorCode, RuntimeProjection, RuntimeRequest, RuntimeResponse,
};
use async_trait::async_trait;
use std::{
    sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        mpsc, Arc, Condvar, Mutex,
    },
    thread,
    time::Duration,
};

struct StaleOnceExecutor {
    state: InMemoryReplica,
    remaining_races: AtomicUsize,
    requested_commits: AtomicUsize,
}

impl StaleOnceExecutor {
    fn seeded() -> Self {
        let state = InMemoryReplica::default();
        state
            .install(
                AccountId::from("account-1"),
                "user-1".into(),
                Incarnation::from("incarnation-1"),
            )
            .unwrap();
        Self {
            state,
            remaining_races: AtomicUsize::new(9),
            requested_commits: AtomicUsize::new(0),
        }
    }
}

#[async_trait]
impl SerializedReplicaExecutor for StaleOnceExecutor {
    async fn invoke(&self, request_json: String) -> Result<String, RuntimeError> {
        let request: ReplicaPersistenceRequest = serde_json::from_str(&request_json).unwrap();
        if let ReplicaPersistenceRequest::Commit { prepared } = &request {
            self.requested_commits.fetch_add(1, Ordering::SeqCst);
            if let Ok(previous) =
                self.remaining_races
                    .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |remaining| {
                        (remaining > 0).then(|| remaining - 1)
                    })
            {
                let race_number = 10 - previous;
                let operation_id = format!("competing-operation-{race_number}");
                let item_id = format!("competing-item-{race_number}");
                self.state.execute(GuardedCommitPlan::new(
                    prepared.expected.account_id.clone(),
                    prepared.expected.incarnation.clone(),
                    prepared.expected.replica_revision,
                    vec![
                        PlanMutation::AcceptOperation(OperationRecord {
                            operation_id,
                            item_id: item_id.clone(),
                            request_bytes: b"competing-sealed-request".to_vec(),
                        }),
                        PlanMutation::PutOptimisticItem(ReplicaItemRecord {
                            account_id: prepared.expected.account_id.clone(),
                            item_id,
                            vault_id: "vault-1".into(),
                            ciphertext: b"competing-sealed-item".to_vec(),
                            optimistic: true,
                        }),
                    ],
                ))?;
            }
        }
        serde_json::to_string(&self.state.invoke(request).await?).map_err(|_| {
            RuntimeError::new(
                RuntimeErrorCode::InvariantViolation,
                "race fake response could not be serialized",
            )
        })
    }
}

struct RemoveOnCommitExecutor {
    state: InMemoryReplica,
    remove_on_commit: AtomicBool,
}

impl RemoveOnCommitExecutor {
    fn seeded() -> Self {
        let state = InMemoryReplica::default();
        state
            .install(
                AccountId::from("account-1"),
                "user-1".into(),
                Incarnation::from("incarnation-1"),
            )
            .unwrap();
        Self {
            state,
            remove_on_commit: AtomicBool::new(true),
        }
    }
}

#[async_trait]
impl SerializedReplicaExecutor for RemoveOnCommitExecutor {
    async fn invoke(&self, request_json: String) -> Result<String, RuntimeError> {
        let request: ReplicaPersistenceRequest = serde_json::from_str(&request_json).unwrap();
        if let ReplicaPersistenceRequest::Commit { prepared } = &request {
            if self.remove_on_commit.swap(false, Ordering::SeqCst) {
                self.state.remove(&prepared.expected.account_id);
            }
        }
        serde_json::to_string(&self.state.invoke(request).await?).map_err(|_| {
            RuntimeError::new(
                RuntimeErrorCode::InvariantViolation,
                "removal fake response could not be serialized",
            )
        })
    }
}

struct AdvanceBeforeLoadExecutor {
    state: InMemoryReplica,
    load_calls: AtomicUsize,
}

#[derive(Default)]
struct SerializedInMemoryExecutor {
    state: InMemoryReplica,
}

#[derive(Default)]
struct ProjectionSink(Mutex<Vec<RuntimeProjection>>);

impl ObservationSink for ProjectionSink {
    fn publish(&self, projection: RuntimeProjection) {
        self.0.lock().unwrap().push(projection);
    }
}

#[async_trait]
impl SerializedReplicaExecutor for SerializedInMemoryExecutor {
    async fn invoke(&self, request_json: String) -> Result<String, RuntimeError> {
        let request: ReplicaPersistenceRequest = serde_json::from_str(&request_json).unwrap();
        let response = self.state.invoke(request).await?;
        serde_json::to_string(&response).map_err(|_| {
            RuntimeError::new(
                RuntimeErrorCode::InvariantViolation,
                "in-memory response could not be serialized",
            )
        })
    }
}

impl AdvanceBeforeLoadExecutor {
    fn seeded() -> Self {
        let state = InMemoryReplica::default();
        state
            .install(
                AccountId::from("account-1"),
                "user-1".into(),
                Incarnation::from("incarnation-1"),
            )
            .unwrap();
        Self {
            state,
            load_calls: AtomicUsize::new(0),
        }
    }
}

#[async_trait]
impl SerializedReplicaExecutor for AdvanceBeforeLoadExecutor {
    async fn invoke(&self, request_json: String) -> Result<String, RuntimeError> {
        let request: ReplicaPersistenceRequest = serde_json::from_str(&request_json).unwrap();
        if let ReplicaPersistenceRequest::Load { account_id } = &request {
            if self.load_calls.fetch_add(1, Ordering::SeqCst) == 1 {
                self.state.execute(GuardedCommitPlan::new(
                    account_id.clone(),
                    Incarnation::from("incarnation-1"),
                    0,
                    vec![
                        PlanMutation::AcceptOperation(OperationRecord {
                            operation_id: "early-competing-operation".into(),
                            item_id: "early-competing-item".into(),
                            request_bytes: b"early-competing-sealed-request".to_vec(),
                        }),
                        PlanMutation::PutOptimisticItem(ReplicaItemRecord {
                            account_id: account_id.clone(),
                            item_id: "early-competing-item".into(),
                            vault_id: "vault-1".into(),
                            ciphertext: b"early-competing-sealed-item".to_vec(),
                            optimistic: true,
                        }),
                    ],
                ))?;
            }
        }
        serde_json::to_string(&self.state.invoke(request).await?).map_err(|_| {
            RuntimeError::new(
                RuntimeErrorCode::InvariantViolation,
                "early race fake response could not be serialized",
            )
        })
    }
}

fn installed_runtime() -> (Arc<Runtime>, AccountId, Incarnation) {
    let runtime = Runtime::new();
    let account_id = AccountId::from("account-1");
    let incarnation = Incarnation::from("incarnation-1");
    runtime
        .install_account(account_id.clone(), "user-1".into(), incarnation.clone())
        .unwrap();
    (runtime, account_id, incarnation)
}

fn create_request(account_id: AccountId) -> RuntimeRequest {
    RuntimeRequest::CreateLoginItem {
        account_id,
        vault_id: "vault-1".into(),
        draft: LoginItemDraft {
            title: "Example".into(),
            url: Some("https://example.test".into()),
            urls: vec![],
            username: Some("person@example.test".into()),
            password: Some("correct horse battery staple".into()),
            notes: Some("private".into()),
            note: None,
            custom_fields: vec![],
            tags: vec![],
        },
    }
}

fn optimistic_item(account_id: AccountId, item_id: &str) -> ReplicaItemRecord {
    ReplicaItemRecord {
        account_id,
        item_id: item_id.into(),
        vault_id: "vault-1".into(),
        ciphertext: b"sealed-fixture".to_vec(),
        optimistic: true,
    }
}

#[tokio::test]
async fn replaced_account_restores_signed_out_and_cannot_create_until_unlocked() {
    let executor = Arc::new(SerializedInMemoryExecutor::default());
    let account_id = AccountId::from("account-restore");
    let first = Runtime::with_serialized_replica_executor(executor.clone());
    first
        .install_or_replace_account(
            account_id.clone(),
            "user-restore".into(),
            Incarnation::from("incarnation-old"),
        )
        .await
        .unwrap();
    first.unlock_account(&account_id).await.unwrap();
    first
        .request(
            create_request(account_id.clone()),
            RequestCancellation::new(),
        )
        .await
        .unwrap();
    first
        .install_or_replace_account(
            account_id.clone(),
            "user-restore".into(),
            Incarnation::from("incarnation-new"),
        )
        .await
        .unwrap();

    let restored = Runtime::with_serialized_replica_executor(executor.clone());
    restored
        .restore_known_accounts(vec![account_id.clone()])
        .await
        .unwrap();
    let snapshot = restored.replica().snapshot(&account_id).unwrap();
    assert_eq!(snapshot.user_id, "user-restore");
    assert_eq!(snapshot.incarnation, Incarnation::from("incarnation-new"));
    assert_eq!(snapshot.revision, 2);
    assert_eq!(snapshot.items.len(), 1);
    assert_eq!(snapshot.operations.len(), 1);
    let status = ProjectionSink::default();
    let status = Arc::new(status);
    let _observation = restored
        .observe(
            ObservationRequest::RuntimeStatus {
                account_id: Some(account_id.clone()),
            },
            status.clone(),
        )
        .unwrap();
    let RuntimeProjection::RuntimeStatus(projected) = status.0.lock().unwrap()[0].clone() else {
        panic!("expected Runtime status projection");
    };
    assert_eq!(projected.accounts[0].access, AccountAccessState::SignedOut);
    let locked_items = restored.observe(
        ObservationRequest::Items {
            account_id: account_id.clone(),
        },
        Arc::new(ProjectionSink::default()),
    );
    assert!(matches!(
        locked_items,
        Err(RuntimeError {
            code: RuntimeErrorCode::AuthenticationRequired,
            ..
        })
    ));
    assert_eq!(
        restored
            .request(create_request(account_id), RequestCancellation::new())
            .await
            .unwrap_err()
            .code,
        RuntimeErrorCode::AuthenticationRequired
    );
}

#[tokio::test]
async fn restore_is_batch_atomic_and_replaces_the_visible_device_catalog() {
    let executor = Arc::new(SerializedInMemoryExecutor::default());
    let installer = Runtime::with_serialized_replica_executor(executor.clone());
    for suffix in ["a", "b"] {
        installer
            .install_or_replace_account(
                AccountId::from(format!("account-{suffix}")),
                format!("user-{suffix}"),
                Incarnation::from(format!("incarnation-{suffix}")),
            )
            .await
            .unwrap();
    }

    let restored = Runtime::with_serialized_replica_executor(executor.clone());
    restored
        .restore_known_accounts(vec![
            AccountId::from("account-a"),
            AccountId::from("account-b"),
        ])
        .await
        .unwrap();
    assert_eq!(restored.replica().snapshots().len(), 2);
    restored
        .restore_known_accounts(vec![AccountId::from("account-a")])
        .await
        .unwrap();
    assert_eq!(
        restored
            .replica()
            .snapshots()
            .into_iter()
            .map(|snapshot| snapshot.account_id)
            .collect::<Vec<_>>(),
        vec![AccountId::from("account-a")]
    );

    let failed =
        Runtime::with_serialized_replica_executor(Arc::new(SerializedInMemoryExecutor::default()));
    let error = failed
        .restore_known_accounts(vec![AccountId::from("missing"), AccountId::from("missing")])
        .await
        .unwrap_err();
    assert_eq!(error.code, RuntimeErrorCode::InvariantViolation);
    assert!(failed.replica().snapshots().is_empty());
    let failed_status = Arc::new(ProjectionSink::default());
    let _failed_observation = failed
        .observe(
            ObservationRequest::RuntimeStatus { account_id: None },
            failed_status.clone(),
        )
        .unwrap();
    let RuntimeProjection::RuntimeStatus(projected) = failed_status.0.lock().unwrap()[0].clone()
    else {
        panic!("expected Runtime status projection");
    };
    assert!(projected.accounts.is_empty());

    let missing_after_valid = Runtime::with_serialized_replica_executor(executor);
    let error = missing_after_valid
        .restore_known_accounts(vec![
            AccountId::from("account-a"),
            AccountId::from("missing"),
        ])
        .await
        .unwrap_err();
    assert_eq!(error.code, RuntimeErrorCode::AccountMissing);
    assert!(missing_after_valid.replica().snapshots().is_empty());
}

#[tokio::test]
async fn runtime_status_projects_unlocked_and_locked_as_closed_states() {
    let (runtime, account_id, _) = installed_runtime();
    let status = Arc::new(ProjectionSink::default());
    let _observation = runtime
        .observe(
            ObservationRequest::RuntimeStatus {
                account_id: Some(account_id.clone()),
            },
            status.clone(),
        )
        .unwrap();
    runtime.mark_account_locked(&account_id).await.unwrap();
    let projections = status.0.lock().unwrap();
    let states: Vec<_> = projections
        .iter()
        .map(|projection| {
            let RuntimeProjection::RuntimeStatus(status) = projection else {
                panic!("expected Runtime status projection");
            };
            status.accounts[0].access
        })
        .collect();
    assert_eq!(
        states,
        vec![AccountAccessState::Unlocked, AccountAccessState::Locked]
    );
}

fn run_request(runtime: Arc<Runtime>, request: RuntimeRequest) {
    tokio::runtime::Builder::new_current_thread()
        .build()
        .unwrap()
        .block_on(runtime.request(request, RequestCancellation::new()))
        .unwrap();
}

#[tokio::test]
async fn guarded_plan_is_atomic_and_distinguishes_missing_from_stale() {
    let (runtime, account_id, incarnation) = installed_runtime();
    let replica = runtime.replica();

    let missing = replica
        .execute(GuardedCommitPlan::new(
            AccountId::from("missing"),
            incarnation.clone(),
            0,
            vec![],
        ))
        .await
        .unwrap();
    assert_eq!(missing, PlanResult::Missing);

    let stale = replica
        .execute(GuardedCommitPlan::new(
            account_id.clone(),
            incarnation.clone(),
            4,
            vec![],
        ))
        .await
        .unwrap();
    assert_eq!(stale, PlanResult::Stale { actual_revision: 0 });

    let invalid = GuardedCommitPlan::new(
        account_id.clone(),
        incarnation,
        0,
        vec![
            PlanMutation::PutOptimisticItem(optimistic_item(account_id.clone(), "item-1")),
            PlanMutation::RemoveOperation {
                operation_id: "never-accepted".into(),
            },
        ],
    );
    assert!(replica.execute(invalid).await.is_err());
    let snapshot = replica.snapshot(&account_id).unwrap();
    assert_eq!(snapshot.revision, 0);
    assert!(snapshot.items.is_empty());
}

#[tokio::test]
async fn durable_stale_keeps_rereading_and_recomputing_while_revisions_advance() {
    let executor = Arc::new(StaleOnceExecutor::seeded());
    let runtime = Runtime::with_serialized_replica_executor(executor.clone());
    let account_id = AccountId::from("account-1");
    runtime.replica().load(&account_id).await.unwrap().unwrap();
    runtime.unlock_account(&account_id).await.unwrap();

    let response = runtime
        .request(
            create_request(account_id.clone()),
            RequestCancellation::new(),
        )
        .await
        .unwrap();

    assert!(matches!(response, crate::RuntimeResponse::Accepted { .. }));
    assert_eq!(executor.requested_commits.load(Ordering::SeqCst), 10);
    let snapshot = runtime.replica().snapshot(&account_id).unwrap();
    assert_eq!(snapshot.revision, 10);
    assert_eq!(snapshot.operations.len(), 10);
    assert_eq!(snapshot.items.len(), 10);
}

#[tokio::test]
async fn durable_missing_clears_the_cache_and_returns_account_missing() {
    let executor = Arc::new(RemoveOnCommitExecutor::seeded());
    let runtime = Runtime::with_serialized_replica_executor(executor);
    let account_id = AccountId::from("account-1");
    runtime.replica().load(&account_id).await.unwrap().unwrap();
    runtime.unlock_account(&account_id).await.unwrap();

    let error = runtime
        .request(
            create_request(account_id.clone()),
            RequestCancellation::new(),
        )
        .await
        .unwrap_err();

    assert_eq!(error.code, RuntimeErrorCode::AccountMissing);
    assert!(runtime.replica().snapshot(&account_id).is_none());
}

#[tokio::test]
async fn create_recomputes_when_revision_advances_before_the_guarded_commit_load() {
    let executor = Arc::new(AdvanceBeforeLoadExecutor::seeded());
    let runtime = Runtime::with_serialized_replica_executor(executor);
    let account_id = AccountId::from("account-1");
    runtime.replica().load(&account_id).await.unwrap().unwrap();
    runtime.unlock_account(&account_id).await.unwrap();

    let response = runtime
        .request(
            create_request(account_id.clone()),
            RequestCancellation::new(),
        )
        .await
        .unwrap();

    assert!(matches!(response, crate::RuntimeResponse::Accepted { .. }));
    let snapshot = runtime.replica().snapshot(&account_id).unwrap();
    assert_eq!(snapshot.revision, 2);
    assert_eq!(snapshot.operations.len(), 2);
    assert_eq!(snapshot.items.len(), 2);
}

#[tokio::test]
async fn cancellation_after_acceptance_stops_waiting_but_preserves_operation() {
    let (runtime, account_id, _incarnation) = installed_runtime();
    let cancellation = RequestCancellation::new();

    let error = runtime
        .request_with_acceptance_hook(
            create_request(account_id.clone()),
            cancellation.clone(),
            || cancellation.cancel(),
        )
        .await
        .unwrap_err();
    assert_eq!(error.code, RuntimeErrorCode::Cancelled);
    assert_eq!(runtime.replica().snapshot(&account_id).unwrap().revision, 1);
    assert_eq!(
        runtime
            .replica()
            .snapshot(&account_id)
            .unwrap()
            .operations
            .len(),
        1
    );
}

#[test]
fn account_lock_waits_for_an_inflight_acceptance_before_clearing_access() {
    let (runtime, account_id, _) = installed_runtime();
    let (entered_sender, entered_receiver) = mpsc::channel();
    let (release_sender, release_receiver) = mpsc::channel();
    let request_runtime = runtime.clone();
    let request_account = account_id.clone();
    let request_thread = thread::spawn(move || {
        tokio::runtime::Builder::new_current_thread()
            .build()
            .unwrap()
            .block_on(request_runtime.request_with_acceptance_hook(
                create_request(request_account),
                RequestCancellation::new(),
                move || {
                    entered_sender.send(()).unwrap();
                    release_receiver.recv().unwrap();
                },
            ))
    });
    entered_receiver.recv().unwrap();

    let (locked_sender, locked_receiver) = mpsc::channel();
    let lock_runtime = runtime.clone();
    let lock_account = account_id.clone();
    let lock_thread = thread::spawn(move || {
        let result = tokio::runtime::Builder::new_current_thread()
            .build()
            .unwrap()
            .block_on(lock_runtime.mark_account_locked(&lock_account));
        locked_sender.send(result).unwrap();
    });
    assert!(locked_receiver
        .recv_timeout(Duration::from_millis(30))
        .is_err());
    release_sender.send(()).unwrap();
    assert!(matches!(
        request_thread.join().unwrap().unwrap(),
        RuntimeResponse::Accepted { .. }
    ));
    locked_receiver
        .recv_timeout(Duration::from_secs(1))
        .unwrap()
        .unwrap();
    lock_thread.join().unwrap();

    assert_eq!(
        tokio::runtime::Builder::new_current_thread()
            .build()
            .unwrap()
            .block_on(runtime.request(create_request(account_id), RequestCancellation::new(),))
            .unwrap_err()
            .code,
        RuntimeErrorCode::AuthenticationRequired
    );
}

#[test]
fn close_waits_for_an_inflight_acceptance_before_clearing_runtime_state() {
    let (runtime, account_id, _) = installed_runtime();
    let (entered_sender, entered_receiver) = mpsc::channel();
    let (release_sender, release_receiver) = mpsc::channel();
    let request_runtime = runtime.clone();
    let request_thread = thread::spawn(move || {
        tokio::runtime::Builder::new_current_thread()
            .build()
            .unwrap()
            .block_on(request_runtime.request_with_acceptance_hook(
                create_request(account_id),
                RequestCancellation::new(),
                move || {
                    entered_sender.send(()).unwrap();
                    release_receiver.recv().unwrap();
                },
            ))
    });
    entered_receiver.recv().unwrap();

    let (closed_sender, closed_receiver) = mpsc::channel();
    let close_runtime = runtime.clone();
    let close_thread = thread::spawn(move || {
        tokio::runtime::Builder::new_current_thread()
            .build()
            .unwrap()
            .block_on(close_runtime.close());
        closed_sender.send(()).unwrap();
    });
    assert!(closed_receiver
        .recv_timeout(Duration::from_millis(30))
        .is_err());
    release_sender.send(()).unwrap();
    assert!(matches!(
        request_thread.join().unwrap().unwrap(),
        RuntimeResponse::Accepted { .. }
    ));
    closed_receiver
        .recv_timeout(Duration::from_secs(1))
        .unwrap();
    close_thread.join().unwrap();
    assert!(runtime.is_closed());
    assert!(matches!(
        runtime.observe(
            ObservationRequest::RuntimeStatus { account_id: None },
            Arc::new(ProjectionSink::default()),
        ),
        Err(RuntimeError {
            code: RuntimeErrorCode::RuntimeClosed,
            ..
        })
    ));
}

struct BlockingSink {
    revisions: Mutex<Vec<u64>>,
    entered_revision_one: (Mutex<bool>, Condvar),
    release_revision_one: (Mutex<bool>, Condvar),
}

impl BlockingSink {
    fn new() -> Self {
        Self {
            revisions: Mutex::new(Vec::new()),
            entered_revision_one: (Mutex::new(false), Condvar::new()),
            release_revision_one: (Mutex::new(false), Condvar::new()),
        }
    }

    fn wait_until_blocked(&self) {
        let (entered, changed) = &self.entered_revision_one;
        let mut entered = entered.lock().unwrap();
        while !*entered {
            entered = changed.wait(entered).unwrap();
        }
    }

    fn release(&self) {
        let (released, changed) = &self.release_revision_one;
        *released.lock().unwrap() = true;
        changed.notify_all();
    }
}

impl ObservationSink for BlockingSink {
    fn publish(&self, projection: RuntimeProjection) {
        let revision = projection.revision();
        self.revisions.lock().unwrap().push(revision);
        if revision == 1 {
            let (entered, entered_changed) = &self.entered_revision_one;
            *entered.lock().unwrap() = true;
            entered_changed.notify_all();

            let (released, release_changed) = &self.release_revision_one;
            let mut released = released.lock().unwrap();
            while !*released {
                released = release_changed.wait(released).unwrap();
            }
        }
    }
}

#[test]
fn concurrent_publications_are_serialized_in_strict_revision_order() {
    let (runtime, account_id, _incarnation) = installed_runtime();
    let sink = Arc::new(BlockingSink::new());
    let _handle = runtime
        .observe(
            ObservationRequest::Items {
                account_id: account_id.clone(),
            },
            sink.clone(),
        )
        .unwrap();

    let first = {
        let runtime = runtime.clone();
        let request = create_request(account_id.clone());
        thread::spawn(move || run_request(runtime, request))
    };
    sink.wait_until_blocked();
    let (second_done_sender, second_done_receiver) = mpsc::channel();
    let second = {
        let runtime = runtime.clone();
        let request = create_request(account_id);
        thread::spawn(move || {
            run_request(runtime, request);
            second_done_sender.send(()).unwrap();
        })
    };
    assert!(second_done_receiver
        .recv_timeout(Duration::from_millis(30))
        .is_err());
    sink.release();
    first.join().unwrap();
    second_done_receiver
        .recv_timeout(Duration::from_secs(1))
        .unwrap();
    second.join().unwrap();

    assert_eq!(*sink.revisions.lock().unwrap(), vec![0, 1, 2]);
}

#[test]
fn close_waits_for_inflight_delivery_and_suppresses_every_later_callback() {
    let (runtime, account_id, _incarnation) = installed_runtime();
    let sink = Arc::new(BlockingSink::new());
    let handle = runtime
        .observe(
            ObservationRequest::Items {
                account_id: account_id.clone(),
            },
            sink.clone(),
        )
        .unwrap();
    let publisher = {
        let runtime = runtime.clone();
        thread::spawn(move || run_request(runtime, create_request(account_id)))
    };
    sink.wait_until_blocked();

    let (closed_tx, closed_rx) = mpsc::channel();
    let closer = thread::spawn(move || {
        handle.close();
        closed_tx.send(()).unwrap();
    });
    assert!(closed_rx.recv_timeout(Duration::from_millis(50)).is_err());
    sink.release();
    closed_rx.recv_timeout(Duration::from_secs(1)).unwrap();
    closer.join().unwrap();
    publisher.join().unwrap();

    runtime.publish_all();
    assert_eq!(*sink.revisions.lock().unwrap(), vec![0, 1]);
}

#[derive(Default)]
struct ReentrantCloseSink {
    handle: Mutex<Option<Arc<ObservationHandle>>>,
    revisions: Mutex<Vec<u64>>,
}

impl ObservationSink for ReentrantCloseSink {
    fn publish(&self, projection: RuntimeProjection) {
        let revision = projection.revision();
        self.revisions.lock().unwrap().push(revision);
        if revision == 1 {
            if let Some(handle) = self.handle.lock().unwrap().clone() {
                handle.close();
            }
        }
    }
}

#[tokio::test]
async fn observation_can_close_itself_reentrantly_without_deadlock() {
    let (runtime, account_id, _incarnation) = installed_runtime();
    let sink = Arc::new(ReentrantCloseSink::default());
    let handle = runtime
        .observe(
            ObservationRequest::Items {
                account_id: account_id.clone(),
            },
            sink.clone(),
        )
        .unwrap();
    *sink.handle.lock().unwrap() = Some(handle);

    runtime
        .request(create_request(account_id), RequestCancellation::new())
        .await
        .unwrap();
    runtime.publish_all();
    assert_eq!(*sink.revisions.lock().unwrap(), vec![0, 1]);
}

#[tokio::test]
async fn plaintext_is_redacted_and_never_enters_replica_records() {
    let (runtime, account_id, _incarnation) = installed_runtime();
    let request = create_request(account_id.clone());
    let debug = format!("{request:?}");
    assert!(!debug.contains("correct horse"));
    assert!(!debug.contains("person@example"));
    let sign_in = RuntimeRequest::SignIn {
        server_url: "https://server.test".into(),
        email: "person@example.test".into(),
        master_password: "UNIQUE_MASTER_PASSWORD".into(),
        secret_key: "UNIQUE_SECRET_KEY".into(),
    };
    let sign_in_debug = format!("{sign_in:?}");
    assert!(!sign_in_debug.contains("UNIQUE_MASTER_PASSWORD"));
    assert!(!sign_in_debug.contains("UNIQUE_SECRET_KEY"));

    runtime
        .request(request, RequestCancellation::new())
        .await
        .unwrap();
    let serialized =
        serde_json::to_string(&runtime.replica().snapshot(&account_id).unwrap().items).unwrap();
    assert!(!serialized.contains("correct horse"));
    assert!(!serialized.contains("person@example"));
}

#[tokio::test]
async fn accounts_fail_in_isolation_and_close_stops_runtime_calls() {
    let (runtime, account_id, _incarnation) = installed_runtime();
    runtime
        .install_account(
            AccountId::from("account-2"),
            "user-2".into(),
            Incarnation::from("incarnation-2"),
        )
        .unwrap();
    runtime
        .fail_account(&account_id, RuntimeErrorCode::InvariantViolation)
        .unwrap();
    assert!(runtime
        .request(create_request(account_id), RequestCancellation::new())
        .await
        .is_err());
    assert!(runtime
        .request(
            create_request(AccountId::from("account-2")),
            RequestCancellation::new(),
        )
        .await
        .is_ok());

    runtime.close().await;
    runtime.close().await;
    assert_eq!(
        runtime
            .request(
                create_request(AccountId::from("account-2")),
                RequestCancellation::new(),
            )
            .await
            .unwrap_err()
            .code,
        RuntimeErrorCode::RuntimeClosed
    );
}

#[test]
fn login_draft_and_runtime_wire_match_the_existing_camel_case_subset() {
    let draft: LoginItemDraft = serde_json::from_value(serde_json::json!({
        "title": "Example",
        "customFields": [{
            "id": "field-1",
            "label": "PIN",
            "value": "1234",
            "type": "password"
        }]
    }))
    .unwrap();
    assert_eq!(draft.url, None);
    assert_eq!(draft.custom_fields[0].field_type, CustomFieldKind::Password);

    let wire = serde_json::to_value(RuntimeRequest::CreateLoginItem {
        account_id: AccountId::from("account-1"),
        vault_id: "vault-1".into(),
        draft,
    })
    .unwrap();
    assert_eq!(wire["type"], "createLoginItem");
    assert_eq!(wire["accountId"], "account-1");
    assert_eq!(wire["vaultId"], "vault-1");
    assert_eq!(wire["draft"]["customFields"][0]["type"], "password");
    assert!(wire.get("account_id").is_none());
}

#[tokio::test]
async fn accepted_plan_keeps_operation_and_overlay_in_one_revision() {
    let (runtime, account_id, incarnation) = installed_runtime();
    let result = runtime
        .execute_plan(GuardedCommitPlan::new(
            account_id.clone(),
            incarnation,
            0,
            vec![
                PlanMutation::AcceptOperation(OperationRecord {
                    operation_id: "operation-1".into(),
                    item_id: "item-1".into(),
                    request_bytes: b"sealed-request".to_vec(),
                }),
                PlanMutation::PutOptimisticItem(optimistic_item(account_id.clone(), "item-1")),
            ],
        ))
        .await
        .unwrap();
    assert_eq!(
        result,
        PlanResult::Applied {
            replica_revision: 1
        }
    );
    let snapshot = runtime.replica().snapshot(&account_id).unwrap();
    assert_eq!(snapshot.operations.len(), 1);
    assert_eq!(snapshot.items.len(), 1);
}
