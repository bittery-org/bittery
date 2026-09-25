//! A retained encrypted artifact survives real Runtime owner loss and startup sweep.
use super::*;
use crate::attachment_artifact_store::{
    ProvisionalAttachmentArtifactScope, ProvisionalAttachmentArtifactStore,
    ProvisionalAttachmentArtifactStoreRequest, ProvisionalAttachmentArtifactStoreResponse,
};

struct SweepWitness {
    store: Arc<SqliteAttachmentArtifactStore>,
    completed: Mutex<Vec<AccountId>>,
    changed: tokio::sync::Notify,
}

#[async_trait]
impl AttachmentArtifactStore for SweepWitness {
    async fn invoke(
        &self,
        request: AttachmentArtifactStoreRequest,
    ) -> Result<AttachmentArtifactStoreResponse, RuntimeError> {
        let sweeping = match &request {
            AttachmentArtifactStoreRequest::SweepOrphans { account_id, .. } => {
                Some(account_id.clone())
            }
            _ => None,
        };
        let response = self.store.invoke(request).await?;
        if let Some(account_id) = sweeping {
            self.completed.lock().unwrap().push(account_id);
            self.changed.notify_waiters();
        }
        Ok(response)
    }
}

impl SweepWitness {
    async fn wait_for(&self, account: &AccountId) {
        loop {
            let notified = self.changed.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            if self.completed.lock().unwrap().contains(account) {
                return;
            }
            notified.await;
        }
    }
}

async fn reopen_attachment_runtime(
    database: &Path,
    artifacts: Arc<SqliteAttachmentArtifactStore>,
    platform: Arc<InstallationPlatform>,
    http: Arc<AttachmentHttp>,
    binary: Arc<AttachmentBinary>,
    published: Arc<dyn AttachmentArtifactStore>,
) -> Arc<Runtime> {
    let runtime = Runtime::with_configured_serialized_executors_and_attachment_move_preparation(
        MoveSqlite::open(database),
        platform,
        http,
        AuthClientConfig::new(
            "client-routing".into(),
            ClientPlatform::Desktop,
            "0.5.2-test".into(),
        )
        .unwrap(),
        AttachmentMovePreparationFacade::new(artifacts, published, binary),
        Arc::new(crate::runtime::attachment_move_lifecycle::TestAccountLeasePort),
    );
    runtime.open().await.unwrap();
    runtime
}

fn checkpoint_owner(record: &Value, source: &AccountId) -> AttachmentArtifactOwner {
    let checkpoint = &record["attachments"][0];
    let artifact = &checkpoint["progress"]["artifact"];
    AttachmentArtifactOwner::from_reference_parts(
        source.clone(),
        record["operationId"].as_str().unwrap(),
        checkpoint["targetAttachmentId"].as_str().unwrap(),
        artifact["artifactId"].as_str().unwrap(),
        artifact["ciphertextSha256"].as_str().unwrap(),
        artifact["byteLength"]
            .as_str()
            .unwrap()
            .parse::<u64>()
            .unwrap(),
    )
    .unwrap()
}

async fn stored_ciphertext(
    store: &SqliteAttachmentArtifactStore,
    owner: &AttachmentArtifactOwner,
) -> Result<Vec<u8>, RuntimeError> {
    let mut bytes = Vec::new();
    let mut index = 0;
    loop {
        let AttachmentArtifactStoreResponse::ChunkRead(chunk) = store
            .invoke(AttachmentArtifactStoreRequest::ReadChunk {
                owner: owner.clone(),
                chunk_index: index,
            })
            .await?
        else {
            panic!("expected the original published ciphertext chunks");
        };
        bytes.extend_from_slice(&chunk.bytes);
        if chunk.is_last {
            return Ok(bytes);
        }
        index += 1;
    }
}

async fn publication_generation(
    store: &SqliteAttachmentArtifactStore,
    owner: &AttachmentArtifactOwner,
) -> Result<String, RuntimeError> {
    let scope = ProvisionalAttachmentArtifactScope::new(
        owner.account_id().clone(),
        owner.operation_id(),
        owner.attachment_id(),
    )
    .unwrap();
    match store
        .invoke_provisional(ProvisionalAttachmentArtifactStoreRequest::Recover { scope })
        .await?
    {
        ProvisionalAttachmentArtifactStoreResponse::RecoveryAvailable(recovery) => {
            Ok(recovery.generation().into())
        }
        _ => Err(RuntimeError::new(
            RuntimeErrorCode::StorageUnavailable,
            "The accepted published generation was removed",
        )),
    }
}

#[tokio::test]
async fn lost_committed_grant_reopens_with_the_original_ciphertext_and_target_identity() {
    let database = MoveDatabase::new();
    let artifact_database = MoveDatabase::new();
    let platform = Arc::new(InstallationPlatform::default());
    let artifacts = Arc::new(SqliteAttachmentArtifactStore::open(&artifact_database.0).unwrap());
    let (http, binary) = attachment_ports(&database.0);
    let runtime = reopen_attachment_runtime(
        &database.0,
        artifacts.clone(),
        platform.clone(),
        http.clone(),
        binary.clone(),
        artifacts.clone(),
    )
    .await;
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
            panic!("both Users must authenticate through SRP")
        };
        accounts.push(account_id);
    }
    let [source, target]: [AccountId; 2] = accounts.try_into().unwrap();
    http.actors.http.offline.store(true, Ordering::SeqCst);
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
        panic!("expected source-owned admission")
    };
    let accepted = workflow(&durable_rows(&database.0, &source).await, &operation_id);
    http.lose_first_grant.store(true, Ordering::SeqCst);
    http.actors.http.resumed.store(true, Ordering::SeqCst);
    http.actors.http.offline.store(false, Ordering::SeqCst);
    let runner = tokio::spawn(runtime.clone().run_operation_dispatch());
    let lost = tokio::time::timeout(Duration::from_secs(15), async {
        loop {
            let record = workflow(&durable_rows(&database.0, &source).await, &operation_id);
            if !http.objects.grant_requests.lock().unwrap().is_empty()
                && record["disposition"] == json!({"type":"waiting", "reason":"offline"})
            {
                return record;
            }
            tokio::task::yield_now().await;
        }
    })
    .await;
    if lost.is_err() {
        close_move_runtime(runtime, runner).await;
        panic!("real committed first grant did not lose its reply after a sealed checkpoint");
    }
    let stranded = lost.unwrap();
    assert_eq!(stranded["attachments"][0]["progress"]["type"], "encrypted");
    assert_eq!(stranded["children"].as_array().unwrap().len(), 1);
    assert_eq!(
        stranded["children"][0]["result"]["result"]["type"],
        "applied"
    );
    let owner = checkpoint_owner(&stranded, &source);
    let ciphertext = stored_ciphertext(&artifacts, &owner).await.unwrap();
    let generation = publication_generation(&artifacts, &owner).await.unwrap();
    let grants_before_loss = http.objects.grant_requests.lock().unwrap().clone();
    assert_eq!(grants_before_loss.len(), 1);
    assert_eq!(binary.downloads.load(Ordering::SeqCst), 2);
    assert_eq!(binary.uploads.load(Ordering::SeqCst), 0);
    let weak = Arc::downgrade(&runtime);
    runner.abort();
    let _ = runner.await;
    drop(runtime);
    assert!(
        weak.upgrade().is_none(),
        "the old Core owner must actually be gone without Close"
    );
    drop(artifacts);

    let artifacts = Arc::new(SqliteAttachmentArtifactStore::open(&artifact_database.0).unwrap());
    let sweep = Arc::new(SweepWitness {
        store: artifacts.clone(),
        completed: Mutex::default(),
        changed: tokio::sync::Notify::new(),
    });
    let reopened = reopen_attachment_runtime(
        &database.0,
        artifacts.clone(),
        platform,
        http.clone(),
        binary.clone(),
        sweep.clone(),
    )
    .await;
    http.actors.http.offline.store(false, Ordering::SeqCst);
    for account_id in [&source, &target] {
        reopened
            .request(
                RuntimeRequest::QuickUnlock {
                    account_id: account_id.clone(),
                    master_password: MASTER_PASSWORD.into(),
                },
                RequestCancellation::new(),
            )
            .await
            .unwrap();
    }
    let before_sweep = workflow(&durable_rows(&database.0, &source).await, &operation_id);
    assert_eq!(
        before_sweep, stranded,
        "fresh online unlock may not rewrite accepted ciphertext or scheduling"
    );
    let preparation = tokio::spawn(reopened.clone().run_attachment_move_preparation());
    let swept = tokio::time::timeout(Duration::from_secs(10), sweep.wait_for(&source)).await;
    let recovered = stored_ciphertext(&artifacts, &owner).await;
    let recovered_generation = publication_generation(&artifacts, &owner).await;
    if swept.is_err() || recovered.is_err() || recovered_generation.is_err() {
        preparation.abort();
        let _ = preparation.await;
        reopened.close().await;
        assert!(
            swept.is_ok(),
            "startup must execute the existing full Account artifact sweep"
        );
        assert!(
            recovered.is_ok(),
            "startup sweep removed the accepted source-owned encrypted Move artifact: {:?}",
            recovered.err()
        );
        assert!(
            recovered_generation.is_ok(),
            "startup sweep removed its exact published generation"
        );
        return;
    }
    assert_eq!(recovered.unwrap(), ciphertext);
    assert_eq!(recovered_generation.unwrap(), generation);
    assert_eq!(binary.downloads.load(Ordering::SeqCst), 2);
    assert_eq!(http.source_grants.load(Ordering::SeqCst), 2);
    assert_eq!(
        http.objects.grant_requests.lock().unwrap().len(),
        1,
        "read-only startup must not dispatch a new target capability"
    );
    http.actors.http.trash_result.release.add_permits(1);
    http.actors.http.delete_result.release.add_permits(1);
    let runner = tokio::spawn(reopened.clone().run_operation_dispatch());
    let converged = tokio::time::timeout(Duration::from_secs(15), async {
        while resolution(&reopened, &source, &operation_id) != OperationResolution::Applied {
            tokio::task::yield_now().await;
        }
    })
    .await;
    let final_record = workflow(&durable_rows(&database.0, &source).await, &operation_id);
    preparation.abort();
    let _ = preparation.await;
    close_move_runtime(reopened, runner).await;
    converged.expect("same-ID renewal must complete with the retained original artifact");
    assert_eq!(final_record["target"], accepted["target"]);
    assert_eq!(final_record["attachments"], stranded["attachments"]);
    assert_eq!(final_record["children"][0], stranded["children"][0]);
    assert_eq!(final_record["stage"], json!({"type":"completed"}));
    let grants = http.objects.grant_requests.lock().unwrap().clone();
    assert_eq!(grants.len(), 3);
    for grant in &grants {
        assert_exact_retry(grant, &grants_before_loss[0]);
    }
    let uploaded = http.objects.uploaded.lock().unwrap().clone().unwrap();
    assert_eq!(uploaded.owner, owner);
    assert_eq!(uploaded.ciphertext, ciphertext);
    assert_eq!(
        binary.downloads.load(Ordering::SeqCst),
        2,
        "owner loss must not retranscrypt or reopen the source blob"
    );
    assert_eq!(binary.uploads.load(Ordering::SeqCst), 1);
    assert_eq!(http.actors.http.target.server.created_items().len(), 1);
    assert!(http.actors.http.source.server.created_items().is_empty());
}

#[path = "cross_account_move_attachment_pending_tests.rs"]
mod pending_tests;

#[path = "cross_account_move_attachment_completed_tests.rs"]
mod completed_tests;

#[path = "cross_account_move_attachment_refusal_tests.rs"]
mod refusal_tests;

#[path = "cross_account_move_attachment_lock_tests.rs"]
mod lock_tests;

#[path = "cross_account_move_attachment_two_file_tests.rs"]
mod two_file_tests;
