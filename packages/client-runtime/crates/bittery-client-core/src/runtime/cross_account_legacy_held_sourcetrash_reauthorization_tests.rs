//! A stopped proved target may explicitly authorize its still-undecided original Trash.
use super::recovery_tests::{confirm, prepare, replace_target};
use super::*;
use crate::replica::CrossAccountMoveStage;
use crate::runtime::dispatch::DispatchPass;

#[path = "cross_account_legacy_held_sourcetrash_reauthorization_variants_tests.rs"]
mod variants_tests;

#[tokio::test]
async fn stopped_source_trash_missing_child_authorizes_without_sending_it_until_normal_dispatch() {
    let (mut fixture, original) = admitted_legacy_move_with_history(
        json!({"status":"failed", "retryCount":"3", "nextAttemptAt":"0",
            "lastError":"departed target reply loss", "projectionClaimId":"departed-owner",
            "projectionClaimExpiresAt":"17"}),
        None,
    )
    .await;
    let target_request = legacy_request(&original, CrossAccountMoveStep::TargetCreate);
    let outcome: Value =
        serde_json::from_slice(&historical_effect(&fixture, &target_request)).unwrap();
    assert_eq!(outcome["result"]["status"], "applied");
    fixture.http.offline.store(false, Ordering::SeqCst);
    fixture.http.resumed.store(true, Ordering::SeqCst);
    let mut parked = false;
    for _ in 0..6 {
        let snapshot = fixture.runtime.require_snapshot(&fixture.source).unwrap();
        if matches!(
            fixture
                .runtime
                .dispatch_cross_account_move(&snapshot, SEMANTIC)
                .await,
            DispatchPass::Parked
        ) {
            parked = true;
            break;
        }
    }
    assert!(
        parked,
        "held recovery must stop at the Missing original Trash outcome"
    );
    let recovered = fixture.runtime.require_snapshot(&fixture.source).unwrap();
    let held = recovered.cross_account_moves[0].captured().unwrap();
    assert_eq!(held.stage, CrossAccountMoveStage::SourceTrash);
    assert_eq!(held.children.len(), 2);
    assert!(held.children[0].item().unwrap().result.is_some());
    assert!(held.children[1].item().unwrap().result.is_none());
    assert_eq!(held.legacy_admission, original.legacy_admission);
    assert!(recovered.items.is_empty());
    assert!(fixture.http.mutations(SOURCE_ORIGIN).is_empty());
    let target_replays = fixture.http.mutations(TARGET_ORIGIN);
    assert_eq!(target_replays.len(), 1);
    assert_original_request(&target_replays[0], &target_request);
    let trash_lookup = format!("{SOURCE_ORIGIN}/api/v1/operations/{SEMANTIC}:trash-source");
    assert!(fixture
        .http
        .requests
        .lock()
        .unwrap()
        .iter()
        .any(|request| request.method == "GET" && request.url == trash_lookup));

    let _artifacts = super::super::super::super::retirement_tests::remove_target(&fixture).await;
    replace_target(&mut fixture).await;
    let retired_rows = durable_rows(&fixture.database.0, &fixture.source).await;
    let retired = workflow(&retired_rows, SEMANTIC);
    assert_eq!(retired["destinationBinding"]["bindingRevision"], "1");
    assert_eq!(retired["destinationBinding"]["status"], "retired");
    assert_eq!(retired["legacyAdmission"]["disposition"], "legacyFailed");
    assert_eq!(
        retired["children"],
        serde_json::to_value(&held.children).unwrap()
    );
    let target_before = fixture.runtime.require_snapshot(&fixture.target).unwrap();
    let target_rows_before = durable_rows(&fixture.database.0, &fixture.target).await;
    let requests_before_prepare = fixture.http.requests.lock().unwrap().len();
    // Behavioral RED on the first authorization implementation: SourceTrash is refused as unsupported.
    let guard = prepare(&fixture, 1).await;
    assert_eq!(
        durable_rows(&fixture.database.0, &fixture.source).await,
        retired_rows
    );
    assert!(fixture
        .http
        .requests
        .lock()
        .unwrap()
        .iter()
        .skip(requests_before_prepare)
        .any(|request| request.method == "GET" && request.url == trash_lookup));
    assert!(fixture.http.mutations(SOURCE_ORIGIN).is_empty());
    let requests_before_confirm = fixture.http.requests.lock().unwrap().len();
    confirm(&fixture, guard).await;
    assert!(fixture
        .http
        .requests
        .lock()
        .unwrap()
        .iter()
        .skip(requests_before_confirm)
        .any(|request| request.method == "GET" && request.url == trash_lookup));
    assert!(
        fixture.http.mutations(SOURCE_ORIGIN).is_empty(),
        "confirmation cannot execute the undecided Trash"
    );
    assert_eq!(
        fixture.http.mutations(TARGET_ORIGIN).len(),
        1,
        "the durable target proof needs no new target effect"
    );
    let authorized_rows = durable_rows(&fixture.database.0, &fixture.source).await;
    let authorized = workflow(&authorized_rows, SEMANTIC);
    let mut expected = retired.clone();
    expected["destinationBinding"] = json!({"accountId":fixture.target,
        "incarnation":target_before.incarnation, "bindingRevision":"2", "status":"active"});
    expected["legacyAdmission"]["disposition"] = json!({"destinationReauthorized":{
        "priorHold":"legacyFailed", "bindingRevision":"2"}});
    expected["disposition"] = json!({"type":"ready"});
    assert_eq!(authorized, expected, "authorization preserves the proved prefix, undecided Trash bytes, original history and scheduling");
    let snapshot = fixture.runtime.require_snapshot(&fixture.source).unwrap();
    assert_eq!(
        snapshot.items,
        vec![original.source_overlay(&fixture.source)]
    );
    assert_eq!(snapshot.bootstrap, recovered.bootstrap);
    assert!(snapshot.operations.is_empty());
    assert_eq!(
        fixture.runtime.require_snapshot(&fixture.target).unwrap(),
        target_before
    );
    assert_eq!(
        durable_rows(&fixture.database.0, &fixture.target).await,
        target_rows_before
    );
    assert_eq!(
        resolution(&fixture.runtime, &fixture.source, SEMANTIC),
        OperationResolution::Pending
    );
    assert_source_visible(
        &fixture.runtime,
        &fixture.source,
        crate::ItemProjectionStatus::Pending,
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
    assert!(completed["children"]
        .as_array()
        .unwrap()
        .iter()
        .all(|child| child["result"]["result"]["type"] == "applied"));
    let requests = fixture.http.mutations(SOURCE_ORIGIN);
    assert_eq!(requests.len(), 2);
    for (actual, step) in requests.iter().zip([
        CrossAccountMoveStep::SourceTrash,
        CrossAccountMoveStep::SourceDelete,
    ]) {
        assert_original_request(actual, &legacy_request(&original, step));
    }
    assert_eq!(fixture.http.mutations(TARGET_ORIGIN).len(), 1);
    assert_eq!(fixture.http.target.server.outcomes.lock().unwrap().len(), 1);
    assert_eq!(fixture.http.source.server.outcomes.lock().unwrap().len(), 2);
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
