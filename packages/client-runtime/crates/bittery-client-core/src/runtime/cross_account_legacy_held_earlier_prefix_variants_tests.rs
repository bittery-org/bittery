//! Reachable SourceTrash checkpoints retain their durable Create proof during full completion.
use super::*;
use crate::runtime::dispatch::DispatchPass;

async fn readded_source_trash_prefix(
    status: &str,
    materialized: bool,
) -> (AdmittedMoveFixture, CrossAccountMoveRecord, MoveDatabase) {
    let (mut fixture, original) = admitted_legacy_move_with_history(json!({"status":status,"retryCount":"5","nextAttemptAt":"0","lastError":"retained original completion history"}), None).await;
    for step in STEPS {
        let proof: Value = serde_json::from_slice(&historical_effect(
            &fixture,
            &legacy_request(&original, step),
        ))
        .unwrap();
        assert_eq!(proof["result"]["status"], "applied");
    }
    fixture.http.offline.store(false, Ordering::SeqCst);
    fixture.http.resumed.store(true, Ordering::SeqCst);
    let mut reached = false;
    for _ in 0..3 {
        let snapshot = fixture.runtime.require_snapshot(&fixture.source).unwrap();
        assert!(matches!(
            fixture
                .runtime
                .dispatch_cross_account_move(&snapshot, SEMANTIC)
                .await,
            DispatchPass::Progressed
        ));
        let snapshot = fixture.runtime.require_snapshot(&fixture.source).unwrap();
        let held = snapshot.cross_account_moves[0].captured().unwrap();
        if held.stage == CrossAccountMoveStage::SourceTrash
            && held.children.len() == if materialized { 2 } else { 1 }
        {
            reached = true;
            break;
        }
    }
    assert!(
        reached,
        "stop at the actual selected SourceTrash checkpoint"
    );
    let current = fixture.runtime.require_snapshot(&fixture.source).unwrap();
    assert_eq!(
        current.cross_account_moves[0]
            .captured()
            .unwrap()
            .legacy_admission,
        original.legacy_admission
    );
    assert!(
        current.cross_account_moves[0].captured().unwrap().children[0]
            .item()
            .unwrap()
            .result
            .is_some()
    );
    if materialized {
        assert!(
            current.cross_account_moves[0].captured().unwrap().children[1]
                .item()
                .unwrap()
                .result
                .is_none()
        );
    }
    assert!(current.items.is_empty());
    assert!(fixture.http.mutations(SOURCE_ORIGIN).is_empty());
    assert_eq!(fixture.http.mutations(TARGET_ORIGIN).len(), 1);
    let artifacts =
        super::super::super::super::super::super::retirement_tests::remove_target(&fixture).await;
    super::super::super::recovery_tests::replace_target(&mut fixture).await;
    (fixture, original, artifacts)
}

fn assert_future_lookups(fixture: &AdmittedMoveFixture, start: usize) {
    let requests = fixture.http.requests.lock().unwrap();
    let lookups: Vec<_> = requests[start..]
        .iter()
        .filter(|r| r.url.contains("/operations/"))
        .map(|r| (r.method.clone(), r.url.clone()))
        .collect();
    assert_eq!(
        lookups,
        vec![
            (
                "GET".into(),
                format!("{SOURCE_ORIGIN}/api/v1/operations/{SEMANTIC}:trash-source")
            ),
            (
                "GET".into(),
                format!("{SOURCE_ORIGIN}/api/v1/operations/{SEMANTIC}:delete-source")
            ),
        ]
    );
}

#[tokio::test]
async fn both_source_trash_prefix_shapes_preserve_create_proof_and_refuse_wrong_future_proof_before_completion(
) {
    for (status, prior, materialized) in [
        ("failed", "legacyFailed", false),
        ("conflicted", "legacyConflicted", true),
    ] {
        let (mut fixture, original, _artifacts) =
            readded_source_trash_prefix(status, materialized).await;
        let recorder = Arc::new(RecordCompletionCommits {
            inner: fixture.sqlite.clone(),
            commits: Mutex::default(),
        });
        reopen_with(&mut fixture, recorder.clone()).await;
        let before = fixture.runtime.require_snapshot(&fixture.source).unwrap();
        let target = fixture.runtime.require_snapshot(&fixture.target).unwrap();
        let source_rows = durable_rows(&fixture.database.0, &fixture.source).await;
        let target_rows = durable_rows(&fixture.database.0, &fixture.target).await;
        let expected = expected_full_completion(&before, &target, prior);
        assert_eq!(
            expected["children"][0],
            serde_json::to_value(&before.cross_account_moves[0].captured().unwrap().children[0])
                .unwrap()
        );
        let observed = CompletionObservations::start(&fixture);
        let start = fixture.http.requests.lock().unwrap().len();
        let guard = prepare(&fixture, 1).await;
        assert_future_lookups(&fixture, start);
        assert_eq!(
            fixture.runtime.require_snapshot(&fixture.source).unwrap(),
            before
        );
        let trash_id = format!("{SEMANTIC}:trash-source");
        let original_outcome = {
            let ledger = fixture.http.source.server.outcomes.lock().unwrap();
            crate::runtime::operation_fixtures::outcome_body(&trash_id, &ledger[&trash_id].result)
        };
        let mut wrong: Value = serde_json::from_slice(&original_outcome).unwrap();
        wrong["result"]["version"] = json!(original.source.version + 2);
        for request in [
            RuntimeRequest::PrepareCrossAccountMoveResume {
                account_id: fixture.source.clone(),
                operation_id: SEMANTIC.into(),
                target_account_id: fixture.target.clone(),
                expected_binding_revision: 1,
            },
            RuntimeRequest::ResumeCrossAccountMove {
                guard: guard.clone(),
            },
        ] {
            fixture
                .http
                .source
                .server
                .lookup_response_overrides
                .lock()
                .unwrap()
                .push_back(serde_json::to_vec(&wrong).unwrap());
            let start = fixture.http.requests.lock().unwrap().len();
            let error = fixture
                .runtime
                .request(request, RequestCancellation::new())
                .await
                .unwrap_err();
            assert_eq!(error.code, RuntimeErrorCode::AccessDenied);
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
            assert_eq!(
                durable_rows(&fixture.database.0, &fixture.target).await,
                target_rows
            );
            assert!(recorder.commits.lock().unwrap().is_empty());
            assert!(fixture.http.mutations(SOURCE_ORIGIN).is_empty());
            assert_eq!(fixture.http.mutations(TARGET_ORIGIN).len(), 1);
            let requests = fixture.http.requests.lock().unwrap();
            let lookups: Vec<_> = requests[start..]
                .iter()
                .filter(|r| r.url.contains("/operations/"))
                .collect();
            assert_eq!(lookups.len(), 1);
            assert_eq!(lookups[0].method, "GET");
            assert_eq!(
                lookups[0].url,
                format!("{SOURCE_ORIGIN}/api/v1/operations/{trash_id}")
            );
            let ledger = fixture.http.source.server.outcomes.lock().unwrap();
            assert_eq!(
                crate::runtime::operation_fixtures::outcome_body(
                    &trash_id,
                    &ledger[&trash_id].result
                ),
                original_outcome
            );
        }
        fixture.http.trash_result.release.add_permits(2);
        fixture.http.delete_result.release.add_permits(2);
        let start = fixture.http.requests.lock().unwrap().len();
        confirm(&fixture, guard).await;
        assert_future_lookups(&fixture, start);
        assert_final_commit(&fixture, &recorder, &before, &expected).await;
        {
            let requests = fixture.http.requests.lock().unwrap();
            let recent = &requests[start..];
            let replays: Vec<_> = recent
                .iter()
                .enumerate()
                .filter(|(_, r)| r.method != "GET")
                .collect();
            assert_eq!(replays.len(), 2);
            for ((_, actual), step) in replays.iter().zip([
                CrossAccountMoveStep::SourceTrash,
                CrossAccountMoveStep::SourceDelete,
            ]) {
                assert_original_request(actual, &legacy_request(&original, step));
            }
            for (origin, id) in [(TARGET_ORIGIN, TARGET_ITEM), (SOURCE_ORIGIN, SOURCE_ITEM)] {
                assert!(recent[replays[1].0 + 1..]
                    .iter()
                    .any(|r| r.method == "GET" && r.url == format!("{origin}/api/v1/items/{id}")));
            }
        }
        assert_eq!(
            fixture.runtime.require_snapshot(&fixture.target).unwrap(),
            target
        );
        assert_eq!(
            durable_rows(&fixture.database.0, &fixture.target).await,
            target_rows
        );
        assert_eq!(fixture.http.mutations(TARGET_ORIGIN).len(), 1);
        assert_eq!(fixture.http.mutations(SOURCE_ORIGIN).len(), 2);
        observed.assert_completed();
        observed.close();
        fixture.runtime.close().await;
    }
}
