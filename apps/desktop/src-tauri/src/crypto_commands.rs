//! Tauri commands for native cryptographic operations
//!
//! Wraps bittery-crypto-core functions for use via Tauri's invoke API.

use base64::{engine::general_purpose::STANDARD, Engine};
use bittery_crypto_core::{
    build_passkey_attestation_object, decrypt, decrypt_master_key, decrypt_with_aad, derive_keys,
    derive_keys_from_master_key, derive_master_key, encrypt, encrypt_master_key, encrypt_with_aad,
    generate_credential_id, generate_encryption_key, generate_passkey_keypair,
    generate_recovery_key, generate_rsa_key_pair, generate_secret_key, generate_uuid,
    get_secret_key_hint,
    key_rotation::{self, ItemData, MemberKeyData, VaultKeyWrapContext},
    rsa_decrypt, rsa_encrypt, sign_passkey_assertion,
    srp6a::{HashAlgorithm, PrimeGroup, SrpClient},
    validate_kdf_profile, validate_recovery_key, validate_secret_key, AadContext, EncryptedData,
    KdfProfile,
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

#[derive(Serialize)]
pub struct PasskeyKeypairResponse {
    pub private_key: String,
    pub public_key_cose: String,
}

#[derive(Serialize)]
pub struct PasskeyAttestationResponse {
    pub authenticator_data: String,
    pub attestation_object: String,
}

#[derive(Serialize)]
pub struct PasskeyAssertionResponse {
    pub authenticator_data: String,
    pub signature_der: String,
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
    schema_version: u32,
    algorithm: String,
    iterations: u32,
) -> Result<DerivedKeysResponse, String> {
    let profile = KdfProfile {
        schema_version,
        algorithm,
        iterations,
    };
    let keys = derive_keys(&password, &secret_key, &email, &profile).map_err(|e| e.to_string())?;

    Ok(DerivedKeysResponse {
        auth_key: STANDARD.encode(&keys.auth_key),
        master_unlock_key: STANDARD.encode(&keys.master_unlock_key),
    })
}

/// Derive the intermediate master key (PBKDF2 output) from password + secret key
#[tauri::command]
pub fn crypto_derive_master_key(
    account_password: String,
    secret_key: String,
    email: String,
    schema_version: u32,
    algorithm: String,
    iterations: u32,
) -> Result<String, String> {
    let profile = KdfProfile {
        schema_version,
        algorithm,
        iterations,
    };
    let master_key = derive_master_key(&account_password, &secret_key, &email, &profile)
        .map_err(|e| e.to_string())?;

    Ok(STANDARD.encode(master_key))
}

/// Split a raw master key into auth key + master unlock key
#[tauri::command]
pub fn crypto_derive_keys_from_master_key(
    master_key_base64: String,
    email: String,
) -> Result<DerivedKeysResponse, String> {
    let master_key = STANDARD
        .decode(&master_key_base64)
        .map_err(|e| format!("Invalid master key base64: {}", e))?;

    let keys = derive_keys_from_master_key(&master_key, &email).map_err(|e| e.to_string())?;

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
pub fn crypto_encrypt(plaintext: String, key_base64: String) -> Result<EncryptResponse, String> {
    let key = STANDARD
        .decode(&key_base64)
        .map_err(|e| format!("Invalid key base64: {}", e))?;

    let encrypted = encrypt(&plaintext, &key).map_err(|e| e.to_string())?;

    Ok(EncryptResponse {
        ciphertext: encrypted.ciphertext,
        iv: encrypted.iv,
        algorithm: encrypted.algorithm,
    })
}

/// Encrypt plaintext using AES-256-GCM with authenticated context
#[tauri::command]
pub fn crypto_encrypt_with_context(
    plaintext: String,
    key_base64: String,
    vault_id: String,
    entity_id: String,
    entity_type: String,
    version: u64,
    user_id: String,
) -> Result<EncryptResponse, String> {
    let key = STANDARD
        .decode(&key_base64)
        .map_err(|e| format!("Invalid key base64: {}", e))?;

    let context = AadContext {
        vault_id,
        entity_id,
        entity_type,
        version,
        user_id,
    };

    let encrypted = encrypt_with_aad(&plaintext, &key, &context).map_err(|e| e.to_string())?;

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
    algorithm: String,
    key_base64: String,
) -> Result<String, String> {
    let key = STANDARD
        .decode(&key_base64)
        .map_err(|e| format!("Invalid key base64: {}", e))?;

    let data = EncryptedData {
        ciphertext,
        iv,
        algorithm,
    };

    decrypt(&data, &key).map_err(|e| e.to_string())
}

/// Decrypt ciphertext using AES-256-GCM with authenticated context
///
/// The argument list is the Tauri IPC contract with the frontend caller; the
/// AAD context fields are passed individually and cannot be grouped without
/// changing the invoke payload shape.
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub fn crypto_decrypt_with_context(
    ciphertext: String,
    iv: String,
    algorithm: String,
    key_base64: String,
    vault_id: String,
    entity_id: String,
    entity_type: String,
    version: u64,
    user_id: String,
) -> Result<String, String> {
    let key = STANDARD
        .decode(&key_base64)
        .map_err(|e| format!("Invalid key base64: {}", e))?;

    let data = EncryptedData {
        ciphertext,
        iv,
        algorithm,
    };
    let context = AadContext {
        vault_id,
        entity_id,
        entity_type,
        version,
        user_id,
    };

    decrypt_with_aad(&data, &key, &context).map_err(|e| e.to_string())
}

/// Validate a server-provided KDF profile against policy and an optional pin.
#[tauri::command]
pub fn crypto_validate_kdf_profile(
    profile_json: String,
    pinned_profile_json: Option<String>,
) -> Result<(), String> {
    let profile: KdfProfile = serde_json::from_str(&profile_json)
        .map_err(|e| format!("Invalid KDF profile JSON: {}", e))?;

    let pinned: Option<KdfProfile> = match pinned_profile_json {
        Some(value) => Some(
            serde_json::from_str(&value)
                .map_err(|e| format!("Invalid pinned KDF profile JSON: {}", e))?,
        ),
        None => None,
    };

    validate_kdf_profile(&profile, pinned.as_ref()).map_err(|e| e.to_string())
}

/// Generate a random 256-bit encryption key
#[tauri::command]
pub fn crypto_generate_encryption_key() -> String {
    STANDARD.encode(generate_encryption_key())
}

/// Generate a random UUID v4 string
#[tauri::command]
pub fn crypto_generate_uuid() -> String {
    generate_uuid()
}

// ============================================================================
// RSA-4096 Commands
// ============================================================================

/// Generate an RSA-4096 key pair
#[tauri::command]
pub fn crypto_generate_rsa_key_pair() -> Result<RsaKeyPairResponse, String> {
    let key_pair = generate_rsa_key_pair().map_err(|e| e.to_string())?;

    Ok(RsaKeyPairResponse {
        public_key: key_pair.public_key.clone(),
        private_key: key_pair.private_key.clone(),
    })
}

/// Encrypt data with RSA-OAEP using a public key
#[tauri::command]
pub fn crypto_rsa_encrypt(plaintext: String, public_key_pem: String) -> Result<String, String> {
    rsa_encrypt(&plaintext, &public_key_pem).map_err(|e| e.to_string())
}

/// Decrypt data with RSA-OAEP using a private key
#[tauri::command]
pub fn crypto_rsa_decrypt(ciphertext: String, private_key_pem: String) -> Result<String, String> {
    rsa_decrypt(&ciphertext, &private_key_pem).map_err(|e| e.to_string())
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

/// Generate a new recovery key in R1-XXXXXX format
#[tauri::command]
pub fn crypto_generate_recovery_key() -> String {
    generate_recovery_key()
}

/// Validate recovery key format
#[tauri::command]
pub fn crypto_validate_recovery_key(recovery_key: String) -> bool {
    validate_recovery_key(&recovery_key)
}

/// Encrypt a raw 32-byte master key using recovery key material
#[tauri::command]
pub fn crypto_encrypt_master_key(
    master_key_base64: String,
    recovery_key: String,
    email: String,
) -> Result<EncryptResponse, String> {
    let master_key = STANDARD
        .decode(&master_key_base64)
        .map_err(|e| format!("Invalid master key base64: {}", e))?;

    let encrypted =
        encrypt_master_key(&master_key, &recovery_key, &email).map_err(|e| e.to_string())?;

    Ok(EncryptResponse {
        ciphertext: encrypted.ciphertext,
        iv: encrypted.iv,
        algorithm: encrypted.algorithm,
    })
}

/// Decrypt an encrypted master key blob using the recovery key
#[tauri::command]
pub fn crypto_decrypt_master_key(
    ciphertext: String,
    iv: String,
    algorithm: String,
    recovery_key: String,
    email: String,
) -> Result<String, String> {
    let data = EncryptedData {
        ciphertext,
        iv,
        algorithm,
    };

    let master_key = decrypt_master_key(&data, &recovery_key, &email).map_err(|e| e.to_string())?;

    Ok(STANDARD.encode(master_key))
}

// ============================================================================
// SRP-6a Client Commands
// ============================================================================

// SRP client state stored between calls.
// For thread-safety, we use a simple approach where each operation is stateless
// by creating fresh clients and relying on the deterministic nature of the operations.

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
    let session = get_srp_client()
        .derive_session(
            &client_secret_ephemeral,
            &server_public_ephemeral,
            &salt,
            &username,
            &private_key,
        )
        .map_err(|e| e.to_string())?;

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

    get_srp_client()
        .verify_session(&client_public_ephemeral, &session, &server_session_proof)
        .map_err(|e| e.to_string())
}

// ============================================================================
// Passkey / WebAuthn Commands
// ============================================================================

/// Generate a P-256 keypair for WebAuthn (private key + COSE public key)
#[tauri::command]
pub fn crypto_passkey_generate_keypair() -> Result<PasskeyKeypairResponse, String> {
    let keypair = generate_passkey_keypair().map_err(|e| e.to_string())?;

    Ok(PasskeyKeypairResponse {
        private_key: STANDARD.encode(keypair.private_key),
        public_key_cose: STANDARD.encode(&keypair.public_key_cose),
    })
}

/// Generate a random 32-byte passkey credential ID
#[tauri::command]
pub fn crypto_passkey_generate_credential_id() -> String {
    STANDARD.encode(generate_credential_id())
}

/// Build authenticator data + attestation object for `navigator.credentials.create()`
#[tauri::command]
pub fn crypto_passkey_build_attestation_object(
    rp_id: String,
    credential_id_base64: String,
    cose_public_key_base64: String,
    sign_count: Option<u32>,
) -> Result<PasskeyAttestationResponse, String> {
    let credential_id = STANDARD
        .decode(&credential_id_base64)
        .map_err(|e| format!("Invalid credential id base64: {}", e))?;
    let cose_public_key = STANDARD
        .decode(&cose_public_key_base64)
        .map_err(|e| format!("Invalid public key base64: {}", e))?;

    let result = build_passkey_attestation_object(
        &rp_id,
        &credential_id,
        &cose_public_key,
        sign_count.unwrap_or(0),
    )
    .map_err(|e| e.to_string())?;

    Ok(PasskeyAttestationResponse {
        authenticator_data: STANDARD.encode(&result.authenticator_data),
        attestation_object: STANDARD.encode(&result.attestation_object),
    })
}

/// Build assertion authenticator data and sign it for `navigator.credentials.get()`
#[tauri::command]
pub fn crypto_passkey_sign_assertion(
    private_key_base64: String,
    rp_id: String,
    client_data_hash_base64: String,
    sign_count: u32,
) -> Result<PasskeyAssertionResponse, String> {
    let private_key = STANDARD
        .decode(&private_key_base64)
        .map_err(|e| format!("Invalid private key base64: {}", e))?;
    let client_data_hash = STANDARD
        .decode(&client_data_hash_base64)
        .map_err(|e| format!("Invalid client data hash base64: {}", e))?;

    let result = sign_passkey_assertion(&private_key, &rp_id, &client_data_hash, sign_count)
        .map_err(|e| e.to_string())?;

    Ok(PasskeyAssertionResponse {
        authenticator_data: STANDARD.encode(&result.authenticator_data),
        signature_der: STANDARD.encode(&result.signature_der),
    })
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
    let vault_key = STANDARD
        .decode(&vault_key_base64)
        .map_err(|e| format!("Invalid vault key base64: {}", e))?;

    key_rotation::encrypt_vault_key_for_member(&vault_key, &member_public_key)
        .map_err(|e| e.to_string())
}

/// Encrypt vault key with AES-GCM using Master Unlock Key
#[tauri::command]
pub fn crypto_encrypt_vault_key_with_muk(
    vault_key_base64: String,
    master_unlock_key_base64: String,
    vault_id: String,
    user_id: String,
    key_version: u64,
) -> Result<String, String> {
    let vault_key = STANDARD
        .decode(&vault_key_base64)
        .map_err(|e| format!("Invalid vault key base64: {}", e))?;
    let muk = STANDARD
        .decode(&master_unlock_key_base64)
        .map_err(|e| format!("Invalid MUK base64: {}", e))?;

    let context = VaultKeyWrapContext::new(&vault_id, &user_id, key_version);
    key_rotation::encrypt_vault_key_with_muk(&vault_key, &muk, &context).map_err(|e| e.to_string())
}

/// Re-encrypt an item with a new vault key
#[tauri::command]
pub fn crypto_re_encrypt_item(
    item: ItemDataInput,
    old_vault_key_base64: String,
    new_vault_key_base64: String,
) -> Result<ReEncryptedItemResponse, String> {
    let old_key = STANDARD
        .decode(&old_vault_key_base64)
        .map_err(|e| format!("Invalid old key base64: {}", e))?;
    let new_key = STANDARD
        .decode(&new_vault_key_base64)
        .map_err(|e| format!("Invalid new key base64: {}", e))?;

    let item_data = ItemData {
        id: item.id,
        encrypted_data: item.encrypted_data,
        encryption_iv: item.encryption_iv,
        encryption_algorithm: item.encryption_algorithm,
    };

    let result =
        key_rotation::re_encrypt_item(&item_data, &old_key, &new_key).map_err(|e| e.to_string())?;

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
    vault_id: String,
    key_version: u64,
    current_user_id: String,
    master_unlock_key_base64: String,
) -> Result<KeyRotationResponse, String> {
    let old_key = STANDARD
        .decode(&old_vault_key_base64)
        .map_err(|e| format!("Invalid old key base64: {}", e))?;
    let muk = STANDARD
        .decode(&master_unlock_key_base64)
        .map_err(|e| format!("Invalid MUK base64: {}", e))?;

    let members_data: Vec<MemberKeyData> = members
        .into_iter()
        .map(|m| MemberKeyData {
            user_id: m.user_id,
            public_key: m.public_key,
        })
        .collect();

    let items_data: Vec<ItemData> = items
        .into_iter()
        .map(|i| ItemData {
            id: i.id,
            encrypted_data: i.encrypted_data,
            encryption_iv: i.encryption_iv,
            encryption_algorithm: i.encryption_algorithm,
        })
        .collect();

    let result = key_rotation::perform_key_rotation(
        &old_key,
        &members_data,
        &items_data,
        &vault_id,
        key_version,
        &current_user_id,
        &muk,
    )
    .map_err(|e| e.to_string())?;

    Ok(KeyRotationResponse {
        member_encrypted_keys: result
            .member_encrypted_keys
            .into_iter()
            .map(|m| MemberEncryptedKeyResponse {
                user_id: m.user_id,
                encrypted_vault_key: m.encrypted_vault_key,
            })
            .collect(),
        re_encrypted_items: result
            .re_encrypted_items
            .into_iter()
            .map(|i| ReEncryptedItemResponse {
                item_id: i.item_id,
                encrypted_data: i.encrypted_data,
                encryption_iv: i.encryption_iv,
            })
            .collect(),
    })
}

/// Validate rotation data
#[tauri::command]
pub fn crypto_validate_rotation_data(members: Vec<MemberKeyInput>) -> ValidationResponse {
    let members_data: Vec<MemberKeyData> = members
        .into_iter()
        .map(|m| MemberKeyData {
            user_id: m.user_id,
            public_key: m.public_key,
        })
        .collect();

    let result = key_rotation::validate_rotation_data(&members_data);

    ValidationResponse {
        valid: result.valid,
        errors: result.errors,
    }
}
