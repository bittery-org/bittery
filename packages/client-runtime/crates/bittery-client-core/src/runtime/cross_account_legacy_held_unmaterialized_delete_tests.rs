//! Final legacy Delete proof can complete an original two-child checkpoint without an intermediate row.
use super::variants_tests::{
    assert_final_commit, assert_lookup_then_final_reads, expected_completion,
    CompletionObservations,
};
use super::*;
use crate::replica::CrossAccountMoveStage;
use crate::runtime::dispatch::DispatchPass;

#[path = "cross_account_legacy_held_unmaterialized_delete_final_read_tests.rs"]
mod final_read_tests;

#[path = "cross_account_legacy_held_unmaterialized_delete_variants_tests.rs"]
mod variants_tests;

#[tokio::test]
async fn original_remote_delete_before_core_prepares_its_child_completes_in_one_final_revision() {
    let (mut fixture, original) = admitted_legacy_move_with_history(json!({"status":"failed","retryCount":"5","nextAttemptAt":"0","lastError":"lost original final-attempt Delete response"}), None).await;
    // The original client completed all remote effects before Core recovers its fixed prefix.
    for step in [
        CrossAccountMoveStep::TargetCreate,
        CrossAccountMoveStep::SourceTrash,
        CrossAccountMoveStep::SourceDelete,
    ] {
        let proof: Value = serde_json::from_slice(&historical_effect(
            &fixture,
            &legacy_request(&original, step),
        ))
        .unwrap();
        assert_eq!(proof["result"]["status"], "applied");
    }
    assert!(fixture.http.source.server.created_items().is_empty());
    fixture.http.offline.store(false, Ordering::SeqCst);
    fixture.http.resumed.store(true, Ordering::SeqCst);
    fixture.http.trash_result.release.add_permits(4);
    let mut reached = false;
    for _ in 0..6 {
        let snapshot = fixture.runtime.require_snapshot(&fixture.source).unwrap();
        assert!(matches!(
            fixture
                .runtime
                .dispatch_cross_account_move(&snapshot, SEMANTIC)
                .await,
            DispatchPass::Progressed
        ));
        let current = fixture.runtime.require_snapshot(&fixture.source).unwrap();
        let held = current.cross_account_moves[0].captured().unwrap();
        if held.stage == CrossAccountMoveStage::SourceDelete && held.children.len() == 2 {
            reached = true;
            break;
        }
    }
    assert!(
        reached,
        "stop at the actual Trash-proof commit before pure Delete preparation"
    );
    let checkpoint = fixture.runtime.require_snapshot(&fixture.source).unwrap();
    let held = checkpoint.cross_account_moves[0].captured().unwrap();
    assert_eq!(held.legacy_admission, original.legacy_admission);
    assert!(held
        .children
        .iter()
        .all(|child| child.item().unwrap().result.is_some()));
    assert!(checkpoint.items.is_empty());
    assert_eq!(fixture.http.mutations(SOURCE_ORIGIN).len(), 1);
    assert_eq!(fixture.http.mutations(TARGET_ORIGIN).len(), 1);
    let _artifacts =
        super::super::super::super::super::retirement_tests::remove_target(&fixture).await;
    super::super::recovery_tests::replace_target(&mut fixture).await;
    let recorder = Arc::new(RecordCompletionCommits {
        inner: fixture.sqlite.clone(),
        commits: Mutex::default(),
    });
    reopen_with(&mut fixture, recorder.clone()).await;
    let before = fixture.runtime.require_snapshot(&fixture.source).unwrap();
    let target = fixture.runtime.require_snapshot(&fixture.target).unwrap();
    let source_rows = durable_rows(&fixture.database.0, &fixture.source).await;
    let target_rows = durable_rows(&fixture.database.0, &fixture.target).await;
    assert_eq!(
        before.cross_account_moves[0].captured().unwrap().children,
        held.children
    );
    assert_eq!(
        before.cross_account_moves[0].captured().unwrap().source,
        original.source
    );
    let expected = expected_completion(&before, &target, "legacyFailed");
    let observed = CompletionObservations::start(&fixture);
    let calls = fixture.http.requests.lock().unwrap().len();
    // Behavioral RED: current Resume examines only materialized children and cannot prove Delete.
    let guard = prepare(&fixture, 1).await;
    assert_eq!(
        fixture.runtime.require_snapshot(&fixture.source).unwrap(),
        before
    );
    assert_eq!(
        fixture.runtime.require_snapshot(&fixture.target).unwrap(),
        target
    );
    assert_eq!(
        durable_rows(&fixture.database.0, &fixture.source).await,
        source_rows
    );
    assert!(recorder.commits.lock().unwrap().is_empty());
    let lookup = format!("{SOURCE_ORIGIN}/api/v1/operations/{SEMANTIC}:delete-source");
    assert!(fixture
        .http
        .requests
        .lock()
        .unwrap()
        .iter()
        .skip(calls)
        .any(|request| request.method == "GET" && request.url == lookup));
    assert_eq!(fixture.http.mutations(SOURCE_ORIGIN).len(), 1);
    assert_eq!(fixture.http.mutations(TARGET_ORIGIN).len(), 1);
    fixture.http.delete_result.release.add_permits(2);
    let calls = fixture.http.requests.lock().unwrap().len();
    confirm(&fixture, guard).await;
    assert_lookup_then_final_reads(&fixture, calls);
    assert_final_commit(&fixture, &recorder, &before, &expected).await;
    let completed_rows = durable_rows(&fixture.database.0, &fixture.source).await;
    let completed = workflow(&completed_rows, SEMANTIC);
    assert_eq!(completed["children"].as_array().unwrap().len(), 3);
    assert_eq!(
        completed["children"][0],
        serde_json::to_value(&held.children[0]).unwrap()
    );
    assert_eq!(
        completed["children"][1],
        serde_json::to_value(&held.children[1]).unwrap()
    );
    assert_eq!(
        completed["source"],
        serde_json::to_value(&original.source).unwrap()
    );
    observed.assert_completed();
    observed.close();
    assert_eq!(
        fixture.runtime.require_snapshot(&fixture.target).unwrap(),
        target
    );
    assert_eq!(
        durable_rows(&fixture.database.0, &fixture.target).await,
        target_rows
    );
    let requests = fixture.http.mutations(SOURCE_ORIGIN);
    assert_eq!(requests.len(), 2);
    let expected_delete = legacy_request(&original, CrossAccountMoveStep::SourceDelete);
    assert_original_request(&requests[1], &expected_delete);
    assert_eq!(
        requests[1].header("Idempotency-Key"),
        Some(format!("{SEMANTIC}:delete-source").as_str())
    );
    assert_eq!(
        requests[1].header("If-Match"),
        Some(format!("\"{}\"", original.source.version + 1).as_str())
    );
    assert!(requests[1].body.is_empty());
    assert_eq!(fixture.http.mutations(TARGET_ORIGIN).len(), 1);
    assert_eq!(fixture.http.source.server.outcomes.lock().unwrap().len(), 2);
    fixture.sqlite = MoveSqlite::open(&fixture.database.0);
    let plain = fixture.sqlite.clone();
    reopen_with(&mut fixture, plain).await;
    assert_eq!(
        durable_rows(&fixture.database.0, &fixture.source).await,
        completed_rows
    );
    let observed = CompletionObservations::start(&fixture);
    observed.assert_completed();
    observed.close();
    assert_eq!(fixture.http.mutations(SOURCE_ORIGIN).len(), 2);
    assert_eq!(fixture.http.mutations(TARGET_ORIGIN).len(), 1);
    fixture.runtime.close().await;
}
