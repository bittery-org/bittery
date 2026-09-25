use super::sqlite::SqliteVaultImageFailure;
use super::*;
use crate::{
    platform_storage::{
        PlatformStorageRequest, PlatformStorageResponse, SerializedPlatformStorageExecutor,
    },
    replica::InMemoryReplica,
    Runtime, RuntimeRequest, RuntimeResponse, SqliteAttachmentArtifactStore, TeardownHostCleanup,
    TeardownHostCleanupRequest, TeardownHostCleanupResponse, TeardownStatus,
};
use async_trait::async_trait;
use std::{
    collections::{HashSet, VecDeque},
    sync::{Arc, Mutex},
};

#[derive(Clone)]
struct MemorySourcePort {
    chunks: Arc<Mutex<VecDeque<Vec<u8>>>>,
    requests: Arc<Mutex<Vec<usize>>>,
}

fn grant(content_type: &str, byte_length: u64) -> VaultImageSourceGrant {
    VaultImageSourceGrant {
        runtime_incarnation: "runtime-a".into(),
        account_id: AccountId::from("account-a"),
        operation_id: "operation-a".into(),
        vault_id: "vault-a".into(),
        capability_id: "capability-a".into(),
        content_type: content_type.into(),
        byte_length,
    }
}
impl MemorySourcePort {
    fn new(chunks: Vec<Vec<u8>>) -> Self {
        Self {
            chunks: Arc::new(Mutex::new(chunks.into())),
            requests: Arc::new(Mutex::new(Vec::new())),
        }
    }
    fn requests(&self) -> Vec<usize> {
        self.requests.lock().unwrap().clone()
    }
}

#[tokio::test]
async fn protected_facade_ingress_persists_no_raw_generation_and_reopens_exact_image() {
    let mut bytes = b"fresh private image content/".repeat(80_000);
    bytes.truncate(VAULT_IMAGE_MAX_BYTES as usize);
    let path = std::env::temp_dir().join(format!(
        "bittery-image-ingress-{}.sqlite",
        bittery_crypto_core::generate_uuid()
    ));
    let store = Arc::new(SqliteVaultImageArtifactStore::open(&path).unwrap());
    let source = MemorySourcePort::new(
        bytes
            .chunks(protected::PROTECTED_IMAGE_PLAINTEXT_CHUNK_BYTES)
            .flat_map(|chunk| chunk.chunks(17_000).map(<[u8]>::to_vec))
            .collect(),
    );
    let facade =
        VaultImageIngressFacade::new("runtime-a", Arc::new(source.clone()), store.clone()).unwrap();
    let expected = grant("image/png", bytes.len() as u64);
    let prepared = facade
        .prepare_bound_protected(
            expected.account_id.clone(),
            expected.operation_id.clone(),
            expected.vault_id.clone(),
            expected.capability_id.clone(),
            expected.content_type.clone(),
            expected.byte_length,
            &RequestCancellation::new(),
            VaultImageProtection {
                user_id: "user-a",
                device_key: &[7; 32],
            },
        )
        .await
        .unwrap();
    let metadata = prepared.metadata().clone();
    assert!(source
        .requests()
        .iter()
        .all(|size| *size <= protected::PROTECTED_IMAGE_PLAINTEXT_CHUNK_BYTES));
    assert_eq!(source.requests().last(), Some(&1));
    assert!(
        metadata.protection().is_some(),
        "fresh image admission must publish only protected bytes"
    );
    let family =
        VaultImageArtifactScope::new(expected.account_id.clone(), expected.operation_id.clone())
            .unwrap();
    assert!(store
        .read_generation(&family, None)
        .await
        .unwrap()
        .unwrap()
        .scope
        .publication_id()
        .is_some());
    drop(facade);
    drop(store);
    assert!(!std::fs::read(&path)
        .unwrap()
        .windows(28)
        .any(|window| window == b"fresh private image content/"));
    let reopened = Arc::new(SqliteVaultImageArtifactStore::open(&path).unwrap());
    let protection = metadata.protection().unwrap();
    let original = VaultImageArtifactMetadata::new(
        family,
        expected.vault_id,
        expected.byte_length,
        expected.content_type,
        metadata.sha256(),
    )
    .unwrap();
    let facade = VaultImageIngressFacade::new(
        "runtime-reopened",
        Arc::new(MemorySourcePort::new(vec![])),
        reopened.clone(),
    )
    .unwrap();
    let recovered = facade
        .read_protected_bound(
            &original,
            &protection.witness,
            VaultImageProtection {
                user_id: "user-a",
                device_key: &[7; 32],
            },
            &RequestCancellation::new(),
        )
        .await
        .unwrap();
    assert_eq!(*recovered, bytes);
    let cancellation = RequestCancellation::new();
    cancellation.cancel();
    assert_eq!(
        facade
            .read_protected_bound(
                &original,
                &protection.witness,
                VaultImageProtection {
                    user_id: "user-a",
                    device_key: &[7; 32]
                },
                &cancellation
            )
            .await
            .unwrap_err()
            .code,
        RuntimeErrorCode::Cancelled
    );
    assert!(facade
        .read_protected_bound(
            &original,
            &protection.witness,
            VaultImageProtection {
                user_id: "other-user",
                device_key: &[7; 32]
            },
            &RequestCancellation::new()
        )
        .await
        .is_err());
    drop(facade);
    drop(reopened);
    std::fs::remove_file(path).unwrap();
}

#[tokio::test]
async fn legacy_facade_conversion_reuses_publication_and_keeps_raw_until_explicit_generation_cleanup(
) {
    let bytes = b"legacy private image content/".repeat(9000);
    let path = std::env::temp_dir().join(format!(
        "bittery-legacy-image-{}.sqlite",
        bittery_crypto_core::generate_uuid()
    ));
    let store = Arc::new(SqliteVaultImageArtifactStore::open(&path).unwrap());
    let source = MemorySourcePort::new(
        bytes
            .chunks(VAULT_IMAGE_CHUNK_BYTES)
            .map(<[u8]>::to_vec)
            .collect(),
    );
    let facade =
        VaultImageIngressFacade::new("runtime-a", Arc::new(source), store.clone()).unwrap();
    let original = facade
        .prepare(
            grant("image/png", bytes.len() as u64),
            &RequestCancellation::new(),
        )
        .await
        .unwrap()
        .metadata()
        .clone();
    let protected = facade
        .protect_legacy_bound(
            &original,
            VaultImageProtection {
                user_id: "user-a",
                device_key: &[7; 32],
            },
            &RequestCancellation::new(),
        )
        .await
        .unwrap();
    assert!(store.read_chunk(&original, 0).await.unwrap().is_some());
    let retry = facade
        .protect_legacy_bound(
            &original,
            VaultImageProtection {
                user_id: "user-a",
                device_key: &[7; 32],
            },
            &RequestCancellation::new(),
        )
        .await
        .unwrap();
    assert_eq!(retry, protected);
    let witness = &protected.protection().unwrap().witness;
    assert!(store
        .read_generation(original.scope(), Some(&witness.publication_id))
        .await
        .unwrap()
        .is_none());
    let read = facade
        .read_protected_bound(
            &original,
            witness,
            VaultImageProtection {
                user_id: "user-a",
                device_key: &[7; 32],
            },
            &RequestCancellation::new(),
        )
        .await
        .unwrap();
    assert_eq!(*read, bytes);
    store.delete_generation(original.scope()).await.unwrap();
    assert!(store.read_chunk(&original, 0).await.unwrap().is_none());
    assert!(store.read_chunk(&protected, 0).await.unwrap().is_some());
    drop(facade);
    drop(store);
    std::fs::remove_file(path).unwrap();
}

struct MemorySource {
    chunks: Arc<Mutex<VecDeque<Vec<u8>>>>,
    requests: Arc<Mutex<Vec<usize>>>,
}
#[async_trait]
impl VaultImageSource for MemorySource {
    async fn next_chunk(
        &mut self,
        max_bytes: usize,
    ) -> Result<Option<Vec<u8>>, VaultImageSourceError> {
        self.requests.lock().unwrap().push(max_bytes);
        let chunk = self.chunks.lock().unwrap().pop_front();
        if chunk.as_ref().is_some_and(|chunk| chunk.len() > max_bytes) {
            return Err(VaultImageSourceError::Invariant);
        }
        Ok(chunk)
    }
    async fn close(&mut self) -> Result<(), VaultImageSourceError> {
        Ok(())
    }
}
#[async_trait]
impl VaultImageSourcePort for MemorySourcePort {
    async fn claim(
        &self,
        _grant: &VaultImageSourceGrant,
    ) -> Result<Box<dyn VaultImageSource>, VaultImageSourceError> {
        Ok(Box::new(MemorySource {
            chunks: Arc::clone(&self.chunks),
            requests: Arc::clone(&self.requests),
        }))
    }
    async fn retire_account(
        &self,
        _runtime_incarnation: &str,
        _account_id: &AccountId,
    ) -> Result<(), VaultImageSourceError> {
        Ok(())
    }
    async fn complete_account_retirement(
        &self,
        _runtime_incarnation: &str,
        _account_id: &AccountId,
    ) -> Result<(), VaultImageSourceError> {
        Ok(())
    }
    async fn begin_acceptance(
        &self,
        _runtime_incarnation: &str,
        _account_id: &AccountId,
        _operation_id: &str,
    ) -> Result<(), VaultImageSourceError> {
        Ok(())
    }
    async fn end_acceptance(
        &self,
        _runtime_incarnation: &str,
        _account_id: &AccountId,
        _operation_id: &str,
    ) -> Result<(), VaultImageSourceError> {
        Ok(())
    }
    async fn retire_vaults(
        &self,
        _runtime_incarnation: &str,
        _account_id: &AccountId,
        _vault_ids: &[String],
    ) -> Result<(), VaultImageSourceError> {
        Ok(())
    }
    async fn complete_vault_retirement(
        &self,
        _runtime_incarnation: &str,
        _account_id: &AccountId,
        _vault_ids: &[String],
    ) -> Result<(), VaultImageSourceError> {
        Ok(())
    }
    async fn forget_account_vault_retirements(
        &self,
        _runtime_incarnation: &str,
        _account_id: &AccountId,
    ) -> Result<(), VaultImageSourceError> {
        Ok(())
    }
    async fn retire_runtime(
        &self,
        _runtime_incarnation: &str,
    ) -> Result<(), VaultImageSourceError> {
        Ok(())
    }
}

#[tokio::test]
async fn ingress_publishes_exact_plaintext_and_rust_digest() {
    let store = MemoryVaultImageArtifactStore::default();
    let source = MemorySourcePort::new(vec![b"vault image".to_vec()]);
    let ingress = VaultImageIngress::new(source, store.clone());
    let prepared = ingress.prepare(grant("image/png", 11)).await.unwrap();
    assert_eq!(
        prepared.metadata().sha256(),
        "134254bffef4b6d248dd119c70e462878038176a91c1e1f7249fa55b2ee902f5"
    );
    assert_eq!(
        store.read_all(prepared.metadata()).await.unwrap(),
        b"vault image"
    );
}

#[tokio::test]
async fn ingress_accepts_only_the_exact_five_mime_values_and_shared_length_bounds() {
    for content_type in [
        "image/jpeg",
        "image/png",
        "image/webp",
        "image/gif",
        "image/avif",
    ] {
        VaultImageIngress::new(
            MemorySourcePort::new(vec![vec![7]]),
            MemoryVaultImageArtifactStore::default(),
        )
        .prepare(grant(content_type, 1))
        .await
        .unwrap();
    }
    for rejected in [
        "image/jpg",
        "IMAGE/PNG",
        "image/png; charset=utf-8",
        " image/png",
        "image/svg+xml",
        "application/octet-stream",
        "",
    ] {
        let result = VaultImageIngress::new(
            MemorySourcePort::new(vec![vec![7]]),
            MemoryVaultImageArtifactStore::default(),
        )
        .prepare(grant(rejected, 1))
        .await;
        assert_eq!(
            result.unwrap_err().code,
            RuntimeErrorCode::InvariantViolation,
            "{rejected:?}"
        );
    }
    for rejected in [0, VAULT_IMAGE_MAX_BYTES + 1] {
        let result = VaultImageIngress::new(
            MemorySourcePort::new(vec![vec![7]]),
            MemoryVaultImageArtifactStore::default(),
        )
        .prepare(grant("image/png", rejected))
        .await;
        assert_eq!(
            result.unwrap_err().code,
            RuntimeErrorCode::InvariantViolation
        );
    }
}

#[tokio::test]
async fn maximum_image_uses_only_256_kib_reads_and_requires_one_exact_eof_probe() {
    let chunk = vec![9; VAULT_IMAGE_CHUNK_BYTES];
    let chunks = (0..8).map(|_| chunk.clone()).collect::<Vec<_>>();
    let source = MemorySourcePort::new(chunks);
    let prepared = VaultImageIngress::new(source.clone(), MemoryVaultImageArtifactStore::default())
        .prepare(grant("image/avif", VAULT_IMAGE_MAX_BYTES))
        .await
        .unwrap();
    assert_eq!(prepared.metadata().byte_length(), VAULT_IMAGE_MAX_BYTES);
    assert_eq!(
        prepared.metadata().sha256(),
        "131fca71fe404a1b870c8d84b020c32e2ffc1d0a6e686e71be976266b0207f17"
    );
    assert_eq!(
        source.requests(),
        [vec![VAULT_IMAGE_CHUNK_BYTES; 8], vec![1]].concat()
    );
}

#[tokio::test]
async fn ingress_rejects_short_long_and_oversized_chunks_without_leaving_an_artifact() {
    for (declared, chunks) in [
        (2, vec![vec![1]]),
        (1, vec![vec![1], vec![2]]),
        (1, vec![vec![1, 2]]),
    ] {
        let store = MemoryVaultImageArtifactStore::default();
        let result = VaultImageIngress::new(MemorySourcePort::new(chunks), store.clone())
            .prepare(grant("image/png", declared))
            .await;
        assert!(result.is_err());
        let scope =
            VaultImageArtifactScope::new(AccountId::from("account-a"), "operation-a").unwrap();
        let metadata = VaultImageArtifactMetadata::new(
            scope,
            "vault-a",
            1,
            "image/png",
            "4bf5122f344554c53bde2ebb8cd2b7e3d1600ad631c385a5d7c5b5d4c3e5f6e8",
        )
        .unwrap();
        assert!(store.read_all(&metadata).await.is_err());
    }
}

async fn artifact_history(store: &dyn VaultImageArtifactPort) {
    let scope =
        VaultImageArtifactScope::new(AccountId::from("account-history"), "operation-history")
            .unwrap();
    let bytes = b"abc";
    let metadata = VaultImageArtifactMetadata::new(
        scope.clone(),
        "vault-history",
        3,
        "image/webp",
        "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    )
    .unwrap();
    store.begin(&scope).await.unwrap();
    assert_eq!(
        store.write_chunk(&scope, 0, bytes).await.unwrap(),
        VaultImageChunkWrite::Stored
    );
    assert_eq!(
        store.write_chunk(&scope, 0, bytes).await.unwrap(),
        VaultImageChunkWrite::AlreadyStored
    );
    assert!(store.write_chunk(&scope, 0, b"abd").await.is_err());
    assert_eq!(
        store.publish(&metadata).await.unwrap(),
        VaultImagePublication::Published
    );
    assert_eq!(
        store.publish(&metadata).await.unwrap(),
        VaultImagePublication::AlreadyPublished
    );
    assert_eq!(
        store.read_chunk(&metadata, 0).await.unwrap(),
        Some(bytes.to_vec())
    );
    store.delete(&scope).await.unwrap();
    store.delete(&scope).await.unwrap();
    assert_eq!(store.read_chunk(&metadata, 0).await.unwrap(), None);
    let orphan =
        VaultImageArtifactScope::new(AccountId::from("account-history"), "orphan").unwrap();
    let retained =
        VaultImageArtifactScope::new(AccountId::from("account-history"), "retained").unwrap();
    store.begin(&orphan).await.unwrap();
    store.begin(&retained).await.unwrap();
    store
        .sweep_orphans(
            &AccountId::from("account-history"),
            &HashSet::from(["retained".into()]),
        )
        .await
        .unwrap();
    assert!(store.write_chunk(&orphan, 0, b"x").await.is_err());
    assert_eq!(
        store.write_chunk(&retained, 0, b"x").await.unwrap(),
        VaultImageChunkWrite::Stored
    );
}

#[tokio::test]
async fn memory_artifact_port_obeys_replay_conflict_publication_deletion_and_sweep_history() {
    artifact_history(&MemoryVaultImageArtifactStore::default()).await;
}

#[tokio::test]
async fn sqlite_artifact_port_obeys_the_same_history_across_restart() {
    let path = std::env::temp_dir().join(format!(
        "bittery-vault-image-{}.sqlite",
        bittery_crypto_core::generate_uuid()
    ));
    artifact_history(&SqliteVaultImageArtifactStore::open(&path).unwrap()).await;
    let restarted = SqliteVaultImageArtifactStore::open(&path).unwrap();
    let retained =
        VaultImageArtifactScope::new(AccountId::from("account-history"), "retained").unwrap();
    assert_eq!(
        restarted.write_chunk(&retained, 0, b"x").await.unwrap(),
        VaultImageChunkWrite::AlreadyStored
    );
}

#[tokio::test]
async fn sqlite_rolls_back_every_chunk_publication_delete_and_sweep_failure_boundary() {
    for boundary in [1, 2] {
        let path = std::env::temp_dir().join(format!(
            "bittery-vault-image-write-{boundary}-{}.sqlite",
            bittery_crypto_core::generate_uuid()
        ));
        let scope =
            VaultImageArtifactScope::new(AccountId::from("account-fault"), "operation-fault")
                .unwrap();
        SqliteVaultImageArtifactStore::open(&path)
            .unwrap()
            .begin(&scope)
            .await
            .unwrap();
        let failing = SqliteVaultImageArtifactStore::open_failing(
            &path,
            SqliteVaultImageFailure::WriteChunk,
            boundary,
        )
        .unwrap();
        assert!(failing.write_chunk(&scope, 0, b"abc").await.is_err());
        let resumed = SqliteVaultImageArtifactStore::open(&path).unwrap();
        assert_eq!(
            resumed.write_chunk(&scope, 0, b"abc").await.unwrap(),
            VaultImageChunkWrite::Stored
        );
    }
    for boundary in [1, 2] {
        let path = std::env::temp_dir().join(format!(
            "bittery-vault-image-publish-{boundary}-{}.sqlite",
            bittery_crypto_core::generate_uuid()
        ));
        let scope =
            VaultImageArtifactScope::new(AccountId::from("account-fault"), "operation-fault")
                .unwrap();
        let metadata = VaultImageArtifactMetadata::new(
            scope.clone(),
            "vault-fault",
            3,
            "image/png",
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
        )
        .unwrap();
        let seed = SqliteVaultImageArtifactStore::open(&path).unwrap();
        seed.begin(&scope).await.unwrap();
        seed.write_chunk(&scope, 0, b"abc").await.unwrap();
        assert!(SqliteVaultImageArtifactStore::open_failing(
            &path,
            SqliteVaultImageFailure::Publish,
            boundary
        )
        .unwrap()
        .publish(&metadata)
        .await
        .is_err());
        assert_eq!(
            SqliteVaultImageArtifactStore::open(&path)
                .unwrap()
                .publish(&metadata)
                .await
                .unwrap(),
            VaultImagePublication::Published
        );
        assert!(SqliteVaultImageArtifactStore::open_failing(
            &path,
            SqliteVaultImageFailure::Delete,
            boundary
        )
        .unwrap()
        .delete(&scope)
        .await
        .is_err());
        assert_eq!(
            SqliteVaultImageArtifactStore::open(&path)
                .unwrap()
                .read_chunk(&metadata, 0)
                .await
                .unwrap(),
            Some(b"abc".to_vec())
        );
    }
    for boundary in [1, 2] {
        let path = std::env::temp_dir().join(format!(
            "bittery-vault-image-sweep-{boundary}-{}.sqlite",
            bittery_crypto_core::generate_uuid()
        ));
        let scope =
            VaultImageArtifactScope::new(AccountId::from("account-fault"), "orphan").unwrap();
        SqliteVaultImageArtifactStore::open(&path)
            .unwrap()
            .begin(&scope)
            .await
            .unwrap();
        assert!(SqliteVaultImageArtifactStore::open_failing(
            &path,
            SqliteVaultImageFailure::Sweep,
            boundary
        )
        .unwrap()
        .sweep_orphans(&AccountId::from("account-fault"), &HashSet::new())
        .await
        .is_err());
        assert_eq!(
            SqliteVaultImageArtifactStore::open(&path)
                .unwrap()
                .write_chunk(&scope, 0, b"x")
                .await
                .unwrap(),
            VaultImageChunkWrite::Stored
        );
    }
}

#[tokio::test]
async fn sqlite_retains_begin_account_delete_and_wipe_obligations_across_restart() {
    for boundary in [1, 2] {
        let begin_path = std::env::temp_dir().join(format!(
            "bittery-vault-image-begin-{boundary}-{}.sqlite",
            bittery_crypto_core::generate_uuid()
        ));
        let scope =
            VaultImageArtifactScope::new(AccountId::from("account-fault"), "operation-fault")
                .unwrap();
        assert!(SqliteVaultImageArtifactStore::open_failing(
            &begin_path,
            SqliteVaultImageFailure::Begin,
            boundary,
        )
        .unwrap()
        .begin(&scope)
        .await
        .is_err());
        SqliteVaultImageArtifactStore::open(&begin_path)
            .unwrap()
            .begin(&scope)
            .await
            .unwrap();

        for failure in [
            SqliteVaultImageFailure::DeleteAccount,
            SqliteVaultImageFailure::Wipe,
        ] {
            let path = std::env::temp_dir().join(format!(
                "bittery-vault-image-retirement-{failure:?}-{boundary}-{}.sqlite",
                bittery_crypto_core::generate_uuid()
            ));
            let store = SqliteVaultImageArtifactStore::open(&path).unwrap();
            store.begin(&scope).await.unwrap();
            store.write_chunk(&scope, 0, b"abc").await.unwrap();
            let metadata = VaultImageArtifactMetadata::new(
                scope.clone(),
                "vault-fault",
                3,
                "image/png",
                "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
            )
            .unwrap();
            store.publish(&metadata).await.unwrap();
            let failing =
                SqliteVaultImageArtifactStore::open_failing(&path, failure, boundary).unwrap();
            let result = match failure {
                SqliteVaultImageFailure::DeleteAccount => {
                    failing
                        .delete_account(&AccountId::from("account-fault"))
                        .await
                }
                SqliteVaultImageFailure::Wipe => failing.wipe().await,
                _ => unreachable!(),
            };
            assert!(result.is_err());
            assert_eq!(
                SqliteVaultImageArtifactStore::open(&path)
                    .unwrap()
                    .read_chunk(&metadata, 0)
                    .await
                    .unwrap(),
                Some(b"abc".to_vec())
            );
        }
    }
}

#[derive(Clone)]
struct HeldRetirementSourcePort {
    entered: Arc<tokio::sync::Notify>,
    release: Arc<tokio::sync::Notify>,
}
#[async_trait]
impl VaultImageSourcePort for HeldRetirementSourcePort {
    async fn claim(
        &self,
        _grant: &VaultImageSourceGrant,
    ) -> Result<Box<dyn VaultImageSource>, VaultImageSourceError> {
        Err(VaultImageSourceError::Invariant)
    }
    async fn retire_account(
        &self,
        _runtime_incarnation: &str,
        _account_id: &AccountId,
    ) -> Result<(), VaultImageSourceError> {
        self.entered.notify_waiters();
        self.release.notified().await;
        Ok(())
    }
    async fn complete_account_retirement(
        &self,
        _runtime_incarnation: &str,
        _account_id: &AccountId,
    ) -> Result<(), VaultImageSourceError> {
        Ok(())
    }
    async fn begin_acceptance(
        &self,
        _runtime_incarnation: &str,
        _account_id: &AccountId,
        _operation_id: &str,
    ) -> Result<(), VaultImageSourceError> {
        Ok(())
    }
    async fn end_acceptance(
        &self,
        _runtime_incarnation: &str,
        _account_id: &AccountId,
        _operation_id: &str,
    ) -> Result<(), VaultImageSourceError> {
        Ok(())
    }
    async fn retire_vaults(
        &self,
        _runtime_incarnation: &str,
        _account_id: &AccountId,
        _vault_ids: &[String],
    ) -> Result<(), VaultImageSourceError> {
        Ok(())
    }
    async fn complete_vault_retirement(
        &self,
        _runtime_incarnation: &str,
        _account_id: &AccountId,
        _vault_ids: &[String],
    ) -> Result<(), VaultImageSourceError> {
        Ok(())
    }
    async fn forget_account_vault_retirements(
        &self,
        _runtime_incarnation: &str,
        _account_id: &AccountId,
    ) -> Result<(), VaultImageSourceError> {
        Ok(())
    }
    async fn retire_runtime(
        &self,
        _runtime_incarnation: &str,
    ) -> Result<(), VaultImageSourceError> {
        self.entered.notify_waiters();
        self.release.notified().await;
        Ok(())
    }
}

struct EmptyRetirementHost;

#[async_trait]
impl SerializedPlatformStorageExecutor for EmptyRetirementHost {
    async fn invoke(
        &self,
        request_json: zeroize::Zeroizing<String>,
    ) -> Result<zeroize::Zeroizing<String>, RuntimeError> {
        let response = match serde_json::from_str::<PlatformStorageRequest>(&request_json).unwrap()
        {
            PlatformStorageRequest::Get { .. } => PlatformStorageResponse::Value { value: None },
            PlatformStorageRequest::Delete { .. } | PlatformStorageRequest::DeletePrefix { .. } => {
                PlatformStorageResponse::Done
            }
            PlatformStorageRequest::Set { .. } => {
                panic!("empty retirement fixture must not install Account state")
            }
            PlatformStorageRequest::ListKeys { .. } => {
                panic!("empty retirement fixture does not provide profile inventory")
            }
            PlatformStorageRequest::DeleteIfUnchanged { .. } => {
                panic!("empty retirement fixture does not abort profile admission")
            }
        };
        Ok(zeroize::Zeroizing::new(
            serde_json::to_string(&response).unwrap(),
        ))
    }
}

#[async_trait]
impl TeardownHostCleanup for EmptyRetirementHost {
    async fn invoke(
        &self,
        request: TeardownHostCleanupRequest,
    ) -> Result<TeardownHostCleanupResponse, RuntimeError> {
        Ok(match request {
            TeardownHostCleanupRequest::DeleteAccount { account_id } => {
                assert_eq!(account_id, AccountId::from("account-lifecycle"));
                TeardownHostCleanupResponse::AccountDeleted
            }
            TeardownHostCleanupRequest::WipeDevice => TeardownHostCleanupResponse::DeviceWiped,
        })
    }
}

#[tokio::test]
async fn runtime_lock_signout_remove_wipe_and_close_wait_for_vault_image_retirement() {
    for authority in ["lock", "signOut", "remove", "wipe", "close"] {
        let entered = Arc::new(tokio::sync::Notify::new());
        let release = Arc::new(tokio::sync::Notify::new());
        let runtime = Runtime::with_test_teardown_environment(
            Arc::new(InMemoryReplica::default()),
            Arc::new(EmptyRetirementHost),
            Arc::new(SqliteAttachmentArtifactStore::open(":memory:").unwrap()),
            Arc::new(EmptyRetirementHost),
        );
        runtime.install_vault_image_ingress(
            VaultImageIngressFacade::new(
                "runtime-a",
                Arc::new(HeldRetirementSourcePort {
                    entered: Arc::clone(&entered),
                    release: Arc::clone(&release),
                }),
                Arc::new(MemoryVaultImageArtifactStore::default()),
            )
            .unwrap(),
        );
        runtime.open().await.unwrap();
        let account_id = AccountId::from("account-lifecycle");
        let running = {
            let runtime = Arc::clone(&runtime);
            tokio::spawn(async move {
                match authority {
                    "lock" => runtime
                        .request(
                            RuntimeRequest::Lock { account_id },
                            RequestCancellation::new(),
                        )
                        .await
                        .map(|_| ()),
                    "signOut" => runtime
                        .request(
                            RuntimeRequest::SignOut { account_id },
                            RequestCancellation::new(),
                        )
                        .await
                        .map(|_| ()),
                    "remove" => runtime
                        .request(
                            RuntimeRequest::RemoveAccount { account_id },
                            RequestCancellation::new(),
                        )
                        .await
                        .map(|response| {
                            assert!(matches!(
                                response,
                                RuntimeResponse::Teardown {
                                    status: TeardownStatus::Complete,
                                    failures,
                                    ..
                                } if failures.is_empty()
                            ));
                        }),
                    "wipe" => runtime
                        .request(RuntimeRequest::Wipe, RequestCancellation::new())
                        .await
                        .map(|response| {
                            assert!(matches!(
                                response,
                                RuntimeResponse::Teardown {
                                    status: TeardownStatus::Complete,
                                    failures,
                                    ..
                                } if failures.is_empty()
                            ));
                        }),
                    "close" => {
                        runtime.close().await;
                        Ok(())
                    }
                    _ => unreachable!(),
                }
            })
        };
        tokio::time::timeout(std::time::Duration::from_secs(3), entered.notified())
            .await
            .unwrap_or_else(|_| {
                panic!(
                    "{authority} never reached image retirement; request finished: {}",
                    running.is_finished()
                )
            });
        assert!(
            !running.is_finished(),
            "{authority} did not wait for retirement"
        );
        release.notify_waiters();
        tokio::time::timeout(std::time::Duration::from_secs(3), running)
            .await
            .unwrap_or_else(|_| panic!("{authority} did not finish after image retirement"))
            .unwrap()
            .unwrap();
    }
}
