use super::attachment_move_preparation::{PreparationDriveRequest, PreparationDriveResult};
use super::attachment_move_scheduler::{
    AttachmentMovePreparationDriver, AttachmentMovePreparationScheduler, PreparationCandidate,
    RuntimeAttachmentMoveSecrets, SchedulerDriveResult, SchedulerPass,
};
use crate::{AccountId, RuntimeError};
use async_trait::async_trait;
use std::{
    collections::HashSet,
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    },
};

fn seed_promotable_preparation(
    persistence: &crate::replica::InMemoryReplica,
    account_id: AccountId,
    operation_id: &str,
    attempt_count: u64,
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
        file_size: 1,
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
    let owner =
        attachment_move_artifact_ref(&account_id, operation_id, ATTACHMENT, &"11".repeat(32), 1)
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
    tokio::task::yield_now().await;
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
