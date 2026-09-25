//! Every original child must already have an outcome before a stopped workflow replays it.
use super::*;
use crate::runtime::dispatch::DispatchPass;

#[tokio::test]
async fn held_cross_remote_prefix_stops_at_first_missing_original_child() {
    for prefix in 1..=3 {
        let status = if prefix == 2 { "conflicted" } else { "failed" };
        let (mut fixture, original) =
            admitted_legacy_move_with_history(json!({"status":status}), None).await;
        let before = fixture
            .runtime
            .require_snapshot(&fixture.source)
            .unwrap()
            .bootstrap;
        let target_before = durable_rows(&fixture.database.0, &fixture.target).await;
        let independent = if prefix == 3 {
            // Accept through the public command while the original captured source is still live.
            // This command owns its own overlay; the stopped workflow owns none.
            fixture
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
                .unwrap();
            let snapshot = fixture.runtime.require_snapshot(&fixture.source).unwrap();
            assert_eq!(snapshot.operations.len(), 1);
            assert_eq!(snapshot.items.len(), 1);
            assert_eq!(
                snapshot.items[0].operation_id,
                snapshot.operations[0].operation_id
            );
            assert_ne!(snapshot.items[0].operation_id, SEMANTIC);
            assert_eq!(snapshot.items[0].favorite, !original.source.favorite);
            let rows = durable_rows(&fixture.database.0, &fixture.source).await;
            let owned_rows = rows
                .into_iter()
                .filter(|row| {
                    matches!(
                        row["store"].as_str(),
                        Some("operations" | "optimisticItems")
                    )
                })
                .collect::<Vec<_>>();
            assert_eq!(owned_rows.len(), 2);
            Some((snapshot.operations, snapshot.items, owned_rows))
        } else {
            None
        };
        let steps = [
            CrossAccountMoveStep::TargetCreate,
            CrossAccountMoveStep::SourceTrash,
            CrossAccountMoveStep::SourceDelete,
        ];
        for step in steps.iter().take(prefix) {
            let result: Value = serde_json::from_slice(&historical_effect(
                &fixture,
                &request(&original, step.clone()),
            ))
            .unwrap();
            assert_eq!(result["result"]["status"], "applied");
        }
        assert_sync_events_leave_held_children_for_the_workflow(&fixture, &original).await;
        fixture.http.offline.store(false, Ordering::SeqCst);
        fixture.http.resumed.store(true, Ordering::SeqCst);
        fixture.http.trash_result.release.add_permits(16);
        fixture.http.delete_result.release.add_permits(16);
        for _ in 0..12 {
            let snapshot = fixture.runtime.require_snapshot(&fixture.source).unwrap();
            let pass = fixture
                .runtime
                .dispatch_cross_account_move(&snapshot, SEMANTIC)
                .await;
            if matches!(pass, DispatchPass::Parked)
                || current(&fixture).stage == CrossAccountMoveStage::Completed
            {
                break;
            }
        }
        let after = current(&fixture);
        assert_eq!(after.legacy_admission, original.legacy_admission);
        assert_eq!(fixture.http.mutations(TARGET_ORIGIN).len(), 1);
        assert_eq!(fixture.http.mutations(SOURCE_ORIGIN).len(), prefix - 1);
        assert_eq!(
            durable_rows(&fixture.database.0, &fixture.target).await,
            target_before
        );
        if prefix == 3 {
            assert_eq!(after.stage, CrossAccountMoveStage::Completed);
            assert_exact_child_replays(&fixture, &original);
            let (operations_before, items_before, rows_before) = independent.as_ref().unwrap();
            let snapshot = fixture.runtime.require_snapshot(&fixture.source).unwrap();
            assert_eq!(&snapshot.operations, operations_before);
            assert_eq!(&snapshot.items, items_before);
            assert!(snapshot
                .bootstrap
                .snapshot()
                .visible_items
                .iter()
                .all(|item| item.id != SOURCE_ITEM));
            let rows = durable_rows(&fixture.database.0, &fixture.source).await;
            let owned_rows = rows
                .into_iter()
                .filter(|row| {
                    matches!(
                        row["store"].as_str(),
                        Some("operations" | "optimisticItems")
                    )
                })
                .collect::<Vec<_>>();
            assert_eq!(&owned_rows, rows_before);
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
            assert_eq!(projected.operations.len(), 2);
            assert_eq!(
                projected
                    .operations
                    .iter()
                    .find(|operation| operation.operation_id == SEMANTIC)
                    .unwrap()
                    .resolution,
                OperationResolution::Applied
            );
            assert!(projected
                .operations
                .iter()
                .any(|operation| operation.operation_id == operations_before[0].operation_id));
        } else {
            assert_eq!(
                after.stage,
                if prefix == 1 {
                    CrossAccountMoveStage::SourceTrash
                } else {
                    CrossAccountMoveStage::SourceDelete
                }
            );
            assert_eq!(after.children.len(), prefix + 1);
            assert!(after
                .children
                .last()
                .unwrap()
                .item()
                .unwrap()
                .result
                .is_none());
            assert_eq!(after.disposition, CrossAccountMoveDisposition::Ready);
            assert_eq!(
                fixture
                    .runtime
                    .require_snapshot(&fixture.source)
                    .unwrap()
                    .bootstrap,
                before
            );
            let mutations = fixture
                .http
                .requests
                .lock()
                .unwrap()
                .iter()
                .filter(|request| request.header("Idempotency-Key").is_some())
                .count();
            reopen(&mut fixture).await;
            let snapshot = fixture.runtime.require_snapshot(&fixture.source).unwrap();
            assert!(matches!(
                fixture
                    .runtime
                    .dispatch_cross_account_move(&snapshot, SEMANTIC)
                    .await,
                DispatchPass::Parked
            ));
            assert_eq!(current(&fixture), after);
            assert_eq!(
                fixture
                    .http
                    .requests
                    .lock()
                    .unwrap()
                    .iter()
                    .filter(|request| request.header("Idempotency-Key").is_some())
                    .count(),
                mutations
            );
        }
        fixture.runtime.close().await;
    }
}
// Call after historical_effect has retained the genuine remote prefix, before the first dispatch.
// This invokes the same outcome reconciliation seam used for a Sync operation-resolved event;
// it does not claim an end-to-end Bootstrap HTTP page test.
async fn assert_sync_events_leave_held_children_for_the_workflow(
    fixture: &AdmittedMoveFixture,
    original: &CrossAccountMoveRecord,
) {
    let source_before = fixture.runtime.require_snapshot(&fixture.source).unwrap();
    let target_before = fixture.runtime.require_snapshot(&fixture.target).unwrap();
    let source_rows = durable_rows(&fixture.database.0, &fixture.source).await;
    let target_rows = durable_rows(&fixture.database.0, &fixture.target).await;
    let requests_before = fixture.http.requests.lock().unwrap().len();
    for (account, origin, operation_id) in [
        (
            &fixture.target,
            TARGET_ORIGIN,
            format!("{SEMANTIC}:create-target"),
        ),
        (
            &fixture.source,
            SOURCE_ORIGIN,
            format!("{SEMANTIC}:trash-source"),
        ),
        (
            &fixture.source,
            SOURCE_ORIGIN,
            format!("{SEMANTIC}:delete-source"),
        ),
        (&fixture.source, SOURCE_ORIGIN, SEMANTIC.into()),
        (&fixture.source, SOURCE_ORIGIN, "legacy-attempt".into()),
    ] {
        let snapshot = fixture.runtime.require_snapshot(account).unwrap();
        let mut session = fixture
            .runtime
            .platform_storage
            .load_current_session(account, &snapshot.incarnation)
            .await
            .unwrap()
            .unwrap();
        let http = crate::auth_http::AuthHttpClient::new(
            &fixture.runtime.http_transport,
            origin,
            false,
            fixture.runtime.auth_client_config.clone().unwrap(),
        )
        .unwrap();
        assert!(matches!(
            fixture
                .runtime
                .reconcile_resolved_operation(account, &operation_id, &http, &mut session,)
                .await,
            crate::runtime::outcome::CompletionResult::Completed
        ));
    }
    assert_eq!(fixture.http.requests.lock().unwrap().len(), requests_before);
    assert_eq!(
        fixture.runtime.require_snapshot(&fixture.source).unwrap(),
        source_before
    );
    assert_eq!(
        fixture.runtime.require_snapshot(&fixture.target).unwrap(),
        target_before
    );
    assert_eq!(
        durable_rows(&fixture.database.0, &fixture.source).await,
        source_rows
    );
    assert_eq!(
        durable_rows(&fixture.database.0, &fixture.target).await,
        target_rows
    );
    assert_eq!(current(fixture), *original);
}
