//! Original remote completion is one final authorization commit, with no live Pending overlay.
use super::recovery_tests::{confirm, prepare, reopen_with};
use super::sourcedelete_tests::variants_tests::readded_source_delete;
use super::*;

#[path = "cross_account_legacy_held_completion_variants_tests.rs"]
mod variants_tests;

#[path = "cross_account_legacy_held_completion_cache_tests.rs"]
mod cache_tests;

#[path = "cross_account_legacy_held_unmaterialized_delete_tests.rs"]
mod unmaterialized_delete_tests;

#[path = "cross_account_legacy_held_earlier_prefix_completion_tests.rs"]
mod earlier_prefix_tests;

struct RecordCompletionCommits {
    inner: Arc<MoveSqlite>,
    commits: Mutex<Vec<Value>>,
}

#[async_trait]
impl SerializedReplicaExecutor for RecordCompletionCommits {
    async fn invoke(&self, request: String) -> Result<String, RuntimeError> {
        let input: Value = serde_json::from_str(&request).unwrap();
        let workflow_commit = input["type"] == "commit"
            && input["prepared"]["writes"]
                .as_array()
                .is_some_and(|writes| {
                    writes.iter().any(|write| {
                        write["type"] == "put"
                            && write["row"]["store"] == "crossAccountMoves"
                            && write["row"]["key"]["recordId"] == SEMANTIC
                    })
                });
        let reply = self.inner.invoke(request).await?;
        if workflow_commit {
            let result: Value = serde_json::from_str(&reply).unwrap();
            assert_eq!(result["type"], "committed");
            assert_eq!(result["result"]["type"], "applied");
            self.commits.lock().unwrap().push(input);
        }
        Ok(reply)
    }
}

#[tokio::test]
async fn stopped_remote_completion_confirms_one_final_revision_without_overlay_or_pending_publication(
) {
    let (mut fixture, original, _artifacts) = readded_source_delete("failed", true).await;
    let recorder = Arc::new(RecordCompletionCommits {
        inner: fixture.sqlite.clone(),
        commits: Mutex::default(),
    });
    reopen_with(&mut fixture, recorder.clone()).await;
    let delete_request = legacy_request(&original, CrossAccountMoveStep::SourceDelete);
    let outcome: Value =
        serde_json::from_slice(&historical_effect(&fixture, &delete_request)).unwrap();
    assert_eq!(outcome["operationId"], format!("{SEMANTIC}:delete-source"));
    assert_eq!(outcome["result"]["status"], "applied");
    assert_eq!(outcome["result"]["version"], original.source.version + 2);
    assert!(fixture.http.source.server.created_items().is_empty());
    let source_before = fixture.runtime.require_snapshot(&fixture.source).unwrap();
    let target_before = fixture.runtime.require_snapshot(&fixture.target).unwrap();
    let source_rows = durable_rows(&fixture.database.0, &fixture.source).await;
    let target_rows = durable_rows(&fixture.database.0, &fixture.target).await;
    let retired = workflow(&source_rows, SEMANTIC);
    assert_eq!(retired["destinationBinding"]["status"], "retired");
    assert_eq!(retired["destinationBinding"]["bindingRevision"], "1");
    assert_eq!(retired["children"].as_array().unwrap().len(), 3);
    assert!(retired["children"][2]["result"].is_null());
    assert_eq!(
        source_before
            .bootstrap
            .snapshot()
            .visible_items
            .iter()
            .find(|item| item.id == SOURCE_ITEM),
        Some(&original.source)
    );
    assert!(source_before.items.is_empty());
    let items = Arc::new(Sink::default());
    let operations = Arc::new(Sink::default());
    let item_observation = fixture
        .runtime
        .observe(
            ObservationRequest::Items {
                account_id: fixture.source.clone(),
            },
            items.clone(),
        )
        .unwrap();
    let operation_observation = fixture
        .runtime
        .observe(
            ObservationRequest::Operations {
                account_id: fixture.source.clone(),
            },
            operations.clone(),
        )
        .unwrap();
    let requests_before_prepare = fixture.http.requests.lock().unwrap().len();
    // Behavioral RED: the prior SourceDelete continuation path refuses current source absence.
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
    assert_eq!(
        durable_rows(&fixture.database.0, &fixture.target).await,
        target_rows
    );
    assert!(recorder.commits.lock().unwrap().is_empty());
    let delete_lookup = format!("{SOURCE_ORIGIN}/api/v1/operations/{SEMANTIC}:delete-source");
    assert!(fixture
        .http
        .requests
        .lock()
        .unwrap()
        .iter()
        .skip(requests_before_prepare)
        .any(|request| request.method == "GET" && request.url == delete_lookup));
    assert_eq!(fixture.http.mutations(SOURCE_ORIGIN).len(), 1);
    assert_eq!(fixture.http.mutations(TARGET_ORIGIN).len(), 1);
    fixture.http.delete_result.release.add_permits(2);
    let requests_before_confirm = fixture.http.requests.lock().unwrap().len();
    confirm(&fixture, guard).await;
    let after = fixture.runtime.require_snapshot(&fixture.source).unwrap();
    assert_eq!(after.revision, source_before.revision + 1);
    assert_eq!(after.operations, source_before.operations);
    assert!(after.items.is_empty());
    assert!(!after
        .bootstrap
        .snapshot()
        .visible_items
        .iter()
        .any(|item| item.id == SOURCE_ITEM));
    assert_eq!(
        fixture.runtime.require_snapshot(&fixture.target).unwrap(),
        target_before
    );
    assert_eq!(
        durable_rows(&fixture.database.0, &fixture.target).await,
        target_rows
    );
    let completed_rows = durable_rows(&fixture.database.0, &fixture.source).await;
    let completed = workflow(&completed_rows, SEMANTIC);
    let mut expected = retired.clone();
    expected["destinationBinding"] = json!({"accountId":fixture.target,"incarnation":target_before.incarnation,"bindingRevision":"2","status":"active"});
    expected["legacyAdmission"]["disposition"] =
        json!({"destinationReauthorized":{"priorHold":"legacyFailed","bindingRevision":"2"}});
    expected["stage"] = json!({"type":"completed"});
    expected["disposition"] = json!({"type":"ready"});
    let child = original
        .legacy_item_child(CrossAccountMoveStep::SourceDelete)
        .unwrap()
        .unwrap();
    let child = child.item().unwrap();
    expected["children"][2]["result"] = serde_json::to_value(crate::replica::ObservedOutcome {
        operation_id: child.operation_id.clone(),
        request_fingerprint: child.request_fingerprint,
        result: crate::replica::OperationOutcomeResult::Applied {
            entity_id: original.source.id.clone(),
            version: original.source.version + 2,
        },
    })
    .unwrap();
    assert_eq!(
        completed, expected,
        "the single final row preserves the proved prefix, DTO/history, requests and schedule"
    );
    assert!(!completed_rows
        .iter()
        .any(|row| row["store"] == "optimisticItems"));
    {
        let commits = recorder.commits.lock().unwrap();
        assert_eq!(commits.len(), 1);
        let writes = commits[0]["prepared"]["writes"].as_array().unwrap();
        assert!(
            !writes
                .iter()
                .any(|write| write["type"] == "put" && write["row"]["store"] == "optimisticItems"),
            "actual SQLite plan cannot transiently install a Pending overlay"
        );
        let source_authority_key = format!(
            "{}/{}",
            source_before
                .bootstrap
                .active_generation
                .as_ref()
                .unwrap()
                .0,
            SOURCE_ITEM
        );
        assert!(
            writes.iter().any(|write| write["type"] == "delete"
                && write["store"] == "authorityItems"
                && write["key"]["recordId"] == source_authority_key),
            "the same final commit removes current source authority"
        );
        let workflow_write = writes
            .iter()
            .find(|write| write["row"]["store"] == "crossAccountMoves")
            .unwrap();
        assert_eq!(
            serde_json::from_str::<Value>(workflow_write["row"]["payloadJson"].as_str().unwrap())
                .unwrap(),
            completed
        );
    }
    let recent = fixture.http.requests.lock().unwrap()[requests_before_confirm..].to_vec();
    let lookup = recent
        .iter()
        .position(|request| request.method == "GET" && request.url == delete_lookup)
        .unwrap();
    let replay = recent
        .iter()
        .position(|request| {
            request.header("Idempotency-Key") == Some(format!("{SEMANTIC}:delete-source").as_str())
        })
        .unwrap();
    assert!(lookup < replay);
    for (origin, item_id) in [(SOURCE_ORIGIN, SOURCE_ITEM), (TARGET_ORIGIN, TARGET_ITEM)] {
        let current_url = format!("{origin}/api/v1/items/{item_id}");
        assert!(
            recent
                .iter()
                .skip(replay + 1)
                .any(|request| request.method == "GET" && request.url == current_url),
            "confirmation rereads each current Item after replay"
        );
    }
    let source_replays = fixture.http.mutations(SOURCE_ORIGIN);
    assert_eq!(source_replays.len(), 2);
    assert_original_request(
        &source_replays[0],
        &legacy_request(&original, CrossAccountMoveStep::SourceTrash),
    );
    assert_original_request(&source_replays[1], &delete_request);
    assert_eq!(fixture.http.mutations(TARGET_ORIGIN).len(), 1);
    assert_eq!(fixture.http.source.server.outcomes.lock().unwrap().len(), 2);
    assert_eq!(fixture.http.target.server.outcomes.lock().unwrap().len(), 1);
    assert_eq!(
        fixture.http.target.server.created_items(),
        vec![TARGET_ITEM.to_owned()]
    );
    assert_eq!(
        resolution(&fixture.runtime, &fixture.source, SEMANTIC),
        OperationResolution::Applied
    );
    {
        let observed = items.0.lock().unwrap();
        assert!(observed.iter().all(|projection| match projection {
            RuntimeProjection::Items(items) => items
                .items
                .iter()
                .all(|item| item.status != crate::ItemProjectionStatus::Pending),
            _ => false,
        }));
        assert!(
            matches!(observed.last(), Some(RuntimeProjection::Items(items)) if items.items.is_empty())
        );
    }
    {
        let observed = operations.0.lock().unwrap();
        assert!(observed.iter().all(|projection| match projection {
            RuntimeProjection::Operations(operations) => operations
                .operations
                .iter()
                .all(|operation| operation.operation_id != SEMANTIC
                    || operation.resolution != OperationResolution::Pending),
            _ => false,
        }));
        assert!(
            matches!(observed.last(), Some(RuntimeProjection::Operations(operations)) if operations.operations.iter().any(|operation| operation.operation_id == SEMANTIC && operation.resolution == OperationResolution::Applied))
        );
    }
    item_observation.close();
    operation_observation.close();
    fixture.runtime.close().await;
}
