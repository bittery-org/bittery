//! WebAssembly bindings for Bittery Crypto
//!
//! Exposes the core crypto library to JavaScript/TypeScript via wasm-bindgen.

use bittery_crypto_core::{
    decrypt, decrypt_master_key, derive_keys, derive_keys_from_master_key, derive_master_key,
    decrypt_with_aad, encrypt, encrypt_master_key, encrypt_with_aad, generate_credential_id,
    generate_encryption_key, generate_uuid,
    generate_passkey_keypair, generate_recovery_key, generate_rsa_key_pair, generate_secret_key,
    get_secret_key_hint,
    kdf_policy::{KdfParams, KDF_ALGORITHM_PBKDF2_SHA256},
    key_rotation::{self, ItemData, MemberKeyData, VaultKeyWrapContext},
    PBKDF2_ITERATIONS,
    passkey::{build_passkey_attestation_object, sign_passkey_assertion},
    rsa_decrypt, rsa_encrypt,
    srp6a::{HashAlgorithm, PrimeGroup, SrpClient, SrpServer},
    validate_recovery_key, validate_secret_key, validate_server_kdf_params, AadContext,
    EncryptedData,
};
use serde::{Deserialize, Serialize};
use std::cell::{Cell, RefCell};
use std::collections::HashMap;
use wasm_bindgen::prelude::*;
use wasm_bindgen::JsValue;
use zeroize::Zeroize;

thread_local! {
    static KEY_HANDLE_STORE: RefCell<HashMap<u64, Vec<u8>>> = RefCell::new(HashMap::new());
    static NEXT_KEY_HANDLE: Cell<u64> = const { Cell::new(1) };
}

fn insert_key_handle(secret: &[u8]) -> u64 {
    let handle = NEXT_KEY_HANDLE.with(|counter| {
        let current = counter.get();
        counter.set(current.wrapping_add(1).max(1));
        current
    });

    KEY_HANDLE_STORE.with(|store| {
        store.borrow_mut().insert(handle, secret.to_vec());
    });

    handle
}

fn with_key_handle<T, F>(key_handle: u64, operation: F) -> Result<T, JsError>
where
    F: FnOnce(&[u8]) -> Result<T, JsError>,
{
    KEY_HANDLE_STORE.with(|store| {
        let map = store.borrow();
        let key = map
            .get(&key_handle)
            .ok_or_else(|| JsError::new("Invalid or expired key handle"))?;
        operation(key.as_slice())
    })
}

fn clone_key_material(key_handle: u64) -> Result<Vec<u8>, JsError> {
    KEY_HANDLE_STORE.with(|store| {
        store
            .borrow()
            .get(&key_handle)
            .cloned()
            .ok_or_else(|| JsError::new("Invalid or expired key handle"))
    })
}

fn destroy_key_handle_internal(key_handle: u64) -> bool {
    KEY_HANDLE_STORE.with(|store| {
        let mut map = store.borrow_mut();
        match map.remove(&key_handle) {
            Some(mut key) => {
                key.zeroize();
                true
            }
            None => false,
        }
    })
}

// Initialize panic hook for better error messages
#[wasm_bindgen(start)]
pub fn init() {
    console_error_panic_hook::set_once();
}

// ============================================================================
// Type Conversions
// ============================================================================

#[wasm_bindgen]
#[derive(Serialize, Deserialize)]
pub struct JsDerivedKeys {
    #[wasm_bindgen(getter_with_clone)]
    pub auth_key: String,
    #[wasm_bindgen(getter_with_clone)]
    pub master_unlock_key: String,
}

#[wasm_bindgen]
#[derive(Serialize, Deserialize)]
pub struct JsDerivedKeyHandles {
    pub auth_key_handle: u64,
    pub master_unlock_key_handle: u64,
}

#[wasm_bindgen]
#[derive(Serialize, Deserialize)]
pub struct JsEncryptedData {
    #[wasm_bindgen(getter_with_clone)]
    pub ciphertext: String,
    #[wasm_bindgen(getter_with_clone)]
    pub iv: String,
    #[wasm_bindgen(getter_with_clone)]
    pub algorithm: String,
}

#[wasm_bindgen]
impl JsEncryptedData {
    /// Create a new JsEncryptedData instance
    #[wasm_bindgen(constructor)]
    pub fn new(ciphertext: String, iv: String, algorithm: String) -> JsEncryptedData {
        JsEncryptedData {
            ciphertext,
            iv,
            algorithm,
        }
    }
}

#[wasm_bindgen]
#[derive(Serialize, Deserialize)]
pub struct JsRsaKeyPair {
    #[wasm_bindgen(getter_with_clone)]
    pub public_key: String,
    #[wasm_bindgen(getter_with_clone)]
    pub private_key: String,
}

#[wasm_bindgen]
#[derive(Serialize, Deserialize)]
pub struct JsEphemeral {
    #[wasm_bindgen(getter_with_clone)]
    pub public: String,
    #[wasm_bindgen(getter_with_clone)]
    pub secret: String,
}

#[wasm_bindgen]
#[derive(Serialize, Deserialize, Clone)]
pub struct JsSession {
    #[wasm_bindgen(getter_with_clone)]
    pub key: String,
    #[wasm_bindgen(getter_with_clone)]
    pub proof: String,
}

#[wasm_bindgen]
#[derive(Serialize, Deserialize)]
pub struct JsAadContext {
    #[wasm_bindgen(getter_with_clone)]
    pub vault_id: String,
    #[wasm_bindgen(getter_with_clone)]
    pub entity_id: String,
    #[wasm_bindgen(getter_with_clone)]
    pub entity_type: String,
    #[wasm_bindgen(getter_with_clone)]
    pub version: u64,
    #[wasm_bindgen(getter_with_clone)]
    pub user_id: String,
}

#[wasm_bindgen]
impl JsAadContext {
    #[wasm_bindgen(constructor)]
    pub fn new(
        vault_id: String,
        entity_id: String,
        entity_type: String,
        version: u64,
        user_id: String,
    ) -> JsAadContext {
        JsAadContext {
            vault_id,
            entity_id,
            entity_type,
            version,
            user_id,
        }
    }
}

impl From<JsAadContext> for AadContext {
    fn from(value: JsAadContext) -> Self {
        AadContext {
            vault_id: value.vault_id,
            entity_id: value.entity_id,
            entity_type: value.entity_type,
            version: value.version,
            user_id: value.user_id,
        }
    }
}

// ============================================================================
// Key Derivation
// ============================================================================

/// Resolve optional KDF params to concrete values, defaulting to the current
/// PBKDF2-SHA256 baseline when the caller does not negotiate them.
fn resolve_kdf_params(algorithm: Option<String>, iterations: Option<u32>) -> (String, u32) {
    (
        algorithm.unwrap_or_else(|| KDF_ALGORITHM_PBKDF2_SHA256.to_string()),
        iterations.unwrap_or(PBKDF2_ITERATIONS),
    )
}

/// Derive authentication and master unlock keys from password + secret key
#[wasm_bindgen(js_name = deriveKeys)]
pub fn js_derive_keys(
    account_password: &str,
    secret_key: &str,
    email: &str,
    iterations: Option<u32>,
    algorithm: Option<String>,
) -> Result<JsDerivedKeys, JsError> {
    let (algorithm, iterations) = resolve_kdf_params(algorithm, iterations);
    let keys = derive_keys(account_password, secret_key, email, &algorithm, iterations)
        .map_err(|e| JsError::new(&e.to_string()))?;

    Ok(JsDerivedKeys {
        auth_key: base64_encode(&keys.auth_key),
        master_unlock_key: base64_encode(&keys.master_unlock_key),
    })
}

/// Derive authentication and master unlock key handles from password + secret key.
#[wasm_bindgen(js_name = deriveKeysHandle)]
pub fn js_derive_keys_handle(
    account_password: &str,
    secret_key: &str,
    email: &str,
    iterations: Option<u32>,
    algorithm: Option<String>,
) -> Result<JsDerivedKeyHandles, JsError> {
    let (algorithm, iterations) = resolve_kdf_params(algorithm, iterations);
    let keys = derive_keys(account_password, secret_key, email, &algorithm, iterations)
        .map_err(|e| JsError::new(&e.to_string()))?;

    let auth_key_handle = insert_key_handle(&keys.auth_key);
    let master_unlock_key_handle = insert_key_handle(&keys.master_unlock_key);

    Ok(JsDerivedKeyHandles {
        auth_key_handle,
        master_unlock_key_handle,
    })
}

/// Derive intermediate master key (PBKDF2 output) from password + secret key
#[wasm_bindgen(js_name = deriveMasterKey)]
pub fn js_derive_master_key(
    account_password: &str,
    secret_key: &str,
    email: &str,
    iterations: Option<u32>,
    algorithm: Option<String>,
) -> Result<String, JsError> {
    let (algorithm, iterations) = resolve_kdf_params(algorithm, iterations);
    let master_key = derive_master_key(account_password, secret_key, email, &algorithm, iterations)
        .map_err(|e| JsError::new(&e.to_string()))?;
    Ok(base64_encode(&master_key))
}

/// Derive intermediate master key and return it as an opaque handle.
#[wasm_bindgen(js_name = deriveMasterKeyHandle)]
pub fn js_derive_master_key_handle(
    account_password: &str,
    secret_key: &str,
    email: &str,
    iterations: Option<u32>,
    algorithm: Option<String>,
) -> Result<u64, JsError> {
    let (algorithm, iterations) = resolve_kdf_params(algorithm, iterations);
    let master_key = derive_master_key(account_password, secret_key, email, &algorithm, iterations)
        .map_err(|e| JsError::new(&e.to_string()))?;
    Ok(insert_key_handle(&master_key))
}

/// Derive auth key + master unlock key from a raw master key
#[wasm_bindgen(js_name = deriveKeysFromMasterKey)]
pub fn js_derive_keys_from_master_key(
    master_key_base64: &str,
    email: &str,
) -> Result<JsDerivedKeys, JsError> {
    let master_key = base64_decode(master_key_base64)?;
    let keys = derive_keys_from_master_key(&master_key, email)
        .map_err(|e| JsError::new(&e.to_string()))?;

    Ok(JsDerivedKeys {
        auth_key: base64_encode(&keys.auth_key),
        master_unlock_key: base64_encode(&keys.master_unlock_key),
    })
}

/// Derive auth key + master unlock key handles from a master-key handle.
#[wasm_bindgen(js_name = deriveKeysFromMasterKeyHandle)]
pub fn js_derive_keys_from_master_key_handle(
    master_key_handle: u64,
    email: &str,
) -> Result<JsDerivedKeyHandles, JsError> {
    let keys = with_key_handle(master_key_handle, |master_key| {
        derive_keys_from_master_key(master_key, email).map_err(|e| JsError::new(&e.to_string()))
    })?;

    let auth_key_handle = insert_key_handle(&keys.auth_key);
    let master_unlock_key_handle = insert_key_handle(&keys.master_unlock_key);

    Ok(JsDerivedKeyHandles {
        auth_key_handle,
        master_unlock_key_handle,
    })
}

/// Import a base64-encoded 32-byte key into the opaque handle store.
#[wasm_bindgen(js_name = importKeyHandle)]
pub fn js_import_key_handle(key_base64: &str) -> Result<u64, JsError> {
    let key = base64_decode(key_base64)?;
    Ok(insert_key_handle(&key))
}

/// Export an opaque key handle as base64.
#[wasm_bindgen(js_name = exportKeyHandle)]
pub fn js_export_key_handle(key_handle: u64) -> Result<String, JsError> {
    with_key_handle(key_handle, |key| Ok(base64_encode(key)))
}

/// Duplicate a key handle.
#[wasm_bindgen(js_name = cloneKeyHandle)]
pub fn js_clone_key_handle(key_handle: u64) -> Result<u64, JsError> {
    let key = clone_key_material(key_handle)?;
    Ok(insert_key_handle(&key))
}

/// Destroy a key handle and zeroize backing memory.
#[wasm_bindgen(js_name = destroyKeyHandle)]
pub fn js_destroy_key_handle(key_handle: u64) -> bool {
    destroy_key_handle_internal(key_handle)
}

/// Convert an auth-key handle into the SRP password string used by existing APIs.
#[wasm_bindgen(js_name = deriveSrpPasswordFromHandle)]
pub fn js_derive_srp_password_from_handle(auth_key_handle: u64) -> Result<String, JsError> {
    with_key_handle(auth_key_handle, |auth_key| {
        Ok(String::from_utf8_lossy(auth_key).to_string())
    })
}

// ============================================================================
// KDF Policy Validation
// ============================================================================

#[wasm_bindgen(js_name = validateServerKdfParams)]
pub fn js_validate_server_kdf_params(
    server_params: JsValue,
    pinned_params: Option<JsValue>,
) -> Result<(), JsError> {
    let server: KdfParams = serde_wasm_bindgen::from_value(server_params)
        .map_err(|e| JsError::new(&format!("Invalid server KDF params: {}", e)))?;

    let pinned: Option<KdfParams> = match pinned_params {
        Some(value) => Some(
            serde_wasm_bindgen::from_value(value)
                .map_err(|e| JsError::new(&format!("Invalid pinned KDF params: {}", e)))?,
        ),
        None => None,
    };

    validate_server_kdf_params(&server, pinned.as_ref())
        .map_err(|e| JsError::new(&e.to_string()))
}

// ============================================================================
// AES-256-GCM Encryption
// ============================================================================

/// Encrypt plaintext using AES-256-GCM
#[wasm_bindgen(js_name = encrypt)]
pub fn js_encrypt(plaintext: &str, key_base64: &str) -> Result<JsEncryptedData, JsError> {
    let key = base64_decode(key_base64)?;
    let encrypted = encrypt(plaintext, &key).map_err(|e| JsError::new(&e.to_string()))?;

    Ok(JsEncryptedData {
        ciphertext: encrypted.ciphertext,
        iv: encrypted.iv,
        algorithm: encrypted.algorithm,
    })
}

/// Encrypt plaintext using AES-256-GCM with an opaque key handle.
#[wasm_bindgen(js_name = encryptWithHandle)]
pub fn js_encrypt_with_handle(
    plaintext: &str,
    key_handle: u64,
) -> Result<JsEncryptedData, JsError> {
    with_key_handle(key_handle, |key| {
        let encrypted = encrypt(plaintext, key).map_err(|e| JsError::new(&e.to_string()))?;
        Ok(JsEncryptedData {
            ciphertext: encrypted.ciphertext,
            iv: encrypted.iv,
            algorithm: encrypted.algorithm,
        })
    })
}

/// Encrypt plaintext using AES-256-GCM with authenticated context.
#[wasm_bindgen(js_name = encryptWithContext)]
pub fn js_encrypt_with_context(
    plaintext: &str,
    key_base64: &str,
    context: JsAadContext,
) -> Result<JsEncryptedData, JsError> {
    let key = base64_decode(key_base64)?;
    let encrypted = encrypt_with_aad(plaintext, &key, &context.into())
        .map_err(|e| JsError::new(&e.to_string()))?;

    Ok(JsEncryptedData {
        ciphertext: encrypted.ciphertext,
        iv: encrypted.iv,
        algorithm: encrypted.algorithm,
    })
}

/// Encrypt plaintext using AES-256-GCM with authenticated context and key handle.
#[wasm_bindgen(js_name = encryptWithContextHandle)]
pub fn js_encrypt_with_context_handle(
    plaintext: &str,
    key_handle: u64,
    context: JsAadContext,
) -> Result<JsEncryptedData, JsError> {
    let aad_context: AadContext = context.into();
    with_key_handle(key_handle, |key| {
        let encrypted = encrypt_with_aad(plaintext, key, &aad_context)
            .map_err(|e| JsError::new(&e.to_string()))?;
        Ok(JsEncryptedData {
            ciphertext: encrypted.ciphertext,
            iv: encrypted.iv,
            algorithm: encrypted.algorithm,
        })
    })
}

/// Decrypt data using AES-256-GCM
#[wasm_bindgen(js_name = decrypt)]
pub fn js_decrypt(encrypted_data: JsEncryptedData, key_base64: &str) -> Result<String, JsError> {
    let key = base64_decode(key_base64)?;
    let data = EncryptedData {
        ciphertext: encrypted_data.ciphertext,
        iv: encrypted_data.iv,
        algorithm: encrypted_data.algorithm,
    };

    decrypt(&data, &key).map_err(|e| JsError::new(&e.to_string()))
}

/// Decrypt data using AES-256-GCM and an opaque key handle.
#[wasm_bindgen(js_name = decryptWithHandle)]
pub fn js_decrypt_with_handle(
    encrypted_data: JsEncryptedData,
    key_handle: u64,
) -> Result<String, JsError> {
    let data = EncryptedData {
        ciphertext: encrypted_data.ciphertext,
        iv: encrypted_data.iv,
        algorithm: encrypted_data.algorithm,
    };

    with_key_handle(key_handle, |key| {
        decrypt(&data, key).map_err(|e| JsError::new(&e.to_string()))
    })
}

/// Decrypt data using AES-256-GCM with authenticated context.
#[wasm_bindgen(js_name = decryptWithContext)]
pub fn js_decrypt_with_context(
    encrypted_data: JsEncryptedData,
    key_base64: &str,
    context: JsAadContext,
) -> Result<String, JsError> {
    let key = base64_decode(key_base64)?;
    let data = EncryptedData {
        ciphertext: encrypted_data.ciphertext,
        iv: encrypted_data.iv,
        algorithm: encrypted_data.algorithm,
    };

    decrypt_with_aad(&data, &key, &context.into()).map_err(|e| JsError::new(&e.to_string()))
}

/// Decrypt data using AES-256-GCM with authenticated context and key handle.
#[wasm_bindgen(js_name = decryptWithContextHandle)]
pub fn js_decrypt_with_context_handle(
    encrypted_data: JsEncryptedData,
    key_handle: u64,
    context: JsAadContext,
) -> Result<String, JsError> {
    let aad_context: AadContext = context.into();
    let data = EncryptedData {
        ciphertext: encrypted_data.ciphertext,
        iv: encrypted_data.iv,
        algorithm: encrypted_data.algorithm,
    };

    with_key_handle(key_handle, |key| {
        decrypt_with_aad(&data, key, &aad_context).map_err(|e| JsError::new(&e.to_string()))
    })
}

/// Encrypt key material referenced by an opaque handle with a raw wrapping key.
#[wasm_bindgen(js_name = encryptKeyHandleWithKey)]
pub fn js_encrypt_key_handle_with_key(
    key_handle: u64,
    wrapping_key_base64: &str,
) -> Result<JsEncryptedData, JsError> {
    let wrapping_key = base64_decode(wrapping_key_base64)?;
    with_key_handle(key_handle, |key_material| {
        let mut key_material_base64 = base64_encode(key_material);
        let encrypted = encrypt(&key_material_base64, &wrapping_key)
            .map_err(|e| JsError::new(&e.to_string()))?;
        key_material_base64.zeroize();

        Ok(JsEncryptedData {
            ciphertext: encrypted.ciphertext,
            iv: encrypted.iv,
            algorithm: encrypted.algorithm,
        })
    })
}

/// Decrypt key material with a raw wrapping key and store it as an opaque handle.
#[wasm_bindgen(js_name = decryptKeyHandleWithKey)]
pub fn js_decrypt_key_handle_with_key(
    encrypted_data: JsEncryptedData,
    wrapping_key_base64: &str,
) -> Result<u64, JsError> {
    let wrapping_key = base64_decode(wrapping_key_base64)?;
    let data = EncryptedData {
        ciphertext: encrypted_data.ciphertext,
        iv: encrypted_data.iv,
        algorithm: encrypted_data.algorithm,
    };

    let mut decrypted_base64 =
        decrypt(&data, &wrapping_key).map_err(|e| JsError::new(&e.to_string()))?;
    let mut key_material = base64_decode(&decrypted_base64)?;
    decrypted_base64.zeroize();

    let handle = insert_key_handle(&key_material);
    key_material.zeroize();
    Ok(handle)
}

/// Generate a random 32-byte encryption key
#[wasm_bindgen(js_name = generateEncryptionKey)]
pub fn js_generate_encryption_key() -> String {
    base64_encode(&generate_encryption_key())
}

/// Generate a random UUID v4 string.
#[wasm_bindgen(js_name = generateUuid)]
pub fn js_generate_uuid() -> String {
    generate_uuid()
}

// ============================================================================
// RSA-4096
// ============================================================================

/// Generate RSA-4096 key pair
#[wasm_bindgen(js_name = generateRSAKeyPair)]
pub fn js_generate_rsa_key_pair() -> Result<JsRsaKeyPair, JsError> {
    let key_pair = generate_rsa_key_pair().map_err(|e| JsError::new(&e.to_string()))?;

    Ok(JsRsaKeyPair {
        public_key: key_pair.public_key.clone(),
        private_key: key_pair.private_key.clone(),
    })
}

/// Encrypt with RSA public key
#[wasm_bindgen(js_name = rsaEncrypt)]
pub fn js_rsa_encrypt(plaintext: &str, public_key_pem: &str) -> Result<String, JsError> {
    rsa_encrypt(plaintext, public_key_pem).map_err(|e| JsError::new(&e.to_string()))
}

/// Decrypt with RSA private key
#[wasm_bindgen(js_name = rsaDecrypt)]
pub fn js_rsa_decrypt(ciphertext: &str, private_key_pem: &str) -> Result<String, JsError> {
    rsa_decrypt(ciphertext, private_key_pem).map_err(|e| JsError::new(&e.to_string()))
}

// ============================================================================
// Secret Key
// ============================================================================

/// Generate a new secret key
#[wasm_bindgen(js_name = generateSecretKey)]
pub fn js_generate_secret_key() -> String {
    generate_secret_key()
}

/// Generate a new recovery key
#[wasm_bindgen(js_name = generateRecoveryKey)]
pub fn js_generate_recovery_key() -> String {
    generate_recovery_key()
}

/// Validate secret key format
#[wasm_bindgen(js_name = validateSecretKey)]
pub fn js_validate_secret_key(secret_key: &str) -> bool {
    validate_secret_key(secret_key)
}

/// Validate recovery key format
#[wasm_bindgen(js_name = validateRecoveryKey)]
pub fn js_validate_recovery_key(recovery_key: &str) -> bool {
    validate_recovery_key(recovery_key)
}

/// Get secret key hint (first segment)
#[wasm_bindgen(js_name = getSecretKeyHint)]
pub fn js_get_secret_key_hint(secret_key: &str) -> String {
    get_secret_key_hint(secret_key)
}

/// Encrypt a raw 32-byte master key using recovery key material
#[wasm_bindgen(js_name = encryptMasterKey)]
pub fn js_encrypt_master_key(
    master_key_base64: &str,
    recovery_key: &str,
    email: &str,
) -> Result<JsEncryptedData, JsError> {
    let master_key = base64_decode(master_key_base64)?;
    let encrypted =
        encrypt_master_key(&master_key, recovery_key, email).map_err(|e| JsError::new(&e.to_string()))?;

    Ok(JsEncryptedData {
        ciphertext: encrypted.ciphertext,
        iv: encrypted.iv,
        algorithm: encrypted.algorithm,
    })
}

/// Decrypt encrypted recovery material and return the raw master key as base64
#[wasm_bindgen(js_name = decryptMasterKey)]
pub fn js_decrypt_master_key(
    encrypted_data: JsEncryptedData,
    recovery_key: &str,
    email: &str,
) -> Result<String, JsError> {
    let data = EncryptedData {
        ciphertext: encrypted_data.ciphertext,
        iv: encrypted_data.iv,
        algorithm: encrypted_data.algorithm,
    };

    let master_key =
        decrypt_master_key(&data, recovery_key, email).map_err(|e| JsError::new(&e.to_string()))?;
    Ok(base64_encode(&master_key))
}

// ============================================================================
// SRP-6a
// ============================================================================

/// SRP Client wrapper for JavaScript
#[wasm_bindgen]
pub struct JsSrpClient {
    client: SrpClient,
}

#[wasm_bindgen]
impl JsSrpClient {
    /// Create a new SRP client
    #[wasm_bindgen(constructor)]
    pub fn new(hash_algorithm: &str, prime_group: u32) -> Result<JsSrpClient, JsError> {
        let hash = parse_hash_algorithm(hash_algorithm)?;
        let group = parse_prime_group(prime_group)?;
        Ok(JsSrpClient {
            client: SrpClient::new(hash, group),
        })
    }

    /// Generate a random salt
    #[wasm_bindgen(js_name = generateSalt)]
    pub fn generate_salt(&self) -> String {
        self.client.generate_salt()
    }

    /// Derive private key using PBKDF2
    #[wasm_bindgen(js_name = deriveSafePrivateKey)]
    pub fn derive_safe_private_key(
        &self,
        salt: &str,
        password: &str,
        iterations: Option<u32>,
    ) -> Result<String, JsError> {
        self.client
            .derive_safe_private_key(salt, password, iterations)
            .map_err(|e| JsError::new(&e.to_string()))
    }

    /// Derive verifier from private key
    #[wasm_bindgen(js_name = deriveVerifier)]
    pub fn derive_verifier(&self, private_key: &str) -> Result<String, JsError> {
        self.client
            .derive_verifier(private_key)
            .map_err(|e| JsError::new(&e.to_string()))
    }

    /// Generate client ephemeral
    #[wasm_bindgen(js_name = generateEphemeral)]
    pub fn generate_ephemeral(&self) -> JsEphemeral {
        let ephemeral = self.client.generate_ephemeral();
        JsEphemeral {
            public: ephemeral.public.clone(),
            secret: ephemeral.secret.clone(),
        }
    }

    /// Derive session key and proof
    #[wasm_bindgen(js_name = deriveSession)]
    pub fn derive_session(
        &self,
        client_secret_ephemeral: &str,
        server_public_ephemeral: &str,
        salt: &str,
        username: &str,
        private_key: &str,
    ) -> Result<JsSession, JsError> {
        let session = self
            .client
            .derive_session(
                client_secret_ephemeral,
                server_public_ephemeral,
                salt,
                username,
                private_key,
            )
            .map_err(|e| JsError::new(&e.to_string()))?;

        Ok(JsSession {
            key: session.key.clone(),
            proof: session.proof.clone(),
        })
    }

    /// Verify server session proof
    #[wasm_bindgen(js_name = verifySession)]
    pub fn verify_session(
        &self,
        client_public_ephemeral: &str,
        client_session: &JsSession,
        server_session_proof: &str,
    ) -> Result<(), JsError> {
        let session = bittery_crypto_core::srp6a::Session {
            key: client_session.key.clone(),
            proof: client_session.proof.clone(),
        };

        self.client
            .verify_session(client_public_ephemeral, &session, server_session_proof)
            .map_err(|e| JsError::new(&e.to_string()))
    }
}

/// SRP Server wrapper for JavaScript
#[wasm_bindgen]
pub struct JsSrpServer {
    server: SrpServer,
}

#[wasm_bindgen]
impl JsSrpServer {
    /// Create a new SRP server
    #[wasm_bindgen(constructor)]
    pub fn new(hash_algorithm: &str, prime_group: u32) -> Result<JsSrpServer, JsError> {
        let hash = parse_hash_algorithm(hash_algorithm)?;
        let group = parse_prime_group(prime_group)?;
        Ok(JsSrpServer {
            server: SrpServer::new(hash, group),
        })
    }

    /// Generate server ephemeral
    #[wasm_bindgen(js_name = generateEphemeral)]
    pub fn generate_ephemeral(&self, verifier: &str) -> Result<JsEphemeral, JsError> {
        let ephemeral = self
            .server
            .generate_ephemeral(verifier)
            .map_err(|e| JsError::new(&e.to_string()))?;
        Ok(JsEphemeral {
            public: ephemeral.public.clone(),
            secret: ephemeral.secret.clone(),
        })
    }

    /// Derive session key and verify client proof
    #[wasm_bindgen(js_name = deriveSession)]
    pub fn derive_session(
        &self,
        server_secret_ephemeral: &str,
        client_public_ephemeral: &str,
        salt: &str,
        username: &str,
        verifier: &str,
        client_session_proof: &str,
    ) -> Result<JsSession, JsError> {
        let session = self
            .server
            .derive_session(
                server_secret_ephemeral,
                client_public_ephemeral,
                salt,
                username,
                verifier,
                client_session_proof,
            )
            .map_err(|e| JsError::new(&e.to_string()))?;

        Ok(JsSession {
            key: session.key.clone(),
            proof: session.proof.clone(),
        })
    }
}

// ============================================================================
// Passkey / WebAuthn
// ============================================================================

#[wasm_bindgen]
#[derive(Serialize, Deserialize)]
pub struct JsPasskeyKeypair {
    #[wasm_bindgen(getter_with_clone)]
    pub private_key: String,
    #[wasm_bindgen(getter_with_clone)]
    pub public_key_cose: String,
}

#[wasm_bindgen]
#[derive(Serialize, Deserialize)]
pub struct JsPasskeyAttestation {
    #[wasm_bindgen(getter_with_clone)]
    pub authenticator_data: String,
    #[wasm_bindgen(getter_with_clone)]
    pub attestation_object: String,
}

#[wasm_bindgen]
#[derive(Serialize, Deserialize)]
pub struct JsPasskeyAssertion {
    #[wasm_bindgen(getter_with_clone)]
    pub authenticator_data: String,
    #[wasm_bindgen(getter_with_clone)]
    pub signature_der: String,
}

/// Generate passkey private key and COSE public key.
#[wasm_bindgen(js_name = generatePasskeyKeypair)]
pub fn js_generate_passkey_keypair() -> Result<JsPasskeyKeypair, JsError> {
    let keypair = generate_passkey_keypair().map_err(|e| JsError::new(&e.to_string()))?;
    Ok(JsPasskeyKeypair {
        private_key: base64_encode(&keypair.private_key),
        public_key_cose: base64_encode(&keypair.public_key_cose),
    })
}

/// Generate a random passkey credential ID (32 bytes), base64 encoded.
#[wasm_bindgen(js_name = generatePasskeyCredentialId)]
pub fn js_generate_passkey_credential_id() -> String {
    base64_encode(&generate_credential_id())
}

/// Build authenticator data + attestation object for `navigator.credentials.create()`.
#[wasm_bindgen(js_name = buildPasskeyAttestationObject)]
pub fn js_build_passkey_attestation_object(
    rp_id: &str,
    credential_id_base64: &str,
    cose_public_key_base64: &str,
    sign_count: Option<u32>,
) -> Result<JsPasskeyAttestation, JsError> {
    let credential_id = base64_decode(credential_id_base64)?;
    let cose_public_key = base64_decode(cose_public_key_base64)?;

    let result = build_passkey_attestation_object(
        rp_id,
        &credential_id,
        &cose_public_key,
        sign_count.unwrap_or(0),
    )
    .map_err(|e| JsError::new(&e.to_string()))?;

    Ok(JsPasskeyAttestation {
        authenticator_data: base64_encode(&result.authenticator_data),
        attestation_object: base64_encode(&result.attestation_object),
    })
}

/// Build assertion authenticator data and sign it for `navigator.credentials.get()`.
#[wasm_bindgen(js_name = signPasskeyAssertion)]
pub fn js_sign_passkey_assertion(
    private_key_base64: &str,
    rp_id: &str,
    client_data_hash_base64: &str,
    sign_count: u32,
) -> Result<JsPasskeyAssertion, JsError> {
    let private_key = base64_decode(private_key_base64)?;
    let client_data_hash = base64_decode(client_data_hash_base64)?;

    let result = sign_passkey_assertion(&private_key, rp_id, &client_data_hash, sign_count)
        .map_err(|e| JsError::new(&e.to_string()))?;

    Ok(JsPasskeyAssertion {
        authenticator_data: base64_encode(&result.authenticator_data),
        signature_der: base64_encode(&result.signature_der),
    })
}

// ============================================================================
// Helpers
// ============================================================================

fn base64_encode(data: &[u8]) -> String {
    use base64::{engine::general_purpose::STANDARD, Engine};
    STANDARD.encode(data)
}

fn base64_decode(data: &str) -> Result<Vec<u8>, JsError> {
    use base64::{engine::general_purpose::STANDARD, Engine};
    STANDARD
        .decode(data)
        .map_err(|e| JsError::new(&e.to_string()))
}

fn parse_hash_algorithm(name: &str) -> Result<HashAlgorithm, JsError> {
    match name {
        "SHA-256" => Ok(HashAlgorithm::Sha256),
        _ => Err(JsError::new(&format!(
            "Unsupported hash algorithm: {} (only SHA-256 is allowed)",
            name
        ))),
    }
}

fn parse_prime_group(group: u32) -> Result<PrimeGroup, JsError> {
    match group {
        4096 => Ok(PrimeGroup::G4096),
        _ => Err(JsError::new(&format!(
            "Unsupported prime group: {} (only 4096 is allowed)",
            group
        ))),
    }
}

// ============================================================================
// Key Rotation
// ============================================================================

#[wasm_bindgen]
#[derive(Serialize, Deserialize)]
pub struct JsItemData {
    #[wasm_bindgen(getter_with_clone)]
    pub id: String,
    #[wasm_bindgen(getter_with_clone)]
    pub encrypted_data: String,
    #[wasm_bindgen(getter_with_clone)]
    pub encryption_iv: String,
    #[wasm_bindgen(getter_with_clone)]
    pub encryption_algorithm: String,
}

#[wasm_bindgen]
impl JsItemData {
    #[wasm_bindgen(constructor)]
    pub fn new(
        id: String,
        encrypted_data: String,
        encryption_iv: String,
        encryption_algorithm: String,
    ) -> JsItemData {
        JsItemData {
            id,
            encrypted_data,
            encryption_iv,
            encryption_algorithm,
        }
    }
}

#[wasm_bindgen]
#[derive(Serialize, Deserialize)]
pub struct JsMemberKeyData {
    #[wasm_bindgen(getter_with_clone)]
    pub user_id: String,
    #[wasm_bindgen(getter_with_clone)]
    pub public_key: String,
}

#[wasm_bindgen]
impl JsMemberKeyData {
    #[wasm_bindgen(constructor)]
    pub fn new(user_id: String, public_key: String) -> JsMemberKeyData {
        JsMemberKeyData {
            user_id,
            public_key,
        }
    }
}

#[wasm_bindgen]
#[derive(Serialize, Deserialize)]
pub struct JsReEncryptedItem {
    #[wasm_bindgen(getter_with_clone)]
    pub item_id: String,
    #[wasm_bindgen(getter_with_clone)]
    pub encrypted_data: String,
    #[wasm_bindgen(getter_with_clone)]
    pub encryption_iv: String,
}

#[wasm_bindgen]
#[derive(Serialize, Deserialize)]
pub struct JsMemberEncryptedKey {
    #[wasm_bindgen(getter_with_clone)]
    pub user_id: String,
    #[wasm_bindgen(getter_with_clone)]
    pub encrypted_vault_key: String,
}

#[wasm_bindgen]
pub struct JsKeyRotationResult {
    // These are accessed via methods, not direct field access
    member_encrypted_keys: Vec<JsMemberEncryptedKey>,
    re_encrypted_items: Vec<JsReEncryptedItem>,
}

#[wasm_bindgen]
impl JsKeyRotationResult {
    #[wasm_bindgen(js_name = getMemberEncryptedKeys)]
    pub fn get_member_encrypted_keys(&self) -> JsValue {
        serde_wasm_bindgen::to_value(&self.member_encrypted_keys).unwrap_or(JsValue::NULL)
    }

    #[wasm_bindgen(js_name = getReEncryptedItems)]
    pub fn get_re_encrypted_items(&self) -> JsValue {
        serde_wasm_bindgen::to_value(&self.re_encrypted_items).unwrap_or(JsValue::NULL)
    }
}

#[wasm_bindgen]
pub struct JsValidationResult {
    pub valid: bool,
    // Accessed via method
    errors: Vec<String>,
}

#[wasm_bindgen]
impl JsValidationResult {
    #[wasm_bindgen(js_name = getErrors)]
    pub fn get_errors(&self) -> JsValue {
        serde_wasm_bindgen::to_value(&self.errors).unwrap_or(JsValue::NULL)
    }
}

/// Encrypt a vault key with a member's RSA public key
#[wasm_bindgen(js_name = encryptVaultKeyForMember)]
pub fn js_encrypt_vault_key_for_member(
    vault_key_base64: &str,
    member_public_key: &str,
) -> Result<String, JsError> {
    let vault_key = base64_decode(vault_key_base64)?;
    key_rotation::encrypt_vault_key_for_member(&vault_key, member_public_key)
        .map_err(|e| JsError::new(&e.to_string()))
}

/// Encrypt a vault key with AES-GCM using Master Unlock Key
#[wasm_bindgen(js_name = encryptVaultKeyWithMUK)]
pub fn js_encrypt_vault_key_with_muk(
    vault_key_base64: &str,
    master_unlock_key_base64: &str,
    vault_id: &str,
    user_id: &str,
    key_version: u64,
) -> Result<String, JsError> {
    let vault_key = base64_decode(vault_key_base64)?;
    let muk = base64_decode(master_unlock_key_base64)?;
    let context = VaultKeyWrapContext::new(vault_id, user_id, key_version);
    key_rotation::encrypt_vault_key_with_muk(&vault_key, &muk, &context)
        .map_err(|e| JsError::new(&e.to_string()))
}

/// Re-encrypt an item with a new vault key
#[wasm_bindgen(js_name = reEncryptItem)]
pub fn js_re_encrypt_item(
    item: JsItemData,
    old_vault_key_base64: &str,
    new_vault_key_base64: &str,
) -> Result<JsReEncryptedItem, JsError> {
    let old_key = base64_decode(old_vault_key_base64)?;
    let new_key = base64_decode(new_vault_key_base64)?;

    let item_data = ItemData {
        id: item.id,
        encrypted_data: item.encrypted_data,
        encryption_iv: item.encryption_iv,
        encryption_algorithm: item.encryption_algorithm,
    };

    let result = key_rotation::re_encrypt_item(&item_data, &old_key, &new_key)
        .map_err(|e| JsError::new(&e.to_string()))?;

    Ok(JsReEncryptedItem {
        item_id: result.item_id,
        encrypted_data: result.encrypted_data,
        encryption_iv: result.encryption_iv,
    })
}

/// Perform a complete key rotation
#[wasm_bindgen(js_name = performKeyRotation)]
pub fn js_perform_key_rotation(
    old_vault_key_base64: &str,
    members_json: &str,
    items_json: &str,
    vault_id: &str,
    key_version: u64,
    current_user_id: &str,
    master_unlock_key_base64: &str,
) -> Result<JsKeyRotationResult, JsError> {
    let old_key = base64_decode(old_vault_key_base64)?;
    let muk = base64_decode(master_unlock_key_base64)?;

    // Parse JSON arrays
    let members: Vec<MemberKeyData> = serde_json::from_str(members_json)
        .map_err(|e| JsError::new(&format!("Invalid members JSON: {}", e)))?;
    let items: Vec<ItemData> = serde_json::from_str(items_json)
        .map_err(|e| JsError::new(&format!("Invalid items JSON: {}", e)))?;

    let result = key_rotation::perform_key_rotation(
        &old_key,
        &members,
        &items,
        vault_id,
        key_version,
        current_user_id,
        &muk,
    )
    .map_err(|e| JsError::new(&e.to_string()))?;

    Ok(JsKeyRotationResult {
        member_encrypted_keys: result
            .member_encrypted_keys
            .into_iter()
            .map(|m| JsMemberEncryptedKey {
                user_id: m.user_id,
                encrypted_vault_key: m.encrypted_vault_key,
            })
            .collect(),
        re_encrypted_items: result
            .re_encrypted_items
            .into_iter()
            .map(|i| JsReEncryptedItem {
                item_id: i.item_id,
                encrypted_data: i.encrypted_data,
                encryption_iv: i.encryption_iv,
            })
            .collect(),
    })
}

/// Validate rotation data
#[wasm_bindgen(js_name = validateRotationData)]
pub fn js_validate_rotation_data(members_json: &str) -> Result<JsValidationResult, JsError> {
    let members: Vec<MemberKeyData> = serde_json::from_str(members_json)
        .map_err(|e| JsError::new(&format!("Invalid members JSON: {}", e)))?;

    let result = key_rotation::validate_rotation_data(&members);

    Ok(JsValidationResult {
        valid: result.valid,
        errors: result.errors,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_derive_keys() {
        let result = js_derive_keys(
            "password",
            "A3-ABCDEF-GHIJKL-MNOPQ-RSTUV-WXYZ2",
            "test@example.com",
            None,
            None,
        );
        assert!(result.is_ok());
    }

    #[test]
    fn test_encrypt_decrypt() {
        let key = js_generate_encryption_key();
        let encrypted = js_encrypt("Hello, World!", &key).unwrap();
        let decrypted = js_decrypt(encrypted, &key).unwrap();
        assert_eq!(decrypted, "Hello, World!");
    }

    #[test]
    fn test_secret_key() {
        let key = js_generate_secret_key();
        assert!(js_validate_secret_key(&key));
        let hint = js_get_secret_key_hint(&key);
        assert!(hint.starts_with("A3-"));
    }

    #[test]
    fn test_recovery_master_key_roundtrip() {
        let recovery_key = js_generate_recovery_key();
        assert!(js_validate_recovery_key(&recovery_key));

        let master_key = js_derive_master_key(
            "password",
            "A3-ABCDEF-GHIJKL-MNOPQ-RSTUV-WXYZ2",
            "test@example.com",
            None,
            None,
        )
        .unwrap();

        let encrypted = js_encrypt_master_key(&master_key, &recovery_key, "test@example.com")
            .unwrap();
        let decrypted =
            js_decrypt_master_key(encrypted, &recovery_key, "test@example.com").unwrap();
        assert_eq!(master_key, decrypted);
    }
}
