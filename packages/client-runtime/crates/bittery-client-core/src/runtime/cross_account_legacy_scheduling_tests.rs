//! Captured queue history schedules the existing public workflow runner, never its children.
use super::*;
use crate::{
    authentication_installation::Clock,
    device_timer::DeviceTimer,
    replica::{
        CrossAccountMoveBlockedReason, CrossAccountMoveChild, CrossAccountMoveDisposition,
        CrossAccountMoveStep,
    },
};
use std::sync::atomic::AtomicU64;

const NOW: u64 = 1_770_000_000_000;
const SOURCE_DEADLINE: u64 = NOW + 10_000;

struct ManualClock(AtomicU64);

impl Clock for ManualClock {
    fn now_ms(&self) -> Result<u64, RuntimeError> {
        Ok(self.0.load(Ordering::SeqCst))
    }
}

// The public runner also sleeps for inactivity and Session refresh. Every wait has its own
// deadline: advancing Device time must not release whichever unrelated task registered first.
struct IndependentTimer {
    clock: Arc<ManualClock>,
    deadlines: Mutex<Vec<u64>>,
    changed: tokio::sync::Notify,
}

#[async_trait]
impl DeviceTimer for IndependentTimer {
    async fn sleep_ms(&self, milliseconds: u64) {
        let deadline = self.clock.now_ms().unwrap().saturating_add(milliseconds);
        self.deadlines.lock().unwrap().push(deadline);
        loop {
            let changed = self.changed.notified();
            tokio::pin!(changed);
            changed.as_mut().enable();
            if self.clock.now_ms().unwrap() >= deadline {
                return;
            }
            changed.await;
        }
    }
}

struct CountedHttp {
    inner: Arc<MoveHttp>,
    calls: Arc<Mutex<Vec<Value>>>,
}

#[async_trait]
impl crate::http_transport::SerializedHttpExecutor for CountedHttp {
    async fn invoke(&self, input: Zeroizing<String>) -> Result<String, RuntimeError> {
        // Count attempts before MoveHttp's offline short circuit, including failed GETs.
        self.calls
            .lock()
            .unwrap()
            .push(serde_json::from_str(&input).unwrap());
        crate::http_transport::SerializedHttpExecutor::invoke(self.inner.as_ref(), input).await
    }

    fn cancel(&self, request_id: &str) {
        crate::http_transport::SerializedHttpExecutor::cancel(self.inner.as_ref(), request_id);
    }
}

pub(super) struct DispatchTime {
    clock: Arc<ManualClock>,
    timer: Arc<IndependentTimer>,
    calls: Arc<Mutex<Vec<Value>>>,
}

impl DispatchTime {
    fn new() -> Self {
        let clock = Arc::new(ManualClock(AtomicU64::new(NOW)));
        Self {
            timer: Arc::new(IndependentTimer {
                clock: clock.clone(),
                deadlines: Mutex::default(),
                changed: tokio::sync::Notify::new(),
            }),
            clock,
            calls: Arc::default(),
        }
    }

    pub(super) async fn open(
        &self,
        sqlite: Arc<MoveSqlite>,
        platform: Arc<InstallationPlatform>,
        http: Arc<MoveHttp>,
    ) -> Arc<Runtime> {
        let runtime = Runtime::with_persistence(
            Arc::new(crate::replica::SerializedReplicaPersistence::new(sqlite)),
            Arc::new(crate::platform_storage::PlatformStorage::for_platform(
                platform,
                ClientPlatform::Desktop,
            )),
            Arc::new(crate::http_transport::HttpTransport::new(Arc::new(
                CountedHttp {
                    inner: http,
                    calls: self.calls.clone(),
                },
            ))),
            Some(
                AuthClientConfig::new(
                    "client-routing".into(),
                    ClientPlatform::Desktop,
                    "0.5.2-test".into(),
                )
                .unwrap(),
            ),
            None,
            false,
            self.clock.clone(),
            self.timer.clone(),
            None,
        );
        runtime.open().await.unwrap();
        runtime
    }

    fn advance_to(&self, now: u64) {
        assert!(now >= self.clock.now_ms().unwrap());
        self.clock.0.store(now, Ordering::SeqCst);
        self.timer.changed.notify_waiters();
    }

    fn waits_for(&self, deadline: u64) -> bool {
        self.timer.deadlines.lock().unwrap().contains(&deadline)
    }

    fn workflow_calls(&self) -> Vec<Value> {
        self.calls
            .lock()
            .unwrap()
            .iter()
            .filter(|call| {
                call["url"]
                    .as_str()
                    .is_some_and(|url| url.contains("/items/") || url.contains("/operations/"))
            })
            .cloned()
            .collect()
    }
}

async fn until(label: &str, mut predicate: impl FnMut() -> bool) {
    tokio::time::timeout(Duration::from_secs(10), async {
        while !predicate() {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap_or_else(|_| panic!("{label} was not reached"));
}

fn current(runtime: &Runtime, source: &AccountId) -> CrossAccountMoveRecord {
    runtime
        .require_snapshot(source)
        .unwrap()
        .cross_account_moves
        .into_iter()
        .filter_map(|entry| entry.into_captured())
        .find(|record| record.operation_id == SEMANTIC)
        .unwrap()
}

async fn reopen_unlocked(fixture: &mut AdmittedMoveFixture, time: &DispatchTime) {
    let before = current(&fixture.runtime, &fixture.source);
    fixture.runtime.close().await;
    fixture.sqlite = MoveSqlite::open(&fixture.database.0);
    let calls = time.calls.lock().unwrap().len();
    fixture.http.offline.store(false, Ordering::SeqCst);
    fixture.runtime = time
        .open(
            fixture.sqlite.clone(),
            fixture.platform.clone(),
            fixture.http.clone(),
        )
        .await;
    assert_eq!(time.calls.lock().unwrap().len(), calls, "locked reopen");
    assert_eq!(
        workflow(
            &durable_rows(&fixture.database.0, &fixture.source).await,
            SEMANTIC,
        ),
        serde_json::to_value(&before).unwrap(),
        "locked reopen preserves the durable workflow before Replica loading"
    );
    for account in [&fixture.source, &fixture.target] {
        assert_eq!(
            fixture.runtime.account_access_state(account),
            Some(AccountAccessState::Locked)
        );
        fixture
            .runtime
            .request(
                quick_unlock_request(account.as_str()),
                RequestCancellation::new(),
            )
            .await
            .unwrap();
        assert_eq!(
            fixture.runtime.account_access_state(account),
            Some(AccountAccessState::Unlocked)
        );
    }
    assert_eq!(current(&fixture.runtime, &fixture.source), before);
}

async fn prove_future_wait(fixture: &AdmittedMoveFixture, time: &DispatchTime) {
    let before = current(&fixture.runtime, &fixture.source);
    let calls = time.workflow_calls();
    until("public dispatcher waiting for captured deadline", || {
        time.waits_for(SOURCE_DEADLINE)
    })
    .await;
    assert!(!fixture.runtime.dispatch_leases.is_held(SEMANTIC));
    assert_eq!(time.workflow_calls(), calls);
    assert_eq!(current(&fixture.runtime, &fixture.source), before);
    time.advance_to(SOURCE_DEADLINE - 1);
    // All sleepers receive the same clock change but each must keep its own remaining wait.
    for _ in 0..32 {
        tokio::task::yield_now().await;
    }
    assert!(!fixture.runtime.dispatch_leases.is_held(SEMANTIC));
    assert_eq!(time.workflow_calls(), calls, "not even an early lookup");
    assert_eq!(current(&fixture.runtime, &fixture.source), before);
}

async fn prove_original_completion(
    fixture: &AdmittedMoveFixture,
    original: &CrossAccountMoveRecord,
) {
    until("public dispatcher completes original choreography", || {
        resolution(&fixture.runtime, &fixture.source, SEMANTIC) == OperationResolution::Applied
    })
    .await;
    let completed = current(&fixture.runtime, &fixture.source);
    assert_eq!(completed.legacy_admission, original.legacy_admission);
    assert_eq!(completed.children.len(), 3);
    for (child, step) in completed.children.iter().zip([
        CrossAccountMoveStep::TargetCreate,
        CrossAccountMoveStep::SourceTrash,
        CrossAccountMoveStep::SourceDelete,
    ]) {
        let mut without_result = child.clone();
        let CrossAccountMoveChild::ItemOperation(operation) = &mut without_result else {
            panic!("no Attachment child is admitted");
        };
        assert!(operation.result.take().is_some());
        assert_eq!(
            without_result,
            original.legacy_item_child(step).unwrap().unwrap(),
            "live retry history cannot change a child request or identity"
        );
    }
    let requests = fixture.http.requests.lock().unwrap().clone();
    let actual = requests
        .iter()
        .filter_map(|request| request.header("Idempotency-Key"))
        .collect::<Vec<_>>();
    assert_eq!(
        actual,
        [
            "legacy-move:create-target",
            "legacy-move:trash-source",
            "legacy-move:delete-source"
        ]
    );
    for (index, mutation) in requests.iter().enumerate() {
        if let Some(operation_id) = mutation.header("Idempotency-Key") {
            let origin = if operation_id.ends_with(":create-target") {
                TARGET_ORIGIN
            } else {
                SOURCE_ORIGIN
            };
            assert!(
                requests[..index].iter().any(|request| {
                    request.method == "GET"
                        && request.url == format!("{origin}/api/v1/operations/{operation_id}")
                }),
                "every original child still needs its own retained-outcome lookup"
            );
        }
    }
    assert_eq!(
        fixture.http.target.server.created_items(),
        vec![TARGET_ITEM.to_owned()]
    );
    assert!(fixture.http.source.server.created_items().is_empty());
    let persisted = workflow(
        &durable_rows(&fixture.database.0, &fixture.source).await,
        SEMANTIC,
    );
    assert_eq!(persisted, serde_json::to_value(&completed).unwrap());
}

async fn stop(fixture: &AdmittedMoveFixture, runner: tokio::task::JoinHandle<()>) {
    tokio::time::timeout(Duration::from_secs(10), fixture.runtime.close())
        .await
        .expect("close cancels every independent sleeper");
    tokio::time::timeout(Duration::from_secs(10), runner)
        .await
        .expect("public scheduler drains after close")
        .unwrap();
}

#[tokio::test]
async fn legacy_cross_retry_history_waits_after_reopen_then_backs_off_and_proves_each_child() {
    let time = DispatchTime::new();
    let (mut fixture, original) = admitted_legacy_move_with_history(
        json!({
            "status":"retrying", "retryCount":"3", "nextAttemptAt":SOURCE_DEADLINE.to_string(),
            "lastError":"old client acquisition failed", "attemptId":"departed-reminted-attempt"
        }),
        Some(&time),
    )
    .await;
    assert_eq!(original.scheduling.attempt_count, 3);
    assert_eq!(original.scheduling.not_before_ms, SOURCE_DEADLINE);
    assert_eq!(original.children.len(), 1);
    reopen_unlocked(&mut fixture, &time).await;
    fixture.http.offline.store(true, Ordering::SeqCst);
    fixture.http.resumed.store(true, Ordering::SeqCst);
    fixture.http.trash_result.release.add_permits(8);
    fixture.http.delete_result.release.add_permits(8);
    let runner = tokio::spawn(fixture.runtime.clone().run_operation_dispatch());
    prove_future_wait(&fixture, &time).await;
    let calls = time.workflow_calls().len();
    time.advance_to(SOURCE_DEADLINE);
    let retry_at = SOURCE_DEADLINE + crate::runtime::dispatch::backoff_ms(4);
    until("first live workflow retry retains queue count", || {
        let record = current(&fixture.runtime, &fixture.source);
        record.scheduling.attempt_count == 4
            && record.scheduling.not_before_ms == retry_at
            && time.waits_for(retry_at)
    })
    .await;
    let retried = current(&fixture.runtime, &fixture.source);
    assert_eq!(retried.legacy_admission, original.legacy_admission);
    assert_eq!(
        retried.children, original.children,
        "no inferred child send history"
    );
    assert_eq!(
        time.workflow_calls().len(),
        calls + 1,
        "one failed current-target GET"
    );
    assert!(fixture.http.mutations(SOURCE_ORIGIN).is_empty());
    assert!(fixture.http.mutations(TARGET_ORIGIN).is_empty());
    let attempts = time.workflow_calls();
    time.advance_to(retry_at - 1);
    for _ in 0..32 {
        tokio::task::yield_now().await;
    }
    assert_eq!(
        time.workflow_calls(),
        attempts,
        "existing live backoff is honored"
    );
    assert_eq!(current(&fixture.runtime, &fixture.source), retried);
    fixture.http.offline.store(false, Ordering::SeqCst);
    time.advance_to(retry_at);
    prove_original_completion(&fixture, &original).await;
    assert_eq!(
        current(&fixture.runtime, &fixture.source)
            .scheduling
            .attempt_count,
        4
    );
    stop(&fixture, runner).await;
}

#[tokio::test]
async fn held_cross_scheduler_honors_a_captured_deadline_then_parks_missing_proof_until_woken() {
    for status in ["failed", "conflicted"] {
        let time = DispatchTime::new();
        let (mut fixture, original) = admitted_legacy_move_with_history(
            json!({
                "status":status, "retryCount":"3", "nextAttemptAt":SOURCE_DEADLINE.to_string(),
                "lastError":"departed queue transport failure", "attemptId":"departed-reminted-attempt"
            }),
            Some(&time),
        )
        .await;
        reopen_unlocked(&mut fixture, &time).await;
        fixture.http.offline.store(true, Ordering::SeqCst);
        fixture.http.resumed.store(true, Ordering::SeqCst);
        let runner = tokio::spawn(fixture.runtime.clone().run_operation_dispatch());

        prove_future_wait(&fixture, &time).await;
        let calls_before_deadline = time.workflow_calls().len();
        time.advance_to(SOURCE_DEADLINE);
        let retry_at = SOURCE_DEADLINE + crate::runtime::dispatch::backoff_ms(4);
        until(
            "transient proof read persists the existing workflow backoff",
            || {
                let record = current(&fixture.runtime, &fixture.source);
                record.scheduling.attempt_count == 4
                    && record.scheduling.not_before_ms == retry_at
                    && time.waits_for(retry_at)
            },
        )
        .await;
        let retried = current(&fixture.runtime, &fixture.source);
        assert_eq!(retried.legacy_admission, original.legacy_admission);
        assert_eq!(retried.children, original.children);
        assert_eq!(time.workflow_calls().len(), calls_before_deadline + 1);
        assert!(fixture.http.mutations(SOURCE_ORIGIN).is_empty());
        assert!(fixture.http.mutations(TARGET_ORIGIN).is_empty());

        let source_before_missing = fixture.runtime.require_snapshot(&fixture.source).unwrap();
        let target_before_missing = fixture.runtime.require_snapshot(&fixture.target).unwrap();
        let durable_before_missing = workflow(
            &durable_rows(&fixture.database.0, &fixture.source).await,
            SEMANTIC,
        );
        let target_proof_url =
            format!("{TARGET_ORIGIN}/api/v1/operations/{SEMANTIC}:create-target");
        let target_proof_reads = || {
            time.workflow_calls()
                .iter()
                .filter(|call| call["url"].as_str() == Some(target_proof_url.as_str()))
                .count()
        };

        fixture.http.offline.store(false, Ordering::SeqCst);
        time.advance_to(retry_at);
        until(
            "missing original target proof parks the public scheduler",
            || target_proof_reads() == 1 && !fixture.runtime.dispatch_leases.is_held(SEMANTIC),
        )
        .await;
        // The joined Desktop inactivity owner legitimately re-arms its five-second timer.
        // Advance across the next workflow backoff interval instead of counting all owners' timers.
        let poll_probe_at = retry_at + crate::runtime::dispatch::backoff_ms(5);
        assert!(
            !time.waits_for(poll_probe_at),
            "Missing proof must not schedule another retry"
        );
        time.advance_to(poll_probe_at);
        until("background timer observes the advanced clock", || {
            time.waits_for(poll_probe_at + 5_000)
        })
        .await;
        for _ in 0..32 {
            tokio::task::yield_now().await;
        }
        assert_eq!(
            target_proof_reads(),
            1,
            "Missing proof does not poll as time advances"
        );
        assert!(!fixture.runtime.dispatch_leases.is_held(SEMANTIC));
        assert_eq!(current(&fixture.runtime, &fixture.source), retried);
        assert_eq!(
            fixture.runtime.require_snapshot(&fixture.source).unwrap(),
            source_before_missing
        );
        assert_eq!(
            fixture.runtime.require_snapshot(&fixture.target).unwrap(),
            target_before_missing
        );
        assert_eq!(
            workflow(
                &durable_rows(&fixture.database.0, &fixture.source).await,
                SEMANTIC,
            ),
            durable_before_missing
        );
        assert!(fixture.http.mutations(SOURCE_ORIGIN).is_empty());
        assert!(fixture.http.mutations(TARGET_ORIGIN).is_empty());

        fixture.runtime.wake_dispatch();
        until(
            "external wake probes the missing original target proof again",
            || target_proof_reads() == 2 && !fixture.runtime.dispatch_leases.is_held(SEMANTIC),
        )
        .await;
        assert_eq!(current(&fixture.runtime, &fixture.source), retried);
        assert!(fixture.http.mutations(SOURCE_ORIGIN).is_empty());
        assert!(fixture.http.mutations(TARGET_ORIGIN).is_empty());
        assert!(fixture.http.target.server.created_items().is_empty());
        stop(&fixture, runner).await;
    }
}

#[tokio::test]
async fn held_missing_proof_does_not_starve_a_new_same_source_favorite() {
    let time = DispatchTime::new();
    let (mut fixture, original) = admitted_legacy_move_with_history(
        json!({
            "status":"failed", "retryCount":"0",
            "lastError":"departed failure without an original target outcome"
        }),
        Some(&time),
    )
    .await;
    reopen_unlocked(&mut fixture, &time).await;
    let held_before = current(&fixture.runtime, &fixture.source);
    let target_before = fixture.runtime.require_snapshot(&fixture.target).unwrap();
    let RuntimeResponse::Accepted {
        operation_id: favorite_operation_id,
        ..
    } = fixture
        .runtime
        .request(
            RuntimeRequest::SetItemFavorite {
                account_id: fixture.source.clone(),
                item_id: SOURCE_ITEM.into(),
                favorite: !original.source.favorite,
            },
            RequestCancellation::new(),
        )
        .await
        .unwrap()
    else {
        panic!("same-source favorite must be accepted beside held work");
    };
    assert_ne!(favorite_operation_id, SEMANTIC);
    let original_target_child = original.children[0].item().unwrap().operation_id.clone();
    assert_ne!(favorite_operation_id, original_target_child);
    let target_proof_url = format!("{TARGET_ORIGIN}/api/v1/operations/{original_target_child}");
    let target_proof_reads = || {
        time.workflow_calls()
            .iter()
            .filter(|call| call["url"].as_str() == Some(target_proof_url.as_str()))
            .count()
    };

    fixture.http.offline.store(false, Ordering::SeqCst);
    fixture.http.resumed.store(true, Ordering::SeqCst);
    let runner = tokio::spawn(fixture.runtime.clone().run_operation_dispatch());
    until(
        "public scheduler parks held proof and completes the ordinary favorite",
        || {
            fixture
                .runtime
                .require_snapshot(&fixture.source)
                .is_ok_and(|snapshot| snapshot.operations.is_empty())
                && target_proof_reads() == 1
                && matches!(
                    current(&fixture.runtime, &fixture.source).disposition,
                    CrossAccountMoveDisposition::Blocked {
                        reason: CrossAccountMoveBlockedReason::SourceChanged
                    }
                )
                && !fixture.runtime.dispatch_leases.is_held(SEMANTIC)
        },
    )
    .await;

    let held_after = current(&fixture.runtime, &fixture.source);
    let mut expected_held = held_before.clone();
    expected_held.disposition = CrossAccountMoveDisposition::Blocked {
        reason: CrossAccountMoveBlockedReason::SourceChanged,
    };
    assert_eq!(
        held_after, expected_held,
        "the ordinary source write may block the held workflow, but cannot rewrite its held evidence"
    );
    assert_eq!(held_after.legacy_admission, original.legacy_admission);
    assert_eq!(held_after.source, original.source);
    assert_eq!(held_after.children, original.children);
    assert!(held_after.children[0].item().unwrap().result.is_none());
    assert_eq!(target_proof_reads(), 1);
    assert_eq!(
        fixture.runtime.require_snapshot(&fixture.target).unwrap(),
        target_before
    );
    let RuntimeProjection::Operations(projected) = fixture
        .runtime
        .projection(&ObservationRequest::Operations {
            account_id: fixture.source.clone(),
        })
        .unwrap()
        .projection
    else {
        panic!("expected Operations");
    };
    let held_projection = projected
        .operations
        .iter()
        .find(|operation| operation.operation_id == SEMANTIC)
        .unwrap();
    assert_eq!(
        held_projection.resolution,
        OperationResolution::LegacyFailed
    );
    assert_eq!(
        held_projection
            .cross_account_move
            .as_ref()
            .unwrap()
            .disposition,
        crate::CrossAccountMoveDisposition::LegacyHeld
    );

    let source_mutations = fixture.http.mutations(SOURCE_ORIGIN);
    assert_eq!(
        source_mutations.len(),
        1,
        "only the ordinary operation writes"
    );
    let favorite = &source_mutations[0];
    assert_eq!(favorite.method, "PATCH");
    assert_eq!(
        favorite.url,
        format!("{SOURCE_ORIGIN}/api/v1/items/{SOURCE_ITEM}/favorite")
    );
    assert_eq!(favorite.body, br#"{"favorite":true}"#);
    assert_eq!(
        favorite.header("Idempotency-Key"),
        Some(favorite_operation_id.as_str())
    );
    assert!(fixture.http.mutations(TARGET_ORIGIN).is_empty());
    assert!(fixture.http.source.server.created_items.lock().unwrap()[0].favorite);
    assert_eq!(
        fixture.http.source.server.created_items.lock().unwrap()[0].version,
        original.source.version + 1
    );
    stop(&fixture, runner).await;
}

#[tokio::test]
async fn legacy_cross_normal_status_and_departed_claims_never_schedule_projection_ownership() {
    for (status, claim, expiry) in [
        (None, false, None),
        (Some("pending"), true, Some(NOW - 1)),
        (Some("staged"), true, Some(NOW + 654_321)),
        (Some("applying"), true, Some(NOW + 654_321)),
        (Some("staged"), true, None),
        (Some("applying"), true, Some(NOW - 1)),
        (Some("retrying"), true, None),
    ] {
        let time = DispatchTime::new();
        let history = json!({
            "status":status,
            "retryCount":"2", "nextAttemptAt":SOURCE_DEADLINE.to_string(),
            "lastError":"departed queue diagnostic",
            "projectionClaimId":claim.then_some("departed-projection-owner"),
            "projectionClaimExpiresAt":expiry.map(|value| value.to_string()),
            "attemptId":"departed-reminted-attempt"
        });
        let (mut fixture, original) = admitted_legacy_move_with_history(history, Some(&time)).await;
        assert_eq!(original.scheduling.attempt_count, 2);
        assert_eq!(original.scheduling.not_before_ms, SOURCE_DEADLINE);
        reopen_unlocked(&mut fixture, &time).await;
        fixture.http.resumed.store(true, Ordering::SeqCst);
        fixture.http.trash_result.release.add_permits(8);
        fixture.http.delete_result.release.add_permits(8);
        let runner = tokio::spawn(fixture.runtime.clone().run_operation_dispatch());
        prove_future_wait(&fixture, &time).await;
        time.advance_to(SOURCE_DEADLINE);
        prove_original_completion(&fixture, &original).await;
        assert_eq!(
            current(&fixture.runtime, &fixture.source)
                .scheduling
                .attempt_count,
            2
        );
        if let Some(expiry) = expiry {
            assert!(
                !time.waits_for(expiry),
                "departed claim expiry owns no Device timer"
            );
        }
        stop(&fixture, runner).await;
    }
}

#[tokio::test]
async fn cross_scheduler_test_timer_keeps_concurrent_sleepers_independent() {
    let time = DispatchTime::new();
    let first_timer = time.timer.clone();
    let first = tokio::spawn(async move { first_timer.sleep_ms(10).await });
    let second_timer = time.timer.clone();
    let second = tokio::spawn(async move { second_timer.sleep_ms(100).await });
    until("both independent physical waits", || {
        time.waits_for(NOW + 10) && time.waits_for(NOW + 100)
    })
    .await;
    time.advance_to(NOW + 10);
    first.await.unwrap();
    assert!(!second.is_finished());
    time.advance_to(NOW + 99);
    tokio::task::yield_now().await;
    assert!(!second.is_finished());
    time.advance_to(NOW + 100);
    second.await.unwrap();
}
