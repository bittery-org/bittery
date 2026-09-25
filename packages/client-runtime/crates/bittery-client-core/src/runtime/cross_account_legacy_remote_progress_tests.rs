//! Original Server outcomes, not remote absence, prove a departed legacy choreography.
use super::*;
#[path = "cross_account_legacy_remote_crash_tests.rs"]
mod crash_tests;
#[path = "cross_account_legacy_held_lifecycle_tests.rs"]
mod held_lifecycle_tests;
#[path = "cross_account_legacy_held_prefix_tests.rs"]
mod held_prefix_tests;
#[path = "cross_account_legacy_held_proof_tests.rs"]
mod held_proof_tests;
#[path = "cross_account_legacy_held_readable_tests.rs"]
mod held_readable_tests;
#[path = "cross_account_legacy_remote_proof_tests.rs"]
mod proof_tests;
use crate::replica::{
    CrossAccountMoveChild, CrossAccountMoveDisposition, CrossAccountMoveSourceAuthority,
    CrossAccountMoveStage, CrossAccountMoveStep, GuardedCommitPlan, OperationRecord,
    OperationSchedulingState, PlanMutation, PlanResult,
};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum RemotePrefix {
    Trashed,
    Deleted,
}

fn child(
    record: &CrossAccountMoveRecord,
    step: CrossAccountMoveStep,
) -> crate::replica::CrossAccountMoveItemOperation {
    record
        .legacy_item_child(step)
        .unwrap()
        .unwrap()
        .item()
        .unwrap()
        .clone()
}

pub(super) fn request(
    record: &CrossAccountMoveRecord,
    step: CrossAccountMoveStep,
) -> RecordedRequest {
    let child = child(record, step.clone());
    let origin = if step == CrossAccountMoveStep::TargetCreate {
        TARGET_ORIGIN
    } else {
        SOURCE_ORIGIN
    };
    let mut headers = child
        .request
        .headers
        .iter()
        .map(|header| (header.name.clone(), header.value.clone()))
        .collect::<Vec<_>>();
    headers.push(("Authorization".into(), "Bearer fresh-token".into()));
    headers.push(("Idempotency-Key".into(), child.operation_id));
    RecordedRequest {
        method: if step == CrossAccountMoveStep::TargetCreate {
            "PUT"
        } else {
            "DELETE"
        }
        .into(),
        url: format!("{origin}{}", child.request.path),
        headers,
        body: child.request.body,
    }
}

fn response_body(response: &Value) -> Vec<u8> {
    assert_eq!(response["type"], "completed");
    assert_eq!(response["status"], 200);
    serde_json::from_value(response["body"].clone()).unwrap()
}

pub(super) fn historical_effect(
    fixture: &AdmittedMoveFixture,
    request: &RecordedRequest,
) -> Vec<u8> {
    let target = request.url.starts_with(TARGET_ORIGIN);
    let origin = if target { TARGET_ORIGIN } else { SOURCE_ORIGIN };
    let mut wire = request.clone();
    wire.url = format!("{SERVER_URL}{}", request.url.strip_prefix(origin).unwrap());
    let response = if target {
        fixture.http.target.server.handle_create(&wire)
    } else {
        // The maintained fake mutation handler does not enforce CAS itself. Prove its real
        // current precondition before establishing each historical effect/outcome here.
        let version = fixture.http.source.server.created_items.lock().unwrap()[0].version;
        assert_eq!(
            request.header("If-Match"),
            Some(format!("\"{version}\"").as_str())
        );
        fixture
            .http
            .source
            .server
            .handle_existing_item_mutation(&wire)
    };
    response_body(&response)
}

fn establish_prefix(
    fixture: &AdmittedMoveFixture,
    original: &CrossAccountMoveRecord,
    prefix: RemotePrefix,
    missing_original: Option<CrossAccountMoveStep>,
) {
    let local_before = fixture.runtime.require_snapshot(&fixture.source).unwrap();
    for step in [
        CrossAccountMoveStep::TargetCreate,
        CrossAccountMoveStep::SourceTrash,
        CrossAccountMoveStep::SourceDelete,
    ] {
        if prefix == RemotePrefix::Trashed && step == CrossAccountMoveStep::SourceDelete {
            break;
        }
        let mut request = request(original, step.clone());
        if missing_original.as_ref() == Some(&step) {
            request
                .headers
                .iter_mut()
                .find(|(name, _)| name == "Idempotency-Key")
                .unwrap()
                .1 = "unrelated-original-effect".into();
        }
        let result: Value = serde_json::from_slice(&historical_effect(fixture, &request)).unwrap();
        assert_eq!(result["result"]["status"], "applied");
        assert_eq!(
            result["operationId"],
            request.header("Idempotency-Key").unwrap()
        );
        assert_eq!(
            result["result"]["version"],
            match step {
                CrossAccountMoveStep::TargetCreate => 1,
                CrossAccountMoveStep::SourceTrash => original.source.version + 1,
                CrossAccountMoveStep::SourceDelete => original.source.version + 2,
            }
        );
    }
    assert_eq!(
        fixture.runtime.require_snapshot(&fixture.source).unwrap(),
        local_before,
        "remote effects never rewrite the exact captured live source cache"
    );
    fixture.http.offline.store(false, Ordering::SeqCst);
    fixture.http.resumed.store(true, Ordering::SeqCst);
    fixture.http.trash_result.release.add_permits(32);
    fixture.http.delete_result.release.add_permits(32);
}

fn current(fixture: &AdmittedMoveFixture) -> CrossAccountMoveRecord {
    fixture
        .runtime
        .require_snapshot(&fixture.source)
        .unwrap()
        .cross_account_moves
        .into_iter()
        .filter_map(|entry| entry.into_captured())
        .find(|record| record.operation_id == SEMANTIC)
        .unwrap()
}

async fn one_pass(fixture: &AdmittedMoveFixture) {
    let snapshot = fixture.runtime.require_snapshot(&fixture.source).unwrap();
    fixture
        .runtime
        .dispatch_cross_account_move(&snapshot, SEMANTIC)
        .await;
}

async fn finish_or_block(fixture: &AdmittedMoveFixture) -> CrossAccountMoveRecord {
    for _ in 0..12 {
        let record = current(fixture);
        if matches!(
            record.stage,
            CrossAccountMoveStage::Completed | CrossAccountMoveStage::Rejected
        ) || matches!(
            record.disposition,
            CrossAccountMoveDisposition::Blocked { .. }
        ) {
            return record;
        }
        one_pass(fixture).await;
    }
    panic!(
        "workflow failed to reach a bounded proof decision: {:?}",
        current(fixture).disposition
    );
}

fn assert_exact_child_replays(fixture: &AdmittedMoveFixture, original: &CrossAccountMoveRecord) {
    let requests = fixture.http.requests.lock().unwrap().clone();
    let mutations = requests
        .iter()
        .filter(|request| request.header("Idempotency-Key").is_some())
        .collect::<Vec<_>>();
    assert_eq!(mutations.len(), 3);
    for (actual, step) in mutations.into_iter().zip([
        CrossAccountMoveStep::TargetCreate,
        CrossAccountMoveStep::SourceTrash,
        CrossAccountMoveStep::SourceDelete,
    ]) {
        let expected = request(original, step);
        assert_eq!(actual.method, expected.method);
        assert_eq!(actual.url, expected.url);
        assert_eq!(actual.body, expected.body);
        for (name, value) in expected
            .headers
            .iter()
            .filter(|(name, _)| name != "Authorization")
        {
            assert_eq!(actual.header(name), Some(value.as_str()));
        }
        let id = actual.header("Idempotency-Key").unwrap();
        let origin = if actual.url.starts_with(TARGET_ORIGIN) {
            TARGET_ORIGIN
        } else {
            SOURCE_ORIGIN
        };
        let mutation_index = requests
            .iter()
            .position(|request| std::ptr::eq(request, actual))
            .unwrap();
        assert!(requests[..mutation_index]
            .iter()
            .any(|request| request.method == "GET"
                && request.url == format!("{origin}/api/v1/operations/{id}")));
    }
}

async fn positive(prefix: RemotePrefix) {
    let (fixture, original) = admitted_legacy_move().await;
    let target_before = durable_rows(&fixture.database.0, &fixture.target).await;
    establish_prefix(&fixture, &original, prefix, None);
    let completed = finish_or_block(&fixture).await;
    assert_eq!(
        completed.stage,
        CrossAccountMoveStage::Completed,
        "{prefix:?}"
    );
    assert_eq!(completed.legacy_admission, original.legacy_admission);
    assert_eq!(completed.source, original.source);
    assert_eq!(completed.children.len(), 3);
    for entry in &completed.children {
        let operation = entry.item().unwrap();
        assert!(operation.result.is_some());
    }
    assert_exact_child_replays(&fixture, &original);
    assert_eq!(
        fixture.http.target.server.created_items(),
        vec![TARGET_ITEM.to_owned()]
    );
    assert!(fixture.http.source.server.created_items().is_empty());
    assert_eq!(fixture.http.source.server.outcomes.lock().unwrap().len(), 2);
    assert_eq!(fixture.http.target.server.outcomes.lock().unwrap().len(), 1);
    assert_eq!(
        durable_rows(&fixture.database.0, &fixture.target).await,
        target_before
    );
    assert_eq!(
        workflow(
            &durable_rows(&fixture.database.0, &fixture.source).await,
            SEMANTIC
        ),
        serde_json::to_value(completed).unwrap()
    );
    let RuntimeProjection::Items(items) = fixture
        .runtime
        .projection(&ObservationRequest::Items {
            account_id: fixture.source.clone(),
        })
        .unwrap()
        .projection
    else {
        panic!("Items projection")
    };
    assert!(items.items.is_empty());
    fixture.runtime.close().await;
}

#[tokio::test]
async fn legacy_remote_trash_prefix_replays_original_proofs_then_sends_the_original_delete() {
    positive(RemotePrefix::Trashed).await;
}

#[tokio::test]
async fn legacy_remote_delete_prefix_proves_all_three_original_results_before_local_cleanup() {
    positive(RemotePrefix::Deleted).await;
}

fn server_evidence(server: &FakeServer) -> Value {
    let items = server
        .created_items
        .lock()
        .unwrap()
        .iter()
        .map(item_body)
        .collect::<Vec<_>>();
    let outcomes = server
        .outcomes
        .lock()
        .unwrap()
        .iter()
        .map(|(id, outcome)| {
            json!({"id":id,"fingerprint":outcome.fingerprint.to_vec(),
            "body":crate::runtime::operation_fixtures::outcome_body(id, &outcome.result)})
        })
        .collect::<Vec<_>>();
    json!({"items":items,"outcomes":outcomes})
}

#[tokio::test]
async fn legacy_remote_absence_cannot_substitute_for_any_original_child_outcome() {
    for missing in [
        CrossAccountMoveStep::TargetCreate,
        CrossAccountMoveStep::SourceTrash,
        CrossAccountMoveStep::SourceDelete,
    ] {
        let (fixture, original) = admitted_legacy_move().await;
        // The exact remote content/effect exists, but one was performed under another ID.
        // Never manufacture a missing result by injecting an Applied record into the fixture.
        establish_prefix(
            &fixture,
            &original,
            RemotePrefix::Deleted,
            Some(missing.clone()),
        );
        let source_before = server_evidence(&fixture.http.source.server);
        let target_before = server_evidence(&fixture.http.target.server);
        let missing_id = child(&original, missing.clone()).operation_id;
        let blocked = finish_or_block(&fixture).await;
        assert_eq!(
            blocked.disposition,
            CrossAccountMoveDisposition::Blocked {
                reason: crate::replica::CrossAccountMoveBlockedReason::MissingProof,
            },
            "{missing:?}"
        );
        assert_ne!(blocked.stage, CrossAccountMoveStage::Completed);
        let unproved = blocked
            .children
            .iter()
            .filter_map(CrossAccountMoveChild::item)
            .find(|operation| operation.operation_id == missing_id)
            .unwrap();
        assert!(unproved.result.is_none());
        assert!(
            !fixture
                .http
                .requests
                .lock()
                .unwrap()
                .iter()
                .any(|request| { request.header("Idempotency-Key") == Some(missing_id.as_str()) }),
            "a missing outcome must not authorize an undecided effect against progressed authority"
        );
        assert_eq!(server_evidence(&fixture.http.source.server), source_before);
        assert_eq!(server_evidence(&fixture.http.target.server), target_before);
        assert_eq!(blocked.legacy_admission, original.legacy_admission);
        assert_source_visible(
            &fixture.runtime,
            &fixture.source,
            crate::ItemProjectionStatus::Pending,
        );
        assert_eq!(
            workflow(
                &durable_rows(&fixture.database.0, &fixture.source).await,
                SEMANTIC
            ),
            serde_json::to_value(blocked).unwrap()
        );
        fixture.runtime.close().await;
    }
}

fn genuine_original_proof(
    fixture: &AdmittedMoveFixture,
    original: &CrossAccountMoveRecord,
    step: CrossAccountMoveStep,
) -> crate::replica::ObservedOutcome {
    let child = child(original, step.clone());
    let mut request = request(original, step.clone());
    let (server, origin) = if step == CrossAccountMoveStep::TargetCreate {
        (&fixture.http.target.server, TARGET_ORIGIN)
    } else {
        (&fixture.http.source.server, SOURCE_ORIGIN)
    };
    assert!(server
        .outcomes
        .lock()
        .unwrap()
        .contains_key(&child.operation_id));
    let lookup = RecordedRequest {
        method: "GET".into(),
        url: format!("{SERVER_URL}/api/v1/operations/{}", child.operation_id),
        headers: vec![("Authorization".into(), "Bearer fresh-token".into())],
        body: Vec::new(),
    };
    let lookup_body = response_body(&server.handle_outcome_lookup(&lookup));
    request.url = format!("{SERVER_URL}{}", request.url.strip_prefix(origin).unwrap());
    let replay_body = response_body(&if step == CrossAccountMoveStep::TargetCreate {
        server.handle_create(&request)
    } else {
        // The original final outcome was established by a real effect before this replay.
        server.handle_existing_item_mutation(&request)
    });
    assert_eq!(
        lookup_body, replay_body,
        "genuine lookup and exact replay must agree"
    );
    let operation = OperationRecord {
        operation_id: child.operation_id,
        kind: child.kind,
        target: child.target,
        request: child.request,
        request_fingerprint: child.request_fingerprint,
        accepted_item_category: Some(original.source.category.clone()),
        attachment_move_recovery: None,
        create_vault: None,
        update_vault: None,
        scheduling: OperationSchedulingState::default(),
        legacy_admission: None,
    };
    let crate::runtime::outcome::SemanticAnswer::Outcome(outcome) = fixture
        .runtime
        .read_dispatch_answer(&operation, 200, &replay_body)
    else {
        panic!("actual retained result must pass Runtime's ordinary outcome parser");
    };
    let (item_id, expected_version) = if step == CrossAccountMoveStep::TargetCreate {
        (TARGET_ITEM, 1)
    } else {
        (
            SOURCE_ITEM,
            original.source.version
                + if step == CrossAccountMoveStep::SourceTrash {
                    1
                } else {
                    2
                },
        )
    };
    assert!(
        matches!(&outcome.result, crate::replica::OperationOutcomeResult::Applied { entity_id, version } if entity_id == item_id && *version == expected_version)
    );
    outcome
}

async fn retain_genuine_target_proof_without_advancing_stage(
    fixture: &AdmittedMoveFixture,
    original: &CrossAccountMoveRecord,
) {
    let outcome = genuine_original_proof(fixture, original, CrossAccountMoveStep::TargetCreate);
    let mut next = original.clone();
    let CrossAccountMoveChild::ItemOperation(target) = &mut next.children[0] else {
        unreachable!()
    };
    target.result = Some(outcome);
    let snapshot = fixture.runtime.require_snapshot(&fixture.source).unwrap();
    assert!(matches!(
        fixture
            .runtime
            .replica
            .execute(GuardedCommitPlan::new(
                snapshot.account_id,
                snapshot.incarnation,
                snapshot.revision,
                snapshot.lock_epoch,
                vec![PlanMutation::AdvanceCrossAccountMove {
                    operation_id: SEMANTIC.into(),
                    expected_binding_revision: 0,
                    next: Box::new(next.clone()),
                    source_authority: CrossAccountMoveSourceAuthority::Unchanged,
                }],
            ))
            .await
            .unwrap(),
        PlanResult::Applied { .. }
    ));
    assert_eq!(current(fixture), next);
    assert_eq!(
        next.stage,
        CrossAccountMoveStage::TargetCreate,
        "exercise the legal durable-result boundary independently of the next stage transition"
    );
}

async fn reopen(fixture: &mut AdmittedMoveFixture) {
    let saved = workflow(
        &durable_rows(&fixture.database.0, &fixture.source).await,
        SEMANTIC,
    );
    fixture.runtime.close().await;
    fixture.sqlite = MoveSqlite::open(&fixture.database.0);
    let calls = fixture.http.requests.lock().unwrap().len();
    fixture.runtime = open_move_runtime(
        fixture.sqlite.clone(),
        fixture.platform.clone(),
        fixture.http.clone(),
    )
    .await;
    assert_eq!(fixture.http.requests.lock().unwrap().len(), calls);
    assert_eq!(
        workflow(
            &durable_rows(&fixture.database.0, &fixture.source).await,
            SEMANTIC
        ),
        saved
    );
    for account in [&fixture.source, &fixture.target] {
        assert_eq!(
            fixture.runtime.account_access_state(account),
            Some(AccountAccessState::Locked)
        );
        fixture
            .runtime
            .request(
                quick_unlock_request(account.as_str()),
                RequestCancellation::new(),
            )
            .await
            .unwrap();
    }
    assert_eq!(serde_json::to_value(current(fixture)).unwrap(), saved);
}

#[tokio::test]
async fn legacy_remote_progress_rechecks_current_target_even_after_its_result_is_durable() {
    for absent in [false, true] {
        let (mut fixture, original) = admitted_legacy_move().await;
        establish_prefix(&fixture, &original, RemotePrefix::Deleted, None);
        retain_genuine_target_proof_without_advancing_stage(&fixture, &original).await;
        reopen(&mut fixture).await;
        {
            let mut items = fixture.http.target.server.created_items.lock().unwrap();
            if absent {
                items.clear();
            } else {
                // A subsequent remote metadata change, beyond the exact original target.
                items[0].favorite = true;
                items[0].version += 1;
            }
        }
        let before = current(&fixture);
        let source_before = server_evidence(&fixture.http.source.server);
        let target_before = server_evidence(&fixture.http.target.server);
        let blocked = finish_or_block(&fixture).await;
        assert_eq!(
            blocked.disposition,
            CrossAccountMoveDisposition::Blocked {
                reason: crate::replica::CrossAccountMoveBlockedReason::TargetChanged,
            }
        );
        assert_eq!(blocked.stage, CrossAccountMoveStage::TargetCreate);
        assert_eq!(blocked.children, before.children);
        assert_eq!(blocked.legacy_admission, before.legacy_admission);
        assert!(fixture.http.mutations(SOURCE_ORIGIN).is_empty());
        assert!(fixture.http.mutations(TARGET_ORIGIN).is_empty());
        assert_eq!(server_evidence(&fixture.http.source.server), source_before);
        assert_eq!(server_evidence(&fixture.http.target.server), target_before);
        assert_source_visible(
            &fixture.runtime,
            &fixture.source,
            crate::ItemProjectionStatus::Pending,
        );
        fixture.runtime.close().await;
    }
}

#[tokio::test]
async fn legacy_remote_progress_rejects_wrong_version_lookup_before_any_replay() {
    let (fixture, original) = admitted_legacy_move().await;
    establish_prefix(&fixture, &original, RemotePrefix::Deleted, None);
    let target_id = child(&original, CrossAccountMoveStep::TargetCreate).operation_id;
    let mut wrong: Value = {
        let outcomes = fixture.http.target.server.outcomes.lock().unwrap();
        serde_json::from_slice(&crate::runtime::operation_fixtures::outcome_body(
            &target_id,
            &outcomes[&target_id].result,
        ))
        .unwrap()
    };
    // Corrupt only the delivered lookup response. The Server's genuine Applied-1 result and
    // target Item stay untouched, so this cannot accidentally test a different remote history.
    wrong["result"]["version"] = json!(2);
    fixture
        .http
        .target
        .server
        .lookup_response_overrides
        .lock()
        .unwrap()
        .push_back(serde_json::to_vec(&wrong).unwrap());
    let source_before = server_evidence(&fixture.http.source.server);
    let target_before = server_evidence(&fixture.http.target.server);
    let blocked = finish_or_block(&fixture).await;
    assert_eq!(
        blocked.disposition,
        CrossAccountMoveDisposition::Blocked {
            reason: crate::replica::CrossAccountMoveBlockedReason::MissingProof,
        }
    );
    assert_eq!(blocked.stage, CrossAccountMoveStage::TargetCreate);
    assert!(blocked.children[0].item().unwrap().result.is_none());
    assert!(fixture.http.requests.lock().unwrap().iter().any(|request| {
        request.method == "GET"
            && request.url == format!("{TARGET_ORIGIN}/api/v1/operations/{target_id}")
    }));
    assert!(
        fixture.http.mutations(TARGET_ORIGIN).is_empty(),
        "wrong-version hint must fail before exact replay"
    );
    assert!(fixture.http.mutations(SOURCE_ORIGIN).is_empty());
    assert_eq!(server_evidence(&fixture.http.source.server), source_before);
    assert_eq!(server_evidence(&fixture.http.target.server), target_before);
    assert_source_visible(
        &fixture.runtime,
        &fixture.source,
        crate::ItemProjectionStatus::Pending,
    );
    fixture.runtime.close().await;
}

async fn advance_exact(fixture: &AdmittedMoveFixture, next: CrossAccountMoveRecord) {
    let snapshot = fixture.runtime.require_snapshot(&fixture.source).unwrap();
    assert!(matches!(
        fixture
            .runtime
            .replica
            .execute(GuardedCommitPlan::new(
                snapshot.account_id,
                snapshot.incarnation,
                snapshot.revision,
                snapshot.lock_epoch,
                vec![PlanMutation::AdvanceCrossAccountMove {
                    operation_id: SEMANTIC.into(),
                    expected_binding_revision: 0,
                    next: Box::new(next),
                    source_authority: CrossAccountMoveSourceAuthority::Unchanged,
                }],
            ))
            .await
            .unwrap(),
        PlanResult::Applied { .. }
    ));
}

#[tokio::test]
async fn legacy_remote_durable_trash_proof_cannot_advance_after_source_restore() {
    let (mut fixture, original) = admitted_legacy_move().await;
    establish_prefix(&fixture, &original, RemotePrefix::Trashed, None);
    retain_genuine_target_proof_without_advancing_stage(&fixture, &original).await;
    let mut next = current(&fixture);
    next.stage = CrossAccountMoveStage::SourceTrash;
    advance_exact(&fixture, next).await;
    let mut next = current(&fixture);
    next.children.push(
        original
            .legacy_item_child(CrossAccountMoveStep::SourceTrash)
            .unwrap()
            .unwrap(),
    );
    advance_exact(&fixture, next).await;
    let trash_proof =
        genuine_original_proof(&fixture, &original, CrossAccountMoveStep::SourceTrash);
    let mut next = current(&fixture);
    let CrossAccountMoveChild::ItemOperation(trash) = &mut next.children[1] else {
        unreachable!()
    };
    trash.result = Some(trash_proof);
    advance_exact(&fixture, next).await;
    reopen(&mut fixture).await;
    let restore = RecordedRequest {
        method: "POST".into(),
        url: format!("{SOURCE_ORIGIN}/api/v1/items/{SOURCE_ITEM}/restore"),
        headers: vec![
            ("Authorization".into(), "Bearer fresh-token".into()),
            (
                "Idempotency-Key".into(),
                "independent-source-restore".into(),
            ),
            ("If-Match".into(), "\"2\"".into()),
        ],
        body: Vec::new(),
    };
    let restored: Value = serde_json::from_slice(&historical_effect(&fixture, &restore)).unwrap();
    assert_eq!(restored["result"]["status"], "applied");
    assert_eq!(restored["result"]["version"], 3);
    let source_before = server_evidence(&fixture.http.source.server);
    let target_before = server_evidence(&fixture.http.target.server);
    let before = current(&fixture);
    assert_eq!(before.stage, CrossAccountMoveStage::SourceTrash);
    assert!(before.children[1].item().unwrap().result.is_some());
    one_pass(&fixture).await;
    let blocked = current(&fixture);
    assert_eq!(
        blocked.disposition,
        CrossAccountMoveDisposition::Blocked {
            reason: crate::replica::CrossAccountMoveBlockedReason::SourceChanged,
        }
    );
    assert_eq!(
        blocked.stage,
        CrossAccountMoveStage::SourceTrash,
        "do not advance on durable proof while skipping fresh source classification"
    );
    assert_eq!(blocked.children, before.children);
    assert!(fixture.http.mutations(SOURCE_ORIGIN).is_empty());
    assert!(fixture.http.mutations(TARGET_ORIGIN).is_empty());
    assert_eq!(server_evidence(&fixture.http.source.server), source_before);
    assert_eq!(server_evidence(&fixture.http.target.server), target_before);
    assert_source_visible(
        &fixture.runtime,
        &fixture.source,
        crate::ItemProjectionStatus::Pending,
    );
    fixture.runtime.close().await;
}
