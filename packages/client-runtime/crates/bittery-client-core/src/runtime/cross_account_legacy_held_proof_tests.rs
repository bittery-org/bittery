//! Register as a child of cross_account_legacy_remote_progress_tests.rs.
use super::*;
use crate::runtime::dispatch::DispatchPass;

fn enable_proof_reads(fixture: &AdmittedMoveFixture) {
    fixture.http.offline.store(false, Ordering::SeqCst);
    fixture.http.resumed.store(true, Ordering::SeqCst);
}

fn assert_original_target_lookup_only(
    fixture: &AdmittedMoveFixture,
    original: &CrossAccountMoveRecord,
) {
    let expected_id = child(original, CrossAccountMoveStep::TargetCreate).operation_id;
    let lookups = fixture
        .http
        .requests
        .lock()
        .unwrap()
        .iter()
        .filter(|request| request.url.contains("/operations/"))
        .map(|request| (request.method.clone(), request.url.clone()))
        .collect::<Vec<_>>();
    assert_eq!(
        lookups,
        vec![(
            "GET".into(),
            format!("{TARGET_ORIGIN}/api/v1/operations/{expected_id}")
        )]
    );
}

#[tokio::test]
async fn held_cross_live_source_wrong_version_target_hint_blocks_before_replay() {
    let (fixture, original) =
        admitted_legacy_move_with_history(json!({"status":"failed"}), None).await;
    let target_request = request(&original, CrossAccountMoveStep::TargetCreate);
    let mut hint: Value =
        serde_json::from_slice(&historical_effect(&fixture, &target_request)).unwrap();
    assert_eq!(hint["result"]["status"], "applied");
    assert_eq!(hint["result"]["version"], 1);
    // Only the delivered lookup lies; genuine target Applied-1 and the original live source stay intact.
    hint["result"]["version"] = json!(2);
    fixture
        .http
        .target
        .server
        .lookup_response_overrides
        .lock()
        .unwrap()
        .push_back(serde_json::to_vec(&hint).unwrap());
    let source_evidence = server_evidence(&fixture.http.source.server);
    let target_evidence = server_evidence(&fixture.http.target.server);
    let source_before = fixture.runtime.require_snapshot(&fixture.source).unwrap();
    let target_before = fixture.runtime.require_snapshot(&fixture.target).unwrap();
    enable_proof_reads(&fixture);
    assert!(matches!(
        fixture
            .runtime
            .dispatch_cross_account_move(&source_before, SEMANTIC)
            .await,
        DispatchPass::Progressed
    ));
    let blocked = current(&fixture);
    assert_eq!(blocked.stage, CrossAccountMoveStage::TargetCreate);
    assert_eq!(
        blocked.disposition,
        CrossAccountMoveDisposition::Blocked {
            reason: crate::replica::CrossAccountMoveBlockedReason::MissingProof
        }
    );
    assert_eq!(blocked.children, original.children);
    assert_eq!(blocked.legacy_admission, original.legacy_admission);
    assert_original_target_lookup_only(&fixture, &original);
    assert!(fixture.http.mutations(TARGET_ORIGIN).is_empty());
    assert!(fixture.http.mutations(SOURCE_ORIGIN).is_empty());
    assert_eq!(
        server_evidence(&fixture.http.source.server),
        source_evidence
    );
    assert_eq!(
        server_evidence(&fixture.http.target.server),
        target_evidence
    );
    let source_after = fixture.runtime.require_snapshot(&fixture.source).unwrap();
    assert_eq!(source_after.bootstrap, source_before.bootstrap);
    assert_eq!(source_after.items, source_before.items);
    assert_eq!(
        fixture.runtime.require_snapshot(&fixture.target).unwrap(),
        target_before
    );
    assert_eq!(
        resolution(&fixture.runtime, &fixture.source, SEMANTIC),
        OperationResolution::LegacyFailed
    );
    fixture.runtime.close().await;
}

#[tokio::test]
async fn held_cross_genuine_target_rejection_preserves_newer_active_source_overlay() {
    let (fixture, original) =
        admitted_legacy_move_with_history(json!({"status":"conflicted"}), None).await;
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
    let before = fixture.runtime.require_snapshot(&fixture.source).unwrap();
    assert_eq!(before.operations.len(), 1);
    assert_eq!(before.items.len(), 1);
    assert_eq!(
        before.items[0].operation_id,
        before.operations[0].operation_id
    );
    assert_ne!(before.items[0].operation_id, SEMANTIC);
    assert_eq!(before.items[0].favorite, !original.source.favorite);
    let target_before = fixture.runtime.require_snapshot(&fixture.target).unwrap();
    let target_request = request(&original, CrossAccountMoveStep::TargetCreate);
    fixture.http.target.server.reject_next("item_id_conflict");
    let rejected: Value =
        serde_json::from_slice(&historical_effect(&fixture, &target_request)).unwrap();
    assert_eq!(
        rejected["result"],
        json!({"status":"rejected", "code":"item_id_conflict"})
    );
    assert!(fixture.http.target.server.created_items().is_empty());
    let source_evidence = server_evidence(&fixture.http.source.server);
    let target_evidence = server_evidence(&fixture.http.target.server);
    let source_mutations_before = fixture.http.mutations(SOURCE_ORIGIN).len();
    enable_proof_reads(&fixture);
    let after = finish_or_block(&fixture).await;
    assert_eq!(after.stage, CrossAccountMoveStage::Rejected);
    assert_eq!(after.children.len(), 1);
    assert_eq!(after.legacy_admission, original.legacy_admission);
    assert_eq!(after.source, original.source);
    assert_eq!(after.target, original.target);
    assert_eq!(
        serde_json::to_value(after.children[0].item().unwrap().result.as_ref().unwrap()).unwrap()
            ["result"],
        json!({"type":"rejected", "code":"item_id_conflict"})
    );
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
    assert!(projected
        .operations
        .iter()
        .any(|operation| operation.operation_id == before.operations[0].operation_id));
    assert_eq!(
        projected
            .operations
            .iter()
            .find(|operation| operation.operation_id == SEMANTIC)
            .unwrap()
            .resolution,
        OperationResolution::Rejected
    );
    assert_original_target_lookup_only(&fixture, &original);
    let replays = fixture.http.mutations(TARGET_ORIGIN);
    assert_eq!(replays.len(), 1);
    let replay = &replays[0];
    assert_eq!(replay.method, target_request.method);
    assert_eq!(replay.url, target_request.url);
    assert_eq!(replay.body, target_request.body);
    for (name, value) in target_request
        .headers
        .iter()
        .filter(|(name, _)| !name.eq_ignore_ascii_case("authorization"))
    {
        assert_eq!(replay.header(name), Some(value.as_str()));
    }
    assert_eq!(
        fixture.http.mutations(SOURCE_ORIGIN).len(),
        source_mutations_before
    );
    assert_eq!(
        server_evidence(&fixture.http.source.server),
        source_evidence
    );
    assert_eq!(
        server_evidence(&fixture.http.target.server),
        target_evidence
    );
    let source_after = fixture.runtime.require_snapshot(&fixture.source).unwrap();
    assert_eq!(source_after.bootstrap, before.bootstrap);
    assert_eq!(source_after.operations, before.operations);
    assert_eq!(source_after.items, before.items);
    assert_eq!(
        fixture.runtime.require_snapshot(&fixture.target).unwrap(),
        target_before
    );
    assert_source_visible(
        &fixture.runtime,
        &fixture.source,
        crate::ItemProjectionStatus::Pending,
    );
    fixture.runtime.close().await;
}

#[tokio::test]
async fn held_cross_target_effect_under_semantic_or_attempt_id_never_substitutes_original_child_proof(
) {
    for other_id in [SEMANTIC, "legacy-attempt"] {
        let (fixture, original) =
            admitted_legacy_move_with_history(json!({"status":"failed"}), None).await;
        let mut other_request = request(&original, CrossAccountMoveStep::TargetCreate);
        other_request
            .headers
            .iter_mut()
            .find(|(name, _)| name == "Idempotency-Key")
            .unwrap()
            .1 = other_id.into();
        let result: Value =
            serde_json::from_slice(&historical_effect(&fixture, &other_request)).unwrap();
        assert_eq!(result["operationId"], other_id);
        assert_eq!(result["result"]["status"], "applied");
        assert_eq!(
            fixture.http.target.server.created_items(),
            vec![TARGET_ITEM.to_owned()]
        );
        let source_before = fixture.runtime.require_snapshot(&fixture.source).unwrap();
        let target_before = fixture.runtime.require_snapshot(&fixture.target).unwrap();
        let rows_before = durable_rows(&fixture.database.0, &fixture.source).await;
        let source_evidence = server_evidence(&fixture.http.source.server);
        let target_evidence = server_evidence(&fixture.http.target.server);
        enable_proof_reads(&fixture);
        assert!(matches!(
            fixture
                .runtime
                .dispatch_cross_account_move(&source_before, SEMANTIC)
                .await,
            DispatchPass::Parked
        ));
        assert_original_target_lookup_only(&fixture, &original);
        assert!(fixture.http.mutations(TARGET_ORIGIN).is_empty());
        assert!(fixture.http.mutations(SOURCE_ORIGIN).is_empty());
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
            rows_before
        );
        assert_eq!(
            server_evidence(&fixture.http.source.server),
            source_evidence
        );
        assert_eq!(
            server_evidence(&fixture.http.target.server),
            target_evidence
        );
        fixture.runtime.close().await;
    }
}
