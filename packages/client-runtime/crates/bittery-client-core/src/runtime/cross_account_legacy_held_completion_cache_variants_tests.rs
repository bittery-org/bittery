//! Actual permanent-delete Sync can remove cache authority, but cannot preserve a stale confirmation.
use super::*;

async fn sync_deleted_source(
    fixture: &AdmittedMoveFixture,
    original: &CrossAccountMoveRecord,
    cursor: &str,
) {
    assert!(fixture.http.source.server.created_items().is_empty());
    let before = fixture.runtime.require_snapshot(&fixture.source).unwrap();
    let original_work = before.cross_account_moves.clone();
    *fixture.http.source.server.sync_cursor.lock().unwrap() = Some(cursor.into());
    fixture.http.source.server.script_sync_page(
        vec![
            json!({"id":cursor,"type":"item_permanently_deleted","entityType":"item",
            "entityId":SOURCE_ITEM,"userId":"user-1","vaultId":"vault-1","clientId":null,
            "metadata":null,"timestamp":"1700000000000","version":original.source.version + 2}),
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
                && !current
                    .bootstrap
                    .snapshot()
                    .visible_items
                    .iter()
                    .any(|item| item.id == SOURCE_ITEM)
            {
                break;
            }
            tokio::task::yield_now().await;
        }
    })
    .await;
    syncing.abort();
    let _ = syncing.await;
    settled.expect("actual permanent-delete Item event must remove active source authority");
    let current = fixture.runtime.require_snapshot(&fixture.source).unwrap();
    assert!(current.revision > before.revision);
    assert_eq!(
        current.cross_account_moves, original_work,
        "Sync leaves all accepted source/child evidence intact"
    );
    assert!(current.items.is_empty());
    assert!(!current
        .bootstrap
        .snapshot()
        .visible_items
        .iter()
        .any(|item| item.id == SOURCE_ITEM));
    assert_eq!(
        current.cross_account_moves[0].captured().unwrap().source,
        original.source
    );
    let rows = durable_rows(&fixture.database.0, &fixture.source).await;
    let source_key = format!(
        "{}/{}",
        current.bootstrap.active_generation.as_ref().unwrap().0,
        SOURCE_ITEM
    );
    assert!(!rows
        .iter()
        .any(|row| row["store"] == "authorityItems" && row["key"]["recordId"] == source_key));
    assert_eq!(
        workflow(&rows, SEMANTIC),
        serde_json::to_value(&original_work[0]).unwrap()
    );
}

fn original_delete_effect(
    fixture: &AdmittedMoveFixture,
    original: &CrossAccountMoveRecord,
) -> RecordedRequest {
    let request = legacy_request(original, CrossAccountMoveStep::SourceDelete);
    let proof: Value = serde_json::from_slice(&historical_effect(fixture, &request)).unwrap();
    assert_eq!(proof["operationId"], format!("{SEMANTIC}:delete-source"));
    assert_eq!(proof["result"]["status"], "applied");
    assert_eq!(proof["result"]["version"], original.source.version + 2);
    assert!(fixture.http.source.server.created_items().is_empty());
    request
}

#[tokio::test]
async fn stopped_completion_after_actual_delete_sync_preserves_absent_cache_without_source_write() {
    let (mut fixture, original, _artifacts) = readded_source_delete("conflicted", true).await;
    let request = original_delete_effect(&fixture, &original);
    sync_deleted_source(&fixture, &original, "held-completion-source-delete-sync").await;
    let recorder = Arc::new(RecordCompletionCommits {
        inner: fixture.sqlite.clone(),
        commits: Mutex::default(),
    });
    reopen_with(&mut fixture, recorder.clone()).await;
    let before = fixture.runtime.require_snapshot(&fixture.source).unwrap();
    let target = fixture.runtime.require_snapshot(&fixture.target).unwrap();
    let target_rows = durable_rows(&fixture.database.0, &fixture.target).await;
    let expected = expected_completion(&before, &target, "legacyConflicted");
    let observed = CompletionObservations::start(&fixture);
    let guard = prepare(&fixture, 1).await;
    assert_eq!(
        fixture.runtime.require_snapshot(&fixture.source).unwrap(),
        before
    );
    assert!(recorder.commits.lock().unwrap().is_empty());
    fixture.http.delete_result.release.add_permits(2);
    let calls = fixture.http.requests.lock().unwrap().len();
    confirm(&fixture, guard).await;
    assert_lookup_then_final_reads(&fixture, calls);
    assert_final_commit(&fixture, &recorder, &before, &expected).await;
    assert_eq!(
        fixture
            .runtime
            .require_snapshot(&fixture.source)
            .unwrap()
            .bootstrap,
        before.bootstrap,
        "already-absent active authority stays exact"
    );
    assert_eq!(
        fixture.runtime.require_snapshot(&fixture.target).unwrap(),
        target
    );
    assert_eq!(
        durable_rows(&fixture.database.0, &fixture.target).await,
        target_rows
    );
    observed.assert_completed();
    observed.close();
    let source_requests = fixture.http.mutations(SOURCE_ORIGIN);
    assert_eq!(source_requests.len(), 2);
    assert_original_request(&source_requests[1], &request);
    assert_eq!(fixture.http.mutations(TARGET_ORIGIN).len(), 1);
    let completed = durable_rows(&fixture.database.0, &fixture.source).await;
    fixture.sqlite = MoveSqlite::open(&fixture.database.0);
    let plain = fixture.sqlite.clone();
    reopen_with(&mut fixture, plain).await;
    assert_eq!(
        durable_rows(&fixture.database.0, &fixture.source).await,
        completed
    );
    assert_eq!(workflow(&completed, SEMANTIC), expected);
    let reopened = CompletionObservations::start(&fixture);
    reopened.assert_completed();
    reopened.close();
    assert_eq!(fixture.http.mutations(SOURCE_ORIGIN).len(), 2);
    assert_eq!(fixture.http.mutations(TARGET_ORIGIN).len(), 1);
    fixture.runtime.close().await;
}

#[tokio::test]
async fn actual_delete_sync_between_prepare_and_confirm_refuses_old_revision_without_proof_io() {
    let (mut fixture, original, _artifacts) = readded_source_delete("failed", true).await;
    let recorder = Arc::new(RecordCompletionCommits {
        inner: fixture.sqlite.clone(),
        commits: Mutex::default(),
    });
    reopen_with(&mut fixture, recorder.clone()).await;
    let request = original_delete_effect(&fixture, &original);
    let observed = CompletionObservations::start(&fixture);
    let old_guard = prepare(&fixture, 1).await;
    let prepared = fixture.runtime.require_snapshot(&fixture.source).unwrap();
    sync_deleted_source(
        &fixture,
        &original,
        "held-completion-delete-sync-invalidates-guard",
    )
    .await;
    let after_sync = fixture.runtime.require_snapshot(&fixture.source).unwrap();
    let target = fixture.runtime.require_snapshot(&fixture.target).unwrap();
    let source_rows = durable_rows(&fixture.database.0, &fixture.source).await;
    let target_rows = durable_rows(&fixture.database.0, &fixture.target).await;
    assert!(after_sync.revision > prepared.revision);
    assert_eq!(after_sync.cross_account_moves, prepared.cross_account_moves);
    let calls = fixture.http.requests.lock().unwrap().len();
    let error = fixture
        .runtime
        .request(
            RuntimeRequest::ResumeCrossAccountMove { guard: old_guard },
            RequestCancellation::new(),
        )
        .await
        .unwrap_err();
    assert_eq!(error.code, RuntimeErrorCode::AccessDenied);
    assert_eq!(fixture.http.requests.lock().unwrap().len(), calls);
    assert_eq!(
        fixture.runtime.require_snapshot(&fixture.source).unwrap(),
        after_sync
    );
    assert_eq!(
        fixture.runtime.require_snapshot(&fixture.target).unwrap(),
        target
    );
    assert_eq!(
        durable_rows(&fixture.database.0, &fixture.source).await,
        source_rows
    );
    assert_eq!(
        durable_rows(&fixture.database.0, &fixture.target).await,
        target_rows
    );
    assert!(recorder.commits.lock().unwrap().is_empty());
    assert_eq!(fixture.http.mutations(SOURCE_ORIGIN).len(), 1);
    assert_eq!(fixture.http.mutations(TARGET_ORIGIN).len(), 1);
    observed.assert_no_pending();
    // A new explicit guard can reconcile the same original proof under the now-current cache revision.
    let fresh_guard = prepare(&fixture, 1).await;
    fixture.http.delete_result.release.add_permits(2);
    confirm(&fixture, fresh_guard).await;
    let expected = expected_completion(&after_sync, &target, "legacyFailed");
    assert_final_commit(&fixture, &recorder, &after_sync, &expected).await;
    observed.assert_completed();
    observed.close();
    let replays = fixture.http.mutations(SOURCE_ORIGIN);
    assert_eq!(replays.len(), 2);
    assert_original_request(&replays[1], &request);
    assert_eq!(fixture.http.mutations(TARGET_ORIGIN).len(), 1);
    assert_eq!(fixture.http.source.server.outcomes.lock().unwrap().len(), 2);
    fixture.runtime.close().await;
}
