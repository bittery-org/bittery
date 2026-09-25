use super::import_executor::ImportExchangeResponse;
use super::*;
use crate::{
    protocol::Incarnation, replica::OperationKind, test_fixtures::TEST_VAULT_ID, ImportItemDraft,
    ItemDraft, LoginItemData,
};
use async_trait::async_trait;
use std::sync::atomic::{AtomicUsize, Ordering};

struct AppliedPort {
    outcome: super::import_executor::ImportExchangeResponse,
}

struct FailOneCommit {
    inner: Arc<InMemoryReplica>,
    armed: AtomicBool,
}

#[async_trait]
impl ReplicaPersistence for FailOneCommit {
    async fn invoke(
        &self,
        request: crate::replica::ReplicaPersistenceRequest,
    ) -> Result<crate::replica::ReplicaPersistenceResponse, RuntimeError> {
        if matches!(
            &request,
            crate::replica::ReplicaPersistenceRequest::Commit { .. }
        ) && self.armed.swap(false, Ordering::SeqCst)
        {
            return Err(RuntimeError::new(
                RuntimeErrorCode::RetryableTransport,
                "receipt commit storage failure",
            ));
        }
        self.inner.invoke(request).await
    }
}

struct LookupFaultPort {
    fault: super::import_executor::ImportExecutorError,
    renewals: AtomicUsize,
}

#[async_trait]
impl super::import_executor::ImportExecutorPort for LookupFaultPort {
    async fn lookup(
        &self,
        _operation: &crate::replica::OperationRecord,
    ) -> Result<
        Option<super::import_executor::ImportExchangeResponse>,
        super::import_executor::ImportExecutorError,
    > {
        Err(self.fault)
    }
    async fn post_exact(
        &self,
        _operation: &crate::replica::OperationRecord,
    ) -> Result<
        super::import_executor::ImportExchangeResponse,
        super::import_executor::ImportExecutorError,
    > {
        panic!("lookup fault must stop the cycle")
    }
    async fn renew_session(&self) -> Result<(), super::import_executor::ImportExecutorError> {
        self.renewals.fetch_add(1, Ordering::SeqCst);
        Ok(())
    }
}

#[async_trait]
impl super::import_executor::ImportExecutorPort for AppliedPort {
    async fn lookup(
        &self,
        _operation: &crate::replica::OperationRecord,
    ) -> Result<
        Option<super::import_executor::ImportExchangeResponse>,
        super::import_executor::ImportExecutorError,
    > {
        Ok(Some(self.outcome.clone()))
    }

    async fn post_exact(
        &self,
        _operation: &crate::replica::OperationRecord,
    ) -> Result<
        super::import_executor::ImportExchangeResponse,
        super::import_executor::ImportExecutorError,
    > {
        Ok(self.outcome.clone())
    }

    async fn renew_session(&self) -> Result<(), super::import_executor::ImportExecutorError> {
        Ok(())
    }
}

/// What a Server exchange answers on one cycle. A history scripts one entry per cycle, so a
/// dropped response, a duplicate send, and a contradicting lookup are all the same shape.
type LookupAnswer = Result<
    Option<super::import_executor::ImportExchangeResponse>,
    super::import_executor::ImportExecutorError,
>;
type PostAnswer = Result<
    super::import_executor::ImportExchangeResponse,
    super::import_executor::ImportExecutorError,
>;
/// How one cycle's exact replay and its lookup hint can disagree.
#[derive(Clone, Copy, Debug)]
enum ChangedReplay {
    ContradictingHint,
    ReusedIdentityHint,
    ChangedCount,
}

/// What durable state moves underneath a cycle between its snapshot and its guarded commit.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Interference {
    None,
    /// An unlock fences the commit the way a lock does mid-flight.
    LockEpoch,
    /// Unrelated durable work lands first, so this replay must not rebase its proof.
    Revision,
    ReplayRevision,
}

struct ScriptedPort {
    lookups: Mutex<Vec<LookupAnswer>>,
    posts: Mutex<Vec<PostAnswer>>,
    posted: AtomicUsize,
    renewals: AtomicUsize,
    persistence: Arc<InMemoryReplica>,
    account_id: AccountId,
    interference: Interference,
}

impl ScriptedPort {
    fn new(persistence: &Arc<InMemoryReplica>, account_id: &AccountId) -> Self {
        Self {
            lookups: Mutex::new(Vec::new()),
            posts: Mutex::new(Vec::new()),
            posted: AtomicUsize::new(0),
            renewals: AtomicUsize::new(0),
            persistence: persistence.clone(),
            account_id: account_id.clone(),
            interference: Interference::None,
        }
    }

    fn script_lookups(self, answers: Vec<LookupAnswer>) -> Self {
        *self.lookups.lock().unwrap() = answers;
        self
    }

    fn script_posts(self, answers: Vec<PostAnswer>) -> Self {
        *self.posts.lock().unwrap() = answers;
        self
    }

    fn interfering(mut self, interference: Interference) -> Self {
        self.interference = interference;
        self
    }
}

#[async_trait]
impl super::import_executor::ImportExecutorPort for ScriptedPort {
    async fn lookup(&self, _operation: &crate::replica::OperationRecord) -> LookupAnswer {
        let mut lookups = self.lookups.lock().unwrap();
        assert!(
            !lookups.is_empty(),
            "the history scripted no further lookup"
        );
        lookups.remove(0)
    }

    async fn post_exact(&self, operation: &crate::replica::OperationRecord) -> PostAnswer {
        if self.interference == Interference::ReplayRevision {
            self.before_reconcile(operation).await;
        }
        self.posted.fetch_add(1, Ordering::SeqCst);
        let mut posts = self.posts.lock().unwrap();
        assert!(!posts.is_empty(), "the history scripted no further send");
        posts.remove(0)
    }

    async fn renew_session(&self) -> Result<(), super::import_executor::ImportExecutorError> {
        self.renewals.fetch_add(1, Ordering::SeqCst);
        Ok(())
    }

    async fn before_reconcile(&self, operation: &crate::replica::OperationRecord) {
        let snapshot = self.persistence.snapshot(&self.account_id).unwrap();
        match self.interference {
            Interference::None => {}
            Interference::LockEpoch => self
                .persistence
                .set_lock_epoch(&self.account_id, snapshot.lock_epoch + 1)
                .unwrap(),
            Interference::Revision | Interference::ReplayRevision => {
                // A later durable write requires a fresh replay, never rebasing this proof.
                let mut rescheduled = operation.clone();
                rescheduled.scheduling.attempt_count += 1;
                let result = self
                    .persistence
                    .execute(GuardedCommitPlan::new(
                        self.account_id.clone(),
                        snapshot.incarnation,
                        snapshot.revision,
                        snapshot.lock_epoch,
                        vec![PlanMutation::RescheduleOperation(rescheduled)],
                    ))
                    .unwrap();
                assert!(matches!(result, crate::replica::PlanResult::Applied { .. }));
            }
        }
    }
}

fn applied_response(operation_id: &str, imported_count: u16) -> ImportExchangeResponse {
    ImportExchangeResponse {
        status: 200,
        body: serde_json::to_vec(&serde_json::json!({
            "kind": "import_items",
            "operationId": operation_id,
            "result": {
                "status": "applied",
                "vaultId": TEST_VAULT_ID,
                "importedCount": imported_count,
            }
        }))
        .unwrap(),
    }
}

/// The Server's one structured way of saying "this Operation ID belongs to other bytes".
fn reused_identity_response() -> ImportExchangeResponse {
    ImportExchangeResponse {
        status: 422,
        body: serde_json::to_vec(&serde_json::json!({
            "type": "about:blank",
            "title": "Unprocessable Entity",
            "status": 422,
            "code": "OPERATION_ID_REUSED",
        }))
        .unwrap(),
    }
}

fn rejected_response(operation_id: &str, code: &str) -> ImportExchangeResponse {
    ImportExchangeResponse {
        status: 200,
        body: serde_json::to_vec(&serde_json::json!({
            "kind": "import_items",
            "operationId": operation_id,
            "result": { "status": "rejected", "code": code }
        }))
        .unwrap(),
    }
}

/// The authority the Server owes back for one accepted Item: identical bytes, version 1.
fn authority_dto(
    item: &super::import::ImportRequestItem,
) -> crate::server_contract::ItemResponseDto {
    crate::server_contract::ItemResponseDto {
        category: item.category.clone(),
        created_at: "2026-09-01T00:00:00Z".into(),
        deleted_at: None,
        encrypted_by_user_id: "user-import".into(),
        encrypted_data: item.encrypted_data.clone(),
        encryption_algorithm: item.encryption_algorithm.clone(),
        encryption_iv: item.encryption_iv.clone(),
        encryption_version: 1,
        favorite: item.favorite,
        id: item.item_id.clone(),
        last_modified_by: "user-import".into(),
        updated_at: "2026-09-01T00:00:00Z".into(),
        vault_id: TEST_VAULT_ID.into(),
        version: 1,
    }
}

/// Bootstrap authority is keyed by generation, so a history asks about the Item, not the key.
fn holds_authority_item(snapshot: &crate::replica::ReplicaSnapshot, item_id: &str) -> bool {
    snapshot
        .bootstrap
        .items
        .keys()
        .any(|(_, candidate)| candidate == item_id)
}

fn accepted_items(
    runtime: &Arc<Runtime>,
    account_id: &AccountId,
) -> Vec<super::import::ImportRequestItem> {
    let snapshot = runtime.replica().snapshot(account_id).unwrap();
    super::import::decode_import_request(&snapshot.operations[0])
        .unwrap()
        .items
}

async fn accept(
    runtime: &Arc<Runtime>,
    account_id: &AccountId,
    drafts: Vec<ImportItemDraft>,
) -> (String, Vec<String>) {
    let response = runtime
        .accept_import_items(
            account_id.clone(),
            TEST_VAULT_ID.into(),
            drafts,
            RequestCancellation::new(),
            || {},
        )
        .await
        .unwrap();
    let RuntimeResponse::ImportBatchAccepted {
        operation_id,
        item_ids,
        ..
    } = response
    else {
        panic!("unexpected response")
    };
    (operation_id, item_ids)
}

const IMPORT_ACCOUNT: &str = "account-import";
const IMPORT_INCARNATION: &str = "incarnation-import";

/// Builds a Runtime over caller-owned durable bytes, so a test can kill it and open a second one
/// over the same Replica the way a restarted process does.
fn runtime_over(persistence: &Arc<InMemoryReplica>, clock: Arc<dyn Clock>) -> Arc<Runtime> {
    let durable: Arc<dyn ReplicaPersistence> = persistence.clone();
    Runtime::with_persistence(
        durable,
        Arc::new(PlatformStorage::unavailable()),
        Arc::new(HttpTransport::unavailable()),
        None,
        None,
        true,
        clock,
        Arc::new(SystemDeviceTimer),
        Some(persistence.clone()),
    )
}

async fn ready_runtime_on(
    persistence: &Arc<InMemoryReplica>,
    clock: Arc<dyn Clock>,
) -> (Arc<Runtime>, AccountId) {
    let runtime = runtime_over(persistence, clock);
    let account_id = AccountId::from(IMPORT_ACCOUNT);
    let incarnation = Incarnation::from(IMPORT_INCARNATION);
    let installed = runtime
        .replica()
        .install_or_replace(
            account_id.clone(),
            "user-import".into(),
            incarnation.clone(),
        )
        .await
        .unwrap();
    runtime.replica().cache(installed);
    runtime.seed_live_master_unlock_key(&account_id, &incarnation);
    runtime.seed_unlocked_preparation_account(&account_id);
    runtime.seed_ready_personal_vault_in_memory(&account_id);
    (runtime, account_id)
}

async fn ready_runtime() -> (Arc<Runtime>, AccountId) {
    let persistence = Arc::new(InMemoryReplica::default());
    ready_runtime_on(&persistence, Arc::new(SystemClock)).await
}

/// Reopens the Runtime over the same durable bytes without any in-memory carry-over, which is
/// what a killed and restarted host process leaves behind.
async fn restarted_runtime(
    persistence: &Arc<InMemoryReplica>,
    clock: Arc<dyn Clock>,
    account_id: &AccountId,
) -> Arc<Runtime> {
    let runtime = runtime_over(persistence, clock);
    runtime.replica().load(account_id).await.unwrap().unwrap();
    runtime.seed_unlocked_preparation_account(account_id);
    runtime
}

/// The durable schedule the whole Runtime shares: one second doubling per attempt, ceiling five
/// minutes. Import may not invent a second policy.
fn expected_backoff_ms(attempt_count: u64) -> u64 {
    (1_000_u64 << u32::try_from(attempt_count.saturating_sub(1).min(20)).unwrap()).min(300_000)
}

fn draft(favorite: bool) -> ImportItemDraft {
    ImportItemDraft {
        favorite,
        draft: ItemDraft::Login(LoginItemData {
            title: "import-secret-marker".into(),
            url: None,
            urls: Vec::new(),
            username: None,
            password: Some("plaintext-password-marker".into()),
            password_history: Vec::new(),
            passkeys: Vec::new(),
            notes: None,
            note: None,
            custom_fields: Vec::new(),
            tags: Vec::new(),
            totp_secret: None,
            totp_issuer: None,
            totp_account_name: None,
            totp_algorithm: None,
            totp_digits: None,
            totp_period: None,
        }),
    }
}

#[tokio::test]
async fn import_acceptance_freezes_order_ids_favorite_and_ciphertext_without_projection() {
    let (runtime, account_id) = ready_runtime().await;
    let response = runtime
        .accept_import_items(
            account_id.clone(),
            TEST_VAULT_ID.into(),
            vec![draft(true), draft(false)],
            RequestCancellation::new(),
            || {},
        )
        .await
        .unwrap();
    let RuntimeResponse::ImportBatchAccepted {
        operation_id,
        item_ids,
        ..
    } = response
    else {
        panic!("unexpected response")
    };
    assert_eq!(item_ids.len(), 2);
    assert_ne!(item_ids[0], item_ids[1]);
    let snapshot = runtime.replica().snapshot(&account_id).unwrap();
    let operation = snapshot
        .operations
        .iter()
        .find(|candidate| candidate.operation_id == operation_id)
        .unwrap();
    assert_eq!(operation.kind, OperationKind::ImportItems);
    let body = super::import::decode_import_request(operation).unwrap();
    assert_eq!(
        body.items
            .iter()
            .map(|item| item.item_id.clone())
            .collect::<Vec<_>>(),
        item_ids
    );
    assert_eq!(
        body.items
            .iter()
            .map(|item| item.favorite)
            .collect::<Vec<_>>(),
        vec![true, false]
    );
    let persisted = String::from_utf8(operation.request.body.clone()).unwrap();
    assert!(!persisted.contains("plaintext-password-marker"));
    assert!(!persisted.contains("import-secret-marker"));
    assert!(
        snapshot.items.is_empty(),
        "pending Imports never project Items"
    );
}

#[tokio::test]
async fn import_accepts_empty_as_a_durable_zero_effect_and_rejects_an_over_bound_batch() {
    let (runtime, account_id) = ready_runtime().await;
    runtime
        .accept_import_items(
            account_id.clone(),
            TEST_VAULT_ID.into(),
            Vec::new(),
            RequestCancellation::new(),
            || {},
        )
        .await
        .unwrap();
    let empty = runtime.replica().snapshot(&account_id).unwrap();
    assert_eq!(
        super::import::decode_import_request(&empty.operations[0])
            .unwrap()
            .items
            .len(),
        0
    );

    let error = runtime
        .accept_import_items(
            account_id.clone(),
            TEST_VAULT_ID.into(),
            (0..=crate::replica::MAX_IMPORT_ITEMS)
                .map(|_| draft(false))
                .collect(),
            RequestCancellation::new(),
            || {},
        )
        .await
        .unwrap_err();
    assert_eq!(error.code, RuntimeErrorCode::SizeRejected);
    assert_eq!(
        runtime
            .replica()
            .snapshot(&account_id)
            .unwrap()
            .operations
            .len(),
        1
    );
}

#[tokio::test]
async fn empty_applied_import_retains_zero_count_without_current_authority() {
    let (runtime, account_id) = ready_runtime().await;
    let (operation_id, _) = accept(&runtime, &account_id, Vec::new()).await;
    let port = AppliedPort {
        outcome: applied_response(&operation_id, 0),
    };
    assert_eq!(
        runtime
            .drive_import_executor_cycle(&account_id, &operation_id, &port)
            .await
            .unwrap(),
        super::import_executor::ImportExecutorPass::Completed
    );
    let completed = runtime.replica.snapshot(&account_id).unwrap();
    assert!(completed.operations.is_empty());
    assert!(completed.bootstrap.items.is_empty());
    assert_eq!(
        completed.receipts[0].result,
        crate::replica::OperationOutcomeResult::ImportApplied {
            vault_id: TEST_VAULT_ID.into(),
            imported_count: 0,
        }
    );
}

#[tokio::test]
async fn production_dispatch_observes_import_retry_deadlines() {
    let clock = super::operation_fixtures::TestClock::new();
    let persistence = Arc::new(InMemoryReplica::default());
    let (runtime, account_id) = ready_runtime_on(&persistence, clock.clone()).await;
    let (operation_id, _) = accept(&runtime, &account_id, vec![draft(false)]).await;

    let transient = LookupFaultPort {
        fault: super::import_executor::ImportExecutorError::Retryable,
        renewals: AtomicUsize::new(0),
    };
    runtime
        .drive_import_executor_cycle(&account_id, &operation_id, &transient)
        .await
        .unwrap();
    let scheduled = persistence.snapshot(&account_id).unwrap();
    assert!(
        scheduled.operations[0].scheduling.not_before_ms > clock.now(),
        "the batch is waiting on a durable deadline"
    );

    assert!(
        matches!(
            runtime.dispatch_eligible_operations().await,
            super::dispatch::DispatchPass::WaitFor {
                milliseconds: 1_000
            }
        ),
        "production dispatch schedules the durable Import retry"
    );
    let snapshot = persistence.snapshot(&account_id).unwrap();
    assert_eq!(snapshot.operations.len(), 1);
    assert_eq!(
        snapshot.operations[0].scheduling, scheduled.operations[0].scheduling,
        "the scan moved nothing"
    );
}

#[tokio::test]
async fn one_ordered_batch_preserves_all_five_categories_and_server_totp_spelling() {
    let (runtime, account_id) = ready_runtime().await;
    let drafts = [
        serde_json::json!({"draft":{"category":"login","data":{"title":"login"}},"favorite":true}),
        serde_json::json!({"draft":{"category":"secure-note","data":{"title":"note","note":"body"}},"favorite":false}),
        serde_json::json!({"draft":{"category":"credit-card","data":{"title":"card"}},"favorite":true}),
        serde_json::json!({"draft":{"category":"identity","data":{"title":"identity"}},"favorite":false}),
        serde_json::json!({"draft":{"category":"authenticator","data":{"title":"totp","totpSecret":"secret"}},"favorite":true}),
    ]
    .into_iter()
    .map(|value| serde_json::from_value(value).unwrap())
    .collect();
    runtime
        .accept_import_items(
            account_id.clone(),
            TEST_VAULT_ID.into(),
            drafts,
            RequestCancellation::new(),
            || {},
        )
        .await
        .unwrap();
    let snapshot = runtime.replica().snapshot(&account_id).unwrap();
    let operation = &snapshot.operations[0];
    let body = super::import::decode_import_request(operation).unwrap();
    assert_eq!(
        body.items
            .into_iter()
            .map(|item| serde_json::to_value(item.category).unwrap())
            .collect::<Vec<_>>(),
        vec!["login", "secure-note", "credit-card", "identity", "totp"]
    );
}

#[tokio::test]
async fn retry_count_never_owns_work_and_second_401_parks_without_removal() {
    let (runtime, account_id) = ready_runtime().await;
    let response = runtime
        .accept_import_items(
            account_id.clone(),
            TEST_VAULT_ID.into(),
            vec![draft(false)],
            RequestCancellation::new(),
            || {},
        )
        .await
        .unwrap();
    let RuntimeResponse::ImportBatchAccepted { operation_id, .. } = response else {
        panic!()
    };
    let frozen = runtime.replica().snapshot(&account_id).unwrap().operations[0]
        .request
        .clone();
    let transient = LookupFaultPort {
        fault: super::import_executor::ImportExecutorError::Retryable,
        renewals: AtomicUsize::new(0),
    };
    for _ in 0..6 {
        assert_eq!(
            runtime
                .drive_import_executor_cycle(&account_id, &operation_id, &transient)
                .await
                .unwrap(),
            super::import_executor::ImportExecutorPass::RetryScheduled
        );
    }
    let pending = runtime.replica().snapshot(&account_id).unwrap();
    assert_eq!(pending.operations.len(), 1);
    assert_eq!(pending.operations[0].scheduling.attempt_count, 6);
    assert_eq!(pending.operations[0].request, frozen);

    let unauthorized = LookupFaultPort {
        fault: super::import_executor::ImportExecutorError::Unauthorized,
        renewals: AtomicUsize::new(0),
    };
    assert_eq!(
        runtime
            .drive_import_executor_cycle(&account_id, &operation_id, &unauthorized)
            .await
            .unwrap(),
        super::import_executor::ImportExecutorPass::ReauthenticationRequired
    );
    assert_eq!(unauthorized.renewals.load(Ordering::SeqCst), 1);
    assert_eq!(
        runtime
            .replica()
            .snapshot(&account_id)
            .unwrap()
            .operations
            .len(),
        1
    );
}

#[tokio::test]
async fn changed_replay_and_every_closed_rejection_never_project_imported_items() {
    let (runtime, account_id) = ready_runtime().await;
    let response = runtime
        .accept_import_items(
            account_id.clone(),
            TEST_VAULT_ID.into(),
            vec![draft(false)],
            RequestCancellation::new(),
            || {},
        )
        .await
        .unwrap();
    let RuntimeResponse::ImportBatchAccepted { operation_id, .. } = response else {
        panic!()
    };
    // Identity reuse is the Server saying these accepted bytes can never be sent again. It is
    // terminal for the Account module, not a retryable transport answer.
    let reused = AppliedPort {
        outcome: reused_identity_response(),
    };
    assert_eq!(
        runtime
            .drive_import_executor_cycle(&account_id, &operation_id, &reused)
            .await
            .unwrap_err()
            .code,
        RuntimeErrorCode::AccountFailed
    );
    let fenced = runtime.replica().snapshot(&account_id).unwrap();
    assert!(
        fenced.failure.is_some(),
        "reused identity fences the Account module instead of looping"
    );
    assert_eq!(fenced.operations.len(), 1);
    assert!(fenced.receipts.is_empty());
    assert!(fenced.bootstrap.items.is_empty());

    for code in [
        "invalid_ciphertext",
        "vault_access_denied",
        "vault_read_only",
        "item_id_conflict",
    ] {
        let (runtime, account_id) = ready_runtime().await;
        let response = runtime
            .accept_import_items(
                account_id.clone(),
                TEST_VAULT_ID.into(),
                vec![draft(false)],
                RequestCancellation::new(),
                || {},
            )
            .await
            .unwrap();
        let RuntimeResponse::ImportBatchAccepted { operation_id, .. } = response else {
            panic!()
        };
        let port = AppliedPort {
            outcome: super::import_executor::ImportExchangeResponse {
                status: 200,
                body: serde_json::to_vec(&serde_json::json!({
                    "kind": "import_items", "operationId": operation_id,
                    "result": { "status": "rejected", "code": code }
                }))
                .unwrap(),
            },
        };
        assert_eq!(
            runtime
                .drive_import_executor_cycle(&account_id, &operation_id, &port)
                .await
                .unwrap(),
            super::import_executor::ImportExecutorPass::Completed
        );
        let snapshot = runtime.replica().snapshot(&account_id).unwrap();
        assert!(snapshot.operations.is_empty());
        assert!(snapshot.bootstrap.items.is_empty());
        assert_eq!(snapshot.receipts.len(), 1);

        let RuntimeProjection::Operations(projection) = runtime
            .projection(&ObservationRequest::Operations {
                account_id: account_id.clone(),
            })
            .unwrap()
            .projection
        else {
            panic!("Operations projection")
        };
        assert_eq!(
            projection.operations[0].resolution,
            crate::OperationResolution::Rejected
        );
        assert_eq!(
            projection.operations[0].rejection_code.as_deref(),
            Some(code)
        );
        assert_eq!(projection.operations[0].imported_count, None);
    }
}

#[tokio::test]
async fn import_retry_persists_the_shared_bounded_exponential_backoff_schedule() {
    let clock = super::operation_fixtures::TestClock::new();
    let persistence = Arc::new(InMemoryReplica::default());
    let (runtime, account_id) = ready_runtime_on(&persistence, clock.clone()).await;
    let response = runtime
        .accept_import_items(
            account_id.clone(),
            TEST_VAULT_ID.into(),
            vec![draft(false)],
            RequestCancellation::new(),
            || {},
        )
        .await
        .unwrap();
    let RuntimeResponse::ImportBatchAccepted { operation_id, .. } = response else {
        panic!()
    };
    let transient = LookupFaultPort {
        fault: super::import_executor::ImportExecutorError::Retryable,
        renewals: AtomicUsize::new(0),
    };

    // Twelve attempts walk the doubling schedule past its ceiling, so a Device that stays offline
    // for hours cannot turn Import into a hot loop.
    for attempt_count in 1..=12u64 {
        assert_eq!(
            runtime
                .drive_import_executor_cycle(&account_id, &operation_id, &transient)
                .await
                .unwrap(),
            super::import_executor::ImportExecutorPass::RetryScheduled
        );
        let expected = clock
            .now()
            .saturating_add(expected_backoff_ms(attempt_count));
        let durable = persistence.snapshot(&account_id).unwrap();
        assert_eq!(
            durable.operations[0].scheduling.attempt_count, attempt_count,
            "attempt {attempt_count} counts its own transport answer"
        );
        assert_eq!(
            durable.operations[0].scheduling.not_before_ms, expected,
            "attempt {attempt_count} persists the shared bounded exponential delay"
        );
        assert_eq!(
            runtime.replica().snapshot(&account_id).unwrap().operations[0].scheduling,
            durable.operations[0].scheduling,
            "the cached schedule never drifts from the durable one"
        );
        clock.advance(expected_backoff_ms(attempt_count));
    }
    assert_eq!(
        expected_backoff_ms(12),
        300_000,
        "the schedule is bounded, not unbounded doubling"
    );
}

#[tokio::test]
async fn an_offline_batch_and_its_durable_schedule_survive_a_restart_byte_for_byte() {
    let clock = super::operation_fixtures::TestClock::new();
    let persistence = Arc::new(InMemoryReplica::default());
    let (runtime, account_id) = ready_runtime_on(&persistence, clock.clone()).await;
    // No transport is installed at all, which is what an offline Device offers an accepted batch.
    let (operation_id, item_ids) = accept(
        &runtime,
        &account_id,
        vec![draft(true), draft(false), draft(true)],
    )
    .await;
    let offline = LookupFaultPort {
        fault: super::import_executor::ImportExecutorError::Retryable,
        renewals: AtomicUsize::new(0),
    };
    runtime
        .drive_import_executor_cycle(&account_id, &operation_id, &offline)
        .await
        .unwrap();
    let before = persistence.snapshot(&account_id).unwrap().operations[0].clone();

    // A killed host process never closes politely, and it never gets to hand anything over.
    drop(runtime);
    let restarted = restarted_runtime(&persistence, clock.clone(), &account_id).await;

    let after = restarted.replica().snapshot(&account_id).unwrap();
    assert_eq!(after.operations.len(), 1);
    assert_eq!(after.operations[0], before);
    assert_eq!(after.operations[0].request.body, before.request.body);
    assert_eq!(after.operations[0].request.headers, before.request.headers);
    assert_eq!(
        after.operations[0].request_fingerprint,
        before.request_fingerprint
    );
    assert_eq!(
        after.operations[0].scheduling.attempt_count, 1,
        "the restart inherits the attempt count instead of restarting the schedule"
    );
    assert_eq!(
        after.operations[0].scheduling.not_before_ms,
        clock.now() + 1_000
    );
    assert_eq!(
        super::import::decode_import_request(&after.operations[0])
            .unwrap()
            .items
            .iter()
            .map(|item| item.item_id.clone())
            .collect::<Vec<_>>(),
        item_ids,
        "the restarted process replays the same ordered identities"
    );
    assert!(
        after.bootstrap.items.is_empty() && after.items.is_empty(),
        "an unreconciled batch projects nothing before and after a restart"
    );
    assert!(matches!(
        restarted.dispatch_eligible_operations().await,
        super::dispatch::DispatchPass::WaitFor {
            milliseconds: 1_000
        }
    ));
}

#[tokio::test]
async fn a_dropped_response_completes_once_from_the_duplicate_send_and_its_lookup() {
    let clock = super::operation_fixtures::TestClock::new();
    let persistence = Arc::new(InMemoryReplica::default());
    let (runtime, account_id) = ready_runtime_on(&persistence, clock.clone()).await;
    let (operation_id, item_ids) = accept(&runtime, &account_id, vec![draft(true)]).await;
    let port = ScriptedPort::new(&persistence, &account_id)
        .script_lookups(vec![
            // The first send reached the Server; only its response was lost.
            Ok(None),
            Ok(Some(applied_response(&operation_id, 1))),
        ])
        .script_posts(vec![
            Err(super::import_executor::ImportExecutorError::Retryable),
            Ok(applied_response(&operation_id, 1)),
        ]);

    assert_eq!(
        runtime
            .drive_import_executor_cycle(&account_id, &operation_id, &port)
            .await
            .unwrap(),
        super::import_executor::ImportExecutorPass::RetryScheduled
    );
    let waiting = persistence.snapshot(&account_id).unwrap();
    assert_eq!(waiting.operations.len(), 1);
    assert_eq!(waiting.operations[0].scheduling.attempt_count, 1);
    assert!(waiting.receipts.is_empty());
    assert!(waiting.bootstrap.items.is_empty());

    assert_eq!(
        runtime
            .drive_import_executor_cycle(&account_id, &operation_id, &port)
            .await
            .unwrap(),
        super::import_executor::ImportExecutorPass::Completed
    );
    let completed = persistence.snapshot(&account_id).unwrap();
    assert!(completed.operations.is_empty());
    assert_eq!(completed.receipts.len(), 1);
    assert!(completed.bootstrap.items.is_empty());
    assert!(!holds_authority_item(&completed, &item_ids[0]));
    assert_eq!(
        port.posted.load(Ordering::SeqCst),
        2,
        "the duplicate send is exact, and the Server makes the effect happen once"
    );

    // A third cycle has nothing left to own: the batch already reached its semantic outcome.
    assert_eq!(
        runtime
            .drive_import_executor_cycle(&account_id, &operation_id, &port)
            .await
            .unwrap(),
        super::import_executor::ImportExecutorPass::ParkedFenced
    );
    assert_eq!(persistence.snapshot(&account_id).unwrap().receipts.len(), 1);
}

#[tokio::test]
async fn a_changed_replay_never_reconciles_the_accepted_batch() {
    for case in [
        // The lookup and the exact replay disagree about the same Operation identity.
        ChangedReplay::ContradictingHint,
        // The lookup says these accepted bytes can never be sent under this identity again.
        ChangedReplay::ReusedIdentityHint,
        // The Server answers about a batch size this Device never accepted.
        ChangedReplay::ChangedCount,
    ] {
        let clock = super::operation_fixtures::TestClock::new();
        let persistence = Arc::new(InMemoryReplica::default());
        let (runtime, account_id) = ready_runtime_on(&persistence, clock.clone()).await;
        let (operation_id, _) = accept(&runtime, &account_id, vec![draft(true)]).await;
        let (lookup, replay, expected_code) = match case {
            ChangedReplay::ContradictingHint => (
                Some(applied_response(&operation_id, 1)),
                applied_response(&operation_id, 0),
                RuntimeErrorCode::AccountFailed,
            ),
            ChangedReplay::ReusedIdentityHint => (
                Some(reused_identity_response()),
                applied_response(&operation_id, 1),
                RuntimeErrorCode::AccountFailed,
            ),
            ChangedReplay::ChangedCount => (
                None,
                applied_response(&operation_id, 5),
                RuntimeErrorCode::AccountFailed,
            ),
        };
        let port = ScriptedPort::new(&persistence, &account_id)
            .script_lookups(vec![Ok(lookup)])
            .script_posts(vec![Ok(replay)]);

        assert_eq!(
            runtime
                .drive_import_executor_cycle(&account_id, &operation_id, &port)
                .await
                .unwrap_err()
                .code,
            expected_code,
            "{case:?} answers with the shared semantic-answer policy"
        );
        let retained = persistence.snapshot(&account_id).unwrap();
        assert_eq!(
            retained.failure.is_some(),
            expected_code == RuntimeErrorCode::AccountFailed,
            "{case:?} fences the Account module only when the identity is unusable"
        );
        assert_eq!(retained.operations.len(), 1);
        assert!(retained.receipts.is_empty());
        assert!(retained.bootstrap.items.is_empty());
    }
}

#[tokio::test]
async fn a_422_without_the_reuse_code_retries_under_the_persisted_backoff() {
    // A bare 422 carries no decision this Runtime may act on. Only the Server's structured
    // `OPERATION_ID_REUSED` problem ends accepted work; everything else is transport-shaped.
    for body in [
        Vec::new(),
        serde_json::to_vec(&serde_json::json!({
            "type": "about:blank",
            "title": "Unprocessable Entity",
            "status": 422,
            "code": "VALIDATION_FAILED",
        }))
        .unwrap(),
    ] {
        let clock = super::operation_fixtures::TestClock::new();
        let persistence = Arc::new(InMemoryReplica::default());
        let (runtime, account_id) = ready_runtime_on(&persistence, clock.clone()).await;
        let (operation_id, _) = accept(&runtime, &account_id, vec![draft(true)]).await;
        let port = ScriptedPort::new(&persistence, &account_id)
            .script_lookups(vec![Ok(None)])
            .script_posts(vec![Ok(ImportExchangeResponse { status: 422, body })]);

        assert_eq!(
            runtime
                .drive_import_executor_cycle(&account_id, &operation_id, &port)
                .await
                .unwrap(),
            super::import_executor::ImportExecutorPass::RetryScheduled
        );
        let retained = persistence.snapshot(&account_id).unwrap();
        assert!(
            retained.failure.is_none(),
            "a transport-shaped 422 never fails the Account module"
        );
        assert_eq!(retained.operations.len(), 1);
        assert_eq!(retained.operations[0].scheduling.attempt_count, 1);
        assert_eq!(
            retained.operations[0].scheduling.not_before_ms,
            clock.now() + 1_000,
            "the durable schedule advances instead of hot-looping"
        );
        assert!(retained.receipts.is_empty());
    }
}

#[tokio::test]
async fn one_renewal_is_spent_once_per_cycle_wherever_the_401_lands() {
    // The budget belongs to the cycle, not to one exchange. A renewal spent answering the lookup
    // is gone by the time the exact replay sees its own 401.
    {
        let clock = super::operation_fixtures::TestClock::new();
        let persistence = Arc::new(InMemoryReplica::default());
        let (runtime, account_id) = ready_runtime_on(&persistence, clock.clone()).await;
        let (operation_id, _) = accept(&runtime, &account_id, vec![draft(true)]).await;
        let port = ScriptedPort::new(&persistence, &account_id)
            .script_lookups(vec![
                Err(super::import_executor::ImportExecutorError::Unauthorized),
                Ok(None),
            ])
            .script_posts(vec![Err(
                super::import_executor::ImportExecutorError::Unauthorized,
            )]);

        assert_eq!(
            runtime
                .drive_import_executor_cycle(&account_id, &operation_id, &port)
                .await
                .unwrap(),
            super::import_executor::ImportExecutorPass::ReauthenticationRequired
        );
        assert_eq!(
            port.renewals.load(Ordering::SeqCst),
            1,
            "the second 401 parks the Account instead of renewing again"
        );
        let retained = persistence.snapshot(&account_id).unwrap();
        assert_eq!(retained.operations.len(), 1);
        assert!(retained.receipts.is_empty());
        assert!(retained.bootstrap.items.is_empty());
    }
}

#[tokio::test]
async fn a_fenced_or_stale_exact_commit_keeps_the_batch_accepted() {
    for interference in [Interference::LockEpoch, Interference::Revision] {
        let clock = super::operation_fixtures::TestClock::new();
        let persistence = Arc::new(InMemoryReplica::default());
        let (runtime, account_id) = ready_runtime_on(&persistence, clock.clone()).await;
        let (operation_id, _item_ids) = accept(&runtime, &account_id, vec![draft(true)]).await;
        let port = ScriptedPort::new(&persistence, &account_id)
            .script_lookups(vec![Ok(None)])
            .script_posts(vec![Ok(applied_response(&operation_id, 1))])
            .interfering(interference);
        let pass = runtime
            .drive_import_executor_cycle(&account_id, &operation_id, &port)
            .await
            .unwrap();
        let durable = persistence.snapshot(&account_id).unwrap();
        assert_eq!(
            pass,
            super::import_executor::ImportExecutorPass::ParkedFenced
        );
        assert_eq!(durable.operations.len(), 1, "a fence never loses the batch");
        assert!(durable.receipts.is_empty());
        assert!(durable.bootstrap.items.is_empty());
    }
}

#[tokio::test]
async fn an_earlier_batch_receipt_and_authority_survive_a_later_independent_batch() {
    let clock = super::operation_fixtures::TestClock::new();
    let persistence = Arc::new(InMemoryReplica::default());
    let (runtime, account_id) = ready_runtime_on(&persistence, clock.clone()).await;

    let (first_operation, first_items) = accept(&runtime, &account_id, vec![draft(true)]).await;
    let accepted = accepted_items(&runtime, &account_id);
    let first = ScriptedPort::new(&persistence, &account_id)
        .script_lookups(vec![Ok(None)])
        .script_posts(vec![Ok(applied_response(&first_operation, 1))]);
    runtime
        .drive_import_executor_cycle(&account_id, &first_operation, &first)
        .await
        .unwrap();

    let current_vaults = persistence
        .snapshot(&account_id)
        .unwrap()
        .bootstrap
        .snapshot()
        .visible_vaults;
    persistence
        .seed_ready_authority(
            &account_id,
            current_vaults,
            vec![super::bootstrap::authority_item_from_dto(authority_dto(&accepted[0])).unwrap()],
        )
        .unwrap();
    runtime.replica.load(&account_id).await.unwrap();
    let (second_operation, _) = accept(&runtime, &account_id, vec![draft(false)]).await;
    let second = ScriptedPort::new(&persistence, &account_id)
        .script_lookups(vec![Ok(None)])
        .script_posts(vec![Ok(rejected_response(
            &second_operation,
            "vault_read_only",
        ))]);
    runtime
        .drive_import_executor_cycle(&account_id, &second_operation, &second)
        .await
        .unwrap();

    let durable = persistence.snapshot(&account_id).unwrap();
    assert!(durable.operations.is_empty());
    assert_eq!(
        durable.receipts.len(),
        2,
        "a later rejection never overwrites an earlier batch receipt"
    );
    assert!(durable
        .receipts
        .iter()
        .any(|receipt| receipt.operation_id == first_operation));
    assert_eq!(durable.bootstrap.items.len(), 1);
    assert!(holds_authority_item(&durable, &first_items[0]));
}

#[tokio::test]
async fn a_batch_with_duplicate_item_ids_is_refused_before_it_can_become_durable() {
    let clock = super::operation_fixtures::TestClock::new();
    let persistence = Arc::new(InMemoryReplica::default());
    let (runtime, account_id) = ready_runtime_on(&persistence, clock.clone()).await;
    let (_, _) = accept(&runtime, &account_id, vec![draft(true)]).await;
    let snapshot = runtime.replica().snapshot(&account_id).unwrap();
    let mut item = super::import::decode_import_request(&snapshot.operations[0])
        .unwrap()
        .items
        .remove(0);
    item.favorite = false;
    let body = serde_json::to_vec(&super::import::ImportRequestBody {
        items: vec![item.clone(), item],
    })
    .unwrap();
    let mut forged = snapshot.operations[0].clone();
    forged.operation_id = "operation-import-duplicate".into();
    forged.request_fingerprint = super::import::import_items_fingerprint(TEST_VAULT_ID, &body);
    forged.request.body = body;

    assert_eq!(
        super::import::decode_import_request(&forged)
            .err()
            .expect("a repeated Item identity is not decodable")
            .code,
        RuntimeErrorCode::InvariantViolation,
        "the executor refuses to replay a batch that repeats an Item identity"
    );
    let refused = runtime
        .replica()
        .execute_recomputing(GuardedCommitPlan::new(
            account_id.clone(),
            snapshot.incarnation.clone(),
            snapshot.revision,
            snapshot.lock_epoch,
            vec![PlanMutation::AcceptOperation(forged)],
        ))
        .await
        .err()
        .expect("a repeated Item identity is not acceptable");
    assert_eq!(refused.code, RuntimeErrorCode::InvariantViolation);
    assert_eq!(
        persistence.snapshot(&account_id).unwrap().operations.len(),
        1,
        "the refused batch never became durable"
    );
}

#[tokio::test]
async fn a_batch_at_the_item_bound_freezes_one_ordered_request() {
    let bound = crate::replica::MAX_IMPORT_ITEMS;
    let (runtime, account_id) = ready_runtime().await;
    let drafts = (0..bound).map(|index| draft(index % 2 == 0)).collect();
    let (_, item_ids) = accept(&runtime, &account_id, drafts).await;
    assert_eq!(item_ids.len(), bound);
    let items = accepted_items(&runtime, &account_id);
    assert_eq!(
        items
            .iter()
            .map(|item| item.item_id.clone())
            .collect::<Vec<_>>(),
        item_ids,
        "the frozen request keeps the accepted order at the bound"
    );
    assert_eq!(
        items.iter().map(|item| item.favorite).collect::<Vec<_>>(),
        (0..bound).map(|index| index % 2 == 0).collect::<Vec<_>>()
    );
    assert_eq!(
        items
            .iter()
            .map(|item| item.item_id.clone())
            .collect::<std::collections::HashSet<_>>()
            .len(),
        bound,
        "Rust mints one distinct identity per accepted draft"
    );
}

#[tokio::test]
async fn a_fenced_import_acceptance_converges_this_device_to_locked() {
    let clock = super::operation_fixtures::TestClock::new();
    let persistence = Arc::new(InMemoryReplica::default());
    let (runtime, account_id) = ready_runtime_on(&persistence, clock.clone()).await;
    let incarnation = Incarnation::from(IMPORT_INCARNATION);
    runtime.decrypt_visible_items(&account_id).unwrap();
    assert!(runtime
        .unlocked_items
        .lock()
        .unwrap()
        .contains_key(&account_id));
    let revision_before = runtime.device_revision.load(Ordering::SeqCst);

    // Another Device locked the Account after this one read its snapshot.
    persistence.set_lock_epoch(&account_id, 1).unwrap();
    let error = runtime
        .accept_import_items(
            account_id.clone(),
            TEST_VAULT_ID.into(),
            vec![draft(true)],
            RequestCancellation::new(),
            || panic!("a fenced acceptance never reports accepted work"),
        )
        .await
        .unwrap_err();

    assert_eq!(error.code, RuntimeErrorCode::AuthenticationRequired);
    assert_eq!(
        runtime
            .account_access
            .lock()
            .unwrap()
            .get(&account_id)
            .copied(),
        Some(AccountAccessState::Locked),
        "the fence converges this Device instead of leaving it believing it is unlocked"
    );
    assert!(
        runtime
            .copy_live_master_unlock_key(&account_id, &incarnation)
            .is_none(),
        "a fenced acceptance drops the live key it copied to encrypt the batch"
    );
    assert!(!runtime
        .unlocked_items
        .lock()
        .unwrap()
        .contains_key(&account_id));
    assert_eq!(
        runtime.account_lock_epochs.lock().unwrap().get(&account_id),
        Some(&1)
    );
    assert_eq!(
        runtime.replica().snapshot(&account_id).unwrap().lock_epoch,
        1
    );
    assert!(runtime.device_revision.load(Ordering::SeqCst) > revision_before);
    assert!(persistence
        .snapshot(&account_id)
        .unwrap()
        .operations
        .is_empty());
}

#[tokio::test]
async fn import_acceptance_against_a_removed_account_drops_every_local_trace() {
    let clock = super::operation_fixtures::TestClock::new();
    let persistence = Arc::new(InMemoryReplica::default());
    let (runtime, account_id) = ready_runtime_on(&persistence, clock.clone()).await;
    let incarnation = Incarnation::from(IMPORT_INCARNATION);
    runtime.decrypt_visible_items(&account_id).unwrap();
    let revision_before = runtime.device_revision.load(Ordering::SeqCst);

    // The Account was removed after this one read its snapshot.
    persistence.remove(&account_id);
    let error = runtime
        .accept_import_items(
            account_id.clone(),
            TEST_VAULT_ID.into(),
            vec![draft(true)],
            RequestCancellation::new(),
            || panic!("a missing Account never reports accepted work"),
        )
        .await
        .unwrap_err();

    assert_eq!(error.code, RuntimeErrorCode::AccountMissing);
    assert!(
        runtime.replica().snapshot(&account_id).is_none(),
        "the removed Account leaves no cached snapshot behind"
    );
    assert!(!runtime
        .unlocked_items
        .lock()
        .unwrap()
        .contains_key(&account_id));
    assert!(!runtime
        .recovery_accounts
        .lock()
        .unwrap()
        .contains_key(&account_id));
    assert!(runtime
        .copy_live_master_unlock_key(&account_id, &incarnation)
        .is_none());
    assert!(runtime.device_revision.load(Ordering::SeqCst) > revision_before);
}

/// Maps one generated wire category to the host draft that produces it.
///
/// The `match` is exhaustive on purpose. A new generated `ItemCategory` breaks this build, which
/// is the drift guard: the Replica must never accept a category list written out by hand.
fn draft_for_category(category: &crate::server_contract::ItemCategory) -> ImportItemDraft {
    use crate::server_contract::ItemCategory;

    let value = match category {
        ItemCategory::Login => serde_json::json!({"category":"login","data":{"title":"login"}}),
        ItemCategory::SecureNote => {
            serde_json::json!({"category":"secure-note","data":{"title":"note","note":"body"}})
        }
        ItemCategory::CreditCard => {
            serde_json::json!({"category":"credit-card","data":{"title":"card"}})
        }
        ItemCategory::Identity => {
            serde_json::json!({"category":"identity","data":{"title":"identity"}})
        }
        ItemCategory::Totp => {
            serde_json::json!({"category":"authenticator","data":{"title":"totp","totpSecret":"s"}})
        }
    };
    ImportItemDraft {
        favorite: false,
        draft: serde_json::from_value(value).unwrap(),
    }
}

#[tokio::test]
async fn every_generated_item_category_reaches_durable_import_acceptance() {
    use crate::server_contract::ItemCategory;

    let categories = [
        ItemCategory::Login,
        ItemCategory::SecureNote,
        ItemCategory::CreditCard,
        ItemCategory::Identity,
        ItemCategory::Totp,
    ];
    let clock = super::operation_fixtures::TestClock::new();
    let persistence = Arc::new(InMemoryReplica::default());
    let (runtime, account_id) = ready_runtime_on(&persistence, clock.clone()).await;
    let (_, item_ids) = accept(
        &runtime,
        &account_id,
        categories.iter().map(draft_for_category).collect(),
    )
    .await;

    // The Replica accepted the batch, so its validation agreed with the generated wire set.
    let durable = persistence.snapshot(&account_id).unwrap();
    assert_eq!(durable.operations.len(), 1);
    let body = super::import::decode_import_request(&durable.operations[0]).unwrap();
    assert_eq!(
        body.items
            .iter()
            .map(|item| item.item_id.clone())
            .collect::<Vec<_>>(),
        item_ids
    );
    assert!(
        body.items
            .iter()
            .map(|item| &item.category)
            .eq(categories.iter()),
        "every generated category survives the trust boundary unchanged"
    );
}

#[tokio::test]
async fn an_applied_import_count_is_read_against_the_shared_batch_bound() {
    let bound = crate::replica::MAX_IMPORT_ITEMS;
    let clock = super::operation_fixtures::TestClock::new();
    let persistence = Arc::new(InMemoryReplica::default());
    let (runtime, account_id) = ready_runtime_on(&persistence, clock.clone()).await;
    let (operation_id, _) = accept(&runtime, &account_id, vec![draft(true)]).await;
    let operation = runtime.replica().snapshot(&account_id).unwrap().operations[0].clone();
    let answer = |imported_count: i64| {
        let body = serde_json::to_vec(&serde_json::json!({
            "kind": "import_items",
            "operationId": operation_id,
            "result": {
                "status": "applied",
                "vaultId": TEST_VAULT_ID,
                "importedCount": imported_count,
            }
        }))
        .unwrap();
        runtime.read_dispatch_answer(&operation, 200, &body)
    };

    // A count the accepted batch bound allows is a decision this Runtime can read.
    assert!(matches!(
        answer(i64::try_from(bound).unwrap()),
        super::outcome::SemanticAnswer::Outcome(_)
    ));
    // One past the bound is a payload the Server's closed schema cannot produce, so it is
    // malformed and retryable — never a decision, and never a reason to fence.
    assert!(matches!(
        answer(i64::try_from(bound).unwrap() + 1),
        super::outcome::SemanticAnswer::Transient
    ));
    assert!(matches!(
        answer(-1),
        super::outcome::SemanticAnswer::Transient
    ));
}

#[tokio::test]
async fn a_mis_targeted_import_record_is_refused_at_the_replica_trust_boundary() {
    let clock = super::operation_fixtures::TestClock::new();
    let persistence = Arc::new(InMemoryReplica::default());
    let (runtime, account_id) = ready_runtime_on(&persistence, clock.clone()).await;
    let (_, item_ids) = accept(&runtime, &account_id, vec![draft(true)]).await;
    let snapshot = runtime.replica().snapshot(&account_id).unwrap();

    // An Import batch that claims an Item target would otherwise reach the permissive Item arm
    // and skip route, body, duplicate-ID, and fingerprint validation entirely.
    let mut forged = snapshot.operations[0].clone();
    forged.operation_id = "operation-import-mis-targeted".into();
    forged.target = crate::replica::ResourceRef::Item {
        item_id: item_ids[0].clone(),
        vault_id: TEST_VAULT_ID.into(),
    };
    let refused = runtime
        .replica()
        .execute_recomputing(GuardedCommitPlan::new(
            account_id.clone(),
            snapshot.incarnation.clone(),
            snapshot.revision,
            snapshot.lock_epoch,
            vec![PlanMutation::AcceptOperation(forged)],
        ))
        .await
        .err()
        .expect("an Import record with an Item target is not acceptable");
    assert_eq!(refused.code, RuntimeErrorCode::InvariantViolation);
    assert_eq!(
        persistence.snapshot(&account_id).unwrap().operations.len(),
        1,
        "the mis-targeted record never became durable"
    );
}

#[tokio::test]
async fn caller_cancellation_after_acceptance_only_detaches_the_waiter() {
    let (runtime, account_id) = ready_runtime().await;
    let cancellation = RequestCancellation::new();
    let cancel_after_commit = cancellation.clone();
    let error = runtime
        .accept_import_items(
            account_id.clone(),
            TEST_VAULT_ID.into(),
            vec![draft(false)],
            cancellation,
            move || cancel_after_commit.cancel(),
        )
        .await
        .unwrap_err();
    assert_eq!(error.code, RuntimeErrorCode::Cancelled);
    let snapshot = runtime.replica().snapshot(&account_id).unwrap();
    assert_eq!(snapshot.operations.len(), 1);
    assert!(snapshot.items.is_empty());
}

/// Existing offline acceptance and Server body limits remain unchanged by reconciliation.
#[test]
fn import_batch_bytes_fit_the_server_ceiling() {
    assert_eq!(super::import::SERVER_IMPORT_BODY_BYTES, 16 * 1024 * 1024);
    assert_eq!(super::import::MAX_IMPORT_REQUEST_BYTES, 15 * 1024 * 1024);
    assert_eq!(crate::replica::MAX_IMPORT_ITEMS, 200);
}

/// A batch the accepted byte bound cannot carry is refused at accept time, so it never becomes durable.
#[tokio::test]
async fn a_batch_past_the_byte_bound_is_refused_before_it_becomes_durable() {
    let (runtime, account_id) = ready_runtime().await;

    // Every Item fits the individual ciphertext bound, but twenty together exceed the
    // frozen-body bound. Measure actual encryption so the individual gate cannot mask this one.
    let mut large = draft(false);
    let ItemDraft::Login(data) = &mut large.draft else {
        panic!("the fixture draft is a Login")
    };
    data.notes = Some("n".repeat(600 * 1024));
    let (measurement_runtime, measurement_account) = ready_runtime().await;
    accept(
        &measurement_runtime,
        &measurement_account,
        vec![large.clone()],
    )
    .await;
    let measurement = measurement_runtime
        .replica()
        .snapshot(&measurement_account)
        .unwrap();
    let body = super::import::decode_import_request(&measurement.operations[0]).unwrap();
    assert!(body.items[0].encrypted_data.len() <= super::import::SERVER_ITEM_CIPHERTEXT_BYTES);
    let measured_batch = super::import::ImportRequestBody {
        items: vec![body.items[0].clone(); 20],
    };
    assert!(
        serde_json::to_vec(&measured_batch).unwrap().len()
            > super::import::MAX_IMPORT_REQUEST_BYTES
    );

    let error = runtime
        .accept_import_items(
            account_id.clone(),
            TEST_VAULT_ID.into(),
            vec![large; 20],
            RequestCancellation::new(),
            || {},
        )
        .await
        .unwrap_err();
    assert_eq!(error.code, RuntimeErrorCode::SizeRejected);
    assert!(
        runtime
            .replica()
            .snapshot(&account_id)
            .unwrap()
            .operations
            .is_empty(),
        "a batch past the byte bound never became durable work"
    );

    // The same Account still accepts an ordinary batch, so the bound refuses one request rather
    // than failing the Account.
    let (_, item_ids) = accept(&runtime, &account_id, vec![draft(true)]).await;
    assert_eq!(item_ids.len(), 1);
}

#[test]
fn import_item_ciphertext_bound_matches_the_generated_server_input_contract() {
    let contract: serde_json::Value =
        serde_json::from_str(include_str!("../../../../../api-contract/openapi.v1.json")).unwrap();
    let published = contract["components"]["schemas"]["BulkImportItemInput"]["properties"]
        ["encryptedData"]["maxLength"]
        .as_u64()
        .expect("the Server publishes its Import Item ciphertext bound");
    assert_eq!(
        super::import::SERVER_ITEM_CIPHERTEXT_BYTES as u64,
        published
    );
}

/// A persisted batch past the byte bound is refused where the executor reads it, too.
///
/// Acceptance is the gate that matters, but a record that reached durable storage another way —
/// an older build, a tampered store — must not be sent either, because the Server would answer a
/// status that carries no outcome and the Operation could never terminate.
#[tokio::test]
async fn a_persisted_batch_past_the_byte_bound_is_refused_where_the_executor_reads_it() {
    let (runtime, account_id) = ready_runtime().await;
    accept(&runtime, &account_id, vec![draft(true)]).await;
    let mut operation = runtime.replica().snapshot(&account_id).unwrap().operations[0].clone();
    assert!(super::import::decode_import_request(&operation).is_ok());

    let mut body: super::import::ImportRequestBody =
        serde_json::from_slice(&operation.request.body).unwrap();
    body.items[0]
        .encrypted_data
        .push_str(&"c".repeat(super::import::MAX_IMPORT_REQUEST_BYTES));
    operation.request.body = serde_json::to_vec(&body).unwrap();
    // The record stays internally consistent, so only the byte bound can refuse it.
    operation.request_fingerprint =
        super::import::import_items_fingerprint(operation.vault_id(), &operation.request.body);

    let error = super::import::decode_import_request(&operation)
        .err()
        .expect("an over-byte persisted batch is not readable");
    assert_eq!(error.code, RuntimeErrorCode::InvariantViolation);
}

#[tokio::test]
async fn operations_projection_tracks_retry_and_terminal_receipts_across_restart_without_plaintext()
{
    let clock = super::operation_fixtures::TestClock::new();
    let persistence = Arc::new(InMemoryReplica::default());
    let (runtime, account_id) = ready_runtime_on(&persistence, clock.clone()).await;
    let (operation_id, _) = accept(&runtime, &account_id, vec![draft(true)]).await;
    let request = ObservationRequest::Operations {
        account_id: account_id.clone(),
    };
    let projected = || {
        let RuntimeProjection::Operations(value) = runtime.projection(&request).unwrap().projection
        else {
            panic!("Operations projection")
        };
        value
    };
    let pending = projected();
    assert_eq!(pending.operations.len(), 1);
    assert_eq!(pending.operations[0].operation_id, operation_id);
    assert_eq!(
        pending.operations[0].kind,
        crate::OperationProjectionKind::ImportItems
    );
    assert_eq!(
        pending.operations[0].resolution,
        crate::OperationResolution::Pending
    );
    assert_eq!(pending.operations[0].attempt_count.as_deref(), Some("0"));
    assert_eq!(pending.operations[0].imported_count, None);
    let serialized = serde_json::to_value(&pending).unwrap();
    assert!(serialized["operations"][0].get("request").is_none());
    assert!(serialized["operations"][0].get("items").is_none());
    let fault = LookupFaultPort {
        fault: super::import_executor::ImportExecutorError::Retryable,
        renewals: AtomicUsize::new(0),
    };
    runtime
        .drive_import_executor_cycle(&account_id, &operation_id, &fault)
        .await
        .unwrap();
    let retry = projected();
    assert_eq!(retry.operations[0].attempt_count.as_deref(), Some("1"));
    assert!(retry.replica_revision > pending.replica_revision);
    let port = ScriptedPort::new(&persistence, &account_id)
        .script_lookups(vec![Ok(None)])
        .script_posts(vec![Ok(applied_response(&operation_id, 1))]);
    runtime
        .drive_import_executor_cycle(&account_id, &operation_id, &port)
        .await
        .unwrap();
    let applied = projected();
    assert_eq!(applied.operations.len(), 1);
    assert_eq!(
        applied.operations[0].resolution,
        crate::OperationResolution::Applied
    );
    assert_eq!(applied.operations[0].imported_count, Some(1));
    assert_eq!(applied.operations[0].attempt_count, None);
    assert_eq!(applied.operations[0].next_attempt_at_ms, None);
    let reopened = runtime_over(&persistence, clock);
    reopened.replica().load(&account_id).await.unwrap().unwrap();
    let RuntimeProjection::Operations(restored) = reopened.projection(&request).unwrap().projection
    else {
        panic!("Operations projection")
    };
    assert_eq!(restored, applied);
}

#[tokio::test]
async fn an_import_item_over_the_server_ciphertext_limit_refuses_before_acceptance_and_preserves_siblings(
) {
    for oversized_first in [false, true] {
        let (runtime, account_id) = ready_runtime().await;
        let before = runtime.replica().snapshot(&account_id).unwrap();
        let mut oversized = draft(false);
        let ItemDraft::Login(data) = &mut oversized.draft else {
            unreachable!()
        };
        data.notes = Some("n".repeat(1024 * 1024));
        let small = draft(true);
        let batch = if oversized_first {
            vec![oversized.clone(), small.clone()]
        } else {
            vec![small.clone(), oversized.clone()]
        };
        let accepted_callbacks = AtomicUsize::new(0);
        let result = runtime
            .accept_import_items(
                account_id.clone(),
                TEST_VAULT_ID.into(),
                batch,
                RequestCancellation::new(),
                || {
                    accepted_callbacks.fetch_add(1, Ordering::SeqCst);
                },
            )
            .await;
        if result.is_ok() {
            // Preserve the exact real-encryption reproduction in the regression: this is
            // under the aggregate bound, but the Server would reject the whole Operation.
            let snapshot = runtime.replica().snapshot(&account_id).unwrap();
            let operation = snapshot.operations.first().unwrap();
            let body = super::import::decode_import_request(operation).unwrap();
            let largest = body
                .items
                .iter()
                .map(|item| item.encrypted_data.len())
                .max()
                .unwrap();
            assert!(operation.request.body.len() < super::import::MAX_IMPORT_REQUEST_BYTES);
            assert!(largest > 1024 * 1024);
            panic!(
                "accepted an Import Item with {largest} ciphertext bytes beside a valid sibling"
            );
        }
        assert_eq!(result.unwrap_err().code, RuntimeErrorCode::SizeRejected);
        assert_eq!(accepted_callbacks.load(Ordering::SeqCst), 0);
        assert_eq!(runtime.replica().snapshot(&account_id).unwrap(), before);

        // The host can split the refusal without losing the ordinary sibling. Neither
        // refusal creates an Operation or consumes an acceptance callback.
        assert_eq!(
            runtime
                .accept_import_items(
                    account_id.clone(),
                    TEST_VAULT_ID.into(),
                    vec![oversized],
                    RequestCancellation::new(),
                    || {},
                )
                .await
                .unwrap_err()
                .code,
            RuntimeErrorCode::SizeRejected
        );
        let (_, ids) = accept(&runtime, &account_id, vec![small]).await;
        assert_eq!(ids.len(), 1);
        assert_eq!(
            runtime
                .replica()
                .snapshot(&account_id)
                .unwrap()
                .operations
                .len(),
            1
        );
    }
}

#[tokio::test]
async fn retained_import_receipts_original_count_when_current_batch_is_partial() {
    let persistence = Arc::new(InMemoryReplica::default());
    let (runtime, account_id) =
        ready_runtime_on(&persistence, super::operation_fixtures::TestClock::new()).await;
    let (operation_id, _) = accept(&runtime, &account_id, vec![draft(true), draft(false)]).await;
    let accepted = accepted_items(&runtime, &account_id);
    let mut current = authority_dto(&accepted[0]);
    current.version = 3;
    current.favorite = false;
    let vaults = persistence
        .snapshot(&account_id)
        .unwrap()
        .bootstrap
        .snapshot()
        .visible_vaults;
    persistence
        .seed_ready_authority(
            &account_id,
            vaults,
            vec![super::bootstrap::authority_item_from_dto(current).unwrap()],
        )
        .unwrap();
    runtime.replica.load(&account_id).await.unwrap();
    let before = persistence.snapshot(&account_id).unwrap().bootstrap.items;
    let port = AppliedPort {
        outcome: applied_response(&operation_id, 2),
    };
    assert_eq!(
        runtime
            .drive_import_executor_cycle(&account_id, &operation_id, &port)
            .await
            .unwrap(),
        super::import_executor::ImportExecutorPass::Completed
    );
    let completed = runtime.replica.snapshot(&account_id).unwrap();
    assert!(completed.operations.is_empty());
    assert_eq!(completed.receipts.len(), 1);
    assert_eq!(
        completed.receipts[0].result,
        crate::replica::OperationOutcomeResult::ImportApplied {
            vault_id: TEST_VAULT_ID.into(),
            imported_count: 2,
        }
    );
    assert_eq!(
        completed.bootstrap.items, before,
        "receipt neither resurrects missing Items nor rolls back later edits"
    );
    assert_eq!(
        completed.bootstrap.state,
        crate::replica::ReplicaState::RefreshRequired
    );
}

#[tokio::test]
async fn stale_import_identity_failure_does_not_fail_newer_replica_work() {
    for changed_count in [false, true] {
        let persistence = Arc::new(InMemoryReplica::default());
        let (runtime, account_id) =
            ready_runtime_on(&persistence, super::operation_fixtures::TestClock::new()).await;
        let (operation_id, _) = accept(&runtime, &account_id, vec![draft(true)]).await;
        let port = ScriptedPort::new(&persistence, &account_id)
            .script_lookups(vec![Ok(None)])
            .script_posts(vec![Ok(if changed_count {
                applied_response(&operation_id, 2)
            } else {
                reused_identity_response()
            })])
            .interfering(Interference::ReplayRevision);
        assert_eq!(
            runtime
                .drive_import_executor_cycle(&account_id, &operation_id, &port)
                .await
                .unwrap(),
            super::import_executor::ImportExecutorPass::ParkedFenced
        );
        let retained = persistence.snapshot(&account_id).unwrap();
        assert!(retained.failure.is_none());
        assert_eq!(retained.operations.len(), 1);
        assert!(retained.receipts.is_empty());
    }
}

#[tokio::test]
async fn retained_import_of_all_categories_preserves_changed_visible_data_without_live_keys() {
    use crate::server_contract::ItemCategory;
    let persistence = Arc::new(InMemoryReplica::default());
    let (runtime, account_id) =
        ready_runtime_on(&persistence, super::operation_fixtures::TestClock::new()).await;
    let categories = [
        ItemCategory::Login,
        ItemCategory::SecureNote,
        ItemCategory::CreditCard,
        ItemCategory::Identity,
        ItemCategory::Totp,
    ];
    let (operation_id, _) = accept(
        &runtime,
        &account_id,
        categories.iter().map(draft_for_category).collect(),
    )
    .await;
    let accepted = accepted_items(&runtime, &account_id);
    let mut vaults = persistence
        .snapshot(&account_id)
        .unwrap()
        .bootstrap
        .snapshot()
        .visible_vaults;
    let mut moved_vault = vaults[0].clone();
    moved_vault.id = "11111111-1111-4111-8111-111111111111".into();
    let mut edited = authority_dto(&accepted[0]);
    edited.version = 4;
    edited.favorite = true;
    let mut moved = authority_dto(&accepted[1]);
    moved.version = 2;
    moved.vault_id = moved_vault.id.clone();
    vaults.push(moved_vault);
    persistence
        .seed_ready_authority(
            &account_id,
            vaults,
            vec![edited, moved]
                .into_iter()
                .map(|item| super::bootstrap::authority_item_from_dto(item).unwrap())
                .collect(),
        )
        .unwrap();
    runtime.replica.load(&account_id).await.unwrap();
    let before = persistence.snapshot(&account_id).unwrap().bootstrap;
    runtime.clear_live_master_unlock_keys_for_account(&account_id);
    let port = AppliedPort {
        outcome: applied_response(&operation_id, 5),
    };
    assert_eq!(
        runtime
            .drive_import_executor_cycle(&account_id, &operation_id, &port)
            .await
            .unwrap(),
        super::import_executor::ImportExecutorPass::Completed
    );
    let after = persistence.snapshot(&account_id).unwrap();
    assert_eq!(after.bootstrap.items, before.items);
    assert_eq!(after.bootstrap.vaults, before.vaults);
    assert_eq!(
        after.receipts[0].result,
        crate::replica::OperationOutcomeResult::ImportApplied {
            vault_id: TEST_VAULT_ID.into(),
            imported_count: 5
        }
    );
    assert!(after.operations.is_empty());
    assert!(after.failure.is_none());
}

#[tokio::test]
async fn failed_import_receipt_commit_retains_exact_work_until_fresh_replay() {
    let persistence = Arc::new(InMemoryReplica::default());
    let (runtime, account_id) =
        ready_runtime_on(&persistence, super::operation_fixtures::TestClock::new()).await;
    let (operation_id, _) = accept(&runtime, &account_id, vec![draft(true)]).await;
    let before = persistence.snapshot(&account_id).unwrap();
    let runtime = runtime_with_one_failed_commit(&persistence);
    runtime.replica.load(&account_id).await.unwrap();
    let port = AppliedPort {
        outcome: applied_response(&operation_id, 1),
    };
    assert_eq!(
        runtime
            .drive_import_executor_cycle(&account_id, &operation_id, &port)
            .await
            .unwrap(),
        super::import_executor::ImportExecutorPass::RetryScheduled
    );
    let waiting = persistence.snapshot(&account_id).unwrap();
    assert_eq!(waiting.operations[0].request, before.operations[0].request);
    assert_eq!(
        waiting.operations[0].request_fingerprint,
        before.operations[0].request_fingerprint
    );
    assert_eq!(waiting.operations[0].scheduling.attempt_count, 1);
    assert!(
        waiting.operations[0].scheduling.not_before_ms
            > before.operations[0].scheduling.not_before_ms
    );
    assert_eq!(waiting.receipts, before.receipts);
    assert_eq!(waiting.bootstrap, before.bootstrap);
    assert_eq!(
        runtime
            .drive_import_executor_cycle(&account_id, &operation_id, &port)
            .await
            .unwrap(),
        super::import_executor::ImportExecutorPass::Completed
    );
    let after = persistence.snapshot(&account_id).unwrap();
    assert!(after.operations.is_empty());
    assert_eq!(after.receipts.len(), 1);
}

fn runtime_with_one_failed_commit(persistence: &Arc<InMemoryReplica>) -> Arc<Runtime> {
    Runtime::with_persistence(
        Arc::new(FailOneCommit {
            inner: persistence.clone(),
            armed: AtomicBool::new(true),
        }),
        Arc::new(PlatformStorage::unavailable()),
        Arc::new(HttpTransport::unavailable()),
        None,
        None,
        true,
        super::operation_fixtures::TestClock::new(),
        Arc::new(SystemDeviceTimer),
        Some(persistence.clone()),
    )
}

#[tokio::test]
async fn failed_import_account_failure_write_retries_without_losing_the_contradiction() {
    let persistence = Arc::new(InMemoryReplica::default());
    let (runtime, account_id) =
        ready_runtime_on(&persistence, super::operation_fixtures::TestClock::new()).await;
    let (operation_id, _) = accept(&runtime, &account_id, vec![draft(true)]).await;
    let before = persistence.snapshot(&account_id).unwrap();
    let runtime = runtime_with_one_failed_commit(&persistence);
    runtime.replica.load(&account_id).await.unwrap();
    let port = AppliedPort {
        outcome: reused_identity_response(),
    };
    assert_eq!(
        runtime
            .drive_import_executor_cycle(&account_id, &operation_id, &port)
            .await
            .unwrap(),
        super::import_executor::ImportExecutorPass::RetryScheduled
    );
    let waiting = persistence.snapshot(&account_id).unwrap();
    assert!(waiting.failure.is_none());
    assert_eq!(waiting.operations[0].request, before.operations[0].request);
    assert_eq!(waiting.operations[0].scheduling.attempt_count, 1);
    assert!(
        waiting.operations[0].scheduling.not_before_ms
            > before.operations[0].scheduling.not_before_ms
    );
    assert!(waiting.receipts.is_empty());
    assert_eq!(
        runtime
            .drive_import_executor_cycle(&account_id, &operation_id, &port)
            .await
            .unwrap_err()
            .code,
        RuntimeErrorCode::AccountFailed
    );
    let failed = persistence.snapshot(&account_id).unwrap();
    assert!(failed.failure.is_some());
    assert_eq!(failed.operations[0].request, before.operations[0].request);
    assert!(failed.receipts.is_empty());
}

struct RetainedImportHttp {
    operation: crate::replica::OperationRecord,
    outcome: ImportExchangeResponse,
    calls: AtomicUsize,
}

#[async_trait]
impl crate::http_transport::SerializedHttpExecutor for RetainedImportHttp {
    async fn invoke(
        &self,
        request_json: zeroize::Zeroizing<String>,
    ) -> Result<String, RuntimeError> {
        let request: serde_json::Value = serde_json::from_str(&request_json).unwrap();
        let call = self.calls.fetch_add(1, Ordering::SeqCst);
        match call {
            0 => {
                assert_eq!(request["method"], "GET");
                assert!(request["url"]
                    .as_str()
                    .unwrap()
                    .ends_with(&format!("/operations/{}", self.operation.operation_id)));
            }
            1 => {
                assert_eq!(request["method"], "POST");
                assert!(request["url"]
                    .as_str()
                    .unwrap()
                    .ends_with(&self.operation.request.path));
                assert_eq!(
                    serde_json::from_value::<Vec<u8>>(request["body"].clone()).unwrap(),
                    self.operation.request.body
                );
            }
            _ => panic!("retained Import must not read historical Item/Vault authority"),
        }
        Ok(
            super::operation_fixtures::completed(self.outcome.status, self.outcome.body.clone())
                .to_string(),
        )
    }
    fn cancel(&self, _dispatch_id: &str) {}
}

#[tokio::test]
async fn sync_import_retained_replay_preserves_current_authority_and_rejects_changed_count() {
    for contradictory_count in [false, true] {
        let harness = super::operation_fixtures::seeded_with_existing_item(false, false).await;
        let (operation_id, _) = accept(
            &harness.runtime,
            &harness.account_id,
            vec![draft(true), draft(false)],
        )
        .await;
        let captured = harness
            .runtime
            .replica
            .snapshot(&harness.account_id)
            .unwrap();
        let operation = captured.operations[0].clone();
        let executor = Arc::new(RetainedImportHttp {
            operation,
            outcome: applied_response(&operation_id, if contradictory_count { 1 } else { 2 }),
            calls: AtomicUsize::new(0),
        });
        let transport = HttpTransport::new(executor.clone());
        let http = AuthHttpClient::new(
            &transport,
            super::operation_fixtures::SERVER_URL,
            false,
            super::operation_fixtures::auth_config(),
        )
        .unwrap();
        let mut session = harness
            .runtime
            .platform_storage
            .load_current_session(&harness.account_id, &captured.incarnation)
            .await
            .unwrap()
            .unwrap();
        let result = harness
            .runtime
            .reconcile_resolved_operation(&harness.account_id, &operation_id, &http, &mut session)
            .await;
        let after = harness
            .runtime
            .replica
            .snapshot(&harness.account_id)
            .unwrap();
        assert_eq!(
            executor.calls.load(Ordering::SeqCst),
            2,
            "lookup remains a hint until exact bytes replay"
        );
        assert_eq!(after.bootstrap.items, captured.bootstrap.items);
        assert_eq!(after.bootstrap.vaults, captured.bootstrap.vaults);
        if contradictory_count {
            assert!(matches!(result, super::outcome::CompletionResult::Failed));
            assert!(after.failure.is_some());
            assert_eq!(after.operations, captured.operations);
            assert!(after.receipts.is_empty());
        } else {
            assert!(matches!(
                result,
                super::outcome::CompletionResult::Completed
            ));
            assert!(after.operations.is_empty());
            assert_eq!(
                after.receipts[0].result,
                crate::replica::OperationOutcomeResult::ImportApplied {
                    vault_id: TEST_VAULT_ID.into(),
                    imported_count: 2
                }
            );
            assert_eq!(
                after.bootstrap.state,
                crate::replica::ReplicaState::RefreshRequired
            );
        }
    }
}
