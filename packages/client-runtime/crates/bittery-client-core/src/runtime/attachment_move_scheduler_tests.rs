use super::attachment_move_preparation::{PreparationDriveRequest, PreparationDriveResult};
use super::attachment_move_scheduler::{
    AttachmentMovePreparationDriver, AttachmentMovePreparationScheduler, PreparationCandidate,
    RuntimeAttachmentMoveSecrets, SchedulerDriveResult, SchedulerPass,
};
use crate::{AccountId, RuntimeError};
use async_trait::async_trait;
use std::{
    collections::{BTreeMap, HashSet, VecDeque},
    sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        Arc, Mutex,
    },
};
use zeroize::Zeroizing;

struct BinaryOnlyTransfer;

#[async_trait]
impl super::attachment_move_scheduler::AttachmentMoveTransferPort for BinaryOnlyTransfer {
    async fn open_source(
        &self,
        _request: super::attachment_move_scheduler::AttachmentMoveDownloadRequest,
    ) -> Result<
        Box<dyn super::attachment_move_scheduler::AttachmentMoveDownload>,
        super::attachment_move_scheduler::AttachmentMoveTransferError,
    > {
        Err(super::attachment_move_scheduler::AttachmentMoveTransferError::Transient)
    }

    async fn open_upload(
        &self,
        _account_id: &AccountId,
        _operation_id: &str,
        _grant: &super::attachment_move_scheduler::AttachmentMoveUploadGrant,
        _owner: &crate::attachment_artifact_store::AttachmentArtifactOwner,
    ) -> Result<
        Box<dyn super::attachment_move_scheduler::AttachmentMoveUpload>,
        super::attachment_move_scheduler::AttachmentMoveTransferError,
    > {
        Err(super::attachment_move_scheduler::AttachmentMoveTransferError::Transient)
    }
}

struct ManifestPlatform {
    values: Mutex<BTreeMap<(String, String), String>>,
    renewed_session_stored: Arc<AtomicBool>,
}

#[async_trait]
impl crate::platform_storage::SerializedPlatformStorageExecutor for ManifestPlatform {
    async fn invoke(
        &self,
        request_json: Zeroizing<String>,
    ) -> Result<Zeroizing<String>, RuntimeError> {
        let request: serde_json::Value = serde_json::from_str(&request_json).unwrap();
        let area = request["area"].as_str().unwrap().to_owned();
        let key = request["key"].as_str().unwrap().to_owned();
        Ok(Zeroizing::new(match request["type"].as_str().unwrap() {
            "get" => serde_json::json!({
                "type": "value",
                "value": self.values.lock().unwrap().get(&(area, key)).cloned(),
            })
            .to_string(),
            "set" => {
                let value = request["value"].as_str().unwrap().to_owned();
                if value.contains("renewed-manifest-token")
                    || value.contains("renewed-source-token")
                {
                    self.renewed_session_stored.store(true, Ordering::SeqCst);
                }
                self.values.lock().unwrap().insert((area, key), value);
                serde_json::json!({ "type": "done" }).to_string()
            }
            other => panic!("unexpected platform request {other}"),
        }))
    }
}

struct EmptyDownload;

#[async_trait]
impl super::attachment_move_scheduler::AttachmentMoveDownload for EmptyDownload {
    async fn next_chunk(
        &mut self,
    ) -> Result<Option<Vec<u8>>, super::attachment_move_scheduler::AttachmentMoveTransferError>
    {
        Ok(None)
    }
}

#[derive(Default)]
struct RecordingBinaryTransfer {
    requests: Mutex<Vec<super::attachment_move_scheduler::AttachmentMoveDownloadRequest>>,
}

#[async_trait]
impl super::attachment_move_scheduler::AttachmentMoveTransferPort for RecordingBinaryTransfer {
    async fn open_source(
        &self,
        request: super::attachment_move_scheduler::AttachmentMoveDownloadRequest,
    ) -> Result<
        Box<dyn super::attachment_move_scheduler::AttachmentMoveDownload>,
        super::attachment_move_scheduler::AttachmentMoveTransferError,
    > {
        self.requests.lock().unwrap().push(request);
        Ok(Box::new(EmptyDownload))
    }

    async fn open_upload(
        &self,
        _account_id: &AccountId,
        _operation_id: &str,
        _grant: &super::attachment_move_scheduler::AttachmentMoveUploadGrant,
        _owner: &crate::attachment_artifact_store::AttachmentArtifactOwner,
    ) -> Result<
        Box<dyn super::attachment_move_scheduler::AttachmentMoveUpload>,
        super::attachment_move_scheduler::AttachmentMoveTransferError,
    > {
        Err(super::attachment_move_scheduler::AttachmentMoveTransferError::Transient)
    }
}

enum SourceGrantResponse {
    Exact,
    Unauthorized,
    Stale,
    Transient,
    Mismatch(&'static str),
    InvalidUrl,
}

struct SourceGrantHttp {
    source: crate::replica::AuthorityAttachmentRecord,
    responses: Mutex<VecDeque<SourceGrantResponse>>,
    requests: Mutex<Vec<serde_json::Value>>,
    renewed_session_stored: Arc<AtomicBool>,
}

impl SourceGrantHttp {
    fn grant(&self, mismatch: Option<&str>) -> serde_json::Value {
        let source = &self.source;
        let mut grant = serde_json::json!({
            "attachmentId": source.id,
            "itemId": source.item_id,
            "vaultId": source.vault_id,
            "storageKey": source.storage_key,
            "envelopeVersion": source.envelope_version,
            "uploadedBy": source.uploaded_by,
            "downloadUrl": "https://object.example.test/invocation-secret?signature=private",
            "encryptedName": source.encrypted_name,
            "encryptedContentType": source.encrypted_content_type,
            "encryptionIv": source.encryption_iv,
            "encryptedContentTypeIv": source.encrypted_content_type_iv,
            "encryptionAlgorithm": source.encryption_algorithm,
            "fileSize": source.file_size,
        });
        if let Some(field) = mismatch {
            grant[field] = match field {
                "envelopeVersion" | "fileSize" => serde_json::json!(99),
                _ => serde_json::json!(format!("foreign-{field}")),
            };
        }
        grant
    }
}

#[async_trait]
impl crate::http_transport::SerializedHttpExecutor for SourceGrantHttp {
    async fn invoke(&self, request_json: String) -> Result<String, RuntimeError> {
        let request: serde_json::Value = serde_json::from_str(&request_json).unwrap();
        let url = request["url"].as_str().unwrap();
        let authorization = request["headers"]
            .as_array()
            .unwrap()
            .iter()
            .find(|header| {
                header["name"]
                    .as_str()
                    .unwrap()
                    .eq_ignore_ascii_case("authorization")
            })
            .and_then(|header| header["value"].as_str())
            .unwrap();
        let response = if url.ends_with("/api/v1/sessions/current/refresh") {
            assert_eq!(authorization, "Bearer source-token");
            serde_json::json!({
                "type": "completed",
                "status": 200,
                "headers": [{ "name": "content-type", "value": "application/json" }],
                "body": serde_json::to_vec(&serde_json::json!({
                    "token": "renewed-source-token",
                    "sessionId": "renewed-source-session",
                    "expiresAt": "2099-01-01T00:00:00Z",
                })).unwrap(),
            })
        } else {
            assert_eq!(
                url,
                "https://requested.example.test/api/v1/attachments/attachment-scheduler/download-urls"
            );
            let response = self.responses.lock().unwrap().pop_front().unwrap();
            match response {
                SourceGrantResponse::Exact => {
                    if authorization == "Bearer renewed-source-token" {
                        assert!(self.renewed_session_stored.load(Ordering::SeqCst));
                    } else {
                        assert_eq!(authorization, "Bearer source-token");
                    }
                    serde_json::json!({
                        "type": "completed",
                        "status": 200,
                        "headers": [{ "name": "content-type", "value": "application/json" }],
                        "body": serde_json::to_vec(&self.grant(None)).unwrap(),
                    })
                }
                SourceGrantResponse::Mismatch(field) => serde_json::json!({
                    "type": "completed",
                    "status": 200,
                    "headers": [{ "name": "content-type", "value": "application/json" }],
                    "body": serde_json::to_vec(&self.grant(Some(field))).unwrap(),
                }),
                SourceGrantResponse::InvalidUrl => {
                    let mut grant = self.grant(None);
                    grant["downloadUrl"] = serde_json::json!("not a URL");
                    serde_json::json!({
                        "type": "completed",
                        "status": 200,
                        "headers": [{ "name": "content-type", "value": "application/json" }],
                        "body": serde_json::to_vec(&grant).unwrap(),
                    })
                }
                SourceGrantResponse::Unauthorized => serde_json::json!({
                    "type": "completed", "status": 401, "headers": [], "body": [],
                }),
                SourceGrantResponse::Stale => serde_json::json!({
                    "type": "completed", "status": 404, "headers": [], "body": [],
                }),
                SourceGrantResponse::Transient => serde_json::json!({
                    "type": "completed", "status": 503, "headers": [], "body": [],
                }),
            }
        };
        self.requests.lock().unwrap().push(request);
        Ok(response.to_string())
    }

    fn cancel(&self, _dispatch_id: &str) {}
}

struct SourceGrantHarness {
    runtime: Arc<super::Runtime>,
    account_id: AccountId,
    persistence: Arc<crate::replica::InMemoryReplica>,
    platform_executor: Arc<ManifestPlatform>,
    http: Arc<SourceGrantHttp>,
    binary: Arc<RecordingBinaryTransfer>,
}

async fn source_grant_harness(responses: Vec<SourceGrantResponse>) -> SourceGrantHarness {
    source_grant_harness_with_file_size(responses, 1).await
}

async fn source_grant_harness_with_file_size(
    responses: Vec<SourceGrantResponse>,
    file_size: i32,
) -> SourceGrantHarness {
    use crate::{
        auth_http::{AuthClientConfig, ClientPlatform},
        platform_storage::{AccountMetadataDocument, CurrentSessionDocument, PlatformStorage},
        protocol::Incarnation,
        replica::{InMemoryReplica, ReplicaPersistence},
    };

    let account_id = AccountId::from("account-requested");
    let incarnation = Incarnation::from("incarnation-account-requested");
    let persistence = Arc::new(InMemoryReplica::default());
    seed_promotable_preparation_with_file_size(
        &persistence,
        account_id.clone(),
        "operation-requested",
        7,
        file_size,
    );
    let source = persistence
        .snapshot(&account_id)
        .unwrap()
        .attachment_move_preparations[0]
        .source_attachments[0]
        .clone();
    let stored = Arc::new(AtomicBool::new(false));
    let platform_executor = Arc::new(ManifestPlatform {
        values: Mutex::new(BTreeMap::new()),
        renewed_session_stored: Arc::clone(&stored),
    });
    let platform = Arc::new(PlatformStorage::new(platform_executor.clone()));
    platform
        .store_account_metadata(
            &AccountMetadataDocument::new(
                account_id.clone(),
                incarnation.clone(),
                "user-scheduler".into(),
                "requested@example.test".into(),
                "Requested".into(),
                "https://requested.example.test".into(),
                None,
                None,
                "A3".into(),
                1,
                1,
                false,
                false,
                bittery_crypto_core::current_kdf_profile(),
                None,
            )
            .unwrap(),
        )
        .await
        .unwrap();
    platform
        .store_current_session(
            &CurrentSessionDocument::new(
                account_id.clone(),
                incarnation,
                "source-token".into(),
                Some("source-session".into()),
                2,
                Some(2),
                Vec::new(),
                "encrypted-private-key".into(),
            )
            .unwrap(),
        )
        .await
        .unwrap();
    let http = Arc::new(SourceGrantHttp {
        source,
        responses: Mutex::new(responses.into()),
        requests: Mutex::new(Vec::new()),
        renewed_session_stored: stored,
    });
    let runtime = super::Runtime::with_persistence(
        persistence.clone() as Arc<dyn ReplicaPersistence>,
        platform,
        Arc::new(crate::http_transport::HttpTransport::new(http.clone())),
        Some(AuthClientConfig::new("client".into(), ClientPlatform::Web, "1.0.0".into()).unwrap()),
        None,
        true,
        Arc::new(crate::authentication_installation::FixedClock(0)),
        Arc::new(NeverTimer),
        Some(persistence.clone()),
    );
    runtime.replica().load(&account_id).await.unwrap();
    SourceGrantHarness {
        runtime,
        account_id,
        persistence,
        platform_executor,
        http,
        binary: Arc::new(RecordingBinaryTransfer::default()),
    }
}

fn source_request(
    account_id: AccountId,
    operation_id: &str,
    attachment_id: &str,
    storage_key: &str,
    pass: super::attachment_move_preparation::DownloadPass,
) -> super::attachment_move_preparation::SourceDownloadRequest {
    super::attachment_move_preparation::SourceDownloadRequest {
        account_id,
        operation_id: operation_id.into(),
        attachment_id: attachment_id.into(),
        storage_key: storage_key.into(),
        pass,
    }
}

async fn source_error(
    adapter: &super::attachment_move_scheduler::TransferAdapter,
    request: super::attachment_move_preparation::SourceDownloadRequest,
) -> super::attachment_move_preparation::PreparationTransportError {
    use super::attachment_move_preparation::AttachmentMoveTransfer;
    let result = adapter.open_source(request).await;
    let Err(error) = result else {
        panic!("source unexpectedly opened");
    };
    error
}

#[tokio::test]
async fn source_grant_404_freezes_the_explicit_accepted_source_before_binary_execution() {
    use super::attachment_move_preparation::{DownloadPass, PreparationTransportError};

    let harness = source_grant_harness(vec![SourceGrantResponse::Stale]).await;
    let adapter = super::attachment_move_scheduler::TransferAdapter::new(
        harness.binary.clone(),
        Arc::downgrade(&harness.runtime),
    );

    assert_eq!(
        source_error(
            &adapter,
            source_request(
                harness.account_id.clone(),
                "operation-requested",
                "attachment-scheduler",
                "source-object",
                DownloadPass::Scan,
            ),
        )
        .await,
        PreparationTransportError::StaleAuthority
    );
    assert!(harness.binary.requests.lock().unwrap().is_empty());
    assert_eq!(
        harness
            .persistence
            .snapshot(&harness.account_id)
            .unwrap()
            .attachment_move_preparations
            .len(),
        1
    );
}

#[tokio::test]
async fn scan_and_transcrypt_each_mint_a_fresh_grant_and_expose_only_bounded_invocation_data() {
    use super::attachment_move_preparation::{AttachmentMoveTransfer, DownloadPass};

    let harness = source_grant_harness_with_file_size(
        vec![SourceGrantResponse::Exact, SourceGrantResponse::Exact],
        73,
    )
    .await;
    let adapter = super::attachment_move_scheduler::TransferAdapter::new(
        harness.binary.clone(),
        Arc::downgrade(&harness.runtime),
    );

    for pass in [DownloadPass::Scan, DownloadPass::Transcrypt] {
        adapter
            .open_source(source_request(
                harness.account_id.clone(),
                "operation-requested",
                "attachment-scheduler",
                "source-object",
                pass,
            ))
            .await
            .unwrap();
    }

    let requests = harness.binary.requests.lock().unwrap();
    assert_eq!(requests.len(), 2);
    for request in requests.iter() {
        assert_eq!(
            request.download_url,
            "https://object.example.test/invocation-secret?signature=private"
        );
        assert!(request.headers.is_empty());
        assert_eq!(request.max_response_bytes, 226);
        assert_eq!(request.max_chunk_bytes, 256 * 1024);
    }
    assert_eq!(harness.http.requests.lock().unwrap().len(), 2);
    assert!(harness
        .platform_executor
        .values
        .lock()
        .unwrap()
        .values()
        .all(|value| !value.contains("invocation-secret") && !value.contains("signature=private")));
    let durable = serde_json::to_string(
        &harness
            .persistence
            .snapshot(&harness.account_id)
            .unwrap()
            .attachment_move_preparations,
    )
    .unwrap();
    assert!(!durable.contains("invocation-secret"));
}

#[tokio::test]
async fn every_download_grant_authority_mismatch_is_stale_without_binary_execution() {
    use super::attachment_move_preparation::{DownloadPass, PreparationTransportError};

    let fields = [
        "attachmentId",
        "itemId",
        "vaultId",
        "storageKey",
        "envelopeVersion",
        "uploadedBy",
        "encryptedName",
        "encryptedContentType",
        "encryptionIv",
        "encryptedContentTypeIv",
        "encryptionAlgorithm",
        "fileSize",
    ];
    let harness = source_grant_harness(
        fields
            .iter()
            .copied()
            .map(SourceGrantResponse::Mismatch)
            .collect(),
    )
    .await;
    let adapter = super::attachment_move_scheduler::TransferAdapter::new(
        harness.binary.clone(),
        Arc::downgrade(&harness.runtime),
    );

    for field in fields {
        assert_eq!(
            source_error(
                &adapter,
                source_request(
                    harness.account_id.clone(),
                    "operation-requested",
                    "attachment-scheduler",
                    "source-object",
                    DownloadPass::Scan,
                ),
            )
            .await,
            PreparationTransportError::StaleAuthority,
            "grant field {field} must be compared with accepted authority"
        );
    }
    assert!(harness.binary.requests.lock().unwrap().is_empty());
    assert_eq!(harness.http.requests.lock().unwrap().len(), fields.len());
}

#[tokio::test]
async fn foreign_account_operation_attachment_or_storage_never_reaches_http_or_binary() {
    use super::attachment_move_preparation::{DownloadPass, PreparationTransportError};

    let harness = source_grant_harness(vec![SourceGrantResponse::Exact]).await;
    let adapter = super::attachment_move_scheduler::TransferAdapter::new(
        harness.binary.clone(),
        Arc::downgrade(&harness.runtime),
    );
    let requests = [
        source_request(
            AccountId::from("account-foreign"),
            "operation-requested",
            "attachment-scheduler",
            "source-object",
            DownloadPass::Scan,
        ),
        source_request(
            harness.account_id.clone(),
            "operation-foreign",
            "attachment-scheduler",
            "source-object",
            DownloadPass::Scan,
        ),
        source_request(
            harness.account_id.clone(),
            "operation-requested",
            "attachment-foreign",
            "source-object",
            DownloadPass::Scan,
        ),
        source_request(
            harness.account_id.clone(),
            "operation-requested",
            "attachment-scheduler",
            "storage-foreign",
            DownloadPass::Scan,
        ),
    ];

    for request in requests {
        assert_eq!(
            source_error(&adapter, request).await,
            PreparationTransportError::Invariant
        );
    }
    assert!(harness.http.requests.lock().unwrap().is_empty());
    assert!(harness.binary.requests.lock().unwrap().is_empty());
}

#[tokio::test]
async fn first_source_401_persists_refresh_before_one_replay() {
    use super::attachment_move_preparation::{AttachmentMoveTransfer, DownloadPass};

    let harness = source_grant_harness(vec![
        SourceGrantResponse::Unauthorized,
        SourceGrantResponse::Exact,
    ])
    .await;
    let adapter = super::attachment_move_scheduler::TransferAdapter::new(
        harness.binary.clone(),
        Arc::downgrade(&harness.runtime),
    );

    adapter
        .open_source(source_request(
            harness.account_id.clone(),
            "operation-requested",
            "attachment-scheduler",
            "source-object",
            DownloadPass::Scan,
        ))
        .await
        .unwrap();

    assert_eq!(harness.http.requests.lock().unwrap().len(), 3);
    assert_eq!(harness.binary.requests.lock().unwrap().len(), 1);
    let snapshot = harness
        .runtime
        .replica
        .snapshot(&harness.account_id)
        .unwrap();
    let session = harness
        .runtime
        .platform_storage
        .load_current_session(&harness.account_id, &snapshot.incarnation)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(session.token.as_ref(), "renewed-source-token");
}

#[tokio::test]
async fn second_source_401_or_transient_answer_is_retryable_without_discard_or_extra_replay() {
    use super::attachment_move_preparation::{DownloadPass, PreparationTransportError};

    for responses in [
        vec![
            SourceGrantResponse::Unauthorized,
            SourceGrantResponse::Unauthorized,
        ],
        vec![SourceGrantResponse::Transient],
    ] {
        let harness = source_grant_harness(responses).await;
        let adapter = super::attachment_move_scheduler::TransferAdapter::new(
            harness.binary.clone(),
            Arc::downgrade(&harness.runtime),
        );

        assert_eq!(
            source_error(
                &adapter,
                source_request(
                    harness.account_id.clone(),
                    "operation-requested",
                    "attachment-scheduler",
                    "source-object",
                    DownloadPass::Scan,
                ),
            )
            .await,
            PreparationTransportError::Transient
        );
        assert!(harness.binary.requests.lock().unwrap().is_empty());
        let snapshot = harness.persistence.snapshot(&harness.account_id).unwrap();
        assert_eq!(snapshot.attachment_move_preparations.len(), 1);
        assert_eq!(
            snapshot.attachment_move_preparations[0]
                .scheduling
                .attempt_count,
            7
        );
        assert!(harness.http.requests.lock().unwrap().len() <= 3);
    }
}

#[tokio::test]
async fn malformed_invocation_url_is_an_invariant_before_binary_execution() {
    use super::attachment_move_preparation::{DownloadPass, PreparationTransportError};

    let harness = source_grant_harness(vec![SourceGrantResponse::InvalidUrl]).await;
    let adapter = super::attachment_move_scheduler::TransferAdapter::new(
        harness.binary.clone(),
        Arc::downgrade(&harness.runtime),
    );

    assert_eq!(
        source_error(
            &adapter,
            source_request(
                harness.account_id.clone(),
                "operation-requested",
                "attachment-scheduler",
                "source-object",
                DownloadPass::Scan,
            ),
        )
        .await,
        PreparationTransportError::Invariant
    );
    assert!(harness.binary.requests.lock().unwrap().is_empty());
}

struct ManifestHttp {
    renewed_session_stored: Arc<AtomicBool>,
    requests: Mutex<Vec<serde_json::Value>>,
    replay_unauthorized: bool,
    operation_id: &'static str,
    item_id: &'static str,
    attachment_id: &'static str,
    ciphertext_sha256: String,
    refresh_hold: Option<Arc<RefreshHold>>,
}

struct RefreshHold {
    entered: tokio::sync::Notify,
    release: tokio::sync::Notify,
}

struct BootstrapHoldingHttp {
    server: Arc<super::operation_fixtures::FakeServer>,
    entered: tokio::sync::Notify,
    release: tokio::sync::Notify,
}

#[async_trait]
impl crate::http_transport::SerializedHttpExecutor for BootstrapHoldingHttp {
    async fn invoke(&self, request_json: String) -> Result<String, RuntimeError> {
        let request: serde_json::Value = serde_json::from_str(&request_json).unwrap();
        if request["url"]
            .as_str()
            .is_some_and(|url| url.contains("/api/v1/sync/changes"))
        {
            self.entered.notify_one();
            self.release.notified().await;
        }
        crate::http_transport::SerializedHttpExecutor::invoke(&*self.server, request_json).await
    }

    fn cancel(&self, dispatch_id: &str) {
        crate::http_transport::SerializedHttpExecutor::cancel(&*self.server, dispatch_id);
    }
}

#[async_trait]
impl crate::http_transport::SerializedHttpExecutor for ManifestHttp {
    async fn invoke(&self, request_json: String) -> Result<String, RuntimeError> {
        let request: serde_json::Value = serde_json::from_str(&request_json).unwrap();
        let url = request["url"].as_str().unwrap();
        let authorization = request["headers"]
            .as_array()
            .unwrap()
            .iter()
            .find(|header| {
                header["name"]
                    .as_str()
                    .unwrap()
                    .eq_ignore_ascii_case("authorization")
            })
            .and_then(|header| header["value"].as_str())
            .unwrap();
        let response = if url.ends_with("/api/v1/sessions/current/refresh") {
            assert_eq!(authorization, "Bearer first-manifest-token");
            if let Some(hold) = &self.refresh_hold {
                hold.entered.notify_one();
                hold.release.notified().await;
            }
            serde_json::json!({
                "type": "completed",
                "status": 200,
                "headers": [{ "name": "content-type", "value": "application/json" }],
                "body": serde_json::to_vec(&serde_json::json!({
                    "token": "renewed-manifest-token",
                    "sessionId": "renewed-session",
                    "expiresAt": "2099-01-01T00:00:00Z",
                })).unwrap(),
            })
        } else if url.ends_with("/attachment-move-manifest") {
            assert_eq!(
                url,
                format!(
                    "https://requested.example.test/api/v1/operations/{}/attachment-move-manifest",
                    self.operation_id
                )
            );
            let previous_manifest_calls = self
                .requests
                .lock()
                .unwrap()
                .iter()
                .filter(|record| record["url"] == request["url"])
                .count();
            if previous_manifest_calls == 0 {
                assert_eq!(authorization, "Bearer first-manifest-token");
                serde_json::json!({
                    "type": "completed",
                    "status": 401,
                    "headers": [],
                    "body": [],
                })
            } else {
                assert_eq!(authorization, "Bearer renewed-manifest-token");
                assert!(self.renewed_session_stored.load(Ordering::SeqCst));
                if self.replay_unauthorized {
                    self.requests.lock().unwrap().push(request);
                    return Ok(serde_json::json!({
                        "type": "completed",
                        "status": 401,
                        "headers": [],
                        "body": [],
                    })
                    .to_string());
                }
                let body: Vec<u8> = request["body"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|byte| byte.as_u64().unwrap() as u8)
                    .collect();
                assert_eq!(
                    serde_json::from_slice::<serde_json::Value>(&body).unwrap(),
                    serde_json::json!({
                        "itemId": self.item_id,
                        "sourceVaultId": "vault-source",
                        "targetVaultId": "vault-target",
                        "attachments": [{
                            "attachmentId": self.attachment_id,
                            "envelopeVersion": 4,
                            "ciphertextSha256": self.ciphertext_sha256,
                        }],
                    })
                );
                serde_json::json!({
                    "type": "completed",
                    "status": 200,
                    "headers": [{ "name": "content-type", "value": "application/json" }],
                    "body": serde_json::to_vec(&serde_json::json!({
                        "operationId": self.operation_id,
                        "expiresAt": "2099-01-01T00:00:00Z",
                        "attachments": [{
                            "attachmentId": self.attachment_id,
                            "storageKey": "staging-object",
                            "uploadUrl": "https://object.example.test/invocation-secret",
                        }],
                    })).unwrap(),
                })
            }
        } else {
            serde_json::json!({ "type": "networkFailure" })
        };
        self.requests.lock().unwrap().push(request);
        Ok(response.to_string())
    }

    fn cancel(&self, _dispatch_id: &str) {}
}

#[tokio::test]
async fn core_manifest_authority_refreshes_the_explicit_account_before_one_replay() {
    use super::attachment_move_preparation::{
        AttachmentMoveTransfer, ManifestAttachment, ManifestRequest,
    };
    use crate::{
        auth_http::{AuthClientConfig, ClientPlatform},
        platform_storage::{AccountMetadataDocument, CurrentSessionDocument, PlatformStorage},
        protocol::Incarnation,
        replica::{InMemoryReplica, ReplicaPersistence},
    };

    let requested = AccountId::from("account-requested");
    let foreign = AccountId::from("account-active-foreign");
    let requested_incarnation = Incarnation::from("incarnation-requested");
    let persistence = Arc::new(InMemoryReplica::default());
    persistence
        .install(
            requested.clone(),
            "user-requested".into(),
            requested_incarnation.clone(),
        )
        .unwrap();
    persistence
        .install(
            foreign,
            "user-foreign".into(),
            Incarnation::from("incarnation-foreign"),
        )
        .unwrap();
    let stored = Arc::new(AtomicBool::new(false));
    let platform = Arc::new(PlatformStorage::new(Arc::new(ManifestPlatform {
        values: Mutex::new(BTreeMap::new()),
        renewed_session_stored: stored.clone(),
    })));
    platform
        .store_account_metadata(
            &AccountMetadataDocument::new(
                requested.clone(),
                requested_incarnation.clone(),
                "user-requested".into(),
                "requested@example.test".into(),
                "Requested".into(),
                "https://requested.example.test".into(),
                None,
                None,
                "A3".into(),
                1,
                1,
                false,
                false,
                bittery_crypto_core::current_kdf_profile(),
                None,
            )
            .unwrap(),
        )
        .await
        .unwrap();
    platform
        .store_current_session(
            &CurrentSessionDocument::new(
                requested.clone(),
                requested_incarnation,
                "first-manifest-token".into(),
                Some("first-session".into()),
                2,
                Some(2),
                Vec::new(),
                "encrypted-private-key".into(),
            )
            .unwrap(),
        )
        .await
        .unwrap();
    let http_executor = Arc::new(ManifestHttp {
        renewed_session_stored: stored.clone(),
        requests: Mutex::new(Vec::new()),
        replay_unauthorized: false,
        operation_id: "operation-requested",
        item_id: "item-requested",
        attachment_id: "attachment-requested",
        ciphertext_sha256: "11".repeat(32),
        refresh_hold: None,
    });
    let http_transport = Arc::new(crate::http_transport::HttpTransport::new(
        http_executor.clone(),
    ));
    let auth_config =
        AuthClientConfig::new("client".into(), ClientPlatform::Web, "1.0.0".into()).unwrap();
    let runtime = super::Runtime::with_persistence(
        persistence.clone() as Arc<dyn ReplicaPersistence>,
        platform.clone(),
        http_transport.clone(),
        Some(auth_config.clone()),
        None,
        true,
        Arc::new(crate::authentication_installation::FixedClock(0)),
        Arc::new(NeverTimer),
        Some(persistence),
    );
    runtime.replica().load(&requested).await.unwrap();
    runtime.mark_reauthentication_required(&requested);
    let revision_before_session_available = runtime.device_revision.load(Ordering::SeqCst);
    let replica = runtime.replica();
    let adapter = super::attachment_move_scheduler::TransferAdapter::new(
        Arc::new(BinaryOnlyTransfer),
        Arc::downgrade(&runtime),
    );

    let manifest = adapter
        .renew_manifest(ManifestRequest {
            account_id: requested.clone(),
            operation_id: "operation-requested".into(),
            item_id: "item-requested".into(),
            source_vault_id: "vault-source".into(),
            target_vault_id: "vault-target".into(),
            attachments: vec![ManifestAttachment {
                attachment_id: "attachment-requested".into(),
                envelope_version: 4,
                ciphertext_sha256: "11".repeat(32),
            }],
        })
        .await
        .unwrap();

    assert_eq!(manifest.operation_id, "operation-requested");
    assert_eq!(manifest.uploads.len(), 1);
    assert!(stored.load(Ordering::SeqCst));
    let renewed = platform
        .load_current_session(
            &requested,
            &replica.snapshot(&requested).unwrap().incarnation,
        )
        .await
        .unwrap()
        .unwrap();
    assert_eq!(renewed.token.as_ref(), "renewed-manifest-token");
    assert!(!runtime
        .waiting_reasons
        .lock()
        .unwrap()
        .contains_key(&requested));
    assert_eq!(
        runtime.device_revision.load(Ordering::SeqCst),
        revision_before_session_available + 1
    );
    assert_eq!(http_executor.requests.lock().unwrap().len(), 3);
}

#[tokio::test]
async fn a_second_manifest_unauthorized_answer_retries_without_discarding_accepted_work() {
    use super::attachment_move_preparation::{
        AttachmentMoveTransfer, ManifestAttachment, ManifestRequest, PreparationTransportError,
    };
    use crate::{
        auth_http::{AuthClientConfig, ClientPlatform},
        platform_storage::{AccountMetadataDocument, CurrentSessionDocument, PlatformStorage},
        protocol::Incarnation,
        replica::{InMemoryReplica, ReplicaPersistence},
    };

    let requested = AccountId::from("account-requested");
    let requested_incarnation = Incarnation::from("incarnation-account-requested");
    let persistence = Arc::new(InMemoryReplica::default());
    seed_promotable_preparation(&persistence, requested.clone(), "operation-requested", 7);
    let stored = Arc::new(AtomicBool::new(false));
    let platform = Arc::new(PlatformStorage::new(Arc::new(ManifestPlatform {
        values: Mutex::new(BTreeMap::new()),
        renewed_session_stored: stored.clone(),
    })));
    platform
        .store_account_metadata(
            &AccountMetadataDocument::new(
                requested.clone(),
                requested_incarnation.clone(),
                "user-scheduler".into(),
                "requested@example.test".into(),
                "Requested".into(),
                "https://requested.example.test".into(),
                None,
                None,
                "A3".into(),
                1,
                1,
                false,
                false,
                bittery_crypto_core::current_kdf_profile(),
                None,
            )
            .unwrap(),
        )
        .await
        .unwrap();
    platform
        .store_current_session(
            &CurrentSessionDocument::new(
                requested.clone(),
                requested_incarnation,
                "first-manifest-token".into(),
                Some("first-session".into()),
                2,
                Some(2),
                Vec::new(),
                "encrypted-private-key".into(),
            )
            .unwrap(),
        )
        .await
        .unwrap();
    let http_executor = Arc::new(ManifestHttp {
        renewed_session_stored: stored,
        requests: Mutex::new(Vec::new()),
        replay_unauthorized: true,
        operation_id: "operation-requested",
        item_id: "item-requested",
        attachment_id: "attachment-requested",
        ciphertext_sha256: "11".repeat(32),
        refresh_hold: None,
    });
    let runtime = super::Runtime::with_persistence(
        persistence.clone() as Arc<dyn ReplicaPersistence>,
        platform,
        Arc::new(crate::http_transport::HttpTransport::new(
            http_executor.clone(),
        )),
        Some(AuthClientConfig::new("client".into(), ClientPlatform::Web, "1.0.0".into()).unwrap()),
        None,
        true,
        Arc::new(crate::authentication_installation::FixedClock(0)),
        Arc::new(NeverTimer),
        Some(persistence),
    );
    runtime.replica().load(&requested).await.unwrap();
    let replica = runtime.replica();
    let adapter = super::attachment_move_scheduler::TransferAdapter::new(
        Arc::new(BinaryOnlyTransfer),
        Arc::downgrade(&runtime),
    );

    let error = adapter
        .renew_manifest(ManifestRequest {
            account_id: requested.clone(),
            operation_id: "operation-requested".into(),
            item_id: "item-requested".into(),
            source_vault_id: "vault-source".into(),
            target_vault_id: "vault-target".into(),
            attachments: vec![ManifestAttachment {
                attachment_id: "attachment-requested".into(),
                envelope_version: 4,
                ciphertext_sha256: "11".repeat(32),
            }],
        })
        .await
        .unwrap_err();

    assert_eq!(error, PreparationTransportError::Transient);
    let requests = http_executor.requests.lock().unwrap();
    assert_eq!(requests.len(), 3);
    assert_eq!(
        requests
            .iter()
            .filter(|request| request["url"]
                .as_str()
                .unwrap()
                .ends_with("/sessions/current/refresh"))
            .count(),
        1
    );
    let snapshot = replica.snapshot(&requested).unwrap();
    assert_eq!(snapshot.attachment_move_preparations.len(), 1);
    assert_eq!(
        snapshot.attachment_move_preparations[0]
            .scheduling
            .attempt_count,
        7
    );
}

#[tokio::test]
async fn ordinary_dispatch_waits_behind_the_same_account_preparation_execution_fence() {
    use super::operation_fixtures::{seeded, RefreshBehavior, SECOND_TOKEN};

    let harness = seeded(false).await;
    *harness.server.refresh.lock().unwrap() = RefreshBehavior::Renews(SECOND_TOKEN);
    harness.server.accepted_tokens.lock().unwrap().clear();
    let (operation_id, _) = harness.accept_create().await;
    let execution_lock = harness
        .runtime
        .account_execution_lock(&harness.account_id)
        .unwrap();
    let preparation_guard = execution_lock.lock().await;
    let dispatch = tokio::spawn({
        let runtime = harness.runtime.clone();
        let account_id = harness.account_id.clone();
        async move {
            runtime
                .dispatch_once_ignoring_lease(&account_id, &operation_id)
                .await
        }
    });
    for _ in 0..10 {
        tokio::task::yield_now().await;
    }

    assert!(
        harness.server.requests.lock().unwrap().is_empty(),
        "dispatch must not reach Session HTTP while preparation owns the Account"
    );
    drop(preparation_guard);
    tokio::time::timeout(std::time::Duration::from_secs(1), dispatch)
        .await
        .expect("dispatch must not reacquire its own Account execution fence")
        .unwrap();
    assert_eq!(harness.server.refresh_calls.load(Ordering::SeqCst), 1);
    assert!(harness.operation().is_none());
}

#[tokio::test]
async fn ordinary_dispatch_waits_while_bootstrap_owns_the_account_execution_fence() {
    use super::operation_fixtures::{auth_config, seeded, TestTimer};

    let harness = seeded(false).await;
    let (operation_id, _) = harness.accept_create().await;
    let http = Arc::new(BootstrapHoldingHttp {
        server: harness.server.clone(),
        entered: tokio::sync::Notify::new(),
        release: tokio::sync::Notify::new(),
    });
    let runtime = super::Runtime::with_test_dispatch_environment(
        harness.replica.clone(),
        harness.platform.clone(),
        http.clone(),
        auth_config(),
        harness.clock.clone(),
        TestTimer::advancing(harness.clock.clone()),
    );
    runtime.replica().load(&harness.account_id).await.unwrap();
    runtime.unlock_account(&harness.account_id).await.unwrap();
    let bootstrap = tokio::spawn({
        let runtime = runtime.clone();
        let account_id = harness.account_id.clone();
        async move {
            runtime
                .bootstrap_account(&account_id, crate::RequestCancellation::new())
                .await
        }
    });
    http.entered.notified().await;
    let dispatch = tokio::spawn({
        let runtime = runtime.clone();
        let account_id = harness.account_id.clone();
        async move {
            runtime
                .dispatch_once_ignoring_lease(&account_id, &operation_id)
                .await
        }
    });
    for _ in 0..10 {
        tokio::task::yield_now().await;
    }

    assert_eq!(
        harness.server.creates(),
        0,
        "dispatch must not enter Session HTTP while Bootstrap owns the Account"
    );
    http.release.notify_one();
    tokio::time::timeout(std::time::Duration::from_secs(1), bootstrap)
        .await
        .expect("Bootstrap must finish after its HTTP response")
        .unwrap()
        .unwrap();
    tokio::time::timeout(std::time::Duration::from_secs(1), dispatch)
        .await
        .expect("dispatch must resume after Bootstrap releases the Account")
        .unwrap();
    assert_eq!(harness.server.creates(), 1);
}

#[tokio::test]
async fn production_scheduler_persists_backoff_after_manifest_refresh_replay_is_unauthorized() {
    use crate::{
        attachment_artifact_store::{
            AttachmentArtifactStore, AttachmentArtifactStoreRequest, SqliteAttachmentArtifactStore,
        },
        auth_http::{AuthClientConfig, ClientPlatform},
        platform_storage::{AccountMetadataDocument, CurrentSessionDocument, PlatformStorage},
        protocol::Incarnation,
        replica::{GuardedCommitPlan, InMemoryReplica, PlanMutation, ReplicaPersistence},
    };

    let account_id = AccountId::from("account-production-manifest");
    let operation_id = "operation-production-manifest";
    let incarnation = Incarnation::from("incarnation-account-production-manifest");
    let persistence = Arc::new(InMemoryReplica::default());
    seed_promotable_preparation(&persistence, account_id.clone(), operation_id, 7);
    let before_reset = persistence.snapshot(&account_id).unwrap();
    let preparation = &before_reset.attachment_move_preparations[0];
    persistence
        .execute(GuardedCommitPlan::new(
            account_id.clone(),
            before_reset.incarnation,
            before_reset.revision,
            before_reset.lock_epoch,
            vec![PlanMutation::ResetAttachmentMoveUpload {
                operation_id: operation_id.into(),
                expected_intent_fingerprint: preparation.intent_fingerprint,
                attachment_id: "attachment-scheduler".into(),
            }],
        ))
        .unwrap();
    let reset = persistence.snapshot(&account_id).unwrap();
    let artifact = match &reset.attachment_move_preparations[0].progress[0] {
        crate::replica::AttachmentMoveProgress::Encrypted { artifact, .. } => artifact.clone(),
        other => panic!("expected encrypted artifact, got {other:?}"),
    };
    let owner = crate::attachment_artifact_store::AttachmentArtifactOwner::from_reference_parts(
        account_id.clone(),
        operation_id,
        "attachment-scheduler",
        artifact.artifact_id.clone(),
        artifact.ciphertext_sha256.clone(),
        artifact.byte_length,
    )
    .unwrap();
    let artifacts = Arc::new(SqliteAttachmentArtifactStore::open(":memory:").unwrap());
    artifacts
        .invoke(AttachmentArtifactStoreRequest::WriteChunk {
            owner: owner.clone(),
            chunk_index: 0,
            bytes: vec![42],
        })
        .await
        .unwrap();
    artifacts
        .invoke(AttachmentArtifactStoreRequest::Publish { owner })
        .await
        .unwrap();

    let stored = Arc::new(AtomicBool::new(false));
    let platform = Arc::new(PlatformStorage::new(Arc::new(ManifestPlatform {
        values: Mutex::new(BTreeMap::new()),
        renewed_session_stored: stored.clone(),
    })));
    platform
        .store_account_metadata(
            &AccountMetadataDocument::new(
                account_id.clone(),
                incarnation.clone(),
                "user-scheduler".into(),
                "requested@example.test".into(),
                "Requested".into(),
                "https://requested.example.test".into(),
                None,
                None,
                "A3".into(),
                1,
                1,
                false,
                false,
                bittery_crypto_core::current_kdf_profile(),
                None,
            )
            .unwrap(),
        )
        .await
        .unwrap();
    platform
        .store_current_session(
            &CurrentSessionDocument::new(
                account_id.clone(),
                incarnation,
                "first-manifest-token".into(),
                Some("first-session".into()),
                2,
                Some(2),
                Vec::new(),
                "encrypted-private-key".into(),
            )
            .unwrap(),
        )
        .await
        .unwrap();
    let refresh_hold = Arc::new(RefreshHold {
        entered: tokio::sync::Notify::new(),
        release: tokio::sync::Notify::new(),
    });
    let http_executor = Arc::new(ManifestHttp {
        renewed_session_stored: stored,
        requests: Mutex::new(Vec::new()),
        replay_unauthorized: true,
        operation_id: "operation-production-manifest",
        item_id: "item-scheduler",
        attachment_id: "attachment-scheduler",
        ciphertext_sha256: artifact.ciphertext_sha256.clone(),
        refresh_hold: Some(refresh_hold.clone()),
    });
    let runtime = super::Runtime::with_persistence(
        persistence.clone() as Arc<dyn ReplicaPersistence>,
        platform,
        Arc::new(crate::http_transport::HttpTransport::new(
            http_executor.clone(),
        )),
        Some(AuthClientConfig::new("client".into(), ClientPlatform::Web, "1.0.0".into()).unwrap()),
        None,
        true,
        Arc::new(crate::authentication_installation::FixedClock(0)),
        Arc::new(NeverTimer),
        Some(persistence),
    );
    runtime.replica().load(&account_id).await.unwrap();
    runtime.install_attachment_move_preparation(
        super::attachment_move_scheduler::AttachmentMovePreparationFacade::new(
            artifacts.clone(),
            artifacts,
            Arc::new(BinaryOnlyTransfer),
        ),
    );
    runtime.seed_unlocked_preparation_account(&account_id);
    let ordinary_operation_id = match runtime
        .request(
            crate::RuntimeRequest::CreateLoginItem {
                account_id: account_id.clone(),
                vault_id: "vault-source".into(),
                draft: super::operation_fixtures::draft(),
            },
            crate::RequestCancellation::new(),
        )
        .await
        .unwrap()
    {
        crate::RuntimeResponse::Accepted { operation_id, .. } => operation_id,
        other => panic!("expected accepted ordinary Operation, got {other:?}"),
    };
    let lifecycle = tokio::spawn(runtime.clone().run_attachment_move_preparation());
    refresh_hold.entered.notified().await;
    let dispatch = tokio::spawn({
        let runtime = runtime.clone();
        let account_id = account_id.clone();
        async move {
            runtime
                .dispatch_once_ignoring_lease(&account_id, &ordinary_operation_id)
                .await
        }
    });
    for _ in 0..10 {
        tokio::task::yield_now().await;
    }
    assert!(!http_executor
        .requests
        .lock()
        .unwrap()
        .iter()
        .any(|request| { request["url"].as_str().unwrap().contains("/api/v1/vaults/") }));
    refresh_hold.release.notify_one();
    tokio::time::timeout(std::time::Duration::from_secs(1), dispatch)
        .await
        .expect("ordinary dispatch must resume after preparation releases the Account fence")
        .unwrap();
    for _ in 0..100 {
        if runtime
            .replica()
            .snapshot(&account_id)
            .unwrap()
            .attachment_move_preparations[0]
            .scheduling
            .attempt_count
            == 8
        {
            break;
        }
        tokio::task::yield_now().await;
    }
    let after = runtime.replica().snapshot(&account_id).unwrap();
    assert_eq!(after.attachment_move_preparations.len(), 1);
    assert_eq!(
        after.attachment_move_preparations[0]
            .scheduling
            .attempt_count,
        8
    );
    assert_eq!(
        http_executor
            .requests
            .lock()
            .unwrap()
            .iter()
            .filter(|request| request["url"]
                .as_str()
                .unwrap()
                .ends_with("/sessions/current/refresh"))
            .count(),
        1
    );
    assert!(http_executor
        .requests
        .lock()
        .unwrap()
        .iter()
        .any(|request| { request["url"].as_str().unwrap().contains("/api/v1/vaults/") }));
    runtime.close().await;
    lifecycle.await.unwrap().unwrap();
}

fn seed_promotable_preparation(
    persistence: &crate::replica::InMemoryReplica,
    account_id: AccountId,
    operation_id: &str,
    attempt_count: u64,
) {
    seed_promotable_preparation_with_file_size(
        persistence,
        account_id,
        operation_id,
        attempt_count,
        1,
    );
}

fn seed_promotable_preparation_with_file_size(
    persistence: &crate::replica::InMemoryReplica,
    account_id: AccountId,
    operation_id: &str,
    attempt_count: u64,
    file_size: i32,
) {
    use crate::replica::{
        attachment_move_artifact_ref, attachment_move_intent_fingerprint,
        AttachmentMovePreparationRecord, AttachmentMoveProgress, AttachmentMoveUploadState,
        AuthorityAttachmentRecord, AuthorityItemCategory, AuthorityItemRecord, GuardedCommitPlan,
        OperationSchedulingState, PlanMutation, PreparedMoveAttachment, ReplicaItemRecord,
        Sha256Fingerprint,
    };
    use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
    use bittery_crypto_core::{encrypt_with_aad, AadContext};
    use sha2::Digest;
    const USER: &str = "user-scheduler";
    const UPLOADER: &str = "user-uploader";
    const SOURCE_ENVELOPE_VERSION: i32 = 4;
    const ITEM: &str = "item-scheduler";
    const ATTACHMENT: &str = "attachment-scheduler";
    const SOURCE: &str = "vault-source";
    const TARGET: &str = "vault-target";
    persistence
        .install(
            account_id.clone(),
            USER.into(),
            crate::protocol::Incarnation::from(format!("incarnation-{}", account_id.as_str())),
        )
        .unwrap();
    let attachment_key = [19u8; 32];
    let source_scope = |entity_type: &str, version: u64| AadContext {
        vault_id: SOURCE.into(),
        entity_id: ATTACHMENT.into(),
        entity_type: entity_type.into(),
        version,
        user_id: UPLOADER.into(),
    };
    let wrapped_key = encrypt_with_aad(
        &BASE64.encode(attachment_key),
        &crate::test_fixtures::TEST_VAULT_KEY,
        &source_scope("attachment_key", SOURCE_ENVELOPE_VERSION as u64),
    )
    .unwrap();
    let encrypted_name = encrypt_with_aad(
        "scheduler-name",
        &attachment_key,
        &source_scope("attachment_name", 1),
    )
    .unwrap();
    let encrypted_type = encrypt_with_aad(
        "application/octet-stream",
        &attachment_key,
        &source_scope("attachment_content_type", 1),
    )
    .unwrap();
    let source = AuthorityAttachmentRecord {
        id: ATTACHMENT.into(),
        item_id: ITEM.into(),
        vault_id: SOURCE.into(),
        storage_key: "source-object".into(),
        encrypted_name: encrypted_name.ciphertext,
        encryption_iv: encrypted_name.iv,
        encryption_algorithm: encrypted_name.algorithm,
        encrypted_attachment_key: wrapped_key.ciphertext,
        attachment_key_iv: wrapped_key.iv,
        attachment_key_algorithm: wrapped_key.algorithm,
        encrypted_content_type: encrypted_type.ciphertext,
        encrypted_content_type_iv: encrypted_type.iv,
        envelope_version: SOURCE_ENVELOPE_VERSION,
        file_size,
        uploaded_by: UPLOADER.into(),
        created_at: "2026-08-26T00:00:00Z".into(),
    };
    persistence
        .seed_ready_authority(
            &account_id,
            vec![
                crate::test_fixtures::personal_vault(SOURCE, USER),
                crate::test_fixtures::personal_vault(TARGET, USER),
            ],
            vec![AuthorityItemRecord {
                id: ITEM.into(),
                vault_id: SOURCE.into(),
                category: AuthorityItemCategory::Login,
                favorite: false,
                encrypted_data: "source-item".into(),
                encryption_iv: "source-item-iv".into(),
                encryption_algorithm: "AES-GCM-AAD-V1".into(),
                version: 1,
                encryption_version: 1,
                encrypted_by_user_id: USER.into(),
                last_modified_by: USER.into(),
                created_at: "2026-08-26T00:00:00Z".into(),
                updated_at: "2026-08-26T00:00:00Z".into(),
                deleted_at: None,
                attachments: vec![source.clone()],
            }],
        )
        .unwrap();
    let artifact_digest = format!("{:x}", sha2::Sha256::digest([42u8]));
    let owner =
        attachment_move_artifact_ref(&account_id, operation_id, ATTACHMENT, &artifact_digest, 1)
            .unwrap();
    let mut preparation = AttachmentMovePreparationRecord {
        account_id: account_id.clone(),
        operation_id: operation_id.into(),
        item_id: ITEM.into(),
        source_vault_id: SOURCE.into(),
        target_vault_id: TARGET.into(),
        expected_item_version: 1,
        target_encrypted_data: "target-item".into(),
        target_encryption_algorithm: "AES-GCM-AAD-V1".into(),
        target_encryption_iv: "target-item-iv".into(),
        source_attachments: vec![source],
        progress: vec![AttachmentMoveProgress::Encrypted {
            attachment_id: ATTACHMENT.into(),
            expected_envelope_version: SOURCE_ENVELOPE_VERSION,
            artifact: owner,
            payload: Box::new(PreparedMoveAttachment {
                encrypted_name: "target-name".into(),
                encryption_iv: "target-name-iv".into(),
                encryption_algorithm: "AES-GCM-AAD-V1".into(),
                encrypted_attachment_key: "target-key".into(),
                attachment_key_iv: "target-key-iv".into(),
                attachment_key_algorithm: "AES-GCM-AAD-V1".into(),
                encrypted_content_type: "target-type".into(),
                encrypted_content_type_iv: "target-type-iv".into(),
            }),
            upload: AttachmentMoveUploadState::Uploaded,
        }],
        intent_fingerprint: Sha256Fingerprint([0; 32]),
        scheduling: OperationSchedulingState {
            attempt_count,
            not_before_ms: 0,
        },
    };
    preparation.intent_fingerprint = attachment_move_intent_fingerprint(&preparation).unwrap();
    let snapshot = persistence.snapshot(&account_id).unwrap();
    persistence
        .execute(GuardedCommitPlan::new(
            account_id.clone(),
            snapshot.incarnation,
            snapshot.revision,
            snapshot.lock_epoch,
            vec![
                PlanMutation::AcceptAttachmentMovePreparation(preparation),
                PlanMutation::PutOptimisticItem(ReplicaItemRecord {
                    account_id,
                    item_id: ITEM.into(),
                    vault_id: TARGET.into(),
                    operation_id: operation_id.into(),
                    category: AuthorityItemCategory::Login,
                    encrypted_data: "target-item".into(),
                    encryption_iv: "target-item-iv".into(),
                    encryption_algorithm: "AES-GCM-AAD-V1".into(),
                    encryption_version: 1,
                    encrypted_by_user_id: USER.into(),
                    favorite: false,
                    version: 1,
                    created_at: "2026-08-26T00:00:00Z".into(),
                    updated_at: "2026-08-26T00:00:00Z".into(),
                    deleted_at: None,
                    attachments: Vec::new(),
                    permanently_deleted: false,
                }),
            ],
        ))
        .unwrap();
}

struct FailingClock;

impl super::Clock for FailingClock {
    fn now_ms(&self) -> Result<u64, RuntimeError> {
        Err(crate::RuntimeError::new(
            crate::RuntimeErrorCode::InvariantViolation,
            "injected clock failure",
        ))
    }
}

struct NeverTimer;

#[async_trait]
impl crate::device_timer::DeviceTimer for NeverTimer {
    async fn sleep_ms(&self, _milliseconds: u64) {
        std::future::pending().await
    }
}

struct HeldDriver {
    calls: AtomicUsize,
    entered: tokio::sync::Notify,
    release: tokio::sync::Notify,
}

struct ScriptedDriver {
    results: std::sync::Mutex<Vec<PreparationDriveResult>>,
    accounts: std::sync::Mutex<Vec<AccountId>>,
}

struct PromotingDriver {
    replica: std::sync::Mutex<Option<Arc<crate::replica::Replica>>>,
    calls: AtomicUsize,
    promoted: tokio::sync::Notify,
}

#[async_trait]
impl AttachmentMovePreparationDriver for PromotingDriver {
    async fn drive(
        &self,
        request: PreparationDriveRequest,
    ) -> Result<PreparationDriveResult, RuntimeError> {
        use crate::replica::{GuardedCommitPlan, PlanMutation, PlanResult};
        let PreparationDriveRequest::Advance {
            account_id,
            operation_id,
            ..
        } = request
        else {
            panic!("the scheduler never owns outcome reactivation")
        };
        self.calls.fetch_add(1, Ordering::SeqCst);
        let replica = self.replica.lock().unwrap().clone().unwrap();
        let snapshot = replica.snapshot(&account_id).unwrap();
        let preparation = snapshot
            .attachment_move_preparations
            .iter()
            .find(|preparation| preparation.operation_id == operation_id)
            .unwrap();
        let result = replica
            .execute(GuardedCommitPlan::new(
                account_id,
                snapshot.incarnation,
                snapshot.revision,
                snapshot.lock_epoch,
                vec![PlanMutation::PromoteAttachmentMovePreparation {
                    operation_id,
                    expected_intent_fingerprint: preparation.intent_fingerprint,
                }],
            ))
            .await?;
        assert!(matches!(result, PlanResult::Applied { .. }));
        self.promoted.notify_one();
        Ok(PreparationDriveResult::ReadyForDispatch)
    }
}

#[async_trait]
impl AttachmentMovePreparationDriver for ScriptedDriver {
    async fn drive(
        &self,
        request: PreparationDriveRequest,
    ) -> Result<PreparationDriveResult, RuntimeError> {
        let PreparationDriveRequest::Advance { account_id, .. } = request else {
            panic!("the scheduler never owns outcome reactivation")
        };
        self.accounts.lock().unwrap().push(account_id);
        Ok(self.results.lock().unwrap().remove(0))
    }
}

#[async_trait]
impl AttachmentMovePreparationDriver for HeldDriver {
    async fn drive(
        &self,
        _request: PreparationDriveRequest,
    ) -> Result<PreparationDriveResult, RuntimeError> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        self.entered.notify_one();
        self.release.notified().await;
        Ok(PreparationDriveResult::Progressed)
    }
}

#[tokio::test]
async fn one_scheduler_writer_owns_each_explicit_account() {
    let driver = Arc::new(HeldDriver {
        calls: AtomicUsize::new(0),
        entered: tokio::sync::Notify::new(),
        release: tokio::sync::Notify::new(),
    });
    let scheduler = Arc::new(AttachmentMovePreparationScheduler::new_for_test(
        driver.clone(),
    ));
    let account_id = AccountId::from("account-scheduler");

    let first = tokio::spawn({
        let scheduler = scheduler.clone();
        let account_id = account_id.clone();
        async move {
            scheduler
                .drive_one(account_id, "operation-a".into(), 0)
                .await
        }
    });
    driver.entered.notified().await;
    let second = scheduler
        .drive_one(account_id, "operation-b".into(), 0)
        .await;

    assert_eq!(second.unwrap(), SchedulerDriveResult::WriterAlreadyActive);
    assert_eq!(driver.calls.load(Ordering::SeqCst), 1);
    driver.release.notify_one();
    assert_eq!(
        first.await.unwrap().unwrap(),
        SchedulerDriveResult::Progressed
    );
}

#[tokio::test]
async fn restart_and_unlock_resume_every_due_preparation_without_a_retry_ceiling() {
    let account_id = AccountId::from("account-resume");
    let foreign_account_id = AccountId::from("account-foreign");
    let driver = Arc::new(ScriptedDriver {
        results: std::sync::Mutex::new(
            (1..=7)
                .map(|attempt| PreparationDriveResult::BackingOff {
                    not_before_ms: attempt * 1_000,
                })
                .chain([PreparationDriveResult::ReadyForDispatch])
                .collect(),
        ),
        accounts: std::sync::Mutex::new(Vec::new()),
    });
    let candidates = |not_before_ms| {
        vec![
            PreparationCandidate {
                account_id: account_id.clone(),
                operation_id: "operation-resume".into(),
                not_before_ms,
            },
            PreparationCandidate {
                account_id: foreign_account_id.clone(),
                operation_id: "operation-foreign".into(),
                not_before_ms: 0,
            },
        ]
    };

    let scheduler = AttachmentMovePreparationScheduler::new_for_test(driver.clone());
    assert_eq!(
        scheduler
            .drive_eligible(candidates(0), &HashSet::new(), 0)
            .await
            .unwrap(),
        SchedulerPass::Parked
    );
    assert!(driver.accounts.lock().unwrap().is_empty());

    let unlocked = HashSet::from([account_id.clone()]);
    for attempt in 1..=7 {
        // A new scheduler models a process restart. The deadline comes from the durable candidate,
        // not from scheduler memory.
        let scheduler = AttachmentMovePreparationScheduler::new_for_test(driver.clone());
        assert_eq!(
            scheduler
                .drive_eligible(
                    candidates((attempt - 1) * 1_000),
                    &unlocked,
                    (attempt - 1) * 1_000
                )
                .await
                .unwrap(),
            SchedulerPass::Progressed
        );
    }
    let scheduler = AttachmentMovePreparationScheduler::new_for_test(driver.clone());
    assert_eq!(
        scheduler
            .drive_eligible(candidates(7_000), &unlocked, 7_000)
            .await
            .unwrap(),
        SchedulerPass::DispatchReady
    );
    assert_eq!(
        driver.accounts.lock().unwrap().as_slice(),
        vec![account_id; 8]
    );
}

#[tokio::test]
async fn lifecycle_future_propagates_clock_failure() {
    let persistence = Arc::new(crate::replica::InMemoryReplica::default());
    let runtime = super::Runtime::with_test_preparation_environment(
        persistence.clone(),
        Arc::new(ScriptedDriver {
            results: std::sync::Mutex::new(Vec::new()),
            accounts: std::sync::Mutex::new(Vec::new()),
        }),
        Arc::new(FailingClock),
        Arc::new(NeverTimer),
    );

    let error = tokio::time::timeout(
        std::time::Duration::from_millis(50),
        runtime.clone().run_attachment_move_preparation(),
    )
    .await
    .expect("clock failure must terminate the lifecycle future")
    .unwrap_err();
    assert_eq!(error.message, "injected clock failure");
    let restarted = runtime.run_attachment_move_preparation().await.unwrap_err();
    assert_eq!(restarted.message, "injected clock failure");
}

#[tokio::test]
async fn only_one_runtime_preparation_lifecycle_runner_can_scan_work() {
    let persistence = Arc::new(crate::replica::InMemoryReplica::default());
    let account_id = AccountId::from("account-single-lifecycle");
    seed_promotable_preparation(
        &persistence,
        account_id.clone(),
        "operation-single-lifecycle",
        0,
    );
    let driver = Arc::new(HeldDriver {
        calls: AtomicUsize::new(0),
        entered: tokio::sync::Notify::new(),
        release: tokio::sync::Notify::new(),
    });
    let runtime = super::Runtime::with_test_preparation_environment(
        persistence,
        driver.clone(),
        Arc::new(crate::authentication_installation::FixedClock(0)),
        Arc::new(NeverTimer),
    );
    runtime.replica().load(&account_id).await.unwrap();
    runtime.seed_unlocked_preparation_account(&account_id);
    let first = tokio::spawn(runtime.clone().run_attachment_move_preparation());
    driver.entered.notified().await;

    let second = tokio::time::timeout(
        std::time::Duration::from_millis(50),
        runtime.clone().run_attachment_move_preparation(),
    )
    .await
    .expect("a second lifecycle runner must reject before waiting on Account work")
    .unwrap_err();
    assert_eq!(
        second.message,
        "Attachment Move preparation lifecycle is already running"
    );
    assert_eq!(driver.calls.load(Ordering::SeqCst), 1);

    let closing = tokio::spawn({
        let runtime = runtime.clone();
        async move { runtime.close().await }
    });
    driver.release.notify_one();
    closing.await.unwrap();
    first.await.unwrap().unwrap();
    assert_eq!(driver.calls.load(Ordering::SeqCst), 1);
    assert!(!runtime
        .attachment_move_lifecycle_active
        .load(Ordering::SeqCst));
}

#[tokio::test]
async fn core_runtime_owns_attachment_keys_and_target_metadata() {
    use super::attachment_move_preparation::AttachmentMoveSecretProvider;
    use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
    use bittery_crypto_core::{decrypt_with_aad, AadContext};

    let persistence = Arc::new(crate::replica::InMemoryReplica::default());
    let account_id = AccountId::from("account-secrets");
    seed_promotable_preparation(&persistence, account_id.clone(), "operation-secrets", 0);
    let replica = Arc::new(crate::replica::Replica::new(persistence));
    replica.load(&account_id).await.unwrap();
    let snapshot = replica.snapshot(&account_id).unwrap();
    let live_keys = Arc::new(std::sync::Mutex::new(std::collections::HashMap::from([(
        (account_id.clone(), snapshot.incarnation.clone()),
        super::LiveMasterUnlockKey::new(zeroize::Zeroizing::new(
            crate::test_fixtures::TEST_MASTER_UNLOCK_KEY,
        )),
    )])));
    let provider = RuntimeAttachmentMoveSecrets::new(replica, live_keys);
    let preparation = &snapshot.attachment_move_preparations[0];
    let source = &preparation.source_attachments[0];

    let material = provider.resolve(preparation, source).unwrap();
    assert_eq!(*material.source_key, [19u8; 32]);
    assert_eq!(*material.target_key, [19u8; 32]);
    let sealed_name = bittery_crypto_core::EncryptedData {
        ciphertext: material.prepared_metadata.encrypted_name.clone(),
        iv: material.prepared_metadata.encryption_iv.clone(),
        algorithm: material.prepared_metadata.encryption_algorithm.clone(),
    };
    let opened_name = decrypt_with_aad(
        &sealed_name,
        &material.target_key[..],
        &AadContext {
            vault_id: "vault-target".into(),
            entity_id: "attachment-scheduler".into(),
            entity_type: "attachment_name".into(),
            version: 1,
            user_id: "user-uploader".into(),
        },
    )
    .unwrap();
    assert_eq!(opened_name, "scheduler-name");
    let wrapped: bittery_crypto_core::EncryptedData = bittery_crypto_core::EncryptedData {
        ciphertext: material.prepared_metadata.encrypted_attachment_key.clone(),
        iv: material.prepared_metadata.attachment_key_iv.clone(),
        algorithm: material.prepared_metadata.attachment_key_algorithm.clone(),
    };
    let opened_key = decrypt_with_aad(
        &wrapped,
        &crate::test_fixtures::TEST_VAULT_KEY,
        &AadContext {
            vault_id: "vault-target".into(),
            entity_id: "attachment-scheduler".into(),
            entity_type: "attachment_key".into(),
            version: 5,
            user_id: "user-uploader".into(),
        },
    )
    .unwrap();
    assert_eq!(BASE64.decode(opened_key).unwrap(), [19u8; 32]);
    assert!(decrypt_with_aad(
        &sealed_name,
        &material.target_key[..],
        &AadContext {
            vault_id: "vault-target".into(),
            entity_id: "attachment-scheduler".into(),
            entity_type: "attachment_name".into(),
            version: 1,
            user_id: "user-scheduler".into(),
        },
    )
    .is_err());
    for (user_id, version) in [("user-scheduler", 5), ("user-uploader", 4)] {
        assert!(decrypt_with_aad(
            &wrapped,
            &crate::test_fixtures::TEST_VAULT_KEY,
            &AadContext {
                vault_id: "vault-target".into(),
                entity_id: "attachment-scheduler".into(),
                entity_type: "attachment_key".into(),
                version,
                user_id: user_id.into(),
            },
        )
        .is_err());
    }
    let mut overflow_preparation = preparation.clone();
    overflow_preparation.source_attachments[0].envelope_version = i32::MAX;
    let overflow_source = overflow_preparation.source_attachments[0].clone();
    let overflow = match provider.resolve(&overflow_preparation, &overflow_source) {
        Ok(_) => panic!("overflowed target envelope version must be rejected"),
        Err(error) => error,
    };
    assert_eq!(
        overflow.message,
        "Attachment Move target envelope version overflowed"
    );
}

#[tokio::test]
async fn lock_and_close_wait_for_the_explicit_account_preparation_writer() {
    let persistence = Arc::new(crate::replica::InMemoryReplica::default());
    let account_id = AccountId::from("account-retirement");
    seed_promotable_preparation(&persistence, account_id.clone(), "operation-retirement", 0);
    let driver = Arc::new(HeldDriver {
        calls: AtomicUsize::new(0),
        entered: tokio::sync::Notify::new(),
        release: tokio::sync::Notify::new(),
    });
    let runtime = super::Runtime::with_test_preparation_environment(
        persistence,
        driver.clone(),
        Arc::new(crate::authentication_installation::FixedClock(0)),
        Arc::new(NeverTimer),
    );
    runtime.replica().load(&account_id).await.unwrap();
    runtime.seed_unlocked_preparation_account(&account_id);
    let lifecycle = tokio::spawn(runtime.clone().run_attachment_move_preparation());
    driver.entered.notified().await;

    let retirement = tokio::spawn({
        let runtime = runtime.clone();
        let account_id = account_id.clone();
        async move {
            runtime
                .request(
                    crate::RuntimeRequest::Lock { account_id },
                    crate::RequestCancellation::new(),
                )
                .await
        }
    });
    while !runtime.account_access_retirement_is_pending(&account_id) {
        tokio::task::yield_now().await;
    }
    assert!(!retirement.is_finished());
    driver.release.notify_one();
    retirement.await.unwrap().unwrap();
    assert_eq!(driver.calls.load(Ordering::SeqCst), 1);

    runtime.seed_unlocked_preparation_account(&account_id);
    driver.entered.notified().await;
    let closing = tokio::spawn({
        let runtime = runtime.clone();
        async move { runtime.close().await }
    });
    tokio::task::yield_now().await;
    assert!(!closing.is_finished());
    driver.release.notify_one();
    closing.await.unwrap();
    assert_eq!(driver.calls.load(Ordering::SeqCst), 2);
    lifecycle.await.unwrap().unwrap();
}

#[tokio::test]
async fn durable_restart_and_unlock_promote_before_dispatch_without_attempt_discard() {
    let persistence = Arc::new(crate::replica::InMemoryReplica::default());
    let account_id = AccountId::from("account-lifecycle");
    seed_promotable_preparation(&persistence, account_id.clone(), "operation-lifecycle", 7);
    let driver = Arc::new(PromotingDriver {
        replica: std::sync::Mutex::new(None),
        calls: AtomicUsize::new(0),
        promoted: tokio::sync::Notify::new(),
    });
    let runtime = super::Runtime::with_test_preparation_environment(
        persistence.clone(),
        driver.clone(),
        Arc::new(crate::authentication_installation::FixedClock(0)),
        Arc::new(NeverTimer),
    );
    runtime.replica().load(&account_id).await.unwrap();
    *driver.replica.lock().unwrap() = Some(runtime.replica());
    let before = runtime.replica().snapshot(&account_id).unwrap();
    assert_eq!(
        before.attachment_move_preparations[0]
            .scheduling
            .attempt_count,
        7
    );
    assert!(before.operations.is_empty());
    let lifecycle = tokio::spawn(runtime.clone().run_attachment_move_preparation());
    tokio::task::yield_now().await;
    assert_eq!(driver.calls.load(Ordering::SeqCst), 0);
    runtime.close().await;
    lifecycle.await.unwrap().unwrap();
    let still_pending = persistence.snapshot(&account_id).unwrap();
    assert_eq!(still_pending.attachment_move_preparations.len(), 1);
    assert_eq!(
        still_pending.attachment_move_preparations[0]
            .scheduling
            .attempt_count,
        7
    );
    assert!(still_pending.operations.is_empty());

    let restored_driver = Arc::new(PromotingDriver {
        replica: std::sync::Mutex::new(None),
        calls: AtomicUsize::new(0),
        promoted: tokio::sync::Notify::new(),
    });
    let restored = super::Runtime::with_test_preparation_environment(
        persistence.clone(),
        restored_driver.clone(),
        Arc::new(crate::authentication_installation::FixedClock(0)),
        Arc::new(NeverTimer),
    );
    restored.replica().load(&account_id).await.unwrap();
    *restored_driver.replica.lock().unwrap() = Some(restored.replica());
    let restored_lifecycle = tokio::spawn(restored.clone().run_attachment_move_preparation());
    tokio::task::yield_now().await;
    assert_eq!(restored_driver.calls.load(Ordering::SeqCst), 0);
    restored.seed_unlocked_preparation_account(&account_id);
    restored_driver.promoted.notified().await;
    let promoted_after_restart = restored.replica().snapshot(&account_id).unwrap();
    assert!(promoted_after_restart
        .attachment_move_preparations
        .is_empty());
    assert_eq!(promoted_after_restart.operations.len(), 1);
    restored.close().await;
    restored_lifecycle.await.unwrap().unwrap();

    let final_driver = Arc::new(PromotingDriver {
        replica: std::sync::Mutex::new(None),
        calls: AtomicUsize::new(0),
        promoted: tokio::sync::Notify::new(),
    });
    let final_runtime = super::Runtime::with_test_preparation_environment(
        persistence,
        final_driver.clone(),
        Arc::new(crate::authentication_installation::FixedClock(0)),
        Arc::new(NeverTimer),
    );
    final_runtime.replica().load(&account_id).await.unwrap();
    *final_driver.replica.lock().unwrap() = Some(final_runtime.replica());
    final_runtime.seed_unlocked_preparation_account(&account_id);
    let final_lifecycle = tokio::spawn(final_runtime.clone().run_attachment_move_preparation());
    tokio::task::yield_now().await;
    assert_eq!(final_driver.calls.load(Ordering::SeqCst), 0);
    let after_final_restart = final_runtime.replica().snapshot(&account_id).unwrap();
    assert!(after_final_restart.attachment_move_preparations.is_empty());
    assert_eq!(after_final_restart.operations.len(), 1);
    final_runtime.close().await;
    final_lifecycle.await.unwrap().unwrap();
}
