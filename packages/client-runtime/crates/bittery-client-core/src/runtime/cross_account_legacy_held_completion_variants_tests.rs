//! Durable proof and ambiguous delivery still publish only final remote completion.
use super::*;
use crate::replica::{CrossAccountMoveStage, ReplicaSnapshot};
use crate::runtime::dispatch::DispatchPass;

pub(super) struct CompletionObservations {
    items: Arc<Sink>,
    operations: Arc<Sink>,
    handles: Vec<Arc<crate::runtime::ObservationHandle>>,
}
impl CompletionObservations {
    pub(super) fn start(fixture: &AdmittedMoveFixture) -> Self {
        let items = Arc::new(Sink::default());
        let operations = Arc::new(Sink::default());
        let handles = vec![
            fixture
                .runtime
                .observe(
                    ObservationRequest::Items {
                        account_id: fixture.source.clone(),
                    },
                    items.clone(),
                )
                .unwrap(),
            fixture
                .runtime
                .observe(
                    ObservationRequest::Operations {
                        account_id: fixture.source.clone(),
                    },
                    operations.clone(),
                )
                .unwrap(),
        ];
        Self {
            items,
            operations,
            handles,
        }
    }
    pub(super) fn assert_no_pending(&self) {
        assert!(self.items.0.lock().unwrap().iter().all(|projection| matches!(projection,
            RuntimeProjection::Items(items) if items.items.iter().all(|item| item.status != crate::ItemProjectionStatus::Pending))));
        assert!(self.operations.0.lock().unwrap().iter().all(|projection| matches!(projection,
            RuntimeProjection::Operations(operations) if operations.operations.iter().all(|operation| operation.operation_id != SEMANTIC || operation.resolution != OperationResolution::Pending))));
    }
    pub(super) fn assert_completed(&self) {
        self.assert_no_pending();
        assert!(
            matches!(self.items.0.lock().unwrap().last(), Some(RuntimeProjection::Items(items)) if items.items.is_empty())
        );
        assert!(
            matches!(self.operations.0.lock().unwrap().last(), Some(RuntimeProjection::Operations(operations)) if operations.operations.iter().any(|operation| operation.operation_id == SEMANTIC && operation.resolution == OperationResolution::Applied))
        );
    }
    pub(super) fn close(&self) {
        for handle in &self.handles {
            handle.close();
        }
    }
}

pub(super) fn expected_completion(
    before: &ReplicaSnapshot,
    target: &ReplicaSnapshot,
    prior: &str,
) -> Value {
    let original = before.cross_account_moves[0].captured().unwrap();
    let mut expected = serde_json::to_value(original).unwrap();
    expected["destinationBinding"] = json!({"accountId":target.account_id,"incarnation":target.incarnation,"bindingRevision":"2","status":"active"});
    expected["legacyAdmission"]["disposition"] =
        json!({"destinationReauthorized":{"priorHold":prior,"bindingRevision":"2"}});
    expected["stage"] = json!({"type":"completed"});
    expected["disposition"] = json!({"type":"ready"});
    let missing_delete = (original.children.len() == 2).then(|| {
        original
            .legacy_item_child(CrossAccountMoveStep::SourceDelete)
            .unwrap()
            .unwrap()
    });
    if let Some(child) = &missing_delete {
        expected["children"]
            .as_array_mut()
            .unwrap()
            .push(serde_json::to_value(child).unwrap());
    }
    let child = original
        .children
        .get(2)
        .or(missing_delete.as_ref())
        .unwrap()
        .item()
        .unwrap();
    expected["children"][2]["result"] = serde_json::to_value(crate::replica::ObservedOutcome {
        operation_id: child.operation_id.clone(),
        request_fingerprint: child.request_fingerprint,
        result: crate::replica::OperationOutcomeResult::Applied {
            entity_id: original.source.id.clone(),
            version: original.source.version + 2,
        },
    })
    .unwrap();
    expected
}

pub(super) async fn assert_final_commit(
    fixture: &AdmittedMoveFixture,
    recorder: &RecordCompletionCommits,
    before: &ReplicaSnapshot,
    expected: &Value,
) {
    let after = fixture.runtime.require_snapshot(&fixture.source).unwrap();
    assert_eq!(after.revision, before.revision + 1);
    assert_eq!(after.operations, before.operations);
    assert!(after.items.is_empty());
    assert!(!after
        .bootstrap
        .snapshot()
        .visible_items
        .iter()
        .any(|item| item.id == SOURCE_ITEM));
    let rows = durable_rows(&fixture.database.0, &fixture.source).await;
    assert_eq!(workflow(&rows, SEMANTIC), *expected);
    assert!(!rows.iter().any(|row| row["store"] == "optimisticItems"));
    let commits = recorder.commits.lock().unwrap();
    assert_eq!(commits.len(), 1);
    let writes = commits[0]["prepared"]["writes"].as_array().unwrap();
    assert!(!writes
        .iter()
        .any(|write| write["type"] == "put" && write["row"]["store"] == "optimisticItems"));
    let source_key = format!(
        "{}/{}",
        before.bootstrap.active_generation.as_ref().unwrap().0,
        SOURCE_ITEM
    );
    let had_source = before
        .bootstrap
        .snapshot()
        .visible_items
        .iter()
        .any(|item| item.id == SOURCE_ITEM);
    let deletes_source = writes.iter().any(|write| {
        write["type"] == "delete"
            && write["store"] == "authorityItems"
            && write["key"]["recordId"] == source_key
    });
    assert_eq!(
        deletes_source, had_source,
        "delete exactly the active source row that existed before completion"
    );
    assert!(
        !writes.iter().any(|write| write["type"] == "put"
            && write["row"]["store"] == "authorityItems"
            && write["row"]["key"]["recordId"] == source_key),
        "completion never invents a replacement source authority row"
    );
    let written = writes
        .iter()
        .find(|write| write["row"]["store"] == "crossAccountMoves")
        .unwrap();
    assert_eq!(
        serde_json::from_str::<Value>(written["row"]["payloadJson"].as_str().unwrap()).unwrap(),
        *expected
    );
}

pub(super) fn assert_lookup_then_final_reads(fixture: &AdmittedMoveFixture, start: usize) {
    let requests = fixture.http.requests.lock().unwrap();
    let recent = &requests[start..];
    let url = format!("{SOURCE_ORIGIN}/api/v1/operations/{SEMANTIC}:delete-source");
    let lookups = recent
        .iter()
        .enumerate()
        .filter(|(_, request)| request.url.contains("/operations/"))
        .collect::<Vec<_>>();
    assert_eq!(lookups.len(), 1);
    assert_eq!(lookups[0].1.method, "GET");
    assert_eq!(lookups[0].1.url, url);
    for (origin, item_id) in [(SOURCE_ORIGIN, SOURCE_ITEM), (TARGET_ORIGIN, TARGET_ITEM)] {
        let url = format!("{origin}/api/v1/items/{item_id}");
        assert!(recent
            .iter()
            .skip(lookups[0].0 + 1)
            .any(|request| request.method == "GET" && request.url == url));
    }
}

#[tokio::test]
async fn conflicted_retained_delete_proof_reconciles_with_fresh_lookup_and_no_replay() {
    let (mut fixture, original) = admitted_legacy_move_with_history(json!({"status":"conflicted","retryCount":"2","nextAttemptAt":"0","lastError":"retained stop"}), None).await;
    for step in [
        CrossAccountMoveStep::TargetCreate,
        CrossAccountMoveStep::SourceTrash,
        CrossAccountMoveStep::SourceDelete,
    ] {
        let proof: Value = serde_json::from_slice(&historical_effect(
            &fixture,
            &legacy_request(&original, step),
        ))
        .unwrap();
        assert_eq!(proof["result"]["status"], "applied");
    }
    fixture.http.offline.store(false, Ordering::SeqCst);
    fixture.http.resumed.store(true, Ordering::SeqCst);
    fixture.http.trash_result.release.add_permits(4);
    fixture.http.delete_result.release.add_permits(4);
    let mut proved = false;
    for _ in 0..8 {
        let snapshot = fixture.runtime.require_snapshot(&fixture.source).unwrap();
        assert!(matches!(
            fixture
                .runtime
                .dispatch_cross_account_move(&snapshot, SEMANTIC)
                .await,
            DispatchPass::Progressed
        ));
        let snapshot = fixture.runtime.require_snapshot(&fixture.source).unwrap();
        let held = snapshot.cross_account_moves[0].captured().unwrap();
        if held.stage == CrossAccountMoveStage::SourceDelete
            && held.children.len() == 3
            && held.children[2].item().unwrap().result.is_some()
        {
            proved = true;
            break;
        }
    }
    assert!(
        proved,
        "stop after the actual Delete result commit, before terminal completion"
    );
    let snapshot = fixture.runtime.require_snapshot(&fixture.source).unwrap();
    assert!(snapshot.items.is_empty());
    assert_eq!(
        snapshot
            .bootstrap
            .snapshot()
            .visible_items
            .iter()
            .find(|item| item.id == SOURCE_ITEM),
        Some(&original.source)
    );
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
    let expected = expected_completion(&before, &target, "legacyConflicted");
    assert_eq!(
        expected["children"],
        serde_json::to_value(&before.cross_account_moves[0].captured().unwrap().children).unwrap()
    );
    let observed = CompletionObservations::start(&fixture);
    let prepare_start = fixture.http.requests.lock().unwrap().len();
    let guard = prepare(&fixture, 1).await;
    assert!(fixture.http.requests.lock().unwrap()[prepare_start..]
        .iter()
        .any(|request| request.method == "GET"
            && request.url
                == format!("{SOURCE_ORIGIN}/api/v1/operations/{SEMANTIC}:delete-source")));
    assert_eq!(
        fixture.runtime.require_snapshot(&fixture.source).unwrap(),
        before
    );
    let source_writes = fixture.http.mutations(SOURCE_ORIGIN).len();
    let target_writes = fixture.http.mutations(TARGET_ORIGIN).len();
    let confirm_start = fixture.http.requests.lock().unwrap().len();
    confirm(&fixture, guard).await;
    assert_lookup_then_final_reads(&fixture, confirm_start);
    assert_eq!(fixture.http.mutations(SOURCE_ORIGIN).len(), source_writes);
    assert_eq!(source_writes, 2);
    assert_eq!(fixture.http.mutations(TARGET_ORIGIN).len(), target_writes);
    assert_final_commit(&fixture, &recorder, &before, &expected).await;
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
    fixture.runtime.close().await;
}

#[tokio::test]
async fn continuation_prepare_then_genuine_remote_delete_confirms_only_final_completion() {
    let (mut fixture, original, _artifacts) = readded_source_delete("failed", true).await;
    let recorder = Arc::new(RecordCompletionCommits {
        inner: fixture.sqlite.clone(),
        commits: Mutex::default(),
    });
    reopen_with(&mut fixture, recorder.clone()).await;
    let before = fixture.runtime.require_snapshot(&fixture.source).unwrap();
    let target = fixture.runtime.require_snapshot(&fixture.target).unwrap();
    let expected = expected_completion(&before, &target, "legacyFailed");
    let observed = CompletionObservations::start(&fixture);
    let guard = prepare(&fixture, 1).await;
    let request = legacy_request(&original, CrossAccountMoveStep::SourceDelete);
    let outcome: Value = serde_json::from_slice(&historical_effect(&fixture, &request)).unwrap();
    assert_eq!(outcome["result"]["status"], "applied");
    assert_eq!(
        fixture.runtime.require_snapshot(&fixture.source).unwrap(),
        before
    );
    assert!(fixture.http.source.server.created_items().is_empty());
    fixture.http.delete_result.release.add_permits(2);
    let start = fixture.http.requests.lock().unwrap().len();
    confirm(&fixture, guard).await;
    assert_lookup_then_final_reads(&fixture, start);
    assert_final_commit(&fixture, &recorder, &before, &expected).await;
    assert_eq!(
        fixture.runtime.require_snapshot(&fixture.target).unwrap(),
        target
    );
    let replays = fixture.http.mutations(SOURCE_ORIGIN);
    assert_eq!(replays.len(), 2);
    assert_original_request(&replays[1], &request);
    assert_eq!(fixture.http.mutations(TARGET_ORIGIN).len(), 1);
    observed.assert_completed();
    observed.close();
    fixture.runtime.close().await;
}

struct LoseCompletionReply {
    recorder: Arc<RecordCompletionCommits>,
    lost: AtomicBool,
}
#[async_trait]
impl SerializedReplicaExecutor for LoseCompletionReply {
    async fn invoke(&self, request: String) -> Result<String, RuntimeError> {
        let input: Value = serde_json::from_str(&request).unwrap();
        let completion = input["type"] == "commit"
            && input["prepared"]["writes"]
                .as_array()
                .is_some_and(|writes| {
                    writes.iter().any(|write| {
                        write["type"] == "put"
                            && write["row"]["store"] == "crossAccountMoves"
                            && write["row"]["key"]["recordId"] == SEMANTIC
                            && serde_json::from_str::<Value>(
                                write["row"]["payloadJson"].as_str().unwrap(),
                            )
                            .unwrap()["stage"]
                                == json!({"type":"completed"})
                    })
                });
        let reply = self.recorder.invoke(request).await?;
        if completion && !self.lost.swap(true, Ordering::SeqCst) {
            let result: Value = serde_json::from_str(&reply).unwrap();
            assert_eq!(result["type"], "committed");
            assert_eq!(result["result"]["type"], "applied");
            return Err(RuntimeError::new(
                RuntimeErrorCode::StorageUnavailable,
                "lost actual final completion commit reply",
            ));
        }
        Ok(reply)
    }
}

#[tokio::test]
async fn lost_final_completion_reply_reopens_locked_sqlite_without_intermediate_authorization() {
    let (mut fixture, original, _artifacts) = readded_source_delete("failed", true).await;
    let recorder = Arc::new(RecordCompletionCommits {
        inner: fixture.sqlite.clone(),
        commits: Mutex::default(),
    });
    let losing = Arc::new(LoseCompletionReply {
        recorder: recorder.clone(),
        lost: AtomicBool::new(false),
    });
    reopen_with(&mut fixture, losing.clone()).await;
    let request = legacy_request(&original, CrossAccountMoveStep::SourceDelete);
    let outcome: Value = serde_json::from_slice(&historical_effect(&fixture, &request)).unwrap();
    assert_eq!(outcome["result"]["status"], "applied");
    let before = fixture.runtime.require_snapshot(&fixture.source).unwrap();
    let target = fixture.runtime.require_snapshot(&fixture.target).unwrap();
    let expected = expected_completion(&before, &target, "legacyFailed");
    let observed = CompletionObservations::start(&fixture);
    let guard = prepare(&fixture, 1).await;
    fixture.http.delete_result.release.add_permits(2);
    let error = fixture
        .runtime
        .request(
            RuntimeRequest::ResumeCrossAccountMove {
                guard: guard.clone(),
            },
            RequestCancellation::new(),
        )
        .await
        .unwrap_err();
    assert_eq!(error.code, RuntimeErrorCode::StorageUnavailable);
    assert!(losing.lost.load(Ordering::SeqCst));
    observed.assert_no_pending();
    observed.close();
    let durable = durable_rows(&fixture.database.0, &fixture.source).await;
    assert_eq!(workflow(&durable, SEMANTIC), expected);
    assert!(!durable.iter().any(|row| row["store"] == "optimisticItems"));
    let source_writes = fixture.http.mutations(SOURCE_ORIGIN).len();
    let target_writes = fixture.http.mutations(TARGET_ORIGIN).len();
    assert_eq!(source_writes, 2);
    fixture.sqlite = MoveSqlite::open(&fixture.database.0);
    let plain = fixture.sqlite.clone();
    // Existing helper asserts source-free open does no HTTP, both Accounts open Locked,
    // real QuickUnlock succeeds, and durable rows remain byte-exact across reopen.
    reopen_with(&mut fixture, plain).await;
    assert_eq!(
        durable_rows(&fixture.database.0, &fixture.source).await,
        durable
    );
    assert_final_commit(&fixture, &recorder, &before, &expected).await;
    let observed = CompletionObservations::start(&fixture);
    observed.assert_completed();
    let calls = fixture.http.requests.lock().unwrap().len();
    assert!(fixture
        .runtime
        .request(
            RuntimeRequest::ResumeCrossAccountMove { guard },
            RequestCancellation::new()
        )
        .await
        .is_err());
    assert_eq!(fixture.http.requests.lock().unwrap().len(), calls);
    assert_eq!(
        durable_rows(&fixture.database.0, &fixture.source).await,
        durable
    );
    assert_eq!(fixture.http.mutations(SOURCE_ORIGIN).len(), source_writes);
    assert_eq!(fixture.http.mutations(TARGET_ORIGIN).len(), target_writes);
    assert_original_request(&fixture.http.mutations(SOURCE_ORIGIN)[1], &request);
    assert!(fixture.http.source.server.created_items().is_empty());
    assert_eq!(fixture.http.source.server.outcomes.lock().unwrap().len(), 2);
    assert_eq!(
        fixture.http.target.server.created_items(),
        vec![TARGET_ITEM.to_owned()]
    );
    observed.close();
    fixture.runtime.close().await;
}
