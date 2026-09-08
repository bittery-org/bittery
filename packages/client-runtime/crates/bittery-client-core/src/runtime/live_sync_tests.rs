use super::{operation_fixtures::*, outcome::CompletionResult, *};
use crate::test_fixtures::TEST_VAULT_ID;
use crate::{http_transport::SerializedHttpExecutor, replica::SyncCursor};
use async_trait::async_trait;
use serde_json::{json, Value};
use std::{collections::VecDeque, sync::atomic::AtomicUsize};
use tokio::sync::{mpsc, Mutex as AsyncMutex, Semaphore};

type ReadQueue = Arc<AsyncMutex<mpsc::UnboundedReceiver<Value>>>;
struct StreamSlot {
    sender: mpsc::UnboundedSender<Value>,
    receiver: ReadQueue,
}
struct SyncServer {
    finite: Arc<FakeServer>,
    streams: Mutex<HashMap<String, StreamSlot>>,
    opens: Mutex<Vec<Value>>,
    statuses: Mutex<VecDeque<u16>>,
    opened: Semaphore,
    changes: Semaphore,
    cancelled: Mutex<Vec<String>>,
    authority_overrides: Mutex<VecDeque<Value>>,
}
impl SyncServer {
    fn send(&self, value: Value) {
        for slot in self.streams.lock().unwrap().values() {
            slot.sender.send(value.clone()).unwrap();
        }
    }
    fn hint(&self, value: &[u8]) {
        self.send(json!({"type":"chunk","bytes":value}));
    }
    fn change(&self, deleted: bool, cursor: &str) {
        if deleted {
            self.finite.created_items.lock().unwrap().clear();
        } else {
            let mut items = self.finite.created_items.lock().unwrap();
            items[0].favorite = true;
            items[0].version = 2;
        }
        self.finite.script_sync_page(vec![json!({
            "id":cursor,"type":if deleted {"item_permanently_deleted"} else {"item_updated"},
            "entityType":"item","entityId":"item-existing","userId":USER,"vaultId":TEST_VAULT_ID,
            "clientId":null,"metadata":null,"timestamp":"1700000000000","version":2
        })], cursor, false);
    }
}
#[async_trait]
impl SerializedHttpExecutor for SyncServer {
    async fn invoke(&self, text: String) -> Result<String, RuntimeError> {
        let value: Value = serde_json::from_str(&text).unwrap();
        if value["type"] == "openStream" {
            self.opens.lock().unwrap().push(value["request"].clone());
            let status = self.statuses.lock().unwrap().pop_front().unwrap_or(200);
            if status == 200 {
                let (sender, receiver) = mpsc::unbounded_channel();
                self.streams.lock().unwrap().insert(
                    value["request"]["dispatchId"].as_str().unwrap().into(),
                    StreamSlot {
                        sender,
                        receiver: Arc::new(AsyncMutex::new(receiver)),
                    },
                );
            }
            self.opened.add_permits(1);
            return Ok(json!({"type":"opened","status":status,"headers":[{"name":"content-type","value":"text/event-stream"}]}).to_string());
        }
        if value["type"] == "readStream" {
            let receiver = self
                .streams
                .lock()
                .unwrap()
                .get(value["dispatchId"].as_str().unwrap())
                .unwrap()
                .receiver
                .clone();
            return Ok(receiver
                .lock()
                .await
                .recv()
                .await
                .unwrap_or(json!({"type":"ended"}))
                .to_string());
        }
        let changes = value["url"]
            .as_str()
            .is_some_and(|url| url.contains("/sync/changes"));
        let result = self.finite.invoke(text).await;
        if value["url"]
            .as_str()
            .is_some_and(|url| url.ends_with("/authority"))
        {
            if let Some(answer) = self.authority_overrides.lock().unwrap().pop_front() {
                return Ok(answer.to_string());
            }
        }
        if changes {
            self.changes.add_permits(1);
        }
        result
    }
    fn cancel(&self, id: &str) {
        if self.streams.lock().unwrap().remove(id).is_some() {
            self.cancelled.lock().unwrap().push(id.into());
        }
    }
}
struct Setup {
    runtime: Arc<Runtime>,
    server: Arc<SyncServer>,
    account: AccountId,
    timer: Arc<TestTimer>,
    persistence: Arc<PlainReplica>,
    commits: Arc<CommitGate>,
}
struct CommitGate {
    persistence: Arc<PlainReplica>,
    hold_next: AtomicBool,
    entered: Semaphore,
    released: tokio::sync::Notify,
}
#[async_trait]
impl crate::replica::SerializedReplicaExecutor for CommitGate {
    async fn invoke(&self, request: String) -> Result<String, RuntimeError> {
        let value: crate::replica::ReplicaPersistenceRequest =
            serde_json::from_str(&request).unwrap();
        if matches!(
            value,
            crate::replica::ReplicaPersistenceRequest::Commit { .. }
        ) && self.hold_next.swap(false, Ordering::SeqCst)
        {
            let mut release = std::pin::pin!(self.released.notified());
            release.as_mut().enable();
            self.entered.add_permits(1);
            release.await;
        }
        self.persistence.invoke(request).await
    }
}
async fn setup() -> Setup {
    let seed = seeded_with_existing_item(true, false).await;
    let server = Arc::new(SyncServer {
        finite: seed.server,
        streams: Mutex::new(HashMap::new()),
        opens: Mutex::new(Vec::new()),
        statuses: Mutex::new(VecDeque::new()),
        opened: Semaphore::new(0),
        changes: Semaphore::new(0),
        cancelled: Mutex::new(Vec::new()),
        authority_overrides: Mutex::new(VecDeque::new()),
    });
    let commits = Arc::new(CommitGate {
        persistence: seed.replica.clone(),
        hold_next: AtomicBool::new(false),
        entered: Semaphore::new(0),
        released: tokio::sync::Notify::new(),
    });
    let runtime = Runtime::with_test_dispatch_environment(
        commits.clone(),
        seed.platform,
        server.clone(),
        auth_config(),
        seed.clock,
        seed.timer.clone(),
    );
    runtime
        .replica
        .load(&seed.account_id)
        .await
        .unwrap()
        .unwrap();
    runtime.unlock_account(&seed.account_id).await.unwrap();
    Setup {
        runtime,
        server,
        account: seed.account_id,
        timer: seed.timer,
        persistence: seed.replica,
        commits,
    }
}
async fn permit(semaphore: &Semaphore) {
    tokio::time::timeout(std::time::Duration::from_secs(2), semaphore.acquire())
        .await
        .unwrap()
        .unwrap()
        .forget();
}
async fn until(mut predicate: impl FnMut() -> bool) {
    tokio::time::timeout(std::time::Duration::from_secs(2), async {
        while !predicate() {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
}
fn cursor(setup: &Setup) -> SyncCursor {
    setup
        .runtime
        .replica
        .snapshot(&setup.account)
        .unwrap()
        .bootstrap
        .active_cursor
}

#[tokio::test]
async fn held_stream_delivers_idle_authority_and_does_not_hold_the_mutation_fence() {
    let setup = setup().await;
    let task = tokio::spawn(setup.runtime.clone().run_live_sync());
    permit(&setup.server.opened).await;
    permit(&setup.server.changes).await;
    let accepted = tokio::time::timeout(
        std::time::Duration::from_secs(2),
        setup.runtime.request(
            RuntimeRequest::CreateItem {
                account_id: setup.account.clone(),
                vault_id: TEST_VAULT_ID.into(),
                draft: draft(),
            },
            RequestCancellation::new(),
        ),
    )
    .await
    .unwrap()
    .unwrap();
    assert!(matches!(accepted, RuntimeResponse::Accepted { .. }));
    setup.server.change(false, "event-2");
    setup
        .server
        .hint(b"event: sync\ndata: {\"cursor\":\"forged\"}\n\n");
    until(|| {
        cursor(&setup)
            == SyncCursor::CapturedValue {
                id: "event-2".into(),
            }
    })
    .await;
    let snapshot = setup.runtime.replica.snapshot(&setup.account).unwrap();
    assert_eq!(snapshot.operations.len(), 1);
    assert!(
        snapshot
            .bootstrap
            .snapshot()
            .visible_items
            .iter()
            .find(|item| item.id == "item-existing")
            .unwrap()
            .favorite
    );
    assert_eq!(setup.server.opens.lock().unwrap().len(), 1);
    setup.runtime.close().await;
    task.await.unwrap();
    assert!(setup.server.streams.lock().unwrap().is_empty());
}

#[tokio::test]
async fn first_connected_frame_closes_subscribe_race_and_repeated_connected_frames_are_inert() {
    let setup = setup().await;
    let task = tokio::spawn(setup.runtime.clone().run_live_sync());
    permit(&setup.server.changes).await;
    setup.server.change(false, "event-race");
    setup.server.hint(b"event: connected\ndata: {}\n\n");
    until(|| {
        cursor(&setup)
            == SyncCursor::CapturedValue {
                id: "event-race".into(),
            }
    })
    .await;
    permit(&setup.server.changes).await;
    setup
        .server
        .hint(b"event: connected\ndata: {}\n\n: heartbeat\n\n");
    for _ in 0..10 {
        tokio::task::yield_now().await;
    }
    assert_eq!(setup.server.changes.available_permits(), 0);
    assert_eq!(setup.server.opens.lock().unwrap().len(), 1);
    setup.runtime.close().await;
    task.await.unwrap();
}

#[tokio::test]
async fn remote_permanent_delete_removes_authority_before_advancing_its_cursor() {
    let setup = setup().await;
    let task = tokio::spawn(setup.runtime.clone().run_live_sync());
    permit(&setup.server.changes).await;
    setup.server.change(true, "event-delete");
    setup.server.hint(b"event: sync\ndata: {}\n\n");
    until(|| {
        cursor(&setup)
            == SyncCursor::CapturedValue {
                id: "event-delete".into(),
            }
    })
    .await;
    assert!(setup
        .runtime
        .replica
        .snapshot(&setup.account)
        .unwrap()
        .bootstrap
        .snapshot()
        .visible_items
        .is_empty());
    setup.runtime.close().await;
    task.await.unwrap();
}

#[tokio::test]
async fn eof_backs_off_and_lock_drains_the_stream_and_timer_without_deleting_work() {
    let setup = setup().await;
    let task = tokio::spawn(setup.runtime.clone().run_live_sync());
    permit(&setup.server.changes).await;
    let accepted = setup
        .runtime
        .request(
            RuntimeRequest::CreateItem {
                account_id: setup.account.clone(),
                vault_id: TEST_VAULT_ID.into(),
                draft: draft(),
            },
            RequestCancellation::new(),
        )
        .await
        .unwrap();
    assert!(matches!(accepted, RuntimeResponse::Accepted { .. }));
    let before = setup
        .runtime
        .replica
        .snapshot(&setup.account)
        .unwrap()
        .operations;
    setup.server.send(json!({"type":"ended"}));
    until(|| setup.timer.requested() == vec![1_000]).await;
    assert!(setup.server.streams.lock().unwrap().is_empty());
    assert_eq!(setup.server.opens.lock().unwrap().len(), 1);
    tokio::time::timeout(
        std::time::Duration::from_secs(2),
        setup.runtime.mark_account_locked(&setup.account),
    )
    .await
    .unwrap()
    .unwrap();
    assert_eq!(
        setup
            .runtime
            .replica
            .snapshot(&setup.account)
            .unwrap()
            .operations,
        before
    );
    assert!(setup
        .runtime
        .replica
        .snapshot(&setup.account)
        .unwrap()
        .failure
        .is_none());
    setup.timer.released.notify_waiters();
    for _ in 0..10 {
        tokio::task::yield_now().await;
    }
    assert_eq!(setup.server.opens.lock().unwrap().len(), 1);
    setup.runtime.close().await;
    task.await.unwrap();
}

#[tokio::test]
async fn live_sync_open_renews_once_and_second_401_parks_without_deleting_accepted_work() {
    for statuses in [vec![401, 200], vec![401, 401]] {
        let setup = setup().await;
        setup
            .server
            .statuses
            .lock()
            .unwrap()
            .extend(statuses.clone());
        *setup.server.finite.refresh.lock().unwrap() = RefreshBehavior::Renews(SECOND_TOKEN);
        setup
            .runtime
            .request(
                RuntimeRequest::CreateItem {
                    account_id: setup.account.clone(),
                    vault_id: TEST_VAULT_ID.into(),
                    draft: draft(),
                },
                RequestCancellation::new(),
            )
            .await
            .unwrap();
        let work = setup
            .runtime
            .replica
            .snapshot(&setup.account)
            .unwrap()
            .operations;
        let task = tokio::spawn(setup.runtime.clone().run_live_sync());
        permit(&setup.server.opened).await;
        permit(&setup.server.opened).await;
        assert_eq!(setup.server.finite.refresh_calls.load(Ordering::SeqCst), 1);
        let opens = setup.server.opens.lock().unwrap().clone();
        let authorization = |request: &Value| {
            request["headers"]
                .as_array()
                .unwrap()
                .iter()
                .find(|header| header["name"] == "Authorization")
                .unwrap()["value"]
                .as_str()
                .unwrap()
                .to_owned()
        };
        assert_eq!(authorization(&opens[0]), format!("Bearer {FIRST_TOKEN}"));
        assert_eq!(authorization(&opens[1]), format!("Bearer {SECOND_TOKEN}"));
        if statuses[1] == 401 {
            until(|| {
                setup
                    .runtime
                    .waiting_reasons
                    .lock()
                    .unwrap()
                    .get(&setup.account)
                    == Some(&AccountWaitingReason::ReauthenticationRequired)
            })
            .await;
            assert!(setup.server.streams.lock().unwrap().is_empty());
        } else {
            permit(&setup.server.changes).await;
            assert_eq!(setup.server.streams.lock().unwrap().len(), 1);
        }
        assert_eq!(
            setup
                .runtime
                .replica
                .snapshot(&setup.account)
                .unwrap()
                .operations,
            work
        );
        assert!(setup
            .runtime
            .replica
            .snapshot(&setup.account)
            .unwrap()
            .failure
            .is_none());
        setup.runtime.close().await;
        task.await.unwrap();
    }
}

#[tokio::test]
async fn live_sync_remote_operation_events_advance_without_guessing_another_devices_fingerprint() {
    let setup = setup().await;
    let task = tokio::spawn(setup.runtime.clone().run_live_sync());
    permit(&setup.server.changes).await;
    setup
        .server
        .finite
        .script_operation_event("another-devices-operation", "foreign-event");
    setup.server.hint(b"event: sync\ndata: {}\n\n");
    until(|| {
        cursor(&setup)
            == SyncCursor::CapturedValue {
                id: "foreign-event".into(),
            }
    })
    .await;
    assert_eq!(setup.server.finite.outcome_lookups(), 0);
    assert!(setup
        .runtime
        .replica
        .snapshot(&setup.account)
        .unwrap()
        .failure
        .is_none());
    setup.runtime.close().await;
    task.await.unwrap();
}

#[tokio::test]
async fn live_sync_failed_authority_commit_preserves_cursor_and_reconnect_replays_the_page() {
    let setup = setup().await;
    let task = tokio::spawn(setup.runtime.clone().run_live_sync());
    permit(&setup.server.changes).await;
    let before = cursor(&setup);
    setup.persistence.fail_next_commits(1);
    setup.server.change(false, "event-retry");
    setup.server.hint(b"event: sync\ndata: {}\n\n");
    until(|| setup.timer.requested() == vec![1_000]).await;
    assert_eq!(setup.persistence.failed_commits(), 1);
    assert_eq!(cursor(&setup), before);
    assert!(
        !setup
            .runtime
            .replica
            .snapshot(&setup.account)
            .unwrap()
            .bootstrap
            .snapshot()
            .visible_items[0]
            .favorite
    );
    // The Server still owns the same page because its Cursor was never advanced locally.
    setup.server.change(false, "event-retry");
    setup.timer.released.notify_one();
    permit(&setup.server.opened).await;
    permit(&setup.server.opened).await;
    until(|| {
        cursor(&setup)
            == SyncCursor::CapturedValue {
                id: "event-retry".into(),
            }
    })
    .await;
    assert_eq!(setup.server.opens.lock().unwrap().len(), 2);
    assert_eq!(
        setup
            .runtime
            .replica
            .snapshot(&setup.account)
            .unwrap()
            .bootstrap
            .snapshot()
            .visible_items[0]
            .version,
        2
    );
    setup.runtime.close().await;
    task.await.unwrap();
}

#[tokio::test]
async fn live_sync_delayed_absence_cannot_remove_a_newer_authority_revision() {
    let setup = setup().await;
    let before = setup.runtime.replica.snapshot(&setup.account).unwrap();
    let guard = crate::replica::BootstrapGuard {
        account_id: setup.account.clone(),
        user_id: before.user_id.clone(),
        incarnation: before.incarnation.clone(),
        expected_replica_revision: before.revision,
        expected_lock_epoch: before.lock_epoch,
    };
    let mut item = before.bootstrap.snapshot().visible_items[0].clone();
    item.version = 3;
    assert!(matches!(
        setup
            .runtime
            .replica
            .apply_sync_item_authority(
                guard.clone(),
                before.bootstrap.active_cursor.clone(),
                item.id.clone(),
                Some(item)
            )
            .await
            .unwrap(),
        crate::replica::PlanResult::Applied { .. }
    ));
    assert!(matches!(
        setup
            .runtime
            .replica
            .apply_sync_item_authority(
                guard,
                before.bootstrap.active_cursor.clone(),
                "item-existing".into(),
                None
            )
            .await
            .unwrap(),
        crate::replica::PlanResult::Stale { .. }
    ));
    let after = setup.runtime.replica.snapshot(&setup.account).unwrap();
    assert_eq!(after.bootstrap.snapshot().visible_items[0].version, 3);
    assert_eq!(
        after.bootstrap.active_cursor,
        before.bootstrap.active_cursor
    );
    setup.runtime.close().await;
}

#[tokio::test]
async fn malformed_change_page_never_applies_authority_or_repeats_without_backoff() {
    for (next, has_more, empty) in [
        (None, true, false),
        (Some(""), false, false),
        (Some("bootstrap-watermark"), true, false),
        (None, true, true),
    ] {
        let setup = setup().await;
        let task = tokio::spawn(setup.runtime.clone().run_live_sync());
        permit(&setup.server.changes).await;
        setup.server.change(false, "event-before-malformed");
        setup.server.hint(b"event: sync\ndata: {}\n\n");
        until(|| {
            cursor(&setup)
                == SyncCursor::CapturedValue {
                    id: "event-before-malformed".into(),
                }
        })
        .await;
        permit(&setup.server.changes).await;
        let before = setup.runtime.replica.snapshot(&setup.account).unwrap();
        let same = match &before.bootstrap.active_cursor {
            SyncCursor::CapturedValue { id } => id.clone(),
            _ => panic!("seed must have a captured nonempty Cursor"),
        };
        setup.server.change(false, "malformed-event");
        let mut page = setup
            .server
            .finite
            .sync_pages
            .lock()
            .unwrap()
            .pop_back()
            .unwrap();
        page["cursor"] = match next {
            Some("bootstrap-watermark") => json!({"id":same}),
            Some(value) => json!({"id":value}),
            None => Value::Null,
        };
        page["hasMore"] = json!(has_more);
        if empty {
            page["events"] = json!([]);
        }
        setup
            .server
            .finite
            .sync_pages
            .lock()
            .unwrap()
            .push_back(page);
        setup.server.hint(b"event: sync\ndata: {}\n\n");
        until(|| setup.timer.requested() == vec![1_000]).await;
        let after = setup.runtime.replica.snapshot(&setup.account).unwrap();
        assert_eq!(
            after.bootstrap.active_cursor,
            before.bootstrap.active_cursor
        );
        assert_eq!(
            after.bootstrap.snapshot().visible_items,
            before.bootstrap.snapshot().visible_items
        );
        assert_eq!(setup.server.changes.available_permits(), 1);
        assert_eq!(setup.server.opens.lock().unwrap().len(), 1);
        setup.runtime.close().await;
        task.await.unwrap();
    }
}

#[tokio::test]
async fn held_stream_lifecycle_cancellation_preserves_or_deletes_only_the_requested_scope() {
    for action in ["sign-out", "remove", "wipe", "failure"] {
        let setup = setup().await;
        setup
            .runtime
            .request(
                RuntimeRequest::CreateItem {
                    account_id: setup.account.clone(),
                    vault_id: TEST_VAULT_ID.into(),
                    draft: draft(),
                },
                RequestCancellation::new(),
            )
            .await
            .unwrap();
        let work = setup
            .runtime
            .replica
            .snapshot(&setup.account)
            .unwrap()
            .operations;
        assert_eq!(work.len(), 1);
        let task = tokio::spawn(setup.runtime.clone().run_live_sync());
        permit(&setup.server.changes).await;
        let sender = setup
            .server
            .streams
            .lock()
            .unwrap()
            .values()
            .next()
            .unwrap()
            .sender
            .clone();
        if action == "failure" {
            setup
                .persistence
                .state
                .fail(&setup.account, RuntimeErrorCode::InvariantViolation)
                .unwrap();
            setup
                .runtime
                .replica
                .cache(setup.persistence.state.snapshot(&setup.account).unwrap());
            setup.runtime.publish_all();
        } else {
            let request = match action {
                "sign-out" => RuntimeRequest::SignOut {
                    account_id: setup.account.clone(),
                },
                "remove" => RuntimeRequest::RemoveAccount {
                    account_id: setup.account.clone(),
                },
                "wipe" => RuntimeRequest::Wipe,
                _ => unreachable!(),
            };
            tokio::time::timeout(
                std::time::Duration::from_secs(2),
                setup.runtime.request(request, RequestCancellation::new()),
            )
            .await
            .unwrap()
            .unwrap();
        }
        until(|| setup.server.streams.lock().unwrap().is_empty()).await;
        assert_eq!(setup.server.cancelled.lock().unwrap().len(), 1, "{action}");
        assert!(sender
            .send(json!({"type":"chunk","bytes":b"event: sync\ndata: {}\n\n"}))
            .is_err());
        setup.timer.released.notify_waiters();
        setup.runtime.publish_all();
        for _ in 0..10 {
            tokio::task::yield_now().await;
        }
        assert_eq!(setup.server.opens.lock().unwrap().len(), 1, "{action}");
        assert!(setup.timer.requested().is_empty());
        if matches!(action, "remove" | "wipe") {
            assert!(
                setup.persistence.state.snapshot(&setup.account).is_none(),
                "{action}"
            );
        } else {
            assert_eq!(
                setup
                    .persistence
                    .state
                    .snapshot(&setup.account)
                    .unwrap()
                    .operations,
                work,
                "{action}"
            );
        }
        setup.runtime.close().await;
        task.await.unwrap();
    }
}

#[tokio::test]
async fn hint_queued_while_authority_commit_is_held_is_reconciled_after_that_exact_page() {
    let setup = setup().await;
    let runner = tokio::spawn(setup.runtime.clone().run_live_sync());
    permit(&setup.server.changes).await;
    setup.commits.hold_next.store(true, Ordering::SeqCst);
    setup.server.change(false, "held-page");
    setup.server.hint(b"event: sync\ndata: {}\n\n");
    permit(&setup.commits.entered).await;
    assert_eq!(cursor(&setup), SyncCursor::CapturedEmpty);
    setup.server.change(false, "queued-page");
    {
        let mut items = setup.server.finite.created_items.lock().unwrap();
        items[0].version = 3;
        items[0].favorite = false;
    }
    setup.server.hint(b"event: sync\ndata: {}\n\n");
    setup.commits.released.notify_waiters();
    until(|| {
        cursor(&setup)
            == SyncCursor::CapturedValue {
                id: "queued-page".into(),
            }
    })
    .await;
    let snapshot = setup.runtime.replica.snapshot(&setup.account).unwrap();
    let items = snapshot.bootstrap.snapshot().visible_items;
    assert_eq!(items[0].version, 3);
    assert!(!items[0].favorite);
    assert_eq!(setup.server.changes.available_permits(), 2);
    assert_eq!(setup.server.opens.lock().unwrap().len(), 1);
    setup.runtime.close().await;
    runner.await.unwrap();
}

#[tokio::test]
async fn final_page_commit_cannot_rebase_a_stale_fetched_boundary_onto_a_new_cursor() {
    let setup = setup().await;
    let old = cursor(&setup);
    let newer = SyncCursor::CapturedValue {
        id: "newer-page".into(),
    };
    assert!(matches!(
        setup
            .runtime
            .advance_sync_page_cursor_fenced(
                &setup.account,
                vec![],
                crate::replica::CursorAdvance {
                    expected: old.clone(),
                    next: newer.clone()
                }
            )
            .await,
        CompletionResult::Completed
    ));
    assert!(matches!(
        setup
            .runtime
            .advance_sync_page_cursor_fenced(
                &setup.account,
                vec![],
                crate::replica::CursorAdvance {
                    expected: old,
                    next: SyncCursor::CapturedValue {
                        id: "stale-page".into()
                    }
                }
            )
            .await,
        CompletionResult::Retry
    ));
    assert_eq!(cursor(&setup), newer);
    setup.runtime.close().await;
}

#[tokio::test]
async fn repeated_eof_reconnects_use_a_bounded_device_timer_budget() {
    let setup = setup().await;
    let runner = tokio::spawn(setup.runtime.clone().run_live_sync());
    let expected = [1_000, 2_000, 4_000, 8_000, 16_000, 32_000, 60_000, 60_000];
    for (index, delay) in expected.into_iter().enumerate() {
        permit(&setup.server.changes).await;
        setup.server.send(json!({"type":"ended"}));
        until(|| setup.timer.requested().len() == index + 1).await;
        assert_eq!(setup.timer.requested()[index], delay);
        assert_eq!(setup.server.opens.lock().unwrap().len(), index + 1);
        assert!(setup.server.streams.lock().unwrap().is_empty());
        if index != expected.len() - 1 {
            setup.timer.released.notify_waiters();
        }
    }
    setup.runtime.close().await;
    runner.await.unwrap();
    setup.timer.released.notify_waiters();
    assert_eq!(setup.server.opens.lock().unwrap().len(), expected.len());
}

#[tokio::test]
async fn session_revoked_control_uses_private_renewal_and_parks_when_rejected() {
    let setup = setup().await;
    *setup.server.finite.refresh.lock().unwrap() = RefreshBehavior::Unauthorized;
    let runner = tokio::spawn(setup.runtime.clone().run_live_sync());
    permit(&setup.server.changes).await;
    setup.server.hint(b"event: session_revoked\ndata: {}\n\n");
    until(|| {
        setup
            .runtime
            .waiting_reasons
            .lock()
            .unwrap()
            .get(&setup.account)
            == Some(&AccountWaitingReason::ReauthenticationRequired)
    })
    .await;
    assert_eq!(setup.server.finite.refresh_calls.load(Ordering::SeqCst), 1);
    assert!(setup.server.streams.lock().unwrap().is_empty());
    assert!(setup.timer.requested().is_empty());
    assert!(setup
        .runtime
        .replica
        .snapshot(&setup.account)
        .unwrap()
        .failure
        .is_none());
    setup.runtime.close().await;
    runner.await.unwrap();
}

#[tokio::test]
async fn ordinary_sync_reads_complete_item_authority_without_paid_attachment_or_bootstrap_requests()
{
    let setup = setup().await;
    setup
        .server
        .finite
        .script_attachment_faults([Some(Fault::Status(403))]);
    let runner = tokio::spawn(setup.runtime.clone().run_live_sync());
    permit(&setup.server.changes).await;
    setup.server.change(false, "complete-authority");
    setup.server.hint(b"event: sync\ndata: {}\n\n");
    until(|| {
        cursor(&setup)
            == SyncCursor::CapturedValue {
                id: "complete-authority".into(),
            }
    })
    .await;
    let snapshot = setup.runtime.replica.snapshot(&setup.account).unwrap();
    assert!(snapshot.bootstrap.snapshot().visible_items[0].favorite);
    assert!(snapshot.bootstrap.snapshot().visible_items[0]
        .attachments
        .is_empty());
    let requests = setup.server.finite.requests.lock().unwrap().clone();
    assert_eq!(
        requests
            .iter()
            .filter(|request| request.url.ends_with("/items/item-existing/authority"))
            .count(),
        1
    );
    assert!(!requests
        .iter()
        .any(|request| request.url.contains("/attachments?")
            || request.url.contains("/sync/bootstrap")
            || request.url.ends_with("/items/item-existing")));
    assert_eq!(
        setup.server.finite.attachment_faults.lock().unwrap().len(),
        1
    );
    setup.runtime.close().await;
    runner.await.unwrap();
}

#[tokio::test]
async fn incomplete_or_foreign_complete_authority_cannot_change_items_cursor_or_accepted_work() {
    for defect in [
        "missing-attachments",
        "foreign-item",
        "foreign-vault",
        "foreign-attachment",
        "malformed",
        "forbidden",
        "oversized",
    ] {
        let setup = setup().await;
        setup
            .runtime
            .request(
                RuntimeRequest::CreateItem {
                    account_id: setup.account.clone(),
                    vault_id: TEST_VAULT_ID.into(),
                    draft: draft(),
                },
                RequestCancellation::new(),
            )
            .await
            .unwrap();
        let runner = tokio::spawn(setup.runtime.clone().run_live_sync());
        permit(&setup.server.changes).await;
        let before = setup.runtime.replica.snapshot(&setup.account).unwrap();
        setup.server.change(false, "invalid-complete-authority");
        let mut body: Value = serde_json::from_slice(&item_body(
            &setup.server.finite.created_items.lock().unwrap()[0],
        ))
        .unwrap();
        body["attachments"] = json!([]);
        match defect {
            "missing-attachments" => {
                body.as_object_mut().unwrap().remove("attachments");
            }
            "foreign-item" => body["id"] = json!("another-item"),
            "foreign-vault" => body["vaultId"] = json!("another-vault"),
            "foreign-attachment" => {
                body["attachments"] = json!([{
                    "id":"attachment-1", "itemId":"foreign-item", "vaultId":TEST_VAULT_ID,
                    "storageKey":"attachments/attachment-1", "encryptedName":"ciphertext", "encryptionIv":"iv", "encryptionAlgorithm":"AES-256-GCM", "encryptedAttachmentKey":"key", "attachmentKeyIv":"iv", "attachmentKeyAlgorithm":"AES-256-GCM", "encryptedContentType":"content-type", "encryptedContentTypeIv":"iv", "envelopeVersion":1, "fileSize":17, "uploadedBy":USER, "createdAt":"2026-08-30T00:00:00Z"
                }]);
            }
            _ => {}
        }
        let answer = match defect {
            "malformed" => completed(200, b"{".to_vec()),
            "forbidden" => completed(403, b"{}".to_vec()),
            "oversized" => completed(200, vec![b' '; 4 * 1024 * 1024 + 1]),
            _ => completed(200, serde_json::to_vec(&body).unwrap()),
        };
        setup
            .server
            .authority_overrides
            .lock()
            .unwrap()
            .push_back(answer);
        setup.server.hint(b"event: sync\ndata: {}\n\n");
        until(|| setup.timer.requested() == vec![1_000]).await;
        let after = setup.runtime.replica.snapshot(&setup.account).unwrap();
        assert_eq!(after, before, "{defect}");
        assert!(!setup
            .server
            .finite
            .requests
            .lock()
            .unwrap()
            .iter()
            .any(|request| request.url.contains("/sync/bootstrap")
                || request.url.contains("/attachments?")));
        setup.runtime.close().await;
        runner.await.unwrap();
    }
}

#[tokio::test]
async fn complete_item_authority_renews_once_and_a_second_401_preserves_work_and_cursor() {
    for refusals in [1, 2] {
        let setup = setup().await;
        setup
            .runtime
            .request(
                RuntimeRequest::CreateItem {
                    account_id: setup.account.clone(),
                    vault_id: TEST_VAULT_ID.into(),
                    draft: draft(),
                },
                RequestCancellation::new(),
            )
            .await
            .unwrap();
        let before = setup.runtime.replica.snapshot(&setup.account).unwrap();
        *setup.server.finite.refresh.lock().unwrap() = RefreshBehavior::Renews(SECOND_TOKEN);
        let runner = tokio::spawn(setup.runtime.clone().run_live_sync());
        permit(&setup.server.changes).await;
        setup
            .server
            .finite
            .script_item_faults(std::iter::repeat_n(Fault::Status(401), refusals));
        setup.server.change(false, "renewed-complete-authority");
        setup.server.hint(b"event: sync\ndata: {}\n\n");
        if refusals == 1 {
            until(|| {
                cursor(&setup)
                    == SyncCursor::CapturedValue {
                        id: "renewed-complete-authority".into(),
                    }
            })
            .await;
        } else {
            until(|| {
                setup
                    .runtime
                    .waiting_reasons
                    .lock()
                    .unwrap()
                    .get(&setup.account)
                    == Some(&AccountWaitingReason::ReauthenticationRequired)
            })
            .await;
            assert_eq!(cursor(&setup), before.bootstrap.active_cursor);
        }
        assert_eq!(setup.server.finite.refresh_calls.load(Ordering::SeqCst), 1);
        let tokens: Vec<_> = setup
            .server
            .finite
            .requests
            .lock()
            .unwrap()
            .iter()
            .filter(|request| request.url.ends_with("/authority"))
            .map(|request| request.header("authorization").unwrap().to_owned())
            .collect();
        assert_eq!(
            tokens,
            vec![
                format!("Bearer {FIRST_TOKEN}"),
                format!("Bearer {SECOND_TOKEN}")
            ]
        );
        assert_eq!(
            setup
                .runtime
                .replica
                .snapshot(&setup.account)
                .unwrap()
                .operations,
            before.operations
        );
        assert!(setup
            .runtime
            .replica
            .snapshot(&setup.account)
            .unwrap()
            .failure
            .is_none());
        setup.runtime.close().await;
        runner.await.unwrap();
    }
}

#[derive(Default)]
struct ItemsSink(Mutex<Vec<RuntimeProjection>>);
impl crate::ObservationSink for ItemsSink {
    fn publish(&self, projection: RuntimeProjection) {
        self.0.lock().unwrap().push(projection);
    }
}

#[tokio::test]
async fn newly_created_remote_item_reaches_a_mounted_plaintext_observer_after_its_operation_event()
{
    let setup = setup().await;
    let sink = Arc::new(ItemsSink::default());
    let _observer = setup
        .runtime
        .observe(
            ObservationRequest::Items {
                account_id: setup.account.clone(),
            },
            sink.clone(),
        )
        .unwrap();
    let runner = tokio::spawn(setup.runtime.clone().run_live_sync());
    permit(&setup.server.changes).await;
    let item_id = "new-remote-item";
    let raced_publications = Arc::new(AtomicUsize::new(0));
    let weak_runtime = Arc::downgrade(&setup.runtime);
    let raced = raced_publications.clone();
    // Another Account can publish all observations after authority commits but before this
    // Account finishes decryption. Exercise that interleaving without changing delivery guards.
    setup
        .runtime
        .set_before_plaintext_commit_hook(Some(Arc::new(move || {
            let runtime = weak_runtime.upgrade().unwrap();
            if runtime
                .replica
                .snapshot(&AccountId::from(ACCOUNT))
                .unwrap()
                .bootstrap
                .snapshot()
                .visible_items
                .iter()
                .any(|item| item.id == item_id)
            {
                raced.fetch_add(1, Ordering::SeqCst);
                runtime.publish_all();
            }
        })));
    let sealed = bittery_crypto_core::encrypt_with_aad(
        &super::create::item_plaintext(&draft()).unwrap(),
        &crate::test_fixtures::TEST_VAULT_KEY,
        &bittery_crypto_core::AadContext {
            vault_id: TEST_VAULT_ID.into(),
            entity_id: item_id.into(),
            entity_type: "item".into(),
            version: 1,
            user_id: USER.into(),
        },
    )
    .unwrap();
    {
        let mut items = setup.server.finite.created_items.lock().unwrap();
        let mut remote = items[0].clone();
        remote.id = item_id.into();
        remote.encrypted_data = sealed.ciphertext;
        remote.encryption_iv = sealed.iv;
        remote.encryption_algorithm = sealed.algorithm;
        items.push(remote);
    }
    setup.server.finite.script_sync_page(vec![
        json!({"id":"remote-item-event", "type":"item_created", "entityType":"item", "entityId":item_id, "userId":USER, "vaultId":TEST_VAULT_ID, "clientId":"another-device", "metadata":null, "timestamp":"1700000000000", "version":1}),
        json!({"id":"remote-operation-event", "type":"operation_resolved", "entityType":"operation", "entityId":"remote-operation", "userId":USER, "vaultId":TEST_VAULT_ID, "clientId":"another-device", "metadata":null, "timestamp":"1700000000000", "version":1}),
    ], "remote-operation-event", false);
    setup.server.hint(b"event: sync\ndata: {}\n\n");
    until(|| {
        cursor(&setup)
            == SyncCursor::CapturedValue {
                id: "remote-operation-event".into(),
            }
    })
    .await;
    assert_eq!(
        setup
            .runtime
            .replica
            .snapshot(&setup.account)
            .unwrap()
            .bootstrap
            .snapshot()
            .visible_items
            .len(),
        2
    );
    until(|| sink.0.lock().unwrap().last().is_some_and(|projection| matches!(projection, RuntimeProjection::Items(items) if items.items.iter().any(|item| item.item_id == item_id && item.status == ItemProjectionStatus::Authoritative)))).await;
    assert!(raced_publications.load(Ordering::SeqCst) > 0);
    setup.runtime.set_before_plaintext_commit_hook(None);
    let revisions: Vec<_> = sink
        .0
        .lock()
        .unwrap()
        .iter()
        .filter_map(|projection| match projection {
            RuntimeProjection::Items(items) => Some(items.replica_revision),
            _ => None,
        })
        .collect();
    assert!(
        revisions.windows(2).all(|pair| pair[0] < pair[1]),
        "Items delivery still rejects duplicate or older revisions"
    );
    assert_eq!(setup.server.finite.outcome_calls.load(Ordering::SeqCst), 0);
    setup.runtime.close().await;
    runner.await.unwrap();
}
