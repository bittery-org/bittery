//! Missing is prospective work only while the exact original target is absent.
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
fn prepare_request(fixture: &AdmittedMoveFixture) -> RuntimeRequest {
    RuntimeRequest::PrepareCrossAccountMoveResume {
        account_id: fixture.source.clone(),
        operation_id: SEMANTIC.into(),
        target_account_id: fixture.target.clone(),
        expected_binding_revision: 1,
    }
}
async fn refuse(fixture: &AdmittedMoveFixture, request: RuntimeRequest) {
    let source = fixture.runtime.require_snapshot(&fixture.source).unwrap();
    let target = fixture.runtime.require_snapshot(&fixture.target).unwrap();
    let source_rows = durable_rows(&fixture.database.0, &fixture.source).await;
    let target_rows = durable_rows(&fixture.database.0, &fixture.target).await;
    let calls = fixture.http.requests.lock().unwrap().len();
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
    assert!(fixture.http.mutations(SOURCE_ORIGIN).is_empty());
    assert!(fixture.http.mutations(TARGET_ORIGIN).is_empty());
    let requests = fixture.http.requests.lock().unwrap();
    let recent = &requests[calls..];
    assert!(recent.iter().all(|request| request.method == "GET"));
    let lookups = recent
        .iter()
        .filter(|request| request.url.contains("/operations/"))
        .map(|request| request.url.as_str())
        .collect::<Vec<_>>();
    let expected = format!("{TARGET_ORIGIN}/api/v1/operations/{SEMANTIC}:create-target");
    assert_eq!(lookups, vec![expected.as_str()]);
    assert!(source.items.is_empty());
    assert_eq!(
        source.cross_account_moves[0]
            .captured()
            .unwrap()
            .destination_binding
            .binding_revision,
        1
    );
    assert!(source.cross_account_moves[0]
        .captured()
        .unwrap()
        .is_legacy_held());
    assert!(
        source.cross_account_moves[0].captured().unwrap().children[0]
            .item()
            .unwrap()
            .result
            .is_none()
    );
}

#[tokio::test]
async fn unrelated_exact_target_appearance_after_prepare_never_authorizes_missing_original_create()
{
    let (fixture, original, _artifacts) = empty_readded_target("failed").await;
    let guard = prepare(&fixture, 1).await;
    let mut other = legacy_request(&original, CrossAccountMoveStep::TargetCreate);
    other
        .headers
        .iter_mut()
        .find(|(name, _)| name.eq_ignore_ascii_case("Idempotency-Key"))
        .unwrap()
        .1 = "unrelated-target-create".into();
    let result: Value = serde_json::from_slice(&historical_effect(&fixture, &other)).unwrap();
    assert_eq!(result["operationId"], "unrelated-target-create");
    assert_eq!(result["result"]["status"], "applied");
    assert_eq!(
        fixture.http.target.server.created_items(),
        vec![TARGET_ITEM.to_owned()]
    );
    assert!(!fixture
        .http
        .target
        .server
        .outcomes
        .lock()
        .unwrap()
        .contains_key(&format!("{SEMANTIC}:create-target")));
    refuse(&fixture, prepare_request(&fixture)).await;
    refuse(&fixture, RuntimeRequest::ResumeCrossAccountMove { guard }).await;
    assert_eq!(fixture.http.target.server.outcomes.lock().unwrap().len(), 1);
    fixture.runtime.close().await;
}

#[tokio::test]
async fn rejected_original_create_does_not_authorize_an_absent_target() {
    let (fixture, original, _artifacts) = empty_readded_target("conflicted").await;
    fixture.http.target.server.reject_next("vault_read_only");
    let result: Value = serde_json::from_slice(&historical_effect(
        &fixture,
        &legacy_request(&original, CrossAccountMoveStep::TargetCreate),
    ))
    .unwrap();
    assert_eq!(
        result["result"],
        json!({"status":"rejected","code":"vault_read_only"})
    );
    assert!(fixture.http.target.server.created_items().is_empty());
    let guard = original_guard(&fixture);
    refuse(&fixture, prepare_request(&fixture)).await;
    refuse(&fixture, RuntimeRequest::ResumeCrossAccountMove { guard }).await;
    assert_eq!(fixture.http.target.server.outcomes.lock().unwrap().len(), 1);
    fixture.runtime.close().await;
}

#[tokio::test]
async fn progressed_source_does_not_authorize_absent_target_and_missing_create() {
    let (fixture, original, _artifacts) = empty_readded_target("failed").await;
    let guard = prepare(&fixture, 1).await;
    let result: Value = serde_json::from_slice(&historical_effect(
        &fixture,
        &legacy_request(&original, CrossAccountMoveStep::SourceTrash),
    ))
    .unwrap();
    assert_eq!(result["result"]["status"], "applied");
    assert!(fixture.http.source.server.created_items.lock().unwrap()[0]
        .deleted_at
        .is_some());
    assert!(fixture
        .runtime
        .require_snapshot(&fixture.source)
        .unwrap()
        .bootstrap
        .snapshot()
        .visible_items
        .iter()
        .any(|item| item.id == SOURCE_ITEM && item.deleted_at.is_none()));
    assert!(fixture.http.target.server.created_items().is_empty());
    assert!(fixture
        .http
        .target
        .server
        .outcomes
        .lock()
        .unwrap()
        .is_empty());
    refuse(&fixture, prepare_request(&fixture)).await;
    refuse(&fixture, RuntimeRequest::ResumeCrossAccountMove { guard }).await;
    assert_eq!(fixture.http.source.server.outcomes.lock().unwrap().len(), 1);
    fixture.runtime.close().await;
}

fn independently_remove_target(fixture: &AdmittedMoveFixture) {
    for (suffix, operation_id, version) in [
        ("", "independent-target-trash", 1),
        ("/permanent", "independent-target-delete", 2),
    ] {
        {
            let items = fixture.http.target.server.created_items.lock().unwrap();
            assert_eq!(items.len(), 1);
            assert_eq!(items[0].id, TARGET_ITEM);
            assert_eq!(items[0].version, version);
        }
        let request = RecordedRequest {
            method: "DELETE".into(),
            url: format!("{SERVER_URL}/api/v1/items/{TARGET_ITEM}{suffix}"),
            headers: vec![
                ("Authorization".into(), "Bearer fresh-token".into()),
                ("Idempotency-Key".into(), operation_id.into()),
                ("If-Match".into(), format!("\"{version}\"")),
            ],
            body: Vec::new(),
        };
        let response = fixture
            .http
            .target
            .server
            .handle_existing_item_mutation_for_item(&request, TARGET_ITEM);
        assert_eq!(response["type"], "completed");
        assert_eq!(response["status"], 200);
        let bytes: Vec<u8> = serde_json::from_value(response["body"].clone()).unwrap();
        let result: Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(result["operationId"], operation_id);
        assert_eq!(result["result"]["status"], "applied");
        assert_eq!(result["result"]["version"], version + 1);
    }
}

#[tokio::test]
async fn original_applied_create_with_independently_removed_target_refuses_recreation() {
    let (fixture, original, _artifacts) = empty_readded_target("conflicted").await;
    let guard = prepare(&fixture, 1).await;
    let result: Value = serde_json::from_slice(&historical_effect(
        &fixture,
        &legacy_request(&original, CrossAccountMoveStep::TargetCreate),
    ))
    .unwrap();
    assert_eq!(result["result"]["status"], "applied");
    independently_remove_target(&fixture);
    assert!(fixture.http.target.server.created_items().is_empty());
    assert_eq!(fixture.http.target.server.outcomes.lock().unwrap().len(), 3);
    refuse(&fixture, prepare_request(&fixture)).await;
    refuse(&fixture, RuntimeRequest::ResumeCrossAccountMove { guard }).await;
    assert!(fixture.http.target.server.created_items().is_empty());
    assert_eq!(fixture.http.target.server.outcomes.lock().unwrap().len(), 3);
    fixture.runtime.close().await;
}

#[tokio::test]
async fn original_target_appearance_after_missing_prepare_uses_existing_exact_proof_confirmation() {
    let (fixture, original, _artifacts) = empty_readded_target("failed").await;
    let guard = prepare(&fixture, 1).await;
    let before = fixture.runtime.require_snapshot(&fixture.source).unwrap();
    let target = fixture.runtime.require_snapshot(&fixture.target).unwrap();
    let request = legacy_request(&original, CrossAccountMoveStep::TargetCreate);
    let result: Value = serde_json::from_slice(&historical_effect(&fixture, &request)).unwrap();
    assert_eq!(result["result"]["status"], "applied");
    assert_eq!(
        fixture.runtime.require_snapshot(&fixture.source).unwrap(),
        before
    );
    confirm(&fixture, guard).await;
    let after = fixture.runtime.require_snapshot(&fixture.source).unwrap();
    assert_eq!(after.revision, before.revision + 1);
    let mut expected =
        serde_json::to_value(before.cross_account_moves[0].captured().unwrap()).unwrap();
    expected["destinationBinding"] = json!({"accountId":fixture.target,"incarnation":target.incarnation,"bindingRevision":"2","status":"active"});
    expected["legacyAdmission"]["disposition"] =
        json!({"destinationReauthorized":{"priorHold":"legacyFailed","bindingRevision":"2"}});
    expected["disposition"] = json!({"type":"ready"});
    assert_eq!(
        workflow(
            &durable_rows(&fixture.database.0, &fixture.source).await,
            SEMANTIC
        ),
        expected
    );
    assert_eq!(after.items, vec![original.source_overlay(&fixture.source)]);
    assert_source_visible(
        &fixture.runtime,
        &fixture.source,
        crate::ItemProjectionStatus::Pending,
    );
    let replay = fixture.http.mutations(TARGET_ORIGIN);
    assert_eq!(replay.len(), 1);
    assert_original_request(&replay[0], &request);
    assert!(fixture.http.mutations(SOURCE_ORIGIN).is_empty());
    assert_eq!(
        fixture.http.target.server.created_items(),
        vec![TARGET_ITEM.to_owned()]
    );
    assert_eq!(fixture.http.target.server.outcomes.lock().unwrap().len(), 1);
    fixture.runtime.close().await;
}
