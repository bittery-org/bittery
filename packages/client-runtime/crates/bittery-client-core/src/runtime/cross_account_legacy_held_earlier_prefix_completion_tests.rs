//! Original full remote completion reconciles from the initial held Create checkpoint.
use super::variants_tests::{assert_final_commit, CompletionObservations};
use super::*;
use crate::replica::{CrossAccountMoveStage, ObservedOutcome, OperationOutcomeResult};

#[path = "cross_account_legacy_held_earlier_prefix_proof_tests.rs"]
mod proof_tests;

#[path = "cross_account_legacy_held_earlier_prefix_variants_tests.rs"]
mod variants_tests;

const STEPS: [CrossAccountMoveStep; 3] = [
    CrossAccountMoveStep::TargetCreate,
    CrossAccountMoveStep::SourceTrash,
    CrossAccountMoveStep::SourceDelete,
];

fn expected_full_completion(
    before: &ReplicaSnapshot,
    target: &ReplicaSnapshot,
    prior: &str,
) -> Value {
    let record = before.cross_account_moves[0].captured().unwrap();
    let mut expected = serde_json::to_value(record).unwrap();
    expected["destinationBinding"] = json!({"accountId":target.account_id,"incarnation":target.incarnation,"bindingRevision":"2","status":"active"});
    expected["legacyAdmission"]["disposition"] =
        json!({"destinationReauthorized":{"priorHold":prior,"bindingRevision":"2"}});
    expected["stage"] = json!({"type":"completed"});
    expected["disposition"] = json!({"type":"ready"});
    expected["children"] = Value::Array(
        STEPS
            .iter()
            .enumerate()
            .map(|(index, step)| {
                let mut child = record.legacy_item_child(step.clone()).unwrap().unwrap();
                let item = child.item_mut().unwrap();
                item.result = Some(ObservedOutcome {
                    operation_id: item.operation_id.clone(),
                    request_fingerprint: item.request_fingerprint,
                    result: OperationOutcomeResult::Applied {
                        entity_id: if index == 0 {
                            record.target.id.clone()
                        } else {
                            record.source.id.clone()
                        },
                        version: if index == 0 {
                            1
                        } else {
                            record.source.version + index as i32
                        },
                    },
                });
                serde_json::to_value(child).unwrap()
            })
            .collect(),
    );
    expected
}

fn assert_full_lookups(fixture: &AdmittedMoveFixture, start: usize) {
    let requests = fixture.http.requests.lock().unwrap();
    let lookups: Vec<_> = requests[start..]
        .iter()
        .filter(|r| r.url.contains("/operations/"))
        .map(|r| (r.method.clone(), r.url.clone()))
        .collect();
    assert_eq!(
        lookups,
        vec![
            (
                "GET".into(),
                format!("{TARGET_ORIGIN}/api/v1/operations/{SEMANTIC}:create-target")
            ),
            (
                "GET".into(),
                format!("{SOURCE_ORIGIN}/api/v1/operations/{SEMANTIC}:trash-source")
            ),
            (
                "GET".into(),
                format!("{SOURCE_ORIGIN}/api/v1/operations/{SEMANTIC}:delete-source")
            ),
        ]
    );
}

#[tokio::test]
async fn all_original_remote_effects_complete_the_initial_held_prefix_in_one_revision() {
    let (mut fixture, original) = admitted_legacy_move_with_history(json!({"status":"failed","retryCount":"5","nextAttemptAt":"0","lastError":"lost original final-attempt Delete response"}), None).await;
    for step in STEPS {
        let proof: Value = serde_json::from_slice(&historical_effect(
            &fixture,
            &legacy_request(&original, step),
        ))
        .unwrap();
        assert_eq!(proof["result"]["status"], "applied");
    }
    assert!(fixture.http.source.server.created_items().is_empty());
    fixture.http.offline.store(false, Ordering::SeqCst);
    fixture.http.resumed.store(true, Ordering::SeqCst);
    let _artifacts =
        super::super::super::super::super::retirement_tests::remove_target(&fixture).await;
    super::super::recovery_tests::replace_target(&mut fixture).await;
    let recorder = Arc::new(RecordCompletionCommits {
        inner: fixture.sqlite.clone(),
        commits: Mutex::default(),
    });
    reopen_with(&mut fixture, recorder.clone()).await;
    let before = fixture.runtime.require_snapshot(&fixture.source).unwrap();
    let target = fixture.runtime.require_snapshot(&fixture.target).unwrap();
    let target_rows = durable_rows(&fixture.database.0, &fixture.target).await;
    assert_eq!(
        before.cross_account_moves[0].captured().unwrap().stage,
        CrossAccountMoveStage::TargetCreate
    );
    assert_eq!(
        before.cross_account_moves[0].captured().unwrap().children,
        original.children
    );
    assert_eq!(original.children.len(), 1);
    assert!(original.children[0].item().unwrap().result.is_none());
    let expected = expected_full_completion(&before, &target, "legacyFailed");
    let observed = CompletionObservations::start(&fixture);
    let start = fixture.http.requests.lock().unwrap().len();
    let guard = prepare(&fixture, 1).await;
    assert_full_lookups(&fixture, start);
    assert_eq!(
        fixture.runtime.require_snapshot(&fixture.source).unwrap(),
        before
    );
    assert!(fixture.http.mutations(SOURCE_ORIGIN).is_empty());
    assert!(fixture.http.mutations(TARGET_ORIGIN).is_empty());
    assert!(recorder.commits.lock().unwrap().is_empty());
    fixture.http.trash_result.release.add_permits(2);
    fixture.http.delete_result.release.add_permits(2);
    let start = fixture.http.requests.lock().unwrap().len();
    confirm(&fixture, guard).await;
    assert_full_lookups(&fixture, start);
    assert_final_commit(&fixture, &recorder, &before, &expected).await;
    {
        let requests = fixture.http.requests.lock().unwrap();
        let recent = &requests[start..];
        let replays: Vec<_> = recent
            .iter()
            .enumerate()
            .filter(|(_, r)| r.method != "GET")
            .collect();
        assert_eq!(replays.len(), 3);
        for ((_, actual), step) in replays.iter().zip(STEPS) {
            assert_original_request(actual, &legacy_request(&original, step));
        }
        let last = replays[2].0;
        for (origin, id) in [(TARGET_ORIGIN, TARGET_ITEM), (SOURCE_ORIGIN, SOURCE_ITEM)] {
            assert!(recent[last + 1..]
                .iter()
                .any(|r| r.method == "GET" && r.url == format!("{origin}/api/v1/items/{id}")));
        }
    }
    assert_eq!(fixture.http.mutations(SOURCE_ORIGIN).len(), 2);
    assert_eq!(fixture.http.mutations(TARGET_ORIGIN).len(), 1);
    assert_eq!(fixture.http.source.server.outcomes.lock().unwrap().len(), 2);
    assert_eq!(fixture.http.target.server.outcomes.lock().unwrap().len(), 1);
    assert_eq!(
        fixture.runtime.require_snapshot(&fixture.target).unwrap(),
        target
    );
    assert_eq!(
        durable_rows(&fixture.database.0, &fixture.target).await,
        target_rows
    );
    observed.assert_completed();
    observed.close();
    let completed_rows = durable_rows(&fixture.database.0, &fixture.source).await;
    fixture.sqlite = MoveSqlite::open(&fixture.database.0);
    let plain = fixture.sqlite.clone();
    reopen_with(&mut fixture, plain).await;
    assert_eq!(
        durable_rows(&fixture.database.0, &fixture.source).await,
        completed_rows
    );
    let observed = CompletionObservations::start(&fixture);
    observed.assert_completed();
    observed.close();
    assert_eq!(fixture.http.mutations(SOURCE_ORIGIN).len(), 2);
    assert_eq!(fixture.http.mutations(TARGET_ORIGIN).len(), 1);
    fixture.runtime.close().await;
}
