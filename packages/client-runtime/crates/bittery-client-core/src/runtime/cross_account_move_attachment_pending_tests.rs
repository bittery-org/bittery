//! Physical Finalize commits independently of the source workflow's Pending checkpoint.
use super::*;

struct PublishedReply {
    store: Arc<SqliteAttachmentArtifactStore>,
    owner: Mutex<Option<AttachmentArtifactOwner>>,
    returned: MoveGate,
}

#[async_trait]
impl ProvisionalAttachmentArtifactStore for PublishedReply {
    async fn invoke_provisional(
        &self,
        request: ProvisionalAttachmentArtifactStoreRequest,
    ) -> Result<ProvisionalAttachmentArtifactStoreResponse, RuntimeError> {
        let response = self.store.invoke_provisional(request).await?;
        if let ProvisionalAttachmentArtifactStoreResponse::Finalized(owner) = &response {
            *self.owner.lock().unwrap() = Some(owner.clone());
            // SQLite has already completed Finalize. Only its reply is held: there is no
            // outstanding write and the separate Replica checkpoint has not been issued.
            self.returned.hold().await;
        }
        Ok(response)
    }
}

#[tokio::test]
async fn published_pending_checkpoint_survives_owner_loss_and_full_sweep_without_retranscryption() {
    let database = MoveDatabase::new();
    let artifact_database = MoveDatabase::new();
    let platform = Arc::new(InstallationPlatform::default());
    let artifacts = Arc::new(SqliteAttachmentArtifactStore::open(&artifact_database.0).unwrap());
    let publication = Arc::new(PublishedReply {
        store: artifacts.clone(),
        owner: Mutex::new(None),
        returned: MoveGate::new(),
    });
    let (http, binary) = attachment_ports(&database.0);
    let runtime = Runtime::with_configured_serialized_executors_and_attachment_move_preparation(
        MoveSqlite::open(&database.0),
        platform.clone(),
        http.clone(),
        AuthClientConfig::new(
            "client-routing".into(),
            ClientPlatform::Desktop,
            "0.5.2-test".into(),
        )
        .unwrap(),
        AttachmentMovePreparationFacade::new(
            publication.clone(),
            artifacts.clone(),
            binary.clone(),
        ),
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
            panic!("both Users must complete actual SRP Sign-in");
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
        panic!("the source-owned nonempty Move must be admitted");
    };
    let accepted = workflow(&durable_rows(&database.0, &source).await, &operation_id);
    http.actors.http.resumed.store(true, Ordering::SeqCst);
    http.actors.http.offline.store(false, Ordering::SeqCst);
    let runner = tokio::spawn(runtime.clone().run_operation_dispatch());
    let finalized = tokio::time::timeout(
        Duration::from_secs(15),
        publication.returned.reached.acquire(),
    )
    .await;
    if finalized.is_err() {
        publication.returned.release.add_permits(1);
        close_move_runtime(runtime, runner).await;
        panic!("the actual source transcryptor did not commit Finalize");
    }
    finalized.unwrap().unwrap().forget();
    let pending = workflow(&durable_rows(&database.0, &source).await, &operation_id);
    let owner = publication.owner.lock().unwrap().clone().unwrap();
    let ciphertext = stored_ciphertext(&artifacts, &owner).await.unwrap();
    let generation = publication_generation(&artifacts, &owner).await.unwrap();
    let state: i64 = rusqlite::Connection::open(&artifact_database.0)
        .unwrap()
        .query_row(
            "SELECT publication_state FROM attachment_move_provisional_artifacts
             WHERE account_id=?1 AND operation_id=?2 AND attachment_id=?3 AND generation=?4",
            rusqlite::params![
                source.as_str(),
                operation_id,
                owner.attachment_id(),
                generation
            ],
            |row| row.get(0),
        )
        .unwrap();
    let weak = Arc::downgrade(&runtime);
    runner.abort();
    let _ = runner.await;
    // The held reply belongs to the dead dispatcher; no storage mutation remains in flight.
    publication.returned.release.add_permits(1);
    drop(runtime);
    assert!(weak.upgrade().is_none());
    drop(publication);
    drop(artifacts);
    assert_eq!(
        state, 2,
        "Finalize must really have committed before owner loss"
    );
    assert_eq!(pending["attachments"], accepted["attachments"]);
    assert_eq!(pending["attachments"][0]["progress"]["type"], "pending");
    assert_eq!(
        pending["stage"],
        json!({"type":"attachments","nextIndex":0})
    );
    assert_eq!(pending["children"].as_array().unwrap().len(), 1);
    assert_eq!(
        pending["children"][0]["result"]["result"]["type"],
        "applied"
    );
    assert_eq!(owner.account_id(), &source);
    assert_eq!(owner.operation_id(), operation_id);
    assert_eq!(
        Some(owner.attachment_id()),
        pending["attachments"][0]["targetAttachmentId"].as_str()
    );
    assert!(ciphertext.len() > crate::ARTIFACT_CHUNK_BYTES * 2);
    assert_eq!(
        format!("{:x}", Sha256::digest(&ciphertext)),
        owner.ciphertext_sha256()
    );
    assert_eq!(binary.downloads.load(Ordering::SeqCst), 2);
    assert_eq!(binary.uploads.load(Ordering::SeqCst), 0);
    assert!(http.objects.grant_requests.lock().unwrap().is_empty());

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
    let preparation = tokio::spawn(reopened.clone().run_attachment_move_preparation());
    let swept = tokio::time::timeout(Duration::from_secs(10), sweep.wait_for(&source)).await;
    let recovered = stored_ciphertext(&artifacts, &owner).await;
    let recovered_generation = publication_generation(&artifacts, &owner).await;
    let after_sweep = workflow(&durable_rows(&database.0, &source).await, &operation_id);
    preparation.abort();
    let _ = preparation.await;
    if swept.is_err() || recovered.is_err() || recovered_generation.is_err() {
        reopened.close().await;
        assert!(
            swept.is_ok(),
            "the actual full lifecycle sweep must complete"
        );
        assert_eq!(before_sweep, pending);
        assert_eq!(after_sweep, pending);
        assert!(
            recovered.is_ok(),
            "full startup sweep deleted the physically published Pending artifact: {:?}",
            recovered.err()
        );
        assert!(
            recovered_generation.is_ok(),
            "Pending recovery lost its exact original generation"
        );
        return;
    }
    assert_eq!(before_sweep, pending);
    assert_eq!(after_sweep, pending);
    assert_eq!(recovered.unwrap(), ciphertext);
    assert_eq!(recovered_generation.unwrap(), generation);
    http.actors.http.trash_result.release.add_permits(1);
    http.actors.http.delete_result.release.add_permits(1);
    let runner = tokio::spawn(reopened.clone().run_operation_dispatch());
    let converged = tokio::time::timeout(Duration::from_secs(15), async {
        while resolution(&reopened, &source, &operation_id) != OperationResolution::Applied {
            tokio::task::yield_now().await;
        }
    })
    .await;
    let completed = workflow(&durable_rows(&database.0, &source).await, &operation_id);
    close_move_runtime(reopened, runner).await;
    converged.expect("Recover must reuse the original published Pending generation");
    assert_eq!(completed["target"], accepted["target"]);
    for field in ["sourceAttachmentId", "targetAttachmentId", "targetMetadata"] {
        assert_eq!(
            completed["attachments"][0][field],
            pending["attachments"][0][field]
        );
    }
    assert_eq!(completed["children"][0], pending["children"][0]);
    assert_eq!(completed["stage"], json!({"type":"completed"}));
    assert_eq!(
        completed["attachments"][0]["progress"]["artifact"]["artifactId"],
        owner.artifact_id()
    );
    let uploaded = http.objects.uploaded.lock().unwrap().clone().unwrap();
    assert_eq!(uploaded.owner, owner);
    assert_eq!(uploaded.ciphertext, ciphertext);
    assert_eq!(
        binary.downloads.load(Ordering::SeqCst),
        2,
        "recovery cannot retranscrypt or reopen the source blob"
    );
    assert_eq!(binary.uploads.load(Ordering::SeqCst), 1);
    assert_eq!(http.actors.http.target.server.created_items().len(), 1);
    assert!(http.actors.http.source.server.created_items().is_empty());
}
