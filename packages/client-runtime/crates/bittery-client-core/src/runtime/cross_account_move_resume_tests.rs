//! Explicit public confirmation rebinds the original durable Move after target retirement.
use super::*;

async fn replacement_target(fixture: &AdmittedMoveFixture) -> AccountId {
    fixture.http.offline.store(false, Ordering::SeqCst);
    let RuntimeResponse::SignedIn { account_id, .. } = fixture
        .runtime
        .request(
            sign_in_request_to(TARGET_ORIGIN, NORMALIZED_EMAIL),
            RequestCancellation::new(),
        )
        .await
        .unwrap()
    else {
        panic!("same-identity target Sign-in failed")
    };
    account_id
}

async fn prepare_resume(fixture: &AdmittedMoveFixture, target: &AccountId) -> Value {
    let request = serde_json::from_value(json!({
        "type":"prepareCrossAccountMoveResume",
        "accountId":fixture.source,
        "operationId":fixture.operation_id,
        "targetAccountId":target,
        "expectedBindingRevision":"1"
    }))
    .expect("public Runtime must accept the Prepare Resume intent");
    let response = fixture
        .runtime
        .request(request, RequestCancellation::new())
        .await
        .expect("current original Server/User must prepare explicit Resume");
    let response = serde_json::to_value(response).unwrap();
    assert_eq!(response["type"], "crossAccountMoveResumePrepared");
    response["guard"].clone()
}

async fn quick_unlock_move(runtime: &Runtime, account: &AccountId) {
    runtime
        .request(
            RuntimeRequest::QuickUnlock {
                account_id: account.clone(),
                master_password: MASTER_PASSWORD.into(),
            },
            RequestCancellation::new(),
        )
        .await
        .unwrap();
}

async fn assert_resume_refused_without_changes(fixture: &AdmittedMoveFixture, guard: Value) {
    let before = durable_rows(&fixture.database.0, &fixture.source).await;
    let requests_before = fixture.http.requests.lock().unwrap().len();
    let request =
        serde_json::from_value(json!({"type":"resumeCrossAccountMove", "guard":guard})).unwrap();
    assert!(
        fixture
            .runtime
            .request(request, RequestCancellation::new())
            .await
            .is_err(),
        "a retired confirmation must not reauthorize the Move"
    );
    assert_eq!(
        durable_rows(&fixture.database.0, &fixture.source).await,
        before
    );
    assert_eq!(
        fixture.http.requests.lock().unwrap().len(),
        requests_before,
        "stale confirmation must fail before remote evidence or mutation calls"
    );
}

#[tokio::test]
async fn explicit_resume_rebinds_same_identity_and_preserves_accepted_move_bytes() {
    let fixture = AdmittedMoveFixture::new().await;
    let _artifacts = retirement_tests::remove_target(&fixture).await;
    let target = replacement_target(&fixture).await;
    assert_ne!(target, fixture.target);
    let retired_rows = durable_rows(&fixture.database.0, &fixture.source).await;
    let retired = workflow(&retired_rows, &fixture.operation_id);
    assert_eq!(retired["destinationBinding"]["status"], "retired");

    let guard = prepare_resume(&fixture, &target).await;
    assert_eq!(guard["accountId"], json!(fixture.source));
    assert_eq!(guard["targetAccountId"], json!(target));
    assert_eq!(guard["operationId"], fixture.operation_id);
    assert_eq!(guard["bindingRevision"], "1");
    assert_eq!(
        durable_rows(&fixture.database.0, &fixture.source).await,
        retired_rows,
        "preparation must not reauthorize or advance the durable Move"
    );
    assert!(fixture.http.mutations(SOURCE_ORIGIN).is_empty());
    assert!(fixture.http.mutations(TARGET_ORIGIN).is_empty());

    let request = serde_json::from_value(json!({"type":"resumeCrossAccountMove", "guard":guard}))
        .expect("public Runtime must accept explicit Resume");
    let response = fixture
        .runtime
        .request(request, RequestCancellation::new())
        .await
        .expect("fresh verified explicit Resume must succeed");
    assert!(
        matches!(response, RuntimeResponse::Accepted { ref operation_id, .. }
        if operation_id == &fixture.operation_id)
    );
    let rebound = workflow(
        &durable_rows(&fixture.database.0, &fixture.source).await,
        &fixture.operation_id,
    );
    let mut expected = retired;
    expected["destinationBinding"] = json!({
        "accountId":target,
        "incarnation":fixture.runtime.require_snapshot(&target).unwrap().incarnation,
        "bindingRevision":"2",
        "status":"active"
    });
    expected["disposition"] = json!({"type":"ready"});
    assert_eq!(
        rebound, expected,
        "only the verified destination binding changes"
    );
    assert!(fixture.http.mutations(SOURCE_ORIGIN).is_empty());
    assert!(fixture.http.mutations(TARGET_ORIGIN).is_empty());

    fixture.http.resumed.store(true, Ordering::SeqCst);
    fixture.http.trash_result.release.add_permits(1);
    fixture.http.delete_result.release.add_permits(1);
    for _ in 0..8 {
        let snapshot = fixture.runtime.require_snapshot(&fixture.source).unwrap();
        let pass = fixture
            .runtime
            .dispatch_cross_account_move(&snapshot, &fixture.operation_id)
            .await;
        assert!(matches!(
            pass,
            crate::runtime::dispatch::DispatchPass::Progressed
        ));
        if resolution(&fixture.runtime, &fixture.source, &fixture.operation_id)
            == OperationResolution::Applied
        {
            break;
        }
    }
    assert_eq!(
        resolution(&fixture.runtime, &fixture.source, &fixture.operation_id),
        OperationResolution::Applied
    );
    assert_eq!(
        fixture
            .http
            .target
            .server
            .created_items
            .lock()
            .unwrap()
            .len(),
        1
    );
    assert!(fixture
        .http
        .source
        .server
        .created_items
        .lock()
        .unwrap()
        .is_empty());
    let completed = workflow(
        &durable_rows(&fixture.database.0, &fixture.source).await,
        &fixture.operation_id,
    );
    assert_eq!(completed["target"], rebound["target"]);
    assert_eq!(
        completed["children"][0]["request"],
        rebound["children"][0]["request"]
    );
    assert_eq!(
        completed["children"][0]["operationId"],
        rebound["children"][0]["operationId"]
    );
    fixture.runtime.close().await;
}

#[tokio::test]
async fn target_lock_and_fresh_unlock_refuse_the_old_move_resume_confirmation() {
    let fixture = AdmittedMoveFixture::new().await;
    let _artifacts = retirement_tests::remove_target(&fixture).await;
    let target = replacement_target(&fixture).await;
    let guard = prepare_resume(&fixture, &target).await;
    fixture
        .runtime
        .request(
            RuntimeRequest::Lock {
                account_id: target.clone(),
            },
            RequestCancellation::new(),
        )
        .await
        .unwrap();
    quick_unlock_move(&fixture.runtime, &target).await;
    assert_resume_refused_without_changes(&fixture, guard).await;
    let fresh = prepare_resume(&fixture, &target).await;
    let request =
        serde_json::from_value(json!({"type":"resumeCrossAccountMove", "guard":fresh})).unwrap();
    assert!(matches!(
        fixture
            .runtime
            .request(request, RequestCancellation::new())
            .await
            .unwrap(),
        RuntimeResponse::Accepted { .. }
    ));
    fixture.runtime.close().await;
}

#[tokio::test]
async fn actual_owner_loss_refuses_resume_guard_with_unchanged_durable_scopes_after_unlock() {
    let fixture = AdmittedMoveFixture::new().await;
    let _artifacts = retirement_tests::remove_target(&fixture).await;
    let candidate = replacement_target(&fixture).await;
    let guard = prepare_resume(&fixture, &candidate).await;
    let rows_before_loss = durable_rows(&fixture.database.0, &fixture.source).await;
    let AdmittedMoveFixture {
        database,
        platform,
        http,
        sqlite,
        runtime,
        source,
        target,
        operation_id,
    } = fixture;
    let old_owner = Arc::downgrade(&runtime);
    drop(runtime);
    drop(sqlite);
    assert!(
        old_owner.upgrade().is_none(),
        "the original Core owner must actually be gone"
    );

    let sqlite = MoveSqlite::open(&database.0);
    let runtime = open_move_runtime(sqlite.clone(), platform.clone(), http.clone()).await;
    quick_unlock_move(&runtime, &source).await;
    quick_unlock_move(&runtime, &candidate).await;
    let fixture = AdmittedMoveFixture {
        database,
        platform,
        http,
        sqlite,
        runtime,
        source,
        target,
        operation_id,
    };
    assert_eq!(
        durable_rows(&fixture.database.0, &fixture.source).await,
        rows_before_loss,
        "this history must isolate owner loss from durable Replica revision changes"
    );
    let fresh = prepare_resume(&fixture, &candidate).await;
    let mut expected = guard.clone();
    expected["ownerIncarnation"] = fresh["ownerIncarnation"].clone();
    assert_ne!(fresh["ownerIncarnation"], guard["ownerIncarnation"]);
    assert_eq!(
        fresh, expected,
        "only the actual Core owner changed after fresh unlock"
    );
    assert_resume_refused_without_changes(&fixture, guard).await;
    let request =
        serde_json::from_value(json!({"type":"resumeCrossAccountMove", "guard":fresh})).unwrap();
    assert!(matches!(
        fixture
            .runtime
            .request(request, RequestCancellation::new())
            .await
            .unwrap(),
        RuntimeResponse::Accepted { .. }
    ));
    fixture.runtime.close().await;
}

#[tokio::test]
async fn explicit_resume_proves_lost_target_create_without_preparation_replaying_it() {
    let fixture = AdmittedMoveFixture::new().await;
    fixture.http.offline.store(false, Ordering::SeqCst);
    fixture.http.target.server.lose_next_response();
    let snapshot = fixture.runtime.require_snapshot(&fixture.source).unwrap();
    fixture
        .runtime
        .dispatch_cross_account_move(&snapshot, &fixture.operation_id)
        .await;
    assert_eq!(
        fixture
            .http
            .target
            .server
            .created_items
            .lock()
            .unwrap()
            .len(),
        1
    );
    let lost = workflow(
        &durable_rows(&fixture.database.0, &fixture.source).await,
        &fixture.operation_id,
    );
    assert!(
        lost["children"][0]["result"].is_null(),
        "the committed target result was lost"
    );
    let original_request = fixture.http.mutations(TARGET_ORIGIN)[0].clone();
    let _artifacts = retirement_tests::remove_target(&fixture).await;
    let target = replacement_target(&fixture).await;
    fixture.http.resumed.store(true, Ordering::SeqCst);
    let retired = workflow(
        &durable_rows(&fixture.database.0, &fixture.source).await,
        &fixture.operation_id,
    );
    let guard = prepare_resume(&fixture, &target).await;
    assert_eq!(
        fixture.http.mutations(TARGET_ORIGIN).len(),
        1,
        "Prepare only reads the retained hint/current target"
    );
    assert_eq!(
        workflow(
            &durable_rows(&fixture.database.0, &fixture.source).await,
            &fixture.operation_id
        ),
        retired
    );
    let request =
        serde_json::from_value(json!({"type":"resumeCrossAccountMove", "guard":guard})).unwrap();
    assert!(matches!(
        fixture
            .runtime
            .request(request, RequestCancellation::new())
            .await
            .unwrap(),
        RuntimeResponse::Accepted { .. }
    ));
    let requests = fixture.http.mutations(TARGET_ORIGIN);
    assert_eq!(
        requests.len(),
        2,
        "explicit Resume proves exactly the already-decided child"
    );
    assert_exact_retry(&requests[1], &original_request);
    assert!(fixture.http.mutations(SOURCE_ORIGIN).is_empty());
    assert_eq!(
        fixture
            .http
            .target
            .server
            .created_items
            .lock()
            .unwrap()
            .len(),
        1
    );
    let rebound = workflow(
        &durable_rows(&fixture.database.0, &fixture.source).await,
        &fixture.operation_id,
    );
    assert_eq!(
        rebound["children"], retired["children"],
        "normal dispatcher remains the durable result owner"
    );
    assert_eq!(rebound["target"], retired["target"]);
    assert_eq!(rebound["stage"], retired["stage"]);
    let snapshot = fixture.runtime.require_snapshot(&fixture.source).unwrap();
    fixture
        .runtime
        .dispatch_cross_account_move(&snapshot, &fixture.operation_id)
        .await;
    let proved = workflow(
        &durable_rows(&fixture.database.0, &fixture.source).await,
        &fixture.operation_id,
    );
    assert_eq!(proved["children"][0]["result"]["result"]["type"], "applied");
    assert_eq!(
        proved["children"][0]["request"],
        retired["children"][0]["request"]
    );
    assert_source_visible(
        &fixture.runtime,
        &fixture.source,
        crate::ItemProjectionStatus::Pending,
    );
    fixture.runtime.close().await;
}

#[tokio::test]
async fn new_source_work_makes_resume_confirmation_stale_without_an_access_change() {
    let fixture = AdmittedMoveFixture::new().await;
    let _artifacts = retirement_tests::remove_target(&fixture).await;
    let target = replacement_target(&fixture).await;
    let guard = prepare_resume(&fixture, &target).await;
    fixture
        .runtime
        .request(
            create_request(fixture.source.as_str()),
            RequestCancellation::new(),
        )
        .await
        .unwrap();
    let fresh = prepare_resume(&fixture, &target).await;
    let mut expected = guard.clone();
    expected["sourceReplicaRevision"] = fresh["sourceReplicaRevision"].clone();
    assert_ne!(
        fresh["sourceReplicaRevision"],
        guard["sourceReplicaRevision"]
    );
    assert_eq!(fresh, expected, "only the durable source revision changed");
    assert_resume_refused_without_changes(&fixture, guard).await;
    fixture.runtime.close().await;
}

#[tokio::test]
async fn changed_target_after_prepare_refuses_resume_without_replaying_or_rebinding() {
    let fixture = AdmittedMoveFixture::new().await;
    fixture.http.offline.store(false, Ordering::SeqCst);
    fixture.http.target.server.lose_next_response();
    let snapshot = fixture.runtime.require_snapshot(&fixture.source).unwrap();
    fixture
        .runtime
        .dispatch_cross_account_move(&snapshot, &fixture.operation_id)
        .await;
    let _artifacts = retirement_tests::remove_target(&fixture).await;
    let target = replacement_target(&fixture).await;
    fixture.http.resumed.store(true, Ordering::SeqCst);
    let guard = prepare_resume(&fixture, &target).await;
    fixture.http.target.server.created_items.lock().unwrap()[0].version += 1;
    let rows_before = durable_rows(&fixture.database.0, &fixture.source).await;
    let mutations_before = fixture.http.mutations(TARGET_ORIGIN);
    let request =
        serde_json::from_value(json!({"type":"resumeCrossAccountMove", "guard":guard})).unwrap();
    assert!(fixture
        .runtime
        .request(request, RequestCancellation::new())
        .await
        .is_err());
    assert_eq!(
        durable_rows(&fixture.database.0, &fixture.source).await,
        rows_before
    );
    assert_eq!(
        fixture.http.mutations(TARGET_ORIGIN).len(),
        mutations_before.len()
    );
    assert!(fixture.http.mutations(SOURCE_ORIGIN).is_empty());
    assert_source_visible(
        &fixture.runtime,
        &fixture.source,
        crate::ItemProjectionStatus::Pending,
    );
    assert_eq!(
        fixture.http.target.server.created_items.lock().unwrap()[0].version,
        2
    );
    fixture.runtime.close().await;
}
