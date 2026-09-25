//! Two-child completion requires fresh proof for the fixed original Delete.
use super::*;

fn prepare_request(fixture: &AdmittedMoveFixture) -> RuntimeRequest {
    RuntimeRequest::PrepareCrossAccountMoveResume {
        account_id: fixture.source.clone(),
        operation_id: SEMANTIC.into(),
        target_account_id: fixture.target.clone(),
        expected_binding_revision: 1,
    }
}

async fn refuse_exact(fixture: &AdmittedMoveFixture, request: RuntimeRequest) {
    let source = fixture.runtime.require_snapshot(&fixture.source).unwrap();
    let target = fixture.runtime.require_snapshot(&fixture.target).unwrap();
    let source_rows = durable_rows(&fixture.database.0, &fixture.source).await;
    let target_rows = durable_rows(&fixture.database.0, &fixture.target).await;
    let start = fixture.http.requests.lock().unwrap().len();
    let source_writes = fixture.http.mutations(SOURCE_ORIGIN).len();
    let target_writes = fixture.http.mutations(TARGET_ORIGIN).len();
    let error = fixture
        .runtime
        .request(request, RequestCancellation::new())
        .await
        .unwrap_err();
    assert_eq!(error.code, RuntimeErrorCode::AccessDenied);
    assert_eq!(
        fixture.runtime.require_snapshot(&fixture.source).unwrap(),
        source
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
    assert_eq!(fixture.http.mutations(SOURCE_ORIGIN).len(), source_writes);
    assert_eq!(fixture.http.mutations(TARGET_ORIGIN).len(), target_writes);
    let lookup = format!("{SOURCE_ORIGIN}/api/v1/operations/{SEMANTIC}:delete-source");
    let requests = fixture.http.requests.lock().unwrap();
    let lookups: Vec<_> = requests[start..]
        .iter()
        .filter(|r| r.url.contains("/operations/"))
        .collect();
    assert_eq!(lookups.len(), 1);
    assert_eq!(lookups[0].method, "GET");
    assert_eq!(lookups[0].url, lookup);
    assert_eq!(
        source.cross_account_moves[0]
            .captured()
            .unwrap()
            .children
            .len(),
        2
    );
    assert!(source.items.is_empty());
    assert_eq!(
        workflow(&source_rows, SEMANTIC)["destinationBinding"]["status"],
        "retired"
    );
}

#[tokio::test]
async fn conflicted_unmaterialized_continuation_guard_can_complete_after_original_delete_and_refuses_wrong_hint(
) {
    let (mut fixture, original, _artifacts) = readded_source_delete("conflicted", false).await;
    let recorder = Arc::new(RecordCompletionCommits {
        inner: fixture.sqlite.clone(),
        commits: Mutex::default(),
    });
    reopen_with(&mut fixture, recorder.clone()).await;
    let before = fixture.runtime.require_snapshot(&fixture.source).unwrap();
    let target = fixture.runtime.require_snapshot(&fixture.target).unwrap();
    let expected = expected_completion(&before, &target, "legacyConflicted");
    let observed = CompletionObservations::start(&fixture);
    let guard = prepare(&fixture, 1).await;
    let lookup = format!("{SOURCE_ORIGIN}/api/v1/operations/{SEMANTIC}:delete-source");
    assert!(!fixture
        .http
        .requests
        .lock()
        .unwrap()
        .iter()
        .any(|r| r.url == lookup));
    let request = legacy_request(&original, CrossAccountMoveStep::SourceDelete);
    let original_outcome = historical_effect(&fixture, &request);
    let mut wrong: Value = serde_json::from_slice(&original_outcome).unwrap();
    assert_eq!(wrong["result"]["version"], original.source.version + 2);
    wrong["result"]["version"] = json!(original.source.version + 3);
    for request in [
        prepare_request(&fixture),
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
        refuse_exact(&fixture, request).await;
        let ledger = fixture.http.source.server.outcomes.lock().unwrap();
        assert_eq!(
            crate::runtime::operation_fixtures::outcome_body(
                &format!("{SEMANTIC}:delete-source"),
                &ledger[&format!("{SEMANTIC}:delete-source")].result
            ),
            original_outcome
        );
    }
    assert!(recorder.commits.lock().unwrap().is_empty());
    fixture.http.delete_result.release.add_permits(2);
    let start = fixture.http.requests.lock().unwrap().len();
    confirm(&fixture, guard).await;
    assert_lookup_then_final_reads(&fixture, start);
    assert_final_commit(&fixture, &recorder, &before, &expected).await;
    assert_eq!(
        fixture.runtime.require_snapshot(&fixture.target).unwrap(),
        target
    );
    let mutations = fixture.http.mutations(SOURCE_ORIGIN);
    assert_eq!(mutations.len(), 2);
    assert_original_request(&mutations[1], &request);
    assert_eq!(fixture.http.mutations(TARGET_ORIGIN).len(), 1);
    observed.assert_completed();
    observed.close();
    fixture.runtime.close().await;
}

#[tokio::test]
async fn unrelated_absence_cannot_materialize_a_missing_or_rejected_original_delete() {
    for rejected in [false, true] {
        let (fixture, original, _artifacts) = readded_source_delete("failed", false).await;
        let guard = prepare(&fixture, 1).await;
        let original_delete = legacy_request(&original, CrossAccountMoveStep::SourceDelete);
        if rejected {
            fixture.http.source.server.reject_next("vault_read_only");
            let proof: Value =
                serde_json::from_slice(&historical_effect(&fixture, &original_delete)).unwrap();
            assert_eq!(
                proof["result"],
                json!({"status":"rejected","code":"vault_read_only"})
            );
        }
        let mut other_delete = original_delete.clone();
        other_delete
            .headers
            .iter_mut()
            .find(|(name, _)| name.eq_ignore_ascii_case("Idempotency-Key"))
            .unwrap()
            .1 = "different-delete-without-original-completion".into();
        let proof: Value =
            serde_json::from_slice(&historical_effect(&fixture, &other_delete)).unwrap();
        assert_eq!(
            proof["operationId"],
            "different-delete-without-original-completion"
        );
        assert_eq!(proof["result"]["status"], "applied");
        assert!(fixture.http.source.server.created_items().is_empty());
        refuse_exact(&fixture, prepare_request(&fixture)).await;
        refuse_exact(&fixture, RuntimeRequest::ResumeCrossAccountMove { guard }).await;
        {
            let ledger = fixture.http.source.server.outcomes.lock().unwrap();
            assert_eq!(ledger.len(), if rejected { 3 } else { 2 });
            assert_eq!(
                ledger.contains_key(&format!("{SEMANTIC}:delete-source")),
                rejected
            );
        }
        fixture.runtime.close().await;
    }
}
