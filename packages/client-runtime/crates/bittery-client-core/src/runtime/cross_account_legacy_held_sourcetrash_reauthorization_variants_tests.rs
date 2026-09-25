//! SourceTrash activation preserves future work and refuses evidence of a prior source effect.
use super::*;
use crate::protocol::CrossAccountMoveResumeGuard;

async fn readded_source_trash(
    status: &str,
    materialized: bool,
) -> (AdmittedMoveFixture, CrossAccountMoveRecord, MoveDatabase) {
    let (mut fixture, original) = admitted_legacy_move_with_history(
        json!({"status":status,"retryCount":"2","nextAttemptAt":"0","lastError":"retained stop"}),
        None,
    )
    .await;
    let proof: Value = serde_json::from_slice(&historical_effect(
        &fixture,
        &legacy_request(&original, CrossAccountMoveStep::TargetCreate),
    ))
    .unwrap();
    assert_eq!(proof["result"]["status"], "applied");
    fixture.http.offline.store(false, Ordering::SeqCst);
    fixture.http.resumed.store(true, Ordering::SeqCst);
    let mut reached = false;
    for _ in 0..6 {
        let snapshot = fixture.runtime.require_snapshot(&fixture.source).unwrap();
        let pass = fixture
            .runtime
            .dispatch_cross_account_move(&snapshot, SEMANTIC)
            .await;
        let after = fixture.runtime.require_snapshot(&fixture.source).unwrap();
        let record = after.cross_account_moves[0].captured().unwrap();
        if record.stage == CrossAccountMoveStage::SourceTrash
            && ((!materialized && record.children.len() == 1)
                || (materialized && matches!(pass, DispatchPass::Parked)))
        {
            reached = true;
            break;
        }
    }
    assert!(
        reached,
        "actual held target proof recovery must reach the requested SourceTrash child shape"
    );
    let snapshot = fixture.runtime.require_snapshot(&fixture.source).unwrap();
    let held = snapshot.cross_account_moves[0].captured().unwrap();
    assert_eq!(held.children.len(), if materialized { 2 } else { 1 });
    assert!(held.children[0].item().unwrap().result.is_some());
    if materialized {
        assert!(held.children[1].item().unwrap().result.is_none());
    }
    assert_eq!(held.legacy_admission, original.legacy_admission);
    assert!(snapshot.items.is_empty());
    assert!(fixture.http.mutations(SOURCE_ORIGIN).is_empty());
    assert_eq!(fixture.http.mutations(TARGET_ORIGIN).len(), 1);
    let artifacts =
        super::super::super::super::super::retirement_tests::remove_target(&fixture).await;
    replace_target(&mut fixture).await;
    (fixture, original, artifacts)
}

fn prepare_request(fixture: &AdmittedMoveFixture) -> RuntimeRequest {
    RuntimeRequest::PrepareCrossAccountMoveResume {
        account_id: fixture.source.clone(),
        operation_id: SEMANTIC.into(),
        target_account_id: fixture.target.clone(),
        expected_binding_revision: 1,
    }
}

fn current_guard(fixture: &AdmittedMoveFixture) -> CrossAccountMoveResumeGuard {
    let source = fixture.runtime.require_snapshot(&fixture.source).unwrap();
    let target = fixture.runtime.require_snapshot(&fixture.target).unwrap();
    CrossAccountMoveResumeGuard {
        account_id: fixture.source.clone(),
        source_incarnation: source.incarnation,
        source_lock_epoch: source.lock_epoch,
        target_account_id: fixture.target.clone(),
        target_incarnation: target.incarnation,
        target_lock_epoch: target.lock_epoch,
        operation_id: SEMANTIC.into(),
        binding_revision: 1,
        source_replica_revision: source.revision,
        owner_incarnation: fixture.runtime.native_authority.owner_incarnation().into(),
    }
}

async fn refuse_without_mutation(fixture: &AdmittedMoveFixture, request: RuntimeRequest) {
    let source = fixture.runtime.require_snapshot(&fixture.source).unwrap();
    let target = fixture.runtime.require_snapshot(&fixture.target).unwrap();
    let source_rows = durable_rows(&fixture.database.0, &fixture.source).await;
    let target_rows = durable_rows(&fixture.database.0, &fixture.target).await;
    let calls = fixture.http.requests.lock().unwrap().len();
    let writes = fixture.http.mutations(TARGET_ORIGIN);
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
    assert_eq!(fixture.http.mutations(TARGET_ORIGIN).len(), writes.len());
    assert!(fixture.http.mutations(SOURCE_ORIGIN).is_empty());
    let requests = fixture.http.requests.lock().unwrap();
    let recent = &requests[calls..];
    assert!(recent.iter().all(|request| request.method != "PUT"));
    let lookups = recent
        .iter()
        .filter(|request| request.url.contains("/operations/"))
        .map(|request| (request.method.as_str(), request.url.as_str()))
        .collect::<Vec<_>>();
    let trash_lookup = format!("{SOURCE_ORIGIN}/api/v1/operations/{SEMANTIC}:trash-source");
    assert_eq!(lookups, vec![("GET", trash_lookup.as_str())]);
    assert!(source.items.is_empty());
    let held = workflow(&source_rows, SEMANTIC);
    assert!(held["legacyAdmission"]["disposition"].is_string());
    assert_eq!(held["destinationBinding"]["status"], "retired");
    assert_eq!(held["destinationBinding"]["bindingRevision"], "1");
    assert!(held["children"][1]["result"].is_null());
}

#[tokio::test]
async fn conflicted_source_trash_authorization_keeps_future_child_unmaterialized_until_dispatch() {
    let (fixture, original, _artifacts) = readded_source_trash("conflicted", false).await;
    let retired_rows = durable_rows(&fixture.database.0, &fixture.source).await;
    let retired = workflow(&retired_rows, SEMANTIC);
    assert_eq!(retired["children"].as_array().unwrap().len(), 1);
    let guard = prepare(&fixture, 1).await;
    assert_eq!(
        durable_rows(&fixture.database.0, &fixture.source).await,
        retired_rows
    );
    confirm(&fixture, guard).await;
    let authorized = workflow(
        &durable_rows(&fixture.database.0, &fixture.source).await,
        SEMANTIC,
    );
    let target = fixture.runtime.require_snapshot(&fixture.target).unwrap();
    let mut expected = retired;
    expected["destinationBinding"] = json!({"accountId":fixture.target,"incarnation":target.incarnation,"bindingRevision":"2","status":"active"});
    expected["legacyAdmission"]["disposition"] =
        json!({"destinationReauthorized":{"priorHold":"legacyConflicted","bindingRevision":"2"}});
    expected["disposition"] = json!({"type":"ready"});
    assert_eq!(authorized, expected);
    assert_eq!(
        fixture
            .runtime
            .require_snapshot(&fixture.source)
            .unwrap()
            .items,
        vec![original.source_overlay(&fixture.source)]
    );
    assert_source_visible(
        &fixture.runtime,
        &fixture.source,
        crate::ItemProjectionStatus::Pending,
    );
    assert!(fixture.http.mutations(SOURCE_ORIGIN).is_empty());
    assert_eq!(fixture.http.mutations(TARGET_ORIGIN).len(), 1);
    let trash_lookup = format!("{SOURCE_ORIGIN}/api/v1/operations/{SEMANTIC}:trash-source");
    assert!(
        !fixture
            .http
            .requests
            .lock()
            .unwrap()
            .iter()
            .any(|request| request.url == trash_lookup),
        "an unmaterialized child stays absent through confirmation"
    );
    fixture.http.trash_result.release.add_permits(4);
    fixture.http.delete_result.release.add_permits(4);
    for _ in 0..10 {
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
    assert_eq!(completed["children"].as_array().unwrap().len(), 3);
    let requests = fixture.http.mutations(SOURCE_ORIGIN);
    assert_eq!(requests.len(), 2);
    for (actual, step) in requests.iter().zip([
        CrossAccountMoveStep::SourceTrash,
        CrossAccountMoveStep::SourceDelete,
    ]) {
        assert_original_request(actual, &legacy_request(&original, step));
    }
    assert_eq!(fixture.http.mutations(TARGET_ORIGIN).len(), 1);
    assert!(fixture.http.source.server.created_items().is_empty());
    assert_eq!(
        fixture.http.target.server.created_items(),
        vec![TARGET_ITEM.to_owned()]
    );
    assert!(fixture
        .runtime
        .require_snapshot(&fixture.source)
        .unwrap()
        .items
        .is_empty());
    fixture.runtime.close().await;
}

#[tokio::test]
async fn source_trash_genuine_rejection_refuses_prepare_and_current_confirmation_without_authorizing(
) {
    let (fixture, original, _artifacts) = readded_source_trash("conflicted", true).await;
    fixture.http.source.server.reject_next("vault_read_only");
    let rejected: Value = serde_json::from_slice(&historical_effect(
        &fixture,
        &legacy_request(&original, CrossAccountMoveStep::SourceTrash),
    ))
    .unwrap();
    assert_eq!(rejected["operationId"], format!("{SEMANTIC}:trash-source"));
    assert_eq!(
        rejected["result"],
        json!({"status":"rejected","code":"vault_read_only"})
    );
    assert!(fixture.http.source.server.created_items.lock().unwrap()[0]
        .deleted_at
        .is_none());
    let guard = current_guard(&fixture);
    refuse_without_mutation(&fixture, prepare_request(&fixture)).await;
    refuse_without_mutation(&fixture, RuntimeRequest::ResumeCrossAccountMove { guard }).await;
    assert_eq!(fixture.http.source.server.outcomes.lock().unwrap().len(), 1);
    assert!(fixture.http.source.server.created_items.lock().unwrap()[0]
        .deleted_at
        .is_none());
    fixture.runtime.close().await;
}

#[tokio::test]
async fn remotely_applied_trash_after_prepare_cannot_authorize_a_still_live_cached_original_hold() {
    let (fixture, original, _artifacts) = readded_source_trash("failed", true).await;
    let guard = prepare(&fixture, 1).await;
    let live_cached = fixture.runtime.require_snapshot(&fixture.source).unwrap();
    assert!(live_cached
        .bootstrap
        .snapshot()
        .visible_items
        .iter()
        .any(|item| item.id == SOURCE_ITEM && item.deleted_at.is_none()));
    let applied: Value = serde_json::from_slice(&historical_effect(
        &fixture,
        &legacy_request(&original, CrossAccountMoveStep::SourceTrash),
    ))
    .unwrap();
    assert_eq!(applied["operationId"], format!("{SEMANTIC}:trash-source"));
    assert_eq!(applied["result"]["status"], "applied");
    assert!(fixture.http.source.server.created_items.lock().unwrap()[0]
        .deleted_at
        .is_some());
    assert_eq!(
        fixture.runtime.require_snapshot(&fixture.source).unwrap(),
        live_cached
    );
    refuse_without_mutation(&fixture, prepare_request(&fixture)).await;
    refuse_without_mutation(&fixture, RuntimeRequest::ResumeCrossAccountMove { guard }).await;
    assert_eq!(fixture.http.source.server.outcomes.lock().unwrap().len(), 1);
    assert!(fixture.http.source.server.created_items.lock().unwrap()[0]
        .deleted_at
        .is_some());
    fixture.runtime.close().await;
}
