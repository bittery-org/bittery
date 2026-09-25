//! First explicit83 authorization of an original stopped workflow.
use super::super::remote_progress_tests::{historical_effect, request as legacy_request};
use super::*;
use crate::replica::CrossAccountMoveStep;

fn assert_original_request(actual: &RecordedRequest, expected: &RecordedRequest) {
    assert_eq!(actual.method, expected.method);
    assert_eq!(actual.url, expected.url);
    assert_eq!(actual.body, expected.body);
    for (name, value) in expected
        .headers
        .iter()
        .filter(|(name, _)| !name.eq_ignore_ascii_case("Authorization"))
    {
        assert_eq!(actual.header(name), Some(value.as_str()));
    }
}

#[tokio::test]
async fn stopped_target_create_explicit_confirmation_restores_normal_original_workflow() {
    let (fixture, original) = admitted_legacy_move_with_history(
        json!({
            "status":"failed", "retryCount":"3", "nextAttemptAt":"0",
            "lastError":"departed owner stopped after target response loss"
        }),
        None,
    )
    .await;
    let target_request = legacy_request(&original, CrossAccountMoveStep::TargetCreate);
    let proof: Value =
        serde_json::from_slice(&historical_effect(&fixture, &target_request)).unwrap();
    assert_eq!(proof["operationId"], format!("{SEMANTIC}:create-target"));
    assert_eq!(proof["result"]["status"], "applied");
    assert_eq!(proof["result"]["version"], 1);
    assert_eq!(
        fixture.http.target.server.created_items(),
        vec![TARGET_ITEM.to_owned()]
    );
    let source_authority = fixture
        .runtime
        .require_snapshot(&fixture.source)
        .unwrap()
        .bootstrap;
    assert!(fixture
        .runtime
        .require_snapshot(&fixture.source)
        .unwrap()
        .items
        .is_empty());
    let _artifacts = super::super::super::retirement_tests::remove_target(&fixture).await;
    let retired_rows = durable_rows(&fixture.database.0, &fixture.source).await;
    let retired = workflow(&retired_rows, SEMANTIC);
    assert_eq!(retired["destinationBinding"]["status"], "retired");
    assert_eq!(retired["destinationBinding"]["bindingRevision"], "1");
    assert_eq!(retired["legacyAdmission"]["disposition"], "legacyFailed");
    assert_eq!(
        retired["children"],
        serde_json::to_value(&original.children).unwrap()
    );
    fixture.http.offline.store(false, Ordering::SeqCst);
    fixture.http.resumed.store(true, Ordering::SeqCst);
    let RuntimeResponse::SignedIn {
        account_id: replacement,
        ..
    } = fixture
        .runtime
        .request(
            sign_in_request_to(TARGET_ORIGIN, NORMALIZED_EMAIL),
            RequestCancellation::new(),
        )
        .await
        .unwrap()
    else {
        panic!("same-identity replacement Sign-in must succeed");
    };
    assert_ne!(replacement, fixture.target);
    let replacement_snapshot = fixture.runtime.require_snapshot(&replacement).unwrap();
    assert_eq!(
        replacement_snapshot.user_id,
        original.destination_identity.user_id
    );
    assert_eq!(
        workflow(
            &durable_rows(&fixture.database.0, &fixture.source).await,
            SEMANTIC
        ),
        retired
    );
    assert!(fixture
        .runtime
        .require_snapshot(&fixture.source)
        .unwrap()
        .items
        .is_empty());
    assert!(fixture.http.mutations(SOURCE_ORIGIN).is_empty());
    assert!(fixture.http.mutations(TARGET_ORIGIN).is_empty());

    let requests_before_prepare = fixture.http.requests.lock().unwrap().len();
    let response = fixture.runtime.request(
        RuntimeRequest::PrepareCrossAccountMoveResume {
            account_id: fixture.source.clone(), operation_id: SEMANTIC.into(),
            target_account_id: replacement.clone(), expected_binding_revision: 1,
        }, RequestCancellation::new(),
    ).await.expect("original target Applied proof and exact current writable scopes must prepare a stopped workflow");
    let RuntimeResponse::CrossAccountMoveResumePrepared { guard } = response else {
        panic!("expected Prepare confirmation guard");
    };
    assert_eq!(guard.account_id, fixture.source);
    assert_eq!(guard.target_account_id, replacement);
    assert_eq!(guard.binding_revision, 1);
    assert_eq!(
        durable_rows(&fixture.database.0, &fixture.source).await,
        retired_rows
    );
    assert_eq!(
        fixture.runtime.require_snapshot(&replacement).unwrap(),
        replacement_snapshot
    );
    assert!(fixture.http.mutations(SOURCE_ORIGIN).is_empty());
    assert!(fixture.http.mutations(TARGET_ORIGIN).is_empty());
    let target_lookup = format!("{TARGET_ORIGIN}/api/v1/operations/{SEMANTIC}:create-target");
    assert!(fixture
        .http
        .requests
        .lock()
        .unwrap()
        .iter()
        .skip(requests_before_prepare)
        .any(|request| request.method == "GET" && request.url == target_lookup));

    let requests_before_confirm = fixture.http.requests.lock().unwrap().len();
    let response = fixture
        .runtime
        .request(
            RuntimeRequest::ResumeCrossAccountMove { guard },
            RequestCancellation::new(),
        )
        .await
        .expect("explicit fresh confirmation must atomically authorize original held work");
    assert!(
        matches!(response, RuntimeResponse::Accepted { ref operation_id, .. } if operation_id == SEMANTIC)
    );
    let rebound_rows = durable_rows(&fixture.database.0, &fixture.source).await;
    let rebound = workflow(&rebound_rows, SEMANTIC);
    let mut expected = retired.clone();
    expected["destinationBinding"] = json!({
        "accountId":replacement, "incarnation":replacement_snapshot.incarnation,
        "bindingRevision":"2", "status":"active"
    });
    expected["legacyAdmission"]["disposition"] = json!({
        "destinationReauthorized":{"priorHold":"legacyFailed", "bindingRevision":"2"}
    });
    expected["disposition"] = json!({"type":"ready"});
    assert_eq!(rebound, expected, "binding and authorization change together; all source evidence, child results and scheduling remain exact");
    let rebound_snapshot = fixture.runtime.require_snapshot(&fixture.source).unwrap();
    assert_eq!(
        rebound_snapshot.items,
        vec![original.source_overlay(&fixture.source)]
    );
    assert_eq!(rebound_snapshot.bootstrap, source_authority);
    assert!(rebound_snapshot.operations.is_empty());
    assert_eq!(
        fixture.runtime.require_snapshot(&replacement).unwrap(),
        replacement_snapshot
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
    let confirmation_requests = fixture
        .http
        .requests
        .lock()
        .unwrap()
        .iter()
        .skip(requests_before_confirm)
        .cloned()
        .collect::<Vec<_>>();
    let lookup_position = confirmation_requests
        .iter()
        .position(|request| request.method == "GET" && request.url == target_lookup)
        .unwrap();
    let replay_position = confirmation_requests
        .iter()
        .position(|request| {
            request.header("Idempotency-Key") == Some(format!("{SEMANTIC}:create-target").as_str())
        })
        .unwrap();
    assert!(
        lookup_position < replay_position,
        "confirmation obtains its own fresh proof before exact replay"
    );
    let target_replays = fixture.http.mutations(TARGET_ORIGIN);
    assert_eq!(target_replays.len(), 1);
    assert_original_request(&target_replays[0], &target_request);
    assert!(
        fixture.http.mutations(SOURCE_ORIGIN).is_empty(),
        "confirmation cannot execute an undecided source request"
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
            crate::runtime::dispatch::DispatchPass::Progressed
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
    assert_eq!(completed["legacyAdmission"], rebound["legacyAdmission"]);
    assert_eq!(completed["source"], rebound["source"]);
    assert_eq!(completed["target"], rebound["target"]);
    assert_eq!(completed["children"].as_array().unwrap().len(), 3);
    assert!(completed["children"]
        .as_array()
        .unwrap()
        .iter()
        .all(|child| child["result"]["result"]["type"] == "applied"));
    let target_replays = fixture.http.mutations(TARGET_ORIGIN);
    assert_eq!(target_replays.len(), 2, "confirmation retains original child results, so normal dispatch proves the same target child again");
    for replay in &target_replays {
        assert_original_request(replay, &target_request);
    }
    let source_requests = fixture.http.mutations(SOURCE_ORIGIN);
    assert_eq!(source_requests.len(), 2);
    for (actual, step) in source_requests.iter().zip([
        CrossAccountMoveStep::SourceTrash,
        CrossAccountMoveStep::SourceDelete,
    ]) {
        assert_original_request(actual, &legacy_request(&original, step));
    }
    assert!(fixture.http.source.server.created_items().is_empty());
    assert_eq!(
        fixture.http.target.server.created_items(),
        vec![TARGET_ITEM.to_owned()]
    );
    assert_eq!(fixture.http.target.server.outcomes.lock().unwrap().len(), 1);
    assert_eq!(fixture.http.source.server.outcomes.lock().unwrap().len(), 2);
    assert!(fixture
        .runtime
        .require_snapshot(&fixture.source)
        .unwrap()
        .items
        .is_empty());
    fixture.runtime.close().await;
}

#[path = "cross_account_legacy_held_reauthorization_recovery_tests.rs"]
mod recovery_tests;

#[path = "cross_account_legacy_held_reauthorization_refusals_tests.rs"]
mod refusals_tests;

#[path = "cross_account_legacy_held_reauthorization_proof_tests.rs"]
mod proof_tests;

#[path = "cross_account_legacy_held_sourcetrash_reauthorization_tests.rs"]
mod sourcetrash_tests;

#[path = "cross_account_legacy_held_sourcedelete_reauthorization_tests.rs"]
mod sourcedelete_tests;

#[path = "cross_account_legacy_held_completion_tests.rs"]
mod completion_tests;

#[path = "cross_account_legacy_held_absent_target_tests.rs"]
mod absent_target_tests;
