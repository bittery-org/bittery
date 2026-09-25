//! Legacy workflow requests reach the existing two-Server dispatcher without reminting children.
use super::*;
use crate::replica::{
    CrossAccountMoveBindingStatus, CrossAccountMoveDestinationBinding, CrossAccountMoveIdentity,
    CrossAccountMoveRecord, LegacyCrossAccountMoveAdmission,
};

#[path = "cross_account_legacy_scheduling_tests.rs"]
mod scheduling_tests;

#[path = "cross_account_legacy_remote_progress_tests.rs"]
mod remote_progress_tests;

#[path = "cross_account_legacy_held_tests.rs"]
mod held_tests;

const SEMANTIC: &str = "legacy-move";
const TARGET_ITEM: &str = "legacy-target-item";

async fn admitted_legacy_move() -> (AdmittedMoveFixture, CrossAccountMoveRecord) {
    admitted_legacy_move_with_history(json!({}), None).await
}

async fn admitted_legacy_move_with_history(
    history: Value,
    time: Option<&scheduling_tests::DispatchTime>,
) -> (AdmittedMoveFixture, CrossAccountMoveRecord) {
    admitted_legacy_move_with_http_and_history(history, time, MoveHttp::new()).await
}

async fn admitted_legacy_move_with_http_and_history(
    history: Value,
    time: Option<&scheduling_tests::DispatchTime>,
    http: Arc<MoveHttp>,
) -> (AdmittedMoveFixture, CrossAccountMoveRecord) {
    let database = MoveDatabase::new();
    let platform = Arc::new(InstallationPlatform::default());
    let sqlite = MoveSqlite::open(&database.0);
    let runtime = if let Some(time) = time {
        time.open(sqlite.clone(), platform.clone(), http.clone())
            .await
    } else {
        open_move_runtime(sqlite.clone(), platform.clone(), http.clone()).await
    };
    let (source, target) = sign_in_move_accounts(&runtime).await;
    http.offline.store(true, Ordering::SeqCst);
    let source_snapshot = runtime.require_snapshot(&source).unwrap();
    let target_snapshot = runtime.require_snapshot(&target).unwrap();
    let original = source_snapshot.bootstrap.snapshot().visible_items[0].clone();
    let (_, ciphertext) =
        sealed_login_item_with_key(TARGET_ITEM, "Original Login", "move-password", &TARGET_KEY);
    let mut destination = original.clone();
    destination.id = TARGET_ITEM.into();
    destination.favorite = false;
    destination.version = 1;
    destination.encryption_version = 1;
    destination.encrypted_by_user_id = target_snapshot.user_id.clone();
    destination.last_modified_by = target_snapshot.user_id.clone();
    destination.encrypted_data = ciphertext["encryptedData"].as_str().unwrap().into();
    destination.encryption_iv = ciphertext["encryptionIv"].as_str().unwrap().into();
    destination.encryption_algorithm = ciphertext["encryptionAlgorithm"].as_str().unwrap().into();
    destination.created_at = crate::replica::source_timestamp(1_770_000_000_000).unwrap();
    destination.updated_at = destination.created_at.clone();
    let mut admission = json!({
        "version":1,"admissionId":"legacy-profile","sourceQueueIndex":"0","disposition":"normal",
        "sourceCommand":{
            "accountId":source,"id":"legacy-source-command","operationId":SEMANTIC,"attemptId":"legacy-attempt",
            "type":"cross_account_move","entityId":SOURCE_ITEM,"vaultId":"vault-1","category":"login",
            "targetAccountId":target,"targetVaultId":"vault-1","targetItemId":TARGET_ITEM,
            "encryptedPayload":{"type":"target","encryptionVersion":1,"encryptedByUserId":target_snapshot.user_id},
            "baseVersion":original.version,"timestamp":"1770000000000","retryCount":"0","status":"pending"
        }
    });
    let command = admission["sourceCommand"].as_object_mut().unwrap();
    for (field, value) in history.as_object().unwrap() {
        if value.is_null() {
            command.remove(field);
        } else {
            command.insert(field.clone(), value.clone());
        }
    }
    admission["disposition"] = match admission["sourceCommand"]["status"].as_str() {
        Some("failed") => json!("legacyFailed"),
        Some("conflicted") => json!("legacyConflicted"),
        _ => json!("normal"),
    };
    let admission: LegacyCrossAccountMoveAdmission = serde_json::from_value(admission).unwrap();
    let record = admission
        .bind(
            CrossAccountMoveIdentity {
                server_url: SOURCE_ORIGIN.into(),
                user_id: source_snapshot.user_id.clone(),
            },
            CrossAccountMoveIdentity {
                server_url: TARGET_ORIGIN.into(),
                user_id: target_snapshot.user_id.clone(),
            },
            CrossAccountMoveDestinationBinding {
                account_id: target.clone(),
                incarnation: target_snapshot.incarnation.clone(),
                binding_revision: 0,
                status: CrossAccountMoveBindingStatus::Active,
            },
            original,
            destination,
        )
        .unwrap();
    let result = runtime
        .replica
        .execute(crate::replica::GuardedCommitPlan::new(
            source.clone(),
            source_snapshot.incarnation,
            source_snapshot.revision,
            source_snapshot.lock_epoch,
            vec![crate::replica::PlanMutation::AdmitCrossAccountMove {
                source_overlay: (!record.is_legacy_held()).then(|| record.source_overlay(&source)),
                record: Box::new(record.clone()),
            }],
        ))
        .await
        .unwrap();
    assert!(matches!(result, crate::replica::PlanResult::Applied { .. }));
    runtime.decrypt_visible_items(&source).unwrap();
    assert_eq!(runtime.require_snapshot(&target).unwrap(), target_snapshot);
    assert!(http.mutations(SOURCE_ORIGIN).is_empty());
    assert!(http.mutations(TARGET_ORIGIN).is_empty());
    (
        AdmittedMoveFixture {
            database,
            platform,
            http,
            sqlite,
            runtime,
            source,
            target,
            operation_id: SEMANTIC.into(),
        },
        record,
    )
}

#[tokio::test]
async fn legacy_cross_move_preserves_the_original_three_child_requests_through_completion() {
    let (fixture, record) = admitted_legacy_move().await;
    let target_before = durable_rows(&fixture.database.0, &fixture.target).await;
    assert_source_visible(
        &fixture.runtime,
        &fixture.source,
        crate::ItemProjectionStatus::Pending,
    );
    fixture.http.offline.store(false, Ordering::SeqCst);
    fixture.http.resumed.store(true, Ordering::SeqCst);
    fixture.http.trash_result.release.add_permits(8);
    fixture.http.delete_result.release.add_permits(8);
    for _ in 0..12 {
        if resolution(&fixture.runtime, &fixture.source, SEMANTIC) == OperationResolution::Applied {
            break;
        }
        let snapshot = fixture.runtime.require_snapshot(&fixture.source).unwrap();
        assert!(
            matches!(
                fixture
                    .runtime
                    .dispatch_cross_account_move(&snapshot, SEMANTIC)
                    .await,
                crate::runtime::dispatch::DispatchPass::Progressed
            ),
            "each original child must durably advance without replacement identity"
        );
    }
    assert_eq!(
        resolution(&fixture.runtime, &fixture.source, SEMANTIC),
        OperationResolution::Applied
    );
    let creates = fixture.http.mutations(TARGET_ORIGIN);
    let deletes = fixture.http.mutations(SOURCE_ORIGIN);
    assert_eq!(creates.len(), 1);
    assert_eq!(deletes.len(), 2);
    assert_eq!(creates[0].method, "PUT");
    assert_eq!(creates[0].header("Content-Type"), Some("application/json"));
    let ordered_ids = fixture
        .http
        .requests
        .lock()
        .unwrap()
        .iter()
        .filter_map(|request| request.header("Idempotency-Key").map(str::to_owned))
        .collect::<Vec<_>>();
    assert_eq!(
        ordered_ids,
        [
            "legacy-move:create-target",
            "legacy-move:trash-source",
            "legacy-move:delete-source"
        ]
    );
    assert_eq!(
        creates[0].header("Idempotency-Key"),
        Some("legacy-move:create-target")
    );
    assert_eq!(
        deletes[0].header("Idempotency-Key"),
        Some("legacy-move:trash-source")
    );
    assert_eq!(
        deletes[1].header("Idempotency-Key"),
        Some("legacy-move:delete-source")
    );
    // Property order is fixed by the actual TypeScript executor oracle; runtime IDs are simple.
    let expected = format!(
        r#"{{"category":"login","encryptedData":{},"encryptionIv":{},"encryptionAlgorithm":{}}}"#,
        serde_json::to_string(&record.target.encrypted_data).unwrap(),
        serde_json::to_string(&record.target.encryption_iv).unwrap(),
        serde_json::to_string(&record.target.encryption_algorithm).unwrap()
    );
    assert_eq!(creates[0].body, expected.as_bytes());
    assert_eq!(
        creates[0].url,
        format!("{TARGET_ORIGIN}/api/v1/vaults/vault-1/items/{TARGET_ITEM}")
    );
    assert_eq!(
        deletes[0].url,
        format!("{SOURCE_ORIGIN}/api/v1/items/{SOURCE_ITEM}")
    );
    assert_eq!(
        deletes[1].url,
        format!("{SOURCE_ORIGIN}/api/v1/items/{SOURCE_ITEM}/permanent")
    );
    assert_eq!(deletes[0].header("If-Match"), Some("\"1\""));
    assert_eq!(deletes[1].header("If-Match"), Some("\"2\""));
    assert!(deletes
        .iter()
        .all(|request| request.method == "DELETE" && request.body.is_empty()));
    assert_eq!(
        fixture.http.target.server.created_items(),
        vec![TARGET_ITEM.to_owned()]
    );
    assert!(fixture.http.source.server.created_items().is_empty());
    assert_eq!(
        durable_rows(&fixture.database.0, &fixture.target).await,
        target_before
    );
    let durable = workflow(
        &durable_rows(&fixture.database.0, &fixture.source).await,
        SEMANTIC,
    );
    assert_eq!(
        durable["legacyAdmission"]["sourceCommand"]["attemptId"],
        "legacy-attempt"
    );
    assert_eq!(durable["children"].as_array().unwrap().len(), 3);
    fixture.runtime.close().await;
}

#[tokio::test]
async fn legacy_cross_move_reopens_lost_target_reply_with_original_lookup_and_exact_replay() {
    let (
        AdmittedMoveFixture {
            database,
            platform,
            http,
            sqlite,
            runtime,
            source,
            target,
            ..
        },
        _,
    ) = admitted_legacy_move().await;
    http.offline.store(false, Ordering::SeqCst);
    http.target.server.lose_next_response();
    let runner = tokio::spawn(runtime.clone().run_operation_dispatch());
    http.recovery
        .wait("original target outcome after lost response")
        .await;
    let original = http.mutations(TARGET_ORIGIN)[0].clone();
    assert_eq!(
        original.header("Idempotency-Key"),
        Some("legacy-move:create-target")
    );
    assert!(http.mutations(SOURCE_ORIGIN).is_empty());
    close_move_runtime(runtime, runner).await;
    drop(sqlite);
    let before = workflow(&durable_rows(&database.0, &source).await, SEMANTIC);
    assert_eq!(
        before["children"][0]["operationId"],
        "legacy-move:create-target"
    );
    assert!(before["children"][0]["result"].is_null());
    let request_count = http.requests.lock().unwrap().len();
    http.resumed.store(true, Ordering::SeqCst);
    let runtime = open_move_runtime(MoveSqlite::open(&database.0), platform, http.clone()).await;
    assert_eq!(
        http.requests.lock().unwrap().len(),
        request_count,
        "locked reopen performs no HTTP"
    );
    for account in [&source, &target] {
        assert_eq!(
            runtime.account_access_state(account),
            Some(AccountAccessState::Locked)
        );
        runtime
            .request(
                quick_unlock_request(account.as_str()),
                RequestCancellation::new(),
            )
            .await
            .unwrap();
    }
    let runner = tokio::spawn(runtime.clone().run_operation_dispatch());
    http.trash_result
        .wait("original source trash after retained target proof")
        .await;
    assert!(http
        .requests
        .lock()
        .unwrap()
        .iter()
        .skip(request_count)
        .any(|request| request.method == "GET"
            && request.url
                == format!("{TARGET_ORIGIN}/api/v1/operations/legacy-move:create-target")));
    let creates = http.mutations(TARGET_ORIGIN);
    assert!(creates.len() >= 2);
    for request in &creates {
        assert_exact_retry(request, &original);
    }
    assert_eq!(
        http.target.server.created_items(),
        vec![TARGET_ITEM.to_owned()]
    );
    assert_eq!(
        http.mutations(SOURCE_ORIGIN)[0].header("Idempotency-Key"),
        Some("legacy-move:trash-source")
    );
    http.trash_result.release.add_permits(1);
    http.delete_result
        .wait("original source delete after proven trash")
        .await;
    assert_eq!(
        http.mutations(SOURCE_ORIGIN)[1].header("Idempotency-Key"),
        Some("legacy-move:delete-source")
    );
    http.delete_result.release.add_permits(1);
    tokio::time::timeout(Duration::from_secs(10), async {
        while resolution(&runtime, &source, SEMANTIC) != OperationResolution::Applied {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    assert!(http.source.server.created_items().is_empty());
    close_move_runtime(runtime, runner).await;
}

#[tokio::test]
async fn legacy_cross_move_matching_target_without_original_outcome_cannot_destroy_source() {
    let (fixture, record) = admitted_legacy_move().await;
    let child = record.children[0].item().unwrap();
    let response = fixture.http.target.server.handle_create(&RecordedRequest {
        method: "PUT".into(),
        url: format!("{SERVER_URL}{}", child.request.path),
        headers: vec![
            ("Authorization".into(), "Bearer fresh-token".into()),
            ("Idempotency-Key".into(), "other-operation".into()),
        ],
        body: child.request.body.clone(),
    });
    assert_eq!(response["status"], 200);
    fixture.http.offline.store(false, Ordering::SeqCst);
    fixture.http.resumed.store(true, Ordering::SeqCst);
    let source_before = item_body(&fixture.http.source.server.created_items.lock().unwrap()[0]);
    let snapshot = fixture.runtime.require_snapshot(&fixture.source).unwrap();
    fixture
        .runtime
        .dispatch_cross_account_move(&snapshot, SEMANTIC)
        .await;
    let retained = workflow(
        &durable_rows(&fixture.database.0, &fixture.source).await,
        SEMANTIC,
    );
    assert_eq!(
        retained["disposition"],
        json!({"type":"blocked","reason":"missingProof"})
    );
    assert!(fixture.http.mutations(SOURCE_ORIGIN).is_empty());
    assert!(fixture.http.mutations(TARGET_ORIGIN).is_empty());
    assert_eq!(
        item_body(&fixture.http.source.server.created_items.lock().unwrap()[0]),
        source_before
    );
    assert_eq!(
        fixture.http.target.server.created_items(),
        vec![TARGET_ITEM.to_owned()]
    );
    assert_source_visible(
        &fixture.runtime,
        &fixture.source,
        crate::ItemProjectionStatus::Pending,
    );
    fixture.runtime.close().await;
}

#[tokio::test]
async fn legacy_cross_move_changed_or_trashed_source_blocks_before_any_effect() {
    for trashed in [false, true] {
        let (fixture, _) = admitted_legacy_move().await;
        let changed = {
            let mut items = fixture.http.source.server.created_items.lock().unwrap();
            items[0].version = 2;
            if trashed {
                items[0].deleted_at = Some("2026-01-01T00:00:00.000Z".into());
            } else {
                items[0].favorite = true;
            }
            item_body(&items[0])
        };
        fixture.http.offline.store(false, Ordering::SeqCst);
        fixture.http.resumed.store(true, Ordering::SeqCst);
        let snapshot = fixture.runtime.require_snapshot(&fixture.source).unwrap();
        fixture
            .runtime
            .dispatch_cross_account_move(&snapshot, SEMANTIC)
            .await;
        let retained = workflow(
            &durable_rows(&fixture.database.0, &fixture.source).await,
            SEMANTIC,
        );
        assert_eq!(
            retained["disposition"],
            json!({"type":"blocked","reason":if trashed { "targetChanged" } else { "sourceChanged" }})
        );
        assert!(fixture.http.mutations(SOURCE_ORIGIN).is_empty());
        assert!(fixture.http.mutations(TARGET_ORIGIN).is_empty());
        assert_eq!(
            item_body(&fixture.http.source.server.created_items.lock().unwrap()[0]),
            changed
        );
        assert_source_visible(
            &fixture.runtime,
            &fixture.source,
            crate::ItemProjectionStatus::Pending,
        );
        fixture.runtime.close().await;
    }
}
