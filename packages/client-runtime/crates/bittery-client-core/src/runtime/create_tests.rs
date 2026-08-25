//! Slice A: the durable half of an offline create.
//!
//! Every assertion here is about what survives a crash: the exact bytes, the fingerprint that
//! stands apart from the Operation ID, the encrypted overlay, and the absence of both plaintext
//! and credentials in anything the Replica persists.

use super::*;
use crate::{
    http_transport::{HttpHeader, HttpMethod},
    protocol::Incarnation,
    replica::{
        AuthorityAttachmentRecord, AuthorityItemCategory, AuthorityItemRecord, AuthorityVaultRole,
        AuthorityVaultType, InMemoryReplica, OperationKind, OperationRecord, ReplicaPersistence,
        ReplicaPersistenceRequest, SerializedReplicaExecutor,
    },
    server_contract::{CreateItemBody, ItemCategory},
    test_fixtures::{personal_vault, seed_ready_personal_vault, TEST_VAULT_ID, TEST_VAULT_KEY},
    CustomFieldKind, LoginCustomField, LoginItemDraft,
};
use async_trait::async_trait;
use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use bittery_crypto_core::{decrypt_with_aad, encrypt_with_aad, AadContext, EncryptedData};
use create::{create_item_fingerprint, create_item_path};
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
    cancel_after_commit: Mutex<Option<RequestCancellation>>,
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
            cancel_after_commit: Mutex::new(None),
        })
    }

    fn seeded_with_item(deleted: bool) -> Arc<Self> {
        Self::seeded_item(deleted, true)
    }

    fn seeded_attachment_free_item(deleted: bool) -> Arc<Self> {
        Self::seeded_item(deleted, false)
    }

    fn seeded_item(deleted: bool, with_attachment: bool) -> Arc<Self> {
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
            &serde_json::to_string(&draft()).unwrap(),
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
                    attachments: with_attachment.then(attachment).into_iter().collect(),
                }],
            )
            .unwrap();
        Arc::new(Self {
            state,
            requests: Mutex::new(Vec::new()),
            fail_commits: AtomicBool::new(false),
            fence_before_commit: AtomicBool::new(false),
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
    let attachment_id = "attachment-1";
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

fn draft() -> LoginItemDraft {
    LoginItemDraft {
        title: TITLE.into(),
        url: Some("https://example.test".into()),
        urls: vec!["https://second.example.test".into()],
        username: Some(USERNAME.into()),
        password: Some(PASSWORD.into()),
        notes: Some(NOTES.into()),
        note: None,
        custom_fields: vec![LoginCustomField {
            id: "field-1".into(),
            label: "Recovery".into(),
            value: FIELD_VALUE.into(),
            field_type: CustomFieldKind::Password,
        }],
        tags: vec![TAG.into()],
    }
}

fn plaintext_markers() -> [&'static str; 6] {
    [TITLE, USERNAME, PASSWORD, NOTES, FIELD_VALUE, TAG]
}

fn create(account_id: &AccountId, vault_id: &str) -> RuntimeRequest {
    RuntimeRequest::CreateLoginItem {
        account_id: account_id.clone(),
        vault_id: vault_id.to_owned(),
        draft: draft(),
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
    assert_eq!(opened, serde_json::to_string(&draft()).unwrap());

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
    assert_eq!(projection.items[0].title, TITLE);
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
    let (runtime, account_id) = unlocked_runtime(executor).await;
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
    let (runtime, account_id) = unlocked_runtime(executor).await;
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
    assert_eq!(before[0].title, TITLE);
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
    assert_eq!(after[0].title, TITLE);
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
            Self::Update => RuntimeRequest::UpdateLoginItem {
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
        RemainingKindCase::Update => assert_eq!(projection.items[0].title, TITLE),
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
async fn attachment_bearing_move_refuses_before_writing_and_preserves_authority() {
    let executor = RecordingExecutor::seeded_with_item(false);
    let (runtime, account_id) = unlocked_runtime(executor.clone()).await;
    let before_snapshot = runtime.replica().snapshot(&account_id).unwrap();
    let before_projection = visible(&runtime, &account_id);

    let error = runtime
        .request(
            RemainingKindCase::Move.request(account_id.clone()),
            RequestCancellation::new(),
        )
        .await
        .unwrap_err();
    assert_eq!(error.code, RuntimeErrorCode::InvariantViolation);
    assert_eq!(
        runtime.replica().snapshot(&account_id).unwrap(),
        before_snapshot
    );
    assert_eq!(visible(&runtime, &account_id), before_projection);
    assert_eq!(before_projection.items[0].attachments.len(), 1);
    assert_eq!(
        before_projection.items[0].attachments[0].name,
        ATTACHMENT_NAME
    );
    assert!(!executor
        .recorded()
        .iter()
        .any(|request| request.contains("\"type\":\"commit\"")));
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
