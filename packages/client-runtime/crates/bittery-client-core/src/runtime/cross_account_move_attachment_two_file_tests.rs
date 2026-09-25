//! Two Servers, a real RSA Member key, and mixed live/Pending physical publications.
use super::*;
use std::collections::BTreeMap;

const SECOND_ATTACHMENT: &str = "daf2077a-310c-4c4d-9e92-964c8cc6a722";
const SECOND_BYTES: usize = crate::ARTIFACT_CHUNK_BYTES + 53;

struct FileFixture {
    authority: AuthorityAttachmentRecord,
    envelope: Arc<Vec<u8>>,
    objects: Arc<AttachmentObjects>,
    downloads: AtomicUsize,
}

fn second_attachment() -> (AuthorityAttachmentRecord, Arc<Vec<u8>>) {
    let key = [29; 32];
    let context = |kind: &str| AadContext {
        vault_id: "vault-1".into(),
        entity_id: SECOND_ATTACHMENT.into(),
        entity_type: kind.into(),
        user_id: "user-1".into(),
        version: 1,
    };
    let wrapped =
        encrypt_with_aad(&BASE64.encode(key), &[41; 32], &context("attachment_key")).unwrap();
    let name =
        encrypt_with_aad("second-member-file.bin", &key, &context("attachment_name")).unwrap();
    let content_type = encrypt_with_aad(
        "application/octet-stream",
        &key,
        &context("attachment_content_type"),
    )
    .unwrap();
    let blob = encrypt_with_aad(
        &BASE64.encode(vec![0x73; SECOND_BYTES]),
        &key,
        &context("attachment_blob"),
    )
    .unwrap();
    (
        AuthorityAttachmentRecord {
            id: SECOND_ATTACHMENT.into(),
            item_id: SOURCE_ITEM.into(),
            vault_id: "vault-1".into(),
            storage_key: format!("attachments/user-1/{SECOND_ATTACHMENT}.enc"),
            encrypted_name: name.ciphertext,
            encryption_iv: name.iv,
            encryption_algorithm: name.algorithm,
            encrypted_attachment_key: wrapped.ciphertext,
            attachment_key_iv: wrapped.iv,
            attachment_key_algorithm: wrapped.algorithm,
            encrypted_content_type: content_type.ciphertext,
            encrypted_content_type_iv: content_type.iv,
            envelope_version: 1,
            file_size: i32::try_from(SECOND_BYTES).unwrap(),
            uploaded_by: "user-1".into(),
            created_at: "2026-09-14T00:00:00Z".into(),
        },
        Arc::new(serde_json::to_vec(&blob).unwrap()),
    )
}

struct TwoFiles {
    endpoints: Arc<MoveHttp>,
    files: Vec<FileFixture>,
    target_ids: Mutex<BTreeMap<String, usize>>,
    database: std::path::PathBuf,
}

impl TwoFiles {
    fn new(database: &Path) -> Arc<Self> {
        let mut endpoints = MoveHttp::new();
        let inner = Arc::get_mut(&mut endpoints).unwrap();
        inner.source.include_login_vault_keys = true;
        configure_other_user(&mut inner.target);
        inner.target.vault["id"] = json!("vault-2");
        inner.target.use_shared_member(&TARGET_KEY);
        let files: Vec<_> = [source_attachment(), second_attachment()]
            .into_iter()
            .map(|(authority, envelope)| FileFixture {
                authority,
                envelope,
                objects: Arc::new(AttachmentObjects::default()),
                downloads: AtomicUsize::new(0),
            })
            .collect();
        inner.source.server.set_attachment_authority(
            files
                .iter()
                .map(|file| serde_json::to_value(&file.authority).unwrap())
                .collect(),
        );
        Arc::new(Self {
            endpoints,
            files,
            target_ids: Mutex::default(),
            database: database.to_path_buf(),
        })
    }
}

#[async_trait]
impl crate::http_transport::SerializedHttpExecutor for TwoFiles {
    async fn invoke(&self, input: Zeroizing<String>) -> Result<String, RuntimeError> {
        let request: Value = serde_json::from_str(&input).unwrap();
        let recorded = attachment_request(&request);
        for file in &self.files {
            if recorded.url
                == format!(
                    "{SOURCE_ORIGIN}/api/v1/attachments/{}/download-urls",
                    file.authority.id
                )
            {
                if self.endpoints.offline.load(Ordering::SeqCst) {
                    return Ok(json!({"type":"networkFailure"}).to_string());
                }
                assert_eq!(recorded.method, "POST");
                assert_eq!(recorded.header("authorization"), Some("Bearer fresh-token"));
                let a = &file.authority;
                return Ok(routing_completed(
                    200,
                    json!({
                        "attachmentId":a.id, "itemId":a.item_id, "vaultId":a.vault_id, "storageKey":a.storage_key,
                        "envelopeVersion":a.envelope_version, "uploadedBy":a.uploaded_by,
                        "downloadUrl":format!("{SOURCE_DOWNLOAD_URL}/{}",a.id),
                        "encryptedName":a.encrypted_name,"encryptedContentType":a.encrypted_content_type,
                        "encryptionIv":a.encryption_iv,"encryptedContentTypeIv":a.encrypted_content_type_iv,
                        "encryptionAlgorithm":a.encryption_algorithm,"fileSize":a.file_size,
                    }),
                ));
            }
        }
        if recorded.method == "POST"
            && (recorded.url.ends_with("/attachment-uploads")
                || recorded.url.ends_with("/attachments"))
        {
            if self.endpoints.offline.load(Ordering::SeqCst) {
                return Ok(json!({"type":"networkFailure"}).to_string());
            }
            assert_eq!(
                recorded.header("authorization"),
                Some(format!("Bearer {}", OTHER_USER.token).as_str())
            );
            let target = self
                .endpoints
                .target
                .server
                .created_items
                .lock()
                .unwrap()
                .first()
                .cloned()
                .unwrap();
            assert!(recorded
                .url
                .starts_with(&format!("{TARGET_ORIGIN}/api/v1/items/{}/", target.id)));
            let body = routing_request_body(&request);
            if recorded.url.ends_with("/attachment-uploads") {
                let index = self
                    .files
                    .iter()
                    .position(|file| body["fileSize"] == file.authority.file_size)
                    .unwrap();
                let file = &self.files[index];
                let id = body["durableUpload"]["attachmentId"].as_str().unwrap();
                let digest = body["durableUpload"]["ciphertextSha256"].as_str().unwrap();
                assert!(self.files.iter().all(|file| file.authority.id != id));
                assert_eq!(body["fileName"], format!("{id}.enc"));
                assert_eq!(body["contentType"], "application/octet-stream");
                if let Some(previous) = self.target_ids.lock().unwrap().insert(id.into(), index) {
                    assert_eq!(previous, index);
                }
                let mut grants = file.objects.grant_requests.lock().unwrap();
                if let Some(first) = grants.first() {
                    assert_exact_retry(&recorded, first);
                }
                grants.push(recorded);
                return Ok(routing_completed(
                    200,
                    json!({
                        "attachmentId":id,"key":format!("attachments/{}/{id}.enc",OTHER_USER.user_id),
                        "uploadUrl":format!("{TARGET_UPLOAD_URL}/{id}"), "uploadHeaders":[
                            {"name":"content-type","value":"application/octet-stream"},
                            {"name":"content-length","value":file.envelope.len().to_string()},
                            {"name":"x-amz-content-sha256","value":digest},
                            {"name":"x-amz-checksum-sha256","value":digest_base64(digest)}
                        ]
                    }),
                ));
            }
            let body: crate::server_contract::CreateAttachmentBody =
                serde_json::from_value(body).unwrap();
            let index = self.target_ids.lock().unwrap()[&body.attachment_id];
            let file = &self.files[index];
            let uploaded = file
                .objects
                .uploaded
                .lock()
                .unwrap()
                .clone()
                .expect("registration follows actual completed PUT");
            assert_eq!(uploaded.owner.attachment_id(), body.attachment_id);
            assert_eq!(uploaded.ciphertext.len(), file.envelope.len());
            assert_eq!(
                body.storage_key,
                format!(
                    "attachments/{}/{}.enc",
                    OTHER_USER.user_id, body.attachment_id
                )
            );
            let attachment = AuthorityAttachmentRecord {
                id: body.attachment_id,
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
            let mut attachments = self
                .endpoints
                .target
                .server
                .attachments
                .lock()
                .unwrap()
                .clone();
            assert!(attachments.iter().all(|old| old["id"] != attachment.id));
            attachments.push(serde_json::to_value(&attachment).unwrap());
            self.endpoints
                .target
                .server
                .set_attachment_authority(attachments);
            file.objects
                .registration_requests
                .lock()
                .unwrap()
                .push(recorded);
            return Ok(routing_completed(
                200,
                json!({"attachmentId":attachment.id}),
            ));
        }
        // The original URL reaches the existing two-Server router without an origin rewrite.
        self.endpoints.invoke(input).await
    }
    fn cancel(&self, dispatch_id: &str) {
        self.endpoints.cancel(dispatch_id);
    }
}

#[async_trait]
impl AttachmentMoveTransferPort for TwoFiles {
    async fn open_source(
        &self,
        request: AttachmentMoveDownloadRequest,
    ) -> Result<Box<dyn AttachmentMoveDownload>, AttachmentMoveTransferError> {
        let file = self
            .files
            .iter()
            .find(|file| {
                request.download_url == format!("{SOURCE_DOWNLOAD_URL}/{}", file.authority.id)
            })
            .unwrap();
        assert!(request.headers.is_empty());
        assert!(request.max_response_bytes >= file.envelope.len() as u64);
        file.downloads.fetch_add(1, Ordering::SeqCst);
        Ok(Box::new(AttachmentChunks {
            envelope: file.envelope.clone(),
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
        assert_eq!(owner.account_id(), account_id);
        assert_eq!(owner.operation_id(), operation_id);
        assert_eq!(owner.attachment_id(), grant.attachment_id);
        assert_eq!(
            grant.upload_url,
            format!("{TARGET_UPLOAD_URL}/{}", owner.attachment_id())
        );
        let index = self.target_ids.lock().unwrap()[owner.attachment_id()];
        let record = workflow(
            &durable_rows(&self.database, account_id).await,
            operation_id,
        );
        let checkpoint = record["attachments"]
            .as_array()
            .unwrap()
            .iter()
            .find(|checkpoint| checkpoint["targetAttachmentId"] == owner.attachment_id())
            .unwrap();
        assert_eq!(checkpoint["progress"]["type"], "encrypted");
        let child = record["children"]
            .as_array()
            .unwrap()
            .iter()
            .find(|child| {
                child["type"] == "attachmentRegistration"
                    && child["sourceAttachmentId"] == self.files[index].authority.id
            })
            .unwrap();
        assert!(child["result"].is_null());
        let body: Vec<u8> = serde_json::from_value(child["request"]["body"].clone()).unwrap();
        let body: Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(body["attachmentId"], owner.attachment_id());
        assert_eq!(body["storageKey"], grant.storage_key);
        let headers = grant.validated_headers(owner)?;
        assert_eq!(headers.len(), 4);
        Ok(Box::new(AttachmentUploadChunks {
            owner: owner.clone(),
            ciphertext: Vec::new(),
            headers,
            objects: self.files[index].objects.clone(),
        }))
    }
}

struct SecondPublication {
    store: Arc<SqliteAttachmentArtifactStore>,
    owners: Mutex<Vec<AttachmentArtifactOwner>>,
    held: MoveGate,
}

#[async_trait]
impl ProvisionalAttachmentArtifactStore for SecondPublication {
    async fn invoke_provisional(
        &self,
        request: ProvisionalAttachmentArtifactStoreRequest,
    ) -> Result<ProvisionalAttachmentArtifactStoreResponse, RuntimeError> {
        let response = self.store.invoke_provisional(request).await?;
        if let ProvisionalAttachmentArtifactStoreResponse::Finalized(owner) = &response {
            let second = {
                let mut owners = self.owners.lock().unwrap();
                owners.push(owner.clone());
                owners.len() == 2
            };
            if second {
                self.held.hold().await;
            }
        }
        Ok(response)
    }
}

async fn two_file_runtime(
    database: &Path,
    platform: Arc<InstallationPlatform>,
    ports: Arc<TwoFiles>,
    provisional: Arc<dyn ProvisionalAttachmentArtifactStore>,
    published: Arc<dyn AttachmentArtifactStore>,
) -> Arc<Runtime> {
    let runtime = Runtime::with_configured_serialized_executors_and_attachment_move_preparation(
        MoveSqlite::open(database),
        platform,
        ports.clone(),
        AuthClientConfig::new(
            "client-routing".into(),
            ClientPlatform::Desktop,
            "0.5.2-test".into(),
        )
        .unwrap(),
        AttachmentMovePreparationFacade::new(provisional, published, ports),
        Arc::new(crate::runtime::attachment_move_lifecycle::TestAccountLeasePort),
    );
    runtime.open().await.unwrap();
    runtime
}

#[tokio::test]
async fn two_servers_shared_member_reopens_mixed_file_publications_and_completes_five_children() {
    let database = MoveDatabase::new();
    let artifact_database = MoveDatabase::new();
    let platform = Arc::new(InstallationPlatform::default());
    let ports = TwoFiles::new(&database.0);
    assert!(ports.endpoints.target.member_identity.is_some());
    let artifacts = Arc::new(SqliteAttachmentArtifactStore::open(&artifact_database.0).unwrap());
    let publication = Arc::new(SecondPublication {
        store: artifacts.clone(),
        owners: Mutex::default(),
        held: MoveGate::new(),
    });
    let runtime = two_file_runtime(
        &database.0,
        platform.clone(),
        ports.clone(),
        publication.clone(),
        artifacts.clone(),
    )
    .await;
    let mut accounts = Vec::new();
    for (origin, identity) in [
        (SOURCE_ORIGIN, RoutingAuthIdentity::default()),
        (TARGET_ORIGIN, OTHER_USER),
    ] {
        let RuntimeResponse::SignedIn { account_id, .. } = runtime
            .request(
                sign_in_request_to(origin, identity.normalized_email),
                RequestCancellation::new(),
            )
            .await
            .unwrap()
        else {
            panic!("both Servers require their own real SRP proof");
        };
        assert_eq!(
            runtime.require_snapshot(&account_id).unwrap().user_id,
            identity.user_id
        );
        accounts.push(account_id);
    }
    let [source, target]: [AccountId; 2] = accounts.try_into().unwrap();
    let target_before = durable_rows(&database.0, &target).await;
    ports.endpoints.offline.store(true, Ordering::SeqCst);
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
        panic!("the two-file source manifest must be accepted");
    };
    let accepted = workflow(&durable_rows(&database.0, &source).await, &operation_id);
    assert_eq!(accepted["sourceIdentity"]["serverUrl"], SOURCE_ORIGIN);
    assert_eq!(accepted["sourceIdentity"]["userId"], "user-1");
    assert_eq!(accepted["destinationIdentity"]["serverUrl"], TARGET_ORIGIN);
    assert_eq!(
        accepted["destinationIdentity"]["userId"],
        OTHER_USER.user_id
    );
    assert_eq!(
        accepted["source"]["attachments"],
        json!(ports
            .files
            .iter()
            .map(|file| file.authority.clone())
            .collect::<Vec<_>>())
    );
    assert_eq!(accepted["attachments"].as_array().unwrap().len(), 2);
    ports.endpoints.resumed.store(true, Ordering::SeqCst);
    ports.endpoints.offline.store(false, Ordering::SeqCst);
    let runner = tokio::spawn(runtime.clone().run_operation_dispatch());
    let reached =
        tokio::time::timeout(Duration::from_secs(20), publication.held.reached.acquire()).await;
    if reached.is_err() {
        publication.held.release.add_permits(1);
        ports.endpoints.trash_result.release.add_permits(1);
        ports.endpoints.delete_result.release.add_permits(1);
        let stopped = workflow(&durable_rows(&database.0, &source).await, &operation_id);
        close_move_runtime(runtime, runner).await;
        panic!("second actual Finalize did not reach reply-loss boundary: {stopped:?}");
    }
    reached.unwrap().unwrap().forget();
    let mixed = workflow(&durable_rows(&database.0, &source).await, &operation_id);
    let owners = publication.owners.lock().unwrap().clone();
    let mut physical = Vec::new();
    for owner in &owners {
        physical.push((
            publication_generation(&artifacts, owner).await.unwrap(),
            stored_ciphertext(&artifacts, owner).await.unwrap(),
        ));
    }
    let weak = Arc::downgrade(&runtime);
    runner.abort();
    let _ = runner.await;
    publication.held.release.add_permits(1);
    drop(runtime);
    drop(publication);
    drop(artifacts);
    assert!(
        weak.upgrade().is_none(),
        "the old dispatcher and Runtime owner really disappear"
    );
    assert_eq!(owners.len(), 2);
    assert_eq!(mixed["attachments"][0]["progress"]["type"], "encrypted");
    assert_eq!(mixed["attachments"][1]["progress"]["type"], "pending");
    assert_eq!(mixed["attachments"][1], accepted["attachments"][1]);
    assert_eq!(mixed["stage"], json!({"type":"attachments","nextIndex":1}));
    assert_eq!(mixed["children"].as_array().unwrap().len(), 2);
    assert_eq!(mixed["children"][1]["result"]["type"], "acknowledged");
    assert_eq!(
        ports.files[0]
            .objects
            .registration_requests
            .lock()
            .unwrap()
            .len(),
        1
    );
    assert!(ports.files[1]
        .objects
        .registration_requests
        .lock()
        .unwrap()
        .is_empty());
    assert!(ports.endpoints.mutations(SOURCE_ORIGIN).is_empty());
    let artifacts = Arc::new(SqliteAttachmentArtifactStore::open(&artifact_database.0).unwrap());
    let sweep = Arc::new(SweepWitness {
        store: artifacts.clone(),
        completed: Mutex::default(),
        changed: tokio::sync::Notify::new(),
    });
    let reopened = two_file_runtime(
        &database.0,
        platform,
        ports.clone(),
        artifacts.clone(),
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
    assert_eq!(
        workflow(&durable_rows(&database.0, &source).await, &operation_id),
        mixed
    );
    let preparation = tokio::spawn(reopened.clone().run_attachment_move_preparation());
    let swept = tokio::time::timeout(Duration::from_secs(10), sweep.wait_for(&source)).await;
    let mut retained = Vec::new();
    for owner in &owners {
        retained.push((
            publication_generation(&artifacts, owner).await,
            stored_ciphertext(&artifacts, owner).await,
        ));
    }
    preparation.abort();
    let _ = preparation.await;
    if swept.is_err()
        || retained
            .iter()
            .any(|(generation, bytes)| generation.is_err() || bytes.is_err())
    {
        reopened.close().await;
        let summary: Vec<_> = retained
            .iter()
            .map(|(generation, bytes)| {
                (
                    generation.as_ref().map(String::as_str),
                    bytes.as_ref().map(Vec::len),
                )
            })
            .collect();
        panic!(
            "actual mixed live/Pending startup sweep must retain both physical publications: {summary:?}"
        );
    }
    for ((generation, bytes), (expected_generation, expected_bytes)) in
        retained.into_iter().zip(&physical)
    {
        assert_eq!(generation.unwrap(), *expected_generation);
        assert_eq!(bytes.unwrap(), *expected_bytes);
    }
    assert_eq!(
        workflow(&durable_rows(&database.0, &source).await, &operation_id),
        mixed
    );
    for file in &ports.files {
        assert_eq!(file.downloads.load(Ordering::SeqCst), 2);
    }
    ports.endpoints.trash_result.release.add_permits(1);
    ports.endpoints.delete_result.release.add_permits(1);
    let runner = tokio::spawn(reopened.clone().run_operation_dispatch());
    let completed = tokio::time::timeout(Duration::from_secs(20), async {
        while resolution(&reopened, &source, &operation_id) != OperationResolution::Applied {
            tokio::task::yield_now().await;
        }
    })
    .await;
    let final_record = workflow(&durable_rows(&database.0, &source).await, &operation_id);
    let source_projection = reopened
        .projection(&ObservationRequest::Items {
            account_id: source.clone(),
        })
        .unwrap();
    close_move_runtime(reopened, runner).await;
    completed.expect("the recovered second file must register before source destruction");
    let RuntimeProjection::Items(source_items) = source_projection.projection else {
        panic!("expected source Items");
    };
    assert!(source_items.items.is_empty());
    assert_eq!(final_record["stage"], json!({"type":"completed"}));
    assert_eq!(final_record["children"].as_array().unwrap().len(), 5);
    assert_eq!(final_record["children"][0], mixed["children"][0]);
    assert_eq!(final_record["children"][1], mixed["children"][1]);
    assert_eq!(final_record["target"], accepted["target"]);
    assert_eq!(durable_rows(&database.0, &target).await, target_before);
    let attachments = ports
        .endpoints
        .target
        .server
        .attachments
        .lock()
        .unwrap()
        .clone();
    assert_eq!(attachments.len(), 2);
    for (index, file) in ports.files.iter().enumerate() {
        assert_eq!(
            file.downloads.load(Ordering::SeqCst),
            2,
            "reopening must reuse both publications without retranscryption"
        );
        let uploaded = file.objects.uploaded.lock().unwrap().clone().unwrap();
        assert_eq!(uploaded.owner, owners[index]);
        assert_eq!(uploaded.ciphertext, physical[index].1);
        assert_eq!(uploaded.headers.len(), 4);
        let registration = file.objects.registration_requests.lock().unwrap();
        assert_eq!(registration.len(), 1);
        assert!(registration[0].url.starts_with(TARGET_ORIGIN));
        assert!(registration[0].header("idempotency-key").is_none());
        let child = &final_record["children"][index + 1];
        assert_eq!(child["type"], "attachmentRegistration");
        assert_eq!(child["result"]["type"], "acknowledged");
        let body: Vec<u8> = serde_json::from_value(child["request"]["body"].clone()).unwrap();
        assert_eq!(body, registration[0].body);
        let grants = file.objects.grant_requests.lock().unwrap();
        assert_eq!(grants.len(), 2);
        assert_exact_retry(&grants[1], &grants[0]);
        let attachment: AuthorityAttachmentRecord = serde_json::from_value(
            attachments
                .iter()
                .find(|a| a["id"] == uploaded.owner.attachment_id())
                .unwrap()
                .clone(),
        )
        .unwrap();
        assert_eq!(attachment.uploaded_by, OTHER_USER.user_id);
        assert_eq!(attachment.vault_id, "vault-2");
        assert_eq!(
            attachment.id,
            accepted["attachments"][index]["targetAttachmentId"]
        );
        let context = |kind: &str| AadContext {
            vault_id: "vault-2".into(),
            entity_id: attachment.id.clone(),
            entity_type: kind.into(),
            user_id: OTHER_USER.user_id.into(),
            version: 1,
        };
        let wrapped = bittery_crypto_core::EncryptedData {
            ciphertext: attachment.encrypted_attachment_key.clone(),
            iv: attachment.attachment_key_iv.clone(),
            algorithm: attachment.attachment_key_algorithm.clone(),
        };
        let key = bittery_crypto_core::decrypt_with_aad(
            &wrapped,
            &TARGET_KEY,
            &context("attachment_key"),
        )
        .unwrap();
        let key = BASE64.decode(key.as_bytes()).unwrap();
        for (kind, ciphertext, iv, expected) in [
            (
                "attachment_name",
                attachment.encrypted_name.clone(),
                attachment.encryption_iv.clone(),
                if index == 0 {
                    "cross-account-original.bin"
                } else {
                    "second-member-file.bin"
                },
            ),
            (
                "attachment_content_type",
                attachment.encrypted_content_type.clone(),
                attachment.encrypted_content_type_iv.clone(),
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
        let blob: bittery_crypto_core::EncryptedData =
            serde_json::from_slice(&uploaded.ciphertext).unwrap();
        let plain = bittery_crypto_core::decrypt_with_aad(&blob, &key, &context("attachment_blob"))
            .unwrap();
        let expected = if index == 0 {
            vec![0x31; FILE_BYTES]
        } else {
            vec![0x73; SECOND_BYTES]
        };
        assert_eq!(BASE64.decode(plain.as_bytes()).unwrap(), expected);
        let mut wrong = context("attachment_key");
        wrong.user_id = "user-1".into();
        assert!(bittery_crypto_core::decrypt_with_aad(&wrapped, &TARGET_KEY, &wrong).is_err());
        assert!(bittery_crypto_core::decrypt_with_aad(
            &wrapped,
            &[41; 32],
            &context("attachment_key")
        )
        .is_err());
    }
    for (index, version) in [(0, 1), (3, 2), (4, 3)] {
        let child = &final_record["children"][index];
        assert_eq!(child["type"], "itemOperation");
        assert_eq!(child["result"]["result"]["type"], "applied");
        assert_eq!(child["result"]["result"]["version"], version);
        let endpoint = if index == 0 {
            &ports.endpoints.target
        } else {
            &ports.endpoints.source
        };
        let outcome = endpoint.server.outcomes.lock().unwrap()
            [child["operationId"].as_str().unwrap()]
        .clone();
        let fingerprint: String = outcome
            .fingerprint
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect();
        assert_eq!(child["result"]["requestFingerprint"], fingerprint);
    }
    assert_eq!(ports.endpoints.target.server.created_items().len(), 1);
    assert!(ports.endpoints.source.server.created_items().is_empty());
    assert_eq!(ports.endpoints.mutations(TARGET_ORIGIN).len(), 1);
    assert_eq!(ports.endpoints.mutations(SOURCE_ORIGIN).len(), 2);
}
