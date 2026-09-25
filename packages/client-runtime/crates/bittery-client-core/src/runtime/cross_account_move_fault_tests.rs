//! Cross-Account Move reconciles retained results with current Server authority.
use super::*;

#[tokio::test]
async fn lost_target_create_rejection_replays_exact_request_without_destroying_source() {
    let mut http = MoveHttp::new();
    Arc::get_mut(&mut http)
        .unwrap()
        .target
        .use_shared_member(&TARGET_KEY);
    let AdmittedMoveFixture {
        database,
        http,
        runtime,
        source,
        target,
        operation_id,
        ..
    } = AdmittedMoveFixture::with_http(http).await;
    let source_rows = durable_rows(&database.0, &source).await;
    let target_rows = durable_rows(&database.0, &target).await;
    let accepted = workflow(&source_rows, &operation_id);
    assert_eq!(accepted["children"].as_array().unwrap().len(), 1);
    let original_child = accepted["children"][0].clone();
    let create_id = original_child["operationId"].as_str().unwrap();
    assert!(original_child["result"].is_null());

    // Admission used genuine RSA Member authority. The Server revokes write access before the
    // first create, and retains its ordinary closed refusal even though that reply is lost.
    http.target
        .set_vault_role(crate::server_contract::VaultRole::ReadOnly);
    http.target.server.reject_next("vault_read_only");
    http.target.server.lose_next_response();
    http.offline.store(false, Ordering::SeqCst);
    let runner = tokio::spawn(runtime.clone().run_operation_dispatch());
    let recovering =
        tokio::time::timeout(Duration::from_secs(10), http.recovery.reached.acquire()).await;
    match recovering {
        Ok(Ok(permit)) => permit.forget(),
        _ => {
            close_move_runtime(runtime, runner).await;
            panic!("the lost target refusal must reach retained-result recovery");
        }
    }
    let held = workflow(&durable_rows(&database.0, &source).await, &operation_id);
    assert_eq!(held["children"], accepted["children"]);
    assert_eq!(
        resolution(&runtime, &source, &operation_id),
        OperationResolution::Pending
    );
    assert_source_visible(&runtime, &source, crate::ItemProjectionStatus::Pending);
    {
        let outcomes = http.target.server.outcomes.lock().unwrap();
        assert_eq!(outcomes.len(), 1);
        assert!(matches!(
            outcomes[create_id].result,
            StoredResult::ItemRejected {
                code: "vault_read_only"
            }
        ));
    }
    assert_eq!(http.target.server.creates(), 1);
    assert!(http.target.server.created_items().is_empty());
    assert!(http.mutations(SOURCE_ORIGIN).is_empty());
    let first_create = http.mutations(TARGET_ORIGIN);
    assert_eq!(first_create.len(), 1);
    assert_eq!(first_create[0].header("idempotency-key"), Some(create_id));
    assert_eq!(first_create[0].method, "PUT");
    let path = first_create[0].url.strip_prefix(TARGET_ORIGIN).unwrap();
    let accepted_request = stored_request(&original_child, "PUT", path)
        .expect("the original destination request must already be durable at admission");
    assert_eq!(accepted_request["body"], json!(first_create[0].body));

    http.resumed.store(true, Ordering::SeqCst);
    http.recovery.release.add_permits(1);
    let rejected = tokio::time::timeout(Duration::from_secs(10), async {
        while resolution(&runtime, &source, &operation_id) != OperationResolution::Rejected {
            tokio::task::yield_now().await;
        }
    })
    .await;
    runner.abort();
    let _ = runner.await;
    if rejected.is_err() {
        let row = workflow(&durable_rows(&database.0, &source).await, &operation_id);
        panic!(
            "retained create refusal did not finish: stage={}, disposition={}, resolution={:?}, target_mutations={}, outcome_lookups={}, source_mutations={}, child_has_result={}",
            row["stage"],
            row["disposition"],
            resolution(&runtime, &source, &operation_id),
            http.mutations(TARGET_ORIGIN).len(),
            http.target.server.outcome_lookups(),
            http.mutations(SOURCE_ORIGIN).len(),
            !row["children"][0]["result"].is_null(),
        );
    }

    let requests = http.mutations(TARGET_ORIGIN);
    assert_eq!(
        requests.len(),
        2,
        "one original create and its exact retained replay"
    );
    assert_exact_retry(&requests[1], &first_create[0]);
    assert!(http.target.server.outcome_lookups() >= 2);
    assert!(http.target.server.created_items().is_empty());
    assert!(http.mutations(SOURCE_ORIGIN).is_empty());
    assert!(http.source.server.outcomes.lock().unwrap().is_empty());
    {
        let items = http.source.server.created_items.lock().unwrap();
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].id, SOURCE_ITEM);
        assert_eq!(items[0].version, 1);
        assert!(items[0].deleted_at.is_none());
    }
    assert_source_visible(&runtime, &source, crate::ItemProjectionStatus::Failed);
    let RuntimeProjection::Operations(operations) = runtime
        .projection(&ObservationRequest::Operations {
            account_id: source.clone(),
        })
        .unwrap()
        .projection
    else {
        panic!("expected public Operations");
    };
    assert_eq!(operations.operations.len(), 1);
    assert_eq!(
        operations.operations[0].rejection_code.as_deref(),
        Some("vault_read_only")
    );
    assert!(
        operations.operations[0]
            .cross_account_move
            .as_ref()
            .unwrap()
            .source_visible
    );

    let final_rows = durable_rows(&database.0, &source).await;
    let persisted = workflow(&final_rows, &operation_id);
    assert_eq!(persisted["source"], accepted["source"]);
    assert_eq!(persisted["target"], accepted["target"]);
    assert_eq!(
        persisted["destinationBinding"],
        accepted["destinationBinding"]
    );
    assert_eq!(persisted["stage"], json!({"type":"rejected"}));
    assert_eq!(
        persisted["disposition"],
        json!({"type":"rejected", "code":"vault_read_only"})
    );
    assert_eq!(persisted["children"].as_array().unwrap().len(), 1);
    assert_eq!(
        persisted["children"][0]["result"]["result"],
        json!({"type":"rejected", "code":"vault_read_only"})
    );
    let mut expected_child = original_child;
    expected_child["result"] = persisted["children"][0]["result"].clone();
    assert_eq!(persisted["children"][0], expected_child);
    assert!(!final_rows.iter().any(|row| row["store"] == "operations"));
    let authority = |rows: &[Value]| {
        rows.iter()
            .filter(|row| row["store"] == "authorityItems")
            .cloned()
            .collect::<Vec<_>>()
    };
    assert_eq!(authority(&final_rows), authority(&source_rows));
    assert_eq!(durable_rows(&database.0, &target).await, target_rows);
    tokio::time::timeout(Duration::from_secs(5), runtime.close())
        .await
        .unwrap();
}

#[tokio::test]
async fn target_lock_cancels_active_recovery_and_unlock_replays_the_original_create() {
    let fixture = AdmittedMoveFixture::new().await;
    fixture.http.target.server.lose_next_response();
    fixture.http.offline.store(false, Ordering::SeqCst);
    let runner = tokio::spawn(fixture.runtime.clone().run_operation_dispatch());
    fixture
        .http
        .recovery
        .wait("in-flight target authority after the committed create reply was lost")
        .await;
    let before = durable_rows(&fixture.database.0, &fixture.source).await;
    let accepted = workflow(&before, &fixture.operation_id);
    assert_eq!(accepted["children"].as_array().unwrap().len(), 1);
    assert!(accepted["children"][0]["result"].is_null());
    let original = fixture.http.mutations(TARGET_ORIGIN);
    assert_eq!(original.len(), 1);
    let original = &original[0];
    assert_eq!(
        fixture.http.target.server.created_items(),
        vec![accepted["target"]["id"].as_str().unwrap().to_owned()]
    );
    assert!(fixture.http.mutations(SOURCE_ORIGIN).is_empty());

    // The source dispatcher owns both execution fences and is awaiting a target request. Public
    // target Lock must cancel that attempt before waiting for either execution fence to drain.
    let locked = tokio::time::timeout(
        Duration::from_secs(5),
        fixture.runtime.request(
            RuntimeRequest::Lock {
                account_id: fixture.target.clone(),
            },
            RequestCancellation::new(),
        ),
    )
    .await;
    if !matches!(locked, Ok(Ok(_))) {
        fixture.http.recovery.release.add_permits(1);
        close_move_runtime(fixture.runtime, runner).await;
        panic!("target Lock must promptly cancel and drain the held cross-Account attempt");
    }
    assert_eq!(
        fixture.runtime.account_access_state(&fixture.target),
        Some(AccountAccessState::Locked)
    );
    assert_eq!(
        durable_rows(&fixture.database.0, &fixture.source).await,
        before,
        "target cancellation must preserve every accepted source row and unproved child"
    );
    assert_source_visible(
        &fixture.runtime,
        &fixture.source,
        crate::ItemProjectionStatus::Pending,
    );
    let RuntimeProjection::Operations(operations) = fixture
        .runtime
        .projection(&ObservationRequest::Operations {
            account_id: fixture.source.clone(),
        })
        .unwrap()
        .projection
    else {
        panic!("expected public Operations")
    };
    assert_eq!(operations.operations.len(), 1);
    assert_eq!(
        operations.operations[0].resolution,
        OperationResolution::Pending
    );
    assert_eq!(
        operations.operations[0]
            .cross_account_move
            .as_ref()
            .unwrap()
            .disposition,
        crate::CrossAccountMoveDisposition::Waiting {
            reason: crate::CrossAccountMoveWaitingReason::AccountLocked,
        }
    );
    assert!(fixture.http.mutations(SOURCE_ORIGIN).is_empty());
    assert_eq!(fixture.http.mutations(TARGET_ORIGIN).len(), 1);
    {
        let source = fixture.http.source.server.created_items.lock().unwrap();
        assert_eq!(source.len(), 1);
        assert_eq!(source[0].version, 1);
        assert!(source[0].deleted_at.is_none());
    }
    assert_eq!(accepted["destinationBinding"]["status"], "active");

    fixture.http.resumed.store(true, Ordering::SeqCst);
    fixture.http.recovery.release.add_permits(1);
    fixture.http.trash_result.release.add_permits(1);
    fixture.http.delete_result.release.add_permits(1);
    fixture
        .runtime
        .request(
            quick_unlock_request(fixture.target.as_str()),
            RequestCancellation::new(),
        )
        .await
        .unwrap();
    let completed = tokio::time::timeout(Duration::from_secs(10), async {
        while resolution(&fixture.runtime, &fixture.source, &fixture.operation_id)
            != OperationResolution::Applied
        {
            tokio::task::yield_now().await;
        }
    })
    .await;
    runner.abort();
    let _ = runner.await;
    completed.expect("QuickUnlock must resume the exact existing cross-Account workflow");
    let creates = fixture.http.mutations(TARGET_ORIGIN);
    assert_eq!(creates.len(), 2);
    assert_exact_retry(&creates[1], original);
    assert_eq!(
        fixture.http.target.server.created_items(),
        vec![accepted["target"]["id"].as_str().unwrap().to_owned()]
    );
    assert!(fixture.http.source.server.created_items().is_empty());
    assert_eq!(fixture.http.mutations(SOURCE_ORIGIN).len(), 2);
    let persisted = workflow(
        &durable_rows(&fixture.database.0, &fixture.source).await,
        &fixture.operation_id,
    );
    assert_eq!(persisted["stage"], json!({"type":"completed"}));
    assert_eq!(persisted["source"], accepted["source"]);
    assert_eq!(persisted["target"], accepted["target"]);
    assert_eq!(
        persisted["destinationBinding"],
        accepted["destinationBinding"]
    );
    assert_eq!(persisted["children"].as_array().unwrap().len(), 3);
    assert!(persisted["children"]
        .as_array()
        .unwrap()
        .iter()
        .all(|child| child["result"]["result"]["type"] == "applied"));
    let mut expected_child = accepted["children"][0].clone();
    expected_child["result"] = persisted["children"][0]["result"].clone();
    assert_eq!(persisted["children"][0], expected_child);
    tokio::time::timeout(Duration::from_secs(5), fixture.runtime.close())
        .await
        .unwrap();
}

#[tokio::test]
async fn retained_target_create_cannot_recreate_a_missing_target_or_destroy_the_source() {
    let AdmittedMoveFixture {
        database,
        http,
        runtime,
        source,
        operation_id,
        ..
    } = AdmittedMoveFixture::new().await;
    let accepted = workflow(&durable_rows(&database.0, &source).await, &operation_id);
    let create = accepted["children"][0].clone();
    let create_id = create["operationId"].as_str().unwrap();
    let original_target = accepted["target"]["id"].as_str().unwrap();
    http.offline.store(false, Ordering::SeqCst);
    http.target.server.lose_next_response();
    let runner = tokio::spawn(runtime.clone().run_operation_dispatch());
    http.recovery
        .wait("recovery after the committed target create response was lost")
        .await;
    assert_eq!(
        http.target.server.created_items(),
        vec![original_target.to_owned()]
    );
    assert_eq!(http.target.server.creates(), 1);
    assert!(
        matches!(&http.target.server.outcomes.lock().unwrap()[create_id].result,
        StoredResult::Applied { item_id, version: 1 } if item_id == original_target)
    );
    assert!(http.mutations(SOURCE_ORIGIN).is_empty());

    // A different Server writer removes the target while the original create receipt survives.
    http.target.server.created_items.lock().unwrap().clear();
    http.resumed.store(true, Ordering::SeqCst);
    http.recovery.release.add_permits(1);
    tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            let RuntimeProjection::Operations(operations) = runtime
                .projection(&ObservationRequest::Operations {
                    account_id: source.clone(),
                })
                .unwrap()
                .projection
            else {
                panic!("expected Operations")
            };
            assert_eq!(operations.operations.len(), 1);
            let operation = &operations.operations[0];
            assert_eq!(operation.operation_id, operation_id);
            assert_eq!(operation.resolution, OperationResolution::Pending);
            let progress = operation
                .cross_account_move
                .as_ref()
                .expect("Move progress is explicit");
            if matches!(
                &progress.disposition,
                crate::CrossAccountMoveDisposition::Blocked {
                    reason: crate::CrossAccountMoveBlockedReason::TargetChanged,
                }
            ) {
                assert!(progress.source_visible);
                break;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("current missing target must block the retained-create workflow");

    assert!(
        http.target.server.outcome_lookups() >= 1,
        "the surviving create result is known, but cannot stand in for current target authority"
    );
    assert_eq!(
        http.target.server.creates(),
        1,
        "the old create must not be dispatched again after current target absence"
    );
    assert!(http.target.server.created_items().is_empty());
    assert!(
        http.mutations(SOURCE_ORIGIN).is_empty(),
        "neither source trash nor permanent deletion is authorized by an absent target"
    );
    assert_source_visible(&runtime, &source, crate::ItemProjectionStatus::Pending);
    let persisted = workflow(&durable_rows(&database.0, &source).await, &operation_id);
    assert_eq!(persisted["source"], accepted["source"]);
    assert_eq!(persisted["target"], accepted["target"]);
    assert_eq!(
        persisted["children"], accepted["children"],
        "blocked recovery must conserve original child identities, request bytes and proof state"
    );
    assert_eq!(
        persisted["disposition"],
        json!({"type":"blocked", "reason":"targetChanged"})
    );
    close_move_runtime(runtime, runner).await;
}

#[tokio::test]
async fn rejected_source_permanent_delete_preserves_proved_steps_and_visible_source() {
    let AdmittedMoveFixture {
        database,
        http,
        runtime,
        source,
        operation_id,
        ..
    } = AdmittedMoveFixture::new().await;
    let accepted = workflow(&durable_rows(&database.0, &source).await, &operation_id);
    http.resumed.store(true, Ordering::SeqCst);
    http.offline.store(false, Ordering::SeqCst);
    let runner = tokio::spawn(runtime.clone().run_operation_dispatch());
    http.trash_result
        .wait("actual source trash after the matching target was verified")
        .await;
    assert_eq!(http.mutations(SOURCE_ORIGIN).len(), 1);
    assert_source_visible(&runtime, &source, crate::ItemProjectionStatus::Pending);

    // The next destructive request gets an HTTP 200 with a real retained refusal.
    http.source.server.reject_next("vault_read_only");
    http.trash_result.release.add_permits(1);
    http.delete_result
        .wait("the permanent-delete refusal before its response reaches Core")
        .await;
    let prepared = workflow(&durable_rows(&database.0, &source).await, &operation_id);
    assert_eq!(prepared["stage"], json!({"type":"sourceDelete"}));
    let prepared_children = prepared["children"].as_array().unwrap();
    assert_eq!(prepared_children.len(), 3);
    assert_eq!(prepared_children[0]["result"]["result"]["type"], "applied");
    assert_eq!(prepared_children[1]["result"]["result"]["type"], "applied");
    assert_eq!(prepared_children[1]["result"]["result"]["version"], 2);
    assert!(prepared_children[2]["result"].is_null());
    assert_eq!(
        resolution(&runtime, &source, &operation_id),
        OperationResolution::Pending
    );
    assert_source_visible(&runtime, &source, crate::ItemProjectionStatus::Pending);
    let delete_id = prepared_children[2]["operationId"].as_str().unwrap();
    assert!(matches!(
        &http.source.server.outcomes.lock().unwrap()[delete_id].result,
        StoredResult::ExistingItemRejected {
            kind: "permanently_delete_item",
            code: "vault_read_only",
        }
    ));
    http.delete_result.release.add_permits(1);

    tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            let RuntimeProjection::Operations(operations) = runtime
                .projection(&ObservationRequest::Operations {
                    account_id: source.clone(),
                })
                .unwrap()
                .projection
            else {
                panic!("expected Operations");
            };
            assert_eq!(operations.operations.len(), 1);
            let operation = &operations.operations[0];
            assert_eq!(operation.operation_id, operation_id);
            assert_ne!(operation.resolution, OperationResolution::Applied);
            if operation.resolution == OperationResolution::Rejected {
                assert_eq!(operation.rejection_code.as_deref(), Some("vault_read_only"));
                let progress = operation.cross_account_move.as_ref().unwrap();
                assert!(progress.source_visible);
                assert!(matches!(
                    &progress.disposition,
                    crate::CrossAccountMoveDisposition::Rejected { code }
                        if code == "vault_read_only"
                ));
                break;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("a proved permanent-delete refusal must reject rather than complete the Move");

    assert_source_visible(&runtime, &source, crate::ItemProjectionStatus::Failed);
    {
        let items = http.source.server.created_items.lock().unwrap();
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].id, SOURCE_ITEM);
        assert_eq!(items[0].version, 2);
        assert!(items[0].deleted_at.is_some());
    }
    assert_eq!(http.mutations(SOURCE_ORIGIN).len(), 2);
    assert_eq!(http.target.server.creates(), 1);
    assert_eq!(
        http.target.server.created_items(),
        vec![accepted["target"]["id"].as_str().unwrap().to_owned()]
    );
    let persisted = workflow(&durable_rows(&database.0, &source).await, &operation_id);
    assert_eq!(persisted["source"], accepted["source"]);
    assert_eq!(persisted["target"], accepted["target"]);
    assert_eq!(persisted["stage"], json!({"type":"rejected"}));
    assert_eq!(
        persisted["disposition"],
        json!({"type":"rejected", "code":"vault_read_only"})
    );
    let persisted_children = persisted["children"].as_array().unwrap();
    assert_eq!(persisted_children.len(), 3);
    assert_eq!(persisted_children[..2], prepared_children[..2]);
    for field in [
        "operationId",
        "request",
        "requestFingerprint",
        "kind",
        "target",
        "step",
    ] {
        assert_eq!(persisted_children[2][field], prepared_children[2][field]);
    }
    assert_eq!(
        persisted_children[2]["result"]["result"],
        json!({"type":"rejected", "code":"vault_read_only"})
    );
    let source_requests = http.mutations(SOURCE_ORIGIN);
    assert_eq!(
        source_requests[1].header("idempotency-key"),
        Some(delete_id)
    );
    assert_eq!(source_requests[1].header("if-match"), Some("\"2\""));
    assert!(source_requests[1]
        .url
        .ends_with("/items/item-existing/permanent"));
    close_move_runtime(runtime, runner).await;
}

#[tokio::test]
async fn fresh_sync_authority_releases_terminal_move_source_for_restore() {
    let AdmittedMoveFixture {
        database,
        http,
        runtime,
        source,
        operation_id,
        ..
    } = AdmittedMoveFixture::new().await;
    http.resumed.store(true, Ordering::SeqCst);
    http.offline.store(false, Ordering::SeqCst);
    let runner = tokio::spawn(runtime.clone().run_operation_dispatch());
    http.trash_result
        .wait("source Trash committed before the later permanent-delete refusal")
        .await;
    http.source.server.reject_next("vault_read_only");
    http.trash_result.release.add_permits(1);
    http.delete_result.release.add_permits(1);
    tokio::time::timeout(Duration::from_secs(10), async {
        while resolution(&runtime, &source, &operation_id) != OperationResolution::Rejected {
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("the original Move must have its proved terminal rejection");
    let rejected = workflow(&durable_rows(&database.0, &source).await, &operation_id);
    assert_eq!(rejected["children"].as_array().unwrap().len(), 3);
    assert_source_visible(&runtime, &source, crate::ItemProjectionStatus::Failed);

    let cursor = "move-source-trash-observed";
    *http.source.server.sync_cursor.lock().unwrap() = Some(cursor.into());
    http.source.server.script_sync_page(
        vec![json!({
            "id":cursor, "type":"item_deleted", "entityType":"item",
            "entityId":SOURCE_ITEM, "userId":"user-1", "vaultId":"vault-1",
            "clientId":null, "metadata":null, "timestamp":"1700000000000", "version":2
        })],
        cursor,
        false,
    );
    let syncing = tokio::spawn(runtime.clone().run_live_sync());
    tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            let rows = durable_rows(&database.0, &source).await;
            let observed = rows.iter().any(|row| {
                if row["store"] != "authorityItems" {
                    return false;
                }
                let item: Value =
                    serde_json::from_str(row["payloadJson"].as_str().unwrap()).unwrap();
                item["id"] == SOURCE_ITEM && item["version"] == 2 && !item["deletedAt"].is_null()
            });
            if observed {
                break;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("public live Sync must persist fresh trashed source authority");
    syncing.abort();
    let _ = syncing.await;
    http.offline.store(true, Ordering::SeqCst);

    let RuntimeResponse::Accepted {
        operation_id: restore_id,
        ..
    } = runtime
        .request(
            RuntimeRequest::RestoreItem {
                account_id: source.clone(),
                item_id: SOURCE_ITEM.into(),
            },
            RequestCancellation::new(),
        )
        .await
        .expect("fresh source authority must release the rejected Move's writer for Restore")
    else {
        panic!("expected a new accepted Restore");
    };
    assert_ne!(restore_id, operation_id);
    let rows = durable_rows(&database.0, &source).await;
    assert_eq!(
        workflow(&rows, &operation_id),
        rejected,
        "reconciliation and later editing must retain the original rejected workflow and children"
    );
    let restore = rows
        .iter()
        .find(|row| row["store"] == "operations" && row["key"]["recordId"] == restore_id)
        .map(|row| serde_json::from_str::<Value>(row["payloadJson"].as_str().unwrap()).unwrap())
        .expect("Restore is an ordinary durable Operation");
    assert_eq!(restore["request"]["method"], "POST");
    assert_eq!(
        restore["request"]["path"],
        "/api/v1/items/item-existing/restore"
    );
    assert!(restore["request"]["headers"]
        .as_array()
        .unwrap()
        .iter()
        .any(|header| header["name"] == "If-Match" && header["value"] == "\"2\""));
    assert_source_visible(&runtime, &source, crate::ItemProjectionStatus::Pending);
    assert_eq!(http.mutations(SOURCE_ORIGIN).len(), 2);
    assert_eq!(http.target.server.creates(), 1);
    assert_eq!(
        http.source.server.created_items(),
        vec![SOURCE_ITEM.to_owned()]
    );
    close_move_runtime(runtime, runner).await;
}
