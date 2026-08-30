//! Slice A: the durable half of an offline create.
//!
//! Every assertion here is about what survives a crash: the exact bytes, the fingerprint that
//! stands apart from the Operation ID, the encrypted overlay, and the absence of both plaintext
//! and credentials in anything the Replica persists.

use super::*;
use crate::{
    http_transport::{HttpHeader, HttpMethod, SerializedHttpExecutor},
    platform_storage::SerializedPlatformStorageExecutor,
    protocol::Incarnation,
    replica::{
        attachment_move_artifact_ref, AttachmentMoveArtifactRef, AttachmentMoveProgress,
        AttachmentMoveUploadState, AuthorityAttachmentRecord, AuthorityItemCategory,
        AuthorityItemRecord, AuthorityVaultRole, AuthorityVaultType, BeginBootstrapPlan,
        BootstrapGenerationId, BootstrapGuard, GuardedCommitPlan, InMemoryReplica,
        MarkRefreshRequiredPlan, OperationKind, OperationRecord, PlanMutation,
        PreparedMoveAttachment, ReplicaPersistence, ReplicaPersistenceRequest, ReplicaState,
        SerializedReplicaExecutor,
    },
    server_contract::{CreateItemBody, ItemCategory},
    test_fixtures::{
        personal_vault, seed_ready_personal_vault, TEST_MASTER_UNLOCK_KEY, TEST_VAULT_ID,
        TEST_VAULT_KEY,
    },
    CreateShareDraft, CustomField, CustomFieldKind, ItemDraft, LoginItemData, ShareAccessMode,
    ShareExpiration,
};
use async_trait::async_trait;
use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use bittery_crypto_core::{decrypt_with_aad, encrypt_with_aad, AadContext, EncryptedData};
use create::{create_item_fingerprint, create_item_path, share_operation_fingerprint};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::sync::atomic::AtomicBool;

const ACCOUNT: &str = "account-1";
const USER: &str = "user-1";
const INCARNATION: &str = "incarnation-1";

/// Records every serialized persistence request so a test can search the durable plan itself.
struct RecordingExecutor {
    state: InMemoryReplica,
    requests: Mutex<Vec<String>>,
    fail_commits: AtomicBool,
    fence_before_commit: AtomicBool,
    reverse_preparation_progress_on_load: AtomicBool,
    invalidate_artifact_id_on_load: AtomicBool,
    cancel_after_commit: Mutex<Option<RequestCancellation>>,
}

struct SuccessfulDeletePlatform;

#[async_trait]
impl SerializedPlatformStorageExecutor for SuccessfulDeletePlatform {
    async fn invoke(
        &self,
        request_json: Zeroizing<String>,
    ) -> Result<Zeroizing<String>, RuntimeError> {
        let request: serde_json::Value = serde_json::from_str(&request_json).unwrap();
        let response = match request["type"].as_str() {
            Some("delete") | Some("set") => serde_json::json!({ "type": "done" }),
            Some("get") => serde_json::json!({ "type": "value", "value": null }),
            other => panic!("unexpected platform request {other:?}"),
        };
        Ok(Zeroizing::new(response.to_string()))
    }
}

struct UnusedHttp;

#[async_trait]
impl SerializedHttpExecutor for UnusedHttp {
    async fn invoke(&self, _request_json: String) -> Result<String, RuntimeError> {
        panic!("Share durable acceptance must not invoke HTTP")
    }

    fn cancel(&self, _dispatch_id: &str) {}
}

impl RecordingExecutor {
    fn seeded() -> Arc<Self> {
        let state = InMemoryReplica::default();
        let account_id = AccountId::from(ACCOUNT);
        state
            .install(
                account_id.clone(),
                USER.to_owned(),
                Incarnation::from(INCARNATION),
            )
            .unwrap();
        seed_ready_personal_vault(&state, &account_id).unwrap();
        Arc::new(Self {
            state,
            requests: Mutex::new(Vec::new()),
            fail_commits: AtomicBool::new(false),
            fence_before_commit: AtomicBool::new(false),
            reverse_preparation_progress_on_load: AtomicBool::new(false),
            invalidate_artifact_id_on_load: AtomicBool::new(false),
            cancel_after_commit: Mutex::new(None),
        })
    }

    fn seeded_with_item(deleted: bool) -> Arc<Self> {
        Self::seeded_item(deleted, true)
    }

    fn seeded_attachment_free_item(deleted: bool) -> Arc<Self> {
        Self::seeded_item(deleted, false)
    }

    fn seeded_share_item(
        category: AuthorityItemCategory,
        plaintext: serde_json::Value,
    ) -> Arc<Self> {
        Self::seeded_category_item(category, plaintext, false)
    }

    fn seeded_category_item(
        category: AuthorityItemCategory,
        plaintext: serde_json::Value,
        deleted: bool,
    ) -> Arc<Self> {
        let state = InMemoryReplica::default();
        let account_id = AccountId::from(ACCOUNT);
        state
            .install(
                account_id.clone(),
                USER.to_owned(),
                Incarnation::from(INCARNATION),
            )
            .unwrap();
        let sealed = encrypt_with_aad(
            &serde_json::to_string(&plaintext).unwrap(),
            &TEST_VAULT_KEY,
            &AadContext {
                vault_id: TEST_VAULT_ID.into(),
                entity_id: "item-existing".into(),
                entity_type: "item".into(),
                version: 1,
                user_id: USER.into(),
            },
        )
        .unwrap();
        state
            .seed_ready_authority(
                &account_id,
                vec![
                    personal_vault(TEST_VAULT_ID, USER),
                    personal_vault("vault-2", USER),
                ],
                vec![AuthorityItemRecord {
                    id: "item-existing".into(),
                    vault_id: TEST_VAULT_ID.into(),
                    category,
                    favorite: true,
                    encrypted_data: sealed.ciphertext,
                    encryption_iv: sealed.iv,
                    encryption_algorithm: sealed.algorithm,
                    version: 1,
                    encryption_version: 1,
                    encrypted_by_user_id: USER.into(),
                    last_modified_by: USER.into(),
                    created_at: "2026-08-23T00:00:00Z".into(),
                    updated_at: "2026-08-23T00:00:00Z".into(),
                    deleted_at: deleted.then(|| "2026-08-24T00:00:00Z".into()),
                    attachments: Vec::new(),
                }],
            )
            .unwrap();
        Arc::new(Self {
            state,
            requests: Mutex::new(Vec::new()),
            fail_commits: AtomicBool::new(false),
            fence_before_commit: AtomicBool::new(false),
            reverse_preparation_progress_on_load: AtomicBool::new(false),
            invalidate_artifact_id_on_load: AtomicBool::new(false),
            cancel_after_commit: Mutex::new(None),
        })
    }

    fn seeded_item(deleted: bool, with_attachment: bool) -> Arc<Self> {
        Self::seeded_item_with_attachments(
            deleted,
            with_attachment.then(attachment).into_iter().collect(),
        )
    }

    fn seeded_with_two_attachments() -> Arc<Self> {
        Self::seeded_item_with_attachments(
            false,
            vec![attachment(), attachment_named("attachment-2")],
        )
    }

    fn seeded_item_with_attachments(
        deleted: bool,
        attachments: Vec<AuthorityAttachmentRecord>,
    ) -> Arc<Self> {
        let state = InMemoryReplica::default();
        let account_id = AccountId::from(ACCOUNT);
        state
            .install(
                account_id.clone(),
                USER.to_owned(),
                Incarnation::from(INCARNATION),
            )
            .unwrap();
        let sealed = encrypt_with_aad(
            &create::item_plaintext(&draft()).unwrap(),
            &TEST_VAULT_KEY,
            &AadContext {
                vault_id: TEST_VAULT_ID.into(),
                entity_id: "item-existing".into(),
                entity_type: "item".into(),
                version: 1,
                user_id: USER.into(),
            },
        )
        .unwrap();
        state
            .seed_ready_authority(
                &account_id,
                vec![
                    personal_vault(TEST_VAULT_ID, USER),
                    personal_vault("vault-2", USER),
                ],
                vec![AuthorityItemRecord {
                    id: "item-existing".into(),
                    vault_id: TEST_VAULT_ID.into(),
                    category: AuthorityItemCategory::Login,
                    favorite: false,
                    encrypted_data: sealed.ciphertext,
                    encryption_iv: sealed.iv,
                    encryption_algorithm: sealed.algorithm,
                    version: 1,
                    encryption_version: 1,
                    encrypted_by_user_id: USER.into(),
                    last_modified_by: USER.into(),
                    created_at: "2026-08-23T00:00:00Z".into(),
                    updated_at: "2026-08-23T00:00:00Z".into(),
                    deleted_at: deleted.then(|| "2026-08-24T00:00:00Z".into()),
                    attachments,
                }],
            )
            .unwrap();
        Arc::new(Self {
            state,
            requests: Mutex::new(Vec::new()),
            fail_commits: AtomicBool::new(false),
            fence_before_commit: AtomicBool::new(false),
            reverse_preparation_progress_on_load: AtomicBool::new(false),
            invalidate_artifact_id_on_load: AtomicBool::new(false),
            cancel_after_commit: Mutex::new(None),
        })
    }

    fn recorded(&self) -> Vec<String> {
        self.requests.lock().unwrap().clone()
    }
}

#[async_trait]
impl SerializedReplicaExecutor for RecordingExecutor {
    async fn invoke(&self, request_json: String) -> Result<String, RuntimeError> {
        self.requests.lock().unwrap().push(request_json.clone());
        let request: ReplicaPersistenceRequest = serde_json::from_str(&request_json).unwrap();
        let is_commit = matches!(request, ReplicaPersistenceRequest::Commit { .. });
        if matches!(request, ReplicaPersistenceRequest::Commit { .. })
            && self.fail_commits.load(Ordering::SeqCst)
        {
            return Err(RuntimeError::new(
                RuntimeErrorCode::InvariantViolation,
                "injected commit failure",
            ));
        }
        if let ReplicaPersistenceRequest::Commit { prepared } = &request {
            if self.fence_before_commit.swap(false, Ordering::SeqCst) {
                self.state
                    .set_lock_epoch(
                        &prepared.expected.account_id,
                        prepared.expected.lock_epoch + 1,
                    )
                    .unwrap();
            }
        }
        let response = self.state.invoke(request).await?;
        if is_commit {
            if let Some(cancellation) = self.cancel_after_commit.lock().unwrap().take() {
                cancellation.cancel();
            }
        }
        let mut response = serde_json::to_value(response).map_err(|_| {
            RuntimeError::new(
                RuntimeErrorCode::InvariantViolation,
                "recording fake response could not be serialized",
            )
        })?;
        if !is_commit
            && self
                .reverse_preparation_progress_on_load
                .swap(false, Ordering::SeqCst)
        {
            let rows = response["rows"].as_array_mut().unwrap();
            let row = rows
                .iter_mut()
                .find(|row| row["store"] == "attachmentMovePreparations")
                .unwrap();
            let mut payload: serde_json::Value =
                serde_json::from_str(row["payloadJson"].as_str().unwrap()).unwrap();
            payload["progress"].as_array_mut().unwrap().reverse();
            row["payloadJson"] =
                serde_json::Value::String(serde_json::to_string(&payload).unwrap());
        }
        if !is_commit
            && self
                .invalidate_artifact_id_on_load
                .swap(false, Ordering::SeqCst)
        {
            let rows = response["rows"].as_array_mut().unwrap();
            let row = rows
                .iter_mut()
                .find(|row| row["store"] == "attachmentMovePreparations")
                .unwrap();
            let mut payload: serde_json::Value =
                serde_json::from_str(row["payloadJson"].as_str().unwrap()).unwrap();
            payload["progress"][0]["artifact"]["artifactId"] =
                serde_json::Value::String("../foreign-artifact".into());
            row["payloadJson"] =
                serde_json::Value::String(serde_json::to_string(&payload).unwrap());
        }
        serde_json::to_string(&response).map_err(|_| {
            RuntimeError::new(
                RuntimeErrorCode::InvariantViolation,
                "recording fake response could not be serialized",
            )
        })
    }
}

async fn unlocked_runtime(executor: Arc<RecordingExecutor>) -> (Arc<Runtime>, AccountId) {
    let runtime = Runtime::with_serialized_replica_executor(executor);
    let account_id = AccountId::from(ACCOUNT);
    runtime.replica().load(&account_id).await.unwrap().unwrap();
    runtime.unlock_account(&account_id).await.unwrap();
    (runtime, account_id)
}

const TITLE: &str = "Zzz-Bank-Title-Marker";
const USERNAME: &str = "Zzz-Username-Marker";
const PASSWORD: &str = "Zzz-Password-Marker";
const NOTES: &str = "Zzz-Notes-Marker";
const FIELD_VALUE: &str = "Zzz-Custom-Field-Marker";
const TAG: &str = "Zzz-Tag-Marker";
const ATTACHMENT_NAME: &str = "Zzz-Attachment-Name.txt";
const ATTACHMENT_CONTENT_TYPE: &str = "text/x-z-marker";

fn attachment() -> AuthorityAttachmentRecord {
    attachment_named("attachment-1")
}

fn attachment_named(attachment_id: &str) -> AuthorityAttachmentRecord {
    let attachment_key = [13u8; 32];
    let context = |entity_type: &str| AadContext {
        vault_id: TEST_VAULT_ID.into(),
        entity_id: attachment_id.into(),
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
    let encrypted_name = encrypt_with_aad(
        ATTACHMENT_NAME,
        &attachment_key,
        &context("attachment_name"),
    )
    .unwrap();
    let encrypted_content_type = encrypt_with_aad(
        ATTACHMENT_CONTENT_TYPE,
        &attachment_key,
        &context("attachment_content_type"),
    )
    .unwrap();
    AuthorityAttachmentRecord {
        id: attachment_id.into(),
        item_id: "item-existing".into(),
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

fn draft() -> ItemDraft {
    ItemDraft::Login(LoginItemData {
        title: TITLE.into(),
        url: Some("https://example.test".into()),
        urls: vec!["https://second.example.test".into()],
        username: Some(USERNAME.into()),
        password: Some(PASSWORD.into()),
        password_history: Vec::new(),
        passkeys: Vec::new(),
        notes: Some(NOTES.into()),
        note: None,
        custom_fields: vec![CustomField {
            id: "field-1".into(),
            label: "Recovery".into(),
            value: FIELD_VALUE.into(),
            field_type: CustomFieldKind::Password,
        }],
        tags: vec![TAG.into()],
        totp_secret: None,
        totp_issuer: None,
        totp_account_name: None,
        totp_algorithm: None,
        totp_digits: None,
        totp_period: None,
    })
}

fn plaintext_markers() -> [&'static str; 6] {
    [TITLE, USERNAME, PASSWORD, NOTES, FIELD_VALUE, TAG]
}

fn create(account_id: &AccountId, vault_id: &str) -> RuntimeRequest {
    RuntimeRequest::CreateItem {
        account_id: account_id.clone(),
        vault_id: vault_id.to_owned(),
        draft: draft(),
    }
}

fn create_share(account_id: &AccountId) -> RuntimeRequest {
    RuntimeRequest::CreateShare {
        account_id: account_id.clone(),
        item_id: "item-existing".into(),
        draft: CreateShareDraft {
            access_mode: ShareAccessMode::Anyone,
            expires_in: ShareExpiration::SevenDays,
            is_one_time_use: false,
            allowed_emails: Vec::new(),
        },
    }
}

fn accepted(response: RuntimeResponse) -> (String, String, u64) {
    match response {
        RuntimeResponse::Accepted {
            operation_id,
            item_id,
            replica_revision,
        } => (operation_id, item_id, replica_revision),
        other => panic!("expected Accepted, got {other:?}"),
    }
}

#[tokio::test]
async fn accepted_share_is_one_explicit_account_scoped_durable_operation() {
    let executor = RecordingExecutor::seeded_attachment_free_item(false);
    let (runtime, account_id) = unlocked_runtime(executor).await;

    let (operation_id, item_id, replica_revision) = accepted(
        runtime
            .request(
                RuntimeRequest::CreateShare {
                    account_id: account_id.clone(),
                    item_id: "item-existing".into(),
                    draft: CreateShareDraft {
                        access_mode: ShareAccessMode::Anyone,
                        expires_in: ShareExpiration::SevenDays,
                        is_one_time_use: false,
                        allowed_emails: Vec::new(),
                    },
                },
                RequestCancellation::new(),
            )
            .await
            .unwrap(),
    );

    let snapshot = runtime.replica().snapshot(&account_id).unwrap();
    assert_eq!(snapshot.revision, replica_revision);
    assert_eq!(snapshot.operations.len(), 1);
    assert_eq!(snapshot.operations[0].operation_id, operation_id);
    assert_eq!(snapshot.operations[0].item_id, item_id);
    assert_eq!(snapshot.operations[0].kind, OperationKind::CreateShare);
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct FrozenShareBody {
    token_hash: String,
    access_mode: ShareAccessMode,
    expires_in: ShareExpiration,
    is_one_time_use: bool,
    allowed_emails: Option<Vec<String>>,
    encrypted_item_data: String,
    encryption_iv: String,
    encrypted_share_key: String,
    share_key_iv: String,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ShareCapabilityPlaintext {
    token: String,
    share_key: String,
}

#[tokio::test]
async fn accepted_share_freezes_hash_only_server_bytes_beside_muk_protected_capability() {
    let executor = RecordingExecutor::seeded_attachment_free_item(false);
    let (runtime, account_id) = unlocked_runtime(executor.clone()).await;

    let (operation_id, _, _) = accepted(
        runtime
            .request(
                RuntimeRequest::CreateShare {
                    account_id: account_id.clone(),
                    item_id: "item-existing".into(),
                    draft: CreateShareDraft {
                        access_mode: ShareAccessMode::EmailRestricted,
                        expires_in: ShareExpiration::SevenDays,
                        is_one_time_use: true,
                        allowed_emails: vec!["reader@example.test".into()],
                    },
                },
                RequestCancellation::new(),
            )
            .await
            .unwrap(),
    );

    let snapshot = runtime.replica().snapshot(&account_id).unwrap();
    let operation = &snapshot.operations[0];
    let body: FrozenShareBody = serde_json::from_slice(&operation.request.body).unwrap();
    let protected = &snapshot.share_capabilities[0];
    assert_eq!(protected.operation_id, operation_id);
    let plaintext = bittery_crypto_core::decrypt_share_capability(
        &EncryptedData {
            ciphertext: protected.ciphertext.clone(),
            iv: protected.iv.clone(),
            algorithm: protected.algorithm.clone(),
        },
        &TEST_MASTER_UNLOCK_KEY,
        &bittery_crypto_core::ShareCapabilityAadContext::new(
            account_id.as_str().into(),
            operation_id.clone(),
        )
        .unwrap(),
    )
    .unwrap();
    let capability: ShareCapabilityPlaintext = serde_json::from_str(&plaintext).unwrap();
    assert_eq!(
        body.token_hash,
        format!("{:x}", Sha256::digest(capability.token.as_bytes()))
    );
    let durable_json = executor.recorded().join("\n");
    assert!(!durable_json.contains(&capability.token));
    assert!(!durable_json.contains(&capability.share_key));

    let share_key = BASE64.decode(&capability.share_key).unwrap();
    assert_eq!(share_key.len(), 32);
    let encrypted_share_key = EncryptedData {
        ciphertext: body.encrypted_share_key,
        iv: body.share_key_iv,
        algorithm: "AES-GCM-AAD-V1".into(),
    };
    assert_eq!(
        bittery_crypto_core::decrypt(&encrypted_share_key, &share_key).unwrap(),
        capability.share_key
    );
    let shared_payload = bittery_crypto_core::decrypt(
        &EncryptedData {
            ciphertext: body.encrypted_item_data,
            iv: body.encryption_iv,
            algorithm: "AES-GCM-AAD-V1".into(),
        },
        &share_key,
    )
    .unwrap();
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(&shared_payload).unwrap()["category"],
        "login"
    );
    assert_eq!(body.access_mode, ShareAccessMode::EmailRestricted);
    assert_eq!(body.expires_in, ShareExpiration::SevenDays);
    assert!(body.is_one_time_use);
    assert_eq!(body.allowed_emails.unwrap(), ["reader@example.test"]);
}

#[tokio::test]
async fn share_payload_preserves_non_login_category_and_withholds_local_only_fields() {
    let executor = RecordingExecutor::seeded_share_item(
        AuthorityItemCategory::CreditCard,
        serde_json::json!({
            "title": "Travel card",
            "cardholderName": "A. Reader",
            "cardNumber": "4111111111111111",
            "cvv": "123",
            "expiryDate": "12/30",
            "billingAddress": "1 Cipher Lane",
            "customFields": [{ "id": "field", "label": "Label", "value": "Value", "type": "text" }],
            "tags": ["private"]
        }),
    );
    let (runtime, account_id) = unlocked_runtime(executor).await;

    let (operation_id, _, _) = accepted(
        runtime
            .request(
                RuntimeRequest::CreateShare {
                    account_id: account_id.clone(),
                    item_id: "item-existing".into(),
                    draft: CreateShareDraft {
                        access_mode: ShareAccessMode::Anyone,
                        expires_in: ShareExpiration::SevenDays,
                        is_one_time_use: false,
                        allowed_emails: Vec::new(),
                    },
                },
                RequestCancellation::new(),
            )
            .await
            .unwrap(),
    );
    let snapshot = runtime.replica().snapshot(&account_id).unwrap();
    let body: FrozenShareBody =
        serde_json::from_slice(&snapshot.operations[0].request.body).unwrap();
    let protected = &snapshot.share_capabilities[0];
    let capability: ShareCapabilityPlaintext = serde_json::from_str(
        &bittery_crypto_core::decrypt_share_capability(
            &EncryptedData {
                ciphertext: protected.ciphertext.clone(),
                iv: protected.iv.clone(),
                algorithm: protected.algorithm.clone(),
            },
            &TEST_MASTER_UNLOCK_KEY,
            &bittery_crypto_core::ShareCapabilityAadContext::new(
                account_id.as_str().into(),
                operation_id,
            )
            .unwrap(),
        )
        .unwrap(),
    )
    .unwrap();
    let share_key = BASE64.decode(capability.share_key).unwrap();
    let payload: serde_json::Value = serde_json::from_str(
        &bittery_crypto_core::decrypt(
            &EncryptedData {
                ciphertext: body.encrypted_item_data,
                iv: body.encryption_iv,
                algorithm: "AES-GCM-AAD-V1".into(),
            },
            &share_key,
        )
        .unwrap(),
    )
    .unwrap();

    assert_eq!(payload["category"], "credit-card");
    assert_eq!(payload["cardNumber"], "4111111111111111");
    assert_eq!(payload["customFields"][0]["value"], "Value");
    for forbidden in [
        "id",
        "vaultId",
        "favorite",
        "createdAt",
        "updatedAt",
        "passwordHistory",
        "passkeys",
        "tags",
        "linkedItemId",
    ] {
        assert!(
            payload.get(forbidden).is_none(),
            "{forbidden} leaked into Share payload"
        );
    }
}

#[tokio::test]
async fn share_rejects_authority_whose_plaintext_does_not_match_its_category() {
    let executor = RecordingExecutor::seeded_share_item(
        AuthorityItemCategory::CreditCard,
        serde_json::json!({
            "title": "Malformed card",
            "passwordHistory": [{ "password": "not-a-card-field" }]
        }),
    );
    let (runtime, account_id) = unlocked_runtime(executor).await;
    let error = runtime
        .request(
            RuntimeRequest::CreateShare {
                account_id,
                item_id: "item-existing".into(),
                draft: CreateShareDraft {
                    access_mode: ShareAccessMode::Anyone,
                    expires_in: ShareExpiration::OneDay,
                    is_one_time_use: false,
                    allowed_emails: vec![],
                },
            },
            RequestCancellation::new(),
        )
        .await
        .unwrap_err();
    assert_eq!(error.code, RuntimeErrorCode::InvariantViolation);
}

#[tokio::test]
async fn share_tokens_preserve_the_existing_32_character_ascii_alphanumeric_contract() {
    for _ in 0..48 {
        let executor = RecordingExecutor::seeded_attachment_free_item(false);
        let (runtime, account_id) = unlocked_runtime(executor).await;
        let (operation_id, _, _) = accepted(
            runtime
                .request(
                    RuntimeRequest::CreateShare {
                        account_id: account_id.clone(),
                        item_id: "item-existing".into(),
                        draft: CreateShareDraft {
                            access_mode: ShareAccessMode::Anyone,
                            expires_in: ShareExpiration::SevenDays,
                            is_one_time_use: false,
                            allowed_emails: Vec::new(),
                        },
                    },
                    RequestCancellation::new(),
                )
                .await
                .unwrap(),
        );
        let protected = &runtime
            .replica()
            .snapshot(&account_id)
            .unwrap()
            .share_capabilities[0];
        let plaintext = bittery_crypto_core::decrypt_share_capability(
            &EncryptedData {
                ciphertext: protected.ciphertext.clone(),
                iv: protected.iv.clone(),
                algorithm: protected.algorithm.clone(),
            },
            &TEST_MASTER_UNLOCK_KEY,
            &bittery_crypto_core::ShareCapabilityAadContext::new(
                account_id.as_str().into(),
                operation_id,
            )
            .unwrap(),
        )
        .unwrap();
        let capability: ShareCapabilityPlaintext = serde_json::from_str(&plaintext).unwrap();
        assert_eq!(capability.token.len(), 32);
        assert!(capability
            .token
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric()));
    }
}

#[test]
fn share_fingerprint_pins_the_no_precondition_operation_contract() {
    assert_eq!(
        share_operation_fingerprint("item-vector", br#"{"tokenHash":"abc"}"#)
            .0
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>(),
        "400c9732ad66ea68144f7e94890f7f2247fde40e45667e0ef89d590592c39f24"
    );
}

#[tokio::test]
async fn invalid_share_access_controls_are_rejected_before_any_durable_write() {
    for (access_mode, allowed_emails) in [
        (ShareAccessMode::Anyone, vec!["reader@example.test".into()]),
        (ShareAccessMode::EmailRestricted, Vec::new()),
        (
            ShareAccessMode::EmailRestricted,
            vec!["reader@extra@example.test".into()],
        ),
    ] {
        let executor = RecordingExecutor::seeded_attachment_free_item(false);
        let (runtime, account_id) = unlocked_runtime(executor).await;
        let error = runtime
            .request(
                RuntimeRequest::CreateShare {
                    account_id: account_id.clone(),
                    item_id: "item-existing".into(),
                    draft: CreateShareDraft {
                        access_mode,
                        expires_in: ShareExpiration::SevenDays,
                        is_one_time_use: false,
                        allowed_emails,
                    },
                },
                RequestCancellation::new(),
            )
            .await
            .unwrap_err();
        assert_eq!(error.code, RuntimeErrorCode::InvariantViolation);
        let snapshot = runtime.replica().snapshot(&account_id).unwrap();
        assert!(snapshot.operations.is_empty());
        assert!(snapshot.share_capabilities.is_empty());
    }
}

#[tokio::test]
async fn sign_out_destroys_protected_share_capabilities_without_discarding_operations() {
    let executor = RecordingExecutor::seeded_attachment_free_item(false);
    let runtime = Runtime::with_serialized_executors(
        executor.clone(),
        Arc::new(SuccessfulDeletePlatform),
        Arc::new(UnusedHttp),
    );
    runtime.open().await.unwrap();
    let account_id = AccountId::from(ACCOUNT);
    runtime.replica().load(&account_id).await.unwrap().unwrap();
    runtime.unlock_account(&account_id).await.unwrap();
    runtime
        .request(
            RuntimeRequest::CreateShare {
                account_id: account_id.clone(),
                item_id: "item-existing".into(),
                draft: CreateShareDraft {
                    access_mode: ShareAccessMode::Anyone,
                    expires_in: ShareExpiration::SevenDays,
                    is_one_time_use: false,
                    allowed_emails: Vec::new(),
                },
            },
            RequestCancellation::new(),
        )
        .await
        .unwrap();
    assert_eq!(
        runtime
            .replica()
            .snapshot(&account_id)
            .unwrap()
            .share_capabilities
            .len(),
        1
    );

    let response = runtime
        .request(
            RuntimeRequest::SignOut {
                account_id: account_id.clone(),
            },
            RequestCancellation::new(),
        )
        .await
        .unwrap();
    assert_eq!(
        response,
        RuntimeResponse::AccessChanged {
            account_id: account_id.clone(),
            access: AccountAccessState::SignedOut,
        }
    );

    let snapshot = runtime.replica().snapshot(&account_id).unwrap();
    assert!(snapshot.share_capabilities.is_empty());
    assert_eq!(
        snapshot.operations.len(),
        1,
        "Sign-out is not Operation discard"
    );

    drop(runtime);
    let restored = Runtime::with_serialized_replica_executor(executor);
    restored.replica().load(&account_id).await.unwrap().unwrap();
    let restored_snapshot = restored.replica().snapshot(&account_id).unwrap();
    assert!(restored_snapshot.share_capabilities.is_empty());
    assert_eq!(restored_snapshot.operations.len(), 1);
}

#[tokio::test]
async fn lock_hides_but_durably_retains_the_protected_share_capability() {
    let executor = RecordingExecutor::seeded_attachment_free_item(false);
    let (runtime, account_id) = unlocked_runtime(executor.clone()).await;
    runtime
        .request(
            RuntimeRequest::CreateShare {
                account_id: account_id.clone(),
                item_id: "item-existing".into(),
                draft: CreateShareDraft {
                    access_mode: ShareAccessMode::Anyone,
                    expires_in: ShareExpiration::SevenDays,
                    is_one_time_use: false,
                    allowed_emails: Vec::new(),
                },
            },
            RequestCancellation::new(),
        )
        .await
        .unwrap();
    let before = runtime.replica().snapshot(&account_id).unwrap();
    let capability = before.share_capabilities[0].clone();

    assert_eq!(
        runtime
            .request(
                RuntimeRequest::Lock {
                    account_id: account_id.clone(),
                },
                RequestCancellation::new(),
            )
            .await
            .unwrap(),
        RuntimeResponse::AccessChanged {
            account_id: account_id.clone(),
            access: AccountAccessState::Locked,
        }
    );
    assert!(!runtime.has_live_master_unlock_key(&account_id, &before.incarnation));
    let locked = runtime.replica().snapshot(&account_id).unwrap();
    assert_eq!(locked.share_capabilities, std::slice::from_ref(&capability));
    assert_eq!(locked.operations.len(), 1);

    drop(runtime);
    let restored = Runtime::with_serialized_replica_executor(executor);
    restored.replica().load(&account_id).await.unwrap().unwrap();
    assert_eq!(
        restored
            .replica()
            .snapshot(&account_id)
            .unwrap()
            .share_capabilities,
        [capability]
    );
}

#[tokio::test]
async fn failed_or_fenced_share_commit_never_leaves_half_an_acceptance() {
    let failing = RecordingExecutor::seeded_attachment_free_item(false);
    failing.fail_commits.store(true, Ordering::SeqCst);
    let (runtime, account_id) = unlocked_runtime(failing).await;
    assert_eq!(
        runtime
            .request(create_share(&account_id), RequestCancellation::new(),)
            .await
            .unwrap_err()
            .code,
        RuntimeErrorCode::InvariantViolation
    );
    let snapshot = runtime.replica().snapshot(&account_id).unwrap();
    assert!(snapshot.operations.is_empty());
    assert!(snapshot.share_capabilities.is_empty());

    let fenced = RecordingExecutor::seeded_attachment_free_item(false);
    fenced.fence_before_commit.store(true, Ordering::SeqCst);
    let (runtime, account_id) = unlocked_runtime(fenced).await;
    assert_eq!(
        runtime
            .request(create_share(&account_id), RequestCancellation::new(),)
            .await
            .unwrap_err()
            .code,
        RuntimeErrorCode::AuthenticationRequired
    );
    let snapshot = runtime.replica().snapshot(&account_id).unwrap();
    assert!(snapshot.operations.is_empty());
    assert!(snapshot.share_capabilities.is_empty());
    assert!(!runtime.has_live_master_unlock_key(&account_id, &snapshot.incarnation));
    let RuntimeProjection::RuntimeStatus(status) = runtime
        .projection(&ObservationRequest::RuntimeStatus {
            account_id: Some(account_id),
        })
        .unwrap()
        .projection
    else {
        panic!("expected Runtime status");
    };
    assert_eq!(status.accounts[0].access, AccountAccessState::Locked);
}

#[tokio::test]
async fn cancellation_after_atomic_share_commit_cannot_discard_either_durable_half() {
    let executor = RecordingExecutor::seeded_attachment_free_item(false);
    let cancellation = RequestCancellation::new();
    *executor.cancel_after_commit.lock().unwrap() = Some(cancellation.clone());
    let (runtime, account_id) = unlocked_runtime(executor).await;

    assert_eq!(
        runtime
            .request(create_share(&account_id), cancellation)
            .await
            .unwrap_err()
            .code,
        RuntimeErrorCode::Cancelled
    );
    let snapshot = runtime.replica().snapshot(&account_id).unwrap();
    assert_eq!(snapshot.operations.len(), 1);
    assert_eq!(snapshot.share_capabilities.len(), 1);
    assert_eq!(
        snapshot.operations[0].operation_id,
        snapshot.share_capabilities[0].operation_id
    );
}

#[tokio::test]
async fn accepted_share_wakes_the_generic_operation_dispatcher() {
    let executor = RecordingExecutor::seeded_attachment_free_item(false);
    let (runtime, account_id) = unlocked_runtime(executor).await;
    let waiting_runtime = Arc::clone(&runtime);
    let wake = tokio::spawn(async move {
        waiting_runtime.dispatch_wake.notified().await;
    });
    tokio::task::yield_now().await;

    runtime
        .request(create_share(&account_id), RequestCancellation::new())
        .await
        .unwrap();

    tokio::time::timeout(std::time::Duration::from_millis(100), wake)
        .await
        .expect("durable Share acceptance wakes the generic dispatcher")
        .unwrap();
}

#[tokio::test]
async fn share_queued_before_close_cannot_decrypt_or_persist_after_close_begins() {
    let executor = RecordingExecutor::seeded_attachment_free_item(false);
    let (runtime, account_id) = unlocked_runtime(executor.clone()).await;
    let execution_lock = runtime.account_execution_lock(&account_id).unwrap();
    let guard = execution_lock.lock().await;
    let request_runtime = Arc::clone(&runtime);
    let request_account = account_id.clone();
    let request = tokio::spawn(async move {
        request_runtime
            .request(create_share(&request_account), RequestCancellation::new())
            .await
    });
    tokio::task::yield_now().await;
    let close_runtime = Arc::clone(&runtime);
    let close = tokio::spawn(async move { close_runtime.close().await });
    while !runtime.is_closed() {
        tokio::task::yield_now().await;
    }
    drop(guard);

    assert_eq!(
        request.await.unwrap().unwrap_err().code,
        RuntimeErrorCode::RuntimeClosed
    );
    close.await.unwrap();
    let durable = executor.state.snapshot(&account_id).unwrap();
    assert!(durable.operations.is_empty());
    assert!(durable.share_capabilities.is_empty());
}

#[tokio::test]
async fn share_acceptance_rejects_retained_authority_until_bootstrap_is_ready() {
    let executor = RecordingExecutor::seeded_attachment_free_item(false);
    let (runtime, account_id) = unlocked_runtime(executor).await;
    let guard_for = |snapshot: &ReplicaSnapshot| BootstrapGuard {
        account_id: account_id.clone(),
        user_id: snapshot.user_id.clone(),
        incarnation: snapshot.incarnation.clone(),
        expected_replica_revision: snapshot.revision,
        expected_lock_epoch: snapshot.lock_epoch,
    };
    let ready = runtime.replica().snapshot(&account_id).unwrap();
    runtime
        .replica()
        .mark_refresh_required(MarkRefreshRequiredPlan {
            guard: guard_for(&ready),
        })
        .await
        .unwrap();
    let refresh = runtime.replica().snapshot(&account_id).unwrap();
    assert_eq!(refresh.bootstrap.state, ReplicaState::RefreshRequired);
    assert_eq!(
        runtime
            .request(create_share(&account_id), RequestCancellation::new(),)
            .await
            .unwrap_err()
            .code,
        RuntimeErrorCode::InvariantViolation
    );

    runtime
        .replica()
        .begin_bootstrap(BeginBootstrapPlan {
            guard: guard_for(&refresh),
            generation_id: BootstrapGenerationId("replacement".into()),
        })
        .await
        .unwrap();
    let bootstrapping = runtime.replica().snapshot(&account_id).unwrap();
    assert_eq!(bootstrapping.bootstrap.state, ReplicaState::Bootstrapping);
    assert_eq!(
        runtime
            .request(create_share(&account_id), RequestCancellation::new())
            .await
            .unwrap_err()
            .code,
        RuntimeErrorCode::InvariantViolation
    );
    assert!(bootstrapping.operations.is_empty());
    assert!(bootstrapping.share_capabilities.is_empty());
}

#[test]
fn share_plaintext_owner_recursively_wipes_nested_json_before_release() {
    let mut owner = create::ZeroizingJsonValue::new(serde_json::json!({
        "secret-key": ["secret-value", { "nested-key": "nested-value" }]
    }));

    assert_eq!(owner.wipe_now_for_test(), vec![0, 0, 0, 0]);
    assert!(owner.as_value().is_null());
}

#[tokio::test]
async fn share_admission_rejects_failed_exhausted_and_pending_account_state() {
    let failed_executor = RecordingExecutor::seeded_attachment_free_item(false);
    let (failed_runtime, account_id) = unlocked_runtime(failed_executor).await;
    let before = failed_runtime.replica().snapshot(&account_id).unwrap();
    let failed = failed_runtime
        .replica()
        .execute_recomputing(GuardedCommitPlan::new(
            account_id.clone(),
            before.incarnation,
            before.revision,
            before.lock_epoch,
            vec![PlanMutation::FailAccount {
                code: RuntimeErrorCode::InvariantViolation,
            }],
        ))
        .await
        .unwrap();
    let RecomputedPlanResult::Applied { snapshot } = failed else {
        panic!("failure fixture must apply");
    };
    failed_runtime.replica().cache(snapshot);
    assert_eq!(
        failed_runtime
            .request(create_share(&account_id), RequestCancellation::new())
            .await
            .unwrap_err()
            .code,
        RuntimeErrorCode::AccountFailed
    );

    let exhausted_executor = RecordingExecutor::seeded_attachment_free_item(false);
    let (exhausted_runtime, account_id) = unlocked_runtime(exhausted_executor.clone()).await;
    exhausted_executor
        .state
        .set_lock_epoch(&account_id, u64::MAX)
        .unwrap();
    exhausted_runtime
        .replica()
        .load(&account_id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        exhausted_runtime
            .request(create_share(&account_id), RequestCancellation::new())
            .await
            .unwrap_err()
            .code,
        RuntimeErrorCode::AuthenticationRequired
    );

    let pending_executor = RecordingExecutor::seeded_attachment_free_item(false);
    let (pending_runtime, account_id) = unlocked_runtime(pending_executor).await;
    pending_runtime
        .lock_epoch_pending
        .lock()
        .unwrap()
        .insert(account_id.clone(), 1);
    assert_eq!(
        pending_runtime
            .request(create_share(&account_id), RequestCancellation::new())
            .await
            .unwrap_err()
            .code,
        RuntimeErrorCode::InvariantViolation
    );
}

#[tokio::test]
async fn share_guard_uses_the_tracked_account_lock_epoch() {
    let executor = RecordingExecutor::seeded_attachment_free_item(false);
    let (runtime, account_id) = unlocked_runtime(executor).await;
    runtime
        .account_lock_epochs
        .lock()
        .unwrap()
        .insert(account_id.clone(), 7);

    assert_eq!(
        runtime
            .request(create_share(&account_id), RequestCancellation::new())
            .await
            .unwrap_err()
            .code,
        RuntimeErrorCode::AuthenticationRequired
    );
    let snapshot = runtime.replica().snapshot(&account_id).unwrap();
    assert!(snapshot.operations.is_empty());
    assert!(snapshot.share_capabilities.is_empty());
}

/// Opens ciphertext exactly the way the Bootstrap read path opens authoritative Items.
fn open_item(data: EncryptedData, vault_id: &str, item_id: &str) -> String {
    decrypt_with_aad(
        &data,
        &TEST_VAULT_KEY,
        &AadContext {
            vault_id: vault_id.to_owned(),
            entity_id: item_id.to_owned(),
            entity_type: "item".into(),
            version: 1,
            user_id: USER.to_owned(),
        },
    )
    .expect("the overlay opens under the existing Item AAD")
}

#[tokio::test]
async fn accepted_create_seals_the_draft_under_the_existing_item_aad() {
    let executor = RecordingExecutor::seeded();
    let (runtime, account_id) = unlocked_runtime(executor.clone()).await;

    let (operation_id, item_id, replica_revision) = accepted(
        runtime
            .request(
                create(&account_id, TEST_VAULT_ID),
                RequestCancellation::new(),
            )
            .await
            .unwrap(),
    );

    let snapshot = runtime.replica().snapshot(&account_id).unwrap();
    assert_eq!(snapshot.revision, replica_revision);
    assert_eq!(snapshot.operations.len(), 1);
    assert_eq!(snapshot.items.len(), 1);

    let operation = &snapshot.operations[0];
    assert_eq!(operation.operation_id, operation_id);
    assert_eq!(operation.kind, OperationKind::CreateItem);
    // One canonical Item ID binds the response, the route, the overlay, and the AAD. There is no
    // temporary identity anywhere in this path.
    assert_eq!(operation.item_id, item_id);
    assert_eq!(operation.vault_id, TEST_VAULT_ID);
    assert_eq!(
        operation.request.path,
        create_item_path(TEST_VAULT_ID, &item_id)
    );
    assert_eq!(operation.request.method, HttpMethod::Put);

    let body: CreateItemBody = serde_json::from_slice(&operation.request.body).unwrap();
    assert!(matches!(body.category, ItemCategory::Login));

    let overlay = &snapshot.items[0];
    assert_eq!(overlay.item_id, item_id);
    assert_eq!(overlay.operation_id, operation_id);
    assert_eq!(overlay.encrypted_by_user_id, USER);
    assert_eq!(overlay.encryption_version, 1);
    // The overlay and the request carry one ciphertext, so what the Server stores is what the
    // Device already reads.
    assert_eq!(overlay.encrypted_data, body.encrypted_data);
    assert_eq!(overlay.encryption_iv, body.encryption_iv);
    assert_eq!(overlay.encryption_algorithm, body.encryption_algorithm);

    let opened = open_item(
        EncryptedData {
            ciphertext: overlay.encrypted_data.clone(),
            iv: overlay.encryption_iv.clone(),
            algorithm: overlay.encryption_algorithm.clone(),
        },
        TEST_VAULT_ID,
        &item_id,
    );
    assert_eq!(opened, create::item_plaintext(&draft()).unwrap());

    // The AAD is bound to this exact Item, so the same ciphertext under another Item ID fails.
    assert!(decrypt_with_aad(
        &EncryptedData {
            ciphertext: overlay.encrypted_data.clone(),
            iv: overlay.encryption_iv.clone(),
            algorithm: overlay.encryption_algorithm.clone(),
        },
        &TEST_VAULT_KEY,
        &AadContext {
            vault_id: TEST_VAULT_ID.into(),
            entity_id: "another-item".into(),
            entity_type: "item".into(),
            version: 1,
            user_id: USER.into(),
        },
    )
    .is_err());

    let projection = match runtime
        .projection(&ObservationRequest::Items {
            account_id: account_id.clone(),
        })
        .unwrap()
        .projection
    {
        RuntimeProjection::Items(items) => items,
        other => panic!("expected an Items projection, got {other:?}"),
    };
    assert_eq!(projection.items.len(), 1);
    assert_eq!(projection.items[0].item_id, item_id);
    assert_eq!(projection.items[0].status, ItemProjectionStatus::Pending);
    assert_eq!(projection.items[0].data.title(), TITLE);
}

#[tokio::test]
async fn create_acceptance_preserves_each_closed_item_category_and_server_totp_spelling() {
    use crate::{AuthenticatorItemData, CreditCardItemData, IdentityItemData, SecureNoteItemData};
    let cases = vec![
        (draft(), ItemCategory::Login, AuthorityItemCategory::Login),
        (
            ItemDraft::SecureNote(SecureNoteItemData {
                title: "Note".into(),
                note: "Body".into(),
                notes: Some("Provider notes".into()),
                custom_fields: vec![],
                tags: vec!["tag".into()],
            }),
            ItemCategory::SecureNote,
            AuthorityItemCategory::SecureNote,
        ),
        (
            ItemDraft::CreditCard(CreditCardItemData {
                title: "Card".into(),
                cardholder_name: Some("Holder".into()),
                card_number: Some("4111".into()),
                cvv: Some("123".into()),
                expiry_date: Some("12/30".into()),
                billing_address: Some("Address".into()),
                notes: Some("Notes".into()),
                custom_fields: vec![],
                totp_secret: Some("card-totp".into()),
                totp_issuer: Some("Issuer".into()),
                totp_account_name: Some("Card".into()),
                totp_algorithm: Some(crate::TotpAlgorithm::Sha1),
                totp_digits: Some(crate::TotpDigits::Six),
                totp_period: Some(30),
                tags: vec!["tag".into()],
            }),
            ItemCategory::CreditCard,
            AuthorityItemCategory::CreditCard,
        ),
        (
            ItemDraft::Identity(IdentityItemData {
                title: "Identity".into(),
                first_name: Some("First".into()),
                middle_name: None,
                last_name: Some("Last".into()),
                email: Some("id@example.test".into()),
                addresses: vec![],
                phone_numbers: vec![],
                ssn: Some("ssn".into()),
                passport_number: None,
                drivers_license: None,
                date_of_birth: None,
                notes: Some("Notes".into()),
                custom_fields: vec![],
                totp_secret: Some("identity-totp".into()),
                totp_issuer: Some("Issuer".into()),
                totp_account_name: Some("Identity".into()),
                totp_algorithm: Some(crate::TotpAlgorithm::Sha256),
                totp_digits: Some(crate::TotpDigits::Eight),
                totp_period: Some(60),
                tags: vec!["tag".into()],
            }),
            ItemCategory::Identity,
            AuthorityItemCategory::Identity,
        ),
        (
            ItemDraft::Authenticator(AuthenticatorItemData {
                title: "Authenticator".into(),
                totp_secret: "secret".into(),
                totp_issuer: Some("Issuer".into()),
                totp_account_name: Some("Account".into()),
                totp_algorithm: None,
                totp_digits: Some(crate::TotpDigits::Six),
                totp_period: Some(30),
                linked_item_id: Some("login-id".into()),
                notes: Some("Notes".into()),
                custom_fields: vec![],
                tags: vec!["tag".into()],
            }),
            ItemCategory::Totp,
            AuthorityItemCategory::Totp,
        ),
    ];
    for (draft, server_category, authority_category) in cases {
        let executor = RecordingExecutor::seeded();
        let (runtime, account_id) = unlocked_runtime(executor).await;
        let (_, item_id, _) = accepted(
            runtime
                .request(
                    RuntimeRequest::CreateItem {
                        account_id: account_id.clone(),
                        vault_id: TEST_VAULT_ID.into(),
                        draft: draft.clone(),
                    },
                    RequestCancellation::new(),
                )
                .await
                .unwrap(),
        );
        let snapshot = runtime.replica().snapshot(&account_id).unwrap();
        let body: CreateItemBody =
            serde_json::from_slice(&snapshot.operations[0].request.body).unwrap();
        assert_eq!(
            serde_json::to_value(&body.category).unwrap(),
            serde_json::to_value(&server_category).unwrap()
        );
        assert_eq!(snapshot.items[0].category, authority_category);
        assert_eq!(
            open_item(
                EncryptedData {
                    ciphertext: body.encrypted_data,
                    iv: body.encryption_iv,
                    algorithm: body.encryption_algorithm
                },
                TEST_VAULT_ID,
                &item_id
            ),
            create::item_plaintext(&draft).unwrap()
        );
        let RuntimeProjection::Items(items) = runtime
            .projection(&ObservationRequest::Items { account_id })
            .unwrap()
            .projection
        else {
            panic!("expected Items")
        };
        assert_eq!(items.items[0].data, draft);
    }
}

#[tokio::test]
async fn category_independent_item_acceptance_has_no_login_admission_guard() {
    let cases = vec![
        (
            AuthorityItemCategory::Login,
            ItemDraft::Login(LoginItemData {
                title: "Login".into(),
                url: None,
                urls: vec![],
                username: None,
                password: None,
                password_history: vec![],
                passkeys: vec![],
                notes: None,
                note: None,
                custom_fields: vec![],
                tags: vec![],
                totp_secret: None,
                totp_issuer: None,
                totp_account_name: None,
                totp_algorithm: None,
                totp_digits: None,
                totp_period: None,
            }),
        ),
        (
            AuthorityItemCategory::SecureNote,
            ItemDraft::SecureNote(crate::SecureNoteItemData {
                title: "Note".into(),
                note: "Body".into(),
                notes: None,
                custom_fields: vec![],
                tags: vec![],
            }),
        ),
        (
            AuthorityItemCategory::CreditCard,
            ItemDraft::CreditCard(crate::CreditCardItemData {
                title: "Card".into(),
                cardholder_name: None,
                card_number: None,
                cvv: None,
                expiry_date: None,
                billing_address: None,
                notes: None,
                custom_fields: vec![],
                totp_secret: None,
                totp_issuer: None,
                totp_account_name: None,
                totp_algorithm: None,
                totp_digits: None,
                totp_period: None,
                tags: vec![],
            }),
        ),
        (
            AuthorityItemCategory::Identity,
            ItemDraft::Identity(crate::IdentityItemData {
                title: "Identity".into(),
                first_name: None,
                middle_name: None,
                last_name: None,
                email: None,
                addresses: vec![],
                phone_numbers: vec![],
                ssn: None,
                passport_number: None,
                drivers_license: None,
                date_of_birth: None,
                notes: None,
                custom_fields: vec![],
                totp_secret: None,
                totp_issuer: None,
                totp_account_name: None,
                totp_algorithm: None,
                totp_digits: None,
                totp_period: None,
                tags: vec![],
            }),
        ),
        (
            AuthorityItemCategory::Totp,
            ItemDraft::Authenticator(crate::AuthenticatorItemData {
                title: "Authenticator".into(),
                totp_secret: "secret".into(),
                totp_issuer: None,
                totp_account_name: None,
                totp_algorithm: None,
                totp_digits: None,
                totp_period: None,
                linked_item_id: None,
                notes: None,
                custom_fields: vec![],
                tags: vec![],
            }),
        ),
    ];
    for (category, draft) in cases {
        for action in [
            RemainingKindCase::Update,
            RemainingKindCase::Favorite,
            RemainingKindCase::Trash,
            RemainingKindCase::Restore,
            RemainingKindCase::Move,
            RemainingKindCase::PermanentlyDelete,
        ] {
            let plaintext = serde_json::from_str(&create::item_plaintext(&draft).unwrap()).unwrap();
            let executor = RecordingExecutor::seeded_category_item(
                category.clone(),
                plaintext,
                action.needs_deleted_authority(),
            );
            let (runtime, account_id) = unlocked_runtime(executor).await;
            let request = match action {
                RemainingKindCase::Update => RuntimeRequest::UpdateItem {
                    account_id,
                    item_id: "item-existing".into(),
                    draft: draft.clone(),
                },
                _ => action.request(account_id),
            };
            assert!(matches!(
                runtime
                    .request(request, RequestCancellation::new())
                    .await
                    .unwrap(),
                RuntimeResponse::Accepted { .. }
            ));
        }

        let plaintext = serde_json::from_str(&create::item_plaintext(&draft).unwrap()).unwrap();
        let executor = RecordingExecutor::seeded_category_item(category, plaintext, false);
        let (runtime, account_id) = unlocked_runtime(executor).await;
        assert!(matches!(
            runtime
                .request(
                    RuntimeRequest::CreateShare {
                        account_id,
                        item_id: "item-existing".into(),
                        draft: CreateShareDraft {
                            access_mode: ShareAccessMode::Anyone,
                            expires_in: ShareExpiration::OneDay,
                            is_one_time_use: false,
                            allowed_emails: vec![],
                        },
                    },
                    RequestCancellation::new(),
                )
                .await
                .unwrap(),
            RuntimeResponse::Accepted { .. }
        ));
    }
}

#[tokio::test]
async fn the_persisted_plan_carries_no_plaintext_and_no_credential() {
    let executor = RecordingExecutor::seeded();
    let (runtime, account_id) = unlocked_runtime(executor.clone()).await;
    let (_, item_id, _) = accepted(
        runtime
            .request(
                create(&account_id, TEST_VAULT_ID),
                RequestCancellation::new(),
            )
            .await
            .unwrap(),
    );

    let recorded = executor.recorded();
    assert!(recorded
        .iter()
        .any(|request| request.contains(&item_id) && request.contains("\"commit\"")));
    for request in &recorded {
        for marker in plaintext_markers() {
            assert!(
                !request.contains(marker),
                "durable plan leaked the plaintext marker {marker}"
            );
        }
        let lowered = request.to_ascii_lowercase();
        assert!(!lowered.contains("authorization"));
        assert!(!lowered.contains("bearer"));
        assert!(!lowered.contains("cookie"));
    }

    let operation = runtime.replica().snapshot(&account_id).unwrap().operations[0].clone();
    assert_eq!(
        operation.request.headers,
        vec![HttpHeader {
            name: "Content-Type".to_owned(),
            value: "application/json".to_owned(),
        }]
    );
}

#[tokio::test]
async fn the_replica_refuses_durable_request_bytes_that_carry_a_credential() {
    let executor = RecordingExecutor::seeded();
    let (runtime, account_id) = unlocked_runtime(executor.clone()).await;
    let snapshot = runtime.replica().snapshot(&account_id).unwrap();
    let mut operation = crate::test_fixtures::test_operation("operation-1", "item-1");
    operation.request.headers.push(HttpHeader {
        name: "Authorization".to_owned(),
        value: "Bearer token".to_owned(),
    });

    let error = runtime
        .execute_plan(GuardedCommitPlan::new(
            account_id.clone(),
            snapshot.incarnation,
            snapshot.revision,
            snapshot.lock_epoch,
            vec![PlanMutation::AcceptOperation(operation)],
        ))
        .await
        .unwrap_err();

    assert_eq!(error.code, RuntimeErrorCode::InvariantViolation);
    assert!(runtime
        .replica()
        .snapshot(&account_id)
        .unwrap()
        .operations
        .is_empty());
}

#[tokio::test]
async fn immutable_bytes_and_fingerprint_are_identical_after_a_restart() {
    let executor = RecordingExecutor::seeded();
    let (runtime, account_id) = unlocked_runtime(executor.clone()).await;
    let (operation_id, item_id, _) = accepted(
        runtime
            .request(
                create(&account_id, TEST_VAULT_ID),
                RequestCancellation::new(),
            )
            .await
            .unwrap(),
    );
    let before = runtime.replica().snapshot(&account_id).unwrap().operations[0].clone();
    runtime.close().await;
    drop(runtime);

    let restarted = Runtime::with_serialized_replica_executor(executor);
    let after = restarted
        .replica()
        .load(&account_id)
        .await
        .unwrap()
        .unwrap()
        .operations[0]
        .clone();

    // Round tripping through the durable wire reproduces the request byte for byte, including its
    // header order, so a later attempt cannot silently send different bytes.
    assert_eq!(after, before);
    assert_eq!(after.request.body, before.request.body);
    assert_eq!(after.request.headers, before.request.headers);
    assert_eq!(after.request_fingerprint, before.request_fingerprint);

    // The fingerprint covers the request, so it is reproducible from the stored bytes alone and
    // never from the Operation ID.
    assert_eq!(
        after.request_fingerprint,
        create_item_fingerprint(TEST_VAULT_ID, &item_id, &after.request.body)
    );
    let mut other_body = after.request.body.clone();
    other_body.push(b' ');
    assert_ne!(
        after.request_fingerprint,
        create_item_fingerprint(TEST_VAULT_ID, &item_id, &other_body)
    );
    assert!(!hex(after.request_fingerprint).contains(&operation_id));
}

fn hex(fingerprint: crate::replica::Sha256Fingerprint) -> String {
    serde_json::to_value(fingerprint)
        .unwrap()
        .as_str()
        .unwrap()
        .to_owned()
}

#[tokio::test]
async fn a_failed_commit_never_answers_accepted() {
    let executor = RecordingExecutor::seeded();
    let (runtime, account_id) = unlocked_runtime(executor.clone()).await;
    executor.fail_commits.store(true, Ordering::SeqCst);

    let error = runtime
        .request(
            create(&account_id, TEST_VAULT_ID),
            RequestCancellation::new(),
        )
        .await
        .unwrap_err();

    assert_eq!(error.code, RuntimeErrorCode::InvariantViolation);
    let snapshot = runtime.replica().snapshot(&account_id).unwrap();
    assert!(snapshot.operations.is_empty());
    assert!(snapshot.items.is_empty());
    let projection = match runtime
        .projection(&ObservationRequest::Items {
            account_id: account_id.clone(),
        })
        .unwrap()
        .projection
    {
        RuntimeProjection::Items(items) => items,
        other => panic!("expected an Items projection, got {other:?}"),
    };
    assert!(projection.items.is_empty());
}

#[tokio::test]
async fn create_requires_an_unlocked_account_a_ready_replica_and_a_writable_personal_vault() {
    let executor = RecordingExecutor::seeded();
    let (runtime, account_id) = unlocked_runtime(executor.clone()).await;

    let unknown_vault = runtime
        .request(
            create(&account_id, "vault-unknown"),
            RequestCancellation::new(),
        )
        .await
        .unwrap_err();
    assert_eq!(unknown_vault.code, RuntimeErrorCode::InvariantViolation);

    runtime
        .request(
            RuntimeRequest::Lock {
                account_id: account_id.clone(),
            },
            RequestCancellation::new(),
        )
        .await
        .unwrap();
    let locked = runtime
        .request(
            create(&account_id, TEST_VAULT_ID),
            RequestCancellation::new(),
        )
        .await
        .unwrap_err();
    assert_eq!(locked.code, RuntimeErrorCode::AuthenticationRequired);
    assert!(runtime
        .replica()
        .snapshot(&account_id)
        .unwrap()
        .operations
        .is_empty());

    // A cold Replica has no authoritative Vault to write into yet.
    let cold = InMemoryReplica::default();
    let cold_account = AccountId::from("account-cold");
    cold.install(
        cold_account.clone(),
        USER.to_owned(),
        Incarnation::from(INCARNATION),
    )
    .unwrap();
    let cold_runtime = Runtime::with_serialized_replica_executor(Arc::new(PlainExecutor(cold)));
    cold_runtime
        .replica()
        .load(&cold_account)
        .await
        .unwrap()
        .unwrap();
    cold_runtime.unlock_account(&cold_account).await.unwrap();
    let cold_error = cold_runtime
        .request(
            create(&cold_account, TEST_VAULT_ID),
            RequestCancellation::new(),
        )
        .await
        .unwrap_err();
    assert_eq!(cold_error.code, RuntimeErrorCode::InvariantViolation);
}

#[tokio::test]
async fn a_team_vault_and_a_read_only_vault_are_refused() {
    for (label, mutate) in [
        (
            "team",
            Box::new(|vault: &mut crate::replica::AuthorityVaultRecord| {
                vault.vault_type = AuthorityVaultType::Team;
            }) as Box<dyn Fn(&mut crate::replica::AuthorityVaultRecord)>,
        ),
        (
            "read only",
            Box::new(|vault: &mut crate::replica::AuthorityVaultRecord| {
                vault.role = AuthorityVaultRole::ReadOnly;
            }),
        ),
    ] {
        let state = InMemoryReplica::default();
        let account_id = AccountId::from(ACCOUNT);
        state
            .install(
                account_id.clone(),
                USER.to_owned(),
                Incarnation::from(INCARNATION),
            )
            .unwrap();
        let mut vault = personal_vault(TEST_VAULT_ID, USER);
        mutate(&mut vault);
        state.seed_ready_personal_vault(&account_id, vault).unwrap();
        let runtime = Runtime::with_serialized_replica_executor(Arc::new(PlainExecutor(state)));
        runtime.replica().load(&account_id).await.unwrap().unwrap();
        runtime.unlock_account(&account_id).await.unwrap();

        let error = runtime
            .request(
                create(&account_id, TEST_VAULT_ID),
                RequestCancellation::new(),
            )
            .await
            .unwrap_err();
        assert_eq!(
            error.code,
            RuntimeErrorCode::InvariantViolation,
            "a {label} Vault must be refused"
        );
        assert!(runtime
            .replica()
            .snapshot(&account_id)
            .unwrap()
            .operations
            .is_empty());
    }
}

#[tokio::test]
async fn each_create_mints_a_new_identity_and_one_item_owes_one_operation() {
    let executor = RecordingExecutor::seeded();
    let (runtime, account_id) = unlocked_runtime(executor.clone()).await;
    let (first_operation, first_item, _) = accepted(
        runtime
            .request(
                create(&account_id, TEST_VAULT_ID),
                RequestCancellation::new(),
            )
            .await
            .unwrap(),
    );
    let (second_operation, second_item, _) = accepted(
        runtime
            .request(
                create(&account_id, TEST_VAULT_ID),
                RequestCancellation::new(),
            )
            .await
            .unwrap(),
    );
    assert_ne!(first_operation, second_operation);
    assert_ne!(first_item, second_item);

    let snapshot = runtime.replica().snapshot(&account_id).unwrap();
    assert_eq!(snapshot.operations.len(), 2);
    let conflicting = OperationRecord {
        operation_id: "operation-conflicting".into(),
        ..snapshot.operations[0].clone()
    };
    let error = runtime
        .execute_plan(GuardedCommitPlan::new(
            account_id.clone(),
            snapshot.incarnation,
            snapshot.revision,
            snapshot.lock_epoch,
            vec![PlanMutation::AcceptOperation(conflicting)],
        ))
        .await
        .unwrap_err();
    assert_eq!(error.code, RuntimeErrorCode::InvariantViolation);
}

/// An executor with no injected behavior, for fixtures that only need durable state.
struct PlainExecutor(InMemoryReplica);

#[async_trait]
impl SerializedReplicaExecutor for PlainExecutor {
    async fn invoke(&self, request_json: String) -> Result<String, RuntimeError> {
        let request: ReplicaPersistenceRequest = serde_json::from_str(&request_json).unwrap();
        serde_json::to_string(&self.0.invoke(request).await?).map_err(|_| {
            RuntimeError::new(
                RuntimeErrorCode::InvariantViolation,
                "plain fake response could not be serialized",
            )
        })
    }
}

// ---------------------------------------------------------------- slice D: what the host sees

/// What an Items observer would receive right now, without opening one.
fn visible(runtime: &Runtime, account_id: &AccountId) -> ItemsProjection {
    match runtime
        .projection(&ObservationRequest::Items {
            account_id: account_id.clone(),
        })
        .expect("an unlocked Account projects Items")
        .projection
    {
        RuntimeProjection::Items(items) => items,
        other => panic!("expected an Items projection, got {other:?}"),
    }
}

#[tokio::test]
async fn an_offline_create_is_visible_as_pending_at_once_and_after_a_restart() {
    // This executor has no transport at all, so nothing can reach a Server here by construction.
    let executor = RecordingExecutor::seeded();
    let (runtime, account_id) = unlocked_runtime(executor.clone()).await;

    let (_, item_id, _) = accepted(
        runtime
            .request(
                create(&account_id, TEST_VAULT_ID),
                RequestCancellation::new(),
            )
            .await
            .unwrap(),
    );

    let before = visible(&runtime, &account_id).items;
    assert_eq!(before.len(), 1, "the accepted Item is visible at once");
    assert_eq!(before[0].item_id, item_id);
    assert_eq!(before[0].data.title(), TITLE);
    assert_eq!(before[0].status, ItemProjectionStatus::Pending);
    // A list that sorts by time has to be able to read these. An empty string is not a date.
    assert!(
        !before[0].created_at.is_empty(),
        "a pending Item has a date"
    );
    assert_eq!(before[0].updated_at, before[0].created_at);
    let created_at = before[0].created_at.clone();

    // A killed Worker never gets to close politely, so this restart does not either.
    drop(runtime);

    let restarted = Runtime::with_serialized_replica_executor(executor);
    restarted
        .replica()
        .load(&account_id)
        .await
        .unwrap()
        .unwrap();
    restarted.unlock_account(&account_id).await.unwrap();

    let after = visible(&restarted, &account_id).items;
    assert_eq!(after.len(), 1, "the restarted process still shows the Item");
    assert_eq!(after[0].item_id, item_id);
    assert_eq!(after[0].data.title(), TITLE);
    assert_eq!(after[0].status, ItemProjectionStatus::Pending);
    // The date is durable too: a restart must not reshuffle a list that sorts by it.
    assert_eq!(after[0].created_at, created_at);
}

#[tokio::test]
async fn the_items_projection_names_the_vaults_a_host_may_offer() {
    let executor = RecordingExecutor::seeded();
    let (runtime, account_id) = unlocked_runtime(executor).await;

    let vaults = visible(&runtime, &account_id).vaults;
    assert_eq!(vaults.len(), 1);
    assert_eq!(vaults[0].vault_id, TEST_VAULT_ID);
    assert_eq!(vaults[0].name, "Personal");
    assert_eq!(vaults[0].vault_type, VaultProjectionType::Personal);
    assert_eq!(
        vaults[0].role,
        VaultProjectionRole::Owner,
        "an owned personal Vault is where a create goes"
    );
}

#[tokio::test]
async fn a_read_only_vault_is_projected_as_one() {
    let state = InMemoryReplica::default();
    let account_id = AccountId::from(ACCOUNT);
    state
        .install(
            account_id.clone(),
            USER.to_owned(),
            Incarnation::from(INCARNATION),
        )
        .unwrap();
    let mut vault = personal_vault(TEST_VAULT_ID, USER);
    vault.role = AuthorityVaultRole::ReadOnly;
    state.seed_ready_personal_vault(&account_id, vault).unwrap();
    let runtime = Runtime::with_serialized_replica_executor(Arc::new(PlainExecutor(state)));
    runtime.replica().load(&account_id).await.unwrap().unwrap();
    runtime.unlock_account(&account_id).await.unwrap();

    let vaults = visible(&runtime, &account_id).vaults;
    assert_eq!(vaults.len(), 1);
    assert_eq!(
        vaults[0].role,
        VaultProjectionRole::ReadOnly,
        "the same refusal the create path makes, before the user tries"
    );
}

#[derive(Clone, Copy)]
enum RemainingKindCase {
    Update,
    Favorite,
    Trash,
    Restore,
    Move,
    PermanentlyDelete,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ExpectedUpdateBody<'a> {
    encrypted_data: &'a str,
    encryption_algorithm: &'a str,
    encryption_iv: &'a str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ExpectedMoveBody<'a> {
    mode: &'a str,
    attachments: &'a [()],
    encrypted_data: &'a str,
    encryption_algorithm: &'a str,
    encryption_iv: &'a str,
    source_vault_id: &'a str,
    target_vault_id: &'a str,
}

impl RemainingKindCase {
    fn operation_kind(self) -> OperationKind {
        match self {
            Self::Update => OperationKind::UpdateItem,
            Self::Favorite => OperationKind::SetItemFavorite,
            Self::Trash => OperationKind::TrashItem,
            Self::Restore => OperationKind::RestoreItem,
            Self::Move => OperationKind::MoveItem,
            Self::PermanentlyDelete => OperationKind::PermanentlyDeleteItem,
        }
    }

    fn needs_deleted_authority(self) -> bool {
        matches!(self, Self::Restore | Self::PermanentlyDelete)
    }

    fn request(self, account_id: AccountId) -> RuntimeRequest {
        match self {
            Self::Update => RuntimeRequest::UpdateItem {
                account_id,
                item_id: "item-existing".into(),
                draft: draft(),
            },
            Self::Favorite => RuntimeRequest::SetItemFavorite {
                account_id,
                item_id: "item-existing".into(),
                favorite: true,
            },
            Self::Trash => RuntimeRequest::TrashItem {
                account_id,
                item_id: "item-existing".into(),
            },
            Self::Restore => RuntimeRequest::RestoreItem {
                account_id,
                item_id: "item-existing".into(),
            },
            Self::Move => RuntimeRequest::MoveItem {
                account_id,
                item_id: "item-existing".into(),
                target_vault_id: "vault-2".into(),
            },
            Self::PermanentlyDelete => RuntimeRequest::PermanentlyDeleteItem {
                account_id,
                item_id: "item-existing".into(),
            },
        }
    }

    fn method(self) -> HttpMethod {
        match self {
            Self::Update | Self::Favorite => HttpMethod::Patch,
            Self::Trash | Self::PermanentlyDelete => HttpMethod::Delete,
            Self::Restore | Self::Move => HttpMethod::Post,
        }
    }

    fn route(self) -> &'static str {
        match self {
            Self::Update => "PATCH /api/v1/items/{itemId}",
            Self::Favorite => "PATCH /api/v1/items/{itemId}/favorite",
            Self::Trash => "DELETE /api/v1/items/{itemId}",
            Self::Restore => "POST /api/v1/items/{itemId}/restore",
            Self::Move => "POST /api/v1/items/{itemId}/moves",
            Self::PermanentlyDelete => "DELETE /api/v1/items/{itemId}/permanent",
        }
    }

    fn path(self) -> &'static str {
        match self {
            Self::Update | Self::Trash => "/api/v1/items/item-existing",
            Self::Favorite => "/api/v1/items/item-existing/favorite",
            Self::Restore => "/api/v1/items/item-existing/restore",
            Self::Move => "/api/v1/items/item-existing/moves",
            Self::PermanentlyDelete => "/api/v1/items/item-existing/permanent",
        }
    }
}

fn server_fingerprint_oracle(case: RemainingKindCase, body: &[u8]) -> [u8; 32] {
    let kind = match case {
        RemainingKindCase::Update => "update_item",
        RemainingKindCase::Favorite => "set_item_favorite",
        RemainingKindCase::Trash => "trash_item",
        RemainingKindCase::Restore => "restore_item",
        RemainingKindCase::Move => "move_item",
        RemainingKindCase::PermanentlyDelete => "permanently_delete_item",
    };
    let mut hasher = Sha256::new();
    for part in [
        b"bittery.operation.v1".as_slice(),
        kind.as_bytes(),
        case.route().as_bytes(),
        b"item-existing".as_slice(),
        body,
        b"1".as_slice(),
    ] {
        hasher.update((part.len() as u64).to_be_bytes());
        hasher.update(part);
    }
    hasher.finalize().into()
}

#[test]
fn each_existing_kind_fingerprint_matches_a_hard_coded_server_golden() {
    let vectors = [
        (
            OperationKind::UpdateItem,
            "PATCH /api/v1/items/{itemId}",
            br#"{"encryptedData":"ciphertext","encryptionAlgorithm":"AES-GCM-AAD-V1","encryptionIv":"iv"}"#.as_slice(),
            "1f2ae15b71f2da0ed484842fad92dbf6e4627932ad6a2e35761828a711bb7182",
        ),
        (
            OperationKind::SetItemFavorite,
            "PATCH /api/v1/items/{itemId}/favorite",
            br#"{"favorite":true}"#.as_slice(),
            "af3caea85a9c7abb2ad3d9fc5daa3a903e4d894a405676c99dad20c559bed7a2",
        ),
        (
            OperationKind::TrashItem,
            "DELETE /api/v1/items/{itemId}",
            b"".as_slice(),
            "d80c08c437b26fea3c0daa5392f301b78b1978c9706dd984a5f4bcc404ece05f",
        ),
        (
            OperationKind::RestoreItem,
            "POST /api/v1/items/{itemId}/restore",
            b"".as_slice(),
            "0847e9d09821b6ae91213f82b5c7adaca632c37718c16e3d32eb3eba9278a60a",
        ),
        (
            OperationKind::MoveItem,
            "POST /api/v1/items/{itemId}/moves",
            br#"{"mode":"prepared","attachments":[],"encryptedData":"ciphertext","encryptionAlgorithm":"AES-GCM-AAD-V1","encryptionIv":"iv","sourceVaultId":"vault-1","targetVaultId":"vault-2"}"#.as_slice(),
            "cc7a4ffb43607c650da7c16a94df1910844f230b51d4edb2518bd6f2edb0ce58",
        ),
        (
            OperationKind::PermanentlyDeleteItem,
            "DELETE /api/v1/items/{itemId}/permanent",
            b"".as_slice(),
            "a3294061261daa2636c44ef675eab7cfbc3589d90e0876b71c9d3fbe984649ac",
        ),
    ];
    for (kind, route, body, expected) in vectors {
        assert_eq!(
            hex(create::item_operation_fingerprint(
                kind,
                route,
                "item-golden",
                body,
                7,
            )),
            expected,
        );
    }
}

fn assert_remaining_projection(case: RemainingKindCase, projection: &ItemsProjection) {
    match case {
        RemainingKindCase::Favorite => assert!(projection.items[0].favorite),
        RemainingKindCase::Trash => assert!(projection.items[0].deleted_at.is_some()),
        RemainingKindCase::Restore => assert!(projection.items[0].deleted_at.is_none()),
        RemainingKindCase::Move => assert_eq!(projection.items[0].vault_id, "vault-2"),
        RemainingKindCase::PermanentlyDelete => assert!(projection.items.is_empty()),
        RemainingKindCase::Update => assert_eq!(projection.items[0].data.title(), TITLE),
    }
}

#[tokio::test]
async fn remaining_item_kinds_are_durably_accepted_under_explicit_account_scope() {
    let cases = [
        RemainingKindCase::Update,
        RemainingKindCase::Favorite,
        RemainingKindCase::Trash,
        RemainingKindCase::Restore,
        RemainingKindCase::Move,
        RemainingKindCase::PermanentlyDelete,
    ];
    for case in cases {
        let fixture = |deleted| match case {
            RemainingKindCase::Move => RecordingExecutor::seeded_attachment_free_item(deleted),
            _ => RecordingExecutor::seeded_with_item(deleted),
        };
        let failed_executor = fixture(case.needs_deleted_authority());
        let (failed_runtime, failed_account_id) = unlocked_runtime(failed_executor.clone()).await;
        failed_executor.fail_commits.store(true, Ordering::SeqCst);
        assert!(failed_runtime
            .request(
                case.request(failed_account_id.clone()),
                RequestCancellation::new(),
            )
            .await
            .is_err());
        let failed_snapshot = failed_runtime
            .replica()
            .snapshot(&failed_account_id)
            .unwrap();
        assert!(failed_snapshot.operations.is_empty());
        assert!(failed_snapshot.items.is_empty());

        let executor = fixture(case.needs_deleted_authority());
        let (runtime, account_id) = unlocked_runtime(executor.clone()).await;
        let (_, item_id, revision) = accepted(
            runtime
                .request(case.request(account_id.clone()), RequestCancellation::new())
                .await
                .unwrap(),
        );
        assert_eq!(item_id, "item-existing");
        let snapshot = runtime.replica().snapshot(&account_id).unwrap();
        assert_eq!(snapshot.revision, revision);
        assert_eq!(snapshot.operations.len(), 1);
        assert_eq!(snapshot.items.len(), 1);
        let operation = snapshot.operations[0].clone();
        let overlay = snapshot.items[0].clone();
        assert_eq!(operation.kind, case.operation_kind());
        assert_eq!(operation.item_id, "item-existing");
        assert_eq!(operation.request.method, case.method());
        assert_eq!(operation.request.path, case.path());
        assert_eq!(overlay.version, 2);
        assert!(operation
            .request
            .headers
            .iter()
            .any(|header| header.name == "If-Match" && header.value == "\"1\""));
        assert_eq!(
            operation.request_fingerprint.0,
            server_fingerprint_oracle(case, &operation.request.body),
        );
        match case {
            RemainingKindCase::Update => {
                assert_eq!(operation.request.headers.len(), 2);
                assert_eq!(operation.request.headers[0].name, "Content-Type");
                assert_eq!(
                    operation.request.headers[0].value,
                    "application/merge-patch+json"
                );
                assert_eq!(
                    operation.request.body,
                    serde_json::to_vec(&ExpectedUpdateBody {
                        encrypted_data: &overlay.encrypted_data,
                        encryption_algorithm: &overlay.encryption_algorithm,
                        encryption_iv: &overlay.encryption_iv,
                    })
                    .unwrap()
                );
            }
            RemainingKindCase::Favorite => {
                assert_eq!(operation.request.headers.len(), 2);
                assert_eq!(operation.request.headers[0].name, "Content-Type");
                assert_eq!(
                    operation.request.headers[0].value,
                    "application/merge-patch+json"
                );
                assert_eq!(operation.request.body, br#"{"favorite":true}"#);
            }
            RemainingKindCase::Move => {
                assert_eq!(operation.request.headers.len(), 2);
                assert_eq!(operation.request.headers[0].name, "Content-Type");
                assert_eq!(operation.request.headers[0].value, "application/json");
                assert_eq!(
                    operation.request.body,
                    serde_json::to_vec(&ExpectedMoveBody {
                        mode: "prepared",
                        attachments: &[],
                        encrypted_data: &overlay.encrypted_data,
                        encryption_algorithm: &overlay.encryption_algorithm,
                        encryption_iv: &overlay.encryption_iv,
                        source_vault_id: TEST_VAULT_ID,
                        target_vault_id: "vault-2",
                    })
                    .unwrap()
                );
            }
            RemainingKindCase::Trash
            | RemainingKindCase::Restore
            | RemainingKindCase::PermanentlyDelete => {
                assert!(operation.request.body.is_empty());
                assert_eq!(operation.request.headers.len(), 1);
            }
        }

        for request in executor.recorded() {
            for marker in plaintext_markers() {
                assert!(
                    !request.contains(marker),
                    "durable {:?} plan leaked {marker}",
                    case.operation_kind()
                );
            }
        }

        assert_remaining_projection(case, &visible(&runtime, &account_id));

        drop(runtime);
        let restarted = Runtime::with_serialized_replica_executor(executor);
        restarted
            .replica()
            .load(&account_id)
            .await
            .unwrap()
            .unwrap();
        restarted.unlock_account(&account_id).await.unwrap();
        let restored = restarted.replica().snapshot(&account_id).unwrap();
        assert_eq!(restored.operations, vec![operation]);
        assert_eq!(restored.items, vec![overlay]);
        assert_remaining_projection(case, &visible(&restarted, &account_id));
    }
}

#[tokio::test]
async fn attachment_bearing_move_is_accepted_offline_before_final_request_exists() {
    let executor = RecordingExecutor::seeded_with_item(false);
    let (runtime, account_id) = unlocked_runtime(executor.clone()).await;

    let outcome = runtime
        .request(
            RuntimeRequest::MoveItem {
                account_id: account_id.clone(),
                item_id: "item-existing".into(),
                target_vault_id: "vault-2".into(),
            },
            RequestCancellation::new(),
        )
        .await
        .expect("an offline Attachment-bearing Move is durably accepted");

    let (operation_id, item_id, _) = accepted(outcome);
    let snapshot = runtime.replica().snapshot(&account_id).unwrap();
    assert!(
        snapshot.operations.is_empty(),
        "preparation must not enter the dispatch-ready Operation collection"
    );
    assert_eq!(snapshot.attachment_move_preparations.len(), 1);
    let preparation = &snapshot.attachment_move_preparations[0];
    assert_eq!(preparation.account_id, account_id);
    assert_eq!(preparation.operation_id, operation_id);
    assert_eq!(preparation.item_id, item_id);
    assert_eq!(preparation.source_vault_id, TEST_VAULT_ID);
    assert_eq!(preparation.target_vault_id, "vault-2");
    assert_eq!(preparation.expected_item_version, 1);
    assert_eq!(preparation.source_attachments.len(), 1);
    assert!(matches!(
        preparation.progress.as_slice(),
        [AttachmentMoveProgress::Pending { attachment_id, expected_envelope_version: 1 }]
            if attachment_id == "attachment-1"
    ));
    assert_eq!(snapshot.items[0].vault_id, "vault-2");

    let durable_json = executor.recorded().join("\n");
    assert!(!durable_json.contains(ATTACHMENT_NAME));
    assert!(!durable_json.contains(ATTACHMENT_CONTENT_TYPE));

    drop(runtime);
    let restarted = Runtime::with_serialized_replica_executor(executor);
    restarted
        .replica()
        .load(&account_id)
        .await
        .unwrap()
        .unwrap();
    let restored = restarted.replica().snapshot(&account_id).unwrap();
    assert_eq!(
        restored.attachment_move_preparations,
        snapshot.attachment_move_preparations
    );
    assert!(restored.operations.is_empty());
}

#[tokio::test]
async fn attachment_move_restart_rejects_reordered_durable_progress() {
    let executor = RecordingExecutor::seeded_with_two_attachments();
    let (runtime, account_id) = unlocked_runtime(executor.clone()).await;
    runtime
        .request(
            RemainingKindCase::Move.request(account_id.clone()),
            RequestCancellation::new(),
        )
        .await
        .unwrap();
    drop(runtime);

    executor
        .reverse_preparation_progress_on_load
        .store(true, Ordering::SeqCst);
    let restarted = Runtime::with_serialized_replica_executor(executor);
    let error = restarted.replica().load(&account_id).await.unwrap_err();
    assert_eq!(error.code, RuntimeErrorCode::InvariantViolation);
}

fn prepared_attachment() -> PreparedMoveAttachment {
    PreparedMoveAttachment {
        encrypted_name: "target-encrypted-name".into(),
        encryption_iv: "target-name-iv".into(),
        encryption_algorithm: "AES-GCM-AAD-V1".into(),
        encrypted_attachment_key: "target-wrapped-key".into(),
        attachment_key_iv: "target-key-iv".into(),
        attachment_key_algorithm: "AES-GCM-AAD-V1".into(),
        encrypted_content_type: "target-encrypted-content-type".into(),
        encrypted_content_type_iv: "target-content-type-iv".into(),
    }
}

fn prepared_artifact(account_id: &AccountId, operation_id: &str) -> AttachmentMoveArtifactRef {
    attachment_move_artifact_ref(
        account_id,
        operation_id,
        "attachment-1",
        "9f64a747e1b97f131fabb6b447296c9b6f0201e79fb3c5356e6c77e89b6a806a",
        4,
    )
    .unwrap()
}

async fn commit_move_mutation(
    runtime: &Runtime,
    account_id: &AccountId,
    mutation: PlanMutation,
) -> Result<crate::replica::PlanResult, RuntimeError> {
    let snapshot = runtime.replica().snapshot(account_id).unwrap();
    runtime
        .execute_plan(GuardedCommitPlan::new(
            account_id.clone(),
            snapshot.incarnation,
            snapshot.revision,
            snapshot.lock_epoch,
            vec![mutation],
        ))
        .await
}

#[tokio::test]
async fn attachment_move_checkpoints_reset_and_promote_without_rewriting_intent() {
    let executor = RecordingExecutor::seeded_with_item(false);
    let (runtime, account_id) = unlocked_runtime(executor.clone()).await;
    let (operation_id, _, _) = accepted(
        runtime
            .request(
                RemainingKindCase::Move.request(account_id.clone()),
                RequestCancellation::new(),
            )
            .await
            .unwrap(),
    );
    let accepted_preparation = runtime
        .replica()
        .snapshot(&account_id)
        .unwrap()
        .attachment_move_preparations[0]
        .clone();
    let pending = accepted_preparation.progress[0].clone();
    let encrypted = AttachmentMoveProgress::Encrypted {
        attachment_id: "attachment-1".into(),
        expected_envelope_version: 1,
        artifact: attachment_move_artifact_ref(
            &account_id,
            &operation_id,
            "attachment-1",
            "9f64a747e1b97f131fabb6b447296c9b6f0201e79fb3c5356e6c77e89b6a806a",
            4,
        )
        .unwrap(),
        payload: Box::new(prepared_attachment()),
        upload: AttachmentMoveUploadState::NeedsUpload,
    };
    let mut wrong_digest = encrypted.clone();
    let AttachmentMoveProgress::Encrypted { artifact, .. } = &mut wrong_digest else {
        unreachable!()
    };
    artifact.ciphertext_sha256 = "G".repeat(64);
    let invalid = commit_move_mutation(
        &runtime,
        &account_id,
        PlanMutation::CheckpointAttachmentMove {
            operation_id: operation_id.clone(),
            expected_intent_fingerprint: accepted_preparation.intent_fingerprint,
            expected: pending.clone(),
            next: wrong_digest,
        },
    )
    .await
    .unwrap_err();
    assert_eq!(invalid.code, RuntimeErrorCode::InvariantViolation);
    commit_move_mutation(
        &runtime,
        &account_id,
        PlanMutation::CheckpointAttachmentMove {
            operation_id: operation_id.clone(),
            expected_intent_fingerprint: accepted_preparation.intent_fingerprint,
            expected: pending.clone(),
            next: encrypted.clone(),
        },
    )
    .await
    .unwrap();

    let after_encryption = runtime.replica().snapshot(&account_id).unwrap();
    let durable_intent = &after_encryption.attachment_move_preparations[0];
    assert_eq!(
        durable_intent.intent_fingerprint,
        accepted_preparation.intent_fingerprint
    );
    assert_eq!(
        durable_intent.source_attachments,
        accepted_preparation.source_attachments
    );
    assert_eq!(
        durable_intent.progress[0], encrypted,
        "the immutable artifact reference survives the checkpoint"
    );
    let AttachmentMoveProgress::Encrypted { artifact, .. } = &encrypted else {
        unreachable!()
    };
    let durable_wire = executor.recorded().join("\n");
    assert!(durable_wire.contains(&format!(r#"\"artifactId\":\"{}\""#, artifact.artifact_id)));
    assert!(durable_wire.contains(r#"\"byteLength\":\"4\""#));
    assert!(!durable_wire.contains("AQIDBA=="));
    assert!(!durable_wire.contains(r#"\"encryptedBlob\""#));
    assert!(!durable_wire.contains("[1,2,3,4]"));

    executor
        .invalidate_artifact_id_on_load
        .store(true, Ordering::SeqCst);
    let hostile_restart = Runtime::with_serialized_replica_executor(executor.clone());
    let invalid_id = hostile_restart
        .replica()
        .load(&account_id)
        .await
        .unwrap_err();
    assert_eq!(invalid_id.code, RuntimeErrorCode::InvariantViolation);

    drop(runtime);
    let restarted = Runtime::with_serialized_replica_executor(executor.clone());
    restarted
        .replica()
        .load(&account_id)
        .await
        .unwrap()
        .unwrap();
    restarted.unlock_account(&account_id).await.unwrap();
    assert_eq!(
        restarted
            .replica()
            .snapshot(&account_id)
            .unwrap()
            .attachment_move_preparations[0]
            .progress[0],
        encrypted,
        "restart must retain the same complete-artifact reference committed before the crash"
    );
    let runtime = restarted;

    let mismatch = commit_move_mutation(
        &runtime,
        &account_id,
        PlanMutation::CheckpointAttachmentMove {
            operation_id: operation_id.clone(),
            expected_intent_fingerprint: accepted_preparation.intent_fingerprint,
            expected: pending,
            next: encrypted.clone(),
        },
    )
    .await
    .unwrap_err();
    assert_eq!(mismatch.code, RuntimeErrorCode::InvariantViolation);
    assert_eq!(
        runtime.replica().snapshot(&account_id).unwrap(),
        after_encryption
    );

    let premature = commit_move_mutation(
        &runtime,
        &account_id,
        PlanMutation::PromoteAttachmentMovePreparation {
            operation_id: operation_id.clone(),
            expected_intent_fingerprint: accepted_preparation.intent_fingerprint,
        },
    )
    .await
    .unwrap_err();
    assert_eq!(premature.code, RuntimeErrorCode::InvariantViolation);

    let AttachmentMoveProgress::Encrypted {
        attachment_id,
        expected_envelope_version,
        artifact,
        payload,
        ..
    } = encrypted.clone()
    else {
        unreachable!()
    };
    let uploaded = AttachmentMoveProgress::Encrypted {
        attachment_id,
        expected_envelope_version,
        artifact,
        payload,
        upload: AttachmentMoveUploadState::Uploaded,
    };
    commit_move_mutation(
        &runtime,
        &account_id,
        PlanMutation::CheckpointAttachmentMove {
            operation_id: operation_id.clone(),
            expected_intent_fingerprint: accepted_preparation.intent_fingerprint,
            expected: encrypted.clone(),
            next: uploaded.clone(),
        },
    )
    .await
    .unwrap();
    commit_move_mutation(
        &runtime,
        &account_id,
        PlanMutation::ResetAttachmentMoveUpload {
            operation_id: operation_id.clone(),
            expected_intent_fingerprint: accepted_preparation.intent_fingerprint,
            attachment_id: "attachment-1".into(),
        },
    )
    .await
    .unwrap();
    assert_eq!(
        runtime
            .replica()
            .snapshot(&account_id)
            .unwrap()
            .attachment_move_preparations[0]
            .progress,
        vec![encrypted.clone()],
        "generation reset preserves the target artifact and only clears upload progress"
    );
    commit_move_mutation(
        &runtime,
        &account_id,
        PlanMutation::CheckpointAttachmentMove {
            operation_id: operation_id.clone(),
            expected_intent_fingerprint: accepted_preparation.intent_fingerprint,
            expected: encrypted,
            next: uploaded.clone(),
        },
    )
    .await
    .unwrap();
    commit_move_mutation(
        &runtime,
        &account_id,
        PlanMutation::PromoteAttachmentMovePreparation {
            operation_id: operation_id.clone(),
            expected_intent_fingerprint: accepted_preparation.intent_fingerprint,
        },
    )
    .await
    .unwrap();

    let promoted = runtime.replica().snapshot(&account_id).unwrap();
    assert!(promoted.attachment_move_preparations.is_empty());
    assert_eq!(promoted.operations.len(), 1);
    assert_eq!(promoted.operations[0].operation_id, operation_id);
    assert_eq!(promoted.items[0].operation_id, operation_id);
    assert_eq!(
        promoted.operations[0].request_fingerprint,
        create::item_operation_fingerprint(
            OperationKind::MoveItem,
            "POST /api/v1/items/{itemId}/moves",
            "item-existing",
            &promoted.operations[0].request.body,
            1,
        )
    );
    let body: serde_json::Value =
        serde_json::from_slice(&promoted.operations[0].request.body).unwrap();
    assert_eq!(body["mode"], "prepared");
    assert_eq!(body["attachments"][0]["attachmentId"], "attachment-1");

    executor.fail_commits.store(true, Ordering::SeqCst);
    assert!(commit_move_mutation(
        &runtime,
        &account_id,
        PlanMutation::ReactivateAttachmentMovePreparation {
            operation_id: operation_id.clone(),
            expected_request_fingerprint: promoted.operations[0].request_fingerprint,
        },
    )
    .await
    .is_err());
    assert_eq!(runtime.replica().snapshot(&account_id).unwrap(), promoted);
    executor.fail_commits.store(false, Ordering::SeqCst);
    commit_move_mutation(
        &runtime,
        &account_id,
        PlanMutation::ReactivateAttachmentMovePreparation {
            operation_id: operation_id.clone(),
            expected_request_fingerprint: promoted.operations[0].request_fingerprint,
        },
    )
    .await
    .unwrap();
    let reactivated = runtime.replica().snapshot(&account_id).unwrap();
    assert!(reactivated.operations.is_empty());
    assert_eq!(reactivated.attachment_move_preparations.len(), 1);
    assert_eq!(
        reactivated.attachment_move_preparations[0].progress,
        vec![uploaded],
        "nonterminal staging recovery retains the exact artifact reference and progress"
    );
}

#[tokio::test]
async fn stale_authority_freeze_uses_original_complete_intent() {
    let executor = RecordingExecutor::seeded_with_item(false);
    let (runtime, account_id) = unlocked_runtime(executor.clone()).await;
    let (operation_id, _, _) = accepted(
        runtime
            .request(
                RemainingKindCase::Move.request(account_id.clone()),
                RequestCancellation::new(),
            )
            .await
            .unwrap(),
    );
    let preparation = runtime
        .replica()
        .snapshot(&account_id)
        .unwrap()
        .attachment_move_preparations[0]
        .clone();
    commit_move_mutation(
        &runtime,
        &account_id,
        PlanMutation::FreezeAttachmentMoveRejection {
            operation_id: operation_id.clone(),
            expected_intent_fingerprint: preparation.intent_fingerprint,
        },
    )
    .await
    .unwrap();
    let snapshot = runtime.replica().snapshot(&account_id).unwrap();
    assert!(snapshot.attachment_move_preparations.is_empty());
    let operation = &snapshot.operations[0];
    assert_eq!(operation.operation_id, operation_id);
    let body: serde_json::Value = serde_json::from_slice(&operation.request.body).unwrap();
    assert_eq!(body["mode"], "reject_stale_authority");
    assert_eq!(body["sourceVaultId"], TEST_VAULT_ID);
    assert_eq!(body["targetVaultId"], "vault-2");
    assert_eq!(
        body["attachments"],
        serde_json::json!([{
            "attachmentId": "attachment-1",
            "expectedEnvelopeVersion": 1
        }])
    );

    commit_move_mutation(
        &runtime,
        &account_id,
        PlanMutation::ReactivateAttachmentMovePreparation {
            operation_id: operation_id.clone(),
            expected_request_fingerprint: operation.request_fingerprint,
        },
    )
    .await
    .unwrap();
    let reactivated = runtime.replica().snapshot(&account_id).unwrap();
    assert!(reactivated.operations.is_empty());
    assert_eq!(reactivated.attachment_move_preparations, vec![preparation]);
}

#[tokio::test]
async fn promoted_and_rejected_attachment_moves_reschedule_and_restart_with_recovery() {
    for reject_stale in [false, true] {
        let executor = RecordingExecutor::seeded_with_item(false);
        let (runtime, account_id) = unlocked_runtime(executor.clone()).await;
        let (operation_id, _, _) = accepted(
            runtime
                .request(
                    RemainingKindCase::Move.request(account_id.clone()),
                    RequestCancellation::new(),
                )
                .await
                .unwrap(),
        );
        let preparation = runtime
            .replica()
            .snapshot(&account_id)
            .unwrap()
            .attachment_move_preparations[0]
            .clone();
        if reject_stale {
            commit_move_mutation(
                &runtime,
                &account_id,
                PlanMutation::FreezeAttachmentMoveRejection {
                    operation_id: operation_id.clone(),
                    expected_intent_fingerprint: preparation.intent_fingerprint,
                },
            )
            .await
            .unwrap();
        } else {
            let pending = preparation.progress[0].clone();
            let needs_upload = AttachmentMoveProgress::Encrypted {
                attachment_id: "attachment-1".into(),
                expected_envelope_version: 1,
                artifact: prepared_artifact(&account_id, &operation_id),
                payload: Box::new(prepared_attachment()),
                upload: AttachmentMoveUploadState::NeedsUpload,
            };
            let AttachmentMoveProgress::Encrypted {
                attachment_id,
                expected_envelope_version,
                artifact,
                payload,
                ..
            } = needs_upload.clone()
            else {
                unreachable!()
            };
            let uploaded = AttachmentMoveProgress::Encrypted {
                attachment_id,
                expected_envelope_version,
                artifact,
                payload,
                upload: AttachmentMoveUploadState::Uploaded,
            };
            commit_move_mutation(
                &runtime,
                &account_id,
                PlanMutation::CheckpointAttachmentMove {
                    operation_id: operation_id.clone(),
                    expected_intent_fingerprint: preparation.intent_fingerprint,
                    expected: pending,
                    next: needs_upload.clone(),
                },
            )
            .await
            .unwrap();
            commit_move_mutation(
                &runtime,
                &account_id,
                PlanMutation::CheckpointAttachmentMove {
                    operation_id: operation_id.clone(),
                    expected_intent_fingerprint: preparation.intent_fingerprint,
                    expected: needs_upload,
                    next: uploaded,
                },
            )
            .await
            .unwrap();
            commit_move_mutation(
                &runtime,
                &account_id,
                PlanMutation::PromoteAttachmentMovePreparation {
                    operation_id: operation_id.clone(),
                    expected_intent_fingerprint: preparation.intent_fingerprint,
                },
            )
            .await
            .unwrap();
        }

        let mut rescheduled =
            runtime.replica().snapshot(&account_id).unwrap().operations[0].clone();
        rescheduled.scheduling.attempt_count = 9;
        rescheduled.scheduling.not_before_ms = 42_000;
        commit_move_mutation(
            &runtime,
            &account_id,
            PlanMutation::RescheduleOperation(rescheduled.clone()),
        )
        .await
        .unwrap();
        let durable_rescheduled =
            runtime.replica().snapshot(&account_id).unwrap().operations[0].clone();
        drop(runtime);

        let restarted = Runtime::with_serialized_replica_executor(executor);
        restarted
            .replica()
            .load(&account_id)
            .await
            .unwrap()
            .unwrap();
        restarted.unlock_account(&account_id).await.unwrap();
        assert_eq!(
            restarted
                .replica()
                .snapshot(&account_id)
                .unwrap()
                .operations,
            vec![durable_rescheduled]
        );
    }
}

#[tokio::test]
async fn attachment_move_acceptance_has_one_atomic_crash_boundary() {
    let failed_executor = RecordingExecutor::seeded_with_item(false);
    let (failed_runtime, account_id) = unlocked_runtime(failed_executor.clone()).await;
    failed_executor.fail_commits.store(true, Ordering::SeqCst);
    assert!(failed_runtime
        .request(
            RemainingKindCase::Move.request(account_id.clone()),
            RequestCancellation::new(),
        )
        .await
        .is_err());
    let unchanged = failed_runtime.replica().snapshot(&account_id).unwrap();
    assert!(unchanged.attachment_move_preparations.is_empty());
    assert!(unchanged.operations.is_empty());
    assert!(unchanged.items.is_empty());

    let committed_executor = RecordingExecutor::seeded_with_item(false);
    let (committed_runtime, account_id) = unlocked_runtime(committed_executor.clone()).await;
    let cancellation = RequestCancellation::new();
    *committed_executor.cancel_after_commit.lock().unwrap() = Some(cancellation.clone());
    let error = committed_runtime
        .request(
            RemainingKindCase::Move.request(account_id.clone()),
            cancellation,
        )
        .await
        .unwrap_err();
    assert_eq!(error.code, RuntimeErrorCode::Cancelled);
    let committed = committed_runtime.replica().snapshot(&account_id).unwrap();
    assert_eq!(committed.attachment_move_preparations.len(), 1);
    assert!(committed.operations.is_empty());
    assert_eq!(committed.items.len(), 1);
    assert_eq!(
        committed.items[0].operation_id,
        committed.attachment_move_preparations[0].operation_id
    );
}

#[tokio::test]
async fn remaining_item_acceptance_never_infers_an_active_account() {
    let executor = RecordingExecutor::seeded_with_item(false);
    let (runtime, account_id) = unlocked_runtime(executor).await;
    let error = runtime
        .request(
            RuntimeRequest::TrashItem {
                account_id: AccountId::from("another-account"),
                item_id: "item-existing".into(),
            },
            RequestCancellation::new(),
        )
        .await
        .unwrap_err();
    assert_eq!(error.code, RuntimeErrorCode::AccountMissing);
    assert!(runtime
        .replica()
        .snapshot(&account_id)
        .unwrap()
        .operations
        .is_empty());
}

#[tokio::test]
async fn existing_item_acceptance_refuses_an_exhausted_lock_epoch_without_writing() {
    let executor = RecordingExecutor::seeded_with_item(false);
    let (runtime, account_id) = unlocked_runtime(executor.clone()).await;
    executor
        .state
        .set_lock_epoch(&account_id, u64::MAX)
        .unwrap();
    runtime.replica().load(&account_id).await.unwrap().unwrap();

    let error = runtime
        .request(
            RuntimeRequest::TrashItem {
                account_id: account_id.clone(),
                item_id: "item-existing".into(),
            },
            RequestCancellation::new(),
        )
        .await
        .unwrap_err();
    assert_eq!(error.code, RuntimeErrorCode::AuthenticationRequired);
    let snapshot = runtime.replica().snapshot(&account_id).unwrap();
    assert!(snapshot.operations.is_empty());
    assert!(snapshot.items.is_empty());
}

#[tokio::test]
async fn existing_item_cancellation_has_one_durable_acceptance_boundary() {
    let pre_executor = RecordingExecutor::seeded_with_item(false);
    let (pre_runtime, account_id) = unlocked_runtime(pre_executor).await;
    let pre_cancelled = RequestCancellation::new();
    pre_cancelled.cancel();
    let error = pre_runtime
        .request(
            RemainingKindCase::Trash.request(account_id.clone()),
            pre_cancelled,
        )
        .await
        .unwrap_err();
    assert_eq!(error.code, RuntimeErrorCode::Cancelled);
    assert!(pre_runtime
        .replica()
        .snapshot(&account_id)
        .unwrap()
        .operations
        .is_empty());

    let post_executor = RecordingExecutor::seeded_with_item(false);
    let (post_runtime, account_id) = unlocked_runtime(post_executor.clone()).await;
    let post_cancelled = RequestCancellation::new();
    *post_executor.cancel_after_commit.lock().unwrap() = Some(post_cancelled.clone());
    let error = post_runtime
        .request(
            RemainingKindCase::Trash.request(account_id.clone()),
            post_cancelled,
        )
        .await
        .unwrap_err();
    assert_eq!(error.code, RuntimeErrorCode::Cancelled);
    let snapshot = post_runtime.replica().snapshot(&account_id).unwrap();
    assert_eq!(snapshot.operations.len(), 1);
    assert_eq!(snapshot.items.len(), 1);
}

#[tokio::test]
async fn a_lock_racing_the_existing_item_commit_fences_without_accepting_work() {
    let executor = RecordingExecutor::seeded_with_item(false);
    let (runtime, account_id) = unlocked_runtime(executor.clone()).await;
    executor.fence_before_commit.store(true, Ordering::SeqCst);

    let error = runtime
        .request(
            RemainingKindCase::Trash.request(account_id.clone()),
            RequestCancellation::new(),
        )
        .await
        .unwrap_err();
    assert_eq!(error.code, RuntimeErrorCode::AuthenticationRequired);
    let snapshot = executor.state.snapshot(&account_id).unwrap();
    assert_eq!(snapshot.lock_epoch, 1);
    assert!(snapshot.operations.is_empty());
    assert!(snapshot.items.is_empty());
}

#[tokio::test]
async fn a_second_pending_operation_for_one_item_is_refused_without_changing_state() {
    let executor = RecordingExecutor::seeded_with_item(false);
    let (runtime, account_id) = unlocked_runtime(executor).await;
    runtime
        .request(
            RemainingKindCase::Favorite.request(account_id.clone()),
            RequestCancellation::new(),
        )
        .await
        .unwrap();
    let before = runtime.replica().snapshot(&account_id).unwrap();

    let error = runtime
        .request(
            RemainingKindCase::Trash.request(account_id.clone()),
            RequestCancellation::new(),
        )
        .await
        .unwrap_err();
    assert_eq!(error.code, RuntimeErrorCode::InvariantViolation);
    assert_eq!(runtime.replica().snapshot(&account_id).unwrap(), before);
}

#[tokio::test]
async fn attachment_bearing_move_accepts_without_mutating_source_authority() {
    let executor = RecordingExecutor::seeded_with_item(false);
    let (runtime, account_id) = unlocked_runtime(executor.clone()).await;
    let before_snapshot = runtime.replica().snapshot(&account_id).unwrap();
    let before_projection = visible(&runtime, &account_id);

    let response = runtime
        .request(
            RemainingKindCase::Move.request(account_id.clone()),
            RequestCancellation::new(),
        )
        .await
        .unwrap();
    let _ = accepted(response);
    let after = runtime.replica().snapshot(&account_id).unwrap();
    assert_eq!(after.bootstrap, before_snapshot.bootstrap);
    assert_eq!(after.attachment_move_preparations.len(), 1);
    assert!(after.operations.is_empty());
    let pending = visible(&runtime, &account_id);
    assert_eq!(pending.items[0].vault_id, "vault-2");
    assert_eq!(pending.items[0].status, ItemProjectionStatus::Pending);
    assert_eq!(pending.items[0].attachments.len(), 1);
    assert_eq!(pending.items[0].attachments[0].name, ATTACHMENT_NAME);
    assert_eq!(before_projection.items[0].attachments.len(), 1);
    assert_eq!(
        before_projection.items[0].attachments[0].name,
        ATTACHMENT_NAME
    );
    assert!(executor
        .recorded()
        .iter()
        .any(|request| request.contains("\"type\":\"commit\"")));

    drop(runtime);
    let restarted = Runtime::with_serialized_replica_executor(executor);
    restarted
        .replica()
        .load(&account_id)
        .await
        .unwrap()
        .unwrap();
    restarted.unlock_account(&account_id).await.unwrap();
    let restored = visible(&restarted, &account_id);
    assert_eq!(restored.items[0].status, ItemProjectionStatus::Pending);
    assert_eq!(restored.items[0].attachments.len(), 1);
    assert_eq!(restored.items[0].attachments[0].name, ATTACHMENT_NAME);
}

#[tokio::test]
async fn items_projection_includes_deleted_items_and_decrypted_attachment_authority() {
    let executor = RecordingExecutor::seeded_with_item(true);
    let (runtime, account_id) = unlocked_runtime(executor.clone()).await;
    let projection = visible(&runtime, &account_id);

    assert_eq!(projection.account_id, account_id);
    assert_eq!(projection.items.len(), 1);
    let item = &projection.items[0];
    assert_eq!(item.item_id, "item-existing");
    assert_eq!(item.deleted_at.as_deref(), Some("2026-08-24T00:00:00Z"));
    assert_eq!(item.attachments.len(), 1);
    let attachment = &item.attachments[0];
    assert_eq!(attachment.account_id, account_id);
    assert_eq!(attachment.name, ATTACHMENT_NAME);
    assert_eq!(attachment.content_type, ATTACHMENT_CONTENT_TYPE);
    assert_eq!(attachment.file_size, 42);
    for request in executor.recorded() {
        assert!(!request.contains(ATTACHMENT_NAME));
        assert!(!request.contains(ATTACHMENT_CONTENT_TYPE));
    }
}
