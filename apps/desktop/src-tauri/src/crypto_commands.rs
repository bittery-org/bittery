//! Tauri commands for native cryptographic operations
//!
//! Wraps bittery-crypto-core functions for use via Tauri's invoke API.

use base64::{engine::general_purpose::STANDARD, Engine};
use bittery_crypto_core::{
    decrypt, derive_keys, encrypt, generate_encryption_key, generate_rsa_key_pair,
    generate_secret_key, get_secret_key_hint, rsa_decrypt, rsa_encrypt, validate_secret_key,
    srp6a::{HashAlgorithm, PrimeGroup, SrpClient},
    EncryptedData,
};
use serde::Serialize;

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
        public_key: key_pair.public_key,
        private_key: key_pair.private_key,
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
) -> String {
    get_srp_client().derive_safe_private_key(&salt, &password, iterations)
}

/// Derive the SRP verifier from the private key
#[tauri::command]
pub fn crypto_srp_derive_verifier(private_key: String) -> String {
    get_srp_client().derive_verifier(&private_key)
}

/// Generate client ephemeral key pair
#[tauri::command]
pub fn crypto_srp_generate_ephemeral() -> EphemeralResponse {
    let ephemeral = get_srp_client().generate_ephemeral();
    EphemeralResponse {
        public: ephemeral.public,
        secret: ephemeral.secret,
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
        key: session.key,
        proof: session.proof,
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
