//! Overlay-free ownership survives lifecycle changes, while Sync invalidates stale authorization.
use super::super::super::super::recovery_tests::replace_target;
use super::*;

fn assert_trashed_owned(fixture: &AdmittedMoveFixture) {
    let snapshot = fixture.runtime.require_snapshot(&fixture.source).unwrap();
    assert!(snapshot.items.is_empty());
    assert!(snapshot.item_has_optimistic_owner(SOURCE_ITEM));
    let RuntimeProjection::Items(items) = fixture
        .runtime
        .projection(&ObservationRequest::Items {
            account_id: fixture.source.clone(),
        })
        .unwrap()
        .projection
    else {
        panic!("expected Items");
    };
    let item = items
        .items
        .iter()
        .find(|item| item.item_id == SOURCE_ITEM)
        .unwrap();
    assert!(item.deleted_at.is_some());
    assert_eq!(item.status, crate::ItemProjectionStatus::Authoritative);
    assert_eq!(
        resolution(&fixture.runtime, &fixture.source, SEMANTIC),
        OperationResolution::Pending
    );
}

async fn assert_favorite_refused(fixture: &AdmittedMoveFixture, original: &CrossAccountMoveRecord) {
    let snapshot = fixture.runtime.require_snapshot(&fixture.source).unwrap();
    let rows = durable_rows(&fixture.database.0, &fixture.source).await;
    assert!(snapshot.item_has_optimistic_owner(SOURCE_ITEM));
    assert!(snapshot.items.is_empty());
    let calls = fixture.http.requests.lock().unwrap().len();
    let error = fixture
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
        .expect_err("the authorized workflow reserves its source without an Item overlay");
    assert_eq!(error.code, RuntimeErrorCode::InvariantViolation);
    assert!(
        error
            .message
            .contains("another active Operation already owns this Item"),
        "refusal must be the guarded domain ownership fence: {error:?}"
    );
    assert_eq!(fixture.http.requests.lock().unwrap().len(), calls);
    assert_eq!(
        fixture.runtime.require_snapshot(&fixture.source).unwrap(),
        snapshot
    );
    assert_eq!(
        durable_rows(&fixture.database.0, &fixture.source).await,
        rows
    );
}

async fn finish_original_delete(fixture: &AdmittedMoveFixture, original: &CrossAccountMoveRecord) {
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
    let source_requests = fixture.http.mutations(SOURCE_ORIGIN);
    assert_eq!(source_requests.len(), 2);
    assert_original_request(
        &source_requests[0],
        &legacy_request(original, CrossAccountMoveStep::SourceTrash),
    );
    assert_original_request(
        &source_requests[1],
        &legacy_request(original, CrossAccountMoveStep::SourceDelete),
    );
    assert_eq!(fixture.http.mutations(TARGET_ORIGIN).len(), 1);
    assert!(fixture.http.source.server.created_items().is_empty());
    assert_eq!(
        fixture.http.target.server.created_items(),
        vec![TARGET_ITEM.to_owned()]
    );
    let final_snapshot = fixture.runtime.require_snapshot(&fixture.source).unwrap();
    assert!(final_snapshot.items.is_empty());
    assert!(!final_snapshot.item_has_optimistic_owner(SOURCE_ITEM));
    assert!(!final_snapshot
        .bootstrap
        .snapshot()
        .visible_items
        .iter()
        .any(|item| item.id == SOURCE_ITEM));
}

#[tokio::test]
async fn conflicted_unmaterialized_delete_reauthorization_keeps_overlay_absent_through_second_retirement(
) {
    let (mut fixture, original, _first_artifacts) =
        readded_source_delete("conflicted", false).await;
    sync_trashed_source(&fixture, &original).await;
    let before = fixture.runtime.require_snapshot(&fixture.source).unwrap();
    assert_eq!(
        before.cross_account_moves[0]
            .captured()
            .unwrap()
            .children
            .len(),
        2
    );
    let guard = prepare(&fixture, 1).await;
    confirm(&fixture, guard).await;
    assert_trashed_owned(&fixture);
    let first_rows = durable_rows(&fixture.database.0, &fixture.source).await;
    let authorized = workflow(&first_rows, SEMANTIC);
    let mut expected =
        serde_json::to_value(before.cross_account_moves[0].captured().unwrap()).unwrap();
    expected["destinationBinding"] = json!({"accountId":fixture.target,"incarnation":fixture.runtime.require_snapshot(&fixture.target).unwrap().incarnation,"bindingRevision":"2","status":"active"});
    expected["legacyAdmission"]["disposition"] =
        json!({"destinationReauthorized":{"priorHold":"legacyConflicted","bindingRevision":"2"}});
    expected["disposition"] = json!({"type":"ready"});
    assert_eq!(authorized, expected);
    assert_eq!(
        fixture
            .runtime
            .require_snapshot(&fixture.source)
            .unwrap()
            .bootstrap,
        before.bootstrap
    );
    assert_favorite_refused(&fixture, &original).await;
    let _second_artifacts =
        super::super::super::super::super::super::super::retirement_tests::remove_target(&fixture)
            .await;
    let retired_rows = durable_rows(&fixture.database.0, &fixture.source).await;
    let retired = workflow(&retired_rows, SEMANTIC);
    let mut expected_retired = authorized.clone();
    expected_retired["destinationBinding"]["status"] = json!("retired");
    expected_retired["destinationBinding"]["bindingRevision"] = json!("3");
    expected_retired["disposition"] = json!({"type":"blocked","reason":"destinationRetired"});
    assert_eq!(retired, expected_retired);
    assert_trashed_owned(&fixture);
    assert_favorite_refused(&fixture, &original).await;
    let calls = fixture.http.requests.lock().unwrap().len();
    let retired_snapshot = fixture.runtime.require_snapshot(&fixture.source).unwrap();
    assert!(matches!(
        fixture
            .runtime
            .dispatch_cross_account_move(&retired_snapshot, SEMANTIC)
            .await,
        DispatchPass::Parked
    ));
    assert_eq!(fixture.http.requests.lock().unwrap().len(), calls);
    replace_target(&mut fixture).await;
    assert_eq!(
        workflow(
            &durable_rows(&fixture.database.0, &fixture.source).await,
            SEMANTIC
        ),
        retired
    );
    let guard = prepare(&fixture, 3).await;
    confirm(&fixture, guard).await;
    assert_trashed_owned(&fixture);
    let rebound = workflow(
        &durable_rows(&fixture.database.0, &fixture.source).await,
        SEMANTIC,
    );
    let mut expected = retired;
    expected["destinationBinding"] = json!({"accountId":fixture.target,"incarnation":fixture.runtime.require_snapshot(&fixture.target).unwrap().incarnation,"bindingRevision":"4","status":"active"});
    expected["legacyAdmission"]["disposition"] =
        json!({"destinationReauthorized":{"priorHold":"legacyConflicted","bindingRevision":"4"}});
    expected["disposition"] = json!({"type":"ready"});
    assert_eq!(rebound, expected);
    assert_eq!(rebound["children"].as_array().unwrap().len(), 2);
    let delete_lookup = format!("{SOURCE_ORIGIN}/api/v1/operations/{SEMANTIC}:delete-source");
    assert!(
        !fixture
            .http
            .requests
            .lock()
            .unwrap()
            .iter()
            .any(|request| request.url == delete_lookup),
        "neither confirmation materializes or probes the absent Delete child"
    );
    assert_eq!(fixture.http.mutations(SOURCE_ORIGIN).len(), 1);
    assert_eq!(fixture.http.mutations(TARGET_ORIGIN).len(), 1);
    assert_favorite_refused(&fixture, &original).await;
    finish_original_delete(&fixture, &original).await;
    let completed = workflow(
        &durable_rows(&fixture.database.0, &fixture.source).await,
        SEMANTIC,
    );
    assert_eq!(completed["legacyAdmission"], rebound["legacyAdmission"]);
    assert_eq!(completed["source"], rebound["source"]);
    assert_eq!(completed["children"][0], rebound["children"][0]);
    assert_eq!(completed["children"][1], rebound["children"][1]);
    fixture.runtime.close().await;
}

#[tokio::test]
async fn actual_trash_sync_between_prepare_and_confirm_requires_a_new_overlay_free_authorization_guard(
) {
    let (fixture, original, _artifacts) = readded_source_delete("failed", true).await;
    let old_guard = prepare(&fixture, 1).await;
    let before_sync = fixture.runtime.require_snapshot(&fixture.source).unwrap();
    assert!(before_sync
        .bootstrap
        .snapshot()
        .visible_items
        .iter()
        .any(|item| item.id == SOURCE_ITEM && item.deleted_at.is_none()));
    sync_trashed_source(&fixture, &original).await;
    let source = fixture.runtime.require_snapshot(&fixture.source).unwrap();
    let target = fixture.runtime.require_snapshot(&fixture.target).unwrap();
    assert!(source.revision > before_sync.revision);
    assert_eq!(source.cross_account_moves, before_sync.cross_account_moves);
    let rows = durable_rows(&fixture.database.0, &fixture.source).await;
    let target_rows = durable_rows(&fixture.database.0, &fixture.target).await;
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
        source
    );
    assert_eq!(
        fixture.runtime.require_snapshot(&fixture.target).unwrap(),
        target
    );
    assert_eq!(
        durable_rows(&fixture.database.0, &fixture.source).await,
        rows
    );
    assert_eq!(
        durable_rows(&fixture.database.0, &fixture.target).await,
        target_rows
    );
    assert!(source.items.is_empty());
    assert!(source.cross_account_moves[0]
        .captured()
        .unwrap()
        .is_legacy_held());
    assert!(!source.item_has_optimistic_owner(SOURCE_ITEM));
    assert_eq!(fixture.http.mutations(SOURCE_ORIGIN).len(), 1);
    assert_eq!(fixture.http.mutations(TARGET_ORIGIN).len(), 1);
    let fresh = prepare(&fixture, 1).await;
    confirm(&fixture, fresh).await;
    assert_trashed_owned(&fixture);
    let after = fixture.runtime.require_snapshot(&fixture.source).unwrap();
    assert_eq!(after.revision, source.revision + 1);
    assert_eq!(after.bootstrap, source.bootstrap);
    assert_eq!(
        after.cross_account_moves[0].captured().unwrap().children,
        source.cross_account_moves[0].captured().unwrap().children
    );
    assert_eq!(
        after.cross_account_moves[0].captured().unwrap().source,
        original.source
    );
    assert_eq!(fixture.http.mutations(SOURCE_ORIGIN).len(), 1);
    finish_original_delete(&fixture, &original).await;
    fixture.runtime.close().await;
}
