//! A real Sync-progressed source cache remains separate from immutable accepted completion evidence.
use super::variants_tests::{
    assert_final_commit, assert_lookup_then_final_reads, expected_completion,
    CompletionObservations,
};
use super::*;
use crate::replica::{ReplicaState, SyncCursor};

#[path = "cross_account_legacy_held_completion_cache_variants_tests.rs"]
mod variants_tests;

#[path = "cross_account_legacy_held_trashed_continuation_tests.rs"]
mod trashed_continuation_tests;

async fn sync_trashed_source(fixture: &AdmittedMoveFixture, original: &CrossAccountMoveRecord) {
    let before = fixture.runtime.require_snapshot(&fixture.source).unwrap();
    let original_work = before.cross_account_moves.clone();
    let cursor = "held-completion-source-trash-sync";
    *fixture.http.source.server.sync_cursor.lock().unwrap() = Some(cursor.into());
    fixture.http.source.server.script_sync_page(
        vec![
            json!({"id":cursor,"type":"item_deleted","entityType":"item",
            "entityId":SOURCE_ITEM,"userId":"user-1","vaultId":"vault-1","clientId":null,
            "metadata":null,"timestamp":"1700000000000","version":original.source.version + 1}),
        ],
        cursor,
        false,
    );
    fixture.http.offline.store(false, Ordering::SeqCst);
    fixture.http.resumed.store(true, Ordering::SeqCst);
    let syncing = tokio::spawn(fixture.runtime.clone().run_live_sync());
    let settled = tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            let current = fixture.runtime.require_snapshot(&fixture.source).unwrap();
            if current.bootstrap.state == ReplicaState::Ready
                && current.bootstrap.active_cursor
                    == (SyncCursor::CapturedValue { id: cursor.into() })
                && current
                    .bootstrap
                    .snapshot()
                    .visible_items
                    .iter()
                    .any(|item| {
                        item.id == SOURCE_ITEM
                            && item.version == original.source.version + 1
                            && item.deleted_at.is_some()
                    })
            {
                break;
            }
            tokio::task::yield_now().await;
        }
    })
    .await;
    syncing.abort();
    let _ = syncing.await;
    settled.expect("actual Item-event live Sync must install the current trashed source in its active generation");
    let current = fixture.runtime.require_snapshot(&fixture.source).unwrap();
    assert_eq!(
        current.cross_account_moves, original_work,
        "Sync never rewrites the original held workflow/children/history"
    );
    assert!(current.items.is_empty());
    let cached = current
        .bootstrap
        .snapshot()
        .visible_items
        .into_iter()
        .find(|item| item.id == SOURCE_ITEM)
        .unwrap();
    assert_ne!(cached, original.source);
    assert_eq!(cached.version, original.source.version + 1);
    assert!(cached.deleted_at.is_some());
    let key = format!(
        "{}/{}",
        current.bootstrap.active_generation.as_ref().unwrap().0,
        SOURCE_ITEM
    );
    let rows = durable_rows(&fixture.database.0, &fixture.source).await;
    let row = rows
        .iter()
        .find(|row| row["store"] == "authorityItems" && row["key"]["recordId"] == key)
        .unwrap();
    assert_eq!(
        serde_json::from_str::<Value>(row["payloadJson"].as_str().unwrap()).unwrap(),
        serde_json::to_value(&cached).unwrap()
    );
    assert_eq!(
        workflow(&rows, SEMANTIC),
        serde_json::to_value(&original_work[0]).unwrap()
    );
    assert_eq!(
        current.cross_account_moves[0].captured().unwrap().source,
        original.source
    );
}

#[tokio::test]
async fn stopped_completion_after_real_trash_sync_removes_progressed_cache_without_pending_overlay()
{
    let (mut fixture, original, _artifacts) = readded_source_delete("failed", true).await;
    assert_eq!(
        fixture
            .runtime
            .require_snapshot(&fixture.source)
            .unwrap()
            .cross_account_moves[0]
            .captured()
            .unwrap()
            .destination_binding
            .binding_revision,
        1
    );
    sync_trashed_source(&fixture, &original).await;
    let recorder = Arc::new(RecordCompletionCommits {
        inner: fixture.sqlite.clone(),
        commits: Mutex::default(),
    });
    // Retained-work recovery must preserve the real Sync result without a legacy-source provider.
    reopen_with(&mut fixture, recorder.clone()).await;
    let before = fixture.runtime.require_snapshot(&fixture.source).unwrap();
    let target = fixture.runtime.require_snapshot(&fixture.target).unwrap();
    let target_rows = durable_rows(&fixture.database.0, &fixture.target).await;
    let expected = expected_completion(&before, &target, "legacyFailed");
    assert_eq!(
        before.cross_account_moves[0].captured().unwrap().source,
        original.source
    );
    assert!(before
        .bootstrap
        .snapshot()
        .visible_items
        .iter()
        .any(|item| item.id == SOURCE_ITEM && item.deleted_at.is_some()));
    let original_delete = legacy_request(&original, CrossAccountMoveStep::SourceDelete);
    let outcome: Value =
        serde_json::from_slice(&historical_effect(&fixture, &original_delete)).unwrap();
    assert_eq!(outcome["operationId"], format!("{SEMANTIC}:delete-source"));
    assert_eq!(outcome["result"]["status"], "applied");
    assert_eq!(outcome["result"]["version"], original.source.version + 2);
    assert!(fixture.http.source.server.created_items().is_empty());
    let observed = CompletionObservations::start(&fixture);
    let guard = prepare(&fixture, 1).await;
    assert_eq!(
        fixture.runtime.require_snapshot(&fixture.source).unwrap(),
        before
    );
    assert_eq!(
        fixture.runtime.require_snapshot(&fixture.target).unwrap(),
        target
    );
    assert!(recorder.commits.lock().unwrap().is_empty());
    fixture.http.delete_result.release.add_permits(2);
    let calls = fixture.http.requests.lock().unwrap().len();
    // Behavioral RED: the prior combined domain mutation requires original live cache equality.
    confirm(&fixture, guard).await;
    assert_lookup_then_final_reads(&fixture, calls);
    assert_final_commit(&fixture, &recorder, &before, &expected).await;
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
    assert_eq!(
        fixture
            .runtime
            .require_snapshot(&fixture.source)
            .unwrap()
            .cross_account_moves[0]
            .captured()
            .unwrap()
            .source,
        original.source
    );
    let source_effects = fixture.http.mutations(SOURCE_ORIGIN);
    assert_eq!(source_effects.len(), 2);
    assert_original_request(
        &source_effects[0],
        &legacy_request(&original, CrossAccountMoveStep::SourceTrash),
    );
    assert_original_request(&source_effects[1], &original_delete);
    assert_eq!(fixture.http.mutations(TARGET_ORIGIN).len(), 1);
    assert_eq!(fixture.http.source.server.outcomes.lock().unwrap().len(), 2);
    let completed = durable_rows(&fixture.database.0, &fixture.source).await;
    fixture.sqlite = MoveSqlite::open(&fixture.database.0);
    let plain = fixture.sqlite.clone();
    reopen_with(&mut fixture, plain).await;
    assert_eq!(
        durable_rows(&fixture.database.0, &fixture.source).await,
        completed
    );
    assert_eq!(workflow(&completed, SEMANTIC), expected);
    assert!(fixture
        .runtime
        .require_snapshot(&fixture.source)
        .unwrap()
        .items
        .is_empty());
    assert!(!fixture
        .runtime
        .require_snapshot(&fixture.source)
        .unwrap()
        .bootstrap
        .snapshot()
        .visible_items
        .iter()
        .any(|item| item.id == SOURCE_ITEM));
    let reopened = CompletionObservations::start(&fixture);
    reopened.assert_completed();
    reopened.close();
    assert_eq!(fixture.http.mutations(SOURCE_ORIGIN).len(), 2);
    assert_eq!(fixture.http.mutations(TARGET_ORIGIN).len(), 1);
    fixture.runtime.close().await;
}
