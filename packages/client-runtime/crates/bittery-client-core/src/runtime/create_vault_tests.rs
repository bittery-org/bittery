use super::*;
use crate::{CreateVaultType, Incarnation, VaultImageArtifactPort, VaultImageSourceInput};
use async_trait::async_trait;
use serde_json::json;
use sha2::{Digest, Sha256};
use std::collections::HashSet;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Arc;

struct OneImageSource {
    bytes: Option<Vec<u8>>,
}

#[async_trait]
impl crate::VaultImageSource for OneImageSource {
    async fn next_chunk(
        &mut self,
        _max_bytes: usize,
    ) -> Result<Option<Vec<u8>>, crate::VaultImageSourceError> {
        Ok(self.bytes.take())
    }

    async fn close(&mut self) -> Result<(), crate::VaultImageSourceError> {
        Ok(())
    }
}

pub(super) struct ExactImageSourcePort;

#[async_trait]
impl crate::VaultImageSourcePort for ExactImageSourcePort {
    async fn claim(
        &self,
        grant: &crate::VaultImageSourceGrant,
    ) -> Result<Box<dyn crate::VaultImageSource>, crate::VaultImageSourceError> {
        assert_eq!(grant.capability_id, "opaque-image-source");
        Ok(Box::new(OneImageSource {
            bytes: Some(b"image-bytes".to_vec()),
        }))
    }

    async fn retire_account(
        &self,
        _runtime_incarnation: &str,
        _account_id: &AccountId,
    ) -> Result<(), crate::VaultImageSourceError> {
        Ok(())
    }

    async fn complete_account_retirement(
        &self,
        _runtime_incarnation: &str,
        _account_id: &AccountId,
    ) -> Result<(), crate::VaultImageSourceError> {
        Ok(())
    }

    async fn begin_acceptance(
        &self,
        _runtime_incarnation: &str,
        _account_id: &AccountId,
        _operation_id: &str,
    ) -> Result<(), crate::VaultImageSourceError> {
        Ok(())
    }

    async fn end_acceptance(
        &self,
        _runtime_incarnation: &str,
        _account_id: &AccountId,
        _operation_id: &str,
    ) -> Result<(), crate::VaultImageSourceError> {
        Ok(())
    }

    async fn retire_vaults(
        &self,
        _: &str,
        _: &AccountId,
        _: &[String],
    ) -> Result<(), crate::VaultImageSourceError> {
        Ok(())
    }
    async fn complete_vault_retirement(
        &self,
        _: &str,
        _: &AccountId,
        _: &[String],
    ) -> Result<(), crate::VaultImageSourceError> {
        Ok(())
    }
    async fn forget_account_vault_retirements(
        &self,
        _: &str,
        _: &AccountId,
    ) -> Result<(), crate::VaultImageSourceError> {
        Ok(())
    }
    async fn retire_runtime(
        &self,
        _runtime_incarnation: &str,
    ) -> Result<(), crate::VaultImageSourceError> {
        Ok(())
    }
}

#[derive(Default)]
struct TrackingImageSourcePort {
    scope: Mutex<Option<(String, String)>>,
    acceptance: Mutex<Vec<&'static str>>,
    fail_begin: AtomicBool,
}

pub(super) fn fail_end_once_source() -> Arc<dyn crate::VaultImageSourcePort> {
    Arc::new(FailEndOnceImageSourcePort {
        inner: TrackingImageSourcePort::default(),
        failures_left: AtomicUsize::new(1),
    })
}

struct FailEndOnceImageSourcePort {
    inner: TrackingImageSourcePort,
    failures_left: AtomicUsize,
}

#[async_trait]
impl crate::VaultImageSourcePort for FailEndOnceImageSourcePort {
    async fn claim(
        &self,
        grant: &crate::VaultImageSourceGrant,
    ) -> Result<Box<dyn crate::VaultImageSource>, crate::VaultImageSourceError> {
        self.inner.claim(grant).await
    }

    async fn retire_account(
        &self,
        runtime_incarnation: &str,
        account_id: &AccountId,
    ) -> Result<(), crate::VaultImageSourceError> {
        self.inner
            .retire_account(runtime_incarnation, account_id)
            .await
    }

    async fn complete_account_retirement(
        &self,
        runtime_incarnation: &str,
        account_id: &AccountId,
    ) -> Result<(), crate::VaultImageSourceError> {
        self.inner
            .complete_account_retirement(runtime_incarnation, account_id)
            .await
    }

    async fn begin_acceptance(
        &self,
        runtime_incarnation: &str,
        account_id: &AccountId,
        operation_id: &str,
    ) -> Result<(), crate::VaultImageSourceError> {
        self.inner
            .begin_acceptance(runtime_incarnation, account_id, operation_id)
            .await
    }

    async fn end_acceptance(
        &self,
        runtime_incarnation: &str,
        account_id: &AccountId,
        operation_id: &str,
    ) -> Result<(), crate::VaultImageSourceError> {
        self.inner.acceptance.lock().unwrap().push("end");
        if self
            .failures_left
            .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |value| {
                value.checked_sub(1)
            })
            .is_ok()
        {
            Err(crate::VaultImageSourceError::Source)
        } else {
            let _ = (runtime_incarnation, account_id, operation_id);
            Ok(())
        }
    }

    async fn retire_vaults(
        &self,
        _: &str,
        _: &AccountId,
        _: &[String],
    ) -> Result<(), crate::VaultImageSourceError> {
        Ok(())
    }
    async fn complete_vault_retirement(
        &self,
        _: &str,
        _: &AccountId,
        _: &[String],
    ) -> Result<(), crate::VaultImageSourceError> {
        Ok(())
    }
    async fn forget_account_vault_retirements(
        &self,
        _: &str,
        _: &AccountId,
    ) -> Result<(), crate::VaultImageSourceError> {
        Ok(())
    }
    async fn retire_runtime(
        &self,
        runtime_incarnation: &str,
    ) -> Result<(), crate::VaultImageSourceError> {
        self.inner.retire_runtime(runtime_incarnation).await
    }
}

#[derive(Default)]
struct FailDeleteArtifactPort {
    inner: crate::MemoryVaultImageArtifactStore,
    fail_delete: AtomicBool,
    delete_calls: AtomicUsize,
}

#[async_trait]
impl crate::VaultImageArtifactPort for FailDeleteArtifactPort {
    async fn read_generation(
        &self,
        scope: &crate::VaultImageArtifactScope,
        after: Option<&str>,
    ) -> Result<Option<crate::VaultImageArtifactGeneration>, RuntimeError> {
        self.inner.read_generation(scope, after).await
    }
    async fn delete_generation(
        &self,
        scope: &crate::VaultImageArtifactScope,
    ) -> Result<(), RuntimeError> {
        self.inner.delete_generation(scope).await
    }

    async fn begin(&self, scope: &crate::VaultImageArtifactScope) -> Result<(), RuntimeError> {
        self.inner.begin(scope).await
    }
    async fn write_chunk(
        &self,
        scope: &crate::VaultImageArtifactScope,
        index: u32,
        bytes: &[u8],
    ) -> Result<crate::VaultImageChunkWrite, RuntimeError> {
        self.inner.write_chunk(scope, index, bytes).await
    }
    async fn publish(
        &self,
        metadata: &crate::VaultImageArtifactMetadata,
    ) -> Result<crate::VaultImagePublication, RuntimeError> {
        self.inner.publish(metadata).await
    }
    async fn read_chunk(
        &self,
        metadata: &crate::VaultImageArtifactMetadata,
        index: u32,
    ) -> Result<Option<Vec<u8>>, RuntimeError> {
        self.inner.read_chunk(metadata, index).await
    }
    async fn delete(&self, scope: &crate::VaultImageArtifactScope) -> Result<(), RuntimeError> {
        self.delete_calls.fetch_add(1, Ordering::SeqCst);
        if self.fail_delete.swap(false, Ordering::SeqCst) {
            Err(RuntimeError::new(
                RuntimeErrorCode::InvariantViolation,
                "injected local delete failure",
            ))
        } else {
            self.inner.delete(scope).await
        }
    }
    async fn delete_account(&self, account_id: &AccountId) -> Result<(), RuntimeError> {
        self.inner.delete_account(account_id).await
    }
    async fn wipe(&self) -> Result<(), RuntimeError> {
        self.inner.wipe().await
    }
    async fn sweep_orphans(
        &self,
        account_id: &AccountId,
        referenced: &HashSet<String>,
    ) -> Result<(), RuntimeError> {
        self.inner.sweep_orphans(account_id, referenced).await
    }
}

#[async_trait]
impl crate::VaultImageSourcePort for TrackingImageSourcePort {
    async fn claim(
        &self,
        grant: &crate::VaultImageSourceGrant,
    ) -> Result<Box<dyn crate::VaultImageSource>, crate::VaultImageSourceError> {
        *self.scope.lock().unwrap() = Some((grant.operation_id.clone(), grant.vault_id.clone()));
        Ok(Box::new(OneImageSource {
            bytes: Some(b"image-bytes".to_vec()),
        }))
    }
    async fn retire_account(
        &self,
        _: &str,
        _: &AccountId,
    ) -> Result<(), crate::VaultImageSourceError> {
        Ok(())
    }
    async fn complete_account_retirement(
        &self,
        _: &str,
        _: &AccountId,
    ) -> Result<(), crate::VaultImageSourceError> {
        Ok(())
    }
    async fn begin_acceptance(
        &self,
        _: &str,
        _: &AccountId,
        _: &str,
    ) -> Result<(), crate::VaultImageSourceError> {
        self.acceptance.lock().unwrap().push("begin");
        if self.fail_begin.swap(false, Ordering::SeqCst) {
            Err(crate::VaultImageSourceError::Source)
        } else {
            Ok(())
        }
    }
    async fn end_acceptance(
        &self,
        _: &str,
        _: &AccountId,
        _: &str,
    ) -> Result<(), crate::VaultImageSourceError> {
        self.acceptance.lock().unwrap().push("end");
        Ok(())
    }
    async fn retire_vaults(
        &self,
        _: &str,
        _: &AccountId,
        _: &[String],
    ) -> Result<(), crate::VaultImageSourceError> {
        Ok(())
    }
    async fn complete_vault_retirement(
        &self,
        _: &str,
        _: &AccountId,
        _: &[String],
    ) -> Result<(), crate::VaultImageSourceError> {
        Ok(())
    }
    async fn forget_account_vault_retirements(
        &self,
        _: &str,
        _: &AccountId,
    ) -> Result<(), crate::VaultImageSourceError> {
        Ok(())
    }
    async fn retire_runtime(&self, _: &str) -> Result<(), crate::VaultImageSourceError> {
        Ok(())
    }
}

async fn image_platform() -> Arc<operation_fixtures::MemoryPlatform> {
    let platform = operation_fixtures::MemoryPlatform::new();
    PlatformStorage::new(platform.clone())
        .store_device_key(&DeviceKeyDocument::new([7; 32]))
        .await
        .unwrap();
    platform
}

async fn unlocked_runtime() -> (Arc<Runtime>, AccountId, Incarnation) {
    let persistence = Arc::new(InMemoryReplica::default());
    let runtime = Runtime::with_persistence(
        persistence.clone(),
        Arc::new(PlatformStorage::new(image_platform().await)),
        Arc::new(HttpTransport::unavailable()),
        None,
        None,
        true,
        Arc::new(SystemClock),
        Arc::new(SystemDeviceTimer),
        Some(persistence),
    );
    let account_id = AccountId::from("account-1");
    let incarnation = Incarnation::from("incarnation-1");
    let installed = runtime
        .replica()
        .install_or_replace(account_id.clone(), "user-1".into(), incarnation.clone())
        .await
        .unwrap();
    runtime.replica().cache(installed);
    runtime.seed_live_master_unlock_key(&account_id, &incarnation);
    runtime.seed_unlocked_preparation_account(&account_id);
    (runtime, account_id, incarnation)
}

#[test]
fn create_vault_request_is_closed_bounded_and_redacted_at_the_runtime_seam() {
    let request = RuntimeRequest::CreateVault {
        account_id: AccountId::from("account-1"),
        name: "  Shared secrets  ".into(),
        vault_type: CreateVaultType::Shared,
        icon: "lock".into(),
        image_source: Some(VaultImageSourceInput {
            capability_id: "opaque-image-source".into(),
            byte_length: 42,
            content_type: "image/png".into(),
        }),
    };

    assert_eq!(
        serde_json::to_value(&request).unwrap(),
        json!({
            "type": "createVault",
            "accountId": "account-1",
            "name": "  Shared secrets  ",
            "vaultType": "shared",
            "icon": "lock",
            "imageSource": {
                "capabilityId": "opaque-image-source",
                "byteLength": "42",
                "contentType": "image/png"
            }
        })
    );
    let diagnostic = format!("{request:?}");
    assert!(diagnostic.contains("account-1"));
    assert!(!diagnostic.contains("opaque-image-source"));
}

#[tokio::test]
async fn image_free_create_vault_accepts_one_wrapped_key_and_frozen_request_atomically() {
    let (runtime, account_id, _) = unlocked_runtime().await;

    let response = runtime
        .request(
            RuntimeRequest::CreateVault {
                account_id: account_id.clone(),
                name: "  Personal secrets  ".into(),
                vault_type: CreateVaultType::Personal,
                icon: "lock".into(),
                image_source: None,
            },
            RequestCancellation::new(),
        )
        .await
        .unwrap();

    let (operation_id, vault_id, revision) = match response {
        RuntimeResponse::VaultCreationAccepted {
            operation_id,
            vault_id,
            replica_revision,
        } => (operation_id, vault_id, replica_revision),
        other => panic!("expected durable Vault acceptance, got {other:?}"),
    };
    let snapshot = runtime.replica().snapshot(&account_id).unwrap();
    assert_eq!(snapshot.revision, revision);
    assert_eq!(snapshot.operations.len(), 1);
    let operation = &snapshot.operations[0];
    assert_eq!(operation.operation_id, operation_id);
    assert_eq!(operation.vault_id(), vault_id);
    assert_eq!(
        operation.target,
        crate::replica::ResourceRef::Vault {
            vault_id: vault_id.clone()
        }
    );
    assert!(!serde_json::to_value(operation)
        .unwrap()
        .as_object()
        .unwrap()
        .contains_key("itemId"));
    let mut duplicate_identity = serde_json::to_value(operation).unwrap();
    duplicate_identity
        .as_object_mut()
        .unwrap()
        .insert("itemId".into(), serde_json::Value::String(vault_id.clone()));
    assert!(serde_json::from_value::<crate::replica::OperationRecord>(duplicate_identity).is_err());
    let mut inconsistent_target = serde_json::to_value(operation).unwrap();
    inconsistent_target["target"]["itemId"] = serde_json::Value::String("not-an-item".into());
    assert!(
        serde_json::from_value::<crate::replica::OperationRecord>(inconsistent_target).is_err()
    );
    assert_eq!(operation.request.path, format!("/api/v1/vaults/{vault_id}"));
    let body: serde_json::Value = serde_json::from_slice(&operation.request.body).unwrap();
    assert_eq!(body["name"], "Personal secrets");
    assert_eq!(body["vaultType"], "personal");
    assert_eq!(body["icon"], "lock");
    assert_eq!(body["imageKey"], serde_json::Value::Null);
    assert!(body["encryptedVaultKey"]
        .as_str()
        .unwrap()
        .contains("AES-GCM"));
    let pending = operation.create_vault.as_ref().unwrap();
    let unwrapped = bittery_crypto_core::decrypt_vault_key_with_muk(
        &pending.encrypted_vault_key,
        &crate::test_fixtures::TEST_MASTER_UNLOCK_KEY,
        &bittery_crypto_core::VaultKeyWrapContext::new(&vault_id, "user-1", 1),
    )
    .unwrap();
    assert_eq!(unwrapped.len(), 32);
    assert!(bittery_crypto_core::decrypt_vault_key_with_muk(
        &pending.encrypted_vault_key,
        &crate::test_fixtures::TEST_MASTER_UNLOCK_KEY,
        &bittery_crypto_core::VaultKeyWrapContext::new("wrong-vault", "user-1", 1),
    )
    .is_err());
    assert!(bittery_crypto_core::decrypt_vault_key_with_muk(
        &pending.encrypted_vault_key,
        &crate::test_fixtures::TEST_MASTER_UNLOCK_KEY,
        &bittery_crypto_core::VaultKeyWrapContext::new(&vault_id, "wrong-user", 1),
    )
    .is_err());
    assert_eq!(
        pending.checkpoint,
        crate::replica::CreateVaultCheckpoint::FinalRequestFrozen
    );
    assert!(pending.image.is_none());
    assert!(snapshot.bootstrap.vaults.is_empty());
}

#[tokio::test]
async fn create_vault_coexists_with_an_active_item_operation_without_stealing_item_ownership() {
    let (runtime, account_id, incarnation) = unlocked_runtime().await;
    let item_operation = crate::test_fixtures::test_operation("operation-item", "item-existing");
    runtime
        .replica()
        .execute(GuardedCommitPlan::new(
            account_id.clone(),
            incarnation,
            0,
            0,
            vec![PlanMutation::AcceptOperation(item_operation.clone())],
        ))
        .await
        .unwrap();

    let response = runtime
        .request(
            RuntimeRequest::CreateVault {
                account_id: account_id.clone(),
                name: "Personal secrets".into(),
                vault_type: CreateVaultType::Personal,
                icon: "lock".into(),
                image_source: None,
            },
            RequestCancellation::new(),
        )
        .await
        .unwrap();

    assert!(matches!(
        response,
        RuntimeResponse::VaultCreationAccepted { .. }
    ));
    let snapshot = runtime.replica().snapshot(&account_id).unwrap();
    assert_eq!(snapshot.operations.len(), 2);
    assert!(snapshot.operations.iter().any(|operation| {
        operation.operation_id == item_operation.operation_id
            && operation.target == item_operation.target
    }));
    assert_eq!(
        snapshot
            .operations
            .iter()
            .filter(|operation| operation.target.item_id() == Some("item-existing"))
            .count(),
        1
    );
}

#[tokio::test]
async fn image_is_published_before_acceptance_and_only_exact_artifact_metadata_survives() {
    let (runtime, account_id, _) = unlocked_runtime().await;
    let artifacts = Arc::new(crate::MemoryVaultImageArtifactStore::default());
    runtime.install_vault_image_ingress(
        crate::VaultImageIngressFacade::new(
            "runtime-1",
            Arc::new(ExactImageSourcePort),
            artifacts.clone(),
        )
        .unwrap(),
    );

    let response = runtime
        .request(
            RuntimeRequest::CreateVault {
                account_id: account_id.clone(),
                name: "Image Vault".into(),
                vault_type: CreateVaultType::Shared,
                icon: "users".into(),
                image_source: Some(VaultImageSourceInput {
                    capability_id: "opaque-image-source".into(),
                    byte_length: 11,
                    content_type: "image/png".into(),
                }),
            },
            RequestCancellation::new(),
        )
        .await
        .unwrap();
    let (operation_id, vault_id) = match response {
        RuntimeResponse::VaultCreationAccepted {
            operation_id,
            vault_id,
            ..
        } => (operation_id, vault_id),
        other => panic!("expected durable image Vault acceptance, got {other:?}"),
    };
    let snapshot = runtime.replica().snapshot(&account_id).unwrap();
    let operation = &snapshot.operations[0];
    assert_eq!(operation.operation_id, operation_id);
    assert!(operation.request.body.is_empty());
    let pending = operation.create_vault.as_ref().unwrap();
    assert_eq!(
        pending.checkpoint,
        crate::replica::CreateVaultCheckpoint::ArtifactReady
    );
    let image = pending.image.as_ref().unwrap();
    assert_eq!(image.byte_length, 11);
    assert_eq!(image.content_type, "image/png");
    assert_eq!(
        image.object_key,
        format!(
            "vaults/user-1/{vault_id}/create/{operation_id}-{}",
            image.sha256
        )
    );
    assert!(!serde_json::to_string(operation)
        .unwrap()
        .contains("opaque-image-source"));
}

pub(super) struct FailingThenExactStaging {
    pub(super) failures_left: AtomicUsize,
    pub(super) calls: Mutex<Vec<&'static str>>,
}

#[async_trait]
impl super::create_vault_staging::CreateVaultStagingPort for FailingThenExactStaging {
    async fn status(
        &self,
        _binding: &super::create_vault_staging::CreateVaultStagingBinding,
    ) -> Result<
        super::create_vault_staging::CreateVaultStagingStatus,
        super::create_vault_staging::CreateVaultStagingError,
    > {
        self.calls.lock().unwrap().push("status");
        Ok(super::create_vault_staging::CreateVaultStagingStatus::AwaitingUpload)
    }

    async fn grant(
        &self,
        binding: &super::create_vault_staging::CreateVaultStagingBinding,
    ) -> Result<
        super::create_vault_staging::CreateVaultUploadGrant,
        super::create_vault_staging::CreateVaultStagingError,
    > {
        self.calls.lock().unwrap().push("grant");
        if self
            .failures_left
            .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |value| {
                value.checked_sub(1)
            })
            .is_ok()
        {
            return Err(super::create_vault_staging::CreateVaultStagingError::Retryable);
        }
        Ok(super::create_vault_staging::CreateVaultUploadGrant::exact(
            binding,
        ))
    }

    async fn upload(
        &self,
        _grant: &super::create_vault_staging::CreateVaultUploadGrant,
        bytes: &[u8],
        _cancellation: RequestCancellation,
    ) -> Result<(), super::create_vault_staging::CreateVaultStagingError> {
        self.calls.lock().unwrap().push("upload");
        assert_eq!(bytes, b"image-bytes");
        Ok(())
    }

    async fn confirm(
        &self,
        _binding: &super::create_vault_staging::CreateVaultStagingBinding,
    ) -> Result<
        super::create_vault_staging::CreateVaultStagingStatus,
        super::create_vault_staging::CreateVaultStagingError,
    > {
        self.calls.lock().unwrap().push("confirm");
        Ok(super::create_vault_staging::CreateVaultStagingStatus::Confirmed)
    }

    async fn renew_session(
        &self,
    ) -> Result<(), super::create_vault_staging::CreateVaultRecoveryError> {
        self.calls.lock().unwrap().push("renew");
        Ok(())
    }
}

#[tokio::test]
async fn staging_retries_beyond_five_then_persists_each_checkpoint_and_freezes_exact_body() {
    let (runtime, account_id, _) = unlocked_runtime().await;
    let artifacts = Arc::new(crate::MemoryVaultImageArtifactStore::default());
    runtime.install_vault_image_ingress(
        crate::VaultImageIngressFacade::new("runtime-1", Arc::new(ExactImageSourcePort), artifacts)
            .unwrap(),
    );
    let response = runtime
        .request(
            RuntimeRequest::CreateVault {
                account_id: account_id.clone(),
                name: "Image Vault".into(),
                vault_type: CreateVaultType::Personal,
                icon: "lock".into(),
                image_source: Some(VaultImageSourceInput {
                    capability_id: "opaque-image-source".into(),
                    byte_length: 11,
                    content_type: "image/png".into(),
                }),
            },
            RequestCancellation::new(),
        )
        .await
        .unwrap();
    let operation_id = match response {
        RuntimeResponse::VaultCreationAccepted { operation_id, .. } => operation_id,
        other => panic!("expected Vault acceptance, got {other:?}"),
    };
    let staging = FailingThenExactStaging {
        failures_left: AtomicUsize::new(6),
        calls: Mutex::new(Vec::new()),
    };

    for attempt in 1..=6 {
        assert_eq!(
            runtime
                .drive_create_vault_staging_cycle(&account_id, &operation_id, &staging)
                .await
                .unwrap(),
            super::create_vault_staging::CreateVaultStagingPass::RetryScheduled
        );
        let operation = runtime
            .replica()
            .snapshot(&account_id)
            .unwrap()
            .operations
            .remove(0);
        assert_eq!(operation.scheduling.attempt_count, attempt);
        assert_eq!(
            operation.create_vault.unwrap().checkpoint,
            crate::replica::CreateVaultCheckpoint::ArtifactReady
        );
    }
    assert_eq!(
        runtime
            .drive_create_vault_staging_cycle(&account_id, &operation_id, &staging)
            .await
            .unwrap(),
        super::create_vault_staging::CreateVaultStagingPass::Progressed
    );
    let operation = runtime
        .replica()
        .snapshot(&account_id)
        .unwrap()
        .operations
        .remove(0);
    assert_eq!(
        operation.create_vault.as_ref().unwrap().checkpoint,
        crate::replica::CreateVaultCheckpoint::RemoteUploadConfirmed
    );
    assert!(operation.request.body.is_empty());

    assert_eq!(
        runtime
            .drive_create_vault_staging_cycle(&account_id, &operation_id, &staging)
            .await
            .unwrap(),
        super::create_vault_staging::CreateVaultStagingPass::DispatchReady
    );
    let operation = runtime
        .replica()
        .snapshot(&account_id)
        .unwrap()
        .operations
        .remove(0);
    assert_eq!(
        operation.create_vault.as_ref().unwrap().checkpoint,
        crate::replica::CreateVaultCheckpoint::FinalRequestFrozen
    );
    let body: serde_json::Value = serde_json::from_slice(&operation.request.body).unwrap();
    assert_eq!(
        body["imageKey"],
        operation.create_vault.unwrap().image.unwrap().object_key
    );
}

#[tokio::test]
async fn image_staging_restarts_between_every_durable_checkpoint_with_identical_bytes() {
    let executor = super::create_tests::create_vault_restart_executor();
    let account_id = AccountId::from("account-1");
    let artifacts = Arc::new(crate::MemoryVaultImageArtifactStore::default());
    let platform = image_platform().await;
    let staging = FailingThenExactStaging {
        failures_left: AtomicUsize::new(0),
        calls: Mutex::new(Vec::new()),
    };

    let first = Runtime::with_serialized_executors(
        executor.clone(),
        platform.clone(),
        Arc::new(super::create_tests::UnusedHttp),
    );
    first.install_vault_image_ingress(
        crate::VaultImageIngressFacade::new(
            "runtime-1",
            Arc::new(ExactImageSourcePort),
            artifacts.clone(),
        )
        .unwrap(),
    );
    first.open().await.unwrap();
    first.replica().load(&account_id).await.unwrap().unwrap();
    first.unlock_account(&account_id).await.unwrap();
    let response = first
        .request(
            RuntimeRequest::CreateVault {
                account_id: account_id.clone(),
                name: "Restarted image Vault".into(),
                vault_type: CreateVaultType::Personal,
                icon: "lock".into(),
                image_source: Some(VaultImageSourceInput {
                    capability_id: "opaque-image-source".into(),
                    byte_length: 11,
                    content_type: "image/png".into(),
                }),
            },
            RequestCancellation::new(),
        )
        .await
        .unwrap();
    let RuntimeResponse::VaultCreationAccepted { operation_id, .. } = response else {
        panic!("expected accepted image create-Vault Operation")
    };
    let artifact_ready = first.replica().snapshot(&account_id).unwrap().operations[0].clone();
    assert_eq!(
        artifact_ready.create_vault.as_ref().unwrap().checkpoint,
        crate::replica::CreateVaultCheckpoint::ArtifactReady
    );
    drop(first);

    let second = Runtime::with_serialized_executors(
        executor.clone(),
        platform.clone(),
        Arc::new(super::create_tests::UnusedHttp),
    );
    second.install_vault_image_ingress(
        crate::VaultImageIngressFacade::new(
            "runtime-1",
            Arc::new(ExactImageSourcePort),
            artifacts.clone(),
        )
        .unwrap(),
    );
    second.open().await.unwrap();
    second.replica().load(&account_id).await.unwrap().unwrap();
    second.unlock_account(&account_id).await.unwrap();
    assert_eq!(
        second.replica().snapshot(&account_id).unwrap().operations[0],
        artifact_ready
    );
    assert_eq!(
        second
            .drive_create_vault_staging_cycle(&account_id, &operation_id, &staging)
            .await
            .unwrap(),
        super::create_vault_staging::CreateVaultStagingPass::Progressed
    );
    let upload_confirmed = second.replica().snapshot(&account_id).unwrap().operations[0].clone();
    assert_eq!(
        upload_confirmed.create_vault.as_ref().unwrap().checkpoint,
        crate::replica::CreateVaultCheckpoint::RemoteUploadConfirmed
    );
    drop(second);

    let third = Runtime::with_serialized_executors(
        executor.clone(),
        platform.clone(),
        Arc::new(super::create_tests::UnusedHttp),
    );
    third.install_vault_image_ingress(
        crate::VaultImageIngressFacade::new(
            "runtime-1",
            Arc::new(ExactImageSourcePort),
            artifacts.clone(),
        )
        .unwrap(),
    );
    third.open().await.unwrap();
    third.replica().load(&account_id).await.unwrap().unwrap();
    third.unlock_account(&account_id).await.unwrap();
    assert_eq!(
        third.replica().snapshot(&account_id).unwrap().operations[0],
        upload_confirmed
    );
    assert_eq!(
        third
            .drive_create_vault_staging_cycle(&account_id, &operation_id, &staging)
            .await
            .unwrap(),
        super::create_vault_staging::CreateVaultStagingPass::DispatchReady
    );
    let request_frozen = third.replica().snapshot(&account_id).unwrap().operations[0].clone();
    assert_eq!(
        request_frozen.create_vault.as_ref().unwrap().checkpoint,
        crate::replica::CreateVaultCheckpoint::FinalRequestFrozen
    );
    assert!(!request_frozen.request.body.is_empty());
    drop(third);

    let fourth = Runtime::with_serialized_executors(
        executor,
        platform.clone(),
        Arc::new(super::create_tests::UnusedHttp),
    );
    fourth.install_vault_image_ingress(
        crate::VaultImageIngressFacade::new("runtime-1", Arc::new(ExactImageSourcePort), artifacts)
            .unwrap(),
    );
    fourth.open().await.unwrap();
    fourth.replica().load(&account_id).await.unwrap().unwrap();
    assert_eq!(
        fourth.replica().snapshot(&account_id).unwrap().operations[0],
        request_frozen
    );
}

struct LostAppliedResponseExecutor {
    committed: AtomicBool,
    authority: Mutex<Option<crate::replica::AuthorityVaultRecord>>,
    put_calls: AtomicUsize,
}

fn tagged_create_vault_outcome(
    operation: &crate::replica::OperationRecord,
    result: crate::server_contract::CreateVaultOperationResult,
) -> super::create_vault_executor::CreateVaultOperationResponse {
    let outcome = crate::server_contract::OperationOutcome::CreateVault {
        operation_id: operation.operation_id.clone(),
        result,
    };
    super::create_vault_executor::CreateVaultOperationResponse {
        status: 200,
        body: serde_json::to_vec(&outcome).unwrap(),
    }
}

fn wire_rejection(
    code: crate::replica::CreateVaultOperationRejectionCode,
) -> crate::server_contract::CreateVaultOperationRejectionCode {
    use crate::replica::CreateVaultOperationRejectionCode as Local;
    use crate::server_contract::CreateVaultOperationRejectionCode as Wire;
    match code {
        Local::VaultIdConflict => Wire::VaultIdConflict,
        Local::TeamMembershipRequired => Wire::TeamMembershipRequired,
        Local::VaultSharingEntitlementDenied => Wire::VaultSharingEntitlementDenied,
        Local::SharedVaultLimitReached => Wire::SharedVaultLimitReached,
    }
}

#[async_trait]
impl super::create_vault_executor::CreateVaultExecutorPort for LostAppliedResponseExecutor {
    async fn lookup(
        &self,
        operation: &crate::replica::OperationRecord,
    ) -> Result<
        Option<super::create_vault_executor::CreateVaultOperationResponse>,
        super::create_vault_staging::CreateVaultStagingError,
    > {
        Ok(self.committed.load(Ordering::SeqCst).then(|| {
            tagged_create_vault_outcome(
                operation,
                crate::server_contract::CreateVaultOperationResult::Applied {
                    vault_id: operation.vault_id().to_owned(),
                },
            )
        }))
    }

    async fn put_exact(
        &self,
        operation: &crate::replica::OperationRecord,
    ) -> Result<
        super::create_vault_executor::CreateVaultOperationResponse,
        super::create_vault_staging::CreateVaultStagingError,
    > {
        self.put_calls.fetch_add(1, Ordering::SeqCst);
        let intent = operation.create_vault.as_ref().unwrap();
        *self.authority.lock().unwrap() = Some(crate::replica::AuthorityVaultRecord {
            id: operation.vault_id().to_owned(),
            name: intent.name.clone(),
            vault_type: crate::replica::AuthorityVaultType::Personal,
            icon: Some(intent.icon.clone()),
            image_url: None,
            encrypted_vault_key: intent.encrypted_vault_key.clone(),
            role: crate::replica::AuthorityVaultRole::Owner,
            key_version: None,
        });
        if !self.committed.swap(true, Ordering::SeqCst) {
            return Err(super::create_vault_staging::CreateVaultStagingError::Retryable);
        }
        Ok(tagged_create_vault_outcome(
            operation,
            crate::server_contract::CreateVaultOperationResult::Applied {
                vault_id: operation.vault_id().to_owned(),
            },
        ))
    }

    async fn renew_session(
        &self,
    ) -> Result<(), super::create_vault_staging::CreateVaultStagingError> {
        Ok(())
    }
}

#[tokio::test]
async fn lost_applied_response_requires_exact_replay_then_receipts_and_requests_current_authority()
{
    let (runtime, account_id, _) = unlocked_runtime().await;
    runtime.seed_ready_personal_vault_in_memory(&account_id);
    let response = runtime
        .request(
            RuntimeRequest::CreateVault {
                account_id: account_id.clone(),
                name: "Recovered Vault".into(),
                vault_type: CreateVaultType::Personal,
                icon: "lock".into(),
                image_source: None,
            },
            RequestCancellation::new(),
        )
        .await
        .unwrap();
    let (operation_id, vault_id) = match response {
        RuntimeResponse::VaultCreationAccepted {
            operation_id,
            vault_id,
            ..
        } => (operation_id, vault_id),
        other => panic!("expected Vault acceptance, got {other:?}"),
    };
    let executor = LostAppliedResponseExecutor {
        committed: AtomicBool::new(false),
        authority: Mutex::new(None),
        put_calls: AtomicUsize::new(0),
    };

    assert_eq!(
        runtime
            .drive_create_vault_executor_cycle(&account_id, &operation_id, &executor)
            .await
            .unwrap(),
        super::create_vault_executor::CreateVaultExecutorPass::RetryScheduled
    );
    assert_eq!(
        runtime
            .replica()
            .snapshot(&account_id)
            .unwrap()
            .operations
            .len(),
        1
    );
    assert_eq!(
        runtime
            .drive_create_vault_executor_cycle(&account_id, &operation_id, &executor)
            .await
            .unwrap(),
        super::create_vault_executor::CreateVaultExecutorPass::Completed
    );
    let snapshot = runtime.replica().snapshot(&account_id).unwrap();
    assert!(snapshot.operations.is_empty());
    assert_eq!(snapshot.receipts.len(), 1);
    assert_eq!(snapshot.receipts[0].operation_id, operation_id);
    assert!(!snapshot
        .bootstrap
        .vaults
        .values()
        .any(|vault| vault.id == vault_id));
    assert_eq!(
        snapshot.bootstrap.state,
        crate::replica::ReplicaState::RefreshRequired
    );
    let server_authority = executor.authority.lock().unwrap();
    assert_eq!(server_authority.as_ref().unwrap().id, vault_id);
    assert_eq!(server_authority.as_ref().unwrap().name, "Recovered Vault");
    assert_eq!(executor.put_calls.load(Ordering::SeqCst), 2);
}

struct RejectedExecutor {
    code: crate::replica::CreateVaultOperationRejectionCode,
}

#[derive(Clone, Copy)]
enum InvalidCreateVaultReplay {
    WrongOperation,
    WrongKind,
    WrongKindAppliedCreate,
    WrongKindAppliedUpdate,
    WrongKindAppliedFavorite,
    WrongKindAppliedTrash,
    WrongKindAppliedRestore,
    WrongKindAppliedMove,
    WrongKindAppliedDelete,
    Malformed,
    ChangedFingerprint,
}

struct MisTaggedExecutor(InvalidCreateVaultReplay);

#[async_trait]
impl super::create_vault_executor::CreateVaultExecutorPort for MisTaggedExecutor {
    async fn lookup(
        &self,
        _operation: &crate::replica::OperationRecord,
    ) -> Result<
        Option<super::create_vault_executor::CreateVaultOperationResponse>,
        super::create_vault_staging::CreateVaultStagingError,
    > {
        Ok(None)
    }

    async fn put_exact(
        &self,
        operation: &crate::replica::OperationRecord,
    ) -> Result<
        super::create_vault_executor::CreateVaultOperationResponse,
        super::create_vault_staging::CreateVaultStagingError,
    > {
        let body = match self.0 {
            InvalidCreateVaultReplay::WrongOperation => serde_json::to_vec(&json!({
                "kind": "create_vault",
                "operationId": "wrong-operation",
                "result": { "status": "rejected", "code": "vault_id_conflict" }
            }))
            .unwrap(),
            InvalidCreateVaultReplay::WrongKind => serde_json::to_vec(&json!({
                "kind": "create_item",
                "operationId": operation.operation_id,
                "result": { "status": "rejected", "code": "vault_access_denied" }
            }))
            .unwrap(),
            InvalidCreateVaultReplay::WrongKindAppliedCreate => {
                wrong_item_outcome("create_item", &operation.operation_id)
            }
            InvalidCreateVaultReplay::WrongKindAppliedUpdate => {
                wrong_item_outcome("update_item", &operation.operation_id)
            }
            InvalidCreateVaultReplay::WrongKindAppliedFavorite => {
                wrong_item_outcome("set_item_favorite", &operation.operation_id)
            }
            InvalidCreateVaultReplay::WrongKindAppliedTrash => {
                wrong_item_outcome("trash_item", &operation.operation_id)
            }
            InvalidCreateVaultReplay::WrongKindAppliedRestore => {
                wrong_item_outcome("restore_item", &operation.operation_id)
            }
            InvalidCreateVaultReplay::WrongKindAppliedMove => {
                wrong_item_outcome("move_item", &operation.operation_id)
            }
            InvalidCreateVaultReplay::WrongKindAppliedDelete => {
                wrong_item_outcome("permanently_delete_item", &operation.operation_id)
            }
            InvalidCreateVaultReplay::Malformed => b"{not-json".to_vec(),
            InvalidCreateVaultReplay::ChangedFingerprint => {
                return Ok(super::create_vault_executor::CreateVaultOperationResponse {
                    status: 422,
                    body: br#"{"code":"OPERATION_ID_REUSED"}"#.to_vec(),
                });
            }
        };
        Ok(super::create_vault_executor::CreateVaultOperationResponse { status: 200, body })
    }

    async fn renew_session(
        &self,
    ) -> Result<(), super::create_vault_staging::CreateVaultStagingError> {
        Ok(())
    }
}

fn wrong_item_outcome(kind: &str, operation_id: &str) -> Vec<u8> {
    serde_json::to_vec(&json!({
        "kind": kind,
        "operationId": operation_id,
        "result": { "status": "applied", "itemId": "foreign-item", "version": 1 }
    }))
    .unwrap()
}

#[tokio::test]
async fn wrong_create_vault_outcome_identity_kind_or_fingerprint_preserves_accepted_work() {
    for replay in [
        InvalidCreateVaultReplay::WrongOperation,
        InvalidCreateVaultReplay::WrongKind,
        InvalidCreateVaultReplay::WrongKindAppliedCreate,
        InvalidCreateVaultReplay::WrongKindAppliedUpdate,
        InvalidCreateVaultReplay::WrongKindAppliedFavorite,
        InvalidCreateVaultReplay::WrongKindAppliedTrash,
        InvalidCreateVaultReplay::WrongKindAppliedRestore,
        InvalidCreateVaultReplay::WrongKindAppliedMove,
        InvalidCreateVaultReplay::WrongKindAppliedDelete,
        InvalidCreateVaultReplay::Malformed,
        InvalidCreateVaultReplay::ChangedFingerprint,
    ] {
        let (runtime, account_id, _) = unlocked_runtime().await;
        runtime.seed_ready_personal_vault_in_memory(&account_id);
        let response = runtime
            .request(
                RuntimeRequest::CreateVault {
                    account_id: account_id.clone(),
                    name: "Tagged Vault".into(),
                    vault_type: CreateVaultType::Personal,
                    icon: "lock".into(),
                    image_source: None,
                },
                RequestCancellation::new(),
            )
            .await
            .unwrap();
        let RuntimeResponse::VaultCreationAccepted { operation_id, .. } = response else {
            panic!("expected accepted create-Vault Operation")
        };
        let before = runtime.replica().snapshot(&account_id).unwrap().operations[0].clone();
        let result = runtime
            .drive_create_vault_executor_cycle(
                &account_id,
                &operation_id,
                &MisTaggedExecutor(replay),
            )
            .await;
        if matches!(replay, InvalidCreateVaultReplay::Malformed) {
            assert_eq!(
                result.unwrap(),
                super::create_vault_executor::CreateVaultExecutorPass::RetryScheduled
            );
        } else {
            assert_eq!(result.unwrap_err().code, RuntimeErrorCode::AccountFailed);
        }
        let after = runtime.replica().snapshot(&account_id).unwrap();
        assert_eq!(after.operations.len(), 1);
        assert_eq!(after.operations[0].operation_id, before.operation_id);
        assert_eq!(after.operations[0].kind, before.kind);
        assert_eq!(after.operations[0].target, before.target);
        assert_eq!(after.operations[0].request, before.request);
        assert_eq!(
            after.operations[0].request_fingerprint,
            before.request_fingerprint
        );
        assert!(after.receipts.is_empty());
    }
}

#[async_trait]
impl super::create_vault_executor::CreateVaultExecutorPort for RejectedExecutor {
    async fn lookup(
        &self,
        _operation: &crate::replica::OperationRecord,
    ) -> Result<
        Option<super::create_vault_executor::CreateVaultOperationResponse>,
        super::create_vault_staging::CreateVaultStagingError,
    > {
        Ok(None)
    }

    async fn put_exact(
        &self,
        operation: &crate::replica::OperationRecord,
    ) -> Result<
        super::create_vault_executor::CreateVaultOperationResponse,
        super::create_vault_staging::CreateVaultStagingError,
    > {
        Ok(tagged_create_vault_outcome(
            operation,
            crate::server_contract::CreateVaultOperationResult::Rejected {
                code: wire_rejection(self.code),
            },
        ))
    }

    async fn renew_session(
        &self,
    ) -> Result<(), super::create_vault_staging::CreateVaultStagingError> {
        Ok(())
    }
}

struct FailingThenExactCleanup {
    failures_left: AtomicUsize,
    calls: AtomicUsize,
}

struct UnauthorizedCleanup {
    unauthorized_left: AtomicUsize,
    calls: AtomicUsize,
    renewals: AtomicUsize,
}

#[async_trait]
impl super::create_vault_cleanup::CreateVaultCleanupPort for UnauthorizedCleanup {
    async fn cleanup_remote(
        &self,
        _binding: &super::create_vault_staging::CreateVaultStagingBinding,
    ) -> Result<(), super::create_vault_staging::CreateVaultStagingError> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        if self
            .unauthorized_left
            .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |value| {
                value.checked_sub(1)
            })
            .is_ok()
        {
            Err(super::create_vault_staging::CreateVaultStagingError::Unauthorized)
        } else {
            Ok(())
        }
    }

    async fn renew_session(
        &self,
    ) -> Result<(), super::create_vault_staging::CreateVaultStagingError> {
        self.renewals.fetch_add(1, Ordering::SeqCst);
        Ok(())
    }
}

#[async_trait]
impl super::create_vault_cleanup::CreateVaultCleanupPort for FailingThenExactCleanup {
    async fn cleanup_remote(
        &self,
        binding: &super::create_vault_staging::CreateVaultStagingBinding,
    ) -> Result<(), super::create_vault_staging::CreateVaultStagingError> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        assert!(binding.object_key.starts_with("vaults/user-1/"));
        assert_eq!(binding.byte_length, 11);
        assert_eq!(binding.content_type, "image/png");
        if self
            .failures_left
            .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |value| {
                value.checked_sub(1)
            })
            .is_ok()
        {
            Err(super::create_vault_staging::CreateVaultStagingError::Retryable)
        } else {
            Ok(())
        }
    }

    async fn renew_session(
        &self,
    ) -> Result<(), super::create_vault_staging::CreateVaultStagingError> {
        Ok(())
    }
}

#[tokio::test]
async fn rejected_image_vault_keeps_durable_local_and_remote_cleanup_until_each_primitive_converges(
) {
    let (runtime, account_id, _) = unlocked_runtime().await;
    runtime.seed_ready_personal_vault_in_memory(&account_id);
    runtime.install_vault_image_ingress(
        crate::VaultImageIngressFacade::new(
            "runtime-1",
            Arc::new(ExactImageSourcePort),
            Arc::new(crate::MemoryVaultImageArtifactStore::default()),
        )
        .unwrap(),
    );
    let response = runtime
        .request(
            RuntimeRequest::CreateVault {
                account_id: account_id.clone(),
                name: "Rejected image Vault".into(),
                vault_type: CreateVaultType::Shared,
                icon: "users".into(),
                image_source: Some(VaultImageSourceInput {
                    capability_id: "opaque-image-source".into(),
                    byte_length: 11,
                    content_type: "image/png".into(),
                }),
            },
            RequestCancellation::new(),
        )
        .await
        .unwrap();
    let operation_id = match response {
        RuntimeResponse::VaultCreationAccepted { operation_id, .. } => operation_id,
        other => panic!("expected Vault acceptance, got {other:?}"),
    };
    let staging = FailingThenExactStaging {
        failures_left: AtomicUsize::new(0),
        calls: Mutex::new(Vec::new()),
    };
    runtime
        .drive_create_vault_staging_cycle(&account_id, &operation_id, &staging)
        .await
        .unwrap();
    runtime
        .drive_create_vault_staging_cycle(&account_id, &operation_id, &staging)
        .await
        .unwrap();
    assert_eq!(
        runtime
            .drive_create_vault_executor_cycle(
                &account_id,
                &operation_id,
                &RejectedExecutor {
                    code:
                        crate::replica::CreateVaultOperationRejectionCode::SharedVaultLimitReached,
                },
            )
            .await
            .unwrap(),
        super::create_vault_executor::CreateVaultExecutorPass::Completed
    );
    let cleanup = runtime.replica().snapshot(&account_id).unwrap().receipts[0]
        .create_vault_cleanup
        .clone()
        .unwrap();
    assert!(cleanup.local_artifact_pending);
    assert!(cleanup.remote_staging_pending);
    let before_remote_first = runtime.replica().snapshot(&account_id).unwrap();
    let error = runtime
        .replica()
        .execute(crate::replica::GuardedCommitPlan::new(
            account_id.clone(),
            before_remote_first.incarnation.clone(),
            before_remote_first.revision,
            before_remote_first.lock_epoch,
            vec![crate::replica::PlanMutation::CompleteCreateVaultCleanup {
                operation_id: operation_id.clone(),
                local_artifact_done: false,
                remote_staging_done: true,
            }],
        ))
        .await
        .unwrap_err();
    assert_eq!(error.code, RuntimeErrorCode::InvariantViolation);
    assert_eq!(
        runtime.replica().snapshot(&account_id).unwrap(),
        before_remote_first
    );

    let port = FailingThenExactCleanup {
        failures_left: AtomicUsize::new(6),
        calls: AtomicUsize::new(0),
    };
    assert_eq!(
        runtime
            .drive_create_vault_cleanup_cycle(&account_id, &operation_id, &port)
            .await
            .unwrap(),
        super::create_vault_cleanup::CreateVaultCleanupPass::Progressed
    );
    let cleanup = runtime.replica().snapshot(&account_id).unwrap().receipts[0]
        .create_vault_cleanup
        .clone()
        .unwrap();
    assert!(!cleanup.local_artifact_pending);
    assert!(cleanup.remote_staging_pending);
    for _ in 0..6 {
        assert_eq!(
            runtime
                .drive_create_vault_cleanup_cycle(&account_id, &operation_id, &port)
                .await
                .unwrap(),
            super::create_vault_cleanup::CreateVaultCleanupPass::RetryScheduled
        );
    }
    assert_eq!(
        runtime
            .drive_create_vault_cleanup_cycle(&account_id, &operation_id, &port)
            .await
            .unwrap(),
        super::create_vault_cleanup::CreateVaultCleanupPass::Completed
    );
    assert!(runtime.replica().snapshot(&account_id).unwrap().receipts[0]
        .create_vault_cleanup
        .is_none());
    assert_eq!(port.calls.load(Ordering::SeqCst), 7);
}

#[tokio::test]
async fn writable_vault_catalog_is_multi_account_authority_only_and_projects_no_keys_or_pending_intent(
) {
    let (runtime, first_account, _) = unlocked_runtime().await;
    runtime.seed_ready_personal_vault_in_memory(&first_account);
    let second_account = AccountId::from("account-2");
    let second_incarnation = Incarnation::from("incarnation-2");
    let installed = runtime
        .replica()
        .install_or_replace(
            second_account.clone(),
            "user-2".into(),
            second_incarnation.clone(),
        )
        .await
        .unwrap();
    runtime.replica().cache(installed);
    runtime.seed_live_master_unlock_key(&second_account, &second_incarnation);
    runtime.seed_unlocked_preparation_account(&second_account);
    runtime.seed_ready_personal_vault_in_memory(&second_account);

    runtime
        .request(
            RuntimeRequest::CreateVault {
                account_id: first_account.clone(),
                name: "Pending must stay hidden".into(),
                vault_type: CreateVaultType::Personal,
                icon: "lock".into(),
                image_source: None,
            },
            RequestCancellation::new(),
        )
        .await
        .unwrap();
    let projection = runtime
        .projection(&ObservationRequest::WritableVaultCatalog)
        .unwrap()
        .projection;
    let RuntimeProjection::WritableVaultCatalog(catalog) = projection else {
        panic!("expected writable Vault catalog")
    };
    assert_eq!(catalog.vaults.len(), 2);
    assert_eq!(catalog.vaults[0].account_id, first_account);
    assert_eq!(catalog.vaults[1].account_id, second_account);
    assert!(!catalog
        .vaults
        .iter()
        .any(|vault| vault.name == "Pending must stay hidden"));
    let json = serde_json::to_string(&catalog).unwrap();
    assert!(!json.contains("encryptedVaultKey"));
    assert!(!json.contains("PendingVaultCreation"));
}

#[tokio::test]
async fn every_closed_create_vault_rejection_is_an_authoritative_receipt_and_never_a_vault() {
    use crate::replica::CreateVaultOperationRejectionCode as Code;
    for code in [
        Code::VaultIdConflict,
        Code::TeamMembershipRequired,
        Code::VaultSharingEntitlementDenied,
        Code::SharedVaultLimitReached,
    ] {
        let (runtime, account_id, _) = unlocked_runtime().await;
        runtime.seed_ready_personal_vault_in_memory(&account_id);
        let authority_before = runtime
            .replica()
            .snapshot(&account_id)
            .unwrap()
            .bootstrap
            .vaults
            .len();
        let response = runtime
            .request(
                RuntimeRequest::CreateVault {
                    account_id: account_id.clone(),
                    name: "Rejected Vault".into(),
                    vault_type: CreateVaultType::Shared,
                    icon: "users".into(),
                    image_source: None,
                },
                RequestCancellation::new(),
            )
            .await
            .unwrap();
        let operation_id = match response {
            RuntimeResponse::VaultCreationAccepted { operation_id, .. } => operation_id,
            other => panic!("expected Vault acceptance, got {other:?}"),
        };
        runtime
            .drive_create_vault_executor_cycle(
                &account_id,
                &operation_id,
                &RejectedExecutor { code },
            )
            .await
            .unwrap();
        let snapshot = runtime.replica().snapshot(&account_id).unwrap();
        assert!(snapshot.operations.is_empty());
        assert_eq!(snapshot.bootstrap.vaults.len(), authority_before);
        assert!(matches!(
            snapshot.receipts[0].result,
            crate::replica::OperationOutcomeResult::VaultRejected { code: actual } if actual == code
        ));
    }
}

#[tokio::test]
async fn accepted_create_vault_restarts_with_identical_bytes_and_outlives_lock_and_sign_out() {
    let executor = super::create_tests::create_vault_restart_executor();
    let account_id = AccountId::from("account-1");
    let first = Runtime::with_serialized_executors(
        executor.clone(),
        operation_fixtures::MemoryPlatform::new(),
        Arc::new(super::create_tests::UnusedHttp),
    );
    first.open().await.unwrap();
    first.replica().load(&account_id).await.unwrap().unwrap();
    first.unlock_account(&account_id).await.unwrap();
    first
        .request(
            RuntimeRequest::CreateVault {
                account_id: account_id.clone(),
                name: "Restart Vault".into(),
                vault_type: CreateVaultType::Personal,
                icon: "lock".into(),
                image_source: None,
            },
            RequestCancellation::new(),
        )
        .await
        .unwrap();
    let accepted = first.replica().snapshot(&account_id).unwrap().operations[0].clone();
    first
        .request(
            RuntimeRequest::Lock {
                account_id: account_id.clone(),
            },
            RequestCancellation::new(),
        )
        .await
        .unwrap();
    first
        .request(
            RuntimeRequest::SignOut {
                account_id: account_id.clone(),
            },
            RequestCancellation::new(),
        )
        .await
        .unwrap();
    assert_eq!(
        first.replica().snapshot(&account_id).unwrap().operations[0],
        accepted
    );
    drop(first);

    let restarted = Runtime::with_serialized_executors(
        executor,
        operation_fixtures::MemoryPlatform::new(),
        Arc::new(super::create_tests::UnusedHttp),
    );
    restarted.open().await.unwrap();
    restarted
        .replica()
        .load(&account_id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        restarted
            .replica()
            .snapshot(&account_id)
            .unwrap()
            .operations[0],
        accepted
    );
}

struct PauseBeforeReconcileExecutor {
    entered: tokio::sync::Notify,
    release: tokio::sync::Notify,
}

#[async_trait]
impl super::create_vault_executor::CreateVaultExecutorPort for PauseBeforeReconcileExecutor {
    async fn lookup(
        &self,
        _operation: &crate::replica::OperationRecord,
    ) -> Result<
        Option<super::create_vault_executor::CreateVaultOperationResponse>,
        super::create_vault_staging::CreateVaultStagingError,
    > {
        Ok(None)
    }
    async fn put_exact(
        &self,
        operation: &crate::replica::OperationRecord,
    ) -> Result<
        super::create_vault_executor::CreateVaultOperationResponse,
        super::create_vault_staging::CreateVaultStagingError,
    > {
        Ok(tagged_create_vault_outcome(
            operation,
            crate::server_contract::CreateVaultOperationResult::Rejected {
                code: crate::server_contract::CreateVaultOperationRejectionCode::VaultIdConflict,
            },
        ))
    }
    async fn renew_session(
        &self,
    ) -> Result<(), super::create_vault_staging::CreateVaultStagingError> {
        Ok(())
    }
    async fn before_reconcile(&self, _operation: &crate::replica::OperationRecord) {
        self.entered.notify_one();
        self.release.notified().await;
    }
}

#[tokio::test]
async fn restart_between_exact_outcome_fetch_and_guarded_commit_replays_and_converges() {
    let persistence = super::create_tests::create_vault_restart_executor();
    let account_id = AccountId::from("account-1");
    let first = Arc::new(Runtime::with_serialized_executors(
        persistence.clone(),
        operation_fixtures::MemoryPlatform::new(),
        Arc::new(super::create_tests::UnusedHttp),
    ));
    first.open().await.unwrap();
    first.replica().load(&account_id).await.unwrap().unwrap();
    first.unlock_account(&account_id).await.unwrap();
    let response = first
        .request(
            RuntimeRequest::CreateVault {
                account_id: account_id.clone(),
                name: "Interrupted outcome".into(),
                vault_type: CreateVaultType::Personal,
                icon: "lock".into(),
                image_source: None,
            },
            RequestCancellation::new(),
        )
        .await
        .unwrap();
    let RuntimeResponse::VaultCreationAccepted { operation_id, .. } = response else {
        panic!("expected accepted create-Vault Operation")
    };
    let port = Arc::new(PauseBeforeReconcileExecutor {
        entered: tokio::sync::Notify::new(),
        release: tokio::sync::Notify::new(),
    });
    let task = tokio::spawn({
        let first = first.clone();
        let account_id = account_id.clone();
        let operation_id = operation_id.clone();
        let port = port.clone();
        async move {
            first
                .drive_create_vault_executor_cycle(&account_id, &operation_id, port.as_ref())
                .await
        }
    });
    port.entered.notified().await;
    task.abort();
    assert!(task.await.unwrap_err().is_cancelled());
    assert_eq!(
        first
            .replica()
            .snapshot(&account_id)
            .unwrap()
            .operations
            .len(),
        1
    );
    drop(first);

    let restarted = Runtime::with_serialized_executors(
        persistence,
        operation_fixtures::MemoryPlatform::new(),
        Arc::new(super::create_tests::UnusedHttp),
    );
    restarted.open().await.unwrap();
    restarted
        .replica()
        .load(&account_id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        restarted
            .drive_create_vault_executor_cycle(
                &account_id,
                &operation_id,
                &RejectedExecutor {
                    code: crate::replica::CreateVaultOperationRejectionCode::VaultIdConflict,
                },
            )
            .await
            .unwrap(),
        super::create_vault_executor::CreateVaultExecutorPass::Completed
    );
    let snapshot = restarted.replica().snapshot(&account_id).unwrap();
    assert!(snapshot.operations.is_empty());
    assert_eq!(snapshot.receipts.len(), 1);
}

#[tokio::test]
async fn cancellation_after_the_guarded_acceptance_never_discards_create_vault_work() {
    let (runtime, account_id, _) = unlocked_runtime().await;
    let cancellation = RequestCancellation::new();
    let cancel_after_commit = cancellation.clone();
    let error = runtime
        .accept_create_vault(
            account_id.clone(),
            "Cancelled caller Vault".into(),
            CreateVaultType::Personal,
            "lock".into(),
            None,
            cancellation,
            move || cancel_after_commit.cancel(),
        )
        .await
        .unwrap_err();
    assert_eq!(error.code, RuntimeErrorCode::Cancelled);
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
async fn committed_image_acceptance_is_published_when_end_cleanup_fails_and_cleanup_retry_cannot_reaccept(
) {
    let (runtime, account_id, _) = unlocked_runtime().await;
    let sources = Arc::new(FailEndOnceImageSourcePort {
        inner: TrackingImageSourcePort::default(),
        failures_left: AtomicUsize::new(1),
    });
    runtime.install_vault_image_ingress(
        crate::VaultImageIngressFacade::new(
            "runtime-1",
            sources.clone(),
            Arc::new(crate::MemoryVaultImageArtifactStore::default()),
        )
        .unwrap(),
    );

    let response = runtime
        .request(
            RuntimeRequest::CreateVault {
                account_id: account_id.clone(),
                name: "Durably accepted image Vault".into(),
                vault_type: CreateVaultType::Personal,
                icon: "lock".into(),
                image_source: Some(VaultImageSourceInput {
                    capability_id: "opaque-image-source".into(),
                    byte_length: 11,
                    content_type: "image/png".into(),
                }),
            },
            RequestCancellation::new(),
        )
        .await
        .expect("end-acceptance cleanup cannot change a committed acceptance result");
    let RuntimeResponse::VaultCreationAccepted { operation_id, .. } = response else {
        panic!("expected accepted create-Vault Operation")
    };
    assert_eq!(
        runtime
            .replica()
            .snapshot(&account_id)
            .unwrap()
            .operations
            .len(),
        1
    );
    assert_eq!(
        runtime.replica().snapshot(&account_id).unwrap().operations[0].operation_id,
        operation_id
    );

    runtime
        .sweep_vault_images_for_snapshot(&runtime.replica().snapshot(&account_id).unwrap())
        .await
        .unwrap();
    assert_eq!(
        runtime
            .replica()
            .snapshot(&account_id)
            .unwrap()
            .operations
            .len(),
        1
    );
    assert_eq!(
        *sources.inner.acceptance.lock().unwrap(),
        vec!["begin", "end", "end"]
    );
}

struct AlwaysUnauthorizedStaging {
    status_calls: AtomicUsize,
    renewals: AtomicUsize,
}

#[async_trait]
impl super::create_vault_staging::CreateVaultStagingPort for AlwaysUnauthorizedStaging {
    async fn status(
        &self,
        _binding: &super::create_vault_staging::CreateVaultStagingBinding,
    ) -> Result<
        super::create_vault_staging::CreateVaultStagingStatus,
        super::create_vault_staging::CreateVaultStagingError,
    > {
        self.status_calls.fetch_add(1, Ordering::SeqCst);
        Err(super::create_vault_staging::CreateVaultStagingError::Unauthorized)
    }
    async fn grant(
        &self,
        _binding: &super::create_vault_staging::CreateVaultStagingBinding,
    ) -> Result<
        super::create_vault_staging::CreateVaultUploadGrant,
        super::create_vault_staging::CreateVaultStagingError,
    > {
        panic!("status never authorized staging")
    }
    async fn upload(
        &self,
        _grant: &super::create_vault_staging::CreateVaultUploadGrant,
        _bytes: &[u8],
        _cancellation: RequestCancellation,
    ) -> Result<(), super::create_vault_staging::CreateVaultStagingError> {
        panic!("status never authorized staging")
    }
    async fn confirm(
        &self,
        _binding: &super::create_vault_staging::CreateVaultStagingBinding,
    ) -> Result<
        super::create_vault_staging::CreateVaultStagingStatus,
        super::create_vault_staging::CreateVaultStagingError,
    > {
        panic!("status never authorized staging")
    }
    async fn renew_session(
        &self,
    ) -> Result<(), super::create_vault_staging::CreateVaultRecoveryError> {
        self.renewals.fetch_add(1, Ordering::SeqCst);
        Ok(())
    }
}

#[tokio::test]
async fn one_staging_cycle_renews_once_and_parks_on_the_second_401_without_losing_work() {
    let (runtime, account_id, _) = unlocked_runtime().await;
    runtime.install_vault_image_ingress(
        crate::VaultImageIngressFacade::new(
            "runtime-1",
            Arc::new(ExactImageSourcePort),
            Arc::new(crate::MemoryVaultImageArtifactStore::default()),
        )
        .unwrap(),
    );
    let response = runtime
        .request(
            RuntimeRequest::CreateVault {
                account_id: account_id.clone(),
                name: "Parked Vault".into(),
                vault_type: CreateVaultType::Personal,
                icon: "lock".into(),
                image_source: Some(VaultImageSourceInput {
                    capability_id: "opaque-image-source".into(),
                    byte_length: 11,
                    content_type: "image/png".into(),
                }),
            },
            RequestCancellation::new(),
        )
        .await
        .unwrap();
    let RuntimeResponse::VaultCreationAccepted { operation_id, .. } = response else {
        panic!("expected Vault acceptance")
    };
    let staging = AlwaysUnauthorizedStaging {
        status_calls: AtomicUsize::new(0),
        renewals: AtomicUsize::new(0),
    };
    assert_eq!(
        runtime
            .drive_create_vault_staging_cycle(&account_id, &operation_id, &staging)
            .await
            .unwrap(),
        super::create_vault_staging::CreateVaultStagingPass::ReauthenticationRequired
    );
    assert_eq!(staging.status_calls.load(Ordering::SeqCst), 2);
    assert_eq!(staging.renewals.load(Ordering::SeqCst), 1);
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

struct RenewThenConfirmStaging {
    status_calls: AtomicUsize,
    renewals: AtomicUsize,
}

#[async_trait]
impl super::create_vault_staging::CreateVaultStagingPort for RenewThenConfirmStaging {
    async fn status(
        &self,
        _binding: &super::create_vault_staging::CreateVaultStagingBinding,
    ) -> Result<
        super::create_vault_staging::CreateVaultStagingStatus,
        super::create_vault_staging::CreateVaultStagingError,
    > {
        if self.status_calls.fetch_add(1, Ordering::SeqCst) == 0 {
            Err(super::create_vault_staging::CreateVaultStagingError::Unauthorized)
        } else {
            Ok(super::create_vault_staging::CreateVaultStagingStatus::Confirmed)
        }
    }
    async fn grant(
        &self,
        _binding: &super::create_vault_staging::CreateVaultStagingBinding,
    ) -> Result<
        super::create_vault_staging::CreateVaultUploadGrant,
        super::create_vault_staging::CreateVaultStagingError,
    > {
        panic!("confirmed staging does not issue a grant")
    }
    async fn upload(
        &self,
        _grant: &super::create_vault_staging::CreateVaultUploadGrant,
        _bytes: &[u8],
        _cancellation: RequestCancellation,
    ) -> Result<(), super::create_vault_staging::CreateVaultStagingError> {
        panic!("confirmed staging does not upload")
    }
    async fn confirm(
        &self,
        _binding: &super::create_vault_staging::CreateVaultStagingBinding,
    ) -> Result<
        super::create_vault_staging::CreateVaultStagingStatus,
        super::create_vault_staging::CreateVaultStagingError,
    > {
        panic!("confirmed staging does not reconfirm")
    }
    async fn renew_session(
        &self,
    ) -> Result<(), super::create_vault_staging::CreateVaultRecoveryError> {
        self.renewals.fetch_add(1, Ordering::SeqCst);
        Ok(())
    }
}

struct UnauthorizedLookupExecutor {
    lookups: AtomicUsize,
    renewals: AtomicUsize,
}

#[async_trait]
impl super::create_vault_executor::CreateVaultExecutorPort for UnauthorizedLookupExecutor {
    async fn lookup(
        &self,
        _operation: &crate::replica::OperationRecord,
    ) -> Result<
        Option<super::create_vault_executor::CreateVaultOperationResponse>,
        super::create_vault_staging::CreateVaultStagingError,
    > {
        self.lookups.fetch_add(1, Ordering::SeqCst);
        Err(super::create_vault_staging::CreateVaultStagingError::Unauthorized)
    }
    async fn put_exact(
        &self,
        _operation: &crate::replica::OperationRecord,
    ) -> Result<
        super::create_vault_executor::CreateVaultOperationResponse,
        super::create_vault_staging::CreateVaultStagingError,
    > {
        panic!("second 401 parks before PUT")
    }
    async fn renew_session(
        &self,
    ) -> Result<(), super::create_vault_staging::CreateVaultStagingError> {
        self.renewals.fetch_add(1, Ordering::SeqCst);
        Ok(())
    }
}

#[tokio::test]
async fn one_renewal_budget_spans_staging_and_final_recovery_exchanges() {
    let (runtime, account_id, _) = unlocked_runtime().await;
    runtime.install_vault_image_ingress(
        crate::VaultImageIngressFacade::new(
            "runtime-1",
            Arc::new(ExactImageSourcePort),
            Arc::new(crate::MemoryVaultImageArtifactStore::default()),
        )
        .unwrap(),
    );
    let response = runtime
        .request(
            RuntimeRequest::CreateVault {
                account_id: account_id.clone(),
                name: "Shared renewal".into(),
                vault_type: CreateVaultType::Personal,
                icon: "lock".into(),
                image_source: Some(VaultImageSourceInput {
                    capability_id: "opaque-image-source".into(),
                    byte_length: 11,
                    content_type: "image/png".into(),
                }),
            },
            RequestCancellation::new(),
        )
        .await
        .unwrap();
    let RuntimeResponse::VaultCreationAccepted { operation_id, .. } = response else {
        panic!("expected accepted create-Vault Operation")
    };
    let staging = RenewThenConfirmStaging {
        status_calls: AtomicUsize::new(0),
        renewals: AtomicUsize::new(0),
    };
    let executor = UnauthorizedLookupExecutor {
        lookups: AtomicUsize::new(0),
        renewals: AtomicUsize::new(0),
    };
    assert_eq!(
        runtime
            .drive_create_vault_recovery_cycle(&account_id, &operation_id, &staging, &executor,)
            .await
            .unwrap(),
        super::create_vault_executor::CreateVaultExecutorPass::ReauthenticationRequired
    );
    assert_eq!(staging.renewals.load(Ordering::SeqCst), 1);
    assert_eq!(executor.renewals.load(Ordering::SeqCst), 0);
    assert_eq!(executor.lookups.load(Ordering::SeqCst), 1);
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

struct RecoveryExchangeMatrixPort {
    target: &'static str,
    failures_left: AtomicUsize,
    unauthorized: bool,
    renewals: AtomicUsize,
    accepted: Mutex<Option<(String, String, String)>>,
    race_at: Option<&'static str>,
    race_context: Mutex<Option<(Arc<Runtime>, AccountId)>>,
    raced: AtomicBool,
}

impl RecoveryExchangeMatrixPort {
    fn maybe_fail(
        &self,
        exchange: &'static str,
    ) -> Result<(), super::create_vault_staging::CreateVaultStagingError> {
        if self.target == exchange
            && self
                .failures_left
                .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |value| {
                    value.checked_sub(1)
                })
                .is_ok()
        {
            return Err(if self.unauthorized {
                super::create_vault_staging::CreateVaultStagingError::Unauthorized
            } else {
                super::create_vault_staging::CreateVaultStagingError::Retryable
            });
        }
        Ok(())
    }

    async fn race_guard(&self, exchange: &'static str) {
        if self.race_at != Some(exchange) || self.raced.swap(true, Ordering::SeqCst) {
            return;
        }
        let (runtime, account_id) = self.race_context.lock().unwrap().clone().unwrap();
        let snapshot = runtime.replica().snapshot(&account_id).unwrap();
        let mut operation = snapshot.operations[0].clone();
        operation.scheduling.attempt_count += 1;
        let result = runtime
            .replica()
            .execute(crate::replica::GuardedCommitPlan::new(
                account_id,
                snapshot.incarnation,
                snapshot.revision,
                snapshot.lock_epoch,
                vec![crate::replica::PlanMutation::RescheduleOperation(operation)],
            ))
            .await
            .unwrap();
        assert!(matches!(result, crate::replica::PlanResult::Applied { .. }));
    }
}

#[async_trait]
impl super::create_vault_staging::CreateVaultStagingPort for RecoveryExchangeMatrixPort {
    async fn status(
        &self,
        _binding: &super::create_vault_staging::CreateVaultStagingBinding,
    ) -> Result<
        super::create_vault_staging::CreateVaultStagingStatus,
        super::create_vault_staging::CreateVaultStagingError,
    > {
        self.maybe_fail("status")?;
        Ok(super::create_vault_staging::CreateVaultStagingStatus::AwaitingUpload)
    }
    async fn grant(
        &self,
        binding: &super::create_vault_staging::CreateVaultStagingBinding,
    ) -> Result<
        super::create_vault_staging::CreateVaultUploadGrant,
        super::create_vault_staging::CreateVaultStagingError,
    > {
        self.maybe_fail("grant")?;
        Ok(super::create_vault_staging::CreateVaultUploadGrant::exact(
            binding,
        ))
    }
    async fn upload(
        &self,
        _grant: &super::create_vault_staging::CreateVaultUploadGrant,
        bytes: &[u8],
        _cancellation: RequestCancellation,
    ) -> Result<(), super::create_vault_staging::CreateVaultStagingError> {
        self.maybe_fail("upload")?;
        assert_eq!(bytes, b"image-bytes");
        Ok(())
    }
    async fn confirm(
        &self,
        _binding: &super::create_vault_staging::CreateVaultStagingBinding,
    ) -> Result<
        super::create_vault_staging::CreateVaultStagingStatus,
        super::create_vault_staging::CreateVaultStagingError,
    > {
        self.maybe_fail("confirm")?;
        self.race_guard("checkpoint").await;
        Ok(super::create_vault_staging::CreateVaultStagingStatus::Confirmed)
    }
    async fn renew_session(
        &self,
    ) -> Result<(), super::create_vault_staging::CreateVaultRecoveryError> {
        self.renewals.fetch_add(1, Ordering::SeqCst);
        Ok(())
    }
}

#[async_trait]
impl super::create_vault_executor::CreateVaultExecutorPort for RecoveryExchangeMatrixPort {
    async fn lookup(
        &self,
        _operation: &crate::replica::OperationRecord,
    ) -> Result<
        Option<super::create_vault_executor::CreateVaultOperationResponse>,
        super::create_vault_staging::CreateVaultStagingError,
    > {
        self.maybe_fail("lookup")?;
        Ok(None)
    }
    async fn put_exact(
        &self,
        operation: &crate::replica::OperationRecord,
    ) -> Result<
        super::create_vault_executor::CreateVaultOperationResponse,
        super::create_vault_staging::CreateVaultStagingError,
    > {
        self.maybe_fail("put")?;
        let intent = operation.create_vault.as_ref().unwrap();
        *self.accepted.lock().unwrap() = Some((
            operation.vault_id().to_owned(),
            intent.encrypted_vault_key.clone(),
            intent.name.clone(),
        ));
        Ok(tagged_create_vault_outcome(
            operation,
            crate::server_contract::CreateVaultOperationResult::Applied {
                vault_id: operation.vault_id().to_owned(),
            },
        ))
    }
    async fn before_reconcile(&self, _operation: &crate::replica::OperationRecord) {
        self.race_guard("final_commit").await;
    }
    async fn renew_session(
        &self,
    ) -> Result<(), super::create_vault_staging::CreateVaultStagingError> {
        self.renewals.fetch_add(1, Ordering::SeqCst);
        Ok(())
    }
}

async fn matrix_recovery(
    target: &'static str,
    failures: usize,
    unauthorized: bool,
) -> (Arc<Runtime>, AccountId, String, RecoveryExchangeMatrixPort) {
    let (runtime, account_id, _) = unlocked_runtime().await;
    runtime.seed_ready_personal_vault_in_memory(&account_id);
    runtime.install_vault_image_ingress(
        crate::VaultImageIngressFacade::new(
            "runtime-1",
            Arc::new(ExactImageSourcePort),
            Arc::new(crate::MemoryVaultImageArtifactStore::default()),
        )
        .unwrap(),
    );
    let response = runtime
        .request(
            RuntimeRequest::CreateVault {
                account_id: account_id.clone(),
                name: "Matrix Vault".into(),
                vault_type: CreateVaultType::Personal,
                icon: "lock".into(),
                image_source: Some(VaultImageSourceInput {
                    capability_id: "opaque-image-source".into(),
                    byte_length: 11,
                    content_type: "image/png".into(),
                }),
            },
            RequestCancellation::new(),
        )
        .await
        .unwrap();
    let RuntimeResponse::VaultCreationAccepted { operation_id, .. } = response else {
        panic!("expected accepted create-Vault Operation")
    };
    (
        runtime,
        account_id,
        operation_id,
        RecoveryExchangeMatrixPort {
            target,
            failures_left: AtomicUsize::new(failures),
            unauthorized,
            renewals: AtomicUsize::new(0),
            accepted: Mutex::new(None),
            race_at: None,
            race_context: Mutex::new(None),
            raced: AtomicBool::new(false),
        },
    )
}

#[tokio::test]
async fn real_guard_races_at_checkpoint_and_final_commit_preserve_work() {
    for race_at in ["checkpoint", "final_commit"] {
        let (runtime, account_id, operation_id, mut port) = matrix_recovery("none", 0, false).await;
        port.race_at = Some(race_at);
        *port.race_context.lock().unwrap() = Some((runtime.clone(), account_id.clone()));
        assert!(
            matches!(
                runtime
                    .drive_create_vault_recovery_cycle(&account_id, &operation_id, &port, &port,)
                    .await,
                Err(super::create_vault_staging::CreateVaultRecoveryError::ParkedFenced)
            ),
            "{race_at}"
        );
        let snapshot = runtime.replica().snapshot(&account_id).unwrap();
        assert_eq!(snapshot.operations.len(), 1, "{race_at}");
        assert!(snapshot.receipts.is_empty(), "{race_at}");
        assert_eq!(
            snapshot.operations[0].scheduling.attempt_count, 1,
            "{race_at}"
        );
    }
}

#[tokio::test]
async fn every_recovery_exchange_survives_more_than_five_failures_without_discarding_work() {
    for exchange in ["status", "grant", "upload", "confirm", "lookup", "put"] {
        let (runtime, account_id, operation_id, port) = matrix_recovery(exchange, 6, false).await;
        for _ in 0..6 {
            assert_eq!(
                runtime
                    .drive_create_vault_recovery_cycle(&account_id, &operation_id, &port, &port)
                    .await
                    .unwrap(),
                super::create_vault_executor::CreateVaultExecutorPass::RetryScheduled,
                "{exchange}"
            );
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
        assert_eq!(
            runtime
                .drive_create_vault_recovery_cycle(&account_id, &operation_id, &port, &port)
                .await
                .unwrap(),
            super::create_vault_executor::CreateVaultExecutorPass::Completed,
            "{exchange}"
        );
    }
}

#[tokio::test]
async fn every_recovery_exchange_renews_once_on_first_401_and_parks_on_second_401() {
    for exchange in ["status", "grant", "upload", "confirm", "lookup", "put"] {
        let (runtime, account_id, operation_id, port) = matrix_recovery(exchange, 1, true).await;
        assert_eq!(
            runtime
                .drive_create_vault_recovery_cycle(&account_id, &operation_id, &port, &port)
                .await
                .unwrap(),
            super::create_vault_executor::CreateVaultExecutorPass::Completed,
            "first 401 at {exchange}"
        );
        assert_eq!(port.renewals.load(Ordering::SeqCst), 1, "{exchange}");

        let (runtime, account_id, operation_id, port) = matrix_recovery(exchange, 2, true).await;
        assert_eq!(
            runtime
                .drive_create_vault_recovery_cycle(&account_id, &operation_id, &port, &port)
                .await
                .unwrap(),
            super::create_vault_executor::CreateVaultExecutorPass::ReauthenticationRequired,
            "second 401 at {exchange}"
        );
        assert_eq!(port.renewals.load(Ordering::SeqCst), 1, "{exchange}");
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
async fn a_lock_epoch_fence_at_create_vault_commit_accepts_no_work() {
    let runtime = Runtime::with_serialized_executors(
        super::create_tests::create_vault_fenced_executor(),
        image_platform().await,
        Arc::new(super::create_tests::UnusedHttp),
    );
    runtime.open().await.unwrap();
    let account_id = AccountId::from("account-1");
    runtime.replica().load(&account_id).await.unwrap().unwrap();
    runtime.unlock_account(&account_id).await.unwrap();
    let error = runtime
        .request(
            RuntimeRequest::CreateVault {
                account_id: account_id.clone(),
                name: "Fenced Vault".into(),
                vault_type: CreateVaultType::Personal,
                icon: "lock".into(),
                image_source: None,
            },
            RequestCancellation::new(),
        )
        .await
        .unwrap_err();
    assert_eq!(error.code, RuntimeErrorCode::AuthenticationRequired);
    assert!(runtime
        .replica()
        .snapshot(&account_id)
        .unwrap()
        .operations
        .is_empty());
}

#[tokio::test]
async fn published_artifact_is_ended_and_deleted_when_guarded_acceptance_commit_fails() {
    let runtime = Runtime::with_serialized_executors(
        super::create_tests::create_vault_failing_executor(),
        image_platform().await,
        Arc::new(super::create_tests::UnusedHttp),
    );
    runtime.open().await.unwrap();
    let account_id = AccountId::from("account-1");
    runtime.replica().load(&account_id).await.unwrap().unwrap();
    runtime.unlock_account(&account_id).await.unwrap();
    let sources = Arc::new(TrackingImageSourcePort::default());
    let artifacts = Arc::new(crate::MemoryVaultImageArtifactStore::default());
    runtime.install_vault_image_ingress(
        crate::VaultImageIngressFacade::new("runtime-1", sources.clone(), artifacts.clone())
            .unwrap(),
    );
    let error = runtime
        .request(
            RuntimeRequest::CreateVault {
                account_id: account_id.clone(),
                name: "Failed acceptance".into(),
                vault_type: CreateVaultType::Personal,
                icon: "lock".into(),
                image_source: Some(VaultImageSourceInput {
                    capability_id: "opaque-image-source".into(),
                    byte_length: 11,
                    content_type: "image/png".into(),
                }),
            },
            RequestCancellation::new(),
        )
        .await
        .unwrap_err();
    assert_eq!(error.code, RuntimeErrorCode::InvariantViolation);
    assert!(runtime
        .replica()
        .snapshot(&account_id)
        .unwrap()
        .operations
        .is_empty());
    assert_eq!(*sources.acceptance.lock().unwrap(), vec!["begin", "end"]);
    let (operation_id, _) = sources.scope.lock().unwrap().clone().unwrap();
    let family = crate::VaultImageArtifactScope::new(account_id, operation_id).unwrap();
    assert!(
        artifacts
            .read_generation(&family, None)
            .await
            .unwrap()
            .is_none(),
        "failed acceptance must remove the actual protected publication"
    );
}

#[tokio::test]
async fn begin_acceptance_and_immediate_delete_failure_leave_only_a_startup_sweepable_orphan() {
    let (runtime, account_id, _) = unlocked_runtime().await;
    let sources = Arc::new(TrackingImageSourcePort::default());
    sources.fail_begin.store(true, Ordering::SeqCst);
    let artifacts = Arc::new(FailDeleteArtifactPort::default());
    artifacts.fail_delete.store(true, Ordering::SeqCst);
    let facade =
        crate::VaultImageIngressFacade::new("runtime-1", sources.clone(), artifacts.clone())
            .unwrap();
    runtime.install_vault_image_ingress(facade.clone());

    assert_eq!(
        runtime
            .request(
                RuntimeRequest::CreateVault {
                    account_id: account_id.clone(),
                    name: "Preaccept cleanup".into(),
                    vault_type: CreateVaultType::Personal,
                    icon: "lock".into(),
                    image_source: Some(VaultImageSourceInput {
                        capability_id: "opaque-image-source".into(),
                        byte_length: 11,
                        content_type: "image/png".into(),
                    }),
                },
                RequestCancellation::new(),
            )
            .await
            .unwrap_err()
            .code,
        RuntimeErrorCode::SourceFailure
    );
    assert!(runtime
        .replica()
        .snapshot(&account_id)
        .unwrap()
        .operations
        .is_empty());
    assert_eq!(artifacts.delete_calls.load(Ordering::SeqCst), 1);
    let (operation_id, vault_id) = sources.scope.lock().unwrap().clone().unwrap();
    let family = crate::VaultImageArtifactScope::new(account_id.clone(), operation_id).unwrap();
    let metadata = artifacts
        .inner
        .read_generation(&family, None)
        .await
        .unwrap()
        .unwrap()
        .metadata
        .unwrap();
    assert_eq!(metadata.vault_id(), vault_id);
    assert_eq!(metadata.byte_length(), 11);
    assert_eq!(metadata.content_type(), "image/png");
    assert_eq!(
        metadata.sha256(),
        format!("{:x}", Sha256::digest(b"image-bytes"))
    );
    assert!(metadata.protection().is_some());
    assert_ne!(
        artifacts.inner.read_all(&metadata).await.unwrap(),
        b"image-bytes"
    );

    facade
        .sweep_account(&account_id, &HashSet::new())
        .await
        .unwrap();
    assert!(artifacts.inner.read_all(&metadata).await.is_err());
}

#[tokio::test]
async fn fenced_acceptance_and_delete_failure_leave_a_sweepable_orphan_without_an_operation() {
    let runtime = Runtime::with_serialized_executors(
        super::create_tests::create_vault_fenced_executor(),
        image_platform().await,
        Arc::new(super::create_tests::UnusedHttp),
    );
    runtime.open().await.unwrap();
    let account_id = AccountId::from("account-1");
    runtime.replica().load(&account_id).await.unwrap().unwrap();
    runtime.unlock_account(&account_id).await.unwrap();
    let sources = Arc::new(TrackingImageSourcePort::default());
    let artifacts = Arc::new(FailDeleteArtifactPort::default());
    artifacts.fail_delete.store(true, Ordering::SeqCst);
    let facade =
        crate::VaultImageIngressFacade::new("runtime-1", sources.clone(), artifacts.clone())
            .unwrap();
    runtime.install_vault_image_ingress(facade.clone());

    assert_eq!(
        runtime
            .request(
                RuntimeRequest::CreateVault {
                    account_id: account_id.clone(),
                    name: "Fenced image acceptance".into(),
                    vault_type: CreateVaultType::Personal,
                    icon: "lock".into(),
                    image_source: Some(VaultImageSourceInput {
                        capability_id: "opaque-image-source".into(),
                        byte_length: 11,
                        content_type: "image/png".into(),
                    }),
                },
                RequestCancellation::new(),
            )
            .await
            .unwrap_err()
            .code,
        RuntimeErrorCode::AuthenticationRequired
    );
    assert!(runtime
        .replica()
        .snapshot(&account_id)
        .unwrap()
        .operations
        .is_empty());
    assert_eq!(*sources.acceptance.lock().unwrap(), vec!["begin", "end"]);
    assert_eq!(artifacts.delete_calls.load(Ordering::SeqCst), 1);
    let (operation_id, vault_id) = sources.scope.lock().unwrap().clone().unwrap();
    let family = crate::VaultImageArtifactScope::new(account_id.clone(), operation_id).unwrap();
    let metadata = artifacts
        .inner
        .read_generation(&family, None)
        .await
        .unwrap()
        .unwrap()
        .metadata
        .unwrap();
    assert_eq!(metadata.vault_id(), vault_id);
    assert_eq!(metadata.byte_length(), 11);
    assert_eq!(metadata.content_type(), "image/png");
    assert_eq!(
        metadata.sha256(),
        format!("{:x}", Sha256::digest(b"image-bytes"))
    );
    assert!(metadata.protection().is_some());
    assert_ne!(
        artifacts.inner.read_all(&metadata).await.unwrap(),
        b"image-bytes"
    );

    facade
        .sweep_account(&account_id, &HashSet::new())
        .await
        .unwrap();
    assert!(artifacts.inner.read_all(&metadata).await.is_err());
}

pub(super) async fn seed_rejected_image_cleanup(
    persistence: &crate::replica::InMemoryReplica,
    operation_id: &str,
) -> crate::replica::OperationRecord {
    seed_image_cleanup(persistence, operation_id, true).await
}

pub(super) async fn seed_image_cleanup(
    persistence: &crate::replica::InMemoryReplica,
    operation_id: &str,
    reconcile_rejection: bool,
) -> crate::replica::OperationRecord {
    use crate::http_transport::{HttpHeader, HttpMethod};
    use crate::replica::{
        CreateVaultCheckpoint, CreateVaultImageRecord, CreateVaultOperationRecord,
        CreateVaultOperationRejectionCode, GuardedCommitPlan, ImmutableHttpRequest,
        ObservedOutcome, OperationKind, OperationOutcomeResult, OperationRecord,
        OperationSchedulingState, PlanMutation, PlanResult,
    };
    let account_id = AccountId::from("account-1");
    let image_sha256 = format!("{:x}", Sha256::digest(b"image-bytes"));
    let mut operation = OperationRecord {
        operation_id: operation_id.into(),
        kind: OperationKind::CreateVault,
        target: crate::replica::ResourceRef::Vault {
            vault_id: "vault-cleanup".into(),
        },
        request: ImmutableHttpRequest {
            method: HttpMethod::Put,
            path: "/api/v1/vaults/vault-cleanup".into(),
            headers: vec![HttpHeader {
                name: "Content-Type".into(),
                value: "application/json".into(),
            }],
            body: Vec::new(),
        },
        request_fingerprint: crate::replica::Sha256Fingerprint([0; 32]),
        accepted_item_category: None,
        attachment_move_recovery: None,
        update_vault: None,
        create_vault: Some(CreateVaultOperationRecord {
            account_id: account_id.clone(),
            name: "Rejected image".into(),
            vault_type: CreateVaultType::Personal,
            icon: "lock".into(),
            encrypted_vault_key: "wrapped".into(),
            image: Some(CreateVaultImageRecord {
                protected_witness: None,
                raw_cleanup_pending: false,
                byte_length: 11,
                content_type: "image/png".into(),
                sha256: image_sha256.clone(),
                object_key: format!(
                    "vaults/user-1/vault-cleanup/create/{operation_id}-{}",
                    image_sha256
                ),
            }),
            checkpoint: CreateVaultCheckpoint::FinalRequestFrozen,
        }),
        scheduling: OperationSchedulingState::default(),
        legacy_admission: None,
    };
    let (request, fingerprint) = super::create_vault::create_vault_http_request(
        operation.vault_id(),
        operation.create_vault.as_ref().unwrap(),
    )
    .unwrap();
    operation.request = request;
    operation.request_fingerprint = fingerprint;
    assert!(matches!(
        persistence
            .execute(GuardedCommitPlan::new(
                account_id.clone(),
                Incarnation::from("incarnation-1"),
                0,
                0,
                vec![PlanMutation::AcceptOperation(operation.clone())],
            ))
            .unwrap(),
        PlanResult::Applied { .. }
    ));
    if reconcile_rejection {
        assert!(matches!(
            persistence
                .execute(GuardedCommitPlan::new(
                    account_id,
                    Incarnation::from("incarnation-1"),
                    1,
                    0,
                    vec![PlanMutation::ReconcileCreateVault {
                        outcome: ObservedOutcome {
                            operation_id: operation_id.into(),
                            request_fingerprint: fingerprint,
                            result: OperationOutcomeResult::VaultRejected {
                                code: CreateVaultOperationRejectionCode::VaultIdConflict,
                            },
                        },
                        vault: None,
                    }],
                ))
                .unwrap(),
            PlanResult::Applied { .. }
        ));
    }
    operation
}

struct ExactTeardownCleanup {
    unauthorized_left: AtomicUsize,
    renewal_fails: bool,
    calls: Mutex<Vec<super::create_vault_staging::CreateVaultStagingBinding>>,
    renewals: AtomicUsize,
}

#[async_trait]
impl super::create_vault_cleanup::CreateVaultCleanupPort for ExactTeardownCleanup {
    async fn cleanup_remote(
        &self,
        binding: &super::create_vault_staging::CreateVaultStagingBinding,
    ) -> Result<(), super::create_vault_staging::CreateVaultStagingError> {
        self.calls.lock().unwrap().push(binding.clone());
        if self
            .unauthorized_left
            .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |left| {
                left.checked_sub(1)
            })
            .is_ok()
        {
            Err(super::create_vault_staging::CreateVaultStagingError::Unauthorized)
        } else {
            Ok(())
        }
    }

    async fn renew_session(
        &self,
    ) -> Result<(), super::create_vault_staging::CreateVaultStagingError> {
        self.renewals.fetch_add(1, Ordering::SeqCst);
        if self.renewal_fails {
            Err(super::create_vault_staging::CreateVaultStagingError::Retryable)
        } else {
            Ok(())
        }
    }
}

#[tokio::test]
async fn a_retained_receipt_prevents_the_same_operation_cleanup_from_coexisting() {
    use crate::replica::{GuardedCommitPlan, PlanMutation};
    let (_, persistence, _) = super::teardown_tests::create_vault_teardown_harness();
    let operation = seed_rejected_image_cleanup(&persistence, "cleanup-overlap").await;
    let account_id = AccountId::from("account-1");
    let snapshot = persistence.snapshot(&account_id).unwrap();
    let error = persistence
        .execute(GuardedCommitPlan::new(
            account_id,
            snapshot.incarnation,
            snapshot.revision,
            snapshot.lock_epoch,
            vec![PlanMutation::AcceptOperation(operation)],
        ))
        .unwrap_err();
    assert_eq!(error.code, RuntimeErrorCode::InvariantViolation);
    assert_eq!(
        error.message, "completed Operation identity was reused",
        "the defensive teardown dedup cannot hide a loadable Operation/receipt overlap"
    );
}

#[tokio::test]
async fn remove_and_wipe_retry_operation_and_receipt_cleanup_after_one_401_and_destroy_local_state_unconditionally(
) {
    for wipe in [false, true] {
        for receipt_backed in [false, true] {
            for (unauthorized, renewal_fails, expected_calls) in
                [(1, false, 2), (2, false, 2), (1, true, 1)]
            {
                let (runtime, persistence, _) =
                    super::teardown_tests::create_vault_teardown_harness();
                let operation_id = format!(
                    "{}-{}-cleanup-{unauthorized}-{}",
                    if wipe { "wipe" } else { "remove" },
                    if receipt_backed {
                        "receipt"
                    } else {
                        "operation"
                    },
                    if renewal_fails {
                        "unrenewable"
                    } else {
                        "renewable"
                    }
                );
                let operation =
                    seed_image_cleanup(&persistence, &operation_id, receipt_backed).await;
                let account_id = AccountId::from("account-1");
                let before = persistence.snapshot(&account_id).unwrap();
                assert_eq!(before.operations.len(), usize::from(!receipt_backed));
                assert_eq!(before.receipts.len(), usize::from(receipt_backed));
                if receipt_backed {
                    let cleanup = before.receipts[0].create_vault_cleanup.as_ref().unwrap();
                    assert!(cleanup.local_artifact_pending);
                    assert!(cleanup.remote_staging_pending);
                } else {
                    assert_eq!(
                        before.operations[0]
                            .create_vault
                            .as_ref()
                            .unwrap()
                            .checkpoint,
                        crate::replica::CreateVaultCheckpoint::FinalRequestFrozen
                    );
                }
                runtime.replica().load(&account_id).await.unwrap().unwrap();

                let image = operation
                    .create_vault
                    .as_ref()
                    .unwrap()
                    .image
                    .as_ref()
                    .unwrap();
                let metadata = crate::VaultImageArtifactMetadata::new(
                    crate::VaultImageArtifactScope::new(account_id.clone(), &operation_id).unwrap(),
                    operation.vault_id(),
                    image.byte_length,
                    &image.content_type,
                    &image.sha256,
                )
                .unwrap();
                let artifacts = Arc::new(crate::MemoryVaultImageArtifactStore::default());
                crate::VaultImageArtifactPort::begin(artifacts.as_ref(), metadata.scope())
                    .await
                    .unwrap();
                crate::VaultImageArtifactPort::write_chunk(
                    artifacts.as_ref(),
                    metadata.scope(),
                    0,
                    b"image-bytes",
                )
                .await
                .unwrap();
                crate::VaultImageArtifactPort::publish(artifacts.as_ref(), &metadata)
                    .await
                    .unwrap();
                runtime.install_vault_image_ingress(
                    crate::VaultImageIngressFacade::new(
                        "runtime-1",
                        Arc::new(ExactImageSourcePort),
                        artifacts.clone(),
                    )
                    .unwrap(),
                );

                let remote = Arc::new(ExactTeardownCleanup {
                    unauthorized_left: AtomicUsize::new(unauthorized),
                    renewal_fails,
                    calls: Mutex::new(Vec::new()),
                    renewals: AtomicUsize::new(0),
                });
                runtime.install_create_vault_cleanup_port(remote.clone());
                let request = if wipe {
                    RuntimeRequest::Wipe
                } else {
                    RuntimeRequest::RemoveAccount {
                        account_id: account_id.clone(),
                    }
                };
                let RuntimeResponse::Teardown {
                    status, failures, ..
                } = runtime
                    .request(request, RequestCancellation::new())
                    .await
                    .unwrap()
                else {
                    panic!("expected teardown response")
                };

                assert_eq!(status, TeardownStatus::Complete);
                assert!(failures.is_empty());
                assert!(persistence.snapshot(&account_id).is_none());
                assert!(artifacts.read_all(&metadata).await.is_err());
                assert_eq!(remote.renewals.load(Ordering::SeqCst), 1);
                let calls = remote.calls.lock().unwrap();
                assert_eq!(calls.len(), expected_calls);
                assert!(calls.windows(2).all(|pair| pair[0] == pair[1]));
                let binding = &calls[0];
                assert_eq!(binding.account_id, account_id);
                assert_eq!(binding.operation_id, operation_id);
                assert_eq!(binding.vault_id, operation.vault_id());
                assert_eq!(binding.object_key, image.object_key);
                assert_eq!(binding.byte_length, 11);
                assert_eq!(binding.content_type, "image/png");
                assert_eq!(binding.sha256, image.sha256);
            }
        }
    }
}

#[tokio::test]
async fn remove_and_wipe_destroy_local_create_vault_state_even_when_remote_cleanup_is_unavailable()
{
    for wipe in [false, true] {
        let (runtime, persistence, _) = super::teardown_tests::create_vault_teardown_harness();
        let operation_id = if wipe {
            "wipe-cleanup"
        } else {
            "remove-cleanup"
        };
        seed_rejected_image_cleanup(&persistence, operation_id).await;
        let account_id = AccountId::from("account-1");
        runtime.replica().load(&account_id).await.unwrap().unwrap();
        runtime.install_vault_image_ingress(
            crate::VaultImageIngressFacade::new(
                "runtime-1",
                Arc::new(ExactImageSourcePort),
                Arc::new(crate::MemoryVaultImageArtifactStore::default()),
            )
            .unwrap(),
        );
        let remote = Arc::new(FailingThenExactCleanup {
            failures_left: AtomicUsize::new(1),
            calls: AtomicUsize::new(0),
        });
        runtime.install_create_vault_cleanup_port(remote.clone());
        let teardown_request = || {
            if wipe {
                RuntimeRequest::Wipe
            } else {
                RuntimeRequest::RemoveAccount {
                    account_id: account_id.clone(),
                }
            }
        };
        let RuntimeResponse::Teardown {
            status, failures, ..
        } = runtime
            .request(teardown_request(), RequestCancellation::new())
            .await
            .unwrap()
        else {
            panic!("expected teardown response")
        };
        assert_eq!(status, TeardownStatus::Complete);
        assert!(failures.is_empty());
        assert!(persistence.snapshot(&account_id).is_none());
        assert_eq!(remote.calls.load(Ordering::SeqCst), 1);
    }
}

#[tokio::test]
async fn local_cleanup_delete_failure_keeps_the_durable_obligation_for_idempotent_retry() {
    let (runtime, persistence, _) = super::teardown_tests::create_vault_teardown_harness();
    let operation_id = "local-delete-failure";
    seed_rejected_image_cleanup(&persistence, operation_id).await;
    let account_id = AccountId::from("account-1");
    runtime.replica().load(&account_id).await.unwrap().unwrap();
    let artifacts = Arc::new(FailDeleteArtifactPort::default());
    artifacts.fail_delete.store(true, Ordering::SeqCst);
    runtime.install_vault_image_ingress(
        crate::VaultImageIngressFacade::new("runtime-1", Arc::new(ExactImageSourcePort), artifacts)
            .unwrap(),
    );
    let cleanup = FailingThenExactCleanup {
        failures_left: AtomicUsize::new(0),
        calls: AtomicUsize::new(0),
    };
    assert_eq!(
        runtime
            .drive_create_vault_cleanup_cycle(&account_id, operation_id, &cleanup)
            .await
            .unwrap(),
        super::create_vault_cleanup::CreateVaultCleanupPass::RetryScheduled
    );
    assert!(
        persistence.snapshot(&account_id).unwrap().receipts[0]
            .create_vault_cleanup
            .as_ref()
            .unwrap()
            .local_artifact_pending
    );
    assert_eq!(
        runtime
            .drive_create_vault_cleanup_cycle(&account_id, operation_id, &cleanup)
            .await
            .unwrap(),
        super::create_vault_cleanup::CreateVaultCleanupPass::Progressed
    );
}

#[tokio::test]
async fn cleanup_cycle_renews_once_after_first_401_and_parks_with_obligation_after_second_401() {
    for unauthorized in [1, 2] {
        let (runtime, persistence, _) = super::teardown_tests::create_vault_teardown_harness();
        let operation_id = format!("cleanup-401-{unauthorized}");
        seed_rejected_image_cleanup(&persistence, &operation_id).await;
        let account_id = AccountId::from("account-1");
        runtime.replica().load(&account_id).await.unwrap().unwrap();
        runtime.install_vault_image_ingress(
            crate::VaultImageIngressFacade::new(
                "runtime-1",
                Arc::new(ExactImageSourcePort),
                Arc::new(crate::MemoryVaultImageArtifactStore::default()),
            )
            .unwrap(),
        );
        let port = UnauthorizedCleanup {
            unauthorized_left: AtomicUsize::new(unauthorized),
            calls: AtomicUsize::new(0),
            renewals: AtomicUsize::new(0),
        };
        assert_eq!(
            runtime
                .drive_create_vault_cleanup_cycle(&account_id, &operation_id, &port)
                .await
                .unwrap(),
            super::create_vault_cleanup::CreateVaultCleanupPass::Progressed
        );
        let result = runtime
            .drive_create_vault_cleanup_cycle(&account_id, &operation_id, &port)
            .await
            .unwrap();
        assert_eq!(port.renewals.load(Ordering::SeqCst), 1);
        assert_eq!(port.calls.load(Ordering::SeqCst), 2);
        if unauthorized == 1 {
            assert_eq!(
                result,
                super::create_vault_cleanup::CreateVaultCleanupPass::Completed
            );
            assert!(persistence.snapshot(&account_id).unwrap().receipts[0]
                .create_vault_cleanup
                .is_none());
        } else {
            assert_eq!(
                result,
                super::create_vault_cleanup::CreateVaultCleanupPass::ReauthenticationRequired
            );
            assert!(
                persistence.snapshot(&account_id).unwrap().receipts[0]
                    .create_vault_cleanup
                    .as_ref()
                    .unwrap()
                    .remote_staging_pending
            );
        }
    }
}

#[tokio::test]
async fn cleanup_checkpoint_commit_failure_reloads_and_repeats_the_physical_delete_idempotently() {
    let (runtime, persistence, replica_port) =
        super::teardown_tests::create_vault_teardown_harness();
    let operation_id = "cleanup-checkpoint-failure";
    seed_rejected_image_cleanup(&persistence, operation_id).await;
    let account_id = AccountId::from("account-1");
    runtime.replica().load(&account_id).await.unwrap().unwrap();
    let artifacts = Arc::new(FailDeleteArtifactPort::default());
    runtime.install_vault_image_ingress(
        crate::VaultImageIngressFacade::new(
            "runtime-1",
            Arc::new(ExactImageSourcePort),
            artifacts.clone(),
        )
        .unwrap(),
    );
    let cleanup = FailingThenExactCleanup {
        failures_left: AtomicUsize::new(0),
        calls: AtomicUsize::new(0),
    };
    replica_port.fail_next_guarded_commit();
    assert_eq!(
        runtime
            .drive_create_vault_cleanup_cycle(&account_id, operation_id, &cleanup)
            .await
            .unwrap_err()
            .code,
        RuntimeErrorCode::InvariantViolation
    );
    assert_eq!(artifacts.delete_calls.load(Ordering::SeqCst), 1);
    assert!(
        persistence.snapshot(&account_id).unwrap().receipts[0]
            .create_vault_cleanup
            .as_ref()
            .unwrap()
            .local_artifact_pending
    );

    runtime.replica().remove_cached(&account_id);
    runtime.replica().load(&account_id).await.unwrap().unwrap();
    assert_eq!(
        runtime
            .drive_create_vault_cleanup_cycle(&account_id, operation_id, &cleanup)
            .await
            .unwrap(),
        super::create_vault_cleanup::CreateVaultCleanupPass::Progressed
    );
    assert_eq!(artifacts.delete_calls.load(Ordering::SeqCst), 2);
    assert!(
        !persistence.snapshot(&account_id).unwrap().receipts[0]
            .create_vault_cleanup
            .as_ref()
            .unwrap()
            .local_artifact_pending
    );
}

struct LifecyclePngSource {
    bytes: Vec<u8>,
    account_retirements: AtomicUsize,
    runtime_retirements: AtomicUsize,
}
#[async_trait]
impl crate::VaultImageSourcePort for LifecyclePngSource {
    async fn claim(
        &self,
        _: &crate::VaultImageSourceGrant,
    ) -> Result<Box<dyn crate::VaultImageSource>, crate::VaultImageSourceError> {
        Ok(Box::new(OneImageSource {
            bytes: Some(self.bytes.clone()),
        }))
    }
    async fn retire_account(
        &self,
        _: &str,
        _: &AccountId,
    ) -> Result<(), crate::VaultImageSourceError> {
        self.account_retirements.fetch_add(1, Ordering::SeqCst);
        Ok(())
    }
    async fn complete_account_retirement(
        &self,
        _: &str,
        _: &AccountId,
    ) -> Result<(), crate::VaultImageSourceError> {
        Ok(())
    }
    async fn begin_acceptance(
        &self,
        _: &str,
        _: &AccountId,
        _: &str,
    ) -> Result<(), crate::VaultImageSourceError> {
        Ok(())
    }
    async fn end_acceptance(
        &self,
        _: &str,
        _: &AccountId,
        _: &str,
    ) -> Result<(), crate::VaultImageSourceError> {
        Ok(())
    }
    async fn retire_vaults(
        &self,
        _: &str,
        _: &AccountId,
        _: &[String],
    ) -> Result<(), crate::VaultImageSourceError> {
        Ok(())
    }
    async fn complete_vault_retirement(
        &self,
        _: &str,
        _: &AccountId,
        _: &[String],
    ) -> Result<(), crate::VaultImageSourceError> {
        Ok(())
    }
    async fn forget_account_vault_retirements(
        &self,
        _: &str,
        _: &AccountId,
    ) -> Result<(), crate::VaultImageSourceError> {
        Ok(())
    }
    async fn retire_runtime(&self, _: &str) -> Result<(), crate::VaultImageSourceError> {
        self.runtime_retirements.fetch_add(1, Ordering::SeqCst);
        Ok(())
    }
}
struct BusyImageRecovery;
#[async_trait]
impl crate::SerializedRecoveryExecutor for BusyImageRecovery {
    async fn invoke(
        &self,
        request: String,
        _: Option<Vec<u8>>,
    ) -> Result<(String, Option<Vec<u8>>), RuntimeError> {
        use crate::recovery::control::{
            RecoveryControlRequest as Request, RecoveryControlResponse as Response,
            RecoveryUnavailableReason,
        };
        let response = match serde_json::from_str::<Request>(&request).unwrap() {
            Request::EnterMaintenance { .. } => Response::Unavailable {
                reason: RecoveryUnavailableReason::Busy,
            },
            Request::LeaveMaintenance { .. } => Response::MaintenanceLeft,
            _ => panic!("busy recovery cannot access storage"),
        };
        Ok((serde_json::to_string(&response).unwrap(), None))
    }
}
#[derive(Clone, Copy)]
enum PreserveImageRetirement {
    Close,
    Lock,
    SignOut,
    BusyRecovery,
}
async fn accepted_png_survives_retirement(action: PreserveImageRetirement) {
    use base64::Engine;
    const PNG_BASE64: &str = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jR9kAAAAASUVORK5CYII=";
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(PNG_BASE64)
        .unwrap();
    let persistence = Arc::new(InMemoryReplica::default());
    let runtime = Runtime::with_persistence(
        persistence.clone(),
        Arc::new(PlatformStorage::new(image_platform().await)),
        Arc::new(HttpTransport::unavailable()),
        None,
        None,
        false,
        Arc::new(SystemClock),
        Arc::new(SystemDeviceTimer),
        Some(persistence.clone()),
    );
    runtime
        .set_recovery_executor(Arc::new(BusyImageRecovery))
        .unwrap();
    runtime.open().await.unwrap();
    let account_id = AccountId::from("account-1");
    let incarnation = Incarnation::from("incarnation-1");
    let installed = runtime
        .replica()
        .install_or_replace(account_id.clone(), "user-1".into(), incarnation.clone())
        .await
        .unwrap();
    runtime.replica().cache(installed);
    runtime.seed_live_master_unlock_key(&account_id, &incarnation);
    runtime.seed_unlocked_preparation_account(&account_id);
    let sources = Arc::new(LifecyclePngSource {
        bytes: bytes.clone(),
        account_retirements: AtomicUsize::new(0),
        runtime_retirements: AtomicUsize::new(0),
    });
    let artifacts = Arc::new(crate::MemoryVaultImageArtifactStore::default());
    runtime.install_vault_image_ingress(
        crate::VaultImageIngressFacade::new("runtime-1", sources.clone(), artifacts.clone())
            .unwrap(),
    );
    let response = runtime
        .request(
            RuntimeRequest::CreateVault {
                account_id: account_id.clone(),
                name: "Retained PNG".into(),
                vault_type: CreateVaultType::Personal,
                icon: "lock".into(),
                image_source: Some(VaultImageSourceInput {
                    capability_id: "opaque-image-source".into(),
                    byte_length: bytes.len() as u64,
                    content_type: "image/png".into(),
                }),
            },
            RequestCancellation::new(),
        )
        .await
        .unwrap();
    assert!(matches!(
        response,
        RuntimeResponse::VaultCreationAccepted { .. }
    ));
    let before = persistence.snapshot(&account_id).unwrap();
    let operation = &before.operations[0];
    let exact_operation = serde_json::to_string(operation).unwrap();
    let image = operation
        .create_vault
        .as_ref()
        .unwrap()
        .image
        .as_ref()
        .unwrap();
    let metadata = crate::VaultImageArtifactMetadata::new(
        crate::VaultImageArtifactScope::new(account_id.clone(), &operation.operation_id).unwrap(),
        operation.vault_id(),
        image.byte_length,
        &image.content_type,
        &image.sha256,
    )
    .unwrap();
    let witness = image
        .protected_witness
        .as_ref()
        .expect("accepted PNG must be protected");
    let family = metadata.scope().clone();
    let publication = artifacts
        .read_generation(&family, None)
        .await
        .unwrap()
        .unwrap()
        .metadata
        .unwrap();
    assert_eq!(publication.protection().unwrap().witness, *witness);
    let ciphertext = artifacts.read_all(&publication).await.unwrap();
    assert_ne!(ciphertext, bytes);
    let facade = crate::VaultImageIngressFacade::new(
        "read-fixture",
        Arc::new(ExactImageSourcePort),
        artifacts.clone(),
    )
    .unwrap();
    assert_eq!(
        facade
            .read_protected_bound(
                &metadata,
                witness,
                crate::vault_image::VaultImageProtection {
                    user_id: "user-1",
                    device_key: &[7; 32]
                },
                &RequestCancellation::new()
            )
            .await
            .unwrap()
            .as_slice(),
        bytes.as_slice()
    );
    match action {
        PreserveImageRetirement::Close => runtime.close().await,
        PreserveImageRetirement::Lock => {
            runtime
                .request(
                    RuntimeRequest::Lock {
                        account_id: account_id.clone(),
                    },
                    RequestCancellation::new(),
                )
                .await
                .unwrap();
        }
        PreserveImageRetirement::SignOut => {
            runtime
                .request(
                    RuntimeRequest::SignOut {
                        account_id: account_id.clone(),
                    },
                    RequestCancellation::new(),
                )
                .await
                .unwrap();
        }
        PreserveImageRetirement::BusyRecovery => {
            let response = runtime
                .request(
                    RuntimeRequest::InspectRecovery {
                        account_id: Some(account_id.clone()),
                    },
                    RequestCancellation::new(),
                )
                .await
                .unwrap();
            assert!(matches!(
                response,
                RuntimeResponse::RecoveryDiagnosed {
                    diagnostics: crate::StorageRecoveryDiagnostics {
                        maintenance: crate::RecoveryMaintenanceStatus::Busy,
                        ..
                    }
                }
            ));
        }
    }
    let retained = persistence.snapshot(&account_id).unwrap();
    assert_eq!(retained.operations.len(), 1);
    assert_eq!(
        serde_json::to_string(&retained.operations[0]).unwrap(),
        exact_operation
    );
    assert_eq!(
        artifacts
            .read_all(&publication)
            .await
            .expect("ordinary source retirement must retain accepted PNG bytes")
            .as_slice(),
        ciphertext.as_slice()
    );
    assert!(
        sources.account_retirements.load(Ordering::SeqCst)
            + sources.runtime_retirements.load(Ordering::SeqCst)
            > 0
    );
    runtime.close().await;
    assert_eq!(
        artifacts.read_all(&publication).await.unwrap().as_slice(),
        ciphertext.as_slice()
    );
}
#[tokio::test]
async fn accepted_png_survives_normal_close() {
    accepted_png_survives_retirement(PreserveImageRetirement::Close).await;
}
#[tokio::test]
async fn accepted_png_survives_lock() {
    accepted_png_survives_retirement(PreserveImageRetirement::Lock).await;
}
#[tokio::test]
async fn accepted_png_survives_sign_out() {
    accepted_png_survives_retirement(PreserveImageRetirement::SignOut).await;
}
#[tokio::test]
async fn accepted_png_survives_busy_recovery_admission() {
    accepted_png_survives_retirement(PreserveImageRetirement::BusyRecovery).await;
}

#[tokio::test]
async fn retained_create_vault_receipts_without_requiring_its_original_current_authority() {
    let (runtime, account_id, operation_id, port) = matrix_recovery("vault", 1, false).await;
    let original_visible = runtime
        .replica()
        .snapshot(&account_id)
        .unwrap()
        .bootstrap
        .snapshot()
        .visible_vaults;
    let result = runtime
        .drive_create_vault_recovery_cycle(&account_id, &operation_id, &port, &port)
        .await
        .unwrap();
    assert_eq!(
        result,
        super::create_vault_executor::CreateVaultExecutorPass::Completed
    );
    let after = runtime.replica().snapshot(&account_id).unwrap();
    assert!(after.operations.is_empty());
    assert_eq!(after.receipts.len(), 1);
    assert!(
        after.receipts[0]
            .create_vault_cleanup
            .as_ref()
            .unwrap()
            .local_artifact_pending
    );
    assert_eq!(
        after.bootstrap.state,
        crate::replica::ReplicaState::RefreshRequired
    );
    assert_eq!(after.bootstrap.snapshot().visible_vaults, original_visible);
    assert_eq!(
        port.failures_left.load(Ordering::SeqCst),
        1,
        "receipt-only completion must never query the old Vault or key representation"
    );
}

#[tokio::test]
async fn stale_create_vault_identity_error_cannot_fail_a_newer_replica_head() {
    struct StaleIdentityReply {
        runtime: Arc<Runtime>,
        account_id: AccountId,
    }
    #[async_trait]
    impl super::create_vault_executor::CreateVaultExecutorPort for StaleIdentityReply {
        async fn lookup(
            &self,
            _: &crate::replica::OperationRecord,
        ) -> Result<
            Option<super::create_vault_executor::CreateVaultOperationResponse>,
            super::create_vault_staging::CreateVaultStagingError,
        > {
            Ok(None)
        }
        async fn put_exact(
            &self,
            operation: &crate::replica::OperationRecord,
        ) -> Result<
            super::create_vault_executor::CreateVaultOperationResponse,
            super::create_vault_staging::CreateVaultStagingError,
        > {
            let snapshot = self.runtime.replica.snapshot(&self.account_id).unwrap();
            let mut newer = operation.clone();
            newer.scheduling.attempt_count += 1;
            self.runtime
                .replica
                .execute_exact(GuardedCommitPlan::new(
                    self.account_id.clone(),
                    snapshot.incarnation,
                    snapshot.revision,
                    snapshot.lock_epoch,
                    vec![PlanMutation::RescheduleOperation(newer)],
                ))
                .await
                .unwrap();
            super::create_vault_executor::CreateVaultExecutorPort::put_exact(
                &MisTaggedExecutor(InvalidCreateVaultReplay::ChangedFingerprint),
                operation,
            )
            .await
        }
        async fn renew_session(
            &self,
        ) -> Result<(), super::create_vault_staging::CreateVaultStagingError> {
            Ok(())
        }
    }
    let (runtime, account_id, operation_id, staging) = matrix_recovery("none", 0, false).await;
    let reply = StaleIdentityReply {
        runtime: runtime.clone(),
        account_id: account_id.clone(),
    };
    let result = runtime
        .drive_create_vault_recovery_cycle(&account_id, &operation_id, &staging, &reply)
        .await;
    assert!(
        matches!(
            result,
            Err(super::create_vault_staging::CreateVaultRecoveryError::ParkedFenced)
        ),
        "stale identity failure must retry its original scope"
    );
    let after = runtime.replica.snapshot(&account_id).unwrap();
    assert_eq!(after.failure, None);
    assert_eq!(after.operations.len(), 1);
    assert!(after.receipts.is_empty());
}

#[tokio::test]
async fn failed_create_vault_receipt_write_preserves_work_and_uses_durable_retry() {
    struct FailReceiptCommit(Arc<InMemoryReplica>, AtomicBool);
    #[async_trait]
    impl ReplicaPersistence for FailReceiptCommit {
        async fn invoke(
            &self,
            request: crate::replica::ReplicaPersistenceRequest,
        ) -> Result<crate::replica::ReplicaPersistenceResponse, RuntimeError> {
            if matches!(
                &request,
                crate::replica::ReplicaPersistenceRequest::Commit { .. }
            ) && self.1.swap(false, Ordering::SeqCst)
            {
                return Err(RuntimeError::new(
                    RuntimeErrorCode::InvariantViolation,
                    "physical receipt write failed",
                ));
            }
            self.0.invoke(request).await
        }
    }
    let (original, account_id, _) = unlocked_runtime().await;
    original.seed_ready_personal_vault_in_memory(&account_id);
    let response = original
        .request(
            RuntimeRequest::CreateVault {
                account_id: account_id.clone(),
                name: "Receipt retry".into(),
                vault_type: CreateVaultType::Personal,
                icon: "lock".into(),
                image_source: None,
            },
            RequestCancellation::new(),
        )
        .await
        .unwrap();
    let RuntimeResponse::VaultCreationAccepted { operation_id, .. } = response else {
        panic!("expected accepted Vault")
    };
    let persistence = original.test_persistence.as_ref().unwrap().clone();
    let before = persistence.snapshot(&account_id).unwrap();
    let runtime = Runtime::with_persistence(
        Arc::new(FailReceiptCommit(
            persistence.clone(),
            AtomicBool::new(true),
        )),
        Arc::new(PlatformStorage::unavailable()),
        Arc::new(HttpTransport::unavailable()),
        None,
        None,
        true,
        operation_fixtures::TestClock::new(),
        Arc::new(SystemDeviceTimer),
        Some(persistence.clone()),
    );
    runtime.replica.load(&account_id).await.unwrap();
    let port = LostAppliedResponseExecutor {
        committed: AtomicBool::new(true),
        authority: Mutex::new(None),
        put_calls: AtomicUsize::new(0),
    };
    assert_eq!(
        runtime
            .drive_create_vault_executor_cycle(&account_id, &operation_id, &port)
            .await
            .unwrap(),
        super::create_vault_executor::CreateVaultExecutorPass::RetryScheduled
    );
    let waiting = persistence.snapshot(&account_id).unwrap();
    assert!(waiting.failure.is_none());
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
            .drive_create_vault_executor_cycle(&account_id, &operation_id, &port)
            .await
            .unwrap(),
        super::create_vault_executor::CreateVaultExecutorPass::Completed
    );
    let after = persistence.snapshot(&account_id).unwrap();
    assert!(after.operations.is_empty());
    assert_eq!(after.receipts.len(), 1);
}
