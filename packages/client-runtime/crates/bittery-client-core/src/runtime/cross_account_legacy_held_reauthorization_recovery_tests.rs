//! Reopen and ambiguous-commit boundaries for the existing explicit authorization owner.
use super::*;
use crate::protocol::CrossAccountMoveResumeGuard;

pub(super) async fn readded_held_target(
    status: &str,
) -> (AdmittedMoveFixture, CrossAccountMoveRecord, MoveDatabase) {
    readded_held_target_with_http(status, MoveHttp::new()).await
}

pub(super) async fn readded_held_target_with_http(
    status: &str,
    http: Arc<MoveHttp>,
) -> (AdmittedMoveFixture, CrossAccountMoveRecord, MoveDatabase) {
    let (mut fixture, original) = admitted_legacy_move_with_http_and_history(
        json!({
            "status":status, "retryCount":"2", "nextAttemptAt":"0",
            "lastError":"departed owner stopped after target response loss"
        }),
        None,
        http,
    )
    .await;
    let outcome: Value = serde_json::from_slice(&historical_effect(
        &fixture,
        &legacy_request(&original, CrossAccountMoveStep::TargetCreate),
    ))
    .unwrap();
    assert_eq!(outcome["result"]["status"], "applied");
    let artifacts = super::super::super::super::retirement_tests::remove_target(&fixture).await;
    replace_target(&mut fixture).await;
    (fixture, original, artifacts)
}

pub(super) async fn replace_target(fixture: &mut AdmittedMoveFixture) {
    fixture.http.offline.store(false, Ordering::SeqCst);
    fixture.http.resumed.store(true, Ordering::SeqCst);
    let RuntimeResponse::SignedIn { account_id, .. } = fixture
        .runtime
        .request(
            sign_in_request_to(TARGET_ORIGIN, NORMALIZED_EMAIL),
            RequestCancellation::new(),
        )
        .await
        .unwrap()
    else {
        panic!("same-identity replacement Sign-in must succeed");
    };
    assert_ne!(account_id, fixture.target);
    fixture.target = account_id;
}

pub(super) async fn prepare(
    fixture: &AdmittedMoveFixture,
    binding_revision: u64,
) -> CrossAccountMoveResumeGuard {
    let source_before = durable_rows(&fixture.database.0, &fixture.source).await;
    let target_before = durable_rows(&fixture.database.0, &fixture.target).await;
    let source_writes = fixture.http.mutations(SOURCE_ORIGIN).len();
    let target_writes = fixture.http.mutations(TARGET_ORIGIN).len();
    let RuntimeResponse::CrossAccountMoveResumePrepared { guard } = fixture
        .runtime
        .request(
            RuntimeRequest::PrepareCrossAccountMoveResume {
                account_id: fixture.source.clone(),
                operation_id: SEMANTIC.into(),
                target_account_id: fixture.target.clone(),
                expected_binding_revision: binding_revision,
            },
            RequestCancellation::new(),
        )
        .await
        .unwrap()
    else {
        panic!("expected nonmutating Prepare response");
    };
    assert_eq!(
        durable_rows(&fixture.database.0, &fixture.source).await,
        source_before
    );
    assert_eq!(
        durable_rows(&fixture.database.0, &fixture.target).await,
        target_before
    );
    assert_eq!(fixture.http.mutations(SOURCE_ORIGIN).len(), source_writes);
    assert_eq!(fixture.http.mutations(TARGET_ORIGIN).len(), target_writes);
    guard
}

pub(super) async fn confirm(fixture: &AdmittedMoveFixture, guard: CrossAccountMoveResumeGuard) {
    assert!(
        matches!(fixture.runtime.request(RuntimeRequest::ResumeCrossAccountMove { guard }, RequestCancellation::new()).await.unwrap(),
        RuntimeResponse::Accepted { operation_id, .. } if operation_id == SEMANTIC)
    );
}

pub(super) async fn reopen_with(
    fixture: &mut AdmittedMoveFixture,
    executor: Arc<dyn SerializedReplicaExecutor>,
) {
    let http = fixture.http.clone();
    reopen_with_http(fixture, executor, http).await;
}

pub(super) async fn reopen_with_http(
    fixture: &mut AdmittedMoveFixture,
    executor: Arc<dyn SerializedReplicaExecutor>,
    http: Arc<dyn crate::http_transport::SerializedHttpExecutor>,
) {
    let source_rows = durable_rows(&fixture.database.0, &fixture.source).await;
    let target_rows = durable_rows(&fixture.database.0, &fixture.target).await;
    fixture.runtime.close().await;
    let requests_before = fixture.http.requests.lock().unwrap().len();
    // A configured Core Runtime with SQLite has no legacy-source provider to consult.
    fixture.runtime = Runtime::with_configured_serialized_executors(
        executor,
        fixture.platform.clone(),
        http,
        AuthClientConfig::new(
            "client-routing".into(),
            ClientPlatform::Desktop,
            "0.5.2-test".into(),
        )
        .unwrap(),
    );
    fixture.runtime.open().await.unwrap();
    assert_eq!(fixture.http.requests.lock().unwrap().len(), requests_before);
    assert_eq!(
        durable_rows(&fixture.database.0, &fixture.source).await,
        source_rows
    );
    assert_eq!(
        durable_rows(&fixture.database.0, &fixture.target).await,
        target_rows
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
    assert_eq!(
        durable_rows(&fixture.database.0, &fixture.source).await,
        source_rows
    );
}

fn authorization(prior_hold: &str, revision: u64) -> Value {
    json!({"destinationReauthorized":{"priorHold":prior_hold, "bindingRevision":revision.to_string()}})
}

fn owned_overlay_rows(rows: &[Value]) -> Vec<Value> {
    rows.iter()
        .filter(|row| row["store"] == "optimisticItems")
        .cloned()
        .collect()
}

#[tokio::test]
async fn conflicted_authorization_reopens_then_survives_a_second_actual_retirement_and_confirmation(
) {
    let (mut fixture, original, _first_artifacts) = readded_held_target("conflicted").await;
    let guard = prepare(&fixture, 1).await;
    confirm(&fixture, guard).await;
    let authorized_rows = durable_rows(&fixture.database.0, &fixture.source).await;
    let authorized = workflow(&authorized_rows, SEMANTIC);
    assert_eq!(
        authorized["legacyAdmission"]["disposition"],
        authorization("legacyConflicted", 2)
    );
    assert_eq!(
        authorized["legacyAdmission"]["sourceCommand"],
        serde_json::to_value(&original.legacy_admission.as_ref().unwrap().source_command).unwrap()
    );
    assert_eq!(
        authorized["children"],
        serde_json::to_value(&original.children).unwrap()
    );
    assert_eq!(
        authorized["scheduling"],
        serde_json::to_value(original.scheduling).unwrap()
    );
    let overlays = owned_overlay_rows(&authorized_rows);
    assert_eq!(overlays.len(), 1);
    assert_eq!(
        serde_json::from_str::<Value>(overlays[0]["payloadJson"].as_str().unwrap()).unwrap(),
        serde_json::to_value(original.source_overlay(&fixture.source)).unwrap()
    );
    fixture.sqlite = MoveSqlite::open(&fixture.database.0);
    let executor = fixture.sqlite.clone();
    reopen_with(&mut fixture, executor).await;
    assert_eq!(
        workflow(
            &durable_rows(&fixture.database.0, &fixture.source).await,
            SEMANTIC
        ),
        authorized
    );
    assert_eq!(
        fixture
            .runtime
            .require_snapshot(&fixture.source)
            .unwrap()
            .items,
        vec![original.source_overlay(&fixture.source)]
    );

    let first_replacement = fixture.target.clone();
    let _second_artifacts =
        super::super::super::super::retirement_tests::remove_target(&fixture).await;
    let retired_rows = durable_rows(&fixture.database.0, &fixture.source).await;
    let retired = workflow(&retired_rows, SEMANTIC);
    let mut expected_retired = authorized.clone();
    expected_retired["destinationBinding"]["status"] = json!("retired");
    expected_retired["destinationBinding"]["bindingRevision"] = json!("3");
    expected_retired["disposition"] = json!({"type":"blocked", "reason":"destinationRetired"});
    assert_eq!(retired, expected_retired);
    assert_eq!(
        retired["destinationBinding"]["accountId"],
        json!(first_replacement)
    );
    assert_eq!(owned_overlay_rows(&retired_rows), overlays);
    let calls = fixture.http.requests.lock().unwrap().len();
    let snapshot = fixture.runtime.require_snapshot(&fixture.source).unwrap();
    assert!(matches!(
        fixture
            .runtime
            .dispatch_cross_account_move(&snapshot, SEMANTIC)
            .await,
        crate::runtime::dispatch::DispatchPass::Parked
    ));
    assert_eq!(fixture.http.requests.lock().unwrap().len(), calls);
    replace_target(&mut fixture).await;
    assert_ne!(fixture.target, first_replacement);
    assert_eq!(
        workflow(
            &durable_rows(&fixture.database.0, &fixture.source).await,
            SEMANTIC
        ),
        retired
    );
    let guard = prepare(&fixture, 3).await;
    confirm(&fixture, guard).await;
    let rebound_rows = durable_rows(&fixture.database.0, &fixture.source).await;
    let rebound = workflow(&rebound_rows, SEMANTIC);
    let mut expected = retired;
    expected["destinationBinding"] = json!({
        "accountId":fixture.target, "incarnation":fixture.runtime.require_snapshot(&fixture.target).unwrap().incarnation,
        "bindingRevision":"4", "status":"active"
    });
    expected["legacyAdmission"]["disposition"] = authorization("legacyConflicted", 4);
    expected["disposition"] = json!({"type":"ready"});
    assert_eq!(rebound, expected);
    assert_eq!(owned_overlay_rows(&rebound_rows), overlays);
    assert_eq!(
        fixture
            .runtime
            .require_snapshot(&fixture.source)
            .unwrap()
            .items
            .len(),
        1
    );
    assert!(fixture.http.mutations(SOURCE_ORIGIN).is_empty());
    let target_replays = fixture.http.mutations(TARGET_ORIGIN);
    assert_eq!(target_replays.len(), 2);
    for replay in &target_replays {
        assert_original_request(
            replay,
            &legacy_request(&original, CrossAccountMoveStep::TargetCreate),
        );
    }
    assert_eq!(fixture.http.target.server.outcomes.lock().unwrap().len(), 1);
    fixture.runtime.close().await;
}

struct LoseAuthorizationReply {
    inner: Arc<MoveSqlite>,
    lost: AtomicBool,
    committed_work: Mutex<Option<Vec<Value>>>,
}

#[async_trait]
impl SerializedReplicaExecutor for LoseAuthorizationReply {
    async fn invoke(&self, request: String) -> Result<String, RuntimeError> {
        let input: Value = serde_json::from_str(&request).unwrap();
        let writes = input["prepared"]["writes"].as_array();
        let authorization_write = input["type"] == "commit"
            && !self.lost.load(Ordering::SeqCst)
            && writes.is_some_and(|writes| {
                writes.iter().any(|write| {
                    write["type"] == "put"
                        && write["row"]["store"] == "crossAccountMoves"
                        && write["row"]["key"]["recordId"] == SEMANTIC
                        && serde_json::from_str::<Value>(
                            write["row"]["payloadJson"].as_str().unwrap(),
                        )
                        .unwrap()["legacyAdmission"]["disposition"]
                            == authorization("legacyFailed", 2)
                })
            });
        let reply = self.inner.invoke(request).await?;
        if authorization_write {
            let result: Value = serde_json::from_str(&reply).unwrap();
            assert_eq!(result["type"], "committed");
            assert_eq!(result["result"]["type"], "applied");
            assert!(!self.lost.swap(true, Ordering::SeqCst));
            *self.committed_work.lock().unwrap() = Some(
                writes
                    .unwrap()
                    .iter()
                    .filter(|write| {
                        write["type"] == "put"
                            && matches!(
                                write["row"]["store"].as_str(),
                                Some("crossAccountMoves" | "optimisticItems")
                            )
                    })
                    .map(|write| write["row"].clone())
                    .collect(),
            );
            return Err(RuntimeError::new(
                RuntimeErrorCode::StorageUnavailable,
                "lost reply after actual atomic authorization and overlay commit",
            ));
        }
        Ok(reply)
    }
}

#[tokio::test]
async fn lost_authorization_reply_reopens_exact_active_work_and_refuses_the_old_confirmation() {
    let (mut fixture, original, _artifacts) = readded_held_target("failed").await;
    let executor = Arc::new(LoseAuthorizationReply {
        inner: fixture.sqlite.clone(),
        lost: AtomicBool::new(false),
        committed_work: Mutex::default(),
    });
    reopen_with(&mut fixture, executor.clone()).await;
    let guard = prepare(&fixture, 1).await;
    let response = fixture
        .runtime
        .request(
            RuntimeRequest::ResumeCrossAccountMove {
                guard: guard.clone(),
            },
            RequestCancellation::new(),
        )
        .await;
    assert_eq!(
        response.unwrap_err().code,
        RuntimeErrorCode::StorageUnavailable
    );
    assert!(executor.lost.load(Ordering::SeqCst));
    let committed = executor.committed_work.lock().unwrap().clone().unwrap();
    assert_eq!(
        committed.len(),
        2,
        "the actual same commit contains the workflow and its sole exact overlay"
    );
    let rows = durable_rows(&fixture.database.0, &fixture.source).await;
    for expected in &committed {
        assert!(
            rows.contains(expected),
            "separate SQLite read must observe each exact committed row"
        );
    }
    let authorized = workflow(&rows, SEMANTIC);
    assert_eq!(
        authorized["legacyAdmission"]["disposition"],
        authorization("legacyFailed", 2)
    );
    assert_eq!(
        authorized["children"],
        serde_json::to_value(&original.children).unwrap()
    );
    assert_eq!(owned_overlay_rows(&rows).len(), 1);
    assert!(fixture.http.mutations(SOURCE_ORIGIN).is_empty());
    fixture.sqlite = MoveSqlite::open(&fixture.database.0);
    let plain = fixture.sqlite.clone();
    reopen_with(&mut fixture, plain).await;
    assert_eq!(
        workflow(
            &durable_rows(&fixture.database.0, &fixture.source).await,
            SEMANTIC
        ),
        authorized
    );
    let snapshot = fixture.runtime.require_snapshot(&fixture.source).unwrap();
    assert_eq!(
        snapshot.items,
        vec![original.source_overlay(&fixture.source)]
    );
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
        fixture.runtime.require_snapshot(&fixture.source).unwrap(),
        snapshot
    );
    fixture.http.trash_result.release.add_permits(4);
    fixture.http.delete_result.release.add_permits(4);
    for _ in 0..10 {
        if resolution(&fixture.runtime, &fixture.source, SEMANTIC) == OperationResolution::Applied {
            break;
        }
        let snapshot = fixture.runtime.require_snapshot(&fixture.source).unwrap();
        assert!(matches!(
            fixture
                .runtime
                .dispatch_cross_account_move(&snapshot, SEMANTIC)
                .await,
            crate::runtime::dispatch::DispatchPass::Progressed
        ));
    }
    assert_eq!(
        resolution(&fixture.runtime, &fixture.source, SEMANTIC),
        OperationResolution::Applied
    );
    let completed = workflow(
        &durable_rows(&fixture.database.0, &fixture.source).await,
        SEMANTIC,
    );
    assert_eq!(completed["legacyAdmission"], authorized["legacyAdmission"]);
    assert_eq!(completed["source"], authorized["source"]);
    assert_eq!(completed["target"], authorized["target"]);
    assert!(fixture
        .runtime
        .require_snapshot(&fixture.source)
        .unwrap()
        .items
        .is_empty());
    let target_replays = fixture.http.mutations(TARGET_ORIGIN);
    assert_eq!(target_replays.len(), 2);
    for replay in &target_replays {
        assert_original_request(
            replay,
            &legacy_request(&original, CrossAccountMoveStep::TargetCreate),
        );
    }
    let source_requests = fixture.http.mutations(SOURCE_ORIGIN);
    assert_eq!(source_requests.len(), 2);
    for (actual, step) in source_requests.iter().zip([
        CrossAccountMoveStep::SourceTrash,
        CrossAccountMoveStep::SourceDelete,
    ]) {
        assert_original_request(actual, &legacy_request(&original, step));
    }
    assert!(fixture.http.source.server.created_items().is_empty());
    assert_eq!(
        fixture.http.target.server.created_items(),
        vec![TARGET_ITEM.to_owned()]
    );
    fixture.runtime.close().await;
}
