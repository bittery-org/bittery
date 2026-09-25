//! Public Attachment admission uses real key envelopes and the actual SQLite artifact backend.
use super::*;
use crate::{
    attachment_artifact_store::{
        AttachmentArtifactOwner, AttachmentArtifactStore, AttachmentArtifactStoreRequest,
        AttachmentArtifactStoreResponse, SqliteAttachmentArtifactStore,
    },
    replica::AuthorityAttachmentRecord,
    AttachmentMoveDownload, AttachmentMoveDownloadRequest, AttachmentMovePreparationFacade,
    AttachmentMoveTransferError, AttachmentMoveTransferPort, AttachmentMoveUpload,
    AttachmentMoveUploadGrant,
};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use sha2::{Digest, Sha256};
use std::sync::atomic::AtomicUsize;

const SOURCE_ATTACHMENT: &str = "b10a7faa-bd70-4d30-8428-218b615071ea";
const TARGET_UPLOAD_URL: &str = "https://objects.example.test/cross-account-target";
const SOURCE_DOWNLOAD_URL: &str = "https://objects.example.test/cross-account-source";
const FILE_BYTES: usize = crate::ARTIFACT_CHUNK_BYTES * 2 + 29;

fn source_attachment() -> (AuthorityAttachmentRecord, Arc<Vec<u8>>) {
    assert_eq!(FILE_BYTES, 524_317);
    let attachment_key = [13_u8; 32];
    let context = |entity_type: &str| AadContext {
        vault_id: "vault-1".into(),
        entity_id: SOURCE_ATTACHMENT.into(),
        entity_type: entity_type.into(),
        user_id: "user-1".into(),
        version: 1,
    };
    let wrapped_key = encrypt_with_aad(
        &BASE64.encode(attachment_key),
        &[41; 32],
        &context("attachment_key"),
    )
    .unwrap();
    let name = encrypt_with_aad(
        "cross-account-original.bin",
        &attachment_key,
        &context("attachment_name"),
    )
    .unwrap();
    let content_type = encrypt_with_aad(
        "application/octet-stream",
        &attachment_key,
        &context("attachment_content_type"),
    )
    .unwrap();
    let envelope = encrypt_with_aad(
        &BASE64.encode(vec![0x31; FILE_BYTES]),
        &attachment_key,
        &context("attachment_blob"),
    )
    .unwrap();
    let encoded = Arc::new(serde_json::to_vec(&envelope).unwrap());
    assert!(encoded.len() > crate::ARTIFACT_CHUNK_BYTES * 2);
    let original = bittery_crypto_core::decrypt_with_aad(
        &envelope,
        &attachment_key,
        &context("attachment_blob"),
    )
    .unwrap();
    assert_eq!(
        BASE64.decode(original.as_bytes()).unwrap(),
        vec![0x31; FILE_BYTES]
    );
    (
        AuthorityAttachmentRecord {
            id: SOURCE_ATTACHMENT.into(),
            item_id: SOURCE_ITEM.into(),
            vault_id: "vault-1".into(),
            storage_key: format!("attachments/user-1/{SOURCE_ATTACHMENT}.enc"),
            encrypted_name: name.ciphertext,
            encryption_iv: name.iv,
            encryption_algorithm: name.algorithm,
            encrypted_attachment_key: wrapped_key.ciphertext,
            attachment_key_iv: wrapped_key.iv,
            attachment_key_algorithm: wrapped_key.algorithm,
            encrypted_content_type: content_type.ciphertext,
            encrypted_content_type_iv: content_type.iv,
            envelope_version: 1,
            file_size: i32::try_from(FILE_BYTES).unwrap(),
            uploaded_by: "user-1".into(),
            created_at: "2026-09-14T00:00:00Z".into(),
        },
        encoded,
    )
}

#[derive(Clone)]
struct UploadedObject {
    owner: AttachmentArtifactOwner,
    ciphertext: Vec<u8>,
    headers: Vec<(String, String)>,
}

#[derive(Default)]
struct AttachmentObjects {
    grant_requests: Mutex<Vec<RecordedRequest>>,
    registration_requests: Mutex<Vec<RecordedRequest>>,
    uploaded: Mutex<Option<UploadedObject>>,
}

fn attachment_request(request: &Value) -> RecordedRequest {
    RecordedRequest {
        method: request["method"].as_str().unwrap().into(),
        url: request["url"].as_str().unwrap().into(),
        headers: request["headers"]
            .as_array()
            .unwrap()
            .iter()
            .map(|header| {
                (
                    header["name"].as_str().unwrap().into(),
                    header["value"].as_str().unwrap().into(),
                )
            })
            .collect(),
        body: serde_json::from_value(request["body"].clone()).unwrap(),
    }
}

fn digest_base64(hex: &str) -> String {
    BASE64.encode(
        hex.as_bytes()
            .chunks_exact(2)
            .map(|pair| u8::from_str_radix(std::str::from_utf8(pair).unwrap(), 16).unwrap())
            .collect::<Vec<_>>(),
    )
}

fn attachment_ports(database: &Path) -> (Arc<AttachmentHttp>, Arc<AttachmentBinary>) {
    let (source, envelope) = source_attachment();
    let actors = SameServerHttp::new();
    actors
        .http
        .source
        .server
        .set_attachment_authority(vec![serde_json::to_value(&source).unwrap()]);
    let objects = Arc::new(AttachmentObjects::default());
    let http = Arc::new(AttachmentHttp {
        actors,
        source,
        source_grants: AtomicUsize::new(0),
        lose_first_grant: AtomicBool::new(false),
        ciphertext_bytes: envelope.len(),
        objects: objects.clone(),
    });
    let binary = Arc::new(AttachmentBinary {
        envelope,
        downloads: AtomicUsize::new(0),
        uploads: AtomicUsize::new(0),
        database: database.to_path_buf(),
        objects,
    });
    (http, binary)
}

struct AttachmentHttp {
    actors: Arc<SameServerHttp>,
    source: AuthorityAttachmentRecord,
    source_grants: AtomicUsize,
    lose_first_grant: AtomicBool,
    ciphertext_bytes: usize,
    objects: Arc<AttachmentObjects>,
}

#[async_trait]
impl crate::http_transport::SerializedHttpExecutor for AttachmentHttp {
    async fn invoke(&self, input: Zeroizing<String>) -> Result<String, RuntimeError> {
        let request: Value = serde_json::from_str(&input).unwrap();
        if request["url"]
            == format!("{SOURCE_ORIGIN}/api/v1/attachments/{SOURCE_ATTACHMENT}/download-urls")
        {
            if self.actors.http.offline.load(Ordering::SeqCst) {
                return Ok(json!({"type":"networkFailure"}).to_string());
            }
            assert_eq!(request["method"], "POST");
            assert!(request["headers"].as_array().unwrap().iter().any(|header| {
                header["name"]
                    .as_str()
                    .unwrap()
                    .eq_ignore_ascii_case("authorization")
                    && header["value"] == "Bearer fresh-token"
            }));
            self.source_grants.fetch_add(1, Ordering::SeqCst);
            return Ok(routing_completed(
                200,
                json!({
                    "attachmentId": self.source.id,
                    "itemId": self.source.item_id,
                    "vaultId": self.source.vault_id,
                    "storageKey": self.source.storage_key,
                    "envelopeVersion": self.source.envelope_version,
                    "uploadedBy": self.source.uploaded_by,
                    "downloadUrl": SOURCE_DOWNLOAD_URL,
                    "encryptedName": self.source.encrypted_name,
                    "encryptedContentType": self.source.encrypted_content_type,
                    "encryptionIv": self.source.encryption_iv,
                    "encryptedContentTypeIv": self.source.encrypted_content_type_iv,
                    "encryptionAlgorithm": self.source.encryption_algorithm,
                    "fileSize": self.source.file_size,
                }),
            ));
        }
        let recorded = attachment_request(&request);
        if recorded.method == "POST"
            && (recorded.url.ends_with("/attachment-uploads")
                || recorded.url.ends_with("/attachments"))
        {
            if self.actors.http.offline.load(Ordering::SeqCst) {
                return Ok(json!({"type":"networkFailure"}).to_string());
            }
            assert_eq!(
                recorded.header("authorization"),
                Some(format!("Bearer {}", OTHER_USER.token).as_str())
            );
            let body = routing_request_body(&request);
            let target = self
                .actors
                .http
                .target
                .server
                .created_items
                .lock()
                .unwrap()
                .first()
                .cloned()
                .expect("actual target Item must exist before file grants");
            let prefix = format!("{SOURCE_ORIGIN}/api/v1/items/{}/", target.id);
            assert!(recorded.url.starts_with(&prefix));
            if recorded.url.ends_with("/attachment-uploads") {
                assert_eq!(body["fileSize"], FILE_BYTES);
                assert_eq!(body["contentType"], "application/octet-stream");
                let id = body["durableUpload"]["attachmentId"].as_str().unwrap();
                let digest = body["durableUpload"]["ciphertextSha256"].as_str().unwrap();
                assert_ne!(id, SOURCE_ATTACHMENT);
                assert_eq!(body["fileName"], format!("{id}.enc"));
                assert_eq!(digest.len(), 64);
                let mut grants = self.objects.grant_requests.lock().unwrap();
                if let Some(first) = grants.first() {
                    assert_exact_retry(&recorded, first);
                }
                grants.push(recorded);
                // The simulated Server has retained the immutable claim above. Only its reply
                // is lost; the next owner must renew these same bytes and this same identity.
                if self.lose_first_grant.swap(false, Ordering::SeqCst) {
                    self.actors.http.offline.store(true, Ordering::SeqCst);
                    return Ok(json!({"type":"networkFailure"}).to_string());
                }
                return Ok(routing_completed(
                    200,
                    json!({
                        "attachmentId":id, "key":format!("attachments/{}/{id}.enc", OTHER_USER.user_id), "uploadUrl":TARGET_UPLOAD_URL,
                        "uploadHeaders":[
                            {"name":"content-type", "value":"application/octet-stream"},
                            {"name":"content-length", "value":self.ciphertext_bytes.to_string()},
                            {"name":"x-amz-content-sha256", "value":digest},
                            {"name":"x-amz-checksum-sha256", "value":digest_base64(digest)}
                        ]
                    }),
                ));
            }
            let body: crate::server_contract::CreateAttachmentBody =
                serde_json::from_value(body).unwrap();
            let uploaded = self
                .objects
                .uploaded
                .lock()
                .unwrap()
                .clone()
                .expect("registration requires a completed ciphertext PUT");
            assert_eq!(body.attachment_id, uploaded.owner.attachment_id());
            assert_eq!(
                body.storage_key,
                format!(
                    "attachments/{}/{}.enc",
                    OTHER_USER.user_id, body.attachment_id
                )
            );
            assert_eq!(uploaded.ciphertext.len(), self.ciphertext_bytes);
            assert_eq!(
                format!("{:x}", Sha256::digest(&uploaded.ciphertext)),
                uploaded.owner.ciphertext_sha256()
            );
            let attachment = AuthorityAttachmentRecord {
                id: body.attachment_id.clone(),
                item_id: target.id,
                vault_id: target.vault_id,
                storage_key: body.storage_key,
                encrypted_name: body.encrypted_name,
                encryption_iv: body.encryption_iv,
                encryption_algorithm: body.encryption_algorithm,
                encrypted_attachment_key: body.encrypted_attachment_key,
                attachment_key_iv: body.attachment_key_iv,
                attachment_key_algorithm: body.attachment_key_algorithm,
                encrypted_content_type: body.encrypted_content_type,
                encrypted_content_type_iv: body.encrypted_content_type_iv,
                envelope_version: body.envelope_version,
                file_size: body.file_size,
                uploaded_by: OTHER_USER.user_id.into(),
                created_at: "2026-09-14T01:00:00Z".into(),
            };
            self.actors
                .http
                .target
                .server
                .set_attachment_authority(vec![serde_json::to_value(&attachment).unwrap()]);
            self.objects
                .registration_requests
                .lock()
                .unwrap()
                .push(recorded);
            return Ok(routing_completed(
                200,
                json!({"attachmentId":attachment.id}),
            ));
        }
        self.actors.invoke(input).await
    }

    fn cancel(&self, dispatch_id: &str) {
        self.actors.cancel(dispatch_id);
    }
}

struct AttachmentBinary {
    envelope: Arc<Vec<u8>>,
    downloads: AtomicUsize,
    uploads: AtomicUsize,
    database: std::path::PathBuf,
    objects: Arc<AttachmentObjects>,
}

struct AttachmentChunks {
    envelope: Arc<Vec<u8>>,
    offset: usize,
    chunk_bytes: usize,
}

#[async_trait]
impl AttachmentMoveDownload for AttachmentChunks {
    async fn next_chunk(&mut self) -> Result<Option<Vec<u8>>, AttachmentMoveTransferError> {
        if self.offset == self.envelope.len() {
            return Ok(None);
        }
        let end = (self.offset + self.chunk_bytes).min(self.envelope.len());
        let chunk = self.envelope[self.offset..end].to_vec();
        self.offset = end;
        Ok(Some(chunk))
    }
}

#[async_trait]
impl AttachmentMoveTransferPort for AttachmentBinary {
    async fn open_source(
        &self,
        request: AttachmentMoveDownloadRequest,
    ) -> Result<Box<dyn AttachmentMoveDownload>, AttachmentMoveTransferError> {
        assert_eq!(request.download_url, SOURCE_DOWNLOAD_URL);
        assert!(request.headers.is_empty());
        assert!(request.max_response_bytes >= u64::try_from(self.envelope.len()).unwrap());
        assert!(request.max_chunk_bytes > 0);
        self.downloads.fetch_add(1, Ordering::SeqCst);
        Ok(Box::new(AttachmentChunks {
            envelope: self.envelope.clone(),
            offset: 0,
            chunk_bytes: usize::try_from(request.max_chunk_bytes)
                .unwrap()
                .min(16_381),
        }))
    }

    async fn open_upload(
        &self,
        account_id: &AccountId,
        operation_id: &str,
        grant: &AttachmentMoveUploadGrant,
        owner: &AttachmentArtifactOwner,
    ) -> Result<Box<dyn AttachmentMoveUpload>, AttachmentMoveTransferError> {
        assert_eq!(grant.upload_url, TARGET_UPLOAD_URL);
        assert_eq!(grant.attachment_id, owner.attachment_id());
        assert_eq!(owner.account_id(), account_id);
        assert_eq!(owner.operation_id(), operation_id);
        let record = workflow(
            &durable_rows(&self.database, account_id).await,
            operation_id,
        );
        assert_eq!(record["attachments"][0]["progress"]["type"], "encrypted");
        let registration = &record["children"][1];
        assert_eq!(registration["type"], "attachmentRegistration");
        assert!(registration["result"].is_null());
        let body: Vec<u8> =
            serde_json::from_value(registration["request"]["body"].clone()).unwrap();
        let body: Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(body["attachmentId"], grant.attachment_id);
        assert_eq!(body["storageKey"], grant.storage_key);
        let headers = grant.validated_headers(owner)?;
        assert_eq!(headers.len(), 4);
        self.uploads.fetch_add(1, Ordering::SeqCst);
        Ok(Box::new(AttachmentUploadChunks {
            owner: owner.clone(),
            ciphertext: Vec::new(),
            headers,
            objects: self.objects.clone(),
        }))
    }
}

struct AttachmentUploadChunks {
    owner: AttachmentArtifactOwner,
    ciphertext: Vec<u8>,
    headers: Vec<(String, String)>,
    objects: Arc<AttachmentObjects>,
}

#[async_trait]
impl AttachmentMoveUpload for AttachmentUploadChunks {
    async fn write_chunk(&mut self, bytes: &[u8]) -> Result<(), AttachmentMoveTransferError> {
        assert!(bytes.len() <= crate::ARTIFACT_CHUNK_BYTES);
        self.ciphertext.extend_from_slice(bytes);
        assert!(self.ciphertext.len() as u64 <= self.owner.byte_length());
        Ok(())
    }
    async fn finish(self: Box<Self>) -> Result<(), AttachmentMoveTransferError> {
        assert_eq!(self.ciphertext.len() as u64, self.owner.byte_length());
        assert_eq!(
            format!("{:x}", Sha256::digest(&self.ciphertext)),
            self.owner.ciphertext_sha256()
        );
        *self.objects.uploaded.lock().unwrap() = Some(UploadedObject {
            owner: self.owner,
            ciphertext: self.ciphertext,
            headers: self.headers,
        });
        Ok(())
    }
}

#[tokio::test]
async fn nonempty_cross_account_move_admits_its_source_manifest_with_real_artifact_ports() {
    let database = MoveDatabase::new();
    let artifact_database = MoveDatabase::new();
    let artifacts = Arc::new(SqliteAttachmentArtifactStore::open(&artifact_database.0).unwrap());
    let (http, binary) = attachment_ports(&database.0);
    let source_attachment = http.source.clone();
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
        assert_eq!(
            runtime.require_snapshot(&account_id).unwrap().user_id,
            identity.user_id
        );
        accounts.push(account_id);
    }
    let [source, target]: [AccountId; 2] = accounts.try_into().unwrap();
    assert_ne!(source, target);
    let RuntimeProjection::Items(items) = runtime
        .projection(&ObservationRequest::Items {
            account_id: source.clone(),
        })
        .unwrap()
        .projection
    else {
        panic!("expected public source Attachment metadata")
    };
    assert_eq!(items.items.len(), 1);
    assert_eq!(items.items[0].attachments.len(), 1);
    let attachment = &items.items[0].attachments[0];
    assert_eq!(attachment.attachment_id, SOURCE_ATTACHMENT);
    assert_eq!(attachment.name, "cross-account-original.bin");
    assert_eq!(attachment.content_type, "application/octet-stream");
    assert_eq!(attachment.file_size, i32::try_from(FILE_BYTES).unwrap());
    let target_before = durable_rows(&database.0, &target).await;
    http.actors.http.offline.store(true, Ordering::SeqCst);
    let response = runtime
        .request(
            RuntimeRequest::MoveItem {
                account_id: source.clone(),
                item_id: SOURCE_ITEM.into(),
                target_account_id: Some(target.clone()),
                target_vault_id: "vault-2".into(),
            },
            RequestCancellation::new(),
        )
        .await;
    let response = match response {
        Ok(response) => response,
        Err(error) => {
            runtime.close().await;
            panic!("public nonempty Move admission refused a valid source manifest: {error:?}");
        }
    };
    let RuntimeResponse::Accepted { operation_id, .. } = response else {
        panic!("expected one accepted source workflow")
    };
    let accepted = workflow(&durable_rows(&database.0, &source).await, &operation_id);
    assert_eq!(
        accepted["source"]["attachments"],
        json!([source_attachment])
    );
    assert_eq!(accepted["attachments"].as_array().unwrap().len(), 1);
    assert_source_visible(&runtime, &source, crate::ItemProjectionStatus::Pending);
    assert_eq!(
        resolution(&runtime, &source, &operation_id),
        OperationResolution::Pending
    );
    assert_eq!(durable_rows(&database.0, &target).await, target_before);
    assert_eq!(http.source_grants.load(Ordering::SeqCst), 0);
    assert_eq!(binary.downloads.load(Ordering::SeqCst), 0);
    assert_eq!(binary.uploads.load(Ordering::SeqCst), 0);
    http.actors.http.resumed.store(true, Ordering::SeqCst);
    http.actors.http.offline.store(false, Ordering::SeqCst);
    let runner = tokio::spawn(runtime.clone().run_operation_dispatch());
    let reached = tokio::time::timeout(
        Duration::from_secs(15),
        http.actors.http.trash_result.reached.acquire(),
    )
    .await;
    if reached.is_err() {
        http.actors.http.trash_result.release.add_permits(1);
        http.actors.http.delete_result.release.add_permits(1);
        let stopped = workflow(&durable_rows(&database.0, &source).await, &operation_id);
        close_move_runtime(runtime, runner).await;
        panic!("source Trash was not reached after exact file publication: {stopped:?}");
    }
    reached.unwrap().unwrap().forget();
    let source_pending_at_trash = runtime
        .projection(&ObservationRequest::Items {
            account_id: source.clone(),
        })
        .unwrap();
    let before_trash_ack = workflow(&durable_rows(&database.0, &source).await, &operation_id);
    let uploaded = http.objects.uploaded.lock().unwrap().clone();
    let target_attachments = http
        .actors
        .http
        .target
        .server
        .attachments
        .lock()
        .unwrap()
        .clone();
    let physical_ciphertext = if let Some(uploaded) = &uploaded {
        let reopened = SqliteAttachmentArtifactStore::open(&artifact_database.0).unwrap();
        let mut bytes = Vec::new();
        let mut index = 0;
        loop {
            let AttachmentArtifactStoreResponse::ChunkRead(chunk) = reopened
                .invoke(AttachmentArtifactStoreRequest::ReadChunk {
                    owner: uploaded.owner.clone(),
                    chunk_index: index,
                })
                .await
                .unwrap()
            else {
                panic!("actual SQLite artifact must retain its published chunks")
            };
            bytes.extend_from_slice(&chunk.bytes);
            if chunk.is_last {
                break;
            }
            index += 1;
        }
        bytes
    } else {
        Vec::new()
    };
    http.actors.http.trash_result.release.add_permits(1);
    let reached = tokio::time::timeout(
        Duration::from_secs(10),
        http.actors.http.delete_result.reached.acquire(),
    )
    .await;
    if reached.is_err() {
        http.actors.http.delete_result.release.add_permits(1);
        close_move_runtime(runtime, runner).await;
        panic!("permanent deletion did not follow proven source Trash");
    }
    reached.unwrap().unwrap().forget();
    let before_delete_ack = workflow(&durable_rows(&database.0, &source).await, &operation_id);
    let pending_before_delete_ack = resolution(&runtime, &source, &operation_id);
    http.actors.http.delete_result.release.add_permits(1);
    let completed = tokio::time::timeout(Duration::from_secs(10), async {
        while resolution(&runtime, &source, &operation_id) != OperationResolution::Applied {
            tokio::task::yield_now().await;
        }
    })
    .await;
    let final_record = workflow(&durable_rows(&database.0, &source).await, &operation_id);
    close_move_runtime(runtime, runner).await;
    completed.expect("Move requires proved source destruction after file publication");

    assert_eq!(pending_before_delete_ack, OperationResolution::Pending);
    let RuntimeProjection::Items(items) = source_pending_at_trash.projection else {
        panic!("expected source Items projection")
    };
    assert_eq!(items.items.len(), 1);
    assert_eq!(items.items[0].item_id, SOURCE_ITEM);
    assert_eq!(items.items[0].status, crate::ItemProjectionStatus::Pending);
    assert_eq!(
        items.items[0].attachments[0].name,
        "cross-account-original.bin"
    );
    assert_eq!(
        before_trash_ack["children"][1]["type"],
        "attachmentRegistration"
    );
    assert_eq!(
        before_trash_ack["children"][1]["result"]["type"],
        "acknowledged"
    );
    assert!(before_trash_ack["children"][2]["result"].is_null());
    assert_eq!(
        before_delete_ack["children"][2]["result"]["result"]["type"],
        "applied"
    );
    assert!(before_delete_ack["children"][3]["result"].is_null());
    assert_eq!(final_record["stage"], json!({"type":"completed"}));
    assert_eq!(final_record["target"], accepted["target"]);
    assert_eq!(final_record["source"], accepted["source"]);
    assert_eq!(
        final_record["attachments"][0]["targetMetadata"],
        accepted["attachments"][0]["targetMetadata"]
    );
    assert_eq!(final_record["children"].as_array().unwrap().len(), 4);
    assert!(http.actors.http.source.server.created_items().is_empty());
    assert_eq!(http.actors.http.target.server.created_items().len(), 1);
    assert_eq!(durable_rows(&database.0, &target).await, target_before);
    assert_eq!(
        binary.downloads.load(Ordering::SeqCst),
        2,
        "the existing authenticated two-pass pipeline opens two source streams"
    );
    assert_eq!(binary.uploads.load(Ordering::SeqCst), 1);
    assert_eq!(http.source_grants.load(Ordering::SeqCst), 2);
    let grants = http.objects.grant_requests.lock().unwrap().clone();
    assert_eq!(
        grants.len(),
        2,
        "storage key is fixed in SQLite before the next same-ID grant opens PUT"
    );
    assert_exact_retry(&grants[1], &grants[0]);
    let registration = http.objects.registration_requests.lock().unwrap().clone();
    assert_eq!(registration.len(), 1);
    assert!(
        registration[0].header("idempotency-key").is_none(),
        "registration has no synthetic Item operation identity"
    );
    let recorded_body: Vec<u8> =
        serde_json::from_value(final_record["children"][1]["request"]["body"].clone()).unwrap();
    assert_eq!(recorded_body, registration[0].body);
    for (index, version) in [(0, 1), (2, 2), (3, 3)] {
        let child = &final_record["children"][index];
        assert_eq!(child["type"], "itemOperation");
        assert_eq!(child["result"]["result"]["type"], "applied");
        assert_eq!(child["result"]["result"]["version"], version);
        let operation = child["operationId"].as_str().unwrap();
        let server = if index == 0 {
            &http.actors.http.target.server
        } else {
            &http.actors.http.source.server
        };
        let stored = server.outcomes.lock().unwrap()[operation].clone();
        let fingerprint: String = stored
            .fingerprint
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect();
        assert_eq!(child["result"]["requestFingerprint"], fingerprint);
    }
    let uploaded = uploaded.expect("actual binary upload must finish before source Trash");
    assert_eq!(
        uploaded.ciphertext, physical_ciphertext,
        "new SQLite backend reads the identical source-owned sealed bytes"
    );
    assert_eq!(uploaded.headers.len(), 4);
    assert_eq!(target_attachments.len(), 1);
    let attachment: AuthorityAttachmentRecord =
        serde_json::from_value(target_attachments[0].clone()).unwrap();
    assert_ne!(attachment.id, SOURCE_ATTACHMENT);
    assert_eq!(
        attachment.id,
        accepted["attachments"][0]["targetAttachmentId"]
    );
    assert_eq!(attachment.item_id, accepted["target"]["id"]);
    assert_eq!(attachment.vault_id, "vault-2");
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
            ciphertext: attachment.encrypted_attachment_key,
            iv: attachment.attachment_key_iv,
            algorithm: attachment.attachment_key_algorithm,
        },
        &TARGET_KEY,
        &context("attachment_key"),
    )
    .unwrap();
    let key = BASE64.decode(key.as_bytes()).unwrap();
    assert_ne!(key, vec![13; 32]);
    for (kind, ciphertext, iv, expected) in [
        (
            "attachment_name",
            attachment.encrypted_name,
            attachment.encryption_iv,
            "cross-account-original.bin",
        ),
        (
            "attachment_content_type",
            attachment.encrypted_content_type,
            attachment.encrypted_content_type_iv,
            "application/octet-stream",
        ),
    ] {
        assert_eq!(
            bittery_crypto_core::decrypt_with_aad(
                &bittery_crypto_core::EncryptedData {
                    ciphertext,
                    iv,
                    algorithm: attachment.encryption_algorithm.clone()
                },
                &key,
                &context(kind)
            )
            .unwrap()
            .as_str(),
            expected
        );
    }
    let envelope: bittery_crypto_core::EncryptedData =
        serde_json::from_slice(&uploaded.ciphertext).unwrap();
    let plaintext =
        bittery_crypto_core::decrypt_with_aad(&envelope, &key, &context("attachment_blob"))
            .unwrap();
    assert_eq!(
        BASE64.decode(plaintext.as_bytes()).unwrap(),
        vec![0x31; FILE_BYTES]
    );
    let mut wrong_actor = context("attachment_blob");
    wrong_actor.user_id = "user-1".into();
    assert!(bittery_crypto_core::decrypt_with_aad(&envelope, &key, &wrong_actor).is_err());
}

#[path = "cross_account_move_attachment_lease_tests.rs"]
mod lease_tests;

#[path = "cross_account_move_attachment_restart_tests.rs"]
mod restart_tests;

#[path = "cross_account_move_attachment_size_tests.rs"]
mod size_tests;
