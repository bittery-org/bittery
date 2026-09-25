//! Original retained proof is mandatory for an original hold's first authorization.
use super::recovery_tests::{prepare, readded_held_target, replace_target};
use super::*;
use crate::protocol::CrossAccountMoveResumeGuard;

fn original_guard(fixture: &AdmittedMoveFixture) -> CrossAccountMoveResumeGuard {
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

async fn assert_proof_refusal(fixture: &AdmittedMoveFixture, request: RuntimeRequest) {
    let source_before = fixture.runtime.require_snapshot(&fixture.source).unwrap();
    let target_before = fixture.runtime.require_snapshot(&fixture.target).unwrap();
    let source_rows = durable_rows(&fixture.database.0, &fixture.source).await;
    let target_rows = durable_rows(&fixture.database.0, &fixture.target).await;
    let requests_before = fixture.http.requests.lock().unwrap().len();
    let result = fixture
        .runtime
        .request(request, RequestCancellation::new())
        .await;
    assert_eq!(result.unwrap_err().code, RuntimeErrorCode::AccessDenied);
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
    let operation_lookups = fixture
        .http
        .requests
        .lock()
        .unwrap()
        .iter()
        .skip(requests_before)
        .filter(|request| request.url.contains("/operations/"))
        .map(|request| (request.method.clone(), request.url.clone()))
        .collect::<Vec<_>>();
    assert_eq!(
        operation_lookups,
        vec![(
            "GET".into(),
            format!("{TARGET_ORIGIN}/api/v1/operations/{SEMANTIC}:create-target")
        )]
    );
    assert!(
        fixture.http.mutations(TARGET_ORIGIN).is_empty(),
        "proof refusal must precede exact target replay"
    );
    assert!(fixture.http.mutations(SOURCE_ORIGIN).is_empty());
    assert!(source_before.items.is_empty());
    assert!(source_before.operations.is_empty());
    let retained = workflow(&source_rows, SEMANTIC);
    assert_eq!(retained["destinationBinding"]["status"], "retired");
    assert_eq!(retained["destinationBinding"]["bindingRevision"], "1");
    assert!(retained["legacyAdmission"]["disposition"].is_string());
    assert_eq!(retained["children"].as_array().unwrap().len(), 1);
    assert!(retained["children"][0]["result"].is_null());
}

fn prepare_request(fixture: &AdmittedMoveFixture) -> RuntimeRequest {
    RuntimeRequest::PrepareCrossAccountMoveResume {
        account_id: fixture.source.clone(),
        operation_id: SEMANTIC.into(),
        target_account_id: fixture.target.clone(),
        expected_binding_revision: 1,
    }
}

#[tokio::test]
async fn original_hold_prepare_and_confirmation_reject_wrong_version_hint_before_replay() {
    let (fixture, original, _artifacts) = readded_held_target("failed").await;
    let guard = prepare(&fixture, 1).await;
    let operation_id = format!("{SEMANTIC}:create-target");
    let original_outcome = {
        let ledger = fixture.http.target.server.outcomes.lock().unwrap();
        assert_eq!(ledger.len(), 1);
        crate::runtime::operation_fixtures::outcome_body(
            &operation_id,
            &ledger[&operation_id].result,
        )
    };
    let mut wrong: Value = serde_json::from_slice(&original_outcome).unwrap();
    assert_eq!(wrong["result"]["status"], "applied");
    assert_eq!(wrong["result"]["version"], 1);
    wrong["result"]["version"] = json!(2);
    for request in [
        prepare_request(&fixture),
        RuntimeRequest::ResumeCrossAccountMove { guard },
    ] {
        // Only the delivered GET response is corrupted; the genuine ledger and exact target stay unchanged.
        fixture
            .http
            .target
            .server
            .lookup_response_overrides
            .lock()
            .unwrap()
            .push_back(serde_json::to_vec(&wrong).unwrap());
        assert_proof_refusal(&fixture, request).await;
        let ledger = fixture.http.target.server.outcomes.lock().unwrap();
        assert_eq!(ledger.len(), 1);
        assert_eq!(
            crate::runtime::operation_fixtures::outcome_body(
                &operation_id,
                &ledger[&operation_id].result
            ),
            original_outcome
        );
    }
    assert_eq!(
        fixture.http.target.server.created_items(),
        vec![TARGET_ITEM.to_owned()]
    );
    assert_eq!(
        workflow(
            &durable_rows(&fixture.database.0, &fixture.source).await,
            SEMANTIC
        )["children"],
        serde_json::to_value(&original.children).unwrap()
    );
    fixture.runtime.close().await;
}

#[tokio::test]
async fn original_hold_missing_then_genuinely_rejected_target_proof_never_authorizes_exact_existing_target(
) {
    let (mut fixture, original) =
        admitted_legacy_move_with_history(json!({"status":"conflicted"}), None).await;
    let original_request = legacy_request(&original, CrossAccountMoveStep::TargetCreate);
    let mut other_request = original_request.clone();
    other_request
        .headers
        .iter_mut()
        .find(|(name, _)| name == "Idempotency-Key")
        .unwrap()
        .1 = "unrelated-target-effect".into();
    let unrelated: Value =
        serde_json::from_slice(&historical_effect(&fixture, &other_request)).unwrap();
    assert_eq!(unrelated["operationId"], "unrelated-target-effect");
    assert_eq!(unrelated["result"]["status"], "applied");
    assert_eq!(
        fixture.http.target.server.created_items(),
        vec![TARGET_ITEM.to_owned()]
    );
    let _artifacts = super::super::super::super::retirement_tests::remove_target(&fixture).await;
    replace_target(&mut fixture).await;
    let guard = original_guard(&fixture);
    let operation_id = format!("{SEMANTIC}:create-target");
    assert!(!fixture
        .http
        .target
        .server
        .outcomes
        .lock()
        .unwrap()
        .contains_key(&operation_id));
    for request in [
        prepare_request(&fixture),
        RuntimeRequest::ResumeCrossAccountMove {
            guard: guard.clone(),
        },
    ] {
        assert_proof_refusal(&fixture, request).await;
    }
    // Real handler creates a fresh original-ID rejection, without rewriting either existing ledger row.
    fixture.http.target.server.reject_next("item_id_conflict");
    let rejected: Value =
        serde_json::from_slice(&historical_effect(&fixture, &original_request)).unwrap();
    assert_eq!(rejected["operationId"], operation_id);
    assert_eq!(
        rejected["result"],
        json!({"status":"rejected", "code":"item_id_conflict"})
    );
    assert_eq!(
        fixture.http.target.server.created_items(),
        vec![TARGET_ITEM.to_owned()]
    );
    let rejected_bytes = {
        let ledger = fixture.http.target.server.outcomes.lock().unwrap();
        assert_eq!(ledger.len(), 2);
        crate::runtime::operation_fixtures::outcome_body(
            &operation_id,
            &ledger[&operation_id].result,
        )
    };
    for request in [
        prepare_request(&fixture),
        RuntimeRequest::ResumeCrossAccountMove { guard },
    ] {
        assert_proof_refusal(&fixture, request).await;
        let ledger = fixture.http.target.server.outcomes.lock().unwrap();
        assert_eq!(ledger.len(), 2);
        assert_eq!(
            crate::runtime::operation_fixtures::outcome_body(
                &operation_id,
                &ledger[&operation_id].result
            ),
            rejected_bytes
        );
    }
    assert!(fixture
        .http
        .source
        .server
        .outcomes
        .lock()
        .unwrap()
        .is_empty());
    assert_eq!(
        fixture.http.source.server.created_items(),
        vec![SOURCE_ITEM.to_owned()]
    );
    assert_eq!(
        workflow(
            &durable_rows(&fixture.database.0, &fixture.source).await,
            SEMANTIC
        )["children"],
        serde_json::to_value(&original.children).unwrap()
    );
    fixture.runtime.close().await;
}
