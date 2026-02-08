//! Tauri commands for native cryptographic operations
//!
//! Wraps bittery-crypto-core functions for use via Tauri's invoke API.

use base64::{engine::general_purpose::STANDARD, Engine};
use bittery_crypto_core::{
    decrypt, derive_keys, encrypt, generate_encryption_key, generate_rsa_key_pair,
    generate_secret_key, get_secret_key_hint, rsa_decrypt, rsa_encrypt, validate_secret_key,
    srp6a::{HashAlgorithm, PrimeGroup, SrpClient},
    key_rotation::{self, ItemData, MemberKeyData},
    EncryptedData,
};
use serde::{Deserialize, Serialize};

// ============================================================================
// Response Types
// ============================================================================

#[derive(Serialize)]
pub struct DerivedKeysResponse {
    pub auth_key: String,
    pub master_unlock_key: String,
}

#[derive(Serialize)]
pub struct EncryptResponse {
    pub ciphertext: String,
    pub iv: String,
    pub algorithm: String,
}

#[derive(Serialize)]
pub struct RsaKeyPairResponse {
    pub public_key: String,
    pub private_key: String,
}

#[derive(Serialize)]
pub struct EphemeralResponse {
    pub public: String,
    pub secret: String,
}

#[derive(Serialize)]
pub struct SessionResponse {
    pub key: String,
    pub proof: String,
}

// ============================================================================
// Key Derivation Commands
// ============================================================================

/// Derive authentication and master unlock keys from password, secret key, and email
#[tauri::command]
pub fn crypto_derive_keys(
    password: String,
    secret_key: String,
    email: String,
) -> Result<DerivedKeysResponse, String> {
    let keys = derive_keys(&password, &secret_key, &email)
        .map_err(|e| e.to_string())?;

    Ok(DerivedKeysResponse {
        auth_key: STANDARD.encode(&keys.auth_key),
        master_unlock_key: STANDARD.encode(&keys.master_unlock_key),
    })
}

// ============================================================================
// AES-256-GCM Encryption Commands
// ============================================================================

/// Encrypt plaintext using AES-256-GCM
#[tauri::command]
pub fn crypto_encrypt(
    plaintext: String,
    key_base64: String,
) -> Result<EncryptResponse, String> {
    let key = STANDARD.decode(&key_base64)
        .map_err(|e| format!("Invalid key base64: {}", e))?;

    let encrypted = encrypt(&plaintext, &key)
        .map_err(|e| e.to_string())?;

    Ok(EncryptResponse {
        ciphertext: encrypted.ciphertext,
        iv: encrypted.iv,
        algorithm: encrypted.algorithm,
    })
}

/// Decrypt ciphertext using AES-256-GCM
#[tauri::command]
pub fn crypto_decrypt(
    ciphertext: String,
    iv: String,
    key_base64: String,
) -> Result<String, String> {
    let key = STANDARD.decode(&key_base64)
        .map_err(|e| format!("Invalid key base64: {}", e))?;

    let data = EncryptedData {
        ciphertext,
        iv,
        algorithm: "AES-GCM".to_string(),
    };

    decrypt(&data, &key).map_err(|e| e.to_string())
}

/// Generate a random 256-bit encryption key
#[tauri::command]
pub fn crypto_generate_encryption_key() -> String {
    STANDARD.encode(generate_encryption_key())
}

// ============================================================================
// RSA-4096 Commands
// ============================================================================

/// Generate an RSA-4096 key pair
#[tauri::command]
pub fn crypto_generate_rsa_key_pair() -> Result<RsaKeyPairResponse, String> {
    let key_pair = generate_rsa_key_pair()
        .map_err(|e| e.to_string())?;

    Ok(RsaKeyPairResponse {
        public_key: key_pair.public_key.clone(),
        private_key: key_pair.private_key.clone(),
    })
}

/// Encrypt data with RSA-OAEP using a public key
#[tauri::command]
pub fn crypto_rsa_encrypt(
    plaintext: String,
    public_key_pem: String,
) -> Result<String, String> {
    rsa_encrypt(&plaintext, &public_key_pem)
        .map_err(|e| e.to_string())
}

/// Decrypt data with RSA-OAEP using a private key
#[tauri::command]
pub fn crypto_rsa_decrypt(
    ciphertext: String,
    private_key_pem: String,
) -> Result<String, String> {
    rsa_decrypt(&ciphertext, &private_key_pem)
        .map_err(|e| e.to_string())
}

// ============================================================================
// Secret Key Commands
// ============================================================================

/// Generate a new secret key in A3-XXXXXX format
#[tauri::command]
pub fn crypto_generate_secret_key() -> String {
    generate_secret_key()
}

/// Validate secret key format
#[tauri::command]
pub fn crypto_validate_secret_key(secret_key: String) -> bool {
    validate_secret_key(&secret_key)
}

/// Get the hint (first 5 characters) from a secret key
#[tauri::command]
pub fn crypto_get_secret_key_hint(secret_key: String) -> String {
    get_secret_key_hint(&secret_key)
}

// ============================================================================
// SRP-6a Client Commands
// ============================================================================

/// SRP client state stored between calls
/// For thread-safety, we use a simple approach where each operation is stateless
/// by creating fresh clients and relying on the deterministic nature of the operations.

fn get_srp_client() -> SrpClient {
    // Use SHA-256 and 4096-bit prime group (standard for Bittery)
    SrpClient::new(HashAlgorithm::Sha256, PrimeGroup::G4096)
}

/// Generate a random SRP salt
#[tauri::command]
pub fn crypto_srp_generate_salt() -> String {
    get_srp_client().generate_salt()
}

/// Derive the SRP safe private key from salt and password
#[tauri::command]
pub fn crypto_srp_derive_safe_private_key(
    salt: String,
    password: String,
    iterations: Option<u32>,
) -> Result<String, String> {
    get_srp_client()
        .derive_safe_private_key(&salt, &password, iterations)
        .map_err(|e| e.to_string())
}

/// Derive the SRP verifier from the private key
#[tauri::command]
pub fn crypto_srp_derive_verifier(private_key: String) -> Result<String, String> {
    get_srp_client()
        .derive_verifier(&private_key)
        .map_err(|e| e.to_string())
}

/// Generate client ephemeral key pair
#[tauri::command]
pub fn crypto_srp_generate_ephemeral() -> EphemeralResponse {
    let ephemeral = get_srp_client().generate_ephemeral();
    EphemeralResponse {
        public: ephemeral.public.clone(),
        secret: ephemeral.secret.clone(),
    }
}

/// Derive client session and proof
#[tauri::command]
pub fn crypto_srp_derive_session(
    client_secret_ephemeral: String,
    server_public_ephemeral: String,
    salt: String,
    username: String,
    private_key: String,
) -> Result<SessionResponse, String> {
    let session = get_srp_client().derive_session(
        &client_secret_ephemeral,
        &server_public_ephemeral,
        &salt,
        &username,
        &private_key,
    ).map_err(|e| e.to_string())?;

    Ok(SessionResponse {
        key: session.key.clone(),
        proof: session.proof.clone(),
    })
}

/// Verify server session proof
#[tauri::command]
pub fn crypto_srp_verify_session(
    client_public_ephemeral: String,
    session_key: String,
    session_proof: String,
    server_session_proof: String,
) -> Result<(), String> {
    use bittery_crypto_core::srp6a::Session;

    let session = Session {
        key: session_key,
        proof: session_proof,
    };

    get_srp_client().verify_session(
        &client_public_ephemeral,
        &session,
        &server_session_proof,
    ).map_err(|e| e.to_string())
}

// ============================================================================
// Key Rotation Commands
// ============================================================================

#[derive(Serialize)]
pub struct ReEncryptedItemResponse {
    pub item_id: String,
    pub encrypted_data: String,
    pub encryption_iv: String,
}

#[derive(Serialize)]
pub struct MemberEncryptedKeyResponse {
    pub user_id: String,
    pub encrypted_vault_key: String,
}

#[derive(Serialize)]
pub struct KeyRotationResponse {
    pub new_vault_key_base64: String,
    pub member_encrypted_keys: Vec<MemberEncryptedKeyResponse>,
    pub re_encrypted_items: Vec<ReEncryptedItemResponse>,
}

#[derive(Serialize)]
pub struct ValidationResponse {
    pub valid: bool,
    pub errors: Vec<String>,
}

#[derive(Deserialize)]
pub struct ItemDataInput {
    pub id: String,
    pub encrypted_data: String,
    pub encryption_iv: String,
    pub encryption_algorithm: String,
}

#[derive(Deserialize)]
pub struct MemberKeyInput {
    pub user_id: String,
    pub public_key: String,
}

/// Encrypt vault key for a member using RSA
#[tauri::command]
pub fn crypto_encrypt_vault_key_for_member(
    vault_key_base64: String,
    member_public_key: String,
) -> Result<String, String> {
    let vault_key = STANDARD.decode(&vault_key_base64)
        .map_err(|e| format!("Invalid vault key base64: {}", e))?;

    key_rotation::encrypt_vault_key_for_member(&vault_key, &member_public_key)
        .map_err(|e| e.to_string())
}

/// Encrypt vault key with AES-GCM using Master Unlock Key
#[tauri::command]
pub fn crypto_encrypt_vault_key_with_muk(
    vault_key_base64: String,
    master_unlock_key_base64: String,
) -> Result<String, String> {
    let vault_key = STANDARD.decode(&vault_key_base64)
        .map_err(|e| format!("Invalid vault key base64: {}", e))?;
    let muk = STANDARD.decode(&master_unlock_key_base64)
        .map_err(|e| format!("Invalid MUK base64: {}", e))?;

    key_rotation::encrypt_vault_key_with_muk(&vault_key, &muk)
        .map_err(|e| e.to_string())
}

/// Re-encrypt an item with a new vault key
#[tauri::command]
pub fn crypto_re_encrypt_item(
    item: ItemDataInput,
    old_vault_key_base64: String,
    new_vault_key_base64: String,
) -> Result<ReEncryptedItemResponse, String> {
    let old_key = STANDARD.decode(&old_vault_key_base64)
        .map_err(|e| format!("Invalid old key base64: {}", e))?;
    let new_key = STANDARD.decode(&new_vault_key_base64)
        .map_err(|e| format!("Invalid new key base64: {}", e))?;

    let item_data = ItemData {
        id: item.id,
        encrypted_data: item.encrypted_data,
        encryption_iv: item.encryption_iv,
        encryption_algorithm: item.encryption_algorithm,
    };

    let result = key_rotation::re_encrypt_item(&item_data, &old_key, &new_key)
        .map_err(|e| e.to_string())?;

    Ok(ReEncryptedItemResponse {
        item_id: result.item_id,
        encrypted_data: result.encrypted_data,
        encryption_iv: result.encryption_iv,
    })
}

/// Perform complete key rotation
#[tauri::command]
pub fn crypto_perform_key_rotation(
    old_vault_key_base64: String,
    members: Vec<MemberKeyInput>,
    items: Vec<ItemDataInput>,
    current_user_id: String,
    master_unlock_key_base64: String,
) -> Result<KeyRotationResponse, String> {
    let old_key = STANDARD.decode(&old_vault_key_base64)
        .map_err(|e| format!("Invalid old key base64: {}", e))?;
    let muk = STANDARD.decode(&master_unlock_key_base64)
        .map_err(|e| format!("Invalid MUK base64: {}", e))?;

    let members_data: Vec<MemberKeyData> = members.into_iter().map(|m| MemberKeyData {
        user_id: m.user_id,
        public_key: m.public_key,
    }).collect();

    let items_data: Vec<ItemData> = items.into_iter().map(|i| ItemData {
        id: i.id,
        encrypted_data: i.encrypted_data,
        encryption_iv: i.encryption_iv,
        encryption_algorithm: i.encryption_algorithm,
    }).collect();

    let result = key_rotation::perform_key_rotation(&old_key, &members_data, &items_data, &current_user_id, &muk)
        .map_err(|e| e.to_string())?;

    Ok(KeyRotationResponse {
        new_vault_key_base64: result.new_vault_key_base64,
        member_encrypted_keys: result.member_encrypted_keys.into_iter().map(|m| MemberEncryptedKeyResponse {
            user_id: m.user_id,
            encrypted_vault_key: m.encrypted_vault_key,
        }).collect(),
        re_encrypted_items: result.re_encrypted_items.into_iter().map(|i| ReEncryptedItemResponse {
            item_id: i.item_id,
            encrypted_data: i.encrypted_data,
            encryption_iv: i.encryption_iv,
        }).collect(),
    })
}

/// Validate rotation data
#[tauri::command]
pub fn crypto_validate_rotation_data(
    members: Vec<MemberKeyInput>,
) -> ValidationResponse {
    let members_data: Vec<MemberKeyData> = members.into_iter().map(|m| MemberKeyData {
        user_id: m.user_id,
        public_key: m.public_key,
    }).collect();

    let result = key_rotation::validate_rotation_data(&members_data);

    ValidationResponse {
        valid: result.valid,
        errors: result.errors,
    }
}
