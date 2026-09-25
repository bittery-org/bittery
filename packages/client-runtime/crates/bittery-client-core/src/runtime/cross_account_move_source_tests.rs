//! Source refusal and fresh edits never become permission to finish destructive Move steps.
use super::*;

#[tokio::test]
async fn lost_source_trash_refusal_preserves_original_source_and_target_proof() {
    let mut http = MoveHttp::new();
    Arc::get_mut(&mut http)
        .unwrap()
        .source
        .use_shared_member(&[41; 32]);
    let fixture = AdmittedMoveFixture::with_http(http).await;
    let source_before = fixture.http.source.server.created_items.lock().unwrap()[0].clone();
    fixture.http.offline.store(false, Ordering::SeqCst);
    fixture.http.resumed.store(true, Ordering::SeqCst);
    // The Server revokes this real Member's write role after offline admission, before Sync.
    fixture
        .http
        .source
        .set_vault_role(crate::server_contract::VaultRole::ReadOnly);
    fixture.http.source.server.reject_next("vault_read_only");
    fixture.http.source.server.lose_next_response();
    let runner = tokio::spawn(fixture.runtime.clone().run_operation_dispatch());
    fixture
        .http
        .trash_result
        .wait("retained source trash refusal before its lost reply")
        .await;
    let before = workflow(
        &durable_rows(&fixture.database.0, &fixture.source).await,
        &fixture.operation_id,
    );
    let children = before["children"].as_array().unwrap();
    assert_eq!(children.len(), 2);
    assert_eq!(children[0]["result"]["result"]["type"], "applied");
    assert!(children[1]["result"].is_null());
    let original = fixture.http.mutations(SOURCE_ORIGIN)[0].clone();
    let child_id = original.header("idempotency-key").unwrap();
    assert_eq!(original.header("if-match"), Some("\"1\""));
    assert!(matches!(
        fixture.http.source.server.outcomes.lock().unwrap()[child_id].result,
        StoredResult::ExistingItemRejected {
            kind: "trash_item",
            code: "vault_read_only"
        }
    ));
    assert_source_visible(
        &fixture.runtime,
        &fixture.source,
        crate::ItemProjectionStatus::Pending,
    );
    // Deliver the lost response, then allow one exact replay of the retained refusal.
    fixture.http.trash_result.release.add_permits(2);
    let rejected = tokio::time::timeout(Duration::from_secs(10), async {
        while resolution(&fixture.runtime, &fixture.source, &fixture.operation_id)
            != OperationResolution::Rejected
        {
            tokio::task::yield_now().await;
        }
    })
    .await;
    runner.abort();
    let _ = runner.await;
    rejected.expect("the original trash refusal must be retained as a terminal rejection");
    assert_source_visible(
        &fixture.runtime,
        &fixture.source,
        crate::ItemProjectionStatus::Failed,
    );
    let mutations = fixture.http.mutations(SOURCE_ORIGIN);
    assert_eq!(mutations.len(), 2);
    assert_exact_retry(&mutations[1], &original);
    assert!(!mutations
        .iter()
        .any(|request| request.url.ends_with("/permanent")));
    assert_eq!(fixture.http.mutations(TARGET_ORIGIN).len(), 1);
    assert_eq!(
        fixture.http.target.server.created_items(),
        vec![before["target"]["id"].as_str().unwrap().to_owned()]
    );
    {
        let source_after = fixture.http.source.server.created_items.lock().unwrap();
        assert_eq!(source_after.len(), 1);
        assert_eq!(item_body(&source_after[0]), item_body(&source_before));
    }
    let mut after = workflow(
        &durable_rows(&fixture.database.0, &fixture.source).await,
        &fixture.operation_id,
    );
    assert_eq!(after["stage"]["type"], "rejected");
    assert_eq!(
        after["disposition"],
        json!({"type":"rejected", "code":"vault_read_only"})
    );
    assert_eq!(after["children"].as_array().unwrap().len(), 2);
    assert_eq!(
        after["children"][1]["result"]["result"],
        json!({"type":"rejected", "code":"vault_read_only"})
    );
    after["children"][1]["result"] = Value::Null;
    for field in ["stage", "disposition", "scheduling"] {
        after[field] = before[field].clone();
    }
    assert_eq!(
        after, before,
        "only terminal evidence and retry scheduling can change"
    );
    fixture.runtime.close().await;
}

#[tokio::test]
async fn source_edit_after_target_proof_blocks_source_destruction_without_recreating_target() {
    let fixture = AdmittedMoveFixture::new().await;
    fixture.http.offline.store(false, Ordering::SeqCst);
    let runner = tokio::spawn(fixture.runtime.clone().run_operation_dispatch());
    fixture
        .http
        .recovery
        .wait("fresh target verification after the create proof is durable")
        .await;
    let before = workflow(
        &durable_rows(&fixture.database.0, &fixture.source).await,
        &fixture.operation_id,
    );
    assert_eq!(before["children"].as_array().unwrap().len(), 1);
    assert_eq!(before["children"][0]["result"]["result"]["type"], "applied");
    assert_eq!(before["stage"]["type"], "sourceTrash");
    // Another writer changes current Server metadata while the accepted ciphertext stays fixed.
    let changed = {
        let mut source = fixture.http.source.server.created_items.lock().unwrap();
        source[0].favorite = true;
        source[0].version = 2;
        item_body(&source[0])
    };
    fixture.http.resumed.store(true, Ordering::SeqCst);
    fixture.http.recovery.release.add_permits(1);
    let blocked = tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            let RuntimeProjection::Operations(operations) = fixture
                .runtime
                .projection(&ObservationRequest::Operations {
                    account_id: fixture.source.clone(),
                })
                .unwrap()
                .projection
            else {
                panic!("expected source Operations");
            };
            assert_eq!(operations.operations.len(), 1);
            let operation = &operations.operations[0];
            assert_eq!(operation.operation_id, fixture.operation_id);
            if operation.cross_account_move.as_ref().unwrap().disposition
                == (crate::CrossAccountMoveDisposition::Blocked {
                    reason: crate::CrossAccountMoveBlockedReason::SourceChanged,
                })
            {
                assert_eq!(operation.resolution, OperationResolution::Pending);
                break;
            }
            tokio::task::yield_now().await;
        }
    })
    .await;
    runner.abort();
    let _ = runner.await;
    blocked.expect("fresh source metadata must fence source destruction");
    assert_source_visible(
        &fixture.runtime,
        &fixture.source,
        crate::ItemProjectionStatus::Pending,
    );
    assert!(fixture.http.mutations(SOURCE_ORIGIN).is_empty());
    assert_eq!(fixture.http.mutations(TARGET_ORIGIN).len(), 1);
    assert_eq!(
        fixture.http.target.server.created_items(),
        vec![before["target"]["id"].as_str().unwrap().to_owned()]
    );
    assert_eq!(
        item_body(&fixture.http.source.server.created_items.lock().unwrap()[0]),
        changed
    );
    let mut after = workflow(
        &durable_rows(&fixture.database.0, &fixture.source).await,
        &fixture.operation_id,
    );
    assert_eq!(
        after["disposition"],
        json!({"type":"blocked", "reason":"sourceChanged"})
    );
    after["disposition"] = before["disposition"].clone();
    assert_eq!(
        after, before,
        "fresh conflict must preserve all accepted bytes and proved target evidence"
    );
    fixture.runtime.close().await;
}
