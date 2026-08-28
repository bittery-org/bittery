use super::operation_fixtures::*;
use super::*;
use crate::{
    attachment_artifact_store::{
        AttachmentArtifactStore, AttachmentArtifactStoreRequest, AttachmentArtifactStoreResponse,
    },
    http_transport::SerializedHttpExecutor,
    protocol::Incarnation,
    replica::{
        AuthorityAttachmentRecord, AuthorityItemCategory, AuthorityItemRecord, GuardedCommitPlan,
        InMemoryReplica, PlanMutation, PlanResult, Replica, SerializedReplicaPersistence,
    },
    server_contract::{UpdateAttachmentBody, VaultAttachmentResponse},
    test_fixtures::{personal_vault, TEST_VAULT_ID, TEST_VAULT_KEY},
    CreateShareDraft, ShareAccessMode, ShareExpiration,
};
use async_trait::async_trait;
use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use bittery_crypto_core::{encrypt_with_aad, AadContext};
use serde_json::{json, Value};
use std::sync::atomic::{AtomicBool, AtomicUsize};
use tokio::sync::Semaphore;

struct SuccessfulAttachmentTeardown;

#[async_trait]
impl AttachmentArtifactStore for SuccessfulAttachmentTeardown {
    async fn invoke(
        &self,
        request: AttachmentArtifactStoreRequest,
    ) -> Result<AttachmentArtifactStoreResponse, RuntimeError> {
        match request {
            AttachmentArtifactStoreRequest::DeleteAccount { .. } => {
                Ok(AttachmentArtifactStoreResponse::AccountDeleted)
            }
            AttachmentArtifactStoreRequest::WipeDevice => {
                Ok(AttachmentArtifactStoreResponse::DeviceWiped)
            }
            _ => panic!("Attachment Rename teardown fixture received non-destructive work"),
        }
    }
}

struct SuccessfulHostTeardown;

#[async_trait]
impl TeardownHostCleanup for SuccessfulHostTeardown {
    async fn invoke(
        &self,
        request: TeardownHostCleanupRequest,
    ) -> Result<TeardownHostCleanupResponse, RuntimeError> {
        Ok(match request {
            TeardownHostCleanupRequest::DeleteAccount { .. } => {
                TeardownHostCleanupResponse::AccountDeleted
            }
            TeardownHostCleanupRequest::WipeDevice => TeardownHostCleanupResponse::DeviceWiped,
        })
    }
}

#[derive(Default)]
struct AttachmentSink(Mutex<Vec<RuntimeProjection>>);

impl ObservationSink for AttachmentSink {
    fn publish(&self, projection: RuntimeProjection) {
        self.0.lock().unwrap().push(projection);
    }
}

struct ReentrantAttachmentSink {
    publications: Mutex<Vec<RuntimeProjection>>,
    callback: Mutex<Option<Box<dyn FnOnce() + Send>>>,
}

impl ObservationSink for ReentrantAttachmentSink {
    fn publish(&self, projection: RuntimeProjection) {
        self.publications.lock().unwrap().push(projection);
        if let Some(callback) = self.callback.lock().unwrap().take() {
            callback();
        }
    }
}

fn create_share(account_id: &AccountId) -> RuntimeRequest {
    RuntimeRequest::CreateShare {
        account_id: account_id.clone(),
        item_id: ITEM_ID.into(),
        draft: CreateShareDraft {
            access_mode: ShareAccessMode::Anyone,
            expires_in: ShareExpiration::SevenDays,
            is_one_time_use: false,
            allowed_emails: Vec::new(),
        },
    }
}

#[test]
fn rename_attachment_request_carries_only_account_attachment_and_name() {
    let request = RuntimeRequest::RenameAttachment {
        account_id: AccountId::from("account-1"),
        attachment_id: "attachment-1".into(),
        name: "renamed.txt".into(),
    };

    assert_eq!(
        serde_json::to_value(request).expect("Rename request should serialize"),
        serde_json::json!({
            "type": "renameAttachment",
            "accountId": "account-1",
            "attachmentId": "attachment-1",
            "name": "renamed.txt",
        })
    );
    assert_eq!(
        serde_json::to_value(RuntimeResponse::AttachmentRenamed {
            account_id: AccountId::from("account-1"),
            attachment_id: "attachment-1".into(),
        })
        .expect("Rename result should serialize"),
        serde_json::json!({
            "type": "attachmentRenamed",
            "accountId": "account-1",
            "attachmentId": "attachment-1",
        })
    );
}

const ATTACHMENT_ID: &str = "attachment-1";
const ITEM_ID: &str = "item-existing";

struct AttachmentServer {
    requests: Mutex<Vec<RecordedRequest>>,
    item: StoredItem,
    attachment: Mutex<VaultAttachmentResponse>,
    lose_next_patch_response: AtomicBool,
    discard_next_patch: AtomicBool,
    unauthorized_patches: AtomicUsize,
    patch_calls: AtomicUsize,
    refresh_calls: AtomicUsize,
    refresh_mode: AtomicUsize,
    refresh_release: Semaphore,
    hold_patch: AtomicBool,
    patch_release: Semaphore,
    hold_attachment_get: AtomicBool,
    attachment_get_calls: AtomicUsize,
    attachment_get_release: Semaphore,
    item_get_failure: AtomicUsize,
    attachment_get_failure: AtomicUsize,
    attachment_page_mode: AtomicUsize,
    key_authority_drift_after_patch: AtomicUsize,
    address_authority_drift_after_patch: AtomicUsize,
    cancel_calls: AtomicUsize,
}

impl AttachmentServer {
    fn patches(&self) -> Vec<RecordedRequest> {
        self.requests
            .lock()
            .unwrap()
            .iter()
            .filter(|request| request.method == "PATCH")
            .cloned()
            .collect()
    }
}

#[async_trait]
impl SerializedHttpExecutor for AttachmentServer {
    async fn invoke(&self, request_json: String) -> Result<String, RuntimeError> {
        let value: Value = serde_json::from_str(&request_json).unwrap();
        let request = RecordedRequest {
            method: value["method"].as_str().unwrap().to_owned(),
            url: value["url"].as_str().unwrap().to_owned(),
            headers: value["headers"]
                .as_array()
                .unwrap()
                .iter()
                .map(|header| {
                    (
                        header["name"].as_str().unwrap().to_owned(),
                        header["value"].as_str().unwrap().to_owned(),
                    )
                })
                .collect(),
            body: value["body"]
                .as_array()
                .unwrap()
                .iter()
                .map(|byte| byte.as_u64().unwrap() as u8)
                .collect(),
        };
        self.requests.lock().unwrap().push(request.clone());
        let response = if request.url.ends_with("/api/v1/sessions/current/refresh") {
            self.refresh_calls.fetch_add(1, Ordering::SeqCst);
            match self.refresh_mode.load(Ordering::SeqCst) {
                1 => {
                    self.refresh_release.acquire().await.unwrap().forget();
                    unreachable!("a held refresh is released only to clean up a failed test")
                }
                2 => return Ok(json!({ "type": "networkFailure" }).to_string()),
                3 => completed(200, b"{".to_vec()),
                _ => completed(
                    200,
                    serde_json::to_vec(&json!({
                        "token": SECOND_TOKEN,
                        "sessionId": "session-1",
                        "expiresAt": "2099-01-01T00:00:00Z",
                    }))
                    .unwrap(),
                ),
            }
        } else if request.method == "PATCH" {
            self.patch_calls.fetch_add(1, Ordering::SeqCst);
            if self
                .unauthorized_patches
                .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |remaining| {
                    remaining.checked_sub(1)
                })
                .is_ok()
            {
                return Ok(completed(401, b"{}".to_vec()).to_string());
            }
            if self.hold_patch.load(Ordering::SeqCst) {
                self.patch_release.acquire().await.unwrap().forget();
            }
            let body: UpdateAttachmentBody = serde_json::from_slice(&request.body).unwrap();
            if !self.discard_next_patch.swap(false, Ordering::SeqCst) {
                let mut attachment = self.attachment.lock().unwrap();
                attachment.encrypted_name = body.encrypted_name;
                attachment.encryption_iv = body.encryption_iv;
                attachment.encryption_algorithm = body.encryption_algorithm;
                match self
                    .key_authority_drift_after_patch
                    .swap(0, Ordering::SeqCst)
                {
                    1 => attachment.envelope_version += 1,
                    2 => attachment.encrypted_attachment_key = BASE64.encode([7u8; 60]),
                    3 => attachment.attachment_key_iv = BASE64.encode([8u8; 12]),
                    4 => attachment.attachment_key_algorithm = "AES-GCM-AAD-V2".into(),
                    _ => {}
                }
                match self
                    .address_authority_drift_after_patch
                    .swap(0, Ordering::SeqCst)
                {
                    1 => attachment.uploaded_by = "different-uploader".into(),
                    2 => attachment.id = "replacement-attachment".into(),
                    3 => attachment.item_id = "replacement-item".into(),
                    4 => attachment.vault_id = "replacement-vault".into(),
                    _ => {}
                }
            }
            if self.lose_next_patch_response.swap(false, Ordering::SeqCst) {
                json!({ "type": "networkFailure" })
            } else {
                completed(200, br#"{"success":true}"#.to_vec())
            }
        } else if request.method == "GET"
            && request
                .url
                .contains(&format!("/api/v1/items/{ITEM_ID}/attachments"))
        {
            self.attachment_get_calls.fetch_add(1, Ordering::SeqCst);
            let attachment_failure = self.attachment_get_failure.swap(0, Ordering::SeqCst);
            match attachment_failure {
                1 => return Ok(json!({ "type": "networkFailure" }).to_string()),
                2 => return Ok(json!({ "type": "responseTooLarge" }).to_string()),
                3 => return Ok(completed(200, b"{".to_vec()).to_string()),
                4 | 5 => {
                    let mut attachment = self.attachment.lock().unwrap().clone();
                    if attachment_failure == 4 {
                        attachment.id = "foreign-attachment".into();
                        attachment.item_id = "foreign-item".into();
                    } else {
                        attachment.id = "foreign-attachment".into();
                        attachment.vault_id = "foreign-vault".into();
                    }
                    return Ok(completed(
                        200,
                        serde_json::to_vec(&json!({
                            "items": [attachment],
                            "hasMore": false,
                            "nextCursor": null,
                        }))
                        .unwrap(),
                    )
                    .to_string());
                }
                _ => {}
            }
            if self.hold_attachment_get.load(Ordering::SeqCst) {
                self.attachment_get_release
                    .acquire()
                    .await
                    .unwrap()
                    .forget();
            }
            attachment_page_response(self, &request.url)
        } else if request.method == "GET"
            && request.url.ends_with(&format!("/api/v1/items/{ITEM_ID}"))
        {
            match self.item_get_failure.swap(0, Ordering::SeqCst) {
                1 => return Ok(json!({ "type": "networkFailure" }).to_string()),
                2 => return Ok(json!({ "type": "responseTooLarge" }).to_string()),
                3 => return Ok(completed(200, b"{".to_vec()).to_string()),
                4 => {
                    let mut foreign = self.item.clone();
                    foreign.id = "foreign-item".into();
                    return Ok(completed(200, item_body(&foreign)).to_string());
                }
                _ => {}
            }
            completed(200, item_body(&self.item))
        } else {
            panic!(
                "unexpected Attachment test request {} {}",
                request.method, request.url
            );
        };
        Ok(response.to_string())
    }

    fn cancel(&self, _dispatch_id: &str) {
        self.cancel_calls.fetch_add(1, Ordering::SeqCst);
    }
}

struct AttachmentHarness {
    runtime: Arc<Runtime>,
    account_id: AccountId,
    server: Arc<AttachmentServer>,
    replica: Arc<PlainReplica>,
}

async fn seeded_attachment() -> AttachmentHarness {
    let account_id = AccountId::from(ACCOUNT);
    let state = InMemoryReplica::default();
    state
        .install(
            account_id.clone(),
            USER.to_owned(),
            Incarnation::from(INCARNATION),
        )
        .unwrap();
    let item_ciphertext = encrypt_with_aad(
        &serde_json::to_string(&draft()).unwrap(),
        &TEST_VAULT_KEY,
        &AadContext {
            vault_id: TEST_VAULT_ID.into(),
            entity_id: ITEM_ID.into(),
            entity_type: "item".into(),
            version: 1,
            user_id: USER.into(),
        },
    )
    .unwrap();
    let attachment = attachment_authority();
    state
        .seed_ready_authority(
            &account_id,
            vec![
                personal_vault(TEST_VAULT_ID, USER),
                personal_vault("vault-2", USER),
            ],
            vec![AuthorityItemRecord {
                id: ITEM_ID.into(),
                vault_id: TEST_VAULT_ID.into(),
                category: AuthorityItemCategory::Login,
                favorite: false,
                encrypted_data: item_ciphertext.ciphertext.clone(),
                encryption_iv: item_ciphertext.iv.clone(),
                encryption_algorithm: item_ciphertext.algorithm.clone(),
                version: 1,
                encryption_version: 1,
                encrypted_by_user_id: USER.into(),
                last_modified_by: USER.into(),
                created_at: "2026-08-23T00:00:00Z".into(),
                updated_at: "2026-08-23T00:00:00Z".into(),
                deleted_at: None,
                attachments: vec![attachment.clone()],
            }],
        )
        .unwrap();
    let server = Arc::new(AttachmentServer {
        requests: Mutex::new(Vec::new()),
        item: StoredItem {
            id: ITEM_ID.into(),
            vault_id: TEST_VAULT_ID.into(),
            encrypted_data: item_ciphertext.ciphertext,
            encryption_iv: item_ciphertext.iv,
            encryption_algorithm: item_ciphertext.algorithm,
            version: 1,
            favorite: false,
            deleted_at: None,
        },
        attachment: Mutex::new(attachment_dto(attachment)),
        lose_next_patch_response: AtomicBool::new(false),
        discard_next_patch: AtomicBool::new(false),
        unauthorized_patches: AtomicUsize::new(0),
        patch_calls: AtomicUsize::new(0),
        refresh_calls: AtomicUsize::new(0),
        refresh_mode: AtomicUsize::new(0),
        refresh_release: Semaphore::new(0),
        hold_patch: AtomicBool::new(false),
        patch_release: Semaphore::new(0),
        hold_attachment_get: AtomicBool::new(false),
        attachment_get_calls: AtomicUsize::new(0),
        attachment_get_release: Semaphore::new(0),
        item_get_failure: AtomicUsize::new(0),
        attachment_get_failure: AtomicUsize::new(0),
        attachment_page_mode: AtomicUsize::new(0),
        key_authority_drift_after_patch: AtomicUsize::new(0),
        address_authority_drift_after_patch: AtomicUsize::new(0),
        cancel_calls: AtomicUsize::new(0),
    });
    let replica = PlainReplica::new(state);
    let platform = MemoryPlatform::new();
    let clock = TestClock::new();
    let runtime = Runtime::with_test_dispatch_environment(
        replica.clone(),
        platform,
        server.clone(),
        auth_config(),
        clock.clone(),
        TestTimer::advancing(clock),
    );
    runtime.replica().load(&account_id).await.unwrap().unwrap();
    runtime.unlock_account(&account_id).await.unwrap();
    store_session(&runtime, &account_id, FIRST_TOKEN).await;
    AttachmentHarness {
        runtime,
        account_id,
        server,
        replica,
    }
}

#[tokio::test]
async fn repeated_rename_uses_exact_patch_and_preserves_readable_key_authority() {
    let harness = seeded_attachment().await;
    let original_key = harness
        .server
        .attachment
        .lock()
        .unwrap()
        .encrypted_attachment_key
        .clone();
    for name in ["first-name.txt", "second-name.txt"] {
        let response = harness
            .runtime
            .request(
                RuntimeRequest::RenameAttachment {
                    account_id: harness.account_id.clone(),
                    attachment_id: ATTACHMENT_ID.into(),
                    name: name.into(),
                },
                RequestCancellation::new(),
            )
            .await
            .unwrap();
        assert!(matches!(
            response,
            RuntimeResponse::AttachmentRenamed { .. }
        ));
        let items = harness.runtime.unlocked_items.lock().unwrap();
        assert_eq!(items[&harness.account_id][0].attachments[0].name, name);
        assert!(
            serde_json::to_value(&items[&harness.account_id][0].attachments[0])
                .unwrap()
                .get("storageKey")
                .is_none()
        );
    }
    let patches = harness.server.patches();
    assert_eq!(patches.len(), 2);
    for patch in patches {
        assert_eq!(
            patch.url,
            format!("{SERVER_URL}/api/v1/attachments/{ATTACHMENT_ID}")
        );
        assert_eq!(
            patch.header("content-type"),
            Some("application/merge-patch+json")
        );
        assert_eq!(
            patch.header("authorization"),
            Some("Bearer session-token-1")
        );
        let body: Value = serde_json::from_slice(&patch.body).unwrap();
        assert_eq!(body.as_object().unwrap().len(), 3);
        assert!(body.get("encryptedName").is_some());
        assert!(body.get("encryptionIv").is_some());
        assert_eq!(body["encryptionAlgorithm"], "AES-GCM-AAD-V1");
    }
    let attachment = harness.server.attachment.lock().unwrap();
    assert_eq!(attachment.envelope_version, 1);
    assert_eq!(attachment.encrypted_attachment_key, original_key);
}

#[tokio::test]
async fn successful_rename_advances_and_publishes_the_projection_once() {
    let harness = seeded_attachment().await;
    let items_sink = Arc::new(AttachmentSink::default());
    let _items_observation = harness
        .runtime
        .observe(
            ObservationRequest::Items {
                account_id: harness.account_id.clone(),
            },
            items_sink.clone(),
        )
        .unwrap();
    let status_sink = Arc::new(AttachmentSink::default());
    let _status_observation = harness
        .runtime
        .observe(
            ObservationRequest::RuntimeStatus {
                account_id: Some(harness.account_id.clone()),
            },
            status_sink.clone(),
        )
        .unwrap();
    let items_publications_before = items_sink.0.lock().unwrap().len();
    let status_publications_before = status_sink.0.lock().unwrap().len();
    let status_revision_before = match status_sink.0.lock().unwrap().last().unwrap() {
        RuntimeProjection::RuntimeStatus(status) => status.revision,
        _ => panic!("Runtime-status observation published another projection kind"),
    };

    harness
        .runtime
        .request(
            RuntimeRequest::RenameAttachment {
                account_id: harness.account_id.clone(),
                attachment_id: ATTACHMENT_ID.into(),
                name: "published-once.txt".into(),
            },
            RequestCancellation::new(),
        )
        .await
        .unwrap();

    let items_publications = items_sink.0.lock().unwrap();
    assert_eq!(items_publications.len(), items_publications_before + 1);
    let RuntimeProjection::Items(items) = items_publications.last().unwrap() else {
        panic!("Attachment observation published another projection kind");
    };
    assert_eq!(items.items[0].attachments[0].name, "published-once.txt");
    let status_publications = status_sink.0.lock().unwrap();
    assert_eq!(status_publications.len(), status_publications_before + 1);
    let RuntimeProjection::RuntimeStatus(status) = status_publications.last().unwrap() else {
        panic!("Runtime-status observation published another projection kind");
    };
    assert_eq!(status.revision, status_revision_before + 1);
}

#[tokio::test]
async fn ambiguous_rename_probes_authority_without_blind_resubmission() {
    let harness = seeded_attachment().await;
    harness
        .server
        .lose_next_patch_response
        .store(true, Ordering::SeqCst);

    harness
        .runtime
        .request(
            RuntimeRequest::RenameAttachment {
                account_id: harness.account_id.clone(),
                attachment_id: ATTACHMENT_ID.into(),
                name: "proved-after-loss.txt".into(),
            },
            RequestCancellation::new(),
        )
        .await
        .unwrap();

    assert_eq!(harness.server.patch_calls.load(Ordering::SeqCst), 1);
    assert_eq!(
        harness.runtime.unlocked_items.lock().unwrap()[&harness.account_id][0].attachments[0].name,
        "proved-after-loss.txt"
    );
}

#[tokio::test]
async fn ambiguous_rename_that_authority_does_not_prove_is_retryable_without_resubmission() {
    let harness = seeded_attachment().await;
    harness
        .server
        .lose_next_patch_response
        .store(true, Ordering::SeqCst);
    harness
        .server
        .discard_next_patch
        .store(true, Ordering::SeqCst);

    let error = harness
        .runtime
        .request(
            RuntimeRequest::RenameAttachment {
                account_id: harness.account_id.clone(),
                attachment_id: ATTACHMENT_ID.into(),
                name: "unproved-after-loss.txt".into(),
            },
            RequestCancellation::new(),
        )
        .await
        .unwrap_err();

    assert_eq!(error.code, RuntimeErrorCode::RetryableTransport);
    assert_eq!(harness.server.patch_calls.load(Ordering::SeqCst), 1);
    assert_eq!(
        harness.runtime.unlocked_items.lock().unwrap()[&harness.account_id][0].attachments[0].name,
        "original.txt"
    );
}

#[tokio::test]
async fn changed_key_envelope_authority_after_patch_is_retryable_without_replica_publication() {
    for (field, drift) in [
        ("envelope-version", 1usize),
        ("encrypted-attachment-key", 2),
        ("attachment-key-iv", 3),
        ("attachment-key-algorithm", 4),
    ] {
        let harness = seeded_attachment().await;
        let before = harness
            .runtime
            .replica()
            .snapshot(&harness.account_id)
            .unwrap();
        harness
            .server
            .key_authority_drift_after_patch
            .store(drift, Ordering::SeqCst);

        let error = harness
            .runtime
            .request(
                RuntimeRequest::RenameAttachment {
                    account_id: harness.account_id.clone(),
                    attachment_id: ATTACHMENT_ID.into(),
                    name: format!("drifted-{field}.txt"),
                },
                RequestCancellation::new(),
            )
            .await
            .unwrap_err();

        assert_eq!(error.code, RuntimeErrorCode::RetryableTransport, "{field}");
        assert_eq!(
            harness.server.patch_calls.load(Ordering::SeqCst),
            1,
            "{field}"
        );
        assert_eq!(
            harness.runtime.replica().snapshot(&harness.account_id),
            Some(before),
            "{field}"
        );
        assert_eq!(
            harness.runtime.unlocked_items.lock().unwrap()[&harness.account_id][0].attachments[0]
                .name,
            "original.txt",
            "{field}"
        );
    }
}

#[tokio::test]
async fn changed_uploader_and_attachment_address_authority_is_retryable_without_publication() {
    for (field, drift) in [
        ("uploader", 1usize),
        ("attachment-id", 2),
        ("item-id", 3),
        ("vault-id", 4),
    ] {
        let harness = seeded_attachment().await;
        let before = harness
            .runtime
            .replica()
            .snapshot(&harness.account_id)
            .unwrap();
        harness
            .server
            .address_authority_drift_after_patch
            .store(drift, Ordering::SeqCst);

        let error = harness
            .runtime
            .request(
                RuntimeRequest::RenameAttachment {
                    account_id: harness.account_id.clone(),
                    attachment_id: ATTACHMENT_ID.into(),
                    name: format!("drifted-{field}.txt"),
                },
                RequestCancellation::new(),
            )
            .await
            .unwrap_err();

        assert_eq!(error.code, RuntimeErrorCode::RetryableTransport, "{field}");
        assert_eq!(
            harness.server.patch_calls.load(Ordering::SeqCst),
            1,
            "{field}"
        );
        assert_eq!(
            harness.runtime.replica().snapshot(&harness.account_id),
            Some(before),
            "{field}"
        );
        assert_eq!(
            harness.runtime.unlocked_items.lock().unwrap()[&harness.account_id][0].attachments[0]
                .name,
            "original.txt",
            "{field}"
        );
    }
}

#[tokio::test]
async fn transient_failure_at_each_authority_probe_is_retryable_without_resend_or_publication() {
    for (stage, fault) in [
        ("item-network", 1usize),
        ("item-too-large", 2),
        ("attachment-network", 1),
        ("attachment-too-large", 2),
    ] {
        let harness = seeded_attachment().await;
        if stage.starts_with("item-") {
            harness
                .server
                .item_get_failure
                .store(fault, Ordering::SeqCst);
        } else {
            harness
                .server
                .attachment_get_failure
                .store(fault, Ordering::SeqCst);
        }

        let error = harness
            .runtime
            .request(
                RuntimeRequest::RenameAttachment {
                    account_id: harness.account_id.clone(),
                    attachment_id: ATTACHMENT_ID.into(),
                    name: format!("{stage}.txt"),
                },
                RequestCancellation::new(),
            )
            .await
            .unwrap_err();

        assert_eq!(error.code, RuntimeErrorCode::RetryableTransport, "{stage}");
        assert_eq!(
            harness.server.patch_calls.load(Ordering::SeqCst),
            1,
            "{stage}"
        );
        assert_eq!(
            harness.runtime.unlocked_items.lock().unwrap()[&harness.account_id][0].attachments[0]
                .name,
            "original.txt",
            "{stage}"
        );
    }
}

#[tokio::test]
async fn malformed_and_foreign_authority_fail_closed_without_resend_or_publication() {
    for (stage, fault) in [
        ("item-malformed", 3usize),
        ("item-foreign", 4),
        ("attachment-malformed", 3),
        ("attachment-foreign-item", 4),
        ("attachment-foreign-vault", 5),
    ] {
        let harness = seeded_attachment().await;
        if stage.starts_with("item-") {
            harness
                .server
                .item_get_failure
                .store(fault, Ordering::SeqCst);
        } else {
            harness
                .server
                .attachment_get_failure
                .store(fault, Ordering::SeqCst);
        }

        let error = harness
            .runtime
            .request(
                RuntimeRequest::RenameAttachment {
                    account_id: harness.account_id.clone(),
                    attachment_id: ATTACHMENT_ID.into(),
                    name: format!("{stage}.txt"),
                },
                RequestCancellation::new(),
            )
            .await
            .unwrap_err();

        assert_eq!(error.code, RuntimeErrorCode::InvariantViolation, "{stage}");
        assert_eq!(
            harness.server.patch_calls.load(Ordering::SeqCst),
            1,
            "{stage}"
        );
        assert_eq!(
            harness.runtime.unlocked_items.lock().unwrap()[&harness.account_id][0].attachments[0]
                .name,
            "original.txt",
            "{stage}"
        );
    }
}

#[tokio::test]
async fn unique_attachment_authority_cursors_exhaust_the_bound_without_publication() {
    let harness = seeded_attachment().await;
    harness
        .server
        .attachment_page_mode
        .store(1, Ordering::SeqCst);

    let error = harness
        .runtime
        .request(
            RuntimeRequest::RenameAttachment {
                account_id: harness.account_id.clone(),
                attachment_id: ATTACHMENT_ID.into(),
                name: "cursor-exhaustion.txt".into(),
            },
            RequestCancellation::new(),
        )
        .await
        .unwrap_err();

    assert_eq!(error.code, RuntimeErrorCode::InvariantViolation);
    assert_eq!(harness.server.patch_calls.load(Ordering::SeqCst), 1);
    assert_eq!(
        harness.runtime.unlocked_items.lock().unwrap()[&harness.account_id][0].attachments[0].name,
        "original.txt"
    );
}

#[tokio::test]
async fn oversized_attachment_authority_aggregate_fails_without_publication() {
    let harness = seeded_attachment().await;
    harness
        .server
        .attachment_page_mode
        .store(2, Ordering::SeqCst);

    let error = harness
        .runtime
        .request(
            RuntimeRequest::RenameAttachment {
                account_id: harness.account_id.clone(),
                attachment_id: ATTACHMENT_ID.into(),
                name: "aggregate-exhaustion.txt".into(),
            },
            RequestCancellation::new(),
        )
        .await
        .unwrap_err();

    assert_eq!(error.code, RuntimeErrorCode::InvariantViolation);
    assert_eq!(harness.server.patch_calls.load(Ordering::SeqCst), 1);
    assert_eq!(
        harness.server.attachment_get_calls.load(Ordering::SeqCst),
        9
    );
    assert_eq!(
        harness.runtime.unlocked_items.lock().unwrap()[&harness.account_id][0].attachments[0].name,
        "original.txt"
    );
}

#[tokio::test]
async fn rename_renews_at_most_once_and_replays_exact_bytes_only_after_unauthorized() {
    let harness = seeded_attachment().await;
    harness
        .server
        .unauthorized_patches
        .store(1, Ordering::SeqCst);

    harness
        .runtime
        .request(
            RuntimeRequest::RenameAttachment {
                account_id: harness.account_id.clone(),
                attachment_id: ATTACHMENT_ID.into(),
                name: "after-renewal.txt".into(),
            },
            RequestCancellation::new(),
        )
        .await
        .unwrap();

    let patches = harness.server.patches();
    assert_eq!(patches.len(), 2);
    assert_eq!(patches[0].body, patches[1].body);
    assert_eq!(
        patches[0].header("authorization"),
        Some("Bearer session-token-1")
    );
    assert_eq!(
        patches[1].header("authorization"),
        Some("Bearer session-token-2")
    );
    assert_eq!(harness.server.refresh_calls.load(Ordering::SeqCst), 1);

    let harness = seeded_attachment().await;
    harness
        .server
        .unauthorized_patches
        .store(2, Ordering::SeqCst);
    let error = harness
        .runtime
        .request(
            RuntimeRequest::RenameAttachment {
                account_id: harness.account_id.clone(),
                attachment_id: ATTACHMENT_ID.into(),
                name: "still-unauthorized.txt".into(),
            },
            RequestCancellation::new(),
        )
        .await
        .unwrap_err();
    assert_eq!(error.code, RuntimeErrorCode::AuthenticationRequired);
    assert_eq!(harness.server.patch_calls.load(Ordering::SeqCst), 2);
    assert_eq!(harness.server.refresh_calls.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn lock_cancels_and_drains_a_hung_session_refresh_without_resubmission() {
    let harness = seeded_attachment().await;
    harness
        .server
        .unauthorized_patches
        .store(1, Ordering::SeqCst);
    harness.server.refresh_mode.store(1, Ordering::SeqCst);
    let rename_runtime = Arc::clone(&harness.runtime);
    let rename_account = harness.account_id.clone();
    let rename = tokio::spawn(async move {
        rename_runtime
            .request(
                RuntimeRequest::RenameAttachment {
                    account_id: rename_account,
                    attachment_id: ATTACHMENT_ID.into(),
                    name: "cancelled-refresh.txt".into(),
                },
                RequestCancellation::new(),
            )
            .await
    });
    until("Rename reaches Session refresh", || {
        harness.server.refresh_calls.load(Ordering::SeqCst) == 1
    })
    .await;

    let lock_runtime = Arc::clone(&harness.runtime);
    let lock_account = harness.account_id.clone();
    let lock = tokio::spawn(async move { lock_runtime.mark_account_locked(&lock_account).await });
    until("Lock cancels and drains the held Session refresh", || {
        lock.is_finished() && rename.is_finished()
    })
    .await;

    assert_eq!(
        rename.await.unwrap().unwrap_err().code,
        RuntimeErrorCode::Cancelled
    );
    lock.await.unwrap().unwrap();
    assert_eq!(harness.server.patch_calls.load(Ordering::SeqCst), 1);
    assert_eq!(harness.server.refresh_calls.load(Ordering::SeqCst), 1);
    assert_eq!(harness.server.cancel_calls.load(Ordering::SeqCst), 1);
    assert!(!harness
        .runtime
        .unlocked_items
        .lock()
        .unwrap()
        .contains_key(&harness.account_id));
}

#[tokio::test]
async fn renewal_maps_only_transport_failure_to_retryable() {
    for (mode, expected) in [
        (2usize, RuntimeErrorCode::RetryableTransport),
        (3, RuntimeErrorCode::AuthenticationUnavailable),
    ] {
        let harness = seeded_attachment().await;
        harness
            .server
            .unauthorized_patches
            .store(1, Ordering::SeqCst);
        harness.server.refresh_mode.store(mode, Ordering::SeqCst);

        let error = harness
            .runtime
            .request(
                RuntimeRequest::RenameAttachment {
                    account_id: harness.account_id.clone(),
                    attachment_id: ATTACHMENT_ID.into(),
                    name: format!("refresh-class-{mode}.txt"),
                },
                RequestCancellation::new(),
            )
            .await
            .unwrap_err();

        assert_eq!(error.code, expected, "refresh mode {mode}");
        assert_eq!(harness.server.patch_calls.load(Ordering::SeqCst), 1);
        assert_eq!(harness.server.refresh_calls.load(Ordering::SeqCst), 1);
    }
}

#[tokio::test]
async fn same_item_renames_have_one_writer() {
    let harness = seeded_attachment().await;
    harness.server.hold_patch.store(true, Ordering::SeqCst);
    let first_runtime = Arc::clone(&harness.runtime);
    let first_account = harness.account_id.clone();
    let first = tokio::spawn(async move {
        first_runtime
            .request(
                RuntimeRequest::RenameAttachment {
                    account_id: first_account,
                    attachment_id: ATTACHMENT_ID.into(),
                    name: "first-writer.txt".into(),
                },
                RequestCancellation::new(),
            )
            .await
    });
    until("the first Rename reaches PATCH", || {
        harness.server.patch_calls.load(Ordering::SeqCst) == 1
    })
    .await;

    let second_runtime = Arc::clone(&harness.runtime);
    let second_account = harness.account_id.clone();
    let second = tokio::spawn(async move {
        second_runtime
            .request(
                RuntimeRequest::RenameAttachment {
                    account_id: second_account,
                    attachment_id: ATTACHMENT_ID.into(),
                    name: "second-writer.txt".into(),
                },
                RequestCancellation::new(),
            )
            .await
    });
    settle().await;
    assert_eq!(harness.server.patch_calls.load(Ordering::SeqCst), 1);

    harness.server.hold_patch.store(false, Ordering::SeqCst);
    harness.server.patch_release.add_permits(1);
    first.await.unwrap().unwrap();
    second.await.unwrap().unwrap();
    assert_eq!(harness.server.patch_calls.load(Ordering::SeqCst), 2);
    assert_eq!(
        harness.runtime.unlocked_items.lock().unwrap()[&harness.account_id][0].attachments[0].name,
        "second-writer.txt"
    );
}

#[tokio::test]
async fn durable_item_acceptance_cannot_create_an_overlay_behind_rename_admission() {
    let harness = seeded_attachment().await;
    harness.server.hold_patch.store(true, Ordering::SeqCst);
    let rename_runtime = Arc::clone(&harness.runtime);
    let rename_account = harness.account_id.clone();
    let rename = tokio::spawn(async move {
        rename_runtime
            .request(
                RuntimeRequest::RenameAttachment {
                    account_id: rename_account,
                    attachment_id: ATTACHMENT_ID.into(),
                    name: "writer-first.txt".into(),
                },
                RequestCancellation::new(),
            )
            .await
    });
    until("Rename owns the shared Item writer", || {
        harness.server.patch_calls.load(Ordering::SeqCst) == 1
    })
    .await;

    let acceptance_runtime = Arc::clone(&harness.runtime);
    let acceptance_account = harness.account_id.clone();
    let acceptance = tokio::spawn(async move {
        acceptance_runtime
            .request(
                RuntimeRequest::UpdateLoginItem {
                    account_id: acceptance_account,
                    item_id: ITEM_ID.into(),
                    draft: draft(),
                },
                RequestCancellation::new(),
            )
            .await
    });
    tokio::task::yield_now().await;
    assert!(
        !acceptance.is_finished(),
        "durable acceptance must wait at the shared Item writer"
    );
    let while_renaming = harness
        .runtime
        .replica()
        .snapshot(&harness.account_id)
        .unwrap();
    assert!(while_renaming.operations.is_empty());
    assert!(while_renaming.items.is_empty());

    harness.server.hold_patch.store(false, Ordering::SeqCst);
    harness.server.patch_release.add_permits(1);
    assert!(matches!(
        rename.await.unwrap().unwrap(),
        RuntimeResponse::AttachmentRenamed { .. }
    ));
    assert!(matches!(
        acceptance.await.unwrap().unwrap(),
        RuntimeResponse::Accepted { .. }
    ));
    let after = harness
        .runtime
        .replica()
        .snapshot(&harness.account_id)
        .unwrap();
    assert_eq!(after.operations.len(), 1);
    assert_eq!(after.items.len(), 1);
}

#[tokio::test]
async fn create_share_cannot_accept_behind_rename_admission() {
    let harness = seeded_attachment().await;
    harness.server.hold_patch.store(true, Ordering::SeqCst);
    let rename = tokio::spawn({
        let runtime = Arc::clone(&harness.runtime);
        let account_id = harness.account_id.clone();
        async move {
            runtime
                .request(
                    RuntimeRequest::RenameAttachment {
                        account_id,
                        attachment_id: ATTACHMENT_ID.into(),
                        name: "rename-before-share.txt".into(),
                    },
                    RequestCancellation::new(),
                )
                .await
        }
    });
    until("Rename owns the Item writer before Share", || {
        harness.server.patch_calls.load(Ordering::SeqCst) == 1
    })
    .await;

    let share = tokio::spawn({
        let runtime = Arc::clone(&harness.runtime);
        let account_id = harness.account_id.clone();
        async move {
            runtime
                .request(create_share(&account_id), RequestCancellation::new())
                .await
        }
    });
    settle().await;
    assert!(!share.is_finished(), "Share must wait at the Item writer");
    let while_renaming = harness
        .runtime
        .replica()
        .snapshot(&harness.account_id)
        .unwrap();
    assert!(while_renaming.operations.is_empty());
    assert!(while_renaming.share_capabilities.is_empty());

    harness.server.hold_patch.store(false, Ordering::SeqCst);
    harness.server.patch_release.add_permits(1);
    assert!(matches!(
        rename.await.unwrap().unwrap(),
        RuntimeResponse::AttachmentRenamed { .. }
    ));
    assert!(matches!(
        share.await.unwrap().unwrap(),
        RuntimeResponse::Accepted { .. }
    ));
    let after = harness
        .runtime
        .replica()
        .snapshot(&harness.account_id)
        .unwrap();
    assert_eq!(after.operations.len(), 1);
    assert_eq!(after.share_capabilities.len(), 1);
}

#[tokio::test]
async fn accepted_create_share_refuses_rename_before_patch() {
    let harness = seeded_attachment().await;
    assert!(matches!(
        harness
            .runtime
            .request(
                create_share(&harness.account_id),
                RequestCancellation::new()
            )
            .await
            .unwrap(),
        RuntimeResponse::Accepted { .. }
    ));

    let error = harness
        .runtime
        .request(
            RuntimeRequest::RenameAttachment {
                account_id: harness.account_id.clone(),
                attachment_id: ATTACHMENT_ID.into(),
                name: "must-not-patch.txt".into(),
            },
            RequestCancellation::new(),
        )
        .await
        .unwrap_err();

    assert_eq!(error.code, RuntimeErrorCode::RetryableTransport);
    assert_eq!(harness.server.patch_calls.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn active_item_operation_refuses_rename_without_patch_or_false_publication() {
    let harness = seeded_attachment().await;
    harness
        .runtime
        .request(
            RuntimeRequest::UpdateLoginItem {
                account_id: harness.account_id.clone(),
                item_id: ITEM_ID.into(),
                draft: draft(),
            },
            RequestCancellation::new(),
        )
        .await
        .expect("the ordinary Item Operation should be durably accepted");
    let revision = harness
        .runtime
        .replica()
        .snapshot(&harness.account_id)
        .unwrap()
        .revision;

    let error = harness
        .runtime
        .request(
            RuntimeRequest::RenameAttachment {
                account_id: harness.account_id.clone(),
                attachment_id: ATTACHMENT_ID.into(),
                name: "must-not-publish.txt".into(),
            },
            RequestCancellation::new(),
        )
        .await
        .unwrap_err();

    assert_eq!(error.code, RuntimeErrorCode::RetryableTransport);
    assert_eq!(harness.server.patch_calls.load(Ordering::SeqCst), 0);
    assert_eq!(
        harness
            .runtime
            .replica()
            .snapshot(&harness.account_id)
            .unwrap()
            .revision,
        revision
    );
}

#[tokio::test]
async fn active_attachment_move_overlay_refuses_rename_without_patch_or_false_publication() {
    let harness = seeded_attachment().await;
    harness
        .runtime
        .request(
            RuntimeRequest::MoveItem {
                account_id: harness.account_id.clone(),
                item_id: ITEM_ID.into(),
                target_vault_id: "vault-2".into(),
            },
            RequestCancellation::new(),
        )
        .await
        .expect("the Attachment Move preparation should be durably accepted");
    let snapshot = harness
        .runtime
        .replica()
        .snapshot(&harness.account_id)
        .unwrap();
    assert_eq!(snapshot.attachment_move_preparations.len(), 1);
    assert_eq!(snapshot.items.len(), 1);

    let error = harness
        .runtime
        .request(
            RuntimeRequest::RenameAttachment {
                account_id: harness.account_id.clone(),
                attachment_id: ATTACHMENT_ID.into(),
                name: "must-not-publish.txt".into(),
            },
            RequestCancellation::new(),
        )
        .await
        .unwrap_err();

    assert_eq!(error.code, RuntimeErrorCode::RetryableTransport);
    assert_eq!(harness.server.patch_calls.load(Ordering::SeqCst), 0);
    let after = harness
        .runtime
        .replica()
        .snapshot(&harness.account_id)
        .unwrap();
    assert_eq!(after.revision, snapshot.revision);
    assert_eq!(
        after.attachment_move_preparations,
        snapshot.attachment_move_preparations
    );
    assert_eq!(after.items, snapshot.items);
}

#[tokio::test]
async fn account_lock_cancels_a_hung_foreground_rename_before_retiring_plaintext() {
    let harness = seeded_attachment().await;
    harness.server.hold_patch.store(true, Ordering::SeqCst);
    let rename_runtime = Arc::clone(&harness.runtime);
    let rename_account = harness.account_id.clone();
    let rename = tokio::spawn(async move {
        rename_runtime
            .request(
                RuntimeRequest::RenameAttachment {
                    account_id: rename_account,
                    attachment_id: ATTACHMENT_ID.into(),
                    name: "before-lock.txt".into(),
                },
                RequestCancellation::new(),
            )
            .await
    });
    until("Rename reaches PATCH", || {
        harness.server.patch_calls.load(Ordering::SeqCst) == 1
    })
    .await;

    let lock_runtime = Arc::clone(&harness.runtime);
    let lock_account = harness.account_id.clone();
    let lock = tokio::spawn(async move { lock_runtime.mark_account_locked(&lock_account).await });
    until("Lock cancels and drains the foreground Rename", || {
        lock.is_finished() && rename.is_finished()
    })
    .await;
    let error = rename.await.unwrap().unwrap_err();
    assert_eq!(error.code, RuntimeErrorCode::Cancelled);
    lock.await.unwrap().unwrap();
    assert_eq!(harness.server.patch_calls.load(Ordering::SeqCst), 1);
    assert_eq!(harness.server.cancel_calls.load(Ordering::SeqCst), 1);
    assert!(!harness
        .runtime
        .unlocked_items
        .lock()
        .unwrap()
        .contains_key(&harness.account_id));

    // Retirement waited for registration cleanup: a later generation can admit fresh work.
    harness.server.hold_patch.store(false, Ordering::SeqCst);
    harness
        .runtime
        .unlock_account(&harness.account_id)
        .await
        .unwrap();
    harness
        .runtime
        .request(
            RuntimeRequest::RenameAttachment {
                account_id: harness.account_id.clone(),
                attachment_id: ATTACHMENT_ID.into(),
                name: "after-unlock.txt".into(),
            },
            RequestCancellation::new(),
        )
        .await
        .unwrap();
    assert_eq!(harness.server.patch_calls.load(Ordering::SeqCst), 2);
}

#[tokio::test]
async fn lock_at_the_final_rename_boundary_publishes_no_stale_projection() {
    let harness = seeded_attachment().await;
    let sink = Arc::new(AttachmentSink::default());
    let _observation = harness
        .runtime
        .observe(
            ObservationRequest::Items {
                account_id: harness.account_id.clone(),
            },
            sink.clone(),
        )
        .unwrap();
    let publications_before = sink.0.lock().unwrap().len();
    let replica_revision_before = harness
        .runtime
        .replica()
        .snapshot(&harness.account_id)
        .unwrap()
        .revision;
    let reached_projection = Arc::new(AtomicBool::new(false));
    let release_projection = Arc::new(AtomicBool::new(false));
    harness
        .runtime
        .set_before_plaintext_commit_hook(Some(Arc::new({
            let reached_projection = Arc::clone(&reached_projection);
            let release_projection = Arc::clone(&release_projection);
            move || {
                reached_projection.store(true, Ordering::SeqCst);
                while !release_projection.load(Ordering::SeqCst) {
                    std::thread::yield_now();
                }
            }
        })));
    let rename = std::thread::spawn({
        let runtime = Arc::clone(&harness.runtime);
        let account_id = harness.account_id.clone();
        move || {
            tokio::runtime::Builder::new_current_thread()
                .build()
                .unwrap()
                .block_on(runtime.request(
                    RuntimeRequest::RenameAttachment {
                        account_id,
                        attachment_id: ATTACHMENT_ID.into(),
                        name: "committed-before-lock.txt".into(),
                    },
                    RequestCancellation::new(),
                ))
        }
    });
    until("Rename reaches its final plaintext boundary", || {
        reached_projection.load(Ordering::SeqCst)
    })
    .await;
    assert_eq!(
        harness
            .runtime
            .replica()
            .snapshot(&harness.account_id)
            .unwrap()
            .revision,
        replica_revision_before + 1,
        "the authoritative Rename must already be committed"
    );

    let lock_runtime = Arc::clone(&harness.runtime);
    let lock_account = harness.account_id.clone();
    let lock = tokio::spawn(async move { lock_runtime.mark_account_locked(&lock_account).await });
    until("Lock registers retirement intent", || {
        harness
            .runtime
            .account_access_retirement_is_pending(&harness.account_id)
    })
    .await;
    release_projection.store(true, Ordering::SeqCst);

    assert!(matches!(
        rename.join().unwrap().unwrap(),
        RuntimeResponse::AttachmentRenamed { .. }
    ));
    lock.await.unwrap().unwrap();
    assert_eq!(
        sink.0.lock().unwrap().len(),
        publications_before,
        "no old plaintext may be published with the committed Replica revision"
    );
    assert!(!harness
        .runtime
        .unlocked_items
        .lock()
        .unwrap()
        .contains_key(&harness.account_id));
}

#[tokio::test]
async fn runtime_close_cancels_a_hung_rename_probe_before_retiring_authority() {
    let harness = seeded_attachment().await;
    harness
        .server
        .hold_attachment_get
        .store(true, Ordering::SeqCst);
    let rename_runtime = Arc::clone(&harness.runtime);
    let rename_account = harness.account_id.clone();
    let rename = tokio::spawn(async move {
        rename_runtime
            .request(
                RuntimeRequest::RenameAttachment {
                    account_id: rename_account,
                    attachment_id: ATTACHMENT_ID.into(),
                    name: "never-published.txt".into(),
                },
                RequestCancellation::new(),
            )
            .await
    });
    until("Rename reaches its Attachment authority probe", || {
        harness.server.attachment_get_calls.load(Ordering::SeqCst) == 1
    })
    .await;

    let close_runtime = Arc::clone(&harness.runtime);
    let close = tokio::spawn(async move { close_runtime.close().await });
    until("close cancels and drains the foreground Rename", || {
        close.is_finished() && rename.is_finished()
    })
    .await;

    let error = rename.await.unwrap().unwrap_err();
    assert_eq!(error.code, RuntimeErrorCode::Cancelled);
    close.await.unwrap();
    assert_eq!(harness.server.patch_calls.load(Ordering::SeqCst), 1);
    assert_eq!(harness.server.cancel_calls.load(Ordering::SeqCst), 1);
    assert!(harness.runtime.is_closed());
    assert!(harness.runtime.unlocked_items.lock().unwrap().is_empty());
}

#[tokio::test]
async fn begun_rename_callback_can_complete_each_lifecycle_reentrantly_cross_thread() {
    for lifecycle in 0..5 {
        let harness = seeded_attachment().await;
        *harness
            .runtime
            .attachment_move_lifecycle
            .lock()
            .expect("Attachment Move lifecycle lock poisoned") =
            Some(Arc::new(AttachmentMoveLifecycle::new(
                Arc::new(attachment_move_lifecycle::TestAccountLeasePort),
                Arc::new(SuccessfulAttachmentTeardown),
            )));
        harness
            .runtime
            .install_teardown_host_cleanup(Arc::new(SuccessfulHostTeardown));
        let sink = Arc::new(ReentrantAttachmentSink {
            publications: Mutex::new(Vec::new()),
            callback: Mutex::new(None),
        });
        let _observation = harness
            .runtime
            .observe(
                ObservationRequest::Items {
                    account_id: harness.account_id.clone(),
                },
                sink.clone(),
            )
            .unwrap();
        let publications_before = sink.publications.lock().unwrap().len();
        let callback_completed = Arc::new(AtomicBool::new(false));
        *sink.callback.lock().unwrap() = Some(Box::new({
            let runtime = Arc::clone(&harness.runtime);
            let account_id = harness.account_id.clone();
            let callback_completed = Arc::clone(&callback_completed);
            move || {
                let (finished_tx, finished_rx) = std::sync::mpsc::sync_channel(1);
                let lifecycle_thread = std::thread::spawn(move || {
                    let runtime_thread = tokio::runtime::Builder::new_current_thread()
                        .build()
                        .unwrap();
                    let completed = runtime_thread.block_on(async {
                        match lifecycle {
                            0 => runtime
                                .request(
                                    RuntimeRequest::Lock { account_id },
                                    RequestCancellation::new(),
                                )
                                .await
                                .is_ok(),
                            1 => runtime
                                .request(
                                    RuntimeRequest::SignOut { account_id },
                                    RequestCancellation::new(),
                                )
                                .await
                                .is_ok(),
                            2 => runtime
                                .request(
                                    RuntimeRequest::RemoveAccount { account_id },
                                    RequestCancellation::new(),
                                )
                                .await
                                .is_ok(),
                            3 => runtime
                                .request(RuntimeRequest::Wipe, RequestCancellation::new())
                                .await
                                .is_ok(),
                            _ => {
                                runtime.close().await;
                                true
                            }
                        }
                    });
                    finished_tx.send(completed).unwrap();
                });
                assert!(
                    finished_rx
                        .recv_timeout(std::time::Duration::from_secs(5))
                        .unwrap_or_else(|_| panic!(
                            "lifecycle {lifecycle} deadlocked on the begun host callback"
                        )),
                    "lifecycle {lifecycle} did not complete"
                );
                lifecycle_thread.join().unwrap();
                callback_completed.store(true, Ordering::SeqCst);
            }
        }));

        let response = harness
            .runtime
            .request(
                RuntimeRequest::RenameAttachment {
                    account_id: harness.account_id.clone(),
                    attachment_id: ATTACHMENT_ID.into(),
                    name: format!("reentrant-{lifecycle}.txt"),
                },
                RequestCancellation::new(),
            )
            .await
            .unwrap();

        assert!(matches!(
            response,
            RuntimeResponse::AttachmentRenamed { .. }
        ));
        assert!(callback_completed.load(Ordering::SeqCst));
        let publications = sink.publications.lock().unwrap();
        let renamed_callbacks = publications
            .iter()
            .filter(|projection| {
                matches!(projection, RuntimeProjection::Items(items)
                    if items.items.iter().any(|item| item.attachments.iter().any(|attachment|
                        attachment.name == format!("reentrant-{lifecycle}.txt"))))
            })
            .count();
        assert_eq!(renamed_callbacks, 1, "lifecycle {lifecycle}");
        assert!(publications.len() > publications_before);
    }
}

#[tokio::test]
async fn close_at_the_final_rename_boundary_emits_no_callback_after_close_intent() {
    let harness = seeded_attachment().await;
    let sink = Arc::new(AttachmentSink::default());
    let _observation = harness
        .runtime
        .observe(
            ObservationRequest::Items {
                account_id: harness.account_id.clone(),
            },
            sink.clone(),
        )
        .unwrap();
    let publications_before = sink.0.lock().unwrap().len();
    let replica_revision_before = harness
        .runtime
        .replica()
        .snapshot(&harness.account_id)
        .unwrap()
        .revision;
    let reached_projection = Arc::new(AtomicBool::new(false));
    let release_projection = Arc::new(AtomicBool::new(false));
    harness
        .runtime
        .foreground_attachments
        .set_before_publication_admission_hook(Some(Arc::new({
            let reached_projection = Arc::clone(&reached_projection);
            let release_projection = Arc::clone(&release_projection);
            move || {
                reached_projection.store(true, Ordering::SeqCst);
                while !release_projection.load(Ordering::SeqCst) {
                    std::thread::yield_now();
                }
            }
        })));
    let rename = std::thread::spawn({
        let runtime = Arc::clone(&harness.runtime);
        let account_id = harness.account_id.clone();
        move || {
            tokio::runtime::Builder::new_current_thread()
                .build()
                .unwrap()
                .block_on(runtime.request(
                    RuntimeRequest::RenameAttachment {
                        account_id,
                        attachment_id: ATTACHMENT_ID.into(),
                        name: "committed-before-close.txt".into(),
                    },
                    RequestCancellation::new(),
                ))
        }
    });
    until("Rename reaches its final projection boundary", || {
        reached_projection.load(Ordering::SeqCst)
    })
    .await;
    assert_eq!(
        harness
            .runtime
            .replica()
            .snapshot(&harness.account_id)
            .unwrap()
            .revision,
        replica_revision_before + 1,
        "the authoritative Rename must already be committed"
    );

    let close_runtime = Arc::clone(&harness.runtime);
    let close = tokio::spawn(async move { close_runtime.close().await });
    until(
        "close completes without waiting for a callback that has not begun",
        || close.is_finished(),
    )
    .await;
    release_projection.store(true, Ordering::SeqCst);

    assert!(matches!(
        rename.join().unwrap().unwrap(),
        RuntimeResponse::AttachmentRenamed { .. }
    ));
    close.await.unwrap();
    assert_eq!(sink.0.lock().unwrap().len(), publications_before);
    assert!(harness.runtime.unlocked_items.lock().unwrap().is_empty());
}

#[tokio::test]
async fn remove_and_wipe_at_final_rename_boundary_emit_no_callback_after_retirement_intent() {
    for wipe in [false, true] {
        let harness = seeded_attachment().await;
        *harness
            .runtime
            .attachment_move_lifecycle
            .lock()
            .expect("Attachment Move lifecycle lock poisoned") =
            Some(Arc::new(AttachmentMoveLifecycle::new(
                Arc::new(attachment_move_lifecycle::TestAccountLeasePort),
                Arc::new(SuccessfulAttachmentTeardown),
            )));
        harness
            .runtime
            .install_teardown_host_cleanup(Arc::new(SuccessfulHostTeardown));
        let sink = Arc::new(AttachmentSink::default());
        let _observation = harness
            .runtime
            .observe(
                ObservationRequest::Items {
                    account_id: harness.account_id.clone(),
                },
                sink.clone(),
            )
            .unwrap();
        let publications_before = sink.0.lock().unwrap().len();
        let replica_revision_before = harness
            .runtime
            .replica()
            .snapshot(&harness.account_id)
            .unwrap()
            .revision;
        let reached_admission = Arc::new(AtomicBool::new(false));
        let release_admission = Arc::new(AtomicBool::new(false));
        harness
            .runtime
            .foreground_attachments
            .set_before_publication_admission_hook(Some(Arc::new({
                let reached_admission = Arc::clone(&reached_admission);
                let release_admission = Arc::clone(&release_admission);
                move || {
                    reached_admission.store(true, Ordering::SeqCst);
                    while !release_admission.load(Ordering::SeqCst) {
                        std::thread::yield_now();
                    }
                }
            })));
        let rename = std::thread::spawn({
            let runtime = Arc::clone(&harness.runtime);
            let account_id = harness.account_id.clone();
            move || {
                tokio::runtime::Builder::new_current_thread()
                    .build()
                    .unwrap()
                    .block_on(runtime.request(
                        RuntimeRequest::RenameAttachment {
                            account_id,
                            attachment_id: ATTACHMENT_ID.into(),
                            name: "committed-before-teardown.txt".into(),
                        },
                        RequestCancellation::new(),
                    ))
            }
        });
        until("Rename reaches publication admission", || {
            reached_admission.load(Ordering::SeqCst)
        })
        .await;
        assert_eq!(
            harness
                .runtime
                .replica()
                .snapshot(&harness.account_id)
                .unwrap()
                .revision,
            replica_revision_before + 1,
            "wipe={wipe}: authority must commit before final publication admission"
        );

        let teardown_runtime = Arc::clone(&harness.runtime);
        let teardown_account = harness.account_id.clone();
        let teardown = tokio::spawn(async move {
            teardown_runtime
                .request(
                    if wipe {
                        RuntimeRequest::Wipe
                    } else {
                        RuntimeRequest::RemoveAccount {
                            account_id: teardown_account,
                        }
                    },
                    RequestCancellation::new(),
                )
                .await
        });
        until(
            "teardown completes without waiting for a callback that has not begun",
            || teardown.is_finished(),
        )
        .await;
        release_admission.store(true, Ordering::SeqCst);

        assert!(matches!(
            rename.join().unwrap().unwrap(),
            RuntimeResponse::AttachmentRenamed { .. }
        ));
        assert!(matches!(
            teardown.await.unwrap().unwrap(),
            RuntimeResponse::Teardown {
                status: TeardownStatus::Complete,
                ..
            }
        ));
        assert_eq!(
            sink.0.lock().unwrap().len(),
            publications_before,
            "wipe={wipe}: no Items callback may begin after teardown intent"
        );
    }
}

#[tokio::test]
async fn sign_out_cancels_a_hung_foreground_rename_before_destroying_access() {
    let harness = seeded_attachment().await;
    harness.server.hold_patch.store(true, Ordering::SeqCst);
    let rename_runtime = Arc::clone(&harness.runtime);
    let rename_account = harness.account_id.clone();
    let rename = tokio::spawn(async move {
        rename_runtime
            .request(
                RuntimeRequest::RenameAttachment {
                    account_id: rename_account,
                    attachment_id: ATTACHMENT_ID.into(),
                    name: "before-sign-out.txt".into(),
                },
                RequestCancellation::new(),
            )
            .await
    });
    until("Rename reaches PATCH before Sign-out", || {
        harness.server.patch_calls.load(Ordering::SeqCst) == 1
    })
    .await;

    let sign_out_runtime = Arc::clone(&harness.runtime);
    let sign_out_account = harness.account_id.clone();
    let sign_out = tokio::spawn(async move {
        sign_out_runtime
            .request(
                RuntimeRequest::SignOut {
                    account_id: sign_out_account,
                },
                RequestCancellation::new(),
            )
            .await
    });
    until("Sign-out cancels and drains the foreground Rename", || {
        sign_out.is_finished() && rename.is_finished()
    })
    .await;

    assert_eq!(
        rename.await.unwrap().unwrap_err().code,
        RuntimeErrorCode::Cancelled
    );
    sign_out.await.unwrap().unwrap();
    assert_eq!(harness.server.patch_calls.load(Ordering::SeqCst), 1);
    assert_eq!(harness.server.cancel_calls.load(Ordering::SeqCst), 1);
    assert!(!harness
        .runtime
        .unlocked_items
        .lock()
        .unwrap()
        .contains_key(&harness.account_id));
}

#[tokio::test]
async fn dropping_a_hung_rename_releases_lifecycle_registration_before_lock() {
    let harness = seeded_attachment().await;
    harness.server.hold_patch.store(true, Ordering::SeqCst);
    let rename_runtime = Arc::clone(&harness.runtime);
    let rename_account = harness.account_id.clone();
    let rename = tokio::spawn(async move {
        rename_runtime
            .request(
                RuntimeRequest::RenameAttachment {
                    account_id: rename_account,
                    attachment_id: ATTACHMENT_ID.into(),
                    name: "dropped.txt".into(),
                },
                RequestCancellation::new(),
            )
            .await
    });
    until("Rename reaches PATCH before its future is dropped", || {
        harness.server.patch_calls.load(Ordering::SeqCst) == 1
    })
    .await;
    rename.abort();
    assert!(rename.await.unwrap_err().is_cancelled());

    let lock_runtime = Arc::clone(&harness.runtime);
    let lock_account = harness.account_id.clone();
    let lock = tokio::spawn(async move { lock_runtime.mark_account_locked(&lock_account).await });
    until(
        "Lock observes the dropped Rename registration as drained",
        || lock.is_finished(),
    )
    .await;
    lock.await.unwrap().unwrap();
    assert_eq!(harness.server.patch_calls.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn account_remove_and_device_wipe_cancel_hung_rename_before_deleting_authority() {
    for wipe in [false, true] {
        let harness = seeded_attachment().await;
        *harness
            .runtime
            .attachment_move_lifecycle
            .lock()
            .expect("Attachment Move lifecycle lock poisoned") =
            Some(Arc::new(AttachmentMoveLifecycle::new(
                Arc::new(attachment_move_lifecycle::TestAccountLeasePort),
                Arc::new(SuccessfulAttachmentTeardown),
            )));
        harness
            .runtime
            .install_teardown_host_cleanup(Arc::new(SuccessfulHostTeardown));
        harness.server.hold_patch.store(true, Ordering::SeqCst);
        let rename_runtime = Arc::clone(&harness.runtime);
        let rename_account = harness.account_id.clone();
        let rename = tokio::spawn(async move {
            rename_runtime
                .request(
                    RuntimeRequest::RenameAttachment {
                        account_id: rename_account,
                        attachment_id: ATTACHMENT_ID.into(),
                        name: "removed-before-publication.txt".into(),
                    },
                    RequestCancellation::new(),
                )
                .await
        });
        until("Rename reaches PATCH before teardown", || {
            harness.server.patch_calls.load(Ordering::SeqCst) == 1
        })
        .await;

        let teardown_runtime = Arc::clone(&harness.runtime);
        let teardown_account = harness.account_id.clone();
        let teardown = tokio::spawn(async move {
            teardown_runtime
                .request(
                    if wipe {
                        RuntimeRequest::Wipe
                    } else {
                        RuntimeRequest::RemoveAccount {
                            account_id: teardown_account,
                        }
                    },
                    RequestCancellation::new(),
                )
                .await
        });
        until("teardown cancels and drains the foreground Rename", || {
            teardown.is_finished() && rename.is_finished()
        })
        .await;

        let error = rename.await.unwrap().unwrap_err();
        assert_eq!(error.code, RuntimeErrorCode::Cancelled, "wipe={wipe}");
        assert!(matches!(
            teardown.await.unwrap().unwrap(),
            RuntimeResponse::Teardown { .. }
        ));
        assert_eq!(
            harness.server.patch_calls.load(Ordering::SeqCst),
            1,
            "wipe={wipe}"
        );
        assert_eq!(
            harness.server.cancel_calls.load(Ordering::SeqCst),
            1,
            "wipe={wipe}"
        );
        assert!(harness
            .runtime
            .replica()
            .snapshot(&harness.account_id)
            .is_none());
    }
}

#[tokio::test]
async fn newer_background_authority_wins_the_guarded_rename_commit() {
    let harness = seeded_attachment().await;
    harness
        .server
        .hold_attachment_get
        .store(true, Ordering::SeqCst);
    let rename_runtime = Arc::clone(&harness.runtime);
    let rename_account = harness.account_id.clone();
    let rename = tokio::spawn(async move {
        rename_runtime
            .request(
                RuntimeRequest::RenameAttachment {
                    account_id: rename_account,
                    attachment_id: ATTACHMENT_ID.into(),
                    name: "foreground.txt".into(),
                },
                RequestCancellation::new(),
            )
            .await
    });
    until("Rename pauses while fetching Attachment authority", || {
        harness.server.attachment_get_calls.load(Ordering::SeqCst) == 1
    })
    .await;

    let background = Replica::new(Arc::new(SerializedReplicaPersistence::new(
        harness.replica.clone(),
    )));
    let observed = background.load(&harness.account_id).await.unwrap().unwrap();
    let mut item = observed.bootstrap.snapshot().visible_items[0].clone();
    let encrypted = encrypt_with_aad(
        "background.txt",
        &[13u8; 32],
        &AadContext {
            vault_id: TEST_VAULT_ID.into(),
            entity_id: ATTACHMENT_ID.into(),
            entity_type: "attachment_name".into(),
            version: 1,
            user_id: USER.into(),
        },
    )
    .unwrap();
    item.attachments[0].encrypted_name = encrypted.ciphertext;
    item.attachments[0].encryption_iv = encrypted.iv;
    item.attachments[0].encryption_algorithm = encrypted.algorithm;
    assert!(matches!(
        background
            .execute(GuardedCommitPlan::new(
                harness.account_id.clone(),
                observed.incarnation,
                observed.revision,
                observed.lock_epoch,
                vec![PlanMutation::CommitAttachmentAuthority {
                    attachment_id: ATTACHMENT_ID.into(),
                    item: Box::new(item),
                }],
            ))
            .await
            .unwrap(),
        PlanResult::Applied { .. }
    ));

    harness
        .server
        .hold_attachment_get
        .store(false, Ordering::SeqCst);
    harness.server.attachment_get_release.add_permits(1);
    let error = rename.await.unwrap().unwrap_err();
    assert_eq!(error.code, RuntimeErrorCode::RetryableTransport);
    harness
        .runtime
        .decrypt_visible_items(&harness.account_id)
        .unwrap();
    assert_eq!(
        harness.runtime.unlocked_items.lock().unwrap()[&harness.account_id][0].attachments[0].name,
        "background.txt"
    );
}

#[tokio::test]
async fn older_fetched_item_authority_is_retryable_without_commit_or_publication() {
    let harness = seeded_attachment().await;
    let mut current = harness
        .runtime
        .replica()
        .snapshot(&harness.account_id)
        .unwrap();
    let mut newer = current.bootstrap.snapshot().visible_items[0].clone();
    newer.version = 2;
    newer.updated_at = "2026-08-28T12:00:00Z".into();
    harness
        .runtime
        .execute_plan(GuardedCommitPlan::new(
            harness.account_id.clone(),
            current.incarnation.clone(),
            current.revision,
            current.lock_epoch,
            vec![PlanMutation::CommitAttachmentAuthority {
                attachment_id: ATTACHMENT_ID.into(),
                item: Box::new(newer),
            }],
        ))
        .await
        .unwrap();
    current = harness
        .runtime
        .replica()
        .snapshot(&harness.account_id)
        .unwrap();
    let sink = Arc::new(AttachmentSink::default());
    let _observation = harness
        .runtime
        .observe(
            ObservationRequest::Items {
                account_id: harness.account_id.clone(),
            },
            sink.clone(),
        )
        .unwrap();
    let publications = sink.0.lock().unwrap().len();

    let error = harness
        .runtime
        .request(
            RuntimeRequest::RenameAttachment {
                account_id: harness.account_id.clone(),
                attachment_id: ATTACHMENT_ID.into(),
                name: "stale-fetch.txt".into(),
            },
            RequestCancellation::new(),
        )
        .await
        .unwrap_err();

    assert_eq!(error.code, RuntimeErrorCode::RetryableTransport);
    assert_eq!(harness.server.patch_calls.load(Ordering::SeqCst), 1);
    assert_eq!(
        harness
            .runtime
            .replica()
            .snapshot(&harness.account_id)
            .unwrap()
            .revision,
        current.revision
    );
    assert_eq!(sink.0.lock().unwrap().len(), publications);
}

#[tokio::test]
async fn rename_rejects_foreign_missing_invalid_and_cancelled_requests_before_transport() {
    let harness = seeded_attachment().await;
    let cases = [
        (
            RuntimeRequest::RenameAttachment {
                account_id: AccountId::from("foreign-account"),
                attachment_id: ATTACHMENT_ID.into(),
                name: "name.txt".into(),
            },
            RequestCancellation::new(),
            RuntimeErrorCode::AccountMissing,
        ),
        (
            RuntimeRequest::RenameAttachment {
                account_id: harness.account_id.clone(),
                attachment_id: "missing-attachment".into(),
                name: "name.txt".into(),
            },
            RequestCancellation::new(),
            RuntimeErrorCode::AuthorityMissing,
        ),
        (
            RuntimeRequest::RenameAttachment {
                account_id: harness.account_id.clone(),
                attachment_id: ATTACHMENT_ID.into(),
                name: "   ".into(),
            },
            RequestCancellation::new(),
            RuntimeErrorCode::SizeRejected,
        ),
    ];
    for (request, cancellation, expected) in cases {
        let error = harness
            .runtime
            .request(request, cancellation)
            .await
            .unwrap_err();
        assert_eq!(error.code, expected);
    }
    let cancellation = RequestCancellation::new();
    cancellation.cancel();
    let error = harness
        .runtime
        .request(
            RuntimeRequest::RenameAttachment {
                account_id: harness.account_id.clone(),
                attachment_id: ATTACHMENT_ID.into(),
                name: "cancelled.txt".into(),
            },
            cancellation,
        )
        .await
        .unwrap_err();
    assert_eq!(error.code, RuntimeErrorCode::Cancelled);
    assert_eq!(harness.server.patch_calls.load(Ordering::SeqCst), 0);
}

fn attachment_authority() -> AuthorityAttachmentRecord {
    let attachment_key = [13u8; 32];
    let context = |entity_type: &str| AadContext {
        vault_id: TEST_VAULT_ID.into(),
        entity_id: ATTACHMENT_ID.into(),
        entity_type: entity_type.into(),
        version: 1,
        user_id: USER.into(),
    };
    let wrapped_key = encrypt_with_aad(
        &BASE64.encode(attachment_key),
        &TEST_VAULT_KEY,
        &context("attachment_key"),
    )
    .unwrap();
    let encrypted_name =
        encrypt_with_aad("original.txt", &attachment_key, &context("attachment_name")).unwrap();
    let encrypted_content_type = encrypt_with_aad(
        "text/plain",
        &attachment_key,
        &context("attachment_content_type"),
    )
    .unwrap();
    AuthorityAttachmentRecord {
        id: ATTACHMENT_ID.into(),
        item_id: ITEM_ID.into(),
        vault_id: TEST_VAULT_ID.into(),
        storage_key: "attachments/item-existing/file.enc".into(),
        encrypted_name: encrypted_name.ciphertext,
        encryption_iv: encrypted_name.iv,
        encryption_algorithm: encrypted_name.algorithm,
        encrypted_attachment_key: wrapped_key.ciphertext,
        attachment_key_iv: wrapped_key.iv,
        attachment_key_algorithm: wrapped_key.algorithm,
        encrypted_content_type: encrypted_content_type.ciphertext,
        encrypted_content_type_iv: encrypted_content_type.iv,
        envelope_version: 1,
        file_size: 42,
        uploaded_by: USER.into(),
        created_at: "2026-08-23T00:00:00Z".into(),
    }
}

fn attachment_dto(attachment: AuthorityAttachmentRecord) -> VaultAttachmentResponse {
    VaultAttachmentResponse {
        id: attachment.id,
        item_id: attachment.item_id,
        vault_id: attachment.vault_id,
        storage_key: attachment.storage_key,
        encrypted_name: attachment.encrypted_name,
        encryption_iv: attachment.encryption_iv,
        encryption_algorithm: attachment.encryption_algorithm,
        encrypted_attachment_key: attachment.encrypted_attachment_key,
        attachment_key_iv: attachment.attachment_key_iv,
        attachment_key_algorithm: attachment.attachment_key_algorithm,
        encrypted_content_type: attachment.encrypted_content_type,
        encrypted_content_type_iv: attachment.encrypted_content_type_iv,
        envelope_version: attachment.envelope_version,
        file_size: attachment.file_size,
        uploaded_by: attachment.uploaded_by,
        created_at: attachment.created_at,
    }
}

fn attachment_page_response(server: &AttachmentServer, url: &str) -> Value {
    let mode = server.attachment_page_mode.load(Ordering::SeqCst);
    if mode == 0 {
        return completed(
            200,
            serde_json::to_vec(&json!({
                "items": [serde_json::to_value(server.attachment.lock().unwrap().clone()).unwrap()],
                "hasMore": false,
                "nextCursor": null,
            }))
            .unwrap(),
        );
    }

    let page = url
        .split("cursor=authority-")
        .nth(1)
        .and_then(|value| value.split('&').next())
        .and_then(|value| value.parse::<usize>().ok())
        .unwrap_or(0);
    let (count, has_more) = if mode == 1 {
        (1usize, true)
    } else {
        (1, page < 8)
    };
    let template = server.attachment.lock().unwrap().clone();
    let items: Vec<_> = (0..count)
        .map(|offset| {
            let mut attachment = template.clone();
            attachment.id = format!("decoy-{mode}-{page}-{offset}");
            attachment
        })
        .collect();
    let mut body = serde_json::to_vec(&json!({
        "items": items,
        "hasMore": has_more,
        "nextCursor": has_more.then(|| format!("authority-{}", page + 1)),
    }))
    .unwrap();
    if mode == 2 {
        // JSON permits trailing whitespace. Nine pages padded just below the transport's 4 MiB
        // per-page bound exceed the 32 MiB authority aggregate without allocating huge entity sets.
        body.resize(4 * 1024 * 1024 - 16 * 1024, b' ');
    }
    completed(200, body)
}
