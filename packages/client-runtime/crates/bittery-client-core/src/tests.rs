use crate::{
    protocol::Incarnation,
    replica::{GuardedCommitPlan, OperationRecord, PlanMutation, PlanResult, ReplicaItemRecord},
    AccountId, CustomFieldKind, LoginItemDraft, ObservationHandle, ObservationRequest,
    ObservationSink, RequestCancellation, Runtime, RuntimeErrorCode, RuntimeProjection,
    RuntimeRequest,
};
use std::{
    sync::{mpsc, Arc, Condvar, Mutex},
    thread,
    time::Duration,
};

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
    let second = {
        let runtime = runtime.clone();
        let request = create_request(account_id);
        thread::spawn(move || run_request(runtime, request))
    };
    second.join().unwrap();
    sink.release();
    first.join().unwrap();

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
