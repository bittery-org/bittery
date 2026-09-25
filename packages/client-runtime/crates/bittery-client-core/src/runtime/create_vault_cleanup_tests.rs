use super::*;
use crate::{
    replica::{CreateVaultOperationRecord, GuardedCommitPlan, PlanMutation},
    vault_image::{
        SqliteVaultImageArtifactStore, VaultImageArtifactMetadata, VaultImageArtifactPort,
        VaultImageArtifactScope,
    },
    Incarnation, VaultImageIngressFacade,
};
use sha2::{Digest, Sha256};

fn metadata(account: &str, operation: &str, vault: &str) -> VaultImageArtifactMetadata {
    VaultImageArtifactMetadata::new(
        VaultImageArtifactScope::new(account.into(), operation).unwrap(),
        vault,
        11,
        "image/png",
        format!("{:x}", Sha256::digest(b"image-bytes")),
    )
    .unwrap()
}

async fn begin(
    store: &SqliteVaultImageArtifactStore,
    metadata: &VaultImageArtifactMetadata,
    publish: bool,
) {
    store.begin(metadata.scope()).await.unwrap();
    store
        .write_chunk(metadata.scope(), 0, b"image-bytes")
        .await
        .unwrap();
    if publish {
        store.publish(metadata).await.unwrap();
    }
}

#[tokio::test]
async fn selected_receipt_cleanup_preserves_accepted_and_unrelated_unpublished_images() {
    let (runtime, persistence, _) = super::super::teardown_tests::create_vault_teardown_harness();
    let account = AccountId::from("account-1");
    let mut accepted = super::super::create_vault_tests::seed_rejected_image_cleanup(
        &persistence,
        "retired-image",
    )
    .await;
    accepted.operation_id = "accepted-image".into();
    let create: &mut CreateVaultOperationRecord = accepted.create_vault.as_mut().unwrap();
    let image = create.image.as_mut().unwrap();
    image.object_key = format!(
        "vaults/user-1/vault-cleanup/create/accepted-image-{}",
        image.sha256
    );
    let (request, fingerprint) = super::super::create_vault::create_vault_http_request(
        accepted.vault_id(),
        accepted.create_vault.as_ref().unwrap(),
    )
    .unwrap();
    accepted.request = request;
    accepted.request_fingerprint = fingerprint;
    let before = persistence.snapshot(&account).unwrap();
    assert!(matches!(
        persistence
            .execute(GuardedCommitPlan::new(
                account.clone(),
                Incarnation::from("incarnation-1"),
                before.revision,
                before.lock_epoch,
                vec![PlanMutation::AcceptOperation(accepted)],
            ))
            .unwrap(),
        PlanResult::Applied { .. }
    ));
    runtime.replica.load(&account).await.unwrap().unwrap();
    let path = std::env::temp_dir().join(format!(
        "bittery-scoped-image-cleanup-{}.sqlite",
        bittery_crypto_core::generate_uuid()
    ));
    let artifacts = Arc::new(SqliteVaultImageArtifactStore::open(&path).unwrap());
    let retired = metadata("account-1", "retired-image", "vault-cleanup");
    let accepted = metadata("account-1", "accepted-image", "vault-cleanup");
    let unrelated = metadata("account-1", "still-ingesting", "other-vault");
    let other_account = metadata("account-2", "other-account-image", "vault-cleanup");
    begin(&artifacts, &retired, true).await;
    begin(&artifacts, &accepted, true).await;
    begin(&artifacts, &unrelated, false).await;
    begin(&artifacts, &other_account, true).await;
    runtime.install_vault_image_ingress(
        VaultImageIngressFacade::new(
            "runtime-1",
            Arc::new(super::super::create_vault_tests::ExactImageSourcePort),
            artifacts.clone(),
        )
        .unwrap(),
    );
    let snapshot = runtime.replica.snapshot(&account).unwrap();
    let lock = runtime.account_execution_lock_internal(&account).unwrap();
    let guard = lock.lock().await;
    runtime
        .sweep_retired_vault_images(&snapshot, &["vault-cleanup".into()])
        .await
        .unwrap();
    assert!(artifacts.read_chunk(&retired, 0).await.unwrap().is_none());
    assert_eq!(
        artifacts.read_chunk(&accepted, 0).await.unwrap().unwrap(),
        b"image-bytes"
    );
    artifacts
        .publish(&unrelated)
        .await
        .expect("unrelated in-progress image was preserved");
    assert_eq!(
        artifacts
            .read_chunk(&other_account, 0)
            .await
            .unwrap()
            .unwrap(),
        b"image-bytes"
    );
    let receipt = runtime
        .replica
        .snapshot(&account)
        .unwrap()
        .receipts
        .into_iter()
        .find(|receipt| receipt.operation_id == "retired-image")
        .unwrap();
    let cleanup = receipt.create_vault_cleanup.unwrap();
    assert!(!cleanup.local_artifact_pending);
    assert!(cleanup.remote_staging_pending);
    drop(guard);
    runtime.close().await;
    drop(runtime);
    drop(artifacts);
    std::fs::remove_file(path).unwrap();
}

#[tokio::test]
async fn startup_cleanup_requires_a_facade_only_for_selected_outstanding_local_duties() {
    let (runtime, persistence, _) =
        super::super::teardown_tests::unopened_create_vault_teardown_harness();
    super::super::create_vault_tests::seed_rejected_image_cleanup(&persistence, "pending-image")
        .await;
    let account = AccountId::from("account-1");
    let snapshot = runtime.replica.load(&account).await.unwrap().unwrap();
    assert!(!runtime.ready.load(Ordering::SeqCst));
    let lock = runtime.account_execution_lock_internal(&account).unwrap();
    let _guard = lock.lock().await;
    runtime
        .sweep_retired_vault_images(&snapshot, &["other-vault".into()])
        .await
        .unwrap();
    assert_eq!(
        runtime
            .sweep_retired_vault_images(&snapshot, &["vault-cleanup".into()])
            .await
            .unwrap_err()
            .code,
        RuntimeErrorCode::StorageUnavailable
    );
    assert!(
        runtime.replica.snapshot(&account).unwrap().receipts[0]
            .create_vault_cleanup
            .as_ref()
            .unwrap()
            .local_artifact_pending
    );
}

#[tokio::test]
async fn failed_local_acknowledgement_keeps_the_duty_and_retries_an_already_deleted_image() {
    let (runtime, persistence, replica_port) =
        super::super::teardown_tests::unopened_create_vault_teardown_harness();
    super::super::create_vault_tests::seed_rejected_image_cleanup(&persistence, "pending-image")
        .await;
    let account = AccountId::from("account-1");
    runtime.replica.load(&account).await.unwrap().unwrap();
    let artifacts = Arc::new(crate::vault_image::MemoryVaultImageArtifactStore::default());
    let image = metadata("account-1", "pending-image", "vault-cleanup");
    artifacts.begin(image.scope()).await.unwrap();
    artifacts
        .write_chunk(image.scope(), 0, b"image-bytes")
        .await
        .unwrap();
    artifacts.publish(&image).await.unwrap();
    runtime.install_vault_image_ingress(
        VaultImageIngressFacade::new(
            "runtime-1",
            Arc::new(super::super::create_vault_tests::ExactImageSourcePort),
            artifacts.clone(),
        )
        .unwrap(),
    );
    let snapshot = runtime.replica.snapshot(&account).unwrap();
    let lock = runtime.account_execution_lock_internal(&account).unwrap();
    let _guard = lock.lock().await;
    replica_port.fail_next_guarded_commit();
    assert!(runtime
        .sweep_retired_vault_images(&snapshot, &["vault-cleanup".into()])
        .await
        .is_err());
    assert!(artifacts.read_chunk(&image, 0).await.unwrap().is_none());
    assert!(
        persistence.snapshot(&account).unwrap().receipts[0]
            .create_vault_cleanup
            .as_ref()
            .unwrap()
            .local_artifact_pending
    );
    runtime.replica.remove_cached(&account);
    let reloaded = runtime.replica.load(&account).await.unwrap().unwrap();
    runtime
        .sweep_retired_vault_images(&reloaded, &["vault-cleanup".into()])
        .await
        .unwrap();
    let snapshot = runtime.replica.snapshot(&account).unwrap();
    let cleanup = snapshot.receipts[0].create_vault_cleanup.as_ref().unwrap();
    assert!(!cleanup.local_artifact_pending);
    assert!(cleanup.remote_staging_pending);
}

#[tokio::test]
async fn retired_owner_refuses_cleanup_even_when_no_selected_duty_remains() {
    let (runtime, persistence, _) = super::super::teardown_tests::create_vault_teardown_harness();
    super::super::create_vault_tests::seed_rejected_image_cleanup(&persistence, "pending-image")
        .await;
    let account = AccountId::from("account-1");
    let snapshot = runtime.replica.load(&account).await.unwrap().unwrap();
    runtime.close().await;
    assert_eq!(
        runtime
            .sweep_retired_vault_images(&snapshot, &[])
            .await
            .unwrap_err()
            .code,
        RuntimeErrorCode::Cancelled
    );
}

#[tokio::test]
async fn legacy_accepted_image_protection_commits_witness_before_exact_raw_cleanup() {
    let (runtime, persistence, _) = super::super::teardown_tests::create_vault_teardown_harness();
    super::super::create_vault_tests::seed_image_cleanup(&persistence, "accepted-image", false)
        .await;
    let account = AccountId::from("account-1");
    runtime.replica.load(&account).await.unwrap();
    runtime
        .platform_storage
        .store_device_key(&DeviceKeyDocument::new([7; 32]))
        .await
        .unwrap();
    let path = std::env::temp_dir().join(format!(
        "bittery-accepted-image-upgrade-{}.sqlite",
        bittery_crypto_core::generate_uuid()
    ));
    let artifacts = Arc::new(SqliteVaultImageArtifactStore::open(&path).unwrap());
    let raw = metadata("account-1", "accepted-image", "vault-cleanup");
    begin(&artifacts, &raw, true).await;
    runtime.install_vault_image_ingress(
        VaultImageIngressFacade::new(
            "runtime-1",
            Arc::new(super::super::create_vault_tests::ExactImageSourcePort),
            artifacts.clone(),
        )
        .unwrap(),
    );
    let before = runtime.replica.snapshot(&account).unwrap();
    let operation = before.operations[0].clone();
    let lock = runtime.account_execution_lock_internal(&account).unwrap();
    let guard = lock.lock().await;
    let after = runtime
        .protect_accepted_vault_images(&before)
        .await
        .unwrap();
    let accepted = &after.operations[0];
    assert_eq!(accepted.request, operation.request);
    assert_eq!(accepted.request_fingerprint, operation.request_fingerprint);
    assert!(!accepted.vault_image().unwrap().raw_cleanup_pending);
    let witness = accepted
        .vault_image()
        .unwrap()
        .protected_witness
        .as_ref()
        .unwrap();
    assert!(artifacts.read_chunk(&raw, 0).await.unwrap().is_none());
    let protected = artifacts
        .read_generation(raw.scope(), Some(""))
        .await
        .unwrap()
        .unwrap()
        .metadata
        .unwrap();
    assert_eq!(&protected.protection().unwrap().witness, witness);
    let revision = after.revision;
    assert_eq!(
        runtime
            .protect_accepted_vault_images(&after)
            .await
            .unwrap()
            .revision,
        revision
    );
    drop(guard);
    runtime
        .platform_storage
        .store_device_catalog(
            &DeviceCatalogDocument::new(vec![DeviceCatalogAccount {
                account_id: account.clone(),
                active_incarnation: Some(after.incarnation.clone()),
                pending_retirement: None,
                pending_install: None,
            }])
            .unwrap(),
        )
        .await
        .unwrap();
    runtime.platform_storage.remove_device_key().await.unwrap();
    let catalog_guard = runtime.catalog_transition.lock().await;
    assert_eq!(
        runtime
            .ensure_image_device_key_under_catalog(&SystemInstallationEntropy)
            .await
            .err()
            .unwrap()
            .code,
        RuntimeErrorCode::StorageUnavailable
    );
    assert!(runtime
        .platform_storage
        .load_device_key()
        .await
        .unwrap()
        .is_none());
    assert_eq!(
        runtime.replica.snapshot(&account).unwrap().operations,
        after.operations
    );
    drop(catalog_guard);
    runtime.close().await;
    drop(runtime);
    drop(artifacts);
    let reopened = SqliteVaultImageArtifactStore::open(&path).unwrap();
    assert!(reopened.read_chunk(&protected, 0).await.unwrap().is_some());
    drop(reopened);
    std::fs::remove_file(path).unwrap();
}

#[tokio::test]
async fn legacy_image_upgrade_retries_failed_witness_and_busy_raw_cleanup_without_losing_work() {
    let (runtime, persistence, replica_port) =
        super::super::teardown_tests::create_vault_teardown_harness();
    super::super::create_vault_tests::seed_image_cleanup(&persistence, "accepted-image", false)
        .await;
    let account = AccountId::from("account-1");
    runtime.replica.load(&account).await.unwrap();
    runtime
        .platform_storage
        .store_device_key(&DeviceKeyDocument::new([7; 32]))
        .await
        .unwrap();
    let path = std::env::temp_dir().join(format!(
        "bittery-accepted-image-upgrade-retry-{}.sqlite",
        bittery_crypto_core::generate_uuid()
    ));
    let keeper = rusqlite::Connection::open(&path).unwrap();
    keeper
        .execute_batch("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;")
        .unwrap();
    let artifacts = Arc::new(SqliteVaultImageArtifactStore::open(&path).unwrap());
    let raw = metadata("account-1", "accepted-image", "vault-cleanup");
    begin(&artifacts, &raw, true).await;
    runtime.install_vault_image_ingress(
        VaultImageIngressFacade::new(
            "runtime-1",
            Arc::new(super::super::create_vault_tests::ExactImageSourcePort),
            artifacts.clone(),
        )
        .unwrap(),
    );
    let original = runtime.replica.snapshot(&account).unwrap();
    let lock = runtime.account_execution_lock_internal(&account).unwrap();
    let guard = lock.lock().await;
    replica_port.fail_next_guarded_commit();
    assert!(runtime
        .protect_accepted_vault_images(&original)
        .await
        .is_err());
    assert!(artifacts.read_chunk(&raw, 0).await.unwrap().is_some());
    let protected = artifacts
        .read_generation(raw.scope(), Some(""))
        .await
        .unwrap()
        .unwrap()
        .metadata
        .unwrap();
    let current = runtime.replica.snapshot(&account).unwrap();
    assert!(current.operations[0]
        .vault_image()
        .unwrap()
        .protected_witness
        .is_none());
    keeper
        .execute_batch("BEGIN; SELECT COUNT(*) FROM vault_image_artifacts;")
        .unwrap();
    assert_eq!(
        runtime
            .protect_accepted_vault_images(&current)
            .await
            .unwrap_err()
            .code,
        RuntimeErrorCode::StorageUnavailable
    );
    let pending = runtime.replica.snapshot(&account).unwrap();
    let image = pending.operations[0].vault_image().unwrap();
    assert!(image.raw_cleanup_pending);
    assert_eq!(
        image.protected_witness.as_ref().unwrap(),
        &protected.protection().unwrap().witness
    );
    assert!(artifacts.read_chunk(&raw, 0).await.unwrap().is_none());
    assert!(artifacts.read_chunk(&protected, 0).await.unwrap().is_some());
    keeper.execute_batch("COMMIT;").unwrap();
    let complete = runtime
        .protect_accepted_vault_images(&pending)
        .await
        .unwrap();
    assert!(
        !complete.operations[0]
            .vault_image()
            .unwrap()
            .raw_cleanup_pending
    );
    assert_eq!(
        complete.operations[0].request,
        original.operations[0].request
    );
    assert_eq!(
        complete.operations[0].request_fingerprint,
        original.operations[0].request_fingerprint
    );
    assert!(artifacts
        .read_generation(raw.scope(), protected.scope().publication_id())
        .await
        .unwrap()
        .is_none());
    drop(guard);
    runtime.close().await;
    drop(runtime);
    drop(artifacts);
    drop(keeper);
    std::fs::remove_file(path).unwrap();
}

#[tokio::test]
async fn pending_raw_cleanup_refuses_a_lost_protected_dependency() {
    let (runtime, persistence, replica_port) =
        super::super::teardown_tests::create_vault_teardown_harness();
    super::super::create_vault_tests::seed_image_cleanup(&persistence, "accepted-image", false)
        .await;
    let account = AccountId::from("account-1");
    runtime.replica.load(&account).await.unwrap();
    runtime
        .platform_storage
        .store_device_key(&DeviceKeyDocument::new([7; 32]))
        .await
        .unwrap();
    let artifacts = Arc::new(SqliteVaultImageArtifactStore::open(":memory:").unwrap());
    let raw = metadata("account-1", "accepted-image", "vault-cleanup");
    begin(&artifacts, &raw, true).await;
    runtime.install_vault_image_ingress(
        VaultImageIngressFacade::new(
            "runtime-1",
            Arc::new(super::super::create_vault_tests::ExactImageSourcePort),
            artifacts.clone(),
        )
        .unwrap(),
    );
    let original = runtime.replica.snapshot(&account).unwrap();
    let lock = runtime.account_execution_lock_internal(&account).unwrap();
    let _guard = lock.lock().await;
    replica_port.fail_next_guarded_commit();
    assert!(runtime
        .protect_accepted_vault_images(&original)
        .await
        .is_err());
    let protected = artifacts
        .read_generation(raw.scope(), Some(""))
        .await
        .unwrap()
        .unwrap()
        .metadata
        .unwrap();
    let current = runtime
        .commit_image_protection(
            original,
            PlanMutation::ProtectVaultImage {
                operation_id: "accepted-image".into(),
                witness: protected.protection().unwrap().witness.clone(),
            },
        )
        .await
        .unwrap();
    artifacts
        .delete_generation(protected.scope())
        .await
        .unwrap();
    assert!(runtime
        .protect_accepted_vault_images(&current)
        .await
        .is_err());
    assert!(artifacts.read_chunk(&raw, 0).await.unwrap().is_some());
    assert!(
        runtime.replica.snapshot(&account).unwrap().operations[0]
            .vault_image()
            .unwrap()
            .raw_cleanup_pending
    );
}
