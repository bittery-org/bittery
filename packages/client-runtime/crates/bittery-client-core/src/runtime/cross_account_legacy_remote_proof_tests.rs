//! A progressed source requires agreeing original proof, even when remote effects already exist.
use super::*;

fn assert_target_lookup(fixture: &AdmittedMoveFixture, operation_id: &str) {
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
            format!("{TARGET_ORIGIN}/api/v1/operations/{operation_id}"),
        )],
        "source children must not be consulted before original target proof agrees"
    );
}

async fn assert_unproved_target_is_retained(
    fixture: &AdmittedMoveFixture,
    original: &CrossAccountMoveRecord,
) {
    let blocked = current(fixture);
    assert_eq!(
        blocked.disposition,
        CrossAccountMoveDisposition::Blocked {
            reason: crate::replica::CrossAccountMoveBlockedReason::MissingProof,
        }
    );
    assert_eq!(blocked.stage, CrossAccountMoveStage::TargetCreate);
    assert_eq!(
        blocked.children, original.children,
        "no substitute result or source child may be committed"
    );
    assert_eq!(blocked.legacy_admission, original.legacy_admission);
    assert_eq!(blocked.source, original.source);
    assert_eq!(blocked.target, original.target);
    assert_source_visible(
        &fixture.runtime,
        &fixture.source,
        crate::ItemProjectionStatus::Pending,
    );
    assert_eq!(
        workflow(
            &durable_rows(&fixture.database.0, &fixture.source).await,
            SEMANTIC,
        ),
        serde_json::to_value(blocked).unwrap()
    );
}

#[tokio::test]
async fn legacy_remote_original_target_rejection_blocks_before_any_replay() {
    let (fixture, original) = admitted_legacy_move().await;
    let target_request = request(&original, CrossAccountMoveStep::TargetCreate);
    fixture.http.target.server.reject_next("item_id_conflict");
    let rejected: Value =
        serde_json::from_slice(&historical_effect(&fixture, &target_request)).unwrap();
    assert_eq!(
        rejected["result"],
        json!({"status":"rejected","code":"item_id_conflict"})
    );
    assert_eq!(
        rejected["operationId"],
        target_request.header("Idempotency-Key").unwrap()
    );
    assert!(fixture.http.target.server.created_items().is_empty());
    // Another original identity produces the exact target, while the original target ID still
    // genuinely retains Rejected. Source effects use the real current CAS checks in the helper.
    establish_prefix(
        &fixture,
        &original,
        RemotePrefix::Deleted,
        Some(CrossAccountMoveStep::TargetCreate),
    );
    let source_before = server_evidence(&fixture.http.source.server);
    let target_before = server_evidence(&fixture.http.target.server);
    let cache_before = fixture
        .runtime
        .require_snapshot(&fixture.source)
        .unwrap()
        .bootstrap;
    let target_replica_before = durable_rows(&fixture.database.0, &fixture.target).await;
    finish_or_block(&fixture).await;
    assert_unproved_target_is_retained(&fixture, &original).await;
    assert_target_lookup(&fixture, target_request.header("Idempotency-Key").unwrap());
    assert!(fixture.http.mutations(TARGET_ORIGIN).is_empty());
    assert!(fixture.http.mutations(SOURCE_ORIGIN).is_empty());
    assert_eq!(server_evidence(&fixture.http.source.server), source_before);
    assert_eq!(server_evidence(&fixture.http.target.server), target_before);
    assert_eq!(
        fixture
            .runtime
            .require_snapshot(&fixture.source)
            .unwrap()
            .bootstrap,
        cache_before
    );
    assert_eq!(
        durable_rows(&fixture.database.0, &fixture.target).await,
        target_replica_before
    );
    fixture.runtime.close().await;
}

// FakeServer's existing mutation override covers PATCH/DELETE, not target Create. Keep this
// override at the delivered transport boundary: execute its genuine retained replay first.
struct TargetReplayDisagreement {
    inner: Arc<MoveHttp>,
    operation_id: String,
    delivered: AtomicBool,
}

#[async_trait]
impl crate::http_transport::SerializedHttpExecutor for TargetReplayDisagreement {
    async fn invoke(&self, input: Zeroizing<String>) -> Result<String, RuntimeError> {
        let request: Value = serde_json::from_str(&input).unwrap();
        let replay = request["method"] == "PUT"
            && request["url"]
                == format!("{TARGET_ORIGIN}/api/v1/vaults/vault-1/items/{TARGET_ITEM}");
        let response =
            crate::http_transport::SerializedHttpExecutor::invoke(self.inner.as_ref(), input)
                .await?;
        if !replay {
            return Ok(response);
        }
        assert!(!self.delivered.swap(true, Ordering::SeqCst));
        let mut response: Value = serde_json::from_str(&response).unwrap();
        let mut body: Value = serde_json::from_slice(&response_body(&response)).unwrap();
        assert_eq!(body["operationId"], self.operation_id);
        assert_eq!(body["result"]["status"], "applied");
        assert_eq!(body["result"]["version"], 1);
        body["result"] = json!({"status":"rejected","code":"item_id_conflict"});
        response["body"] = json!(serde_json::to_vec(&body).unwrap());
        Ok(response.to_string())
    }

    fn cancel(&self, request_id: &str) {
        crate::http_transport::SerializedHttpExecutor::cancel(self.inner.as_ref(), request_id);
    }
}

#[tokio::test]
async fn legacy_remote_target_replay_disagreement_preserves_unproved_work_and_authority() {
    let (mut fixture, original) = admitted_legacy_move().await;
    establish_prefix(&fixture, &original, RemotePrefix::Deleted, None);
    let target_request = request(&original, CrossAccountMoveStep::TargetCreate);
    let operation_id = target_request.header("Idempotency-Key").unwrap().to_owned();
    let transport = Arc::new(TargetReplayDisagreement {
        inner: fixture.http.clone(),
        operation_id: operation_id.clone(),
        delivered: AtomicBool::new(false),
    });
    let saved = workflow(
        &durable_rows(&fixture.database.0, &fixture.source).await,
        SEMANTIC,
    );
    fixture.runtime.close().await;
    fixture.sqlite = MoveSqlite::open(&fixture.database.0);
    fixture.runtime = Runtime::with_configured_serialized_executors(
        fixture.sqlite.clone(),
        fixture.platform.clone(),
        transport.clone(),
        AuthClientConfig::new(
            "client-routing".into(),
            ClientPlatform::Desktop,
            "0.5.2-test".into(),
        )
        .unwrap(),
    );
    let calls = fixture.http.requests.lock().unwrap().len();
    fixture.runtime.open().await.unwrap();
    assert_eq!(fixture.http.requests.lock().unwrap().len(), calls);
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
    assert_eq!(serde_json::to_value(current(&fixture)).unwrap(), saved);
    let source_before = server_evidence(&fixture.http.source.server);
    let target_before = server_evidence(&fixture.http.target.server);
    let cache_before = fixture
        .runtime
        .require_snapshot(&fixture.source)
        .unwrap()
        .bootstrap;
    let target_replica_before = durable_rows(&fixture.database.0, &fixture.target).await;
    finish_or_block(&fixture).await;
    assert!(transport.delivered.load(Ordering::SeqCst));
    assert_unproved_target_is_retained(&fixture, &original).await;
    assert_target_lookup(&fixture, &operation_id);
    let replays = fixture.http.mutations(TARGET_ORIGIN);
    assert_eq!(replays.len(), 1);
    let replay = &replays[0];
    assert_eq!(replay.method, target_request.method);
    assert_eq!(replay.url, target_request.url);
    assert_eq!(replay.body, target_request.body);
    for (name, value) in target_request
        .headers
        .iter()
        .filter(|(name, _)| name != "Authorization")
    {
        assert_eq!(replay.header(name), Some(value.as_str()));
    }
    let requests = fixture.http.requests.lock().unwrap().clone();
    let lookup_index = requests
        .iter()
        .position(|request| {
            request.method == "GET"
                && request.url == format!("{TARGET_ORIGIN}/api/v1/operations/{operation_id}")
        })
        .unwrap();
    let replay_index = requests
        .iter()
        .position(|request| request.header("Idempotency-Key") == Some(operation_id.as_str()))
        .unwrap();
    assert!(lookup_index < replay_index);
    assert!(fixture.http.mutations(SOURCE_ORIGIN).is_empty());
    assert_eq!(server_evidence(&fixture.http.source.server), source_before);
    assert_eq!(server_evidence(&fixture.http.target.server), target_before);
    assert_eq!(
        fixture
            .runtime
            .require_snapshot(&fixture.source)
            .unwrap()
            .bootstrap,
        cache_before
    );
    assert_eq!(
        durable_rows(&fixture.database.0, &fixture.target).await,
        target_replica_before
    );
    fixture.runtime.close().await;
}
