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
        AuthorityVaultRole, AuthorityVaultType, InMemoryReplica, OperationKind, OperationRecord,
        ReplicaPersistence, ReplicaPersistenceRequest, SerializedReplicaExecutor,
    },
    server_contract::{CreateItemBody, ItemCategory},
    test_fixtures::{personal_vault, seed_ready_personal_vault, TEST_VAULT_ID, TEST_VAULT_KEY},
    CustomFieldKind, LoginCustomField, LoginItemDraft,
};
use async_trait::async_trait;
use bittery_crypto_core::{decrypt_with_aad, AadContext, EncryptedData};
use create::{create_item_fingerprint, create_item_path};
use std::sync::atomic::AtomicBool;

const ACCOUNT: &str = "account-1";
const USER: &str = "user-1";
const INCARNATION: &str = "incarnation-1";

/// Records every serialized persistence request so a test can search the durable plan itself.
struct RecordingExecutor {
    state: InMemoryReplica,
    requests: Mutex<Vec<String>>,
    fail_commits: AtomicBool,
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
        if matches!(request, ReplicaPersistenceRequest::Commit { .. })
            && self.fail_commits.load(Ordering::SeqCst)
        {
            return Err(RuntimeError::new(
                RuntimeErrorCode::InvariantViolation,
                "injected commit failure",
            ));
        }
        serde_json::to_string(&self.state.invoke(request).await?).map_err(|_| {
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
