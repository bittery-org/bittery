//! Explicit confirmation may authorize a future original Create while both target and outcome are absent.
use super::recovery_tests::{confirm, prepare, replace_target};
use super::*;
use crate::runtime::dispatch::DispatchPass;

#[path = "cross_account_legacy_held_absent_target_variants_tests.rs"]
mod variants_tests;

async fn empty_readded_target(
    status: &str,
) -> (AdmittedMoveFixture, CrossAccountMoveRecord, MoveDatabase) {
    let (mut fixture, original) = admitted_legacy_move_with_history(
        json!({"status":status,"retryCount":"3","nextAttemptAt":"0","lastError":"retained transport failure"}), None,
    ).await;
    assert!(fixture.http.target.server.created_items().is_empty());
    assert!(fixture
        .http
        .target
        .server
        .outcomes
        .lock()
        .unwrap()
        .is_empty());
    let artifacts = super::super::super::super::retirement_tests::remove_target(&fixture).await;
    replace_target(&mut fixture).await;
    (fixture, original, artifacts)
}

#[tokio::test]
async fn absent_target_and_missing_original_create_authorize_without_effect_until_normal_dispatch()
{
    for (status, prior_hold) in [
        ("failed", "legacyFailed"),
        ("conflicted", "legacyConflicted"),
    ] {
        let (fixture, original, _artifacts) = empty_readded_target(status).await;
        let source_before = fixture.runtime.require_snapshot(&fixture.source).unwrap();
        let target_before = fixture.runtime.require_snapshot(&fixture.target).unwrap();
        let source_rows = durable_rows(&fixture.database.0, &fixture.source).await;
        let target_rows = durable_rows(&fixture.database.0, &fixture.target).await;
        let retired = workflow(&source_rows, SEMANTIC);
        assert_eq!(retired["legacyAdmission"]["disposition"], prior_hold);
        assert_eq!(retired["destinationBinding"]["status"], "retired");
        assert_eq!(retired["destinationBinding"]["bindingRevision"], "1");
        assert_eq!(
            retired["children"],
            serde_json::to_value(&original.children).unwrap()
        );
        assert!(retired["children"][0]["result"].is_null());
        assert!(source_before.items.is_empty());
        assert_eq!(
            source_before
                .bootstrap
                .snapshot()
                .visible_items
                .iter()
                .find(|item| item.id == SOURCE_ITEM),
            Some(&original.source)
        );
        let calls = fixture.http.requests.lock().unwrap().len();
        // Behavioral RED: the previous held TargetCreate path parks on Missing original proof.
        let guard = prepare(&fixture, 1).await;
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
        let lookup_url = format!("{TARGET_ORIGIN}/api/v1/operations/{SEMANTIC}:create-target");
        assert!(fixture
            .http
            .requests
            .lock()
            .unwrap()
            .iter()
            .skip(calls)
            .any(|request| request.method == "GET" && request.url == lookup_url));
        assert!(fixture.http.mutations(SOURCE_ORIGIN).is_empty());
        assert!(fixture.http.mutations(TARGET_ORIGIN).is_empty());
        let calls = fixture.http.requests.lock().unwrap().len();
        confirm(&fixture, guard).await;
        assert!(fixture.http.mutations(SOURCE_ORIGIN).is_empty());
        assert!(fixture.http.mutations(TARGET_ORIGIN).is_empty());
        assert!(fixture.http.target.server.created_items().is_empty());
        assert!(fixture
            .http
            .target
            .server
            .outcomes
            .lock()
            .unwrap()
            .is_empty());
        {
            let requests = fixture.http.requests.lock().unwrap();
            let recent = &requests[calls..];
            let lookup = recent
                .iter()
                .position(|request| request.method == "GET" && request.url == lookup_url)
                .unwrap();
            for (origin, item_id) in [(SOURCE_ORIGIN, SOURCE_ITEM), (TARGET_ORIGIN, TARGET_ITEM)] {
                let url = format!("{origin}/api/v1/items/{item_id}");
                assert!(
                    recent
                        .iter()
                        .skip(lookup + 1)
                        .any(|request| request.method == "GET" && request.url == url),
                    "confirmation rereads both current Items even without replay"
                );
            }
        }
        let authorized = workflow(
            &durable_rows(&fixture.database.0, &fixture.source).await,
            SEMANTIC,
        );
        let mut expected = retired;
        expected["destinationBinding"] = json!({"accountId":fixture.target,"incarnation":target_before.incarnation,"bindingRevision":"2","status":"active"});
        expected["legacyAdmission"]["disposition"] =
            json!({"destinationReauthorized":{"priorHold":prior_hold,"bindingRevision":"2"}});
        expected["disposition"] = json!({"type":"ready"});
        assert_eq!(authorized, expected, "only authorization, binding and disposition change; original requests, results, DTO/history and schedule remain exact");
        let after = fixture.runtime.require_snapshot(&fixture.source).unwrap();
        assert_eq!(after.revision, source_before.revision + 1);
        assert_eq!(after.bootstrap, source_before.bootstrap);
        assert_eq!(after.items, vec![original.source_overlay(&fixture.source)]);
        assert!(after.operations.is_empty());
        assert_eq!(
            fixture.runtime.require_snapshot(&fixture.target).unwrap(),
            target_before
        );
        assert_eq!(
            durable_rows(&fixture.database.0, &fixture.target).await,
            target_rows
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
            if resolution(&fixture.runtime, &fixture.source, SEMANTIC)
                == OperationResolution::Applied
            {
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
        assert_eq!(completed["children"].as_array().unwrap().len(), 3);
        let target_requests = fixture.http.mutations(TARGET_ORIGIN);
        assert_eq!(
            target_requests.len(),
            1,
            "the original Create is sent once, only by normal dispatch"
        );
        assert_original_request(
            &target_requests[0],
            &legacy_request(&original, CrossAccountMoveStep::TargetCreate),
        );
        let source_requests = fixture.http.mutations(SOURCE_ORIGIN);
        assert_eq!(source_requests.len(), 2);
        for (actual, step) in source_requests.iter().zip([
            CrossAccountMoveStep::SourceTrash,
            CrossAccountMoveStep::SourceDelete,
        ]) {
            assert_original_request(actual, &legacy_request(&original, step));
        }
        assert_eq!(fixture.http.target.server.outcomes.lock().unwrap().len(), 1);
        assert_eq!(fixture.http.source.server.outcomes.lock().unwrap().len(), 2);
        assert_eq!(
            fixture.http.target.server.created_items(),
            vec![TARGET_ITEM.to_owned()]
        );
        assert!(fixture.http.source.server.created_items().is_empty());
        assert!(fixture
            .runtime
            .require_snapshot(&fixture.source)
            .unwrap()
            .items
            .is_empty());
        fixture.runtime.close().await;
    }
}
