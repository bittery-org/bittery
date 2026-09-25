//! The ordinary retrying copy still uses its own outcome lookup and immutable PUT.
use super::*;

pub(super) struct CopyDispatchNetwork {
    auth: Arc<AccountNetworks>,
    copy: Value,
    armed: std::sync::atomic::AtomicBool,
    requests: Mutex<Vec<Value>>,
    progressed: tokio::sync::Notify,
}

impl CopyDispatchNetwork {
    pub(super) fn new(auth: Arc<AccountNetworks>, copy: &Value) -> Self {
        Self {
            auth,
            copy: copy.clone(),
            armed: std::sync::atomic::AtomicBool::new(false),
            requests: Mutex::new(Vec::new()),
            progressed: tokio::sync::Notify::new(),
        }
    }
}

#[async_trait]
impl SerializedHttpExecutor for CopyDispatchNetwork {
    async fn invoke(&self, request_json: Zeroizing<String>) -> Result<String, RuntimeError> {
        if !self.armed.load(std::sync::atomic::Ordering::SeqCst) {
            return self.auth.invoke(request_json).await;
        }
        let request: Value = serde_json::from_str(&request_json).unwrap();
        self.requests.lock().unwrap().push(request.clone());
        self.progressed.notify_one();
        let url = request["url"].as_str().unwrap();
        if url == format!("{TARGET_SERVER}/api/v1/auth/me") {
            assert_eq!(request["method"], "GET");
            return self.auth.invoke(request_json).await;
        }
        let lookup = format!(
            "{SOURCE_SERVER}/api/v1/operations/{}",
            self.copy["operationId"].as_str().unwrap()
        );
        if url == lookup {
            assert_eq!(request["method"], "GET");
            assert_eq!(request["body"], json!([]));
            return Ok(admission_http_completed(404, json!({})));
        }
        assert_eq!(
            url,
            format!(
                "{SOURCE_SERVER}/api/v1/vaults/{}/items/{}",
                encode_component(self.copy["vaultId"].as_str().unwrap()),
                encode_component(self.copy["entityId"].as_str().unwrap())
            )
        );
        assert_eq!(request["method"], "PUT");
        assert_eq!(request["body"], json!(immutable_create_body(&self.copy)));
        let headers = request["headers"].as_array().unwrap();
        assert_eq!(
            headers
                .iter()
                .filter(|h| h["name"]
                    .as_str()
                    .unwrap()
                    .eq_ignore_ascii_case("Idempotency-Key"))
                .collect::<Vec<_>>(),
            vec![&json!({"name":"Idempotency-Key", "value":self.copy["operationId"]})]
        );
        assert!(headers
            .iter()
            .any(|h| h["name"] == "Content-Type" && h["value"] == "application/json"));
        assert!(headers.iter().any(|h| h["name"]
            .as_str()
            .unwrap()
            .eq_ignore_ascii_case("Authorization")
            && h["value"].as_str().unwrap().starts_with("Bearer ")));
        // No Server success or durable completion is invented by this tracer.
        std::future::pending().await
    }

    fn cancel(&self, request_id: &str) {
        self.auth.cancel(request_id);
    }
}

pub(super) async fn assert_only_independent_copy_dispatches(
    runtime: &Arc<Runtime>,
    directory: &TestDirectory,
    network: &Arc<CopyDispatchNetwork>,
    original: &Value,
    copy: &Value,
) {
    let before = snapshot(directory, desktop::ACCOUNT).await;
    let target_before = snapshot(directory, SECOND_ACCOUNT).await;
    let held = row(&before, "crossAccountMoves");
    let ordinary = row(&before, "operations");
    let overlay = row(&before, "optimisticItems");
    let auth_before = network.auth.call_count();
    network
        .armed
        .store(true, std::sync::atomic::Ordering::SeqCst);
    let runner = tokio::spawn(runtime.clone().run_operation_dispatch());
    let reached = tokio::time::timeout(std::time::Duration::from_secs(10), async {
        loop {
            let notification = network.progressed.notified();
            if network.requests.lock().unwrap().len() >= 3 {
                break;
            }
            notification.await;
        }
    })
    .await;
    runner.abort();
    let result = runner.await;
    assert!(result.unwrap_err().is_cancelled());
    assert!(
        reached.is_ok(),
        "copy PUT and the independent target Account refresh must actually be reached: {:?}",
        network.requests.lock().unwrap()
    );
    let requests = network.requests.lock().unwrap().clone();
    assert_eq!(requests.len(), 3);
    let copy_requests: Vec<_> = requests
        .iter()
        .filter(|r| !r["url"].as_str().unwrap().ends_with("/api/v1/auth/me"))
        .collect();
    assert_eq!(copy_requests.len(), 2);
    assert_eq!(copy_requests[0]["method"], "GET");
    assert_eq!(copy_requests[1]["method"], "PUT");
    // The pending copy PUT holds the source Account execution lock. Source refresh waits
    // for that same lock; only the independent target Account reaches its HTTP request.
    assert_eq!(
        requests
            .iter()
            .filter(|r| r["url"] == format!("{SOURCE_SERVER}/api/v1/auth/me"))
            .count(),
        0
    );
    assert_eq!(
        requests
            .iter()
            .filter(
                |r| r["url"] == format!("{TARGET_SERVER}/api/v1/auth/me") && r["method"] == "GET"
            )
            .count(),
        1
    );
    assert_eq!(network.auth.call_count(), auth_before + 1);
    let after = snapshot(directory, desktop::ACCOUNT).await;
    assert_eq!(row(&after, "crossAccountMoves"), held);
    assert_eq!(row(&after, "optimisticItems"), overlay);
    let current = row(&after, "operations");
    for field in [
        "operationId",
        "request",
        "legacyAdmission",
        "target",
        "kind",
    ] {
        assert!(
            current.get(field).is_some(),
            "current copy must retain {field}"
        );
        assert!(
            ordinary.get(field).is_some(),
            "admitted copy must contain {field}"
        );
        assert_eq!(current[field], ordinary[field], "{field}");
    }
    assert_eq!(current["operationId"], copy["operationId"]);
    assert_eq!(held["operationId"], original["operationId"]);
    assert!(after["rows"]
        .as_array()
        .unwrap()
        .iter()
        .all(|r| r["store"] != "operationReceipts" && r["store"] != "authorityItems"));
    assert_eq!(snapshot(directory, SECOND_ACCOUNT).await, target_before);
    assert_exact_copy_readable(runtime, copy);
    // The ordinary copy may have advanced its lease/scheduling; the held row cannot.
    let sink = Arc::new(Sink::default());
    let observation = runtime
        .observe(
            ObservationRequest::Operations {
                account_id: desktop::ACCOUNT.into(),
            },
            sink.clone(),
        )
        .unwrap();
    let RuntimeProjection::Operations(projection) = sink.0.lock().unwrap().last().cloned().unwrap()
    else {
        panic!("Operations")
    };
    let value = serde_json::to_value(projection).unwrap();
    let held_projection = value["operations"]
        .as_array()
        .unwrap()
        .iter()
        .find(|op| op["operationId"] == original["operationId"])
        .unwrap();
    assert_eq!(held_projection["resolution"], "legacyConflicted");
    assert_eq!(
        held_projection["crossAccountMove"]["disposition"],
        json!({"type":"legacyHeld"})
    );
    assert_eq!(held_projection["crossAccountMove"]["sourceVisible"], false);
    observation.close();
}
