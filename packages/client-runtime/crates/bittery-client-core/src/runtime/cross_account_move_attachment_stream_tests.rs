//! Real partial byte effects and authenticated finish refusal through the cross-Account adapter.
use super::*;

struct StreamHttp {
    inner: Arc<RefusalHttp>,
    first_source_401: AtomicBool,
    source_requests: Mutex<Vec<RecordedRequest>>,
}

#[async_trait]
impl SerializedHttpExecutor for StreamHttp {
    async fn invoke(&self, input: Zeroizing<String>) -> Result<String, RuntimeError> {
        let request: Value = serde_json::from_str(&input).unwrap();
        let Some(url) = request["url"].as_str() else {
            return self.inner.invoke(input).await;
        };
        let recorded = attachment_request(&request);
        let source = &self.inner.inner;
        if url == format!("{SOURCE_ORIGIN}/api/v1/attachments/{SOURCE_ATTACHMENT}/download-urls") {
            assert_eq!(recorded.method, "POST");
            self.source_requests.lock().unwrap().push(recorded.clone());
            if self.first_source_401.swap(false, Ordering::SeqCst) {
                assert_eq!(recorded.header("authorization"), Some("Bearer fresh-token"));
                return Ok(refusal_problem(401, "UNAUTHORIZED", false));
            }
            let token = recorded
                .header("authorization")
                .unwrap()
                .strip_prefix("Bearer ")
                .unwrap();
            assert!(source
                .actors
                .http
                .source
                .server
                .accepted_tokens
                .lock()
                .unwrap()
                .iter()
                .any(|accepted| accepted == token));
            // This fixture's auth and Item routes have separate stores. The source grant uses
            // their actual accepted token and unchanged metadata, including after real renewal.
            source.source_grants.fetch_add(1, Ordering::SeqCst);
            return Ok(routing_completed(
                200,
                json!({
                    "attachmentId":source.source.id, "itemId":source.source.item_id,
                    "vaultId":source.source.vault_id, "storageKey":source.source.storage_key,
                    "envelopeVersion":source.source.envelope_version, "uploadedBy":source.source.uploaded_by,
                    "downloadUrl":SOURCE_DOWNLOAD_URL, "encryptedName":source.source.encrypted_name,
                    "encryptedContentType":source.source.encrypted_content_type,
                    "encryptionIv":source.source.encryption_iv,
                    "encryptedContentTypeIv":source.source.encrypted_content_type_iv,
                    "encryptionAlgorithm":source.source.encryption_algorithm, "fileSize":source.source.file_size
                }),
            ));
        }
        let source_refresh = url.ends_with("/sessions/current/refresh")
            && recorded.header("authorization") == Some("Bearer fresh-token");
        let answer = self.inner.invoke(input).await?;
        if source_refresh {
            let response: Value = serde_json::from_str(&answer).unwrap();
            assert_eq!(response["status"], 200);
            let bytes: Vec<u8> = serde_json::from_value(response["body"].clone()).unwrap();
            let body: Value = serde_json::from_slice(&bytes).unwrap();
            assert_eq!(
                body["token"],
                RoutingAuthIdentity::default().refreshed_token
            );
            // Publish only the token returned by the existing real Session refresh fixture.
            source
                .actors
                .http
                .source
                .server
                .accepted_tokens
                .lock()
                .unwrap()
                .push(body["token"].as_str().unwrap().into());
        }
        Ok(answer)
    }

    fn cancel(&self, dispatch_id: &str) {
        self.inner.cancel(dispatch_id);
    }
}

#[derive(Clone, Copy)]
enum SourceFault {
    PartialSecondPass,
    InvalidAuthenticationTag,
}

#[derive(Clone, Debug, Default)]
struct SourceTrace {
    bytes: usize,
    ended: bool,
    interrupted: bool,
}

#[derive(Clone, Debug, Default)]
struct UploadTrace {
    bytes: usize,
    finished: bool,
    reply_lost: bool,
}

#[derive(Default)]
struct StreamEffects {
    sources: Mutex<Vec<SourceTrace>>,
    uploads: Mutex<Vec<UploadTrace>>,
    completed: Mutex<Vec<UploadedObject>>,
}

struct StreamTransfer {
    inner: Arc<AttachmentBinary>,
    source_fault: SourceFault,
    corrupt_envelope: Arc<Vec<u8>>,
    effects: Arc<StreamEffects>,
}

struct StreamSource {
    inner: Box<dyn AttachmentMoveDownload>,
    effects: Arc<StreamEffects>,
    index: usize,
    partial: bool,
}

#[async_trait]
impl AttachmentMoveDownload for StreamSource {
    async fn next_chunk(&mut self) -> Result<Option<Vec<u8>>, AttachmentMoveTransferError> {
        {
            let mut sources = self.effects.sources.lock().unwrap();
            let trace = &mut sources[self.index];
            if self.partial && trace.bytes >= 20 * 16_381 {
                trace.interrupted = true;
                return Err(AttachmentMoveTransferError::Transient);
            }
        }
        let next = self.inner.next_chunk().await?;
        let mut sources = self.effects.sources.lock().unwrap();
        let trace = &mut sources[self.index];
        match &next {
            Some(bytes) => trace.bytes += bytes.len(),
            None => trace.ended = true,
        }
        Ok(next)
    }
}

struct StreamUpload {
    inner: Box<dyn AttachmentMoveUpload>,
    objects: Arc<AttachmentObjects>,
    effects: Arc<StreamEffects>,
    index: usize,
}

#[async_trait]
impl AttachmentMoveUpload for StreamUpload {
    async fn write_chunk(&mut self, bytes: &[u8]) -> Result<(), AttachmentMoveTransferError> {
        if self.index == 0 && self.effects.uploads.lock().unwrap()[self.index].bytes > 0 {
            return Err(AttachmentMoveTransferError::Transient);
        }
        self.inner.write_chunk(bytes).await?;
        self.effects.uploads.lock().unwrap()[self.index].bytes += bytes.len();
        Ok(())
    }

    async fn finish(self: Box<Self>) -> Result<(), AttachmentMoveTransferError> {
        self.inner.finish().await?;
        let uploaded = self.objects.uploaded.lock().unwrap().clone().unwrap();
        self.effects.completed.lock().unwrap().push(uploaded);
        let mut uploads = self.effects.uploads.lock().unwrap();
        uploads[self.index].finished = true;
        if self.index == 1 {
            uploads[self.index].reply_lost = true;
            return Err(AttachmentMoveTransferError::Transient);
        }
        Ok(())
    }
}

#[async_trait]
impl AttachmentMoveTransferPort for StreamTransfer {
    async fn open_source(
        &self,
        request: AttachmentMoveDownloadRequest,
    ) -> Result<Box<dyn AttachmentMoveDownload>, AttachmentMoveTransferError> {
        let chunk_bytes = usize::try_from(request.max_chunk_bytes)
            .unwrap()
            .min(16_381);
        let original = self.inner.open_source(request).await?;
        let index = {
            let mut sources = self.effects.sources.lock().unwrap();
            let index = sources.len();
            sources.push(SourceTrace::default());
            index
        };
        let inner: Box<dyn AttachmentMoveDownload> = match self.source_fault {
            SourceFault::PartialSecondPass => original,
            SourceFault::InvalidAuthenticationTag => Box::new(AttachmentChunks {
                envelope: self.corrupt_envelope.clone(),
                offset: 0,
                chunk_bytes,
            }),
        };
        Ok(Box::new(StreamSource {
            inner,
            effects: self.effects.clone(),
            index,
            partial: matches!(self.source_fault, SourceFault::PartialSecondPass) && index == 1,
        }))
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
        let index = {
            let mut uploads = self.effects.uploads.lock().unwrap();
            let index = uploads.len();
            uploads.push(UploadTrace::default());
            index
        };
        Ok(Box::new(StreamUpload {
            inner,
            objects: self.inner.objects.clone(),
            effects: self.effects.clone(),
            index,
        }))
    }
}

struct StreamFixture {
    base: RefusalFixture,
    http: Arc<StreamHttp>,
    transfer: Arc<StreamTransfer>,
}

impl StreamFixture {
    async fn new(source_fault: SourceFault, source_401: bool) -> Self {
        // Reuse both actual SRP Sign-ins and public Move admission unchanged. Replace the owner,
        // not its immutable facade, to install the controlled byte transport for execution.
        let base = RefusalFixture::new().await;
        let mut corrupt: bittery_crypto_core::EncryptedData =
            serde_json::from_slice(&base.binary.envelope).unwrap();
        let mut ciphertext = BASE64.decode(&corrupt.ciphertext).unwrap();
        *ciphertext.last_mut().unwrap() ^= 1;
        corrupt.ciphertext = BASE64.encode(ciphertext);
        let corrupt_envelope = Arc::new(serde_json::to_vec(&corrupt).unwrap());
        assert_eq!(corrupt_envelope.len(), base.binary.envelope.len());
        let http = Arc::new(StreamHttp {
            inner: base.http.clone(),
            first_source_401: AtomicBool::new(source_401),
            source_requests: Mutex::default(),
        });
        let transfer = Arc::new(StreamTransfer {
            inner: base.binary.clone(),
            source_fault,
            corrupt_envelope,
            effects: Arc::new(StreamEffects::default()),
        });
        let mut fixture = Self {
            base,
            http,
            transfer,
        };
        let accepted = fixture.base.accepted.clone();
        fixture.reopen(&accepted, false).await;
        fixture
    }

    async fn reopen(&mut self, record: &Value, at_deadline: bool) {
        if at_deadline {
            let deadline = record["scheduling"]["notBeforeMs"]
                .as_str()
                .unwrap()
                .parse::<u64>()
                .unwrap();
            self.base.clock.0.store(deadline - 1, Ordering::SeqCst);
        }
        let prior = self.base.runtime.take().unwrap();
        let weak = Arc::downgrade(&prior);
        drop(prior);
        assert!(
            weak.upgrade().is_none(),
            "the actual former Runtime owner must be gone"
        );
        self.base.artifacts =
            Arc::new(SqliteAttachmentArtifactStore::open(&self.base._artifact_database.0).unwrap());
        let runtime = Runtime::with_persistence(
            Arc::new(SerializedReplicaPersistence::new(MoveSqlite::open(
                &self.base.database.0,
            ))),
            Arc::new(PlatformStorage::for_platform(
                self.base.platform.clone(),
                ClientPlatform::Desktop,
            )),
            Arc::new(HttpTransport::new(self.http.clone())),
            Some(
                AuthClientConfig::new(
                    "client-routing".into(),
                    ClientPlatform::Desktop,
                    "0.5.2-test".into(),
                )
                .unwrap(),
            ),
            Some((
                AttachmentMovePreparationFacade::new(
                    self.base.artifacts.clone(),
                    self.base.artifacts.clone(),
                    self.transfer.clone(),
                ),
                Arc::new(crate::runtime::attachment_move_lifecycle::TestAccountLeasePort),
            )),
            false,
            self.base.clock.clone(),
            Arc::new(SystemDeviceTimer),
            None,
        );
        runtime.open().await.unwrap();
        for account in [&self.base.source, &self.base.target] {
            runtime
                .request(
                    quick_unlock_request(account.as_str()),
                    RequestCancellation::new(),
                )
                .await
                .unwrap();
        }
        self.base.runtime = Some(runtime);
        assert_eq!(
            self.base.record().await,
            *record,
            "reopening SQLite and public unlock preserve exact accepted evidence"
        );
        if at_deadline {
            let source_calls = self.http.source_requests.lock().unwrap().len();
            self.base.before_deadline(record).await;
            assert_eq!(
                self.http.source_requests.lock().unwrap().len(),
                source_calls
            );
        }
    }

    fn assert_no_registration_or_destruction(&self, record: &Value) {
        assert_eq!(record["source"], self.base.accepted["source"]);
        assert_eq!(record["target"], self.base.accepted["target"]);
        assert_eq!(
            record["attachments"][0]["targetMetadata"],
            self.base.accepted["attachments"][0]["targetMetadata"]
        );
        assert_eq!(
            record["attachments"][0]["targetAttachmentId"],
            self.base.accepted["attachments"][0]["targetAttachmentId"]
        );
        assert_eq!(
            record["stage"],
            json!({"type":"attachments", "nextIndex":0})
        );
        assert!(self
            .base
            .http
            .inner
            .objects
            .registration_requests
            .lock()
            .unwrap()
            .is_empty());
        assert!(self
            .base
            .http
            .inner
            .actors
            .http
            .mutations(SOURCE_ORIGIN)
            .is_empty());
        assert_eq!(
            self.base
                .http
                .inner
                .actors
                .http
                .source
                .server
                .created_items()
                .len(),
            1
        );
        assert_source_visible(
            self.base.runtime(),
            &self.base.source,
            ItemProjectionStatus::Pending,
        );
        assert_eq!(
            resolution(
                self.base.runtime(),
                &self.base.source,
                &self.base.operation_id
            ),
            OperationResolution::Pending
        );
    }

    fn pending_physical_rows(&self) -> (String, i64, i64) {
        let connection = rusqlite::Connection::open(&self.base._artifact_database.0).unwrap();
        let target = self.base.accepted["attachments"][0]["targetAttachmentId"]
            .as_str()
            .unwrap();
        let params = rusqlite::params![self.base.source.as_str(), self.base.operation_id, target];
        let (generation, state, digest, length): (String, i64, Option<String>, Option<i64>) = connection.query_row(
            "SELECT generation, publication_state, ciphertext_sha256, byte_length FROM attachment_move_provisional_artifacts WHERE account_id=?1 AND operation_id=?2 AND attachment_id=?3",
            params, |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?))).unwrap();
        assert_eq!(
            (state, digest, length),
            (0, None, None),
            "unverified output cannot be sealed"
        );
        let chunks: i64 = connection.query_row(
            "SELECT COUNT(*) FROM attachment_move_provisional_chunks WHERE account_id=?1 AND operation_id=?2 AND attachment_id=?3 AND generation=?4",
            rusqlite::params![self.base.source.as_str(), self.base.operation_id, target, generation], |row|row.get(0)).unwrap();
        let published: i64 = connection.query_row(
            "SELECT COUNT(*) FROM attachment_move_artifacts WHERE account_id=?1 AND operation_id=?2 AND attachment_id=?3",
            params, |row|row.get(0)).unwrap();
        (generation, chunks, published)
    }

    async fn assert_sealed(&self, owner: &AttachmentArtifactOwner, generation: &str, bytes: &[u8]) {
        assert_eq!(
            publication_generation(&self.base.artifacts, owner)
                .await
                .unwrap(),
            generation
        );
        assert_eq!(
            stored_ciphertext(&self.base.artifacts, owner)
                .await
                .unwrap(),
            bytes
        );
    }
    fn assert_destination_plaintext(&self, bytes: &[u8]) {
        let attachments = self
            .base
            .http
            .inner
            .actors
            .http
            .target
            .server
            .attachments
            .lock()
            .unwrap();
        assert_eq!(attachments.len(), 1);
        let attachment: AuthorityAttachmentRecord =
            serde_json::from_value(attachments[0].clone()).unwrap();
        assert_eq!(
            attachment.id,
            self.base.accepted["attachments"][0]["targetAttachmentId"]
        );
        assert_eq!(attachment.item_id, self.base.accepted["target"]["id"]);
        assert_eq!(attachment.uploaded_by, OTHER_USER.user_id);
        let context = |kind: &str| AadContext {
            vault_id: "vault-2".into(),
            entity_id: attachment.id.clone(),
            entity_type: kind.into(),
            user_id: OTHER_USER.user_id.into(),
            version: 1,
        };
        let key = bittery_crypto_core::decrypt_with_aad(
            &bittery_crypto_core::EncryptedData {
                ciphertext: attachment.encrypted_attachment_key.clone(),
                iv: attachment.attachment_key_iv.clone(),
                algorithm: attachment.attachment_key_algorithm.clone(),
            },
            &TARGET_KEY,
            &context("attachment_key"),
        )
        .unwrap();
        let key = BASE64.decode(key.as_bytes()).unwrap();
        let envelope = serde_json::from_slice(bytes).unwrap();
        let plaintext =
            bittery_crypto_core::decrypt_with_aad(&envelope, &key, &context("attachment_blob"))
                .unwrap();
        assert_eq!(
            BASE64.decode(plaintext.as_bytes()).unwrap(),
            vec![0x31; FILE_BYTES]
        );
    }
}

#[tokio::test]
async fn partial_source_and_put_reopen_then_lost_finish_reuses_the_original_sealed_ciphertext() {
    let mut fixture = StreamFixture::new(SourceFault::PartialSecondPass, true).await;
    let partial_source = fixture.base.next_failure(0).await;
    fixture.assert_no_registration_or_destruction(&partial_source);
    assert_eq!(
        partial_source["disposition"],
        json!({"type":"waiting","reason":"offline"})
    );
    assert_eq!(
        partial_source["attachments"],
        fixture.base.accepted["attachments"]
    );
    assert_eq!(partial_source["children"].as_array().unwrap().len(), 1);
    assert!(fixture
        .base
        .http
        .inner
        .objects
        .grant_requests
        .lock()
        .unwrap()
        .is_empty());
    let initial_sources = fixture.transfer.effects.sources.lock().unwrap().clone();
    assert_eq!(initial_sources.len(), 2);
    assert!(initial_sources[0].ended);
    assert_eq!(initial_sources[0].bytes, fixture.base.binary.envelope.len());
    assert!(initial_sources[1].interrupted && !initial_sources[1].ended);
    assert!(initial_sources[1].bytes > crate::ARTIFACT_CHUNK_BYTES);
    assert!(initial_sources[1].bytes < fixture.base.binary.envelope.len());
    let (incomplete_generation, chunks, published) = fixture.pending_physical_rows();
    assert!(
        chunks > 0,
        "the failed pass must have written real provisional chunks"
    );
    assert_eq!(published, 0);
    assert_eq!(
        fixture.base.http.renewals(),
        1,
        "one source401 uses the existing endpoint renewal budget"
    );
    {
        let calls = fixture.http.source_requests.lock().unwrap();
        assert_eq!(calls.len(), 3);
        assert_eq!(calls[0].header("authorization"), Some("Bearer fresh-token"));
        for request in &calls[1..] {
            assert_eq!(
                request.header("authorization"),
                Some("Bearer refreshed-token")
            );
            assert_eq!(request.method, calls[0].method);
            assert_eq!(request.url, calls[0].url);
            assert_eq!(request.body, calls[0].body);
        }
    }
    fixture.reopen(&partial_source, true).await;
    assert_eq!(
        fixture.pending_physical_rows(),
        (incomplete_generation.clone(), chunks, 0)
    );
    let partial_put = fixture.base.next_failure(1).await;
    fixture.assert_no_registration_or_destruction(&partial_put);
    assert_eq!(
        partial_put["disposition"],
        json!({"type":"waiting","reason":"offline"})
    );
    assert_eq!(
        partial_put["attachments"][0]["progress"]["type"],
        "encrypted"
    );
    assert_eq!(partial_put["children"].as_array().unwrap().len(), 2);
    assert!(partial_put["children"][1]["result"].is_null());
    let owner = checkpoint_owner(&partial_put, &fixture.base.source);
    let generation = publication_generation(&fixture.base.artifacts, &owner)
        .await
        .unwrap();
    let bytes = stored_ciphertext(&fixture.base.artifacts, &owner)
        .await
        .unwrap();
    assert_ne!(
        generation, incomplete_generation,
        "an unsealed partial stream cannot resume as a publication"
    );
    assert!(fixture
        .base
        .http
        .inner
        .objects
        .uploaded
        .lock()
        .unwrap()
        .is_none());
    {
        let uploads = fixture.transfer.effects.uploads.lock().unwrap();
        assert_eq!(uploads.len(), 1);
        assert_eq!(uploads[0].bytes, crate::ARTIFACT_CHUNK_BYTES);
        assert!(uploads[0].bytes < bytes.len());
        assert!(!uploads[0].finished);
    }
    assert_eq!(fixture.base.binary.downloads.load(Ordering::SeqCst), 4);
    fixture.reopen(&partial_put, true).await;
    fixture.assert_sealed(&owner, &generation, &bytes).await;
    let lost_finish = fixture.base.next_failure(2).await;
    fixture.assert_no_registration_or_destruction(&lost_finish);
    assert_eq!(
        lost_finish["disposition"],
        json!({"type":"waiting","reason":"offline"})
    );
    assert_eq!(lost_finish["attachments"], partial_put["attachments"]);
    assert_eq!(lost_finish["children"], partial_put["children"]);
    fixture.assert_sealed(&owner, &generation, &bytes).await;
    {
        let uploads = fixture.transfer.effects.uploads.lock().unwrap();
        assert_eq!(uploads.len(), 2);
        assert_eq!(uploads[1].bytes, bytes.len());
        assert!(uploads[1].finished && uploads[1].reply_lost);
        let completed = fixture.transfer.effects.completed.lock().unwrap();
        assert_eq!(completed.len(), 1);
        assert_eq!(completed[0].owner, owner);
        assert_eq!(completed[0].ciphertext, bytes);
    }
    fixture.base.before_deadline(&lost_finish).await;
    for _ in 0..12 {
        if fixture.base.record().await["stage"]["type"] == "completed" {
            break;
        }
        fixture.base.step().await;
    }
    let completed = fixture.base.record().await;
    assert_eq!(completed["stage"]["type"], "completed");
    assert_eq!(completed["attachments"], partial_put["attachments"]);
    assert_eq!(
        completed["children"][1]["request"],
        partial_put["children"][1]["request"]
    );
    assert_eq!(completed["children"][1]["result"]["type"], "acknowledged");
    assert_eq!(
        completed["children"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|child| child["type"] == "itemOperation"
                && child["result"]["result"]["type"] == "applied")
            .count(),
        3
    );
    assert_eq!(
        fixture.base.binary.downloads.load(Ordering::SeqCst),
        4,
        "sealed retries never open the source again"
    );
    assert_eq!(fixture.base.binary.uploads.load(Ordering::SeqCst), 3);
    assert_eq!(fixture.base.http.renewals(), 1);
    assert_eq!(
        fixture.base.http.inner.actors.http.target.server.creates(),
        1
    );
    assert!(fixture
        .base
        .http
        .inner
        .actors
        .http
        .source
        .server
        .created_items()
        .is_empty());
    {
        let grants = fixture
            .base
            .http
            .inner
            .objects
            .grant_requests
            .lock()
            .unwrap();
        assert_eq!(grants.len(), 4);
        for grant in &grants[1..] {
            assert_exact_retry(grant, &grants[0]);
        }
        let registrations = fixture
            .base
            .http
            .inner
            .objects
            .registration_requests
            .lock()
            .unwrap();
        assert_eq!(registrations.len(), 1);
        let completed_puts = fixture.transfer.effects.completed.lock().unwrap();
        assert_eq!(completed_puts.len(), 2);
        for put in completed_puts.iter() {
            assert_eq!(put.owner, owner);
            assert_eq!(put.ciphertext, bytes);
            assert_eq!(put.headers, completed_puts[0].headers);
        }
    }
    fixture.assert_destination_plaintext(&bytes);
    fixture.base.runtime().close().await;
}

#[tokio::test]
async fn fully_read_source_with_invalid_authentication_tag_never_publishes_or_requests_a_grant() {
    let fixture = StreamFixture::new(SourceFault::InvalidAuthenticationTag, false).await;
    let mut blocked = fixture.base.record().await;
    for _ in 0..12 {
        fixture.base.step().await;
        blocked = fixture.base.record().await;
        if blocked["disposition"]["type"] == "blocked" {
            break;
        }
    }
    fixture.assert_no_registration_or_destruction(&blocked);
    assert_eq!(
        blocked["disposition"],
        json!({"type":"blocked","reason":"missingArtifact"})
    );
    assert_eq!(blocked["attachments"], fixture.base.accepted["attachments"]);
    assert_eq!(blocked["children"].as_array().unwrap().len(), 1);
    let sources = fixture.transfer.effects.sources.lock().unwrap().clone();
    assert_eq!(sources.len(), 2);
    assert!(
        sources.iter().all(|source| source.ended
            && !source.interrupted
            && source.bytes == fixture.transfer.corrupt_envelope.len()),
        "both passes consume the same complete envelope before authenticated finish refuses it"
    );
    let (_, chunks, published) = fixture.pending_physical_rows();
    assert!(
        chunks > 0,
        "untrusted output was streamed to real provisional storage"
    );
    assert_eq!(published, 0);
    assert!(fixture
        .base
        .http
        .inner
        .objects
        .grant_requests
        .lock()
        .unwrap()
        .is_empty());
    assert_eq!(fixture.base.binary.uploads.load(Ordering::SeqCst), 0);
    assert_eq!(fixture.base.http.renewals(), 0);
    fixture.base.runtime().close().await;
}
