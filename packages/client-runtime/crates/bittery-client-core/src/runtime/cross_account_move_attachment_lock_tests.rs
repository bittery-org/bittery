//! Either participating Account can cancel a completed PUT's still-pending local reply.
use super::*;

struct UploadReplyState {
    hold_first: AtomicBool,
    gate: MoveGate,
    drained: tokio::sync::Semaphore,
    finished: Mutex<Vec<UploadedObject>>,
}

struct UploadReplyLifetime(Arc<UploadReplyState>);

impl Drop for UploadReplyLifetime {
    fn drop(&mut self) {
        self.0.drained.add_permits(1);
    }
}

struct HeldUploadPort {
    inner: Arc<AttachmentBinary>,
    state: Arc<UploadReplyState>,
}

struct HeldUploadReply {
    inner: Option<Box<dyn AttachmentMoveUpload>>,
    objects: Arc<AttachmentObjects>,
    state: Arc<UploadReplyState>,
    held: bool,
}

#[async_trait]
impl AttachmentMoveTransferPort for HeldUploadPort {
    async fn open_source(
        &self,
        request: AttachmentMoveDownloadRequest,
    ) -> Result<Box<dyn AttachmentMoveDownload>, AttachmentMoveTransferError> {
        self.inner.open_source(request).await
    }

    async fn open_upload(
        &self,
        account_id: &AccountId,
        operation_id: &str,
        grant: &AttachmentMoveUploadGrant,
        owner: &AttachmentArtifactOwner,
    ) -> Result<Box<dyn AttachmentMoveUpload>, AttachmentMoveTransferError> {
        let inner = self
            .inner
            .open_upload(account_id, operation_id, grant, owner)
            .await?;
        Ok(Box::new(HeldUploadReply {
            inner: Some(inner),
            objects: self.inner.objects.clone(),
            state: self.state.clone(),
            held: self.state.hold_first.swap(false, Ordering::SeqCst),
        }))
    }
}

#[async_trait]
impl AttachmentMoveUpload for HeldUploadReply {
    async fn write_chunk(&mut self, bytes: &[u8]) -> Result<(), AttachmentMoveTransferError> {
        self.inner.as_mut().unwrap().write_chunk(bytes).await
    }

    async fn finish(mut self: Box<Self>) -> Result<(), AttachmentMoveTransferError> {
        self.inner.take().unwrap().finish().await?;
        let uploaded = self.objects.uploaded.lock().unwrap().clone().unwrap();
        self.state.finished.lock().unwrap().push(uploaded);
        if self.held {
            let _reply = UploadReplyLifetime(self.state.clone());
            self.state.gate.hold().await;
        }
        Ok(())
    }
}

#[tokio::test]
async fn source_lock_after_ciphertext_put_retains_the_original_move_for_unlock() {
    lock_after_put(true).await;
}

#[tokio::test]
async fn target_lock_after_ciphertext_put_retains_the_original_move_for_unlock() {
    lock_after_put(false).await;
}

async fn lock_after_put(lock_source: bool) {
    let database = MoveDatabase::new();
    let artifact_database = MoveDatabase::new();
    let artifacts = Arc::new(SqliteAttachmentArtifactStore::open(&artifact_database.0).unwrap());
    let (http, binary) = attachment_ports(&database.0);
    let state = Arc::new(UploadReplyState {
        hold_first: AtomicBool::new(true),
        gate: MoveGate::new(),
        drained: tokio::sync::Semaphore::new(0),
        finished: Mutex::default(),
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
        AttachmentMovePreparationFacade::new(
            artifacts.clone(),
            artifacts.clone(),
            Arc::new(HeldUploadPort {
                inner: binary.clone(),
                state: state.clone(),
            }),
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
            panic!("both Users must complete public SRP Sign-in")
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
        panic!("a valid Attachment manifest must be accepted")
    };
    http.actors.http.resumed.store(true, Ordering::SeqCst);
    http.actors.http.offline.store(false, Ordering::SeqCst);
    let runner = tokio::spawn(runtime.clone().run_operation_dispatch());
    state
        .gate
        .wait("actual ciphertext PUT before its local finish reply")
        .await;
    let before = workflow(&durable_rows(&database.0, &source).await, &operation_id);
    let cached_before = runtime
        .require_snapshot(&source)
        .unwrap()
        .cross_account_moves;
    let owner = checkpoint_owner(&before, &source);
    let generation = publication_generation(&artifacts, &owner).await.unwrap();
    let ciphertext = stored_ciphertext(&artifacts, &owner).await.unwrap();
    let original_grants = http.objects.grant_requests.lock().unwrap().clone();
    let uploads_before_lock = state.finished.lock().unwrap().clone();
    let selected = if lock_source { &source } else { &target };
    let other = if lock_source { &target } else { &source };
    let locked = tokio::time::timeout(
        Duration::from_secs(5),
        runtime.request(
            RuntimeRequest::Lock {
                account_id: selected.clone(),
            },
            RequestCancellation::new(),
        ),
    )
    .await;
    if !matches!(locked, Ok(Ok(_))) {
        state.gate.release.add_permits(1);
        http.actors.http.trash_result.release.add_permits(1);
        http.actors.http.delete_result.release.add_permits(1);
        close_move_runtime(runtime, runner).await;
        panic!("public participant Lock must cancel and drain the held PUT reply")
    }
    let drained = state
        .drained
        .try_acquire()
        .map(|permit| permit.forget())
        .is_ok();
    let retained = workflow(&durable_rows(&database.0, &source).await, &operation_id);
    let cached_retained = runtime
        .require_snapshot(&source)
        .unwrap()
        .cross_account_moves;
    let retained_generation = publication_generation(&artifacts, &owner).await.unwrap();
    let retained_bytes = stored_ciphertext(&artifacts, &owner).await.unwrap();
    let grants_while_locked = http.objects.grant_requests.lock().unwrap().clone();
    let registered_while_locked = http.objects.registration_requests.lock().unwrap().len();
    let source_mutations_while_locked = http.actors.http.mutations(SOURCE_ORIGIN);
    let selected_access = runtime.account_access_state(selected);
    let other_access = runtime.account_access_state(other);
    state.gate.release.add_permits(1);
    http.actors.http.trash_result.release.add_permits(1);
    http.actors.http.delete_result.release.add_permits(1);
    runtime
        .request(
            quick_unlock_request(selected.as_str()),
            RequestCancellation::new(),
        )
        .await
        .unwrap();
    let completed = tokio::time::timeout(Duration::from_secs(15), async {
        while resolution(&runtime, &source, &operation_id) != OperationResolution::Applied {
            tokio::task::yield_now().await;
        }
    })
    .await;
    let final_record = workflow(&durable_rows(&database.0, &source).await, &operation_id);
    close_move_runtime(runtime, runner).await;

    assert!(
        drained,
        "Lock must abandon the completed PUT's old local reply before returning"
    );
    assert_eq!(uploads_before_lock.len(), 1);
    assert_eq!(uploads_before_lock[0].owner, owner);
    assert_eq!(uploads_before_lock[0].ciphertext, ciphertext);
    assert_eq!(selected_access, Some(AccountAccessState::Locked));
    assert_eq!(other_access, Some(AccountAccessState::Unlocked));
    assert_eq!(retained, before);
    assert_eq!(
        cached_retained, cached_before,
        "cancellation cannot adopt any late Attachment checkpoint"
    );
    assert_eq!(retained_generation, generation);
    assert_eq!(retained_bytes, ciphertext);
    assert_eq!(original_grants.len(), 2);
    assert_eq!(grants_while_locked.len(), original_grants.len());
    for (grant, original) in grants_while_locked.iter().zip(&original_grants) {
        assert_exact_retry(grant, original);
    }
    assert_eq!(registered_while_locked, 0);
    assert!(source_mutations_while_locked.is_empty());
    assert_eq!(
        before["stage"],
        json!({"type":"attachments", "nextIndex":0})
    );
    assert_eq!(before["children"].as_array().unwrap().len(), 2);
    assert_eq!(before["children"][1]["type"], "attachmentRegistration");
    assert!(before["children"][1]["result"].is_null());
    completed.expect("explicit unlock must resume the exact decided Attachment registration");
    assert_eq!(final_record["stage"], json!({"type":"completed"}));
    assert_eq!(final_record["source"], before["source"]);
    assert_eq!(final_record["target"], before["target"]);
    assert_eq!(final_record["attachments"], before["attachments"]);
    assert_eq!(
        final_record["destinationBinding"],
        before["destinationBinding"]
    );
    assert_eq!(final_record["children"][0], before["children"][0]);
    assert_eq!(
        final_record["children"][1]["request"],
        before["children"][1]["request"]
    );
    assert_eq!(
        final_record["children"][1]["result"]["type"],
        "acknowledged"
    );
    assert_eq!(final_record["children"].as_array().unwrap().len(), 4);
    for (index, version) in [(0, 1), (2, 2), (3, 3)] {
        assert_eq!(
            final_record["children"][index]["result"]["result"]["type"],
            "applied"
        );
        assert_eq!(
            final_record["children"][index]["result"]["result"]["version"],
            version
        );
    }
    let grants = http.objects.grant_requests.lock().unwrap().clone();
    assert_eq!(grants.len(), 3);
    for grant in &grants {
        assert_exact_retry(grant, &original_grants[0]);
    }
    assert_eq!(http.objects.registration_requests.lock().unwrap().len(), 1);
    let uploads = state.finished.lock().unwrap();
    assert_eq!(
        uploads.len(),
        2,
        "unlock retries the unacknowledged PUT at its original key"
    );
    for upload in uploads.iter() {
        assert_eq!(upload.owner, owner);
        assert_eq!(upload.ciphertext, ciphertext);
        assert_eq!(upload.headers, uploads[0].headers);
    }
    assert_eq!(binary.downloads.load(Ordering::SeqCst), 2);
    assert_eq!(http.source_grants.load(Ordering::SeqCst), 2);
    assert_eq!(binary.uploads.load(Ordering::SeqCst), 2);
    assert_eq!(http.actors.http.target.server.creates(), 1);
    assert_eq!(http.actors.http.source.server.created_items().len(), 0);
    assert_eq!(http.actors.http.mutations(SOURCE_ORIGIN).len(), 2);
}
