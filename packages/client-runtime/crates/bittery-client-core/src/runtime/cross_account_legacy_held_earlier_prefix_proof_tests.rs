//! Full completion checks the last original proof before replaying any earlier decided request.
use super::*;

#[tokio::test]
async fn initial_create_prefix_never_replays_when_original_delete_is_missing_or_genuinely_rejected()
{
    for (status, rejected) in [("failed", false), ("conflicted", true)] {
        let (mut fixture, original, _artifacts) =
            super::super::super::recovery_tests::readded_held_target(status).await;
        let recorder = Arc::new(RecordCompletionCommits {
            inner: fixture.sqlite.clone(),
            commits: Mutex::default(),
        });
        reopen_with(&mut fixture, recorder.clone()).await;
        // This is a genuine continuation guard while the original source is still live.
        let guard = prepare(&fixture, 1).await;
        let before = fixture.runtime.require_snapshot(&fixture.source).unwrap();
        let target = fixture.runtime.require_snapshot(&fixture.target).unwrap();
        let source_rows = durable_rows(&fixture.database.0, &fixture.source).await;
        let target_rows = durable_rows(&fixture.database.0, &fixture.target).await;
        assert_eq!(
            before.cross_account_moves[0].captured().unwrap().stage,
            CrossAccountMoveStage::TargetCreate
        );
        assert_eq!(
            before.cross_account_moves[0].captured().unwrap().children,
            original.children
        );
        assert_eq!(original.children.len(), 1);
        assert!(original.children[0].item().unwrap().result.is_none());
        let trash: Value = serde_json::from_slice(&historical_effect(
            &fixture,
            &legacy_request(&original, CrossAccountMoveStep::SourceTrash),
        ))
        .unwrap();
        assert_eq!(trash["result"]["status"], "applied");
        let original_delete = legacy_request(&original, CrossAccountMoveStep::SourceDelete);
        let rejected_body = if rejected {
            fixture.http.source.server.reject_next("vault_read_only");
            let body = historical_effect(&fixture, &original_delete);
            let outcome: Value = serde_json::from_slice(&body).unwrap();
            assert_eq!(outcome["operationId"], format!("{SEMANTIC}:delete-source"));
            assert_eq!(
                outcome["result"],
                json!({"status":"rejected","code":"vault_read_only"})
            );
            Some(body)
        } else {
            None
        };
        let mut other_delete = original_delete;
        other_delete
            .headers
            .iter_mut()
            .find(|(name, _)| name.eq_ignore_ascii_case("Idempotency-Key"))
            .unwrap()
            .1 = "another-operation-removes-the-original-source".into();
        let other: Value =
            serde_json::from_slice(&historical_effect(&fixture, &other_delete)).unwrap();
        assert_eq!(
            other["operationId"],
            "another-operation-removes-the-original-source"
        );
        assert_eq!(other["result"]["status"], "applied");
        assert!(fixture.http.source.server.created_items().is_empty());
        assert_eq!(
            fixture.runtime.require_snapshot(&fixture.source).unwrap(),
            before
        );
        let observed = CompletionObservations::start(&fixture);
        // Unexpected replay should fail assertions, rather than wait on a fixture response gate.
        fixture.http.trash_result.release.add_permits(4);
        fixture.http.delete_result.release.add_permits(4);
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
            let start = fixture.http.requests.lock().unwrap().len();
            let error = fixture
                .runtime
                .request(request, RequestCancellation::new())
                .await
                .unwrap_err();
            assert_eq!(error.code, RuntimeErrorCode::AccessDenied);
            assert_full_lookups(&fixture, start);
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
            assert!(fixture.http.mutations(TARGET_ORIGIN).is_empty());
            assert!(fixture.http.mutations(SOURCE_ORIGIN).is_empty());
            {
                let requests = fixture.http.requests.lock().unwrap();
                assert!(requests[start..]
                    .iter()
                    .all(|request| request.method == "GET"));
                let ledger = fixture.http.source.server.outcomes.lock().unwrap();
                assert_eq!(ledger.len(), if rejected { 3 } else { 2 });
                let id = format!("{SEMANTIC}:delete-source");
                if let Some(body) = &rejected_body {
                    assert_eq!(
                        &crate::runtime::operation_fixtures::outcome_body(&id, &ledger[&id].result),
                        body
                    );
                } else {
                    assert!(!ledger.contains_key(&id));
                }
                assert!(ledger.contains_key(&format!("{SEMANTIC}:trash-source")));
                assert!(ledger.contains_key("another-operation-removes-the-original-source"));
            }
            assert_eq!(fixture.http.target.server.outcomes.lock().unwrap().len(), 1);
            assert_eq!(
                fixture.http.target.server.created_items(),
                vec![TARGET_ITEM.to_owned()]
            );
            observed.assert_no_pending();
        }
        assert!(before.items.is_empty());
        observed.close();
        fixture.runtime.close().await;
    }
}
