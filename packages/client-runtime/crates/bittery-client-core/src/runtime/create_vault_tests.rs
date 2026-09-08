use super::*;
use crate::{CreateVaultType, Incarnation, VaultImageSourceInput};
use async_trait::async_trait;
use serde_json::json;
use sha2::{Digest, Sha256};
use std::collections::HashSet;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Arc;

fn authority_page(
    items: Vec<crate::server_contract::AuthVaultKeyResponse>,
    has_more: bool,
    next_cursor: Option<String>,
) -> super::create_vault_executor::CreateVaultAuthorityPage {
    let raw_response_body =
        serde_json::to_vec(&crate::server_contract::CursorPageAuthVaultKeyResponse {
            items,
            has_more,
            next_cursor,
        })
        .unwrap();
    super::create_vault_executor::CreateVaultAuthorityPage {
        raw_response_body: Some(raw_response_body),
    }
}

fn decoded_authority_page(
    page: &super::create_vault_executor::CreateVaultAuthorityPage,
) -> crate::server_contract::CursorPageAuthVaultKeyResponse {
    serde_json::from_slice(page.raw_response_body.as_ref().unwrap()).unwrap()
}

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

struct ExactImageSourcePort;

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
    async fn retire_runtime(&self, _: &str) -> Result<(), crate::VaultImageSourceError> {
        Ok(())
    }
}

async fn unlocked_runtime() -> (Arc<Runtime>, AccountId, Incarnation) {
    let runtime = Runtime::new();
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

struct FailingThenExactStaging {
    failures_left: AtomicUsize,
    calls: Mutex<Vec<&'static str>>,
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
    ) -> Result<(), super::create_vault_staging::CreateVaultStagingError> {
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
    let staging = FailingThenExactStaging {
        failures_left: AtomicUsize::new(0),
        calls: Mutex::new(Vec::new()),
    };

    let first = Runtime::with_serialized_executors(
        executor.clone(),
        Arc::new(super::create_tests::SuccessfulDeletePlatform),
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
        Arc::new(super::create_tests::SuccessfulDeletePlatform),
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
        Arc::new(super::create_tests::SuccessfulDeletePlatform),
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
        Arc::new(super::create_tests::SuccessfulDeletePlatform),
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

fn authority_key(
    authority: &crate::replica::AuthorityVaultRecord,
) -> crate::server_contract::AuthVaultKeyResponse {
    crate::server_contract::AuthVaultKeyResponse {
        encrypted_vault_key: authority.encrypted_vault_key.clone(),
        role: crate::server_contract::VaultRole::Owner,
        vault_icon: authority.icon.clone(),
        vault_id: authority.id.clone(),
        vault_image_url: authority.image_url.clone(),
        vault_name: authority.name.clone(),
        vault_type: match authority.vault_type {
            crate::replica::AuthorityVaultType::Personal => {
                crate::server_contract::VaultType::Personal
            }
            crate::replica::AuthorityVaultType::Team => crate::server_contract::VaultType::Team,
        },
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

    async fn fetch_vault(
        &self,
        _vault_id: &str,
    ) -> Result<
        super::create_vault_executor::CreateVaultAuthorityRecord,
        super::create_vault_staging::CreateVaultStagingError,
    > {
        let authority = self.authority.lock().unwrap().clone().unwrap();
        Ok(super::create_vault_executor::CreateVaultAuthorityRecord {
            id: authority.id,
            name: authority.name,
            vault_type: authority.vault_type,
            icon: authority.icon,
            image_url: authority.image_url,
            role: authority.role,
        })
    }

    async fn fetch_vault_keys(
        &self,
        _vault_id: &str,
        _cursor: Option<&str>,
    ) -> Result<
        super::create_vault_executor::CreateVaultAuthorityPage,
        super::create_vault_staging::CreateVaultStagingError,
    > {
        Ok(authority_page(
            vec![authority_key(
                self.authority.lock().unwrap().as_ref().unwrap(),
            )],
            false,
            None,
        ))
    }

    async fn renew_session(
        &self,
    ) -> Result<(), super::create_vault_staging::CreateVaultStagingError> {
        Ok(())
    }
}

#[tokio::test]
async fn lost_applied_response_requires_exact_replay_then_reconciles_authority_and_receipt() {
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
    assert!(snapshot
        .bootstrap
        .vaults
        .values()
        .any(|vault| vault.id == vault_id && vault.name == "Recovered Vault"));
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

    async fn fetch_vault(
        &self,
        _vault_id: &str,
    ) -> Result<
        super::create_vault_executor::CreateVaultAuthorityRecord,
        super::create_vault_staging::CreateVaultStagingError,
    > {
        panic!("invalid tagged outcome must preserve work before authority fetch")
    }

    async fn fetch_vault_keys(
        &self,
        _vault_id: &str,
        _cursor: Option<&str>,
    ) -> Result<
        super::create_vault_executor::CreateVaultAuthorityPage,
        super::create_vault_staging::CreateVaultStagingError,
    > {
        panic!("invalid tagged outcome must preserve work before authority key fetch")
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

    async fn fetch_vault(
        &self,
        _vault_id: &str,
    ) -> Result<
        super::create_vault_executor::CreateVaultAuthorityRecord,
        super::create_vault_staging::CreateVaultStagingError,
    > {
        panic!("a rejected create-Vault outcome has no authority fetch")
    }

    async fn fetch_vault_keys(
        &self,
        _vault_id: &str,
        _cursor: Option<&str>,
    ) -> Result<
        super::create_vault_executor::CreateVaultAuthorityPage,
        super::create_vault_staging::CreateVaultStagingError,
    > {
        panic!("a rejected create-Vault outcome has no authority key fetch")
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
        Arc::new(super::create_tests::SuccessfulDeletePlatform),
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
        Arc::new(super::create_tests::SuccessfulDeletePlatform),
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
    async fn fetch_vault(
        &self,
        _vault_id: &str,
    ) -> Result<
        super::create_vault_executor::CreateVaultAuthorityRecord,
        super::create_vault_staging::CreateVaultStagingError,
    > {
        panic!("rejected outcome has no Vault fetch")
    }
    async fn fetch_vault_keys(
        &self,
        _vault_id: &str,
        _cursor: Option<&str>,
    ) -> Result<
        super::create_vault_executor::CreateVaultAuthorityPage,
        super::create_vault_staging::CreateVaultStagingError,
    > {
        panic!("rejected outcome has no Vault-key fetch")
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
        Arc::new(super::create_tests::SuccessfulDeletePlatform),
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
        Arc::new(super::create_tests::SuccessfulDeletePlatform),
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
    ) -> Result<(), super::create_vault_staging::CreateVaultStagingError> {
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
    ) -> Result<(), super::create_vault_staging::CreateVaultStagingError> {
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
    async fn fetch_vault(
        &self,
        _vault_id: &str,
    ) -> Result<
        super::create_vault_executor::CreateVaultAuthorityRecord,
        super::create_vault_staging::CreateVaultStagingError,
    > {
        panic!("second 401 parks before authority")
    }
    async fn fetch_vault_keys(
        &self,
        _vault_id: &str,
        _cursor: Option<&str>,
    ) -> Result<
        super::create_vault_executor::CreateVaultAuthorityPage,
        super::create_vault_staging::CreateVaultStagingError,
    > {
        panic!("second 401 parks before authority keys")
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

struct AuthorityBoundsPort {
    vault_id: String,
    vault_name: String,
    pages:
        Mutex<std::collections::VecDeque<super::create_vault_executor::CreateVaultAuthorityPage>>,
}

#[async_trait]
impl super::create_vault_executor::CreateVaultExecutorPort for AuthorityBoundsPort {
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
            crate::server_contract::CreateVaultOperationResult::Applied {
                vault_id: self.vault_id.clone(),
            },
        ))
    }

    async fn fetch_vault(
        &self,
        _vault_id: &str,
    ) -> Result<
        super::create_vault_executor::CreateVaultAuthorityRecord,
        super::create_vault_staging::CreateVaultStagingError,
    > {
        Ok(super::create_vault_executor::CreateVaultAuthorityRecord {
            id: self.vault_id.clone(),
            name: self.vault_name.clone(),
            vault_type: crate::replica::AuthorityVaultType::Personal,
            icon: Some("lock".into()),
            image_url: None,
            role: crate::replica::AuthorityVaultRole::Owner,
        })
    }

    async fn fetch_vault_keys(
        &self,
        _vault_id: &str,
        _cursor: Option<&str>,
    ) -> Result<
        super::create_vault_executor::CreateVaultAuthorityPage,
        super::create_vault_staging::CreateVaultStagingError,
    > {
        Ok(self.pages.lock().unwrap().pop_front().unwrap())
    }

    async fn renew_session(
        &self,
    ) -> Result<(), super::create_vault_staging::CreateVaultStagingError> {
        Ok(())
    }
}

fn bounds_authority_key(
    vault_id: impl Into<String>,
    encrypted_vault_key: impl Into<String>,
    vault_name: impl Into<String>,
) -> crate::server_contract::AuthVaultKeyResponse {
    crate::server_contract::AuthVaultKeyResponse {
        encrypted_vault_key: encrypted_vault_key.into(),
        role: crate::server_contract::VaultRole::Owner,
        vault_icon: Some("lock".into()),
        vault_id: vault_id.into(),
        vault_image_url: None,
        vault_name: vault_name.into(),
        vault_type: crate::server_contract::VaultType::Personal,
    }
}

fn authority_page_with_exact_bytes(
    target_bytes: usize,
    mut items: Vec<crate::server_contract::AuthVaultKeyResponse>,
) -> super::create_vault_executor::CreateVaultAuthorityPage {
    let measured = authority_page(items.clone(), false, None)
        .raw_response_body
        .as_ref()
        .unwrap()
        .len();
    assert!(measured <= target_bytes);
    items[0]
        .vault_name
        .push_str(&"x".repeat(target_bytes - measured));
    let page = authority_page(items, false, None);
    assert_eq!(page.raw_response_body.as_ref().unwrap().len(), target_bytes);
    page
}

fn authority_page_with_exact_item_bytes(
    target_bytes: usize,
    mut items: Vec<crate::server_contract::AuthVaultKeyResponse>,
) -> super::create_vault_executor::CreateVaultAuthorityPage {
    let measured = serde_json::to_vec(&items).unwrap().len();
    assert!(measured <= target_bytes);
    items[0]
        .vault_name
        .push_str(&"x".repeat(target_bytes - measured));
    assert_eq!(serde_json::to_vec(&items).unwrap().len(), target_bytes);
    authority_page(items, false, None)
}

fn paginate_authority_pages(
    mut pages: Vec<super::create_vault_executor::CreateVaultAuthorityPage>,
) -> Vec<super::create_vault_executor::CreateVaultAuthorityPage> {
    let page_count = pages.len();
    for (index, page) in pages.iter_mut().enumerate() {
        let decoded = decoded_authority_page(page);
        *page = authority_page(
            decoded.items,
            index + 1 < page_count,
            (index + 1 < page_count).then(|| format!("authority-page-{}", index + 1)),
        );
    }
    pages
}

async fn accepted_create_vault_for_authority_bounds(
) -> (Arc<Runtime>, AccountId, String, String, String) {
    let (runtime, account_id, _) = unlocked_runtime().await;
    runtime.seed_ready_personal_vault_in_memory(&account_id);
    let RuntimeResponse::VaultCreationAccepted {
        operation_id,
        vault_id,
        ..
    } = runtime
        .request(
            RuntimeRequest::CreateVault {
                account_id: account_id.clone(),
                name: "Bounded Vault".into(),
                vault_type: CreateVaultType::Personal,
                icon: "lock".into(),
                image_source: None,
            },
            RequestCancellation::new(),
        )
        .await
        .unwrap()
    else {
        panic!("expected accepted create-Vault Operation")
    };
    let encrypted_vault_key = runtime.replica().snapshot(&account_id).unwrap().operations[0]
        .create_vault
        .as_ref()
        .unwrap()
        .encrypted_vault_key
        .clone();
    (
        runtime,
        account_id,
        operation_id,
        vault_id,
        encrypted_vault_key,
    )
}

async fn assert_authority_pages(
    pages: impl FnOnce(&str, &str) -> Vec<super::create_vault_executor::CreateVaultAuthorityPage>,
    succeeds: bool,
) {
    let (runtime, account_id, operation_id, vault_id, encrypted_vault_key) =
        accepted_create_vault_for_authority_bounds().await;
    let port = AuthorityBoundsPort {
        vault_id: vault_id.clone(),
        vault_name: "Bounded Vault".into(),
        pages: Mutex::new(pages(&vault_id, &encrypted_vault_key).into()),
    };
    let result = runtime
        .drive_create_vault_executor_cycle(&account_id, &operation_id, &port)
        .await;
    assert_eq!(
        result.is_ok(),
        succeeds,
        "unexpected authority result: {result:?}"
    );
    let snapshot = runtime.replica().snapshot(&account_id).unwrap();
    assert_eq!(snapshot.operations.is_empty(), succeeds);
    assert_eq!(snapshot.receipts.len(), usize::from(succeeds));
}

#[tokio::test]
async fn create_vault_authority_rejects_one_key_page_over_the_four_mibibyte_bound() {
    const PAGE_BYTES: usize = 4 * 1024 * 1024;
    let (runtime, account_id, operation_id, vault_id, encrypted_vault_key) =
        accepted_create_vault_for_authority_bounds().await;
    let page = authority_page_with_exact_bytes(
        PAGE_BYTES + 1,
        vec![
            bounds_authority_key("foreign-vault", "foreign-wrapped", "foreign"),
            bounds_authority_key(&vault_id, &encrypted_vault_key, "Bounded Vault"),
        ],
    );
    let port = AuthorityBoundsPort {
        vault_id,
        vault_name: "Bounded Vault".into(),
        pages: Mutex::new([page].into()),
    };

    assert!(runtime
        .drive_create_vault_executor_cycle(&account_id, &operation_id, &port)
        .await
        .is_err());
    let snapshot = runtime.replica().snapshot(&account_id).unwrap();
    assert_eq!(snapshot.operations.len(), 1);
    assert!(snapshot.receipts.is_empty());
}

#[tokio::test]
async fn create_vault_authority_rejects_a_full_wire_page_over_four_mibibytes() {
    const RESPONSE_BYTES: usize = 4 * 1024 * 1024;
    assert_authority_pages(
        move |vault_id, encrypted_vault_key| {
            vec![authority_page(
                vec![bounds_authority_key(
                    vault_id,
                    encrypted_vault_key,
                    "Bounded Vault",
                )],
                true,
                Some("c".repeat(RESPONSE_BYTES)),
            )]
        },
        false,
    )
    .await;
}

#[tokio::test]
async fn create_vault_authority_page_count_and_byte_boundaries_are_exact() {
    const PAGE_ITEMS: usize = 500;
    const PAGE_BYTES: usize = 4 * 1024 * 1024;
    for (count, succeeds) in [(PAGE_ITEMS, true), (PAGE_ITEMS + 1, false)] {
        assert_authority_pages(
            move |vault_id, encrypted_vault_key| {
                let mut items = (0..count.saturating_sub(1))
                    .map(|index| {
                        bounds_authority_key(
                            format!("count-{index}"),
                            format!("wrapped-{index}"),
                            format!("Count {index}"),
                        )
                    })
                    .collect::<Vec<_>>();
                items.push(bounds_authority_key(
                    vault_id,
                    encrypted_vault_key,
                    "Bounded Vault",
                ));
                vec![authority_page(items, false, None)]
            },
            succeeds,
        )
        .await;
    }
    for (bytes, succeeds) in [(PAGE_BYTES, true), (PAGE_BYTES + 1, false)] {
        assert_authority_pages(
            move |vault_id, encrypted_vault_key| {
                vec![authority_page_with_exact_bytes(
                    bytes,
                    vec![
                        bounds_authority_key("byte-filler", "wrapped-filler", "filler"),
                        bounds_authority_key(vault_id, encrypted_vault_key, "Bounded Vault"),
                    ],
                )]
            },
            succeeds,
        )
        .await;
    }
}

fn authority_count_pages(
    count: usize,
    vault_id: &str,
    encrypted_vault_key: &str,
) -> Vec<super::create_vault_executor::CreateVaultAuthorityPage> {
    let mut items = (0..count.saturating_sub(1))
        .map(|index| {
            bounds_authority_key(
                format!("aggregate-count-{index}"),
                format!("wrapped-{index}"),
                "foreign",
            )
        })
        .collect::<Vec<_>>();
    items.push(bounds_authority_key(
        vault_id,
        encrypted_vault_key,
        "Bounded Vault",
    ));
    paginate_authority_pages(
        items
            .chunks(500)
            .map(|items| authority_page(items.to_vec(), false, None))
            .collect(),
    )
}

fn authority_aggregate_byte_pages(
    target_bytes: usize,
    vault_id: &str,
    encrypted_vault_key: &str,
) -> Vec<super::create_vault_executor::CreateVaultAuthorityPage> {
    let page_target = target_bytes / 9;
    let mut pages = (0..8)
        .map(|index| {
            authority_page_with_exact_item_bytes(
                page_target,
                vec![bounds_authority_key(
                    format!("aggregate-byte-{index}"),
                    format!("wrapped-{index}"),
                    "foreign",
                )],
            )
        })
        .collect::<Vec<_>>();
    let prefix_item_bytes = pages
        .iter()
        .flat_map(|page| decoded_authority_page(page).items)
        .map(|item| serde_json::to_vec(&item).unwrap().len())
        .sum::<usize>();
    let last_page_bytes = target_bytes - prefix_item_bytes - 8;
    pages.push(authority_page_with_exact_item_bytes(
        last_page_bytes,
        vec![
            bounds_authority_key("aggregate-byte-last", "wrapped-last", "foreign"),
            bounds_authority_key(vault_id, encrypted_vault_key, "Bounded Vault"),
        ],
    ));
    let all_items = pages
        .iter()
        .flat_map(|page| decoded_authority_page(page).items)
        .collect::<Vec<_>>();
    assert_eq!(serde_json::to_vec(&all_items).unwrap().len(), target_bytes);
    paginate_authority_pages(pages)
}

#[tokio::test]
async fn create_vault_authority_aggregate_count_and_byte_boundaries_are_exact() {
    const ITEMS: usize = 21_000;
    const BYTES: usize = 32 * 1024 * 1024;
    for (count, succeeds) in [(ITEMS, true), (ITEMS + 1, false)] {
        assert_authority_pages(
            move |vault_id, encrypted_vault_key| {
                authority_count_pages(count, vault_id, encrypted_vault_key)
            },
            succeeds,
        )
        .await;
    }
    for (bytes, succeeds) in [(BYTES, true), (BYTES + 1, false)] {
        assert_authority_pages(
            move |vault_id, encrypted_vault_key| {
                authority_aggregate_byte_pages(bytes, vault_id, encrypted_vault_key)
            },
            succeeds,
        )
        .await;
    }
}

#[tokio::test]
async fn create_vault_authority_rejects_page_cursor_and_identity_pathologies_at_public_seam() {
    const PAGE_BYTES: usize = 4 * 1024 * 1024;
    for (page_bytes, succeeds) in [(PAGE_BYTES, true), (PAGE_BYTES + 1, false)] {
        assert_authority_pages(
            move |vault_id, encrypted_vault_key| {
                let item = bounds_authority_key("cursor-foreign", "cursor-wrapped", "foreign");
                let base = authority_page(vec![item.clone()], true, Some(String::new()));
                let cursor_bytes = page_bytes - base.raw_response_body.as_ref().unwrap().len();
                vec![
                    authority_page(vec![item], true, Some("c".repeat(cursor_bytes))),
                    authority_page(
                        vec![bounds_authority_key(
                            vault_id,
                            encrypted_vault_key,
                            "Bounded Vault",
                        )],
                        false,
                        None,
                    ),
                ]
            },
            succeeds,
        )
        .await;
    }

    const AGGREGATE_CURSOR_BYTES: usize = 32 * 1024 * 1024;
    for (cursor_bytes, succeeds) in [
        (AGGREGATE_CURSOR_BYTES, true),
        (AGGREGATE_CURSOR_BYTES + 1, false),
    ] {
        assert_authority_pages(
            move |vault_id, encrypted_vault_key| {
                let base = cursor_bytes / 9;
                let mut pages = (0..9)
                    .map(|index| {
                        let length = if index == 8 {
                            cursor_bytes - base * 8
                        } else {
                            base
                        };
                        authority_page(
                            vec![bounds_authority_key(
                                format!("cursor-total-{index}"),
                                format!("cursor-wrapped-{index}"),
                                "foreign",
                            )],
                            true,
                            Some(format!("{index}{}", "c".repeat(length - 1))),
                        )
                    })
                    .collect::<Vec<_>>();
                pages.push(authority_page(
                    vec![bounds_authority_key(
                        vault_id,
                        encrypted_vault_key,
                        "Bounded Vault",
                    )],
                    false,
                    None,
                ));
                pages
            },
            succeeds,
        )
        .await;
    }

    assert_authority_pages(
        |vault_id, encrypted_vault_key| {
            let mut pages = (0..200)
                .map(|index| {
                    authority_page(
                        vec![bounds_authority_key(
                            format!("page-{index}"),
                            format!("wrapped-{index}"),
                            "foreign",
                        )],
                        true,
                        Some(format!("page-cursor-{index}")),
                    )
                })
                .collect::<Vec<_>>();
            let mut decoded = decoded_authority_page(&pages[199]);
            decoded.items.push(bounds_authority_key(
                vault_id,
                encrypted_vault_key,
                "Bounded Vault",
            ));
            pages[199] = authority_page(decoded.items, decoded.has_more, decoded.next_cursor);
            pages
        },
        false,
    )
    .await;

    assert_authority_pages(
        |vault_id, encrypted_vault_key| {
            let mut pages = paginate_authority_pages(
                (0..200)
                    .map(|index| {
                        authority_page(
                            vec![bounds_authority_key(
                                format!("exact-page-{index}"),
                                format!("exact-wrapped-{index}"),
                                "foreign",
                            )],
                            false,
                            None,
                        )
                    })
                    .collect(),
            );
            let mut decoded = decoded_authority_page(&pages[199]);
            decoded.items.push(bounds_authority_key(
                vault_id,
                encrypted_vault_key,
                "Bounded Vault",
            ));
            pages[199] = authority_page(decoded.items, decoded.has_more, decoded.next_cursor);
            pages
        },
        true,
    )
    .await;

    for pages in [
        vec![
            authority_page(
                vec![bounds_authority_key("cycle-1", "wrapped-1", "foreign")],
                true,
                Some("cycle-a".into()),
            ),
            authority_page(
                vec![bounds_authority_key("cycle-2", "wrapped-2", "foreign")],
                true,
                Some("cycle-b".into()),
            ),
            authority_page(
                vec![bounds_authority_key("cycle-3", "wrapped-3", "foreign")],
                true,
                Some("cycle-a".into()),
            ),
        ],
        vec![authority_page(
            vec![
                bounds_authority_key("duplicate", "wrapped-1", "foreign"),
                bounds_authority_key("duplicate", "wrapped-2", "foreign"),
            ],
            false,
            None,
        )],
        vec![
            authority_page(
                vec![bounds_authority_key("before-empty", "wrapped", "foreign")],
                true,
                Some("later-empty".into()),
            ),
            authority_page(Vec::new(), true, Some("after-empty".into())),
        ],
    ] {
        assert_authority_pages(move |_, _| pages, false).await;
    }
}

#[tokio::test]
async fn create_vault_authority_requires_present_well_formed_raw_response_evidence() {
    assert_authority_pages(
        |vault_id, encrypted_vault_key| {
            let mut page = authority_page(
                vec![bounds_authority_key(
                    vault_id,
                    encrypted_vault_key,
                    "Bounded Vault",
                )],
                false,
                None,
            );
            page.raw_response_body = None;
            vec![page]
        },
        false,
    )
    .await;

    assert_authority_pages(
        |vault_id, encrypted_vault_key| {
            let _ = (vault_id, encrypted_vault_key);
            let page = super::create_vault_executor::CreateVaultAuthorityPage {
                raw_response_body: Some(b"not-json".to_vec()),
            };
            vec![page]
        },
        false,
    )
    .await;
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
    foreign_only: bool,
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
    ) -> Result<(), super::create_vault_staging::CreateVaultStagingError> {
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
    async fn fetch_vault(
        &self,
        _vault_id: &str,
    ) -> Result<
        super::create_vault_executor::CreateVaultAuthorityRecord,
        super::create_vault_staging::CreateVaultStagingError,
    > {
        self.maybe_fail("vault")?;
        self.race_guard("authority_fetch").await;
        let accepted = self.accepted.lock().unwrap();
        let (vault_id, _, name) = accepted.as_ref().unwrap();
        Ok(super::create_vault_executor::CreateVaultAuthorityRecord {
            id: vault_id.clone(),
            name: name.clone(),
            vault_type: crate::replica::AuthorityVaultType::Personal,
            icon: Some("lock".into()),
            image_url: Some("https://example.invalid/vault-image".into()),
            role: crate::replica::AuthorityVaultRole::Owner,
        })
    }
    async fn fetch_vault_keys(
        &self,
        _vault_id: &str,
        cursor: Option<&str>,
    ) -> Result<
        super::create_vault_executor::CreateVaultAuthorityPage,
        super::create_vault_staging::CreateVaultStagingError,
    > {
        let exchange = if cursor.is_none() {
            "key_first"
        } else {
            "key_second"
        };
        self.maybe_fail(exchange)?;
        if exchange == "key_second" {
            self.race_guard("final_commit").await;
        }
        if cursor.is_none() {
            let accepted = self.accepted.lock().unwrap();
            let (_, encrypted_vault_key, _) = accepted.as_ref().unwrap();
            Ok(authority_page(
                vec![crate::server_contract::AuthVaultKeyResponse {
                    encrypted_vault_key: encrypted_vault_key.clone(),
                    role: crate::server_contract::VaultRole::Owner,
                    vault_icon: Some("lock".into()),
                    vault_id: "foreign-vault".into(),
                    vault_image_url: Some("https://example.invalid/vault-image".into()),
                    vault_name: "Foreign matching ciphertext".into(),
                    vault_type: crate::server_contract::VaultType::Personal,
                }],
                true,
                Some("next".into()),
            ))
        } else {
            let accepted = self.accepted.lock().unwrap();
            let (vault_id, encrypted_vault_key, name) = accepted.as_ref().unwrap();
            Ok(authority_page(
                (!self.foreign_only)
                    .then(|| crate::server_contract::AuthVaultKeyResponse {
                        encrypted_vault_key: encrypted_vault_key.clone(),
                        role: crate::server_contract::VaultRole::Owner,
                        vault_icon: Some("lock".into()),
                        vault_id: vault_id.clone(),
                        vault_image_url: Some("https://example.invalid/vault-image".into()),
                        vault_name: name.clone(),
                        vault_type: crate::server_contract::VaultType::Personal,
                    })
                    .into_iter()
                    .collect(),
                false,
                None,
            ))
        }
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
            foreign_only: false,
        },
    )
}

#[tokio::test]
async fn foreign_vault_with_matching_wrapped_ciphertext_cannot_reconcile_created_vault_authority() {
    let (runtime, account_id, operation_id, mut port) = matrix_recovery("none", 0, false).await;
    port.foreign_only = true;
    let before = runtime.replica().snapshot(&account_id).unwrap().operations[0].clone();
    let error = runtime
        .drive_create_vault_recovery_cycle(&account_id, &operation_id, &port, &port)
        .await
        .unwrap_err();
    assert!(matches!(
        error,
        super::create_vault_staging::CreateVaultRecoveryError::Fatal(RuntimeError {
            code: RuntimeErrorCode::InvariantViolation,
            ..
        })
    ));
    let after = runtime.replica().snapshot(&account_id).unwrap();
    assert_eq!(after.operations.len(), 1);
    assert_eq!(after.operations[0].operation_id, before.operation_id);
    assert_eq!(after.operations[0].target, before.target);
    assert_eq!(
        after.operations[0]
            .create_vault
            .as_ref()
            .unwrap()
            .encrypted_vault_key,
        before.create_vault.as_ref().unwrap().encrypted_vault_key
    );
    assert!(after.receipts.is_empty());
}

#[tokio::test]
async fn real_guard_races_at_checkpoint_authority_fetch_and_final_commit_preserve_work() {
    for race_at in ["checkpoint", "authority_fetch", "final_commit"] {
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
    for exchange in [
        "status",
        "grant",
        "upload",
        "confirm",
        "lookup",
        "put",
        "vault",
        "key_first",
        "key_second",
    ] {
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
    for exchange in [
        "status",
        "grant",
        "upload",
        "confirm",
        "lookup",
        "put",
        "vault",
        "key_first",
        "key_second",
    ] {
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
    let runtime = Runtime::with_serialized_replica_executor(
        super::create_tests::create_vault_fenced_executor(),
    );
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
    let runtime = Runtime::with_serialized_replica_executor(
        super::create_tests::create_vault_failing_executor(),
    );
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
    let (operation_id, vault_id) = sources.scope.lock().unwrap().clone().unwrap();
    let metadata = crate::VaultImageArtifactMetadata::new(
        crate::VaultImageArtifactScope::new(account_id, operation_id).unwrap(),
        vault_id,
        11,
        "image/png",
        format!("{:x}", Sha256::digest(b"image-bytes")),
    )
    .unwrap();
    assert!(artifacts.read_all(&metadata).await.is_err());
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
    let metadata = crate::VaultImageArtifactMetadata::new(
        crate::VaultImageArtifactScope::new(account_id.clone(), operation_id).unwrap(),
        vault_id,
        11,
        "image/png",
        format!("{:x}", Sha256::digest(b"image-bytes")),
    )
    .unwrap();
    assert_eq!(
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
    let runtime = Runtime::with_serialized_replica_executor(
        super::create_tests::create_vault_fenced_executor(),
    );
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
    let metadata = crate::VaultImageArtifactMetadata::new(
        crate::VaultImageArtifactScope::new(account_id.clone(), operation_id).unwrap(),
        vault_id,
        11,
        "image/png",
        format!("{:x}", Sha256::digest(b"image-bytes")),
    )
    .unwrap();
    assert_eq!(
        artifacts.inner.read_all(&metadata).await.unwrap(),
        b"image-bytes"
    );

    facade
        .sweep_account(&account_id, &HashSet::new())
        .await
        .unwrap();
    assert!(artifacts.inner.read_all(&metadata).await.is_err());
}

async fn seed_rejected_image_cleanup(
    persistence: &crate::replica::InMemoryReplica,
    operation_id: &str,
) -> crate::replica::OperationRecord {
    seed_image_cleanup(persistence, operation_id, true).await
}

async fn seed_image_cleanup(
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
        attachment_move_recovery: None,
        create_vault: Some(CreateVaultOperationRecord {
            account_id: account_id.clone(),
            name: "Rejected image".into(),
            vault_type: CreateVaultType::Personal,
            icon: "lock".into(),
            encrypted_vault_key: "wrapped".into(),
            image: Some(CreateVaultImageRecord {
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
        Arc::new(PlatformStorage::new(
            operation_fixtures::MemoryPlatform::new(),
        )),
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
    assert_eq!(
        artifacts.read_all(&metadata).await.unwrap().as_slice(),
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
            .read_all(&metadata)
            .await
            .expect("ordinary source retirement must retain accepted PNG bytes")
            .as_slice(),
        bytes.as_slice()
    );
    assert!(
        sources.account_retirements.load(Ordering::SeqCst)
            + sources.runtime_retirements.load(Ordering::SeqCst)
            > 0
    );
    runtime.close().await;
    assert_eq!(
        artifacts.read_all(&metadata).await.unwrap().as_slice(),
        bytes.as_slice()
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
