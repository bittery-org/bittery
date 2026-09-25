//! Scoped protection of accepted image bytes using the existing crypto primitives.
//! Runtime current-authority admission remains outside this storage representation.

use super::{
    invariant, is_lowercase_sha256, validate_identity, VaultImageArtifactMetadata,
    VaultImageArtifactScope, VAULT_IMAGE_CHUNK_BYTES, VAULT_IMAGE_MAX_BYTES,
};
use crate::RuntimeError;
use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use bittery_crypto_core::{
    decrypt_with_aad, encrypt_with_aad, generate_encryption_key, generate_uuid, AadContext,
    EncryptedData,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use zeroize::Zeroizing;

pub(crate) mod recovery;

pub(crate) const PROTECTED_IMAGE_PLAINTEXT_CHUNK_BYTES: usize = 128 * 1024;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(
    any(
        feature = "vault-image-contract-schema",
        feature = "persistence-contract-schema"
    ),
    derive(schemars::JsonSchema)
)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProtectedImageWitness {
    #[cfg_attr(
        any(
            feature = "vault-image-contract-schema",
            feature = "persistence-contract-schema"
        ),
        schemars(range(min = 1, max = 1))
    )]
    pub format_version: u32,
    pub publication_id: String,
    pub ciphertext_sha256: String,
    #[cfg_attr(
        any(
            feature = "vault-image-contract-schema",
            feature = "persistence-contract-schema"
        ),
        schemars(range(min = 1, max = 4_194_304_u64))
    )]
    pub ciphertext_byte_length: u64,
    #[cfg_attr(
        any(
            feature = "vault-image-contract-schema",
            feature = "persistence-contract-schema"
        ),
        schemars(range(min = 1, max = 16))
    )]
    pub chunk_count: u32,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "vault-image-contract-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ImageIdentity {
    account_id: String,
    operation_id: String,
    vault_id: String,
    user_id: String,
}
impl ImageIdentity {
    fn new(
        scope: &VaultImageArtifactScope,
        vault_id: &str,
        user_id: &str,
    ) -> Result<Self, RuntimeError> {
        validate_identity(vault_id, "Vault")?;
        validate_identity(user_id, "User")?;
        Ok(Self {
            account_id: scope.account_id().as_str().into(),
            operation_id: scope.operation_id().into(),
            vault_id: vault_id.into(),
            user_id: user_id.into(),
        })
    }

    fn context(&self, publication: &str, chunk: Option<u32>) -> Result<AadContext, RuntimeError> {
        let entity_id = match chunk {
            Some(index) => {
                serde_json::to_string(&(&self.account_id, &self.operation_id, publication, index))
            }
            None => serde_json::to_string(&(&self.account_id, &self.operation_id, publication)),
        }
        .map_err(|_| invalid())?;
        Ok(AadContext {
            vault_id: self.vault_id.clone(),
            entity_id,
            entity_type: if chunk.is_some() {
                "vaultImageArtifactChunk"
            } else {
                "vaultImageArtifactKey"
            }
            .into(),
            version: 1,
            user_id: self.user_id.clone(),
        })
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "vault-image-contract-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ImageBinding {
    identity: ImageIdentity,
    #[cfg_attr(
        feature = "vault-image-contract-schema",
        schemars(range(min = 1, max = 2_097_152_u64))
    )]
    byte_length: u64,
    content_type: String,
    sha256: String,
}
impl ImageBinding {
    fn new(metadata: &VaultImageArtifactMetadata, user_id: &str) -> Result<Self, RuntimeError> {
        Ok(Self {
            identity: ImageIdentity::new(metadata.scope(), metadata.vault_id(), user_id)?,
            byte_length: metadata.byte_length(),
            content_type: metadata.content_type().into(),
            sha256: metadata.sha256().into(),
        })
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[cfg_attr(feature = "vault-image-contract-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProtectedImageMetadata {
    pub witness: ProtectedImageWitness,
    binding: ImageBinding,
    wrapped_key: EncryptedData,
}

impl PartialEq for ProtectedImageMetadata {
    fn eq(&self, other: &Self) -> bool {
        self.witness == other.witness
            && self.binding == other.binding
            && self.wrapped_key.algorithm == other.wrapped_key.algorithm
            && self.wrapped_key.iv == other.wrapped_key.iv
            && self.wrapped_key.ciphertext == other.wrapped_key.ciphertext
    }
}
impl Eq for ProtectedImageMetadata {}

impl ProtectedImageMetadata {
    pub(super) fn matches_original(
        &self,
        metadata: &VaultImageArtifactMetadata,
    ) -> Result<bool, RuntimeError> {
        Ok(self.binding == ImageBinding::new(metadata, &self.binding.identity.user_id)?)
    }
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct KeyPayload {
    binding: ImageBinding,
    witness: ProtectedImageWitness,
    artifact_key: Zeroizing<String>,
}

pub(crate) struct ProtectedImageWriter {
    identity: ImageIdentity,
    publication_id: String,
    key: Zeroizing<[u8; 32]>,
    plaintext_hash: Sha256,
    plaintext_length: u64,
    ciphertext_hash: Sha256,
    ciphertext_length: u64,
    chunk_count: u32,
    last_chunk_short: bool,
    failed: bool,
}
impl ProtectedImageWriter {
    pub(super) fn publication_id(&self) -> &str {
        &self.publication_id
    }

    pub(crate) fn new(
        scope: VaultImageArtifactScope,
        vault_id: &str,
        user_id: &str,
    ) -> Result<Self, RuntimeError> {
        Ok(Self {
            identity: ImageIdentity::new(&scope, vault_id, user_id)?,
            publication_id: generate_uuid(),
            key: Zeroizing::new(generate_encryption_key()),
            plaintext_hash: Sha256::new(),
            plaintext_length: 0,
            ciphertext_hash: Sha256::new(),
            ciphertext_length: 0,
            chunk_count: 0,
            last_chunk_short: false,
            failed: false,
        })
    }

    pub(crate) fn push(&mut self, bytes: &[u8]) -> Result<Vec<u8>, RuntimeError> {
        let unavailable = self.failed || self.last_chunk_short;
        self.failed = true;
        if unavailable
            || bytes.is_empty()
            || bytes.len() > PROTECTED_IMAGE_PLAINTEXT_CHUNK_BYTES
            || self.plaintext_length + bytes.len() as u64 > VAULT_IMAGE_MAX_BYTES
        {
            return Err(invalid());
        }
        let encoded = Zeroizing::new(BASE64.encode(bytes));
        let encrypted = encrypt_with_aad(
            &encoded,
            self.key.as_ref(),
            &self
                .identity
                .context(&self.publication_id, Some(self.chunk_count))?,
        )
        .map_err(|_| invalid())?;
        let output = serde_json::to_vec(&encrypted).map_err(|_| invalid())?;
        if output.len() > VAULT_IMAGE_CHUNK_BYTES {
            return Err(invalid());
        }
        self.plaintext_hash.update(bytes);
        self.plaintext_length += bytes.len() as u64;
        self.ciphertext_hash.update(&output);
        self.ciphertext_length += output.len() as u64;
        self.chunk_count += 1;
        self.last_chunk_short = bytes.len() < PROTECTED_IMAGE_PLAINTEXT_CHUNK_BYTES;
        self.failed = false;
        Ok(output)
    }

    pub(crate) fn finish(
        self,
        metadata: &VaultImageArtifactMetadata,
        device_key: &[u8],
    ) -> Result<ProtectedImageMetadata, RuntimeError> {
        let binding = ImageBinding::new(metadata, &self.identity.user_id)?;
        if self.failed
            || self.chunk_count == 0
            || self.identity != binding.identity
            || self.plaintext_length != metadata.byte_length()
            || format!("{:x}", self.plaintext_hash.finalize()) != metadata.sha256()
        {
            return Err(invalid());
        }
        let witness = ProtectedImageWitness {
            format_version: 1,
            publication_id: self.publication_id,
            ciphertext_sha256: format!("{:x}", self.ciphertext_hash.finalize()),
            ciphertext_byte_length: self.ciphertext_length,
            chunk_count: self.chunk_count,
        };
        let payload = KeyPayload {
            binding: binding.clone(),
            witness: witness.clone(),
            artifact_key: Zeroizing::new(BASE64.encode(self.key.as_ref())),
        };
        validate_key_payload(&payload, metadata, &self.identity.user_id, &witness)?;
        let wrapped_key = wrap_key_payload(&payload, device_key)?;
        Ok(ProtectedImageMetadata {
            witness,
            binding,
            wrapped_key,
        })
    }
}

/// Validate immutable opaque storage bytes without opening the wrapped key or image plaintext.
pub(super) fn verify_ciphertext<B: AsRef<[u8]>>(
    expected: &VaultImageArtifactMetadata,
    metadata: &ProtectedImageMetadata,
    chunks: &[B],
) -> Result<(), RuntimeError> {
    validate_protected_metadata(expected, metadata)?;
    let witness = &metadata.witness;
    if witness.chunk_count as usize != chunks.len() {
        return Err(invalid());
    }
    let mut hash = Sha256::new();
    let mut length = 0_u64;
    for chunk in chunks {
        let chunk = chunk.as_ref();
        if chunk.is_empty() || chunk.len() > VAULT_IMAGE_CHUNK_BYTES {
            return Err(invalid());
        }
        length += chunk.len() as u64;
        hash.update(chunk);
    }
    if length != witness.ciphertext_byte_length
        || format!("{:x}", hash.finalize()) != witness.ciphertext_sha256
    {
        return Err(invalid());
    }
    Ok(())
}

pub(crate) fn validate_witness(
    witness: &ProtectedImageWitness,
    byte_length: u64,
) -> Result<(), RuntimeError> {
    if !(1..=VAULT_IMAGE_MAX_BYTES).contains(&byte_length)
        || witness.format_version != 1
        || !is_lowercase_sha256(&witness.ciphertext_sha256)
        || u64::from(witness.chunk_count)
            != byte_length.div_ceil(PROTECTED_IMAGE_PLAINTEXT_CHUNK_BYTES as u64)
        || witness.ciphertext_byte_length < u64::from(witness.chunk_count)
        || witness.ciphertext_byte_length
            > u64::from(witness.chunk_count) * VAULT_IMAGE_CHUNK_BYTES as u64
    {
        return Err(invalid());
    }
    validate_identity(&witness.publication_id, "Image publication")?;
    Ok(())
}

pub(super) fn validate_protected_metadata(
    expected: &VaultImageArtifactMetadata,
    metadata: &ProtectedImageMetadata,
) -> Result<(), RuntimeError> {
    validate_witness(&metadata.witness, expected.byte_length())?;
    if !metadata.matches_original(expected)?
        || metadata.wrapped_key.ciphertext.len() > 4096
        || metadata.wrapped_key.iv.len() > 32
        || metadata.wrapped_key.algorithm != "AES-GCM-AAD-V1"
    {
        return Err(invalid());
    }
    Ok(())
}

/// The portable recovery child validates the same accepted scope without opening image bytes.
fn validate_key_payload(
    payload: &KeyPayload,
    expected: &VaultImageArtifactMetadata,
    user_id: &str,
    witness: &ProtectedImageWitness,
) -> Result<Zeroizing<[u8; 32]>, RuntimeError> {
    validate_witness(witness, expected.byte_length())?;
    if payload.binding != ImageBinding::new(expected, user_id)? || payload.witness != *witness {
        return Err(invalid());
    }
    let bytes = Zeroizing::new(
        BASE64
            .decode(payload.artifact_key.as_bytes())
            .map_err(|_| invalid())?,
    );
    if bytes.len() != 32 {
        return Err(invalid());
    }
    let mut key = Zeroizing::new([0; 32]);
    key.copy_from_slice(&bytes);
    Ok(key)
}

pub(crate) fn validate_metadata_scope(
    expected: &VaultImageArtifactMetadata,
    user_id: &str,
    witness: &ProtectedImageWitness,
    metadata: &ProtectedImageMetadata,
) -> Result<(), RuntimeError> {
    validate_protected_metadata(expected, metadata)?;
    if metadata.binding != ImageBinding::new(expected, user_id)? || metadata.witness != *witness {
        return Err(invalid());
    }
    Ok(())
}

fn unwrap_key_payload(
    expected: &VaultImageArtifactMetadata,
    user_id: &str,
    witness: &ProtectedImageWitness,
    metadata: &ProtectedImageMetadata,
    device_key: &[u8],
) -> Result<KeyPayload, RuntimeError> {
    validate_metadata_scope(expected, user_id, witness, metadata)?;
    let plaintext = Zeroizing::new(
        decrypt_with_aad(
            &metadata.wrapped_key,
            device_key,
            &metadata
                .binding
                .identity
                .context(&witness.publication_id, None)?,
        )
        .map_err(|_| invalid())?,
    );
    let payload: KeyPayload = serde_json::from_str(&plaintext).map_err(|_| invalid())?;
    validate_key_payload(&payload, expected, user_id, witness)?;
    Ok(payload)
}

/// Caller has matched this private payload against the immutable accepted witness and scope.
fn wrap_key_payload(
    payload: &KeyPayload,
    device_key: &[u8],
) -> Result<EncryptedData, RuntimeError> {
    let encoded = Zeroizing::new(serde_json::to_string(payload).map_err(|_| invalid())?);
    encrypt_with_aad(
        &encoded,
        device_key,
        &payload
            .binding
            .identity
            .context(&payload.witness.publication_id, None)?,
    )
    .map_err(|_| invalid())
}

/// Validate an already published conversion without opening any image envelope. This is
/// storage-upgrade work and does not establish current Vault read authority.
pub(crate) fn verify_protected_publication(
    expected: &VaultImageArtifactMetadata,
    user_id: &str,
    witness: &ProtectedImageWitness,
    metadata: &ProtectedImageMetadata,
    chunks: &[Vec<u8>],
    device_key: &[u8],
) -> Result<(), RuntimeError> {
    verify_ciphertext(expected, metadata, chunks)?;
    unwrap_key_payload(expected, user_id, witness, metadata, device_key)?;
    Ok(())
}

/// Called only after Core has admitted the current scoped read. This primitive validates stored
/// representation; an accepted witness or a Device key is not a current-authority capability.
pub(crate) fn read_protected_image(
    expected: &VaultImageArtifactMetadata,
    user_id: &str,
    witness: &ProtectedImageWitness,
    metadata: &ProtectedImageMetadata,
    chunks: &[Vec<u8>],
    device_key: &[u8],
) -> Result<Zeroizing<Vec<u8>>, RuntimeError> {
    let binding = ImageBinding::new(expected, user_id)?;
    verify_ciphertext(expected, metadata, chunks)?;
    let payload = unwrap_key_payload(expected, user_id, witness, metadata, device_key)?;
    let key = validate_key_payload(&payload, expected, user_id, witness)?;
    let mut plaintext = Zeroizing::new(Vec::with_capacity(expected.byte_length() as usize));
    for (index, chunk) in chunks.iter().enumerate() {
        let encrypted: EncryptedData = serde_json::from_slice(chunk).map_err(|_| invalid())?;
        let encoded = Zeroizing::new(
            decrypt_with_aad(
                &encrypted,
                key.as_ref(),
                &binding
                    .identity
                    .context(&witness.publication_id, Some(index as u32))?,
            )
            .map_err(|_| invalid())?,
        );
        let bytes = Zeroizing::new(BASE64.decode(encoded.as_bytes()).map_err(|_| invalid())?);
        if bytes.is_empty()
            || bytes.len() > PROTECTED_IMAGE_PLAINTEXT_CHUNK_BYTES
            || (index + 1 < chunks.len() && bytes.len() != PROTECTED_IMAGE_PLAINTEXT_CHUNK_BYTES)
            || plaintext.len() as u64 + bytes.len() as u64 > expected.byte_length()
        {
            return Err(invalid());
        }
        plaintext.extend_from_slice(&bytes);
    }
    if plaintext.len() as u64 != expected.byte_length()
        || format!("{:x}", Sha256::digest(plaintext.as_slice())) != expected.sha256()
    {
        return Err(invalid());
    }
    Ok(plaintext)
}

fn invalid() -> RuntimeError {
    invariant("Protected Vault image is invalid")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{vault_image::VAULT_IMAGE_CHUNK_BYTES, AccountId};
    use sha2::{Digest, Sha256};

    #[cfg(not(target_arch = "wasm32"))]
    #[tokio::test]
    async fn existing_sqlite_store_publishes_and_reopens_only_protected_image_bytes() {
        use crate::vault_image::{SqliteVaultImageArtifactStore, VaultImageArtifactPort};
        let fixture = fixture();
        let metadata = fixture
            .original
            .clone()
            .with_protection(fixture.metadata.clone())
            .unwrap();
        let path = std::env::temp_dir().join(format!(
            "bittery-protected-image-{}.sqlite",
            generate_uuid()
        ));
        let store = SqliteVaultImageArtifactStore::open(&path).unwrap();
        store.begin(metadata.scope()).await.unwrap();
        for (index, chunk) in fixture.chunks.iter().enumerate() {
            store
                .write_chunk(metadata.scope(), index as u32, chunk)
                .await
                .unwrap();
        }
        store.publish(&metadata).await.unwrap();
        drop(store);
        let disk = std::fs::read(&path).unwrap();
        let marker = b"private image content/";
        assert!(!disk.windows(marker.len()).any(|window| window == marker));
        let reopened = SqliteVaultImageArtifactStore::open(&path).unwrap();
        let mut chunks = Vec::new();
        for index in 0..fixture.metadata.witness.chunk_count {
            chunks.push(
                reopened
                    .read_chunk(&metadata, index)
                    .await
                    .unwrap()
                    .unwrap(),
            );
        }
        assert_eq!(chunks, fixture.chunks);
        assert_eq!(
            read_protected_image(
                &fixture.original,
                "user-a",
                &fixture.metadata.witness,
                metadata.protection().unwrap(),
                &chunks,
                &[7; 32]
            )
            .unwrap()
            .as_slice(),
            fixture.bytes
        );
        reopened.delete(metadata.scope()).await.unwrap();
        drop(reopened);
        std::fs::remove_file(path).unwrap();
    }

    pub(super) struct Fixture {
        pub(super) original: VaultImageArtifactMetadata,
        pub(super) metadata: ProtectedImageMetadata,
        pub(super) chunks: Vec<Vec<u8>>,
        pub(super) bytes: Vec<u8>,
    }

    #[cfg(not(target_arch = "wasm32"))]
    async fn legacy_wal_fixture() -> (
        Fixture,
        VaultImageArtifactMetadata,
        crate::SqliteVaultImageArtifactStore,
        rusqlite::Connection,
        std::path::PathBuf,
    ) {
        use crate::VaultImageArtifactPort;
        let fixture = fixture();
        let path =
            std::env::temp_dir().join(format!("bittery-image-erasure-{}.sqlite", generate_uuid()));
        let keeper = rusqlite::Connection::open(&path).unwrap();
        keeper
            .execute_batch(
                "PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; PRAGMA secure_delete=OFF;",
            )
            .unwrap();
        keeper
            .execute_batch(crate::vault_image::sqlite::RAW_SCHEMA)
            .unwrap();
        keeper
            .execute(
                "INSERT INTO vault_image_artifacts VALUES(?1,?2,?3,?4,?5,?6,1)",
                rusqlite::params![
                    fixture.original.account_id().as_str(),
                    fixture.original.operation_id(),
                    fixture.original.vault_id(),
                    fixture.original.byte_length() as i64,
                    fixture.original.content_type(),
                    fixture.original.sha256()
                ],
            )
            .unwrap();
        for (index, chunk) in fixture.bytes.chunks(VAULT_IMAGE_CHUNK_BYTES).enumerate() {
            keeper
                .execute(
                    "INSERT INTO vault_image_artifact_chunks VALUES(?1,?2,?3,?4)",
                    rusqlite::params![
                        fixture.original.account_id().as_str(),
                        fixture.original.operation_id(),
                        index as i64,
                        chunk
                    ],
                )
                .unwrap();
        }
        let store = crate::SqliteVaultImageArtifactStore::open(&path).unwrap();
        let metadata = fixture
            .original
            .clone()
            .with_protection(fixture.metadata.clone())
            .unwrap();
        store.begin(metadata.scope()).await.unwrap();
        for (index, chunk) in fixture.chunks.iter().enumerate() {
            store
                .write_chunk(metadata.scope(), index as u32, chunk)
                .await
                .unwrap();
        }
        store.publish(&metadata).await.unwrap();
        (fixture, metadata, store, keeper, path)
    }

    #[cfg(not(target_arch = "wasm32"))]
    fn physical_image_marker_exists(path: &std::path::Path) -> bool {
        let marker = b"private image content/";
        [
            path.to_path_buf(),
            std::path::PathBuf::from(format!("{}-wal", path.display())),
        ]
        .iter()
        .any(|path| {
            std::fs::read(path)
                .unwrap_or_default()
                .windows(marker.len())
                .any(|part| part == marker)
        })
    }

    #[cfg(not(target_arch = "wasm32"))]
    #[tokio::test]
    async fn raw_generation_cleanup_removes_prior_database_and_wal_image_bytes() {
        use crate::VaultImageArtifactPort;
        let (fixture, metadata, store, keeper, path) = legacy_wal_fixture().await;
        assert!(physical_image_marker_exists(&path));
        store
            .delete_generation(fixture.original.scope())
            .await
            .unwrap();
        assert!(!physical_image_marker_exists(&path));
        assert_eq!(
            store.read_chunk(&metadata, 0).await.unwrap().unwrap(),
            fixture.chunks[0]
        );
        drop(store);
        drop(keeper);
        std::fs::remove_file(path).unwrap();
    }

    #[cfg(not(target_arch = "wasm32"))]
    #[tokio::test]
    async fn raw_generation_cleanup_busy_is_not_acknowledged_and_replays_after_row_loss() {
        use crate::VaultImageArtifactPort;
        let (fixture, metadata, store, keeper, path) = legacy_wal_fixture().await;
        keeper
            .execute_batch("BEGIN; SELECT COUNT(*) FROM vault_image_artifacts;")
            .unwrap();
        assert_eq!(
            store
                .delete_generation(fixture.original.scope())
                .await
                .unwrap_err()
                .code,
            crate::RuntimeErrorCode::StorageUnavailable
        );
        assert!(store
            .read_chunk(&fixture.original, 0)
            .await
            .unwrap()
            .is_none());
        assert!(physical_image_marker_exists(&path));
        assert_eq!(
            store.read_chunk(&metadata, 0).await.unwrap().unwrap(),
            fixture.chunks[0]
        );
        keeper.execute_batch("COMMIT;").unwrap();
        store
            .delete_generation(fixture.original.scope())
            .await
            .unwrap();
        assert!(!physical_image_marker_exists(&path));
        assert_eq!(
            store.read_chunk(&metadata, 0).await.unwrap().unwrap(),
            fixture.chunks[0]
        );
        drop(store);
        drop(keeper);
        std::fs::remove_file(path).unwrap();
    }

    #[cfg(not(target_arch = "wasm32"))]
    #[tokio::test]
    async fn native_generation_cursor_and_exact_delete_preserve_the_protected_replacement() {
        use crate::vault_image::{SqliteVaultImageArtifactStore, VaultImageArtifactPort};
        let fixture = fixture();
        let protected = fixture
            .original
            .clone()
            .with_protection(fixture.metadata)
            .unwrap();
        let store = SqliteVaultImageArtifactStore::open(":memory:").unwrap();
        store.begin(fixture.original.scope()).await.unwrap();
        for (index, chunk) in fixture.bytes.chunks(VAULT_IMAGE_CHUNK_BYTES).enumerate() {
            store
                .write_chunk(fixture.original.scope(), index as u32, chunk)
                .await
                .unwrap();
        }
        store.publish(&fixture.original).await.unwrap();
        store.begin(protected.scope()).await.unwrap();
        for (index, chunk) in fixture.chunks.iter().enumerate() {
            store
                .write_chunk(protected.scope(), index as u32, chunk)
                .await
                .unwrap();
        }
        store.publish(&protected).await.unwrap();
        let raw = store
            .read_generation(fixture.original.scope(), None)
            .await
            .unwrap()
            .expect("raw generation");
        assert_eq!(raw.metadata, Some(fixture.original.clone()));
        let replacement = store
            .read_generation(fixture.original.scope(), Some(""))
            .await
            .unwrap()
            .expect("protected replacement");
        assert_eq!(replacement.metadata, Some(protected.clone()));
        assert!(store
            .read_generation(fixture.original.scope(), protected.scope().publication_id())
            .await
            .unwrap()
            .is_none());
        store
            .delete_generation(fixture.original.scope())
            .await
            .unwrap();
        assert!(store
            .read_chunk(&fixture.original, 0)
            .await
            .unwrap()
            .is_none());
        assert_eq!(
            store.read_chunk(&protected, 0).await.unwrap().unwrap(),
            fixture.chunks[0]
        );
    }

    #[cfg(not(target_arch = "wasm32"))]
    #[tokio::test]
    async fn oversized_physical_ciphertext_chunk_is_refused_at_the_storage_boundary() {
        use crate::vault_image::{SqliteVaultImageArtifactStore, VaultImageArtifactPort};
        let fixture = fixture();
        let metadata = fixture.original.with_protection(fixture.metadata).unwrap();
        let path = std::env::temp_dir().join(format!(
            "bittery-corrupt-protected-image-{}.sqlite",
            generate_uuid()
        ));
        let store = SqliteVaultImageArtifactStore::open(&path).unwrap();
        store.begin(metadata.scope()).await.unwrap();
        for (index, chunk) in fixture.chunks.iter().enumerate() {
            store
                .write_chunk(metadata.scope(), index as u32, chunk)
                .await
                .unwrap();
        }
        store.publish(&metadata).await.unwrap();
        drop(store);
        let connection = rusqlite::Connection::open(&path).unwrap();
        connection.execute("UPDATE vault_image_artifact_chunks SET plaintext=zeroblob(262145) WHERE chunk_index=0", []).unwrap();
        drop(connection);
        let reopened = SqliteVaultImageArtifactStore::open(&path).unwrap();
        assert!(reopened.read_chunk(&metadata, 0).await.is_err());
        drop(reopened);
        std::fs::remove_file(path).unwrap();
    }

    #[tokio::test]
    async fn memory_family_cleanup_removes_raw_and_protected_publications() {
        use crate::vault_image::{MemoryVaultImageArtifactStore, VaultImageArtifactPort};
        let fixture = fixture();
        let store = MemoryVaultImageArtifactStore::default();
        store.begin(fixture.original.scope()).await.unwrap();
        for (index, chunk) in fixture.bytes.chunks(VAULT_IMAGE_CHUNK_BYTES).enumerate() {
            store
                .write_chunk(fixture.original.scope(), index as u32, chunk)
                .await
                .unwrap();
        }
        store.publish(&fixture.original).await.unwrap();
        let protected = fixture
            .original
            .clone()
            .with_protection(fixture.metadata)
            .unwrap();
        store.begin(protected.scope()).await.unwrap();
        for (index, chunk) in fixture.chunks.iter().enumerate() {
            store
                .write_chunk(protected.scope(), index as u32, chunk)
                .await
                .unwrap();
        }
        store.publish(&protected).await.unwrap();
        store.delete(fixture.original.scope()).await.unwrap();
        assert!(store
            .read_chunk(&fixture.original, 0)
            .await
            .unwrap()
            .is_none());
        assert!(store.read_chunk(&protected, 0).await.unwrap().is_none());
    }

    #[cfg(not(target_arch = "wasm32"))]
    #[tokio::test]
    async fn legacy_raw_publication_survives_upgrade_and_coexists_until_family_cleanup() {
        use crate::vault_image::{SqliteVaultImageArtifactStore, VaultImageArtifactPort};
        use rusqlite::{params, Connection};
        let fixture = fixture();
        let path = std::env::temp_dir().join(format!(
            "bittery-raw-image-upgrade-{}.sqlite",
            generate_uuid()
        ));
        let connection = Connection::open(&path).unwrap();
        connection
            .execute_batch(crate::vault_image::sqlite::RAW_SCHEMA)
            .unwrap();
        connection
            .execute(
                "INSERT INTO vault_image_artifacts VALUES(?1,?2,?3,?4,?5,?6,1)",
                params![
                    fixture.original.account_id().as_str(),
                    fixture.original.operation_id(),
                    fixture.original.vault_id(),
                    fixture.original.byte_length() as i64,
                    fixture.original.content_type(),
                    fixture.original.sha256()
                ],
            )
            .unwrap();
        for (index, chunk) in fixture.bytes.chunks(VAULT_IMAGE_CHUNK_BYTES).enumerate() {
            connection
                .execute(
                    "INSERT INTO vault_image_artifact_chunks VALUES(?1,?2,?3,?4)",
                    params![
                        fixture.original.account_id().as_str(),
                        fixture.original.operation_id(),
                        index as i64,
                        chunk
                    ],
                )
                .unwrap();
        }
        drop(connection);
        let store = SqliteVaultImageArtifactStore::open(&path).unwrap();
        let protected = fixture
            .original
            .clone()
            .with_protection(fixture.metadata.clone())
            .unwrap();
        store.begin(protected.scope()).await.unwrap();
        for (index, chunk) in fixture.chunks.iter().enumerate() {
            store
                .write_chunk(protected.scope(), index as u32, chunk)
                .await
                .unwrap();
        }
        store.publish(&protected).await.unwrap();
        drop(store);
        let reopened = SqliteVaultImageArtifactStore::open(&path).unwrap();
        for (index, chunk) in fixture.bytes.chunks(VAULT_IMAGE_CHUNK_BYTES).enumerate() {
            assert_eq!(
                reopened
                    .read_chunk(&fixture.original, index as u32)
                    .await
                    .unwrap()
                    .unwrap(),
                chunk
            );
        }
        for (index, chunk) in fixture.chunks.iter().enumerate() {
            assert_eq!(
                reopened
                    .read_chunk(&protected, index as u32)
                    .await
                    .unwrap()
                    .unwrap(),
                *chunk
            );
        }
        // Terminal family cleanup remains identity-only and removes both generations.
        reopened.delete(fixture.original.scope()).await.unwrap();
        assert!(reopened
            .read_chunk(&fixture.original, 0)
            .await
            .unwrap()
            .is_none());
        assert!(reopened.read_chunk(&protected, 0).await.unwrap().is_none());
        drop(reopened);
        std::fs::remove_file(path).unwrap();
    }

    pub(super) fn fixture() -> Fixture {
        let bytes = b"private image content/".repeat(13000);
        let original = VaultImageArtifactMetadata::new(
            VaultImageArtifactScope::new("account-a".into(), "operation-a").unwrap(),
            "vault-a",
            bytes.len() as u64,
            "image/png",
            format!("{:x}", Sha256::digest(&bytes)),
        )
        .unwrap();
        let mut writer =
            ProtectedImageWriter::new(original.scope().clone(), "vault-a", "user-a").unwrap();
        let chunks = bytes
            .chunks(PROTECTED_IMAGE_PLAINTEXT_CHUNK_BYTES)
            .map(|chunk| writer.push(chunk).unwrap())
            .collect();
        let metadata = writer.finish(&original, &[7; 32]).unwrap();
        Fixture {
            original,
            metadata,
            chunks,
            bytes,
        }
    }

    #[test]
    fn publication_validation_opens_only_the_key_wrapper() {
        let mut fixture = fixture();
        let mut payload = unwrap_key_payload(
            &fixture.original,
            "user-a",
            &fixture.metadata.witness,
            &fixture.metadata,
            &[7; 32],
        )
        .unwrap();
        // A correctly witnessed opaque publication may contain an unreadable image envelope.
        // Upgrade retry checks its authenticated storage identity; only admitted reads open it.
        fixture.chunks[0][0] = b'!';
        let mut digest = Sha256::new();
        for chunk in &fixture.chunks {
            digest.update(chunk);
        }
        fixture.metadata.witness.ciphertext_sha256 = format!("{:x}", digest.finalize());
        payload.witness = fixture.metadata.witness.clone();
        fixture.metadata.wrapped_key = wrap_key_payload(&payload, &[7; 32]).unwrap();
        verify_protected_publication(
            &fixture.original,
            "user-a",
            &fixture.metadata.witness,
            &fixture.metadata,
            &fixture.chunks,
            &[7; 32],
        )
        .unwrap();
        assert!(read_protected_image(
            &fixture.original,
            "user-a",
            &fixture.metadata.witness,
            &fixture.metadata,
            &fixture.chunks,
            &[7; 32],
        )
        .is_err());
        assert!(verify_protected_publication(
            &fixture.original,
            "user-a",
            &fixture.metadata.witness,
            &fixture.metadata,
            &fixture.chunks,
            &[8; 32],
        )
        .is_err());
    }

    #[test]
    fn another_account_operation_vault_user_or_expected_image_cannot_open_the_artifact() {
        let fixture = fixture();
        for (account, operation, vault, user, content_type) in [
            ("account-b", "operation-a", "vault-a", "user-a", "image/png"),
            ("account-a", "operation-b", "vault-a", "user-a", "image/png"),
            ("account-a", "operation-a", "vault-b", "user-a", "image/png"),
            ("account-a", "operation-a", "vault-a", "user-b", "image/png"),
            (
                "account-a",
                "operation-a",
                "vault-a",
                "user-a",
                "image/jpeg",
            ),
        ] {
            let expected = VaultImageArtifactMetadata::new(
                VaultImageArtifactScope::new(account.into(), operation).unwrap(),
                vault,
                fixture.original.byte_length(),
                content_type,
                fixture.original.sha256(),
            )
            .unwrap();
            assert!(
                read_protected_image(
                    &expected,
                    user,
                    &fixture.metadata.witness,
                    &fixture.metadata,
                    &fixture.chunks,
                    &[7; 32],
                )
                .is_err(),
                "wrong scope: {account}/{operation}/{vault}/{user}/{content_type}"
            );
        }
        assert!(read_protected_image(
            &fixture.original,
            "user-a",
            &fixture.metadata.witness,
            &fixture.metadata,
            &fixture.chunks,
            &[8; 32],
        )
        .is_err());
    }

    #[test]
    fn accepted_ciphertext_witness_refuses_reorder_truncation_duplication_and_replacement() {
        let fixture = fixture();
        let mut reordered = fixture.chunks.clone();
        reordered.swap(0, 1);
        let mut truncated = fixture.chunks.clone();
        truncated.pop();
        let mut duplicated = fixture.chunks.clone();
        duplicated[1] = duplicated[0].clone();
        let mut tampered = fixture.chunks.clone();
        tampered[0][100] ^= 1;
        for chunks in [reordered, truncated, duplicated, tampered] {
            assert!(read_protected_image(
                &fixture.original,
                "user-a",
                &fixture.metadata.witness,
                &fixture.metadata,
                &chunks,
                &[7; 32],
            )
            .is_err());
        }
        let replacement = self::fixture();
        assert_ne!(replacement.metadata.witness, fixture.metadata.witness);
        assert!(read_protected_image(
            &fixture.original,
            "user-a",
            &fixture.metadata.witness,
            &replacement.metadata,
            &replacement.chunks,
            &[7; 32],
        )
        .is_err());
    }

    #[test]
    fn wrapped_key_authenticates_metadata_even_if_public_fields_are_rewritten() {
        let fixture = fixture();
        let mut encoded = serde_json::to_value(&fixture.metadata).unwrap();
        encoded["binding"]["contentType"] = "image/jpeg".into();
        let metadata = serde_json::from_value(encoded).unwrap();
        let rewritten = VaultImageArtifactMetadata::new(
            fixture.original.scope().clone(),
            "vault-a",
            fixture.original.byte_length(),
            "image/jpeg",
            fixture.original.sha256(),
        )
        .unwrap();
        assert!(read_protected_image(
            &rewritten,
            "user-a",
            &fixture.metadata.witness,
            &metadata,
            &fixture.chunks,
            &[7; 32],
        )
        .is_err());
    }

    #[test]
    fn existing_crypto_opens_the_specified_aad_envelopes_and_preserves_binary_encoding() {
        let fixture = fixture();
        let publication = &fixture.metadata.witness.publication_id;
        let key_context = AadContext {
            vault_id: "vault-a".into(),
            entity_id: format!("[\"account-a\",\"operation-a\",\"{publication}\"]"),
            entity_type: "vaultImageArtifactKey".into(),
            version: 1,
            user_id: "user-a".into(),
        };
        let payload = Zeroizing::new(
            decrypt_with_aad(&fixture.metadata.wrapped_key, &[7; 32], &key_context).unwrap(),
        );
        let payload: KeyPayload = serde_json::from_str(&payload).unwrap();
        let key = Zeroizing::new(BASE64.decode(payload.artifact_key.as_bytes()).unwrap());
        let first: EncryptedData = serde_json::from_slice(&fixture.chunks[0]).unwrap();
        assert_eq!(first.algorithm, "AES-GCM-AAD-V1");
        let chunk_context = AadContext {
            vault_id: "vault-a".into(),
            entity_id: format!("[\"account-a\",\"operation-a\",\"{publication}\",0]"),
            entity_type: "vaultImageArtifactChunk".into(),
            version: 1,
            user_id: "user-a".into(),
        };
        let encoded = Zeroizing::new(decrypt_with_aad(&first, &key, &chunk_context).unwrap());
        let bytes = Zeroizing::new(BASE64.decode(encoded.as_bytes()).unwrap());
        assert_eq!(
            bytes.as_slice(),
            &fixture.bytes[..PROTECTED_IMAGE_PLAINTEXT_CHUNK_BYTES]
        );
    }

    #[test]
    fn full_allowed_image_uses_bounded_envelopes_without_changing_the_image_size_limit() {
        let bytes: Vec<_> = (0..VAULT_IMAGE_MAX_BYTES)
            .map(|index| (index % 251) as u8)
            .collect();
        let original = VaultImageArtifactMetadata::new(
            VaultImageArtifactScope::new("account-a".into(), "operation-max").unwrap(),
            "vault-a",
            VAULT_IMAGE_MAX_BYTES,
            "image/avif",
            format!("{:x}", Sha256::digest(&bytes)),
        )
        .unwrap();
        let mut writer =
            ProtectedImageWriter::new(original.scope().clone(), "vault-a", "user-a").unwrap();
        let chunks: Vec<_> = bytes
            .chunks(PROTECTED_IMAGE_PLAINTEXT_CHUNK_BYTES)
            .map(|chunk| writer.push(chunk).unwrap())
            .collect();
        let metadata = writer.finish(&original, &[7; 32]).unwrap();
        assert_eq!(metadata.witness.chunk_count, 16);
        assert!(chunks
            .iter()
            .all(|chunk| chunk.len() <= VAULT_IMAGE_CHUNK_BYTES));
        assert_eq!(
            read_protected_image(
                &original,
                "user-a",
                &metadata.witness,
                &metadata,
                &chunks,
                &[7; 32]
            )
            .unwrap()
            .as_slice(),
            bytes
        );
    }

    #[test]
    fn protected_publication_reopens_the_exact_image_with_existing_device_key() {
        let bytes = [b"private local image bytes/".repeat(6000), b"end".to_vec()].concat();
        let original = VaultImageArtifactMetadata::new(
            VaultImageArtifactScope::new(AccountId::from("account-a"), "operation-a").unwrap(),
            "vault-a",
            bytes.len() as u64,
            "image/png",
            format!("{:x}", Sha256::digest(&bytes)),
        )
        .unwrap();
        let device_key = [7_u8; 32];
        let mut writer =
            ProtectedImageWriter::new(original.scope().clone(), "vault-a", "user-a").unwrap();
        let chunks: Vec<_> = bytes
            .chunks(PROTECTED_IMAGE_PLAINTEXT_CHUNK_BYTES)
            .map(|chunk| writer.push(chunk).unwrap())
            .collect();
        let metadata = writer.finish(&original, &device_key).unwrap();
        assert_eq!(metadata.witness.format_version, 1);
        assert_eq!(metadata.witness.chunk_count, 2);
        assert!(chunks
            .iter()
            .all(|chunk| chunk.len() <= VAULT_IMAGE_CHUNK_BYTES));
        let marker = b"private local image bytes/";
        assert!(chunks
            .iter()
            .all(|chunk| !chunk.windows(marker.len()).any(|window| window == marker)));
        let persisted = serde_json::to_vec(&metadata).unwrap();
        let reopened = serde_json::from_slice(&persisted).unwrap();
        assert_eq!(
            read_protected_image(
                &original,
                "user-a",
                &metadata.witness,
                &reopened,
                &chunks,
                &device_key,
            )
            .unwrap()
            .as_slice(),
            bytes
        );
    }
}
