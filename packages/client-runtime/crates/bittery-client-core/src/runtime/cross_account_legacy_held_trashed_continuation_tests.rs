//! Explicit continuation keeps the real trashed Item authoritative and owns work without an overlay.
use super::*;
use crate::runtime::dispatch::DispatchPass;

#[path = "cross_account_legacy_held_trashed_continuation_variants_tests.rs"]
mod variants_tests;

fn items_at_snapshot_scope(
    mut items: Vec<crate::ItemProjection>,
    snapshot: &crate::replica::ReplicaSnapshot,
) -> Vec<crate::ItemProjection> {
    for item in &mut items {
        let edit = item.edit_guard.as_mut().expect("authoritative edit guard");
        edit.incarnation = snapshot.incarnation.clone();
        edit.lock_epoch = snapshot.lock_epoch;
        let duplicate = item
            .duplicate_source_guard
            .as_mut()
            .expect("authoritative duplicate guard");
        duplicate.incarnation_id = snapshot.incarnation.clone();
        duplicate.lock_epoch = snapshot.lock_epoch;
        duplicate.replica_revision = snapshot.revision;
    }
    items
}

#[tokio::test]
async fn trashed_cache_source_delete_continuation_preserves_authority_without_a_pending_item_overlay(
) {
    let (mut fixture, original, _artifacts) = readded_source_delete("failed", true).await;
    sync_trashed_source(&fixture, &original).await;
    let recorder = Arc::new(RecordCompletionCommits {
        inner: fixture.sqlite.clone(),
        commits: Mutex::default(),
    });
    reopen_with(&mut fixture, recorder.clone()).await;
    let before = fixture.runtime.require_snapshot(&fixture.source).unwrap();
    let target = fixture.runtime.require_snapshot(&fixture.target).unwrap();
    let source_rows = durable_rows(&fixture.database.0, &fixture.source).await;
    let target_rows = durable_rows(&fixture.database.0, &fixture.target).await;
    let held = workflow(&source_rows, SEMANTIC);
    assert_eq!(held["children"].as_array().unwrap().len(), 3);
    assert!(held["children"][2]["result"].is_null());
    assert_eq!(
        before.cross_account_moves[0].captured().unwrap().source,
        original.source
    );
    assert!(before.items.is_empty());
    assert!(!before.item_has_optimistic_owner(SOURCE_ITEM));
    let RuntimeProjection::Items(items_before) = fixture
        .runtime
        .projection(&ObservationRequest::Items {
            account_id: fixture.source.clone(),
        })
        .unwrap()
        .projection
    else {
        panic!("expected Items");
    };
    let item = items_before
        .items
        .iter()
        .find(|item| item.item_id == SOURCE_ITEM)
        .unwrap();
    assert!(item.deleted_at.is_some());
    assert_eq!(item.status, crate::ItemProjectionStatus::Authoritative);
    let sink = Arc::new(Sink::default());
    let observation = fixture
        .runtime
        .observe(
            ObservationRequest::Items {
                account_id: fixture.source.clone(),
            },
            sink.clone(),
        )
        .unwrap();
    let guard = prepare(&fixture, 1).await;
    assert_eq!(
        fixture.runtime.require_snapshot(&fixture.source).unwrap(),
        before
    );
    assert_eq!(
        durable_rows(&fixture.database.0, &fixture.source).await,
        source_rows
    );
    assert!(recorder.commits.lock().unwrap().is_empty());
    let calls = fixture.http.requests.lock().unwrap().len();
    // Behavioral RED before the new mode: the ordinary activation requires the original live cache.
    confirm(&fixture, guard).await;
    assert_lookup_then_final_reads(&fixture, calls);
    let after = fixture.runtime.require_snapshot(&fixture.source).unwrap();
    assert_eq!(after.revision, before.revision + 1);
    assert_eq!(after.bootstrap, before.bootstrap);
    assert_eq!(after.operations, before.operations);
    assert!(after.items.is_empty());
    assert!(after.item_has_optimistic_owner(SOURCE_ITEM));
    assert_eq!(
        resolution(&fixture.runtime, &fixture.source, SEMANTIC),
        OperationResolution::Pending
    );
    let RuntimeProjection::Items(items_after) = fixture
        .runtime
        .projection(&ObservationRequest::Items {
            account_id: fixture.source.clone(),
        })
        .unwrap()
        .projection
    else {
        panic!("expected Items");
    };
    assert_eq!(
        items_after.items,
        items_at_snapshot_scope(items_before.items.clone(), &after),
        "authorization keeps the exact trashed Item and current edit/duplicate guards"
    );
    let authorized_rows = durable_rows(&fixture.database.0, &fixture.source).await;
    let authorized = workflow(&authorized_rows, SEMANTIC);
    let mut expected = held.clone();
    expected["destinationBinding"] = json!({"accountId":fixture.target,"incarnation":target.incarnation,"bindingRevision":"2","status":"active"});
    expected["legacyAdmission"]["disposition"] =
        json!({"destinationReauthorized":{"priorHold":"legacyFailed","bindingRevision":"2"}});
    expected["disposition"] = json!({"type":"ready"});
    assert_eq!(
        authorized, expected,
        "original capture, all child evidence, DTO/history and scheduling remain exact"
    );
    assert_eq!(
        fixture.runtime.require_snapshot(&fixture.target).unwrap(),
        target
    );
    assert_eq!(
        durable_rows(&fixture.database.0, &fixture.target).await,
        target_rows
    );
    {
        let commits = recorder.commits.lock().unwrap();
        assert_eq!(commits.len(), 1);
        let writes = commits[0]["prepared"]["writes"].as_array().unwrap();
        assert!(
            writes.iter().all(|write| {
                let store = if write["type"] == "put" {
                    &write["row"]["store"]
                } else {
                    &write["store"]
                };
                store != "optimisticItems" && store != "authorityItems"
            }),
            "authorization writes neither overlay nor source authority"
        );
    }
    assert_eq!(
        fixture.http.mutations(SOURCE_ORIGIN).len(),
        1,
        "no Missing Delete is sent during confirmation"
    );
    assert_eq!(fixture.http.mutations(TARGET_ORIGIN).len(), 1);
    assert!(sink.0.lock().unwrap().iter().all(|projection| matches!(projection,
        RuntimeProjection::Items(items) if items.items.iter().all(|item| item.status != crate::ItemProjectionStatus::Pending))));
    observation.close();

    // Reopen while work is still pending: absence of an overlay must not release source ownership.
    fixture.sqlite = MoveSqlite::open(&fixture.database.0);
    let plain = fixture.sqlite.clone();
    reopen_with(&mut fixture, plain).await;
    assert_eq!(
        durable_rows(&fixture.database.0, &fixture.source).await,
        authorized_rows
    );
    let reopened = fixture.runtime.require_snapshot(&fixture.source).unwrap();
    assert!(reopened.items.is_empty());
    assert!(reopened.item_has_optimistic_owner(SOURCE_ITEM));
    assert_eq!(
        resolution(&fixture.runtime, &fixture.source, SEMANTIC),
        OperationResolution::Pending
    );
    let RuntimeProjection::Items(items_reopened) = fixture
        .runtime
        .projection(&ObservationRequest::Items {
            account_id: fixture.source.clone(),
        })
        .unwrap()
        .projection
    else {
        panic!("expected Items");
    };
    assert_eq!(
        items_reopened.items,
        items_at_snapshot_scope(items_before.items.clone(), &reopened),
        "reopen keeps the exact trashed Item and renews only its guard scope"
    );
    fixture.http.delete_result.release.add_permits(4);
    for _ in 0..6 {
        if resolution(&fixture.runtime, &fixture.source, SEMANTIC) == OperationResolution::Applied {
            break;
        }
        let snapshot = fixture.runtime.require_snapshot(&fixture.source).unwrap();
        assert!(matches!(
            fixture
                .runtime
                .dispatch_cross_account_move(&snapshot, SEMANTIC)
                .await,
            DispatchPass::Progressed
        ));
    }
    assert_eq!(
        resolution(&fixture.runtime, &fixture.source, SEMANTIC),
        OperationResolution::Applied
    );
    let completed = workflow(
        &durable_rows(&fixture.database.0, &fixture.source).await,
        SEMANTIC,
    );
    assert_eq!(completed["legacyAdmission"], authorized["legacyAdmission"]);
    assert_eq!(completed["source"], authorized["source"]);
    assert_eq!(completed["target"], authorized["target"]);
    assert_eq!(completed["children"][0], authorized["children"][0]);
    assert_eq!(completed["children"][1], authorized["children"][1]);
    let source_requests = fixture.http.mutations(SOURCE_ORIGIN);
    assert_eq!(source_requests.len(), 2);
    assert_original_request(
        &source_requests[1],
        &legacy_request(&original, CrossAccountMoveStep::SourceDelete),
    );
    assert_eq!(fixture.http.mutations(TARGET_ORIGIN).len(), 1);
    assert!(fixture.http.source.server.created_items().is_empty());
    assert_eq!(
        fixture.http.target.server.created_items(),
        vec![TARGET_ITEM.to_owned()]
    );
    let completed_snapshot = fixture.runtime.require_snapshot(&fixture.source).unwrap();
    assert!(completed_snapshot.items.is_empty());
    assert!(!completed_snapshot.item_has_optimistic_owner(SOURCE_ITEM));
    assert!(!completed_snapshot
        .bootstrap
        .snapshot()
        .visible_items
        .iter()
        .any(|item| item.id == SOURCE_ITEM));
    fixture.runtime.close().await;
}
