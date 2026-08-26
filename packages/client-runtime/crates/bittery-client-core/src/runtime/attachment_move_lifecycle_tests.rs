use super::{
    attachment_move_lifecycle::{
        live_artifact_owners, AttachmentMoveAccountLease, AttachmentMoveAccountLeasePort,
        AttachmentMoveLifecycle, LifecyclePass,
    },
    attachment_move_preparation::{PreparationDriveRequest, PreparationDriveResult},
    attachment_move_scheduler::{
        AttachmentMovePreparationDriver, AttachmentMovePreparationScheduler,
    },
    Runtime,
};
use crate::{
    attachment_artifact_store::{
        AttachmentArtifactStore, AttachmentArtifactStoreRequest, AttachmentArtifactStoreResponse,
    },
    replica::{
        attachment_move_artifact_ref, attachment_move_intent_fingerprint,
        AttachmentMovePreparationRecord, AttachmentMoveProgress, AttachmentMoveRecovery,
        AttachmentMoveUploadState, AuthorityAttachmentRecord, AuthorityItemCategory,
        AuthorityItemRecord, BootstrapAuthority, GuardedCommitPlan, InMemoryReplica,
        OperationSchedulingState, PlanMutation, PreparedMoveAttachment, ReplicaSnapshot,
        Sha256Fingerprint,
    },
    AccountId, RuntimeError, RuntimeErrorCode,
};
use async_trait::async_trait;
use std::sync::{
    atomic::{AtomicBool, AtomicUsize, Ordering},
    Arc, Mutex,
};

struct LeaseGuard {
    live: Arc<AtomicBool>,
    lost: Arc<tokio::sync::Notify>,
    held: Arc<AtomicBool>,
    releases: Arc<AtomicUsize>,
}

#[async_trait]
impl AttachmentMoveAccountLease for LeaseGuard {
    fn is_live(&self) -> bool {
        self.live.load(Ordering::SeqCst)
    }

    async fn lost(&self) {
        loop {
            let notified = self.lost.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            if !self.is_live() {
                return;
            }
            notified.await;
        }
    }
}

impl Drop for LeaseGuard {
    fn drop(&mut self) {
        self.held.store(false, Ordering::SeqCst);
        self.releases.fetch_add(1, Ordering::SeqCst);
    }
}

#[derive(Default)]
struct ExclusiveLeasePort {
    held: Arc<AtomicBool>,
    live: Arc<AtomicBool>,
    lost: Arc<tokio::sync::Notify>,
    releases: Arc<AtomicUsize>,
    accounts: Mutex<Vec<AccountId>>,
    deny: AtomicUsize,
}

#[async_trait]
impl AttachmentMoveAccountLeasePort for ExclusiveLeasePort {
    async fn acquire(
        &self,
        account_id: &AccountId,
    ) -> Result<Option<Box<dyn AttachmentMoveAccountLease>>, RuntimeError> {
        self.accounts.lock().unwrap().push(account_id.clone());
        if self.deny.load(Ordering::SeqCst) > 0 {
            self.deny.fetch_sub(1, Ordering::SeqCst);
            return Ok(None);
        }
        if self
            .held
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .is_err()
        {
            return Ok(None);
        }
        self.live.store(true, Ordering::SeqCst);
        Ok(Some(Box::new(LeaseGuard {
            live: Arc::clone(&self.live),
            lost: Arc::clone(&self.lost),
            held: Arc::clone(&self.held),
            releases: Arc::clone(&self.releases),
        })))
    }
}

struct RecordingStore {
    events: Arc<Mutex<Vec<&'static str>>>,
    requests: Mutex<Vec<(AccountId, Vec<crate::AttachmentArtifactOwner>)>>,
    failures: AtomicUsize,
    lose_lease: Option<(Arc<AtomicBool>, Arc<tokio::sync::Notify>)>,
}

#[async_trait]
impl AttachmentArtifactStore for RecordingStore {
    async fn invoke(
        &self,
        request: AttachmentArtifactStoreRequest,
    ) -> Result<AttachmentArtifactStoreResponse, RuntimeError> {
        let AttachmentArtifactStoreRequest::SweepOrphans {
            account_id, live, ..
        } = request
        else {
            panic!("lifecycle test received a non-sweep request")
        };
        self.events.lock().unwrap().push("sweep");
        self.requests.lock().unwrap().push((account_id, live));
        if let Some((live, lost)) = &self.lose_lease {
            live.store(false, Ordering::SeqCst);
            lost.notify_waiters();
        }
        if self.failures.load(Ordering::SeqCst) > 0 {
            self.failures.fetch_sub(1, Ordering::SeqCst);
            return Err(RuntimeError::new(
                RuntimeErrorCode::InvariantViolation,
                "injected sweep failure",
            ));
        }
        Ok(AttachmentArtifactStoreResponse::OrphansSwept { deleted: 1 })
    }
}

struct RecordingDriver {
    events: Arc<Mutex<Vec<&'static str>>>,
    calls: AtomicUsize,
}

struct BlockingDriver {
    entered: Arc<tokio::sync::Notify>,
    release: Arc<tokio::sync::Notify>,
    completed_write: Arc<AtomicBool>,
    cancelled: Arc<AtomicBool>,
}

struct AccountRecordingDriver {
    accounts: Mutex<Vec<AccountId>>,
    entered: Arc<tokio::sync::Notify>,
}

#[async_trait]
impl AttachmentMovePreparationDriver for AccountRecordingDriver {
    async fn drive(
        &self,
        request: PreparationDriveRequest,
    ) -> Result<PreparationDriveResult, RuntimeError> {
        let account_id = match request {
            PreparationDriveRequest::Advance { account_id, .. }
            | PreparationDriveRequest::ReactivateStagingIncomplete { account_id, .. } => account_id,
        };
        self.accounts.lock().unwrap().push(account_id);
        self.entered.notify_one();
        Ok(PreparationDriveResult::Progressed)
    }
}

struct HoldingTimer {
    delays: Mutex<Vec<u64>>,
    entered: Arc<tokio::sync::Notify>,
}

#[async_trait]
impl crate::device_timer::DeviceTimer for HoldingTimer {
    async fn sleep_ms(&self, milliseconds: u64) {
        self.delays.lock().unwrap().push(milliseconds);
        self.entered.notify_one();
        std::future::pending().await
    }
}

struct CancellationWitness {
    completed: Arc<AtomicBool>,
    cancelled: Arc<AtomicBool>,
}

impl Drop for CancellationWitness {
    fn drop(&mut self) {
        if !self.completed.load(Ordering::SeqCst) {
            self.cancelled.store(true, Ordering::SeqCst);
        }
    }
}

#[async_trait]
impl AttachmentMovePreparationDriver for BlockingDriver {
    async fn drive(
        &self,
        _request: PreparationDriveRequest,
    ) -> Result<PreparationDriveResult, RuntimeError> {
        let witness = CancellationWitness {
            completed: Arc::clone(&self.completed_write),
            cancelled: Arc::clone(&self.cancelled),
        };
        self.entered.notify_one();
        self.release.notified().await;
        self.completed_write.store(true, Ordering::SeqCst);
        drop(witness);
        Ok(PreparationDriveResult::Progressed)
    }
}

#[async_trait]
impl AttachmentMovePreparationDriver for RecordingDriver {
    async fn drive(
        &self,
        _request: PreparationDriveRequest,
    ) -> Result<PreparationDriveResult, RuntimeError> {
        self.events.lock().unwrap().push("drive");
        self.calls.fetch_add(1, Ordering::SeqCst);
        Ok(PreparationDriveResult::Progressed)
    }
}

async fn runtime_with_account(account: &str) -> (Arc<Runtime>, ReplicaSnapshot) {
    let persistence = Arc::new(InMemoryReplica::default());
    let account_id = AccountId::from(account);
    persistence
        .install(
            account_id.clone(),
            format!("user-{account}"),
            crate::protocol::Incarnation::from(format!("inc-{account}")),
        )
        .unwrap();
    let runtime = Runtime::with_test_preparation_environment(
        persistence,
        Arc::new(RecordingDriver {
            events: Arc::new(Mutex::new(Vec::new())),
            calls: AtomicUsize::new(0),
        }),
        Arc::new(crate::authentication_installation::FixedClock(0)),
        Arc::new(crate::device_timer::SystemDeviceTimer),
    );
    runtime.replica().load(&account_id).await.unwrap();
    runtime.seed_unlocked_preparation_account(&account_id);
    let snapshot = runtime.replica().snapshot(&account_id).unwrap();
    (runtime, snapshot)
}

async fn runtime_with_accepted_preparation(account: &str) -> (Arc<Runtime>, ReplicaSnapshot) {
    let persistence = Arc::new(InMemoryReplica::default());
    let account_id = AccountId::from(account);
    let user_id = format!("user-{account}");
    persistence
        .install(
            account_id.clone(),
            user_id.clone(),
            crate::protocol::Incarnation::from(format!("inc-{account}")),
        )
        .unwrap();
    let source = AuthorityAttachmentRecord {
        id: "attachment-accepted".into(),
        item_id: "item-accepted".into(),
        vault_id: "source".into(),
        storage_key: "opaque-object".into(),
        encrypted_name: "sealed-name".into(),
        encryption_iv: "name-iv".into(),
        encryption_algorithm: "AES-GCM-AAD-V1".into(),
        encrypted_attachment_key: "sealed-key".into(),
        attachment_key_iv: "key-iv".into(),
        attachment_key_algorithm: "AES-GCM-AAD-V1".into(),
        encrypted_content_type: "sealed-type".into(),
        encrypted_content_type_iv: "type-iv".into(),
        envelope_version: 1,
        file_size: 1,
        uploaded_by: user_id.clone(),
        created_at: "2026-08-26T00:00:00Z".into(),
    };
    persistence
        .seed_ready_authority(
            &account_id,
            vec![
                crate::test_fixtures::personal_vault("source", &user_id),
                crate::test_fixtures::personal_vault("target", &user_id),
            ],
            vec![AuthorityItemRecord {
                id: "item-accepted".into(),
                vault_id: "source".into(),
                category: AuthorityItemCategory::Login,
                favorite: false,
                encrypted_data: "sealed-item".into(),
                encryption_iv: "item-iv".into(),
                encryption_algorithm: "AES-GCM-AAD-V1".into(),
                version: 1,
                encryption_version: 1,
                encrypted_by_user_id: user_id.clone(),
                last_modified_by: user_id.clone(),
                created_at: "2026-08-26T00:00:00Z".into(),
                updated_at: "2026-08-26T00:00:00Z".into(),
                deleted_at: None,
                attachments: vec![source.clone()],
            }],
        )
        .unwrap();
    let mut preparation = AttachmentMovePreparationRecord {
        account_id: account_id.clone(),
        operation_id: "accepted-op".into(),
        item_id: "item-accepted".into(),
        source_vault_id: "source".into(),
        target_vault_id: "target".into(),
        expected_item_version: 1,
        target_encrypted_data: "sealed-target".into(),
        target_encryption_algorithm: "AES-GCM-AAD-V1".into(),
        target_encryption_iv: "target-iv".into(),
        source_attachments: vec![source],
        progress: vec![AttachmentMoveProgress::Pending {
            attachment_id: "attachment-accepted".into(),
            expected_envelope_version: 1,
        }],
        intent_fingerprint: Sha256Fingerprint([0; 32]),
        scheduling: OperationSchedulingState::default(),
    };
    preparation.intent_fingerprint = attachment_move_intent_fingerprint(&preparation).unwrap();
    let current = persistence.snapshot(&account_id).unwrap();
    persistence
        .execute(GuardedCommitPlan::new(
            account_id.clone(),
            current.incarnation,
            current.revision,
            current.lock_epoch,
            vec![PlanMutation::AcceptAttachmentMovePreparation(preparation)],
        ))
        .unwrap();
    let runtime = Runtime::with_test_preparation_environment(
        persistence,
        Arc::new(RecordingDriver {
            events: Arc::new(Mutex::new(Vec::new())),
            calls: AtomicUsize::new(0),
        }),
        Arc::new(crate::authentication_installation::FixedClock(0)),
        Arc::new(crate::device_timer::SystemDeviceTimer),
    );
    runtime.replica().load(&account_id).await.unwrap();
    runtime.seed_unlocked_preparation_account(&account_id);
    let snapshot = runtime.replica().snapshot(&account_id).unwrap();
    (runtime, snapshot)
}

async fn add_accepted_preparation_account(
    runtime: &Arc<Runtime>,
    account: &str,
) -> ReplicaSnapshot {
    let persistence = runtime
        .test_persistence
        .as_ref()
        .expect("lifecycle fixture uses in-memory persistence")
        .clone();
    let account_id = AccountId::from(account);
    let user_id = format!("user-{account}");
    persistence
        .install(
            account_id.clone(),
            user_id.clone(),
            crate::protocol::Incarnation::from(format!("inc-{account}")),
        )
        .unwrap();
    let source = AuthorityAttachmentRecord {
        id: "attachment-accepted".into(),
        item_id: "item-accepted".into(),
        vault_id: "source".into(),
        storage_key: "opaque-object".into(),
        encrypted_name: "sealed-name".into(),
        encryption_iv: "name-iv".into(),
        encryption_algorithm: "AES-GCM-AAD-V1".into(),
        encrypted_attachment_key: "sealed-key".into(),
        attachment_key_iv: "key-iv".into(),
        attachment_key_algorithm: "AES-GCM-AAD-V1".into(),
        encrypted_content_type: "sealed-type".into(),
        encrypted_content_type_iv: "type-iv".into(),
        envelope_version: 1,
        file_size: 1,
        uploaded_by: user_id.clone(),
        created_at: "2026-08-26T00:00:00Z".into(),
    };
    persistence
        .seed_ready_authority(
            &account_id,
            vec![
                crate::test_fixtures::personal_vault("source", &user_id),
                crate::test_fixtures::personal_vault("target", &user_id),
            ],
            vec![AuthorityItemRecord {
                id: "item-accepted".into(),
                vault_id: "source".into(),
                category: AuthorityItemCategory::Login,
                favorite: false,
                encrypted_data: "sealed-item".into(),
                encryption_iv: "item-iv".into(),
                encryption_algorithm: "AES-GCM-AAD-V1".into(),
                version: 1,
                encryption_version: 1,
                encrypted_by_user_id: user_id.clone(),
                last_modified_by: user_id.clone(),
                created_at: "2026-08-26T00:00:00Z".into(),
                updated_at: "2026-08-26T00:00:00Z".into(),
                deleted_at: None,
                attachments: vec![source.clone()],
            }],
        )
        .unwrap();
    let mut preparation = AttachmentMovePreparationRecord {
        account_id: account_id.clone(),
        operation_id: "accepted-op".into(),
        item_id: "item-accepted".into(),
        source_vault_id: "source".into(),
        target_vault_id: "target".into(),
        expected_item_version: 1,
        target_encrypted_data: "sealed-target".into(),
        target_encryption_algorithm: "AES-GCM-AAD-V1".into(),
        target_encryption_iv: "target-iv".into(),
        source_attachments: vec![source],
        progress: vec![AttachmentMoveProgress::Pending {
            attachment_id: "attachment-accepted".into(),
            expected_envelope_version: 1,
        }],
        intent_fingerprint: Sha256Fingerprint([0; 32]),
        scheduling: OperationSchedulingState::default(),
    };
    preparation.intent_fingerprint = attachment_move_intent_fingerprint(&preparation).unwrap();
    let current = persistence.snapshot(&account_id).unwrap();
    persistence
        .execute(GuardedCommitPlan::new(
            account_id.clone(),
            current.incarnation,
            current.revision,
            current.lock_epoch,
            vec![PlanMutation::AcceptAttachmentMovePreparation(preparation)],
        ))
        .unwrap();
    runtime.replica().load(&account_id).await.unwrap();
    runtime.seed_unlocked_preparation_account(&account_id);
    runtime.replica().snapshot(&account_id).unwrap()
}

fn lifecycle_fixture(
    lease: Arc<ExclusiveLeasePort>,
    store: Arc<RecordingStore>,
    events: Arc<Mutex<Vec<&'static str>>>,
) -> (
    AttachmentMoveLifecycle,
    AttachmentMovePreparationScheduler,
    Arc<RecordingDriver>,
) {
    let driver = Arc::new(RecordingDriver {
        events,
        calls: AtomicUsize::new(0),
    });
    (
        AttachmentMoveLifecycle::new(lease, store),
        AttachmentMovePreparationScheduler::new_for_test(driver.clone()),
        driver,
    )
}

#[tokio::test]
async fn exclusive_account_lifecycle_sweeps_before_it_drives_preparation_and_releases_guard() {
    let events = Arc::new(Mutex::new(Vec::new()));
    let lease = Arc::new(ExclusiveLeasePort::default());
    let store = Arc::new(RecordingStore {
        events: Arc::clone(&events),
        requests: Mutex::new(Vec::new()),
        failures: AtomicUsize::new(0),
        lose_lease: None,
    });
    let (lifecycle, scheduler, _) = lifecycle_fixture(lease.clone(), store, Arc::clone(&events));
    let (runtime, snapshot) = runtime_with_account("account-a").await;

    let pass = lifecycle
        .run_account(&runtime, &scheduler, &snapshot, Some("op-a".into()), 0)
        .await
        .unwrap();

    assert!(matches!(pass, LifecyclePass::Driven(_)));
    assert_eq!(*events.lock().unwrap(), vec!["sweep", "drive"]);
    assert_eq!(lease.releases.load(Ordering::SeqCst), 1);
    assert!(!lease.held.load(Ordering::SeqCst));
}

#[tokio::test]
async fn denied_or_lost_lease_never_reaches_the_preparation_driver() {
    let events = Arc::new(Mutex::new(Vec::new()));
    let lease = Arc::new(ExclusiveLeasePort::default());
    lease.deny.store(1, Ordering::SeqCst);
    let store = Arc::new(RecordingStore {
        events: Arc::clone(&events),
        requests: Mutex::new(Vec::new()),
        failures: AtomicUsize::new(0),
        lose_lease: Some((Arc::clone(&lease.live), Arc::clone(&lease.lost))),
    });
    let (lifecycle, scheduler, driver) = lifecycle_fixture(lease, store, events);
    let (runtime, snapshot) = runtime_with_account("account-a").await;

    assert_eq!(
        lifecycle
            .run_account(&runtime, &scheduler, &snapshot, Some("op-a".into()), 0)
            .await
            .unwrap(),
        LifecyclePass::LeaseUnavailable
    );
    assert_eq!(
        lifecycle
            .run_account(&runtime, &scheduler, &snapshot, Some("op-a".into()), 0)
            .await
            .unwrap(),
        LifecyclePass::GenerationRetired
    );
    assert_eq!(driver.calls.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn lease_loss_during_an_awaited_drive_cancels_every_subsequent_write_and_releases_guard() {
    let lease = Arc::new(ExclusiveLeasePort::default());
    let store = Arc::new(RecordingStore {
        events: Arc::new(Mutex::new(Vec::new())),
        requests: Mutex::new(Vec::new()),
        failures: AtomicUsize::new(0),
        lose_lease: None,
    });
    let lifecycle = Arc::new(AttachmentMoveLifecycle::new(lease.clone(), store));
    let entered = Arc::new(tokio::sync::Notify::new());
    let release = Arc::new(tokio::sync::Notify::new());
    let completed_write = Arc::new(AtomicBool::new(false));
    let cancelled = Arc::new(AtomicBool::new(false));
    let scheduler = Arc::new(AttachmentMovePreparationScheduler::new_for_test(Arc::new(
        BlockingDriver {
            entered: Arc::clone(&entered),
            release: Arc::clone(&release),
            completed_write: Arc::clone(&completed_write),
            cancelled: Arc::clone(&cancelled),
        },
    )));
    let (runtime, snapshot) = runtime_with_accepted_preparation("lost-mid-drive").await;
    let task = tokio::spawn({
        let lifecycle = lifecycle.clone();
        async move {
            lifecycle
                .run_account(
                    &runtime,
                    &scheduler,
                    &snapshot,
                    Some("accepted-op".into()),
                    0,
                )
                .await
        }
    });
    entered.notified().await;
    lease.live.store(false, Ordering::SeqCst);
    lease.lost.notify_waiters();

    assert_eq!(
        task.await.unwrap().unwrap(),
        LifecyclePass::GenerationRetired
    );
    release.notify_waiters();
    tokio::task::yield_now().await;
    assert!(!completed_write.load(Ordering::SeqCst));
    assert!(cancelled.load(Ordering::SeqCst));
    assert_eq!(lease.releases.load(Ordering::SeqCst), 1);
    assert!(!lease.held.load(Ordering::SeqCst));
}

#[tokio::test]
async fn close_and_lock_retire_the_selected_generation_before_sweep_or_drive() {
    for close in [false, true] {
        let events = Arc::new(Mutex::new(Vec::new()));
        let lease = Arc::new(ExclusiveLeasePort::default());
        let store = Arc::new(RecordingStore {
            events: Arc::clone(&events),
            requests: Mutex::new(Vec::new()),
            failures: AtomicUsize::new(0),
            lose_lease: None,
        });
        let (lifecycle, scheduler, driver) = lifecycle_fixture(lease, store, events);
        let (runtime, snapshot) =
            runtime_with_account(if close { "closed" } else { "locked" }).await;
        if close {
            runtime.close().await;
        } else {
            runtime
                .request(
                    crate::RuntimeRequest::Lock {
                        account_id: snapshot.account_id.clone(),
                    },
                    crate::RequestCancellation::new(),
                )
                .await
                .unwrap();
        }
        assert_eq!(
            lifecycle
                .run_account(&runtime, &scheduler, &snapshot, Some("op".into()), 0)
                .await
                .unwrap(),
            LifecyclePass::GenerationRetired
        );
        assert_eq!(driver.calls.load(Ordering::SeqCst), 0);
    }
}

#[tokio::test]
async fn six_sweep_failures_preserve_work_and_the_seventh_retry_drives() {
    let events = Arc::new(Mutex::new(Vec::new()));
    let lease = Arc::new(ExclusiveLeasePort::default());
    let store = Arc::new(RecordingStore {
        events: Arc::clone(&events),
        requests: Mutex::new(Vec::new()),
        failures: AtomicUsize::new(6),
        lose_lease: None,
    });
    let (lifecycle, scheduler, driver) = lifecycle_fixture(lease, store, events);
    let (runtime, snapshot) = runtime_with_accepted_preparation("retry").await;
    assert_eq!(snapshot.attachment_move_preparations.len(), 1);
    for _ in 0..6 {
        assert!(lifecycle
            .run_account(
                &runtime,
                &scheduler,
                &snapshot,
                Some("accepted-op".into()),
                0
            )
            .await
            .is_err());
        assert_eq!(driver.calls.load(Ordering::SeqCst), 0);
        assert_eq!(
            runtime.replica().snapshot(&snapshot.account_id),
            Some(snapshot.clone())
        );
    }
    assert!(matches!(
        lifecycle
            .run_account(
                &runtime,
                &scheduler,
                &snapshot,
                Some("accepted-op".into()),
                0
            )
            .await
            .unwrap(),
        LifecyclePass::Driven(_)
    ));
    assert_eq!(driver.calls.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn six_lease_denials_preserve_the_accepted_preparation_for_a_later_owner() {
    let events = Arc::new(Mutex::new(Vec::new()));
    let lease = Arc::new(ExclusiveLeasePort::default());
    lease.deny.store(6, Ordering::SeqCst);
    let store = Arc::new(RecordingStore {
        events: Arc::clone(&events),
        requests: Mutex::new(Vec::new()),
        failures: AtomicUsize::new(0),
        lose_lease: None,
    });
    let (lifecycle, scheduler, driver) = lifecycle_fixture(lease, store, events);
    let (runtime, snapshot) = runtime_with_accepted_preparation("lease-retry").await;
    for _ in 0..6 {
        assert_eq!(
            lifecycle
                .run_account(
                    &runtime,
                    &scheduler,
                    &snapshot,
                    Some("accepted-op".into()),
                    0,
                )
                .await
                .unwrap(),
            LifecyclePass::LeaseUnavailable
        );
        assert_eq!(
            runtime.replica().snapshot(&snapshot.account_id),
            Some(snapshot.clone())
        );
    }
    assert!(matches!(
        lifecycle
            .run_account(
                &runtime,
                &scheduler,
                &snapshot,
                Some("accepted-op".into()),
                0,
            )
            .await
            .unwrap(),
        LifecyclePass::Driven(_)
    ));
    assert_eq!(driver.calls.load(Ordering::SeqCst), 1);
}

struct HeldSweepStore {
    entered: Arc<tokio::sync::Notify>,
    release: Arc<tokio::sync::Notify>,
}

struct BlockingSweepStore {
    entered: Arc<tokio::sync::Notify>,
    release: Arc<tokio::sync::Notify>,
    completed_delete: Arc<AtomicBool>,
    cancelled: Arc<AtomicBool>,
}

#[async_trait]
impl AttachmentArtifactStore for BlockingSweepStore {
    async fn invoke(
        &self,
        request: AttachmentArtifactStoreRequest,
    ) -> Result<AttachmentArtifactStoreResponse, RuntimeError> {
        assert!(matches!(
            request,
            AttachmentArtifactStoreRequest::SweepOrphans { .. }
        ));
        let witness = CancellationWitness {
            completed: Arc::clone(&self.completed_delete),
            cancelled: Arc::clone(&self.cancelled),
        };
        self.entered.notify_one();
        self.release.notified().await;
        self.completed_delete.store(true, Ordering::SeqCst);
        drop(witness);
        Ok(AttachmentArtifactStoreResponse::OrphansSwept { deleted: 1 })
    }
}

struct OrphanTrackingStore {
    sweeps: AtomicUsize,
    orphan_present: AtomicBool,
    events: Arc<Mutex<Vec<&'static str>>>,
}

#[async_trait]
impl AttachmentArtifactStore for OrphanTrackingStore {
    async fn invoke(
        &self,
        request: AttachmentArtifactStoreRequest,
    ) -> Result<AttachmentArtifactStoreResponse, RuntimeError> {
        assert!(matches!(
            request,
            AttachmentArtifactStoreRequest::SweepOrphans { .. }
        ));
        self.events.lock().unwrap().push("sweep");
        self.sweeps.fetch_add(1, Ordering::SeqCst);
        let deleted = usize::from(self.orphan_present.swap(false, Ordering::SeqCst));
        Ok(AttachmentArtifactStoreResponse::OrphansSwept { deleted })
    }
}

#[async_trait]
impl AttachmentArtifactStore for HeldSweepStore {
    async fn invoke(
        &self,
        request: AttachmentArtifactStoreRequest,
    ) -> Result<AttachmentArtifactStoreResponse, RuntimeError> {
        assert!(matches!(
            request,
            AttachmentArtifactStoreRequest::SweepOrphans { .. }
        ));
        self.entered.notify_one();
        self.release.notified().await;
        Ok(AttachmentArtifactStoreResponse::OrphansSwept { deleted: 0 })
    }
}

#[tokio::test]
async fn two_runtime_instances_sharing_the_host_port_never_own_one_account_together() {
    let lease = Arc::new(ExclusiveLeasePort::default());
    let entered = Arc::new(tokio::sync::Notify::new());
    let release = Arc::new(tokio::sync::Notify::new());
    let store = Arc::new(HeldSweepStore {
        entered: Arc::clone(&entered),
        release: Arc::clone(&release),
    });
    let first_lifecycle = Arc::new(AttachmentMoveLifecycle::new(lease.clone(), store.clone()));
    let second_lifecycle = AttachmentMoveLifecycle::new(lease.clone(), store);
    let events = Arc::new(Mutex::new(Vec::new()));
    let first_driver = Arc::new(RecordingDriver {
        events: Arc::clone(&events),
        calls: AtomicUsize::new(0),
    });
    let second_driver = Arc::new(RecordingDriver {
        events,
        calls: AtomicUsize::new(0),
    });
    let first_scheduler = Arc::new(AttachmentMovePreparationScheduler::new_for_test(
        first_driver.clone(),
    ));
    let second_scheduler = AttachmentMovePreparationScheduler::new_for_test(second_driver.clone());
    let (first_runtime, first_snapshot) = runtime_with_account("shared").await;
    let (second_runtime, second_snapshot) = runtime_with_account("shared").await;
    let first = tokio::spawn({
        let lifecycle = first_lifecycle;
        let scheduler = first_scheduler;
        async move {
            lifecycle
                .run_account(
                    &first_runtime,
                    &scheduler,
                    &first_snapshot,
                    Some("op-first".into()),
                    0,
                )
                .await
        }
    });
    entered.notified().await;

    assert_eq!(
        second_lifecycle
            .run_account(
                &second_runtime,
                &second_scheduler,
                &second_snapshot,
                Some("op-second".into()),
                0,
            )
            .await
            .unwrap(),
        LifecyclePass::LeaseUnavailable
    );
    assert_eq!(second_driver.calls.load(Ordering::SeqCst), 0);
    release.notify_one();
    assert!(matches!(
        first.await.unwrap().unwrap(),
        LifecyclePass::Driven(_)
    ));
    assert_eq!(first_driver.calls.load(Ordering::SeqCst), 1);
    assert_eq!(lease.releases.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn lease_loss_during_an_awaited_sweep_cancels_deletion_and_never_drives() {
    let lease = Arc::new(ExclusiveLeasePort::default());
    let entered = Arc::new(tokio::sync::Notify::new());
    let release = Arc::new(tokio::sync::Notify::new());
    let completed_delete = Arc::new(AtomicBool::new(false));
    let cancelled = Arc::new(AtomicBool::new(false));
    let lifecycle = Arc::new(AttachmentMoveLifecycle::new(
        lease.clone(),
        Arc::new(BlockingSweepStore {
            entered: Arc::clone(&entered),
            release: Arc::clone(&release),
            completed_delete: Arc::clone(&completed_delete),
            cancelled: Arc::clone(&cancelled),
        }),
    ));
    let events = Arc::new(Mutex::new(Vec::new()));
    let driver = Arc::new(RecordingDriver {
        events,
        calls: AtomicUsize::new(0),
    });
    let scheduler = Arc::new(AttachmentMovePreparationScheduler::new_for_test(
        driver.clone(),
    ));
    let (runtime, snapshot) = runtime_with_accepted_preparation("lost-mid-sweep").await;
    let task = tokio::spawn({
        let lifecycle = lifecycle.clone();
        async move {
            lifecycle
                .run_account(
                    &runtime,
                    &scheduler,
                    &snapshot,
                    Some("accepted-op".into()),
                    0,
                )
                .await
        }
    });
    entered.notified().await;
    lease.live.store(false, Ordering::SeqCst);
    lease.lost.notify_waiters();

    assert_eq!(
        task.await.unwrap().unwrap(),
        LifecyclePass::GenerationRetired
    );
    release.notify_waiters();
    tokio::task::yield_now().await;
    assert!(!completed_delete.load(Ordering::SeqCst));
    assert!(cancelled.load(Ordering::SeqCst));
    assert_eq!(driver.calls.load(Ordering::SeqCst), 0);
    assert_eq!(lease.releases.load(Ordering::SeqCst), 1);
    assert!(!lease.held.load(Ordering::SeqCst));
}

#[tokio::test]
async fn owner_a_sweeps_again_before_drive_after_owner_b_crashes_with_a_new_orphan() {
    let lease = Arc::new(ExclusiveLeasePort::default());
    let events = Arc::new(Mutex::new(Vec::new()));
    let store = Arc::new(OrphanTrackingStore {
        sweeps: AtomicUsize::new(0),
        orphan_present: AtomicBool::new(false),
        events: Arc::clone(&events),
    });
    let owner_a = AttachmentMoveLifecycle::new(lease.clone(), store.clone());
    let owner_b = AttachmentMoveLifecycle::new(lease, store.clone());
    let driver = Arc::new(RecordingDriver {
        events: Arc::clone(&events),
        calls: AtomicUsize::new(0),
    });
    let scheduler = AttachmentMovePreparationScheduler::new_for_test(driver.clone());
    let (runtime, snapshot) = runtime_with_accepted_preparation("handoff").await;

    assert_eq!(
        owner_a
            .run_account(&runtime, &scheduler, &snapshot, None, 0)
            .await
            .unwrap(),
        LifecyclePass::Swept
    );
    assert_eq!(
        owner_b
            .run_account(&runtime, &scheduler, &snapshot, None, 0)
            .await
            .unwrap(),
        LifecyclePass::Swept
    );
    store.orphan_present.store(true, Ordering::SeqCst);

    assert!(matches!(
        owner_a
            .run_account(
                &runtime,
                &scheduler,
                &snapshot,
                Some("accepted-op".into()),
                0,
            )
            .await
            .unwrap(),
        LifecyclePass::Driven(_)
    ));
    assert_eq!(store.sweeps.load(Ordering::SeqCst), 3);
    assert!(!store.orphan_present.load(Ordering::SeqCst));
    assert_eq!(
        *events.lock().unwrap(),
        vec!["sweep", "sweep", "sweep", "drive"]
    );
    assert_eq!(driver.calls.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn denied_first_due_account_does_not_starve_the_second_due_account() {
    let (fixture, _) = runtime_with_accepted_preparation("account-a").await;
    add_accepted_preparation_account(&fixture, "account-b").await;
    let persistence = fixture.test_persistence.as_ref().unwrap().clone();
    fixture.close().await;
    let lease = Arc::new(ExclusiveLeasePort::default());
    lease.deny.store(1, Ordering::SeqCst);
    let events = Arc::new(Mutex::new(Vec::new()));
    let store = Arc::new(RecordingStore {
        events,
        requests: Mutex::new(Vec::new()),
        failures: AtomicUsize::new(0),
        lose_lease: None,
    });
    let entered = Arc::new(tokio::sync::Notify::new());
    let driver = Arc::new(AccountRecordingDriver {
        accounts: Mutex::new(Vec::new()),
        entered: Arc::clone(&entered),
    });
    let runtime = Runtime::with_test_preparation_lifecycle_environment(
        persistence,
        driver.clone(),
        lease.clone(),
        store,
        Arc::new(crate::authentication_installation::FixedClock(0)),
        Arc::new(crate::device_timer::SystemDeviceTimer),
    );
    for account in [AccountId::from("account-a"), AccountId::from("account-b")] {
        runtime.replica().load(&account).await.unwrap();
        runtime.seed_unlocked_preparation_account(&account);
    }
    let task = tokio::spawn(runtime.clone().run_attachment_move_preparation());
    entered.notified().await;

    assert!(lease
        .accounts
        .lock()
        .unwrap()
        .starts_with(&[AccountId::from("account-a"), AccountId::from("account-b")]));
    assert_eq!(
        driver.accounts.lock().unwrap().first(),
        Some(&AccountId::from("account-b"))
    );
    runtime.close().await;
    task.await.unwrap().unwrap();
}

#[tokio::test]
async fn all_denied_accounts_use_one_wakeable_resource_backoff_without_hot_polling() {
    let (fixture, snapshot) = runtime_with_accepted_preparation("contended").await;
    let persistence = fixture.test_persistence.as_ref().unwrap().clone();
    fixture.close().await;
    let lease = Arc::new(ExclusiveLeasePort::default());
    lease.deny.store(100, Ordering::SeqCst);
    let timer_entered = Arc::new(tokio::sync::Notify::new());
    let timer = Arc::new(HoldingTimer {
        delays: Mutex::new(Vec::new()),
        entered: Arc::clone(&timer_entered),
    });
    let runtime = Runtime::with_test_preparation_lifecycle_environment(
        persistence,
        Arc::new(RecordingDriver {
            events: Arc::new(Mutex::new(Vec::new())),
            calls: AtomicUsize::new(0),
        }),
        lease.clone(),
        Arc::new(RecordingStore {
            events: Arc::new(Mutex::new(Vec::new())),
            requests: Mutex::new(Vec::new()),
            failures: AtomicUsize::new(0),
            lose_lease: None,
        }),
        Arc::new(crate::authentication_installation::FixedClock(0)),
        timer.clone(),
    );
    runtime.replica().load(&snapshot.account_id).await.unwrap();
    runtime.seed_unlocked_preparation_account(&snapshot.account_id);
    let task = tokio::spawn(runtime.clone().run_attachment_move_preparation());
    timer_entered.notified().await;

    assert_eq!(*timer.delays.lock().unwrap(), vec![250]);
    assert_eq!(lease.accounts.lock().unwrap().len(), 1);
    runtime.close().await;
    task.await.unwrap().unwrap();
}

#[tokio::test]
async fn changed_incarnation_is_rejected_before_the_store_sees_an_account() {
    let events = Arc::new(Mutex::new(Vec::new()));
    let lease = Arc::new(ExclusiveLeasePort::default());
    let store = Arc::new(RecordingStore {
        events: Arc::clone(&events),
        requests: Mutex::new(Vec::new()),
        failures: AtomicUsize::new(0),
        lose_lease: None,
    });
    let (lifecycle, scheduler, driver) = lifecycle_fixture(lease, store.clone(), events);
    let (runtime, mut selected) = runtime_with_account("generation").await;
    selected.incarnation = crate::protocol::Incarnation::from("retired-incarnation");

    assert_eq!(
        lifecycle
            .run_account(&runtime, &scheduler, &selected, Some("op".into()), 0)
            .await
            .unwrap(),
        LifecyclePass::GenerationRetired
    );
    assert!(store.requests.lock().unwrap().is_empty());
    assert_eq!(driver.calls.load(Ordering::SeqCst), 0);
}

#[test]
fn live_set_is_canonical_and_complete_across_preparation_and_both_recovery_variants() {
    let account = AccountId::from("account-live");
    let other = AccountId::from("account-other");
    let preparation = synthetic_preparation(&account, "preparation-op", "attachment-a", 1);
    let prepared = synthetic_preparation(&account, "prepared-op", "attachment-b", 2);
    let stale = synthetic_preparation(&account, "stale-op", "attachment-c", 3);
    let wrong = synthetic_preparation(&other, "wrong-op", "attachment-d", 4);
    let mut prepared_operation = crate::test_fixtures::test_operation("prepared-op", "item-b");
    prepared_operation.attachment_move_recovery = Some(AttachmentMoveRecovery::Prepared {
        preparation: Box::new(prepared),
    });
    let mut stale_operation = crate::test_fixtures::test_operation("stale-op", "item-c");
    stale_operation.attachment_move_recovery = Some(AttachmentMoveRecovery::RejectStaleAuthority {
        preparation: Box::new(stale),
    });
    let snapshot = synthetic_snapshot(
        account.clone(),
        vec![preparation],
        vec![prepared_operation, stale_operation],
    );
    let live = live_artifact_owners(&snapshot).unwrap();
    assert_eq!(
        live.iter()
            .map(|owner| (owner.account_id().clone(), owner.operation_id().to_owned()))
            .collect::<Vec<_>>(),
        vec![
            (account.clone(), "preparation-op".into()),
            (account.clone(), "prepared-op".into()),
            (account.clone(), "stale-op".into()),
        ]
    );
    let wrong_snapshot = synthetic_snapshot(account, vec![wrong], vec![]);
    assert_eq!(
        live_artifact_owners(&wrong_snapshot).unwrap_err().code,
        RuntimeErrorCode::InvariantViolation
    );
}

fn synthetic_preparation(
    account: &AccountId,
    operation: &str,
    attachment: &str,
    byte: u8,
) -> AttachmentMovePreparationRecord {
    let digest = format!("{byte:02x}").repeat(32);
    let artifact =
        attachment_move_artifact_ref(account, operation, attachment, &digest, 1).unwrap();
    AttachmentMovePreparationRecord {
        account_id: account.clone(),
        operation_id: operation.into(),
        item_id: format!("item-{operation}"),
        source_vault_id: "source".into(),
        target_vault_id: "target".into(),
        expected_item_version: 1,
        target_encrypted_data: "sealed".into(),
        target_encryption_algorithm: "AES-GCM-AAD-V1".into(),
        target_encryption_iv: "iv".into(),
        source_attachments: vec![],
        progress: vec![AttachmentMoveProgress::Encrypted {
            attachment_id: attachment.into(),
            expected_envelope_version: 1,
            artifact,
            payload: Box::new(PreparedMoveAttachment {
                encrypted_name: "name".into(),
                encryption_iv: "iv".into(),
                encryption_algorithm: "AES-GCM-AAD-V1".into(),
                encrypted_attachment_key: "key".into(),
                attachment_key_iv: "iv".into(),
                attachment_key_algorithm: "AES-GCM-AAD-V1".into(),
                encrypted_content_type: "type".into(),
                encrypted_content_type_iv: "iv".into(),
            }),
            upload: AttachmentMoveUploadState::Uploaded,
        }],
        intent_fingerprint: Sha256Fingerprint([0; 32]),
        scheduling: OperationSchedulingState::default(),
    }
}

fn synthetic_snapshot(
    account_id: AccountId,
    preparations: Vec<AttachmentMovePreparationRecord>,
    operations: Vec<crate::replica::OperationRecord>,
) -> ReplicaSnapshot {
    ReplicaSnapshot {
        account_id,
        user_id: "user".into(),
        incarnation: crate::protocol::Incarnation::from("inc"),
        revision: 0,
        lock_epoch: 0,
        items: vec![],
        operations,
        attachment_move_preparations: preparations,
        receipts: vec![],
        failure: None,
        bootstrap: BootstrapAuthority::default(),
    }
}
