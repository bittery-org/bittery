use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use bittery_crypto_core as core;
use std::fmt;
use std::sync::{Arc, Mutex};
use zeroize::{Zeroize, Zeroizing};

uniffi::setup_scaffolding!();

#[derive(Debug, thiserror::Error, uniffi::Error)]
pub enum CryptoError {
    #[error("key derivation failed: {0}")]
    KeyDerivation(String),
    #[error("encryption failed: {0}")]
    Encryption(String),
    #[error("decryption failed: {0}")]
    Decryption(String),
    #[error("invalid key length: expected {expected}, got {actual}")]
    InvalidKeyLength { expected: u64, actual: u64 },
    #[error("invalid IV length: expected {expected}, got {actual}")]
    InvalidIvLength { expected: u64, actual: u64 },
    #[error("RSA operation failed: {0}")]
    Rsa(String),
    #[error("invalid PEM format: {0}")]
    InvalidPem(String),
    #[error("invalid Secret Key format")]
    InvalidSecretKey,
    #[error("base64 decode failed: {0}")]
    Base64Decode(String),
    #[error("hex decode failed: {0}")]
    HexDecode(String),
    #[error("SRP operation failed: {0}")]
    Srp(String),
    #[error("invalid public ephemeral")]
    InvalidPublicEphemeral,
    #[error("invalid session proof")]
    InvalidSessionProof,
    #[error("UTF-8 decode failed: {0}")]
    Utf8(String),
    #[error("invalid input: {0}")]
    InvalidInput(String),
    #[error("key handle has been destroyed")]
    KeyDestroyed,
    #[error("key handle lock was poisoned")]
    KeyHandleUnavailable,
    #[error("background crypto task failed")]
    BackgroundTaskFailed,
}

impl From<core::CryptoError> for CryptoError {
    fn from(error: core::CryptoError) -> Self {
        match error {
            core::CryptoError::KeyDerivation(value) => Self::KeyDerivation(value),
            core::CryptoError::Encryption(value) => Self::Encryption(value),
            core::CryptoError::Decryption(value) => Self::Decryption(value),
            core::CryptoError::InvalidKeyLength { expected, actual } => Self::InvalidKeyLength {
                expected: expected as u64,
                actual: actual as u64,
            },
            core::CryptoError::InvalidIvLength { expected, actual } => Self::InvalidIvLength {
                expected: expected as u64,
                actual: actual as u64,
            },
            core::CryptoError::Rsa(value) => Self::Rsa(value),
            core::CryptoError::InvalidPem(value) => Self::InvalidPem(value),
            core::CryptoError::InvalidSecretKey => Self::InvalidSecretKey,
            core::CryptoError::Base64Decode(value) => Self::Base64Decode(value),
            core::CryptoError::HexDecode(value) => Self::HexDecode(value),
            core::CryptoError::Srp(value) => Self::Srp(value),
            core::CryptoError::InvalidPublicEphemeral => Self::InvalidPublicEphemeral,
            core::CryptoError::InvalidSessionProof => Self::InvalidSessionProof,
            core::CryptoError::Utf8Error(value) => Self::Utf8(value),
            core::CryptoError::InvalidInput(value) => Self::InvalidInput(value),
        }
    }
}

impl From<base64::DecodeError> for CryptoError {
    fn from(error: base64::DecodeError) -> Self {
        Self::Base64Decode(error.to_string())
    }
}

#[derive(uniffi::Object)]
pub struct KeyHandle {
    material: Mutex<Option<Zeroizing<Vec<u8>>>>,
}

impl fmt::Debug for KeyHandle {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("KeyHandle")
            .field("material", &"[redacted]")
            .finish()
    }
}

impl KeyHandle {
    fn new(material: impl Into<Vec<u8>>) -> Arc<Self> {
        Arc::new(Self {
            material: Mutex::new(Some(Zeroizing::new(material.into()))),
        })
    }

    fn copy_material(&self) -> Result<Zeroizing<Vec<u8>>, CryptoError> {
        let guard = self
            .material
            .lock()
            .map_err(|_| CryptoError::KeyHandleUnavailable)?;
        guard
            .as_ref()
            .map(|material| Zeroizing::new(material.to_vec()))
            .ok_or(CryptoError::KeyDestroyed)
    }
}

#[cfg_attr(target_arch = "wasm32", uniffi::export)]
#[cfg_attr(not(target_arch = "wasm32"), uniffi::export(async_runtime = "tokio"))]
impl KeyHandle {
    pub async fn destroy(&self) -> Result<(), CryptoError> {
        let mut material = self
            .material
            .lock()
            .map_err(|_| CryptoError::KeyHandleUnavailable)?;
        if let Some(mut live) = material.take() {
            live.zeroize();
        }
        Ok(())
    }
}

#[derive(Clone, uniffi::Record)]
pub struct EncryptedData {
    pub ciphertext: String,
    pub iv: String,
    pub algorithm: String,
}

impl From<core::EncryptedData> for EncryptedData {
    fn from(value: core::EncryptedData) -> Self {
        Self {
            ciphertext: value.ciphertext,
            iv: value.iv,
            algorithm: value.algorithm,
        }
    }
}

impl From<EncryptedData> for core::EncryptedData {
    fn from(value: EncryptedData) -> Self {
        Self {
            ciphertext: value.ciphertext,
            iv: value.iv,
            algorithm: value.algorithm,
        }
    }
}

#[derive(Clone, uniffi::Record)]
pub struct EncryptionContext {
    pub vault_id: String,
    pub entity_id: String,
    pub entity_type: String,
    pub version: u64,
    pub user_id: String,
}

impl From<EncryptionContext> for core::AadContext {
    fn from(value: EncryptionContext) -> Self {
        Self {
            vault_id: value.vault_id,
            entity_id: value.entity_id,
            entity_type: value.entity_type,
            version: value.version,
            user_id: value.user_id,
        }
    }
}

#[derive(Clone, uniffi::Record)]
pub struct KdfProfile {
    pub schema_version: u32,
    pub algorithm: String,
    pub iterations: u32,
}

impl From<KdfProfile> for core::KdfProfile {
    fn from(value: KdfProfile) -> Self {
        Self {
            schema_version: value.schema_version,
            algorithm: value.algorithm,
            iterations: value.iterations,
        }
    }
}

#[derive(uniffi::Record)]
pub struct DerivedKeyHandles {
    pub auth_key: Arc<KeyHandle>,
    pub master_unlock_key: Arc<KeyHandle>,
}

#[derive(Clone, uniffi::Record)]
pub struct DecryptRequest {
    pub id: String,
    pub data: EncryptedData,
    pub key: Arc<KeyHandle>,
    pub context: Option<EncryptionContext>,
}

#[derive(uniffi::Record)]
pub struct DecryptManyResult {
    pub id: String,
    pub plaintext: Option<String>,
    pub error: Option<String>,
}

#[derive(uniffi::Record)]
pub struct RsaKeyPair {
    pub public_key: String,
    pub private_key: String,
}

#[derive(Clone, uniffi::Record)]
pub struct ItemData {
    pub id: String,
    pub encrypted_data: String,
    pub encryption_iv: String,
    pub encryption_algorithm: String,
    pub context: EncryptionContext,
}

impl From<ItemData> for core::ItemData {
    fn from(value: ItemData) -> Self {
        Self {
            id: value.id,
            encrypted_data: value.encrypted_data,
            encryption_iv: value.encryption_iv,
            encryption_algorithm: value.encryption_algorithm,
            context: value.context.into(),
        }
    }
}

#[derive(Clone, uniffi::Record)]
pub struct MemberKeyData {
    pub user_id: String,
    pub public_key: String,
}

impl From<MemberKeyData> for core::MemberKeyData {
    fn from(value: MemberKeyData) -> Self {
        Self {
            user_id: value.user_id,
            public_key: value.public_key,
        }
    }
}

#[derive(uniffi::Record)]
pub struct ReEncryptedItem {
    pub item_id: String,
    pub encrypted_data: String,
    pub encryption_iv: String,
}

impl From<core::ReEncryptedItem> for ReEncryptedItem {
    fn from(value: core::ReEncryptedItem) -> Self {
        Self {
            item_id: value.item_id,
            encrypted_data: value.encrypted_data,
            encryption_iv: value.encryption_iv,
        }
    }
}

#[derive(uniffi::Record)]
pub struct MemberEncryptedKey {
    pub user_id: String,
    pub encrypted_vault_key: String,
}

#[derive(uniffi::Record)]
pub struct KeyRotationResult {
    pub member_encrypted_keys: Vec<MemberEncryptedKey>,
    pub re_encrypted_items: Vec<ReEncryptedItem>,
}

#[derive(uniffi::Record)]
pub struct ValidationResult {
    pub valid: bool,
    pub errors: Vec<String>,
}

#[derive(uniffi::Record)]
pub struct SrpRegistration {
    pub salt: String,
    pub verifier: String,
}

#[derive(uniffi::Record)]
pub struct SrpClientEphemeral {
    pub public_key: String,
    pub secret: String,
}

#[derive(Clone, uniffi::Record)]
pub struct SrpServerChallenge {
    pub salt: String,
    pub server_public_key: String,
}

#[derive(Clone, uniffi::Record)]
pub struct SrpClientSession {
    pub key: String,
    pub proof: String,
}

#[derive(uniffi::Record)]
pub struct PasskeyKeypair {
    pub private_key: String,
    pub public_key_cose: String,
    pub public_key_spki: String,
}

#[derive(uniffi::Record)]
pub struct PasskeyAttestation {
    pub authenticator_data: Vec<u8>,
    pub attestation_object: Vec<u8>,
}

#[derive(uniffi::Record)]
pub struct PasskeyAssertion {
    pub authenticator_data: Vec<u8>,
    pub signature_der: Vec<u8>,
}

#[derive(uniffi::Record)]
pub struct TotpResult {
    pub code: String,
    pub remaining_seconds: u64,
    pub period: u64,
    pub progress: f64,
}

#[cfg(not(target_arch = "wasm32"))]
async fn run_crypto<T, F>(operation: F) -> Result<T, CryptoError>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, CryptoError> + Send + 'static,
{
    tokio::task::spawn_blocking(operation)
        .await
        .map_err(|_| CryptoError::BackgroundTaskFailed)?
}

#[cfg(target_arch = "wasm32")]
async fn run_crypto<T, F>(operation: F) -> Result<T, CryptoError>
where
    F: FnOnce() -> Result<T, CryptoError>,
{
    operation()
}

fn srp_client() -> core::SrpClient {
    core::SrpClient::new(
        core::srp6a::HashAlgorithm::Sha256,
        core::srp6a::PrimeGroup::G4096,
    )
}

#[cfg_attr(target_arch = "wasm32", uniffi::export)]
#[cfg_attr(not(target_arch = "wasm32"), uniffi::export(async_runtime = "tokio"))]
pub async fn initialize() -> Result<(), CryptoError> {
    Ok(())
}

#[cfg_attr(target_arch = "wasm32", uniffi::export)]
#[cfg_attr(not(target_arch = "wasm32"), uniffi::export(async_runtime = "tokio"))]
pub async fn generate_encryption_key() -> Result<Arc<KeyHandle>, CryptoError> {
    run_crypto(|| Ok(KeyHandle::new(core::generate_encryption_key()))).await
}

#[cfg_attr(target_arch = "wasm32", uniffi::export)]
#[cfg_attr(not(target_arch = "wasm32"), uniffi::export(async_runtime = "tokio"))]
pub async fn import_key(key: Vec<u8>) -> Result<Arc<KeyHandle>, CryptoError> {
    run_crypto(move || {
        if key.len() != 32 {
            return Err(CryptoError::InvalidKeyLength {
                expected: 32,
                actual: key.len() as u64,
            });
        }
        Ok(KeyHandle::new(key))
    })
    .await
}

#[cfg_attr(target_arch = "wasm32", uniffi::export)]
#[cfg_attr(not(target_arch = "wasm32"), uniffi::export(async_runtime = "tokio"))]
pub async fn export_key(key: Arc<KeyHandle>) -> Result<Vec<u8>, CryptoError> {
    run_crypto(move || Ok(key.copy_material()?.to_vec())).await
}

#[cfg_attr(target_arch = "wasm32", uniffi::export)]
#[cfg_attr(not(target_arch = "wasm32"), uniffi::export(async_runtime = "tokio"))]
pub async fn clone_key(key: Arc<KeyHandle>) -> Result<Arc<KeyHandle>, CryptoError> {
    run_crypto(move || Ok(KeyHandle::new(key.copy_material()?.to_vec()))).await
}

#[cfg_attr(target_arch = "wasm32", uniffi::export)]
#[cfg_attr(not(target_arch = "wasm32"), uniffi::export(async_runtime = "tokio"))]
pub async fn destroy_key(key: Arc<KeyHandle>) -> Result<(), CryptoError> {
    key.destroy().await
}

#[cfg_attr(target_arch = "wasm32", uniffi::export)]
#[cfg_attr(not(target_arch = "wasm32"), uniffi::export(async_runtime = "tokio"))]
pub async fn derive_keys(
    account_password: String,
    secret_key: String,
    email: String,
    profile: KdfProfile,
) -> Result<DerivedKeyHandles, CryptoError> {
    run_crypto(move || {
        let keys = core::derive_keys(&account_password, &secret_key, &email, &profile.into())?;
        Ok(DerivedKeyHandles {
            auth_key: KeyHandle::new(keys.auth_key),
            master_unlock_key: KeyHandle::new(keys.master_unlock_key),
        })
    })
    .await
}

#[cfg_attr(target_arch = "wasm32", uniffi::export)]
#[cfg_attr(not(target_arch = "wasm32"), uniffi::export(async_runtime = "tokio"))]
pub async fn derive_master_key(
    account_password: String,
    secret_key: String,
    email: String,
    profile: KdfProfile,
) -> Result<Arc<KeyHandle>, CryptoError> {
    run_crypto(move || {
        core::derive_master_key(&account_password, &secret_key, &email, &profile.into())
            .map(KeyHandle::new)
            .map_err(Into::into)
    })
    .await
}

#[cfg_attr(target_arch = "wasm32", uniffi::export)]
#[cfg_attr(not(target_arch = "wasm32"), uniffi::export(async_runtime = "tokio"))]
pub async fn derive_keys_from_master_key(
    master_key: Arc<KeyHandle>,
    email: String,
) -> Result<DerivedKeyHandles, CryptoError> {
    run_crypto(move || {
        let material = master_key.copy_material()?;
        let keys = core::derive_keys_from_master_key(&material, &email)?;
        Ok(DerivedKeyHandles {
            auth_key: KeyHandle::new(keys.auth_key),
            master_unlock_key: KeyHandle::new(keys.master_unlock_key),
        })
    })
    .await
}

#[cfg_attr(target_arch = "wasm32", uniffi::export)]
#[cfg_attr(not(target_arch = "wasm32"), uniffi::export(async_runtime = "tokio"))]
pub async fn derive_srp_password(auth_key: Arc<KeyHandle>) -> Result<String, CryptoError> {
    run_crypto(move || {
        Ok(String::from_utf8_lossy(auth_key.copy_material()?.as_slice()).to_string())
    })
    .await
}

fn encrypt_inner(
    plaintext: &str,
    key: &[u8],
    context: Option<EncryptionContext>,
) -> Result<EncryptedData, CryptoError> {
    match context {
        Some(context) => core::encrypt_with_aad(plaintext, key, &context.into()),
        None => core::encrypt(plaintext, key),
    }
    .map(Into::into)
    .map_err(Into::into)
}

fn decrypt_inner(
    data: EncryptedData,
    key: &[u8],
    context: Option<EncryptionContext>,
) -> Result<String, CryptoError> {
    let data = data.into();
    match context {
        Some(context) => core::decrypt_with_aad(&data, key, &context.into()),
        None => core::decrypt(&data, key),
    }
    .map_err(Into::into)
}

#[cfg_attr(target_arch = "wasm32", uniffi::export)]
#[cfg_attr(not(target_arch = "wasm32"), uniffi::export(async_runtime = "tokio"))]
pub async fn encrypt(
    plaintext: String,
    key: Arc<KeyHandle>,
    context: Option<EncryptionContext>,
) -> Result<EncryptedData, CryptoError> {
    run_crypto(move || encrypt_inner(&plaintext, &key.copy_material()?, context)).await
}

#[cfg_attr(target_arch = "wasm32", uniffi::export)]
#[cfg_attr(not(target_arch = "wasm32"), uniffi::export(async_runtime = "tokio"))]
pub async fn decrypt(
    data: EncryptedData,
    key: Arc<KeyHandle>,
    context: Option<EncryptionContext>,
) -> Result<String, CryptoError> {
    run_crypto(move || decrypt_inner(data, &key.copy_material()?, context)).await
}

#[cfg_attr(target_arch = "wasm32", uniffi::export)]
#[cfg_attr(not(target_arch = "wasm32"), uniffi::export(async_runtime = "tokio"))]
pub async fn decrypt_many(
    requests: Vec<DecryptRequest>,
) -> Result<Vec<DecryptManyResult>, CryptoError> {
    run_crypto(move || {
        requests
            .into_iter()
            .map(|request| {
                let material = request.key.copy_material()?;
                Ok(
                    match decrypt_inner(request.data, &material, request.context) {
                        Ok(plaintext) => DecryptManyResult {
                            id: request.id,
                            plaintext: Some(plaintext),
                            error: None,
                        },
                        Err(error) => DecryptManyResult {
                            id: request.id,
                            plaintext: None,
                            error: Some(error.to_string()),
                        },
                    },
                )
            })
            .collect()
    })
    .await
}

#[cfg_attr(target_arch = "wasm32", uniffi::export)]
#[cfg_attr(not(target_arch = "wasm32"), uniffi::export(async_runtime = "tokio"))]
pub async fn wrap_key(
    key: Arc<KeyHandle>,
    wrapping_key: Arc<KeyHandle>,
) -> Result<EncryptedData, CryptoError> {
    run_crypto(move || {
        let material = key.copy_material()?;
        let wrapping_material = wrapping_key.copy_material()?;
        let mut encoded = BASE64.encode(material.as_slice());
        let result = core::encrypt(&encoded, &wrapping_material).map(Into::into);
        encoded.zeroize();
        result.map_err(Into::into)
    })
    .await
}

#[cfg_attr(target_arch = "wasm32", uniffi::export)]
#[cfg_attr(not(target_arch = "wasm32"), uniffi::export(async_runtime = "tokio"))]
pub async fn unwrap_key(
    data: EncryptedData,
    wrapping_key: Arc<KeyHandle>,
    context: Option<EncryptionContext>,
    legacy_marker: Option<String>,
    legacy_context: Option<String>,
) -> Result<Arc<KeyHandle>, CryptoError> {
    run_crypto(move || {
        let wrapping_material = wrapping_key.copy_material()?;
        let mut plaintext = decrypt_inner(data, &wrapping_material, context)?;
        if let (Some(marker), Some(expected_context)) = (legacy_marker, legacy_context) {
            let envelope: serde_json::Value = serde_json::from_str(&plaintext)
                .map_err(|error| CryptoError::InvalidInput(error.to_string()))?;
            if envelope.get("marker").and_then(|value| value.as_str()) != Some(marker.as_str())
                || envelope.get("context").and_then(|value| value.as_str())
                    != Some(expected_context.as_str())
            {
                plaintext.zeroize();
                return Err(CryptoError::InvalidInput(
                    "legacy key envelope did not match".to_string(),
                ));
            }
            plaintext = envelope
                .get("payload")
                .and_then(|value| value.as_str())
                .ok_or_else(|| {
                    CryptoError::InvalidInput("legacy key envelope has no payload".into())
                })?
                .to_string();
        }
        let decoded = BASE64.decode(plaintext.as_bytes())?;
        plaintext.zeroize();
        if decoded.len() != 32 {
            return Err(CryptoError::InvalidKeyLength {
                expected: 32,
                actual: decoded.len() as u64,
            });
        }
        Ok(KeyHandle::new(decoded))
    })
    .await
}

#[cfg_attr(target_arch = "wasm32", uniffi::export)]
#[cfg_attr(not(target_arch = "wasm32"), uniffi::export(async_runtime = "tokio"))]
pub async fn generate_rsa_key_pair() -> Result<RsaKeyPair, CryptoError> {
    run_crypto(|| {
        let pair = core::generate_rsa_key_pair()?;
        Ok(RsaKeyPair {
            public_key: pair.public_key.clone(),
            private_key: pair.private_key.clone(),
        })
    })
    .await
}

#[cfg_attr(target_arch = "wasm32", uniffi::export)]
#[cfg_attr(not(target_arch = "wasm32"), uniffi::export(async_runtime = "tokio"))]
pub async fn rsa_encrypt(plaintext: String, public_key_pem: String) -> Result<String, CryptoError> {
    run_crypto(move || core::rsa_encrypt(&plaintext, &public_key_pem).map_err(Into::into)).await
}

#[cfg_attr(target_arch = "wasm32", uniffi::export)]
#[cfg_attr(not(target_arch = "wasm32"), uniffi::export(async_runtime = "tokio"))]
pub async fn rsa_decrypt(
    ciphertext: String,
    private_key_pem: String,
) -> Result<String, CryptoError> {
    run_crypto(move || core::rsa_decrypt(&ciphertext, &private_key_pem).map_err(Into::into)).await
}

#[cfg_attr(target_arch = "wasm32", uniffi::export)]
#[cfg_attr(not(target_arch = "wasm32"), uniffi::export(async_runtime = "tokio"))]
pub async fn decrypt_rsa_wrapped_key(
    ciphertext: String,
    encrypted_private_key: EncryptedData,
    private_key_wrapping_key: Arc<KeyHandle>,
    private_key_context: Option<EncryptionContext>,
) -> Result<Arc<KeyHandle>, CryptoError> {
    run_crypto(move || {
        let wrapping_material = private_key_wrapping_key.copy_material()?;
        let mut private_key = decrypt_inner(
            encrypted_private_key,
            &wrapping_material,
            private_key_context,
        )?;
        let mut unwrapped = core::rsa_decrypt(&ciphertext, &private_key)?;
        private_key.zeroize();
        let decoded = BASE64.decode(unwrapped.as_bytes())?;
        unwrapped.zeroize();
        if decoded.len() != 32 {
            return Err(CryptoError::InvalidKeyLength {
                expected: 32,
                actual: decoded.len() as u64,
            });
        }
        Ok(KeyHandle::new(decoded))
    })
    .await
}

#[cfg_attr(target_arch = "wasm32", uniffi::export)]
#[cfg_attr(not(target_arch = "wasm32"), uniffi::export(async_runtime = "tokio"))]
pub async fn encrypt_vault_key_for_member(
    vault_key: Arc<KeyHandle>,
    member_public_key_pem: String,
) -> Result<String, CryptoError> {
    run_crypto(move || {
        core::encrypt_vault_key_for_member(&vault_key.copy_material()?, &member_public_key_pem)
            .map_err(Into::into)
    })
    .await
}

#[cfg_attr(target_arch = "wasm32", uniffi::export)]
#[cfg_attr(not(target_arch = "wasm32"), uniffi::export(async_runtime = "tokio"))]
pub async fn encrypt_vault_key_with_muk(
    vault_key: Arc<KeyHandle>,
    master_unlock_key: Arc<KeyHandle>,
    vault_id: String,
    user_id: String,
    key_version: u64,
) -> Result<String, CryptoError> {
    run_crypto(move || {
        let context = core::VaultKeyWrapContext::new(&vault_id, &user_id, key_version);
        core::encrypt_vault_key_with_muk(
            &vault_key.copy_material()?,
            &master_unlock_key.copy_material()?,
            &context,
        )
        .map_err(Into::into)
    })
    .await
}

#[cfg_attr(target_arch = "wasm32", uniffi::export)]
#[cfg_attr(not(target_arch = "wasm32"), uniffi::export(async_runtime = "tokio"))]
pub async fn re_encrypt_item(
    item: ItemData,
    old_vault_key: Arc<KeyHandle>,
    new_vault_key: Arc<KeyHandle>,
) -> Result<ReEncryptedItem, CryptoError> {
    run_crypto(move || {
        core::re_encrypt_item(
            &item.into(),
            &old_vault_key.copy_material()?,
            &new_vault_key.copy_material()?,
        )
        .map(Into::into)
        .map_err(Into::into)
    })
    .await
}

#[cfg_attr(target_arch = "wasm32", uniffi::export)]
#[cfg_attr(not(target_arch = "wasm32"), uniffi::export(async_runtime = "tokio"))]
pub async fn perform_key_rotation(
    old_vault_key: Arc<KeyHandle>,
    members: Vec<MemberKeyData>,
    items: Vec<ItemData>,
    vault_id: String,
    key_version: u64,
    current_user_id: String,
    master_unlock_key: Arc<KeyHandle>,
) -> Result<KeyRotationResult, CryptoError> {
    run_crypto(move || {
        let members: Vec<_> = members.into_iter().map(Into::into).collect();
        let items: Vec<_> = items.into_iter().map(Into::into).collect();
        let result = core::perform_key_rotation(
            &old_vault_key.copy_material()?,
            &members,
            &items,
            &vault_id,
            key_version,
            &current_user_id,
            &master_unlock_key.copy_material()?,
        )?;
        Ok(KeyRotationResult {
            member_encrypted_keys: result
                .member_encrypted_keys
                .into_iter()
                .map(|value| MemberEncryptedKey {
                    user_id: value.user_id,
                    encrypted_vault_key: value.encrypted_vault_key,
                })
                .collect(),
            re_encrypted_items: result
                .re_encrypted_items
                .into_iter()
                .map(Into::into)
                .collect(),
        })
    })
    .await
}

#[cfg_attr(target_arch = "wasm32", uniffi::export)]
#[cfg_attr(not(target_arch = "wasm32"), uniffi::export(async_runtime = "tokio"))]
pub async fn validate_rotation_data(
    members: Vec<MemberKeyData>,
) -> Result<ValidationResult, CryptoError> {
    run_crypto(move || {
        let members: Vec<_> = members.into_iter().map(Into::into).collect();
        let result = core::validate_rotation_data(&members);
        Ok(ValidationResult {
            valid: result.valid,
            errors: result.errors,
        })
    })
    .await
}

#[cfg_attr(target_arch = "wasm32", uniffi::export)]
#[cfg_attr(not(target_arch = "wasm32"), uniffi::export(async_runtime = "tokio"))]
pub async fn generate_secret_key() -> Result<String, CryptoError> {
    run_crypto(|| Ok(core::generate_secret_key())).await
}

#[cfg_attr(target_arch = "wasm32", uniffi::export)]
#[cfg_attr(not(target_arch = "wasm32"), uniffi::export(async_runtime = "tokio"))]
pub async fn validate_secret_key(secret_key: String) -> Result<bool, CryptoError> {
    run_crypto(move || Ok(core::validate_secret_key(&secret_key))).await
}

#[cfg_attr(target_arch = "wasm32", uniffi::export)]
#[cfg_attr(not(target_arch = "wasm32"), uniffi::export(async_runtime = "tokio"))]
pub async fn generate_recovery_key() -> Result<String, CryptoError> {
    run_crypto(|| Ok(core::generate_recovery_key())).await
}

#[cfg_attr(target_arch = "wasm32", uniffi::export)]
#[cfg_attr(not(target_arch = "wasm32"), uniffi::export(async_runtime = "tokio"))]
pub async fn validate_recovery_key(recovery_key: String) -> Result<bool, CryptoError> {
    run_crypto(move || Ok(core::validate_recovery_key(&recovery_key))).await
}

#[cfg_attr(target_arch = "wasm32", uniffi::export)]
#[cfg_attr(not(target_arch = "wasm32"), uniffi::export(async_runtime = "tokio"))]
pub async fn encrypt_master_key(
    master_key: Arc<KeyHandle>,
    recovery_key: String,
    email: String,
) -> Result<EncryptedData, CryptoError> {
    run_crypto(move || {
        core::encrypt_master_key(&master_key.copy_material()?, &recovery_key, &email)
            .map(Into::into)
            .map_err(Into::into)
    })
    .await
}

#[cfg_attr(target_arch = "wasm32", uniffi::export)]
#[cfg_attr(not(target_arch = "wasm32"), uniffi::export(async_runtime = "tokio"))]
pub async fn decrypt_master_key(
    data: EncryptedData,
    recovery_key: String,
    email: String,
) -> Result<Arc<KeyHandle>, CryptoError> {
    run_crypto(move || {
        core::decrypt_master_key(&data.into(), &recovery_key, &email)
            .map(KeyHandle::new)
            .map_err(Into::into)
    })
    .await
}

#[derive(uniffi::Object)]
pub struct SrpClient {
    _private: (),
}

#[cfg_attr(target_arch = "wasm32", uniffi::export)]
#[cfg_attr(not(target_arch = "wasm32"), uniffi::export(async_runtime = "tokio"))]
impl SrpClient {
    #[uniffi::constructor]
    pub fn new() -> Arc<Self> {
        Arc::new(Self { _private: () })
    }

    pub async fn generate_salt(&self) -> Result<String, CryptoError> {
        run_crypto(|| Ok(srp_client().generate_salt())).await
    }

    pub async fn derive_safe_private_key(
        &self,
        salt: String,
        password: String,
    ) -> Result<String, CryptoError> {
        run_crypto(move || {
            srp_client()
                .derive_safe_private_key(&salt, &password, None)
                .map_err(Into::into)
        })
        .await
    }

    pub async fn derive_verifier(&self, private_key: String) -> Result<String, CryptoError> {
        run_crypto(move || {
            srp_client()
                .derive_verifier(&private_key)
                .map_err(Into::into)
        })
        .await
    }
}

#[derive(uniffi::Object)]
pub struct SrpServer {
    _private: (),
}

#[cfg_attr(target_arch = "wasm32", uniffi::export)]
#[cfg_attr(not(target_arch = "wasm32"), uniffi::export(async_runtime = "tokio"))]
impl SrpServer {
    #[uniffi::constructor]
    pub fn new() -> Arc<Self> {
        Arc::new(Self { _private: () })
    }

    pub async fn generate_ephemeral(
        &self,
        verifier: String,
    ) -> Result<SrpClientEphemeral, CryptoError> {
        run_crypto(move || {
            let server = core::SrpServer::new(
                core::srp6a::HashAlgorithm::Sha256,
                core::srp6a::PrimeGroup::G4096,
            );
            let ephemeral = server.generate_ephemeral(&verifier)?;
            Ok(SrpClientEphemeral {
                public_key: ephemeral.public.clone(),
                secret: ephemeral.secret.clone(),
            })
        })
        .await
    }
}

#[cfg_attr(target_arch = "wasm32", uniffi::export)]
#[cfg_attr(not(target_arch = "wasm32"), uniffi::export(async_runtime = "tokio"))]
pub async fn generate_srp_registration(password: String) -> Result<SrpRegistration, CryptoError> {
    run_crypto(move || {
        let client = srp_client();
        let salt = client.generate_salt();
        let private = client.derive_safe_private_key(&salt, &password, None)?;
        let verifier = client.derive_verifier(&private)?;
        Ok(SrpRegistration { salt, verifier })
    })
    .await
}

#[cfg_attr(target_arch = "wasm32", uniffi::export)]
#[cfg_attr(not(target_arch = "wasm32"), uniffi::export(async_runtime = "tokio"))]
pub async fn generate_client_ephemeral() -> Result<SrpClientEphemeral, CryptoError> {
    run_crypto(|| {
        let ephemeral = srp_client().generate_ephemeral();
        Ok(SrpClientEphemeral {
            public_key: ephemeral.public.clone(),
            secret: ephemeral.secret.clone(),
        })
    })
    .await
}

#[cfg_attr(target_arch = "wasm32", uniffi::export)]
#[cfg_attr(not(target_arch = "wasm32"), uniffi::export(async_runtime = "tokio"))]
pub async fn derive_client_session(
    client_ephemeral_secret: String,
    challenge: SrpServerChallenge,
    password: String,
) -> Result<SrpClientSession, CryptoError> {
    run_crypto(move || {
        let client = srp_client();
        let private = client.derive_safe_private_key(&challenge.salt, &password, None)?;
        let session = client.derive_session(
            &client_ephemeral_secret,
            &challenge.server_public_key,
            &challenge.salt,
            "",
            &private,
        )?;
        Ok(SrpClientSession {
            key: session.key.clone(),
            proof: session.proof.clone(),
        })
    })
    .await
}

#[cfg_attr(target_arch = "wasm32", uniffi::export)]
#[cfg_attr(not(target_arch = "wasm32"), uniffi::export(async_runtime = "tokio"))]
pub async fn verify_server_session(
    client_public_ephemeral: String,
    session: SrpClientSession,
    server_session_proof: String,
) -> Result<(), CryptoError> {
    run_crypto(move || {
        srp_client()
            .verify_session(
                &client_public_ephemeral,
                &core::srp6a::Session {
                    key: session.key,
                    proof: session.proof,
                },
                &server_session_proof,
            )
            .map_err(Into::into)
    })
    .await
}

#[cfg_attr(target_arch = "wasm32", uniffi::export)]
#[cfg_attr(not(target_arch = "wasm32"), uniffi::export(async_runtime = "tokio"))]
pub async fn generate_passkey_keypair() -> Result<PasskeyKeypair, CryptoError> {
    run_crypto(|| {
        let pair = core::generate_passkey_keypair()?;
        Ok(PasskeyKeypair {
            private_key: BASE64.encode(pair.private_key),
            public_key_cose: BASE64.encode(&pair.public_key_cose),
            public_key_spki: BASE64.encode(&pair.public_key_spki),
        })
    })
    .await
}

#[cfg_attr(target_arch = "wasm32", uniffi::export)]
#[cfg_attr(not(target_arch = "wasm32"), uniffi::export(async_runtime = "tokio"))]
pub async fn generate_passkey_credential_id() -> Result<String, CryptoError> {
    run_crypto(|| Ok(BASE64.encode(core::generate_credential_id()))).await
}

#[cfg_attr(target_arch = "wasm32", uniffi::export)]
#[cfg_attr(not(target_arch = "wasm32"), uniffi::export(async_runtime = "tokio"))]
pub async fn build_passkey_attestation_object(
    rp_id: String,
    credential_id_base64: String,
    cose_public_key_base64: String,
    sign_count: u32,
) -> Result<PasskeyAttestation, CryptoError> {
    run_crypto(move || {
        let result = core::build_passkey_attestation_object(
            &rp_id,
            &BASE64.decode(credential_id_base64)?,
            &BASE64.decode(cose_public_key_base64)?,
            sign_count,
        )?;
        Ok(PasskeyAttestation {
            authenticator_data: result.authenticator_data,
            attestation_object: result.attestation_object,
        })
    })
    .await
}

#[cfg_attr(target_arch = "wasm32", uniffi::export)]
#[cfg_attr(not(target_arch = "wasm32"), uniffi::export(async_runtime = "tokio"))]
pub async fn sign_passkey_assertion(
    private_key_base64: String,
    rp_id: String,
    client_data_hash_base64: String,
    sign_count: u32,
) -> Result<PasskeyAssertion, CryptoError> {
    run_crypto(move || {
        let mut private_key = Zeroizing::new(BASE64.decode(private_key_base64)?);
        let result = core::sign_passkey_assertion(
            &private_key,
            &rp_id,
            &BASE64.decode(client_data_hash_base64)?,
            sign_count,
        )?;
        private_key.zeroize();
        Ok(PasskeyAssertion {
            authenticator_data: result.authenticator_data,
            signature_der: result.signature_der,
        })
    })
    .await
}

#[cfg_attr(target_arch = "wasm32", uniffi::export)]
#[cfg_attr(not(target_arch = "wasm32"), uniffi::export(async_runtime = "tokio"))]
pub async fn generate_uuid() -> Result<String, CryptoError> {
    run_crypto(|| Ok(core::generate_uuid())).await
}

#[cfg_attr(target_arch = "wasm32", uniffi::export)]
#[cfg_attr(not(target_arch = "wasm32"), uniffi::export(async_runtime = "tokio"))]
pub async fn generate_totp(
    secret: String,
    algorithm: String,
    digits: u32,
    period: u64,
) -> Result<TotpResult, CryptoError> {
    run_crypto(move || {
        let result = core::generate_totp(&secret, &algorithm, digits, period)?;
        Ok(TotpResult {
            code: result.code,
            remaining_seconds: result.remaining_seconds,
            period: result.period,
            progress: result.progress,
        })
    })
    .await
}

#[cfg_attr(target_arch = "wasm32", uniffi::export)]
#[cfg_attr(not(target_arch = "wasm32"), uniffi::export(async_runtime = "tokio"))]
pub async fn generate_totp_at(
    secret: String,
    algorithm: String,
    digits: u32,
    period: u64,
    timestamp: u64,
) -> Result<String, CryptoError> {
    run_crypto(move || {
        core::generate_totp_at(&secret, &algorithm, digits, period, timestamp).map_err(Into::into)
    })
    .await
}
