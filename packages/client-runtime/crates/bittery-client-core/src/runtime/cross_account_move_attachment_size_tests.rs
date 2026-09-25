//! A valid encrypted stream must agree with its accepted plaintext-size bound before a grant.
use super::*;

struct SizeMismatchHttp {
    inner: Arc<AttachmentHttp>,
    destination_grants: AtomicUsize,
}

#[async_trait]
impl crate::http_transport::SerializedHttpExecutor for SizeMismatchHttp {
    async fn invoke(&self, input: Zeroizing<String>) -> Result<String, RuntimeError> {
        let request: Value = serde_json::from_str(&input).unwrap();
        if request["method"] == "POST"
            && request["url"]
                .as_str()
                .unwrap()
                .ends_with("/attachment-uploads")
        {
            assert_eq!(
                routing_request_body(&request)["fileSize"],
                self.inner.source.file_size
            );
            self.destination_grants.fetch_add(1, Ordering::SeqCst);
            return Ok(json!({"type":"networkFailure"}).to_string());
        }
        self.inner.invoke(input).await
    }

    fn cancel(&self, dispatch_id: &str) {
        self.inner.cancel(dispatch_id);
    }
}

#[tokio::test]
async fn valid_ciphertext_with_inconsistent_declared_size_refuses_before_destination_grant() {
    let database = MoveDatabase::new();
    let artifact_database = MoveDatabase::new();
    let artifacts = Arc::new(SqliteAttachmentArtifactStore::open(&artifact_database.0).unwrap());
    let (mut inner, binary) = attachment_ports(&database.0);
    // Keep the current metadata and source grant identical. The actual encrypted stream is
    // authentic, but this declaration is large enough to change its canonical envelope length.
    // It remains above the real length, so the bounded source reader must finish both passes.
    Arc::get_mut(&mut inner).unwrap().source.file_size += 12;
    inner
        .actors
        .http
        .source
        .server
        .set_attachment_authority(vec![serde_json::to_value(&inner.source).unwrap()]);
    let http = Arc::new(SizeMismatchHttp {
        inner,
        destination_grants: AtomicUsize::new(0),
    });
    let runtime = Runtime::with_configured_serialized_executors_and_attachment_move_preparation(
        MoveSqlite::open(&database.0),
        Arc::new(InstallationPlatform::default()),
        http.clone(),
        AuthClientConfig::new(
            "client-routing".into(),
            ClientPlatform::Desktop,
            "0.5.2-test".into(),
        )
        .unwrap(),
        AttachmentMovePreparationFacade::new(artifacts.clone(), artifacts, binary.clone()),
        Arc::new(crate::runtime::attachment_move_lifecycle::TestAccountLeasePort),
    );
    runtime.open().await.unwrap();
    let mut accounts = Vec::new();
    for identity in [RoutingAuthIdentity::default(), OTHER_USER] {
        let RuntimeResponse::SignedIn { account_id, .. } = runtime
            .request(
                sign_in_request_to(SOURCE_ORIGIN, identity.normalized_email),
                RequestCancellation::new(),
            )
            .await
            .unwrap()
        else {
            panic!("both Users must complete their own public SRP Sign-in")
        };
        accounts.push(account_id);
    }
    let [source, target]: [AccountId; 2] = accounts.try_into().unwrap();
    http.inner.actors.http.offline.store(true, Ordering::SeqCst);
    let RuntimeResponse::Accepted { operation_id, .. } = runtime
        .request(
            RuntimeRequest::MoveItem {
                account_id: source.clone(),
                item_id: SOURCE_ITEM.into(),
                target_account_id: Some(target.clone()),
                target_vault_id: "vault-2".into(),
            },
            RequestCancellation::new(),
        )
        .await
        .unwrap()
    else {
        panic!("the current metadata must be admitted before its bytes can be validated")
    };
    let accepted = workflow(&durable_rows(&database.0, &source).await, &operation_id);
    let target_before = durable_rows(&database.0, &target).await;
    http.inner
        .actors
        .http
        .offline
        .store(false, Ordering::SeqCst);
    http.inner.actors.http.resumed.store(true, Ordering::SeqCst);
    let mut result = accepted.clone();
    for _ in 0..6 {
        let _ = runtime.dispatch_eligible_operations().await;
        result = workflow(&durable_rows(&database.0, &source).await, &operation_id);
        if result["disposition"]["type"] != "ready" {
            break;
        }
    }
    let target_after = durable_rows(&database.0, &target).await;
    assert_source_visible(&runtime, &source, crate::ItemProjectionStatus::Pending);
    runtime.close().await;

    assert_eq!(binary.downloads.load(Ordering::SeqCst), 2);
    assert_eq!(http.inner.source_grants.load(Ordering::SeqCst), 2);
    assert_eq!(
        http.destination_grants.load(Ordering::SeqCst),
        0,
        "a completed stream with an inconsistent declared size cannot acquire a target grant"
    );
    assert_eq!(binary.uploads.load(Ordering::SeqCst), 0);
    assert_eq!(target_after, target_before);
    assert_eq!(result["source"], accepted["source"]);
    assert_eq!(result["target"], accepted["target"]);
    assert_eq!(result["attachments"], accepted["attachments"]);
    assert_eq!(result["children"].as_array().unwrap().len(), 1);
    assert_eq!(result["children"][0]["result"]["result"]["type"], "applied");
    assert_eq!(
        result["disposition"],
        json!({"type":"blocked","reason":"missingArtifact"})
    );
    assert!(http.inner.actors.http.mutations(SOURCE_ORIGIN).is_empty());
    assert_eq!(http.inner.actors.http.target.server.creates(), 1);
}
