//! C FFI bindings for Bittery Crypto
//!
//! Provides C-compatible functions for use with React Native Nitro Module.

#[cfg(target_os = "android")]
mod jni;

use bittery_crypto_core::{
    decrypt, decrypt_with_aad, derive_keys, encrypt, encrypt_with_aad, generate_credential_id,
    generate_encryption_key, generate_passkey_keypair, generate_rsa_key_pair, generate_secret_key,
    get_secret_key_hint,
    kdf_policy::KDF_ALGORITHM_PBKDF2_SHA256,
    key_rotation::{self, ItemData, MemberKeyData, VaultKeyWrapContext},
    passkey::{build_passkey_attestation_object, sign_passkey_assertion},
    rsa_decrypt, rsa_encrypt,
    srp6a::{HashAlgorithm, PrimeGroup, SrpClient, SrpServer},
    validate_secret_key, AadContext, EncryptedData, PBKDF2_ITERATIONS,
};
use std::ffi::{CStr, CString};
use std::os::raw::c_char;
use std::ptr;

// ============================================================================
// Memory Management
// ============================================================================

/// Free a string allocated by Rust
#[no_mangle]
pub extern "C" fn bittery_free_string(s: *mut c_char) {
    if !s.is_null() {
        unsafe {
            drop(CString::from_raw(s));
        }
    }
}

/// Helper to convert C string to Rust string
fn c_str_to_string(s: *const c_char) -> Option<String> {
    if s.is_null() {
        return None;
    }
    unsafe { CStr::from_ptr(s).to_str().ok().map(|s| s.to_owned()) }
}

/// Helper to convert Rust string to C string
fn string_to_c_str(s: String) -> *mut c_char {
    CString::new(s)
        .map(|cs| cs.into_raw())
        .unwrap_or(ptr::null_mut())
}

// ============================================================================
// Key Derivation
// ============================================================================

/// Result struct for key derivation
#[repr(C)]
pub struct DerivedKeysResult {
    pub auth_key: *mut c_char,
    pub master_unlock_key: *mut c_char,
    pub error: *mut c_char,
}

/// Derive authentication and master unlock keys.
///
/// `algorithm` may be null to use the default (`pbkdf2-sha256`) and `iterations`
/// may be 0 to use the default iteration count. This keeps the KDF agile (issue
/// #32) while remaining backward compatible with callers that pass null/0.
#[no_mangle]
pub extern "C" fn bittery_derive_keys(
    account_password: *const c_char,
    secret_key: *const c_char,
    email: *const c_char,
    algorithm: *const c_char,
    iterations: u32,
) -> DerivedKeysResult {
    let password = match c_str_to_string(account_password) {
        Some(s) => s,
        None => {
            return DerivedKeysResult {
                auth_key: ptr::null_mut(),
                master_unlock_key: ptr::null_mut(),
                error: string_to_c_str("Invalid password".to_string()),
            }
        }
    };

    let secret = match c_str_to_string(secret_key) {
        Some(s) => s,
        None => {
            return DerivedKeysResult {
                auth_key: ptr::null_mut(),
                master_unlock_key: ptr::null_mut(),
                error: string_to_c_str("Invalid secret key".to_string()),
            }
        }
    };

    let email_str = match c_str_to_string(email) {
        Some(s) => s,
        None => {
            return DerivedKeysResult {
                auth_key: ptr::null_mut(),
                master_unlock_key: ptr::null_mut(),
                error: string_to_c_str("Invalid email".to_string()),
            }
        }
    };

    let algorithm =
        c_str_to_string(algorithm).unwrap_or_else(|| KDF_ALGORITHM_PBKDF2_SHA256.to_string());
    let iterations = if iterations == 0 {
        PBKDF2_ITERATIONS
    } else {
        iterations
    };

    match derive_keys(&password, &secret, &email_str, &algorithm, iterations) {
        Ok(keys) => {
            use base64::{engine::general_purpose::STANDARD, Engine};
            DerivedKeysResult {
                auth_key: string_to_c_str(STANDARD.encode(&keys.auth_key)),
                master_unlock_key: string_to_c_str(STANDARD.encode(&keys.master_unlock_key)),
                error: ptr::null_mut(),
            }
        }
        Err(e) => DerivedKeysResult {
            auth_key: ptr::null_mut(),
            master_unlock_key: ptr::null_mut(),
            error: string_to_c_str(e.to_string()),
        },
    }
}

// ============================================================================
// AES-256-GCM Encryption
// ============================================================================

/// Result struct for encryption
#[repr(C)]
pub struct EncryptResult {
    pub ciphertext: *mut c_char,
    pub iv: *mut c_char,
    pub algorithm: *mut c_char,
    pub error: *mut c_char,
}

/// Encrypt plaintext using AES-256-GCM
#[no_mangle]
pub extern "C" fn bittery_encrypt(
    plaintext: *const c_char,
    key_base64: *const c_char,
) -> EncryptResult {
    let plaintext_str = match c_str_to_string(plaintext) {
        Some(s) => s,
        None => {
            return EncryptResult {
                ciphertext: ptr::null_mut(),
                iv: ptr::null_mut(),
                algorithm: ptr::null_mut(),
                error: string_to_c_str("Invalid plaintext".to_string()),
            }
        }
    };

    let key_str = match c_str_to_string(key_base64) {
        Some(s) => s,
        None => {
            return EncryptResult {
                ciphertext: ptr::null_mut(),
                iv: ptr::null_mut(),
                algorithm: ptr::null_mut(),
                error: string_to_c_str("Invalid key".to_string()),
            }
        }
    };

    use base64::{engine::general_purpose::STANDARD, Engine};
    let key = match STANDARD.decode(&key_str) {
        Ok(k) => k,
        Err(e) => {
            return EncryptResult {
                ciphertext: ptr::null_mut(),
                iv: ptr::null_mut(),
                algorithm: ptr::null_mut(),
                error: string_to_c_str(format!("Invalid key base64: {}", e)),
            }
        }
    };

    match encrypt(&plaintext_str, &key) {
        Ok(encrypted) => EncryptResult {
            ciphertext: string_to_c_str(encrypted.ciphertext),
            iv: string_to_c_str(encrypted.iv),
            algorithm: string_to_c_str(encrypted.algorithm),
            error: ptr::null_mut(),
        },
        Err(e) => EncryptResult {
            ciphertext: ptr::null_mut(),
            iv: ptr::null_mut(),
            algorithm: ptr::null_mut(),
            error: string_to_c_str(e.to_string()),
        },
    }
}

/// Decrypt data using AES-256-GCM
#[no_mangle]
pub extern "C" fn bittery_decrypt(
    ciphertext: *const c_char,
    iv: *const c_char,
    algorithm: *const c_char,
    key_base64: *const c_char,
) -> *mut c_char {
    let ciphertext_str = match c_str_to_string(ciphertext) {
        Some(s) => s,
        None => return string_to_c_str("ERROR:Invalid ciphertext".to_string()),
    };

    let iv_str = match c_str_to_string(iv) {
        Some(s) => s,
        None => return string_to_c_str("ERROR:Invalid IV".to_string()),
    };

    let algorithm_str = match c_str_to_string(algorithm) {
        Some(s) => s,
        None => return string_to_c_str("ERROR:Invalid algorithm".to_string()),
    };

    let key_str = match c_str_to_string(key_base64) {
        Some(s) => s,
        None => return string_to_c_str("ERROR:Invalid key".to_string()),
    };

    use base64::{engine::general_purpose::STANDARD, Engine};
    let key = match STANDARD.decode(&key_str) {
        Ok(k) => k,
        Err(e) => return string_to_c_str(format!("ERROR:Invalid key base64: {}", e)),
    };

    let data = EncryptedData {
        ciphertext: ciphertext_str,
        iv: iv_str,
        algorithm: algorithm_str,
    };

    match decrypt(&data, &key) {
        Ok(plaintext) => string_to_c_str(plaintext),
        Err(e) => string_to_c_str(format!("ERROR:{}", e)),
    }
}

/// Encrypt plaintext using AES-256-GCM with authenticated context (AAD)
#[no_mangle]
pub extern "C" fn bittery_encrypt_with_context(
    plaintext: *const c_char,
    key_base64: *const c_char,
    vault_id: *const c_char,
    entity_id: *const c_char,
    entity_type: *const c_char,
    version: u64,
    user_id: *const c_char,
) -> EncryptResult {
    let plaintext_str = match c_str_to_string(plaintext) {
        Some(s) => s,
        None => {
            return EncryptResult {
                ciphertext: ptr::null_mut(),
                iv: ptr::null_mut(),
                algorithm: ptr::null_mut(),
                error: string_to_c_str("Invalid plaintext".to_string()),
            }
        }
    };
    let key_str = match c_str_to_string(key_base64) {
        Some(s) => s,
        None => {
            return EncryptResult {
                ciphertext: ptr::null_mut(),
                iv: ptr::null_mut(),
                algorithm: ptr::null_mut(),
                error: string_to_c_str("Invalid key".to_string()),
            }
        }
    };
    let vault_id_str = match c_str_to_string(vault_id) {
        Some(s) => s,
        None => {
            return EncryptResult {
                ciphertext: ptr::null_mut(),
                iv: ptr::null_mut(),
                algorithm: ptr::null_mut(),
                error: string_to_c_str("Invalid vault_id".to_string()),
            }
        }
    };
    let entity_id_str = match c_str_to_string(entity_id) {
        Some(s) => s,
        None => {
            return EncryptResult {
                ciphertext: ptr::null_mut(),
                iv: ptr::null_mut(),
                algorithm: ptr::null_mut(),
                error: string_to_c_str("Invalid entity_id".to_string()),
            }
        }
    };
    let entity_type_str = match c_str_to_string(entity_type) {
        Some(s) => s,
        None => {
            return EncryptResult {
                ciphertext: ptr::null_mut(),
                iv: ptr::null_mut(),
                algorithm: ptr::null_mut(),
                error: string_to_c_str("Invalid entity_type".to_string()),
            }
        }
    };
    let user_id_str = match c_str_to_string(user_id) {
        Some(s) => s,
        None => {
            return EncryptResult {
                ciphertext: ptr::null_mut(),
                iv: ptr::null_mut(),
                algorithm: ptr::null_mut(),
                error: string_to_c_str("Invalid user_id".to_string()),
            }
        }
    };

    use base64::{engine::general_purpose::STANDARD, Engine};
    let key = match STANDARD.decode(&key_str) {
        Ok(k) => k,
        Err(e) => {
            return EncryptResult {
                ciphertext: ptr::null_mut(),
                iv: ptr::null_mut(),
                algorithm: ptr::null_mut(),
                error: string_to_c_str(format!("Invalid key base64: {}", e)),
            }
        }
    };

    let context = AadContext {
        vault_id: vault_id_str,
        entity_id: entity_id_str,
        entity_type: entity_type_str,
        version,
        user_id: user_id_str,
    };

    match encrypt_with_aad(&plaintext_str, &key, &context) {
        Ok(encrypted) => EncryptResult {
            ciphertext: string_to_c_str(encrypted.ciphertext),
            iv: string_to_c_str(encrypted.iv),
            algorithm: string_to_c_str(encrypted.algorithm),
            error: ptr::null_mut(),
        },
        Err(e) => EncryptResult {
            ciphertext: ptr::null_mut(),
            iv: ptr::null_mut(),
            algorithm: ptr::null_mut(),
            error: string_to_c_str(e.to_string()),
        },
    }
}

/// Decrypt data using AES-256-GCM with authenticated context (AAD)
#[no_mangle]
pub extern "C" fn bittery_decrypt_with_context(
    ciphertext: *const c_char,
    iv: *const c_char,
    algorithm: *const c_char,
    key_base64: *const c_char,
    vault_id: *const c_char,
    entity_id: *const c_char,
    entity_type: *const c_char,
    version: u64,
    user_id: *const c_char,
) -> *mut c_char {
    let ciphertext_str = match c_str_to_string(ciphertext) {
        Some(s) => s,
        None => return string_to_c_str("ERROR:Invalid ciphertext".to_string()),
    };
    let iv_str = match c_str_to_string(iv) {
        Some(s) => s,
        None => return string_to_c_str("ERROR:Invalid IV".to_string()),
    };
    let algorithm_str = match c_str_to_string(algorithm) {
        Some(s) => s,
        None => return string_to_c_str("ERROR:Invalid algorithm".to_string()),
    };
    let key_str = match c_str_to_string(key_base64) {
        Some(s) => s,
        None => return string_to_c_str("ERROR:Invalid key".to_string()),
    };
    let vault_id_str = match c_str_to_string(vault_id) {
        Some(s) => s,
        None => return string_to_c_str("ERROR:Invalid vault_id".to_string()),
    };
    let entity_id_str = match c_str_to_string(entity_id) {
        Some(s) => s,
        None => return string_to_c_str("ERROR:Invalid entity_id".to_string()),
    };
    let entity_type_str = match c_str_to_string(entity_type) {
        Some(s) => s,
        None => return string_to_c_str("ERROR:Invalid entity_type".to_string()),
    };
    let user_id_str = match c_str_to_string(user_id) {
        Some(s) => s,
        None => return string_to_c_str("ERROR:Invalid user_id".to_string()),
    };

    use base64::{engine::general_purpose::STANDARD, Engine};
    let key = match STANDARD.decode(&key_str) {
        Ok(k) => k,
        Err(e) => return string_to_c_str(format!("ERROR:Invalid key base64: {}", e)),
    };

    let data = EncryptedData {
        ciphertext: ciphertext_str,
        iv: iv_str,
        algorithm: algorithm_str,
    };

    let context = AadContext {
        vault_id: vault_id_str,
        entity_id: entity_id_str,
        entity_type: entity_type_str,
        version,
        user_id: user_id_str,
    };

    match decrypt_with_aad(&data, &key, &context) {
        Ok(plaintext) => string_to_c_str(plaintext),
        Err(e) => string_to_c_str(format!("ERROR:{}", e)),
    }
}

/// Generate a random encryption key (base64 encoded)
#[no_mangle]
pub extern "C" fn bittery_generate_encryption_key() -> *mut c_char {
    use base64::{engine::general_purpose::STANDARD, Engine};
    let key = generate_encryption_key();
    string_to_c_str(STANDARD.encode(&key))
}

// ============================================================================
// RSA-4096
// ============================================================================

/// Result struct for RSA key generation
#[repr(C)]
pub struct RsaKeyPairResult {
    pub public_key: *mut c_char,
    pub private_key: *mut c_char,
    pub error: *mut c_char,
}

/// Generate RSA-4096 key pair
#[no_mangle]
pub extern "C" fn bittery_generate_rsa_key_pair() -> RsaKeyPairResult {
    match generate_rsa_key_pair() {
        Ok(key_pair) => RsaKeyPairResult {
            public_key: string_to_c_str(key_pair.public_key.clone()),
            private_key: string_to_c_str(key_pair.private_key.clone()),
            error: ptr::null_mut(),
        },
        Err(e) => RsaKeyPairResult {
            public_key: ptr::null_mut(),
            private_key: ptr::null_mut(),
            error: string_to_c_str(e.to_string()),
        },
    }
}

/// RSA encrypt (returns base64 or error prefixed with "ERROR:")
#[no_mangle]
pub extern "C" fn bittery_rsa_encrypt(
    plaintext: *const c_char,
    public_key_pem: *const c_char,
) -> *mut c_char {
    let plaintext_str = match c_str_to_string(plaintext) {
        Some(s) => s,
        None => return string_to_c_str("ERROR:Invalid plaintext".to_string()),
    };

    let pem = match c_str_to_string(public_key_pem) {
        Some(s) => s,
        None => return string_to_c_str("ERROR:Invalid public key".to_string()),
    };

    match rsa_encrypt(&plaintext_str, &pem) {
        Ok(ciphertext) => string_to_c_str(ciphertext),
        Err(e) => string_to_c_str(format!("ERROR:{}", e)),
    }
}

/// RSA decrypt (returns plaintext or error prefixed with "ERROR:")
#[no_mangle]
pub extern "C" fn bittery_rsa_decrypt(
    ciphertext: *const c_char,
    private_key_pem: *const c_char,
) -> *mut c_char {
    let ciphertext_str = match c_str_to_string(ciphertext) {
        Some(s) => s,
        None => return string_to_c_str("ERROR:Invalid ciphertext".to_string()),
    };

    let pem = match c_str_to_string(private_key_pem) {
        Some(s) => s,
        None => return string_to_c_str("ERROR:Invalid private key".to_string()),
    };

    match rsa_decrypt(&ciphertext_str, &pem) {
        Ok(plaintext) => string_to_c_str(plaintext),
        Err(e) => string_to_c_str(format!("ERROR:{}", e)),
    }
}

// ============================================================================
// Passkey / WebAuthn
// ============================================================================

#[repr(C)]
pub struct PasskeyKeypairResult {
    pub private_key: *mut c_char,
    pub public_key_cose: *mut c_char,
    pub error: *mut c_char,
}

#[repr(C)]
pub struct PasskeyAttestationResult {
    pub authenticator_data: *mut c_char,
    pub attestation_object: *mut c_char,
    pub error: *mut c_char,
}

#[repr(C)]
pub struct PasskeyAssertionResult {
    pub authenticator_data: *mut c_char,
    pub signature_der: *mut c_char,
    pub error: *mut c_char,
}

/// Generate passkey private key and COSE public key.
#[no_mangle]
pub extern "C" fn bittery_passkey_generate_keypair() -> PasskeyKeypairResult {
    use base64::{engine::general_purpose::STANDARD, Engine};

    match generate_passkey_keypair() {
        Ok(result) => PasskeyKeypairResult {
            private_key: string_to_c_str(STANDARD.encode(result.private_key)),
            public_key_cose: string_to_c_str(STANDARD.encode(result.public_key_cose)),
            error: ptr::null_mut(),
        },
        Err(e) => PasskeyKeypairResult {
            private_key: ptr::null_mut(),
            public_key_cose: ptr::null_mut(),
            error: string_to_c_str(e.to_string()),
        },
    }
}

/// Generate passkey credential ID (base64).
#[no_mangle]
pub extern "C" fn bittery_passkey_generate_credential_id() -> *mut c_char {
    use base64::{engine::general_purpose::STANDARD, Engine};
    string_to_c_str(STANDARD.encode(generate_credential_id()))
}

/// Build authenticator data + attestation object (both base64).
#[no_mangle]
pub extern "C" fn bittery_passkey_build_attestation_object(
    rp_id: *const c_char,
    credential_id_base64: *const c_char,
    cose_public_key_base64: *const c_char,
    sign_count: u32,
) -> PasskeyAttestationResult {
    use base64::{engine::general_purpose::STANDARD, Engine};

    let rp_id_str = match c_str_to_string(rp_id) {
        Some(s) => s,
        None => {
            return PasskeyAttestationResult {
                authenticator_data: ptr::null_mut(),
                attestation_object: ptr::null_mut(),
                error: string_to_c_str("Invalid rpId".to_string()),
            }
        }
    };
    let credential_id_str = match c_str_to_string(credential_id_base64) {
        Some(s) => s,
        None => {
            return PasskeyAttestationResult {
                authenticator_data: ptr::null_mut(),
                attestation_object: ptr::null_mut(),
                error: string_to_c_str("Invalid credentialId".to_string()),
            }
        }
    };
    let cose_public_key_str = match c_str_to_string(cose_public_key_base64) {
        Some(s) => s,
        None => {
            return PasskeyAttestationResult {
                authenticator_data: ptr::null_mut(),
                attestation_object: ptr::null_mut(),
                error: string_to_c_str("Invalid COSE public key".to_string()),
            }
        }
    };

    let credential_id = match STANDARD.decode(&credential_id_str) {
        Ok(value) => value,
        Err(error) => {
            return PasskeyAttestationResult {
                authenticator_data: ptr::null_mut(),
                attestation_object: ptr::null_mut(),
                error: string_to_c_str(format!("Invalid credentialId base64: {}", error)),
            }
        }
    };
    let cose_public_key = match STANDARD.decode(&cose_public_key_str) {
        Ok(value) => value,
        Err(error) => {
            return PasskeyAttestationResult {
                authenticator_data: ptr::null_mut(),
                attestation_object: ptr::null_mut(),
                error: string_to_c_str(format!("Invalid COSE key base64: {}", error)),
            }
        }
    };

    match build_passkey_attestation_object(&rp_id_str, &credential_id, &cose_public_key, sign_count)
    {
        Ok(result) => PasskeyAttestationResult {
            authenticator_data: string_to_c_str(STANDARD.encode(result.authenticator_data)),
            attestation_object: string_to_c_str(STANDARD.encode(result.attestation_object)),
            error: ptr::null_mut(),
        },
        Err(e) => PasskeyAttestationResult {
            authenticator_data: ptr::null_mut(),
            attestation_object: ptr::null_mut(),
            error: string_to_c_str(e.to_string()),
        },
    }
}

/// Build assertion authenticator data and signature (base64).
#[no_mangle]
pub extern "C" fn bittery_passkey_sign_assertion(
    private_key_base64: *const c_char,
    rp_id: *const c_char,
    client_data_hash_base64: *const c_char,
    sign_count: u32,
) -> PasskeyAssertionResult {
    use base64::{engine::general_purpose::STANDARD, Engine};

    let private_key_str = match c_str_to_string(private_key_base64) {
        Some(s) => s,
        None => {
            return PasskeyAssertionResult {
                authenticator_data: ptr::null_mut(),
                signature_der: ptr::null_mut(),
                error: string_to_c_str("Invalid private key".to_string()),
            }
        }
    };
    let rp_id_str = match c_str_to_string(rp_id) {
        Some(s) => s,
        None => {
            return PasskeyAssertionResult {
                authenticator_data: ptr::null_mut(),
                signature_der: ptr::null_mut(),
                error: string_to_c_str("Invalid rpId".to_string()),
            }
        }
    };
    let client_data_hash_str = match c_str_to_string(client_data_hash_base64) {
        Some(s) => s,
        None => {
            return PasskeyAssertionResult {
                authenticator_data: ptr::null_mut(),
                signature_der: ptr::null_mut(),
                error: string_to_c_str("Invalid clientDataHash".to_string()),
            }
        }
    };

    let private_key = match STANDARD.decode(&private_key_str) {
        Ok(value) => value,
        Err(error) => {
            return PasskeyAssertionResult {
                authenticator_data: ptr::null_mut(),
                signature_der: ptr::null_mut(),
                error: string_to_c_str(format!("Invalid private key base64: {}", error)),
            }
        }
    };
    let client_data_hash = match STANDARD.decode(&client_data_hash_str) {
        Ok(value) => value,
        Err(error) => {
            return PasskeyAssertionResult {
                authenticator_data: ptr::null_mut(),
                signature_der: ptr::null_mut(),
                error: string_to_c_str(format!("Invalid clientDataHash base64: {}", error)),
            }
        }
    };

    match sign_passkey_assertion(&private_key, &rp_id_str, &client_data_hash, sign_count) {
        Ok(result) => PasskeyAssertionResult {
            authenticator_data: string_to_c_str(STANDARD.encode(result.authenticator_data)),
            signature_der: string_to_c_str(STANDARD.encode(result.signature_der)),
            error: ptr::null_mut(),
        },
        Err(e) => PasskeyAssertionResult {
            authenticator_data: ptr::null_mut(),
            signature_der: ptr::null_mut(),
            error: string_to_c_str(e.to_string()),
        },
    }
}

// ============================================================================
// Secret Key
// ============================================================================

/// Generate a new secret key
#[no_mangle]
pub extern "C" fn bittery_generate_secret_key() -> *mut c_char {
    string_to_c_str(generate_secret_key())
}

/// Validate secret key format (returns 1 for valid, 0 for invalid)
#[no_mangle]
pub extern "C" fn bittery_validate_secret_key(secret_key: *const c_char) -> i32 {
    let key = match c_str_to_string(secret_key) {
        Some(s) => s,
        None => return 0,
    };
    if validate_secret_key(&key) {
        1
    } else {
        0
    }
}

/// Get secret key hint
#[no_mangle]
pub extern "C" fn bittery_get_secret_key_hint(secret_key: *const c_char) -> *mut c_char {
    let key = match c_str_to_string(secret_key) {
        Some(s) => s,
        None => return ptr::null_mut(),
    };
    string_to_c_str(get_secret_key_hint(&key))
}

// ============================================================================
// SRP-6a
// ============================================================================

/// Opaque pointer to SRP client
pub struct SrpClientHandle {
    client: SrpClient,
}

/// Opaque pointer to SRP server
pub struct SrpServerHandle {
    server: SrpServer,
}

/// Create a new SRP client
#[no_mangle]
pub extern "C" fn bittery_srp_client_new(
    hash_algorithm: *const c_char,
    prime_group: u32,
) -> *mut SrpClientHandle {
    let hash_str = match c_str_to_string(hash_algorithm) {
        Some(s) => s,
        None => return ptr::null_mut(),
    };

    let hash = match hash_str.as_str() {
        "SHA-256" => HashAlgorithm::Sha256,
        _ => return ptr::null_mut(),
    };

    let group = match prime_group {
        4096 => PrimeGroup::G4096,
        _ => return ptr::null_mut(),
    };

    let handle = Box::new(SrpClientHandle {
        client: SrpClient::new(hash, group),
    });
    Box::into_raw(handle)
}

/// Free SRP client
#[no_mangle]
pub extern "C" fn bittery_srp_client_free(handle: *mut SrpClientHandle) {
    if !handle.is_null() {
        unsafe {
            drop(Box::from_raw(handle));
        }
    }
}

/// Generate salt
#[no_mangle]
pub extern "C" fn bittery_srp_client_generate_salt(handle: *const SrpClientHandle) -> *mut c_char {
    if handle.is_null() {
        return ptr::null_mut();
    }
    let client = unsafe { &(*handle).client };
    string_to_c_str(client.generate_salt())
}

/// Derive safe private key
#[no_mangle]
pub extern "C" fn bittery_srp_client_derive_safe_private_key(
    handle: *const SrpClientHandle,
    salt: *const c_char,
    password: *const c_char,
    iterations: u32,
) -> *mut c_char {
    if handle.is_null() {
        return ptr::null_mut();
    }
    let client = unsafe { &(*handle).client };

    let salt_str = match c_str_to_string(salt) {
        Some(s) => s,
        None => return ptr::null_mut(),
    };
    let password_str = match c_str_to_string(password) {
        Some(s) => s,
        None => return ptr::null_mut(),
    };

    let iterations_opt = if iterations > 0 {
        Some(iterations)
    } else {
        None
    };
    match client.derive_safe_private_key(&salt_str, &password_str, iterations_opt) {
        Ok(private_key) => string_to_c_str(private_key),
        Err(_) => ptr::null_mut(),
    }
}

/// Derive verifier
#[no_mangle]
pub extern "C" fn bittery_srp_client_derive_verifier(
    handle: *const SrpClientHandle,
    private_key: *const c_char,
) -> *mut c_char {
    if handle.is_null() {
        return ptr::null_mut();
    }
    let client = unsafe { &(*handle).client };

    let pk = match c_str_to_string(private_key) {
        Some(s) => s,
        None => return ptr::null_mut(),
    };

    match client.derive_verifier(&pk) {
        Ok(verifier) => string_to_c_str(verifier),
        Err(_) => ptr::null_mut(),
    }
}

/// Ephemeral result struct
#[repr(C)]
pub struct EphemeralResult {
    pub public: *mut c_char,
    pub secret: *mut c_char,
}

/// Generate client ephemeral
#[no_mangle]
pub extern "C" fn bittery_srp_client_generate_ephemeral(
    handle: *const SrpClientHandle,
) -> EphemeralResult {
    if handle.is_null() {
        return EphemeralResult {
            public: ptr::null_mut(),
            secret: ptr::null_mut(),
        };
    }
    let client = unsafe { &(*handle).client };
    let ephemeral = client.generate_ephemeral();

    EphemeralResult {
        public: string_to_c_str(ephemeral.public.clone()),
        secret: string_to_c_str(ephemeral.secret.clone()),
    }
}

/// Session result struct
#[repr(C)]
pub struct SessionResult {
    pub key: *mut c_char,
    pub proof: *mut c_char,
    pub error: *mut c_char,
}

/// Derive client session
#[no_mangle]
pub extern "C" fn bittery_srp_client_derive_session(
    handle: *const SrpClientHandle,
    client_secret_ephemeral: *const c_char,
    server_public_ephemeral: *const c_char,
    salt: *const c_char,
    username: *const c_char,
    private_key: *const c_char,
) -> SessionResult {
    if handle.is_null() {
        return SessionResult {
            key: ptr::null_mut(),
            proof: ptr::null_mut(),
            error: string_to_c_str("Null handle".to_string()),
        };
    }
    let client = unsafe { &(*handle).client };

    let cse = match c_str_to_string(client_secret_ephemeral) {
        Some(s) => s,
        None => {
            return SessionResult {
                key: ptr::null_mut(),
                proof: ptr::null_mut(),
                error: string_to_c_str("Invalid client secret ephemeral".to_string()),
            }
        }
    };
    let spe = match c_str_to_string(server_public_ephemeral) {
        Some(s) => s,
        None => {
            return SessionResult {
                key: ptr::null_mut(),
                proof: ptr::null_mut(),
                error: string_to_c_str("Invalid server public ephemeral".to_string()),
            }
        }
    };
    let salt_str = match c_str_to_string(salt) {
        Some(s) => s,
        None => {
            return SessionResult {
                key: ptr::null_mut(),
                proof: ptr::null_mut(),
                error: string_to_c_str("Invalid salt".to_string()),
            }
        }
    };
    let username_str = match c_str_to_string(username) {
        Some(s) => s,
        None => {
            return SessionResult {
                key: ptr::null_mut(),
                proof: ptr::null_mut(),
                error: string_to_c_str("Invalid username".to_string()),
            }
        }
    };
    let pk = match c_str_to_string(private_key) {
        Some(s) => s,
        None => {
            return SessionResult {
                key: ptr::null_mut(),
                proof: ptr::null_mut(),
                error: string_to_c_str("Invalid private key".to_string()),
            }
        }
    };

    match client.derive_session(&cse, &spe, &salt_str, &username_str, &pk) {
        Ok(session) => SessionResult {
            key: string_to_c_str(session.key.clone()),
            proof: string_to_c_str(session.proof.clone()),
            error: ptr::null_mut(),
        },
        Err(e) => SessionResult {
            key: ptr::null_mut(),
            proof: ptr::null_mut(),
            error: string_to_c_str(e.to_string()),
        },
    }
}

/// Verify server session proof (returns 1 for success, 0 for failure)
/// Error message available via bittery_srp_client_verify_session_error
#[no_mangle]
pub extern "C" fn bittery_srp_client_verify_session(
    handle: *const SrpClientHandle,
    client_public_ephemeral: *const c_char,
    session_key: *const c_char,
    session_proof: *const c_char,
    server_session_proof: *const c_char,
) -> *mut c_char {
    use bittery_crypto_core::srp6a::Session;

    if handle.is_null() {
        return string_to_c_str("ERROR:Null handle".to_string());
    }
    let client = unsafe { &(*handle).client };

    let cpe = match c_str_to_string(client_public_ephemeral) {
        Some(s) => s,
        None => return string_to_c_str("ERROR:Invalid client public ephemeral".to_string()),
    };
    let key = match c_str_to_string(session_key) {
        Some(s) => s,
        None => return string_to_c_str("ERROR:Invalid session key".to_string()),
    };
    let proof = match c_str_to_string(session_proof) {
        Some(s) => s,
        None => return string_to_c_str("ERROR:Invalid session proof".to_string()),
    };
    let server_proof = match c_str_to_string(server_session_proof) {
        Some(s) => s,
        None => return string_to_c_str("ERROR:Invalid server session proof".to_string()),
    };

    let session = Session { key, proof };

    match client.verify_session(&cpe, &session, &server_proof) {
        Ok(()) => string_to_c_str("OK".to_string()),
        Err(e) => string_to_c_str(format!("ERROR:{}", e)),
    }
}

// ============================================================================
// Key Rotation
// ============================================================================

/// Result struct for key rotation
#[repr(C)]
pub struct KeyRotationResultFFI {
    pub member_encrypted_keys_json: *mut c_char,
    pub re_encrypted_items_json: *mut c_char,
    pub error: *mut c_char,
}

/// Result struct for re-encrypted item
#[repr(C)]
pub struct ReEncryptedItemResult {
    pub item_id: *mut c_char,
    pub encrypted_data: *mut c_char,
    pub encryption_iv: *mut c_char,
    pub error: *mut c_char,
}

/// Result struct for validation
#[repr(C)]
pub struct ValidationResultFFI {
    pub valid: i32,
    pub errors_json: *mut c_char,
}

/// Encrypt vault key for a member using RSA
#[no_mangle]
pub extern "C" fn bittery_encrypt_vault_key_for_member(
    vault_key_base64: *const c_char,
    member_public_key: *const c_char,
) -> *mut c_char {
    let vault_key_str = match c_str_to_string(vault_key_base64) {
        Some(s) => s,
        None => return string_to_c_str("ERROR:Invalid vault key".to_string()),
    };
    let public_key = match c_str_to_string(member_public_key) {
        Some(s) => s,
        None => return string_to_c_str("ERROR:Invalid public key".to_string()),
    };

    use base64::{engine::general_purpose::STANDARD, Engine};
    let vault_key = match STANDARD.decode(&vault_key_str) {
        Ok(k) => k,
        Err(e) => return string_to_c_str(format!("ERROR:Invalid vault key base64: {}", e)),
    };

    match key_rotation::encrypt_vault_key_for_member(&vault_key, &public_key) {
        Ok(encrypted) => string_to_c_str(encrypted),
        Err(e) => string_to_c_str(format!("ERROR:{}", e)),
    }
}

/// Encrypt vault key with AES-GCM using Master Unlock Key
#[no_mangle]
pub extern "C" fn bittery_encrypt_vault_key_with_muk(
    vault_key_base64: *const c_char,
    master_unlock_key_base64: *const c_char,
    vault_id: *const c_char,
    user_id: *const c_char,
    key_version: u64,
) -> *mut c_char {
    let vault_key_str = match c_str_to_string(vault_key_base64) {
        Some(s) => s,
        None => return string_to_c_str("ERROR:Invalid vault key".to_string()),
    };
    let muk_str = match c_str_to_string(master_unlock_key_base64) {
        Some(s) => s,
        None => return string_to_c_str("ERROR:Invalid master unlock key".to_string()),
    };
    let vault_id_str = match c_str_to_string(vault_id) {
        Some(s) => s,
        None => return string_to_c_str("ERROR:Invalid vault ID".to_string()),
    };
    let user_id_str = match c_str_to_string(user_id) {
        Some(s) => s,
        None => return string_to_c_str("ERROR:Invalid user ID".to_string()),
    };

    use base64::{engine::general_purpose::STANDARD, Engine};
    let vault_key = match STANDARD.decode(&vault_key_str) {
        Ok(k) => k,
        Err(e) => return string_to_c_str(format!("ERROR:Invalid vault key base64: {}", e)),
    };
    let muk = match STANDARD.decode(&muk_str) {
        Ok(k) => k,
        Err(e) => return string_to_c_str(format!("ERROR:Invalid MUK base64: {}", e)),
    };

    let context = VaultKeyWrapContext::new(&vault_id_str, &user_id_str, key_version);
    match key_rotation::encrypt_vault_key_with_muk(&vault_key, &muk, &context) {
        Ok(encrypted) => string_to_c_str(encrypted),
        Err(e) => string_to_c_str(format!("ERROR:{}", e)),
    }
}

/// Re-encrypt an item with a new vault key
#[no_mangle]
pub extern "C" fn bittery_re_encrypt_item(
    item_id: *const c_char,
    encrypted_data: *const c_char,
    encryption_iv: *const c_char,
    encryption_algorithm: *const c_char,
    old_vault_key_base64: *const c_char,
    new_vault_key_base64: *const c_char,
) -> ReEncryptedItemResult {
    let id = match c_str_to_string(item_id) {
        Some(s) => s,
        None => {
            return ReEncryptedItemResult {
                item_id: ptr::null_mut(),
                encrypted_data: ptr::null_mut(),
                encryption_iv: ptr::null_mut(),
                error: string_to_c_str("Invalid item ID".to_string()),
            }
        }
    };
    let enc_data = match c_str_to_string(encrypted_data) {
        Some(s) => s,
        None => {
            return ReEncryptedItemResult {
                item_id: ptr::null_mut(),
                encrypted_data: ptr::null_mut(),
                encryption_iv: ptr::null_mut(),
                error: string_to_c_str("Invalid encrypted data".to_string()),
            }
        }
    };
    let enc_iv = match c_str_to_string(encryption_iv) {
        Some(s) => s,
        None => {
            return ReEncryptedItemResult {
                item_id: ptr::null_mut(),
                encrypted_data: ptr::null_mut(),
                encryption_iv: ptr::null_mut(),
                error: string_to_c_str("Invalid encryption IV".to_string()),
            }
        }
    };
    let enc_algo = match c_str_to_string(encryption_algorithm) {
        Some(s) => s,
        None => {
            return ReEncryptedItemResult {
                item_id: ptr::null_mut(),
                encrypted_data: ptr::null_mut(),
                encryption_iv: ptr::null_mut(),
                error: string_to_c_str("Invalid encryption algorithm".to_string()),
            }
        }
    };
    let old_key_str = match c_str_to_string(old_vault_key_base64) {
        Some(s) => s,
        None => {
            return ReEncryptedItemResult {
                item_id: ptr::null_mut(),
                encrypted_data: ptr::null_mut(),
                encryption_iv: ptr::null_mut(),
                error: string_to_c_str("Invalid old vault key".to_string()),
            }
        }
    };
    let new_key_str = match c_str_to_string(new_vault_key_base64) {
        Some(s) => s,
        None => {
            return ReEncryptedItemResult {
                item_id: ptr::null_mut(),
                encrypted_data: ptr::null_mut(),
                encryption_iv: ptr::null_mut(),
                error: string_to_c_str("Invalid new vault key".to_string()),
            }
        }
    };

    use base64::{engine::general_purpose::STANDARD, Engine};
    let old_key = match STANDARD.decode(&old_key_str) {
        Ok(k) => k,
        Err(e) => {
            return ReEncryptedItemResult {
                item_id: ptr::null_mut(),
                encrypted_data: ptr::null_mut(),
                encryption_iv: ptr::null_mut(),
                error: string_to_c_str(format!("Invalid old key base64: {}", e)),
            }
        }
    };
    let new_key = match STANDARD.decode(&new_key_str) {
        Ok(k) => k,
        Err(e) => {
            return ReEncryptedItemResult {
                item_id: ptr::null_mut(),
                encrypted_data: ptr::null_mut(),
                encryption_iv: ptr::null_mut(),
                error: string_to_c_str(format!("Invalid new key base64: {}", e)),
            }
        }
    };

    let item = ItemData {
        id,
        encrypted_data: enc_data,
        encryption_iv: enc_iv,
        encryption_algorithm: enc_algo,
    };

    match key_rotation::re_encrypt_item(&item, &old_key, &new_key) {
        Ok(result) => ReEncryptedItemResult {
            item_id: string_to_c_str(result.item_id),
            encrypted_data: string_to_c_str(result.encrypted_data),
            encryption_iv: string_to_c_str(result.encryption_iv),
            error: ptr::null_mut(),
        },
        Err(e) => ReEncryptedItemResult {
            item_id: ptr::null_mut(),
            encrypted_data: ptr::null_mut(),
            encryption_iv: ptr::null_mut(),
            error: string_to_c_str(e.to_string()),
        },
    }
}

/// Perform complete key rotation
/// members_json and items_json are JSON arrays
#[no_mangle]
pub extern "C" fn bittery_perform_key_rotation(
    old_vault_key_base64: *const c_char,
    members_json: *const c_char,
    items_json: *const c_char,
    vault_id: *const c_char,
    key_version: u64,
    current_user_id: *const c_char,
    master_unlock_key_base64: *const c_char,
) -> KeyRotationResultFFI {
    let old_key_str = match c_str_to_string(old_vault_key_base64) {
        Some(s) => s,
        None => {
            return KeyRotationResultFFI {
                member_encrypted_keys_json: ptr::null_mut(),
                re_encrypted_items_json: ptr::null_mut(),
                error: string_to_c_str("Invalid old vault key".to_string()),
            }
        }
    };
    let members_str = match c_str_to_string(members_json) {
        Some(s) => s,
        None => {
            return KeyRotationResultFFI {
                member_encrypted_keys_json: ptr::null_mut(),
                re_encrypted_items_json: ptr::null_mut(),
                error: string_to_c_str("Invalid members JSON".to_string()),
            }
        }
    };
    let items_str = match c_str_to_string(items_json) {
        Some(s) => s,
        None => {
            return KeyRotationResultFFI {
                member_encrypted_keys_json: ptr::null_mut(),
                re_encrypted_items_json: ptr::null_mut(),
                error: string_to_c_str("Invalid items JSON".to_string()),
            }
        }
    };
    let vault_id_str = match c_str_to_string(vault_id) {
        Some(s) => s,
        None => {
            return KeyRotationResultFFI {
                member_encrypted_keys_json: ptr::null_mut(),
                re_encrypted_items_json: ptr::null_mut(),
                error: string_to_c_str("Invalid vault ID".to_string()),
            }
        }
    };
    let user_id = match c_str_to_string(current_user_id) {
        Some(s) => s,
        None => {
            return KeyRotationResultFFI {
                member_encrypted_keys_json: ptr::null_mut(),
                re_encrypted_items_json: ptr::null_mut(),
                error: string_to_c_str("Invalid current user ID".to_string()),
            }
        }
    };
    let muk_str = match c_str_to_string(master_unlock_key_base64) {
        Some(s) => s,
        None => {
            return KeyRotationResultFFI {
                member_encrypted_keys_json: ptr::null_mut(),
                re_encrypted_items_json: ptr::null_mut(),
                error: string_to_c_str("Invalid master unlock key".to_string()),
            }
        }
    };

    use base64::{engine::general_purpose::STANDARD, Engine};
    let old_key = match STANDARD.decode(&old_key_str) {
        Ok(k) => k,
        Err(e) => {
            return KeyRotationResultFFI {
                member_encrypted_keys_json: ptr::null_mut(),
                re_encrypted_items_json: ptr::null_mut(),
                error: string_to_c_str(format!("Invalid old key base64: {}", e)),
            }
        }
    };
    let muk = match STANDARD.decode(&muk_str) {
        Ok(k) => k,
        Err(e) => {
            return KeyRotationResultFFI {
                member_encrypted_keys_json: ptr::null_mut(),
                re_encrypted_items_json: ptr::null_mut(),
                error: string_to_c_str(format!("Invalid MUK base64: {}", e)),
            }
        }
    };

    let members: Vec<MemberKeyData> = match serde_json::from_str(&members_str) {
        Ok(m) => m,
        Err(e) => {
            return KeyRotationResultFFI {
                member_encrypted_keys_json: ptr::null_mut(),
                re_encrypted_items_json: ptr::null_mut(),
                error: string_to_c_str(format!("Invalid members JSON: {}", e)),
            }
        }
    };
    let items: Vec<ItemData> = match serde_json::from_str(&items_str) {
        Ok(i) => i,
        Err(e) => {
            return KeyRotationResultFFI {
                member_encrypted_keys_json: ptr::null_mut(),
                re_encrypted_items_json: ptr::null_mut(),
                error: string_to_c_str(format!("Invalid items JSON: {}", e)),
            }
        }
    };

    match key_rotation::perform_key_rotation(
        &old_key,
        &members,
        &items,
        &vault_id_str,
        key_version,
        &user_id,
        &muk,
    ) {
        Ok(result) => {
            let member_keys_json = serde_json::to_string(&result.member_encrypted_keys)
                .unwrap_or_else(|_| "[]".to_string());
            let items_json = serde_json::to_string(&result.re_encrypted_items)
                .unwrap_or_else(|_| "[]".to_string());
            KeyRotationResultFFI {
                member_encrypted_keys_json: string_to_c_str(member_keys_json),
                re_encrypted_items_json: string_to_c_str(items_json),
                error: ptr::null_mut(),
            }
        }
        Err(e) => KeyRotationResultFFI {
            member_encrypted_keys_json: ptr::null_mut(),
            re_encrypted_items_json: ptr::null_mut(),
            error: string_to_c_str(e.to_string()),
        },
    }
}

/// Validate rotation data
#[no_mangle]
pub extern "C" fn bittery_validate_rotation_data(
    members_json: *const c_char,
) -> ValidationResultFFI {
    let members_str = match c_str_to_string(members_json) {
        Some(s) => s,
        None => {
            return ValidationResultFFI {
                valid: 0,
                errors_json: string_to_c_str("[\"Invalid members JSON\"]".to_string()),
            }
        }
    };

    let members: Vec<MemberKeyData> = match serde_json::from_str(&members_str) {
        Ok(m) => m,
        Err(e) => {
            return ValidationResultFFI {
                valid: 0,
                errors_json: string_to_c_str(format!("[\"{}\"]", e)),
            }
        }
    };

    let result = key_rotation::validate_rotation_data(&members);
    let errors_json = serde_json::to_string(&result.errors).unwrap_or_else(|_| "[]".to_string());

    ValidationResultFFI {
        valid: if result.valid { 1 } else { 0 },
        errors_json: string_to_c_str(errors_json),
    }
}

/// Free key rotation result
#[no_mangle]
pub extern "C" fn bittery_free_key_rotation_result(result: KeyRotationResultFFI) {
    bittery_free_string(result.member_encrypted_keys_json);
    bittery_free_string(result.re_encrypted_items_json);
    bittery_free_string(result.error);
}

/// Free re-encrypted item result
#[no_mangle]
pub extern "C" fn bittery_free_re_encrypted_item_result(result: ReEncryptedItemResult) {
    bittery_free_string(result.item_id);
    bittery_free_string(result.encrypted_data);
    bittery_free_string(result.encryption_iv);
    bittery_free_string(result.error);
}

/// Free validation result
#[no_mangle]
pub extern "C" fn bittery_free_validation_result(result: ValidationResultFFI) {
    bittery_free_string(result.errors_json);
}

// ============================================================================
// SRP-6a Server
// ============================================================================

/// Create a new SRP server
#[no_mangle]
pub extern "C" fn bittery_srp_server_new(
    hash_algorithm: *const c_char,
    prime_group: u32,
) -> *mut SrpServerHandle {
    let hash_str = match c_str_to_string(hash_algorithm) {
        Some(s) => s,
        None => return ptr::null_mut(),
    };

    let hash = match hash_str.as_str() {
        "SHA-256" => HashAlgorithm::Sha256,
        _ => return ptr::null_mut(),
    };

    let group = match prime_group {
        4096 => PrimeGroup::G4096,
        _ => return ptr::null_mut(),
    };

    let handle = Box::new(SrpServerHandle {
        server: SrpServer::new(hash, group),
    });
    Box::into_raw(handle)
}

/// Free SRP server
#[no_mangle]
pub extern "C" fn bittery_srp_server_free(handle: *mut SrpServerHandle) {
    if !handle.is_null() {
        unsafe {
            drop(Box::from_raw(handle));
        }
    }
}

/// Generate server ephemeral
#[no_mangle]
pub extern "C" fn bittery_srp_server_generate_ephemeral(
    handle: *const SrpServerHandle,
    verifier: *const c_char,
) -> EphemeralResult {
    if handle.is_null() {
        return EphemeralResult {
            public: ptr::null_mut(),
            secret: ptr::null_mut(),
        };
    }
    let server = unsafe { &(*handle).server };

    let v = match c_str_to_string(verifier) {
        Some(s) => s,
        None => {
            return EphemeralResult {
                public: ptr::null_mut(),
                secret: ptr::null_mut(),
            }
        }
    };

    match server.generate_ephemeral(&v) {
        Ok(ephemeral) => EphemeralResult {
            public: string_to_c_str(ephemeral.public.clone()),
            secret: string_to_c_str(ephemeral.secret.clone()),
        },
        Err(_) => EphemeralResult {
            public: ptr::null_mut(),
            secret: ptr::null_mut(),
        },
    }
}

/// Derive server session
#[no_mangle]
pub extern "C" fn bittery_srp_server_derive_session(
    handle: *const SrpServerHandle,
    server_secret_ephemeral: *const c_char,
    client_public_ephemeral: *const c_char,
    salt: *const c_char,
    username: *const c_char,
    verifier: *const c_char,
    client_session_proof: *const c_char,
) -> SessionResult {
    if handle.is_null() {
        return SessionResult {
            key: ptr::null_mut(),
            proof: ptr::null_mut(),
            error: string_to_c_str("Null handle".to_string()),
        };
    }
    let server = unsafe { &(*handle).server };

    let sse = match c_str_to_string(server_secret_ephemeral) {
        Some(s) => s,
        None => {
            return SessionResult {
                key: ptr::null_mut(),
                proof: ptr::null_mut(),
                error: string_to_c_str("Invalid server secret ephemeral".to_string()),
            }
        }
    };
    let cpe = match c_str_to_string(client_public_ephemeral) {
        Some(s) => s,
        None => {
            return SessionResult {
                key: ptr::null_mut(),
                proof: ptr::null_mut(),
                error: string_to_c_str("Invalid client public ephemeral".to_string()),
            }
        }
    };
    let salt_str = match c_str_to_string(salt) {
        Some(s) => s,
        None => {
            return SessionResult {
                key: ptr::null_mut(),
                proof: ptr::null_mut(),
                error: string_to_c_str("Invalid salt".to_string()),
            }
        }
    };
    let username_str = match c_str_to_string(username) {
        Some(s) => s,
        None => {
            return SessionResult {
                key: ptr::null_mut(),
                proof: ptr::null_mut(),
                error: string_to_c_str("Invalid username".to_string()),
            }
        }
    };
    let v = match c_str_to_string(verifier) {
        Some(s) => s,
        None => {
            return SessionResult {
                key: ptr::null_mut(),
                proof: ptr::null_mut(),
                error: string_to_c_str("Invalid verifier".to_string()),
            }
        }
    };
    let csp = match c_str_to_string(client_session_proof) {
        Some(s) => s,
        None => {
            return SessionResult {
                key: ptr::null_mut(),
                proof: ptr::null_mut(),
                error: string_to_c_str("Invalid client session proof".to_string()),
            }
        }
    };

    match server.derive_session(&sse, &cpe, &salt_str, &username_str, &v, &csp) {
        Ok(session) => SessionResult {
            key: string_to_c_str(session.key.clone()),
            proof: string_to_c_str(session.proof.clone()),
            error: ptr::null_mut(),
        },
        Err(e) => SessionResult {
            key: ptr::null_mut(),
            proof: ptr::null_mut(),
            error: string_to_c_str(e.to_string()),
        },
    }
}

// ============================================================================
// TOTP (Time-Based One-Time Password)
// ============================================================================

/// Result struct for TOTP generation
#[repr(C)]
pub struct TotpFfiResult {
    pub code: *mut c_char,
    pub remaining_seconds: u64,
    pub period: u64,
    pub progress: f64,
    pub error: *mut c_char,
}

/// Free a TotpFfiResult
#[no_mangle]
pub extern "C" fn bittery_free_totp_result(result: TotpFfiResult) {
    if !result.code.is_null() {
        unsafe { drop(std::ffi::CString::from_raw(result.code)) };
    }
    if !result.error.is_null() {
        unsafe { drop(std::ffi::CString::from_raw(result.error)) };
    }
}

/// Generate a TOTP code for the current time
///
/// - secret: base32-encoded shared secret
/// - algorithm: "SHA1", "SHA256", or "SHA512"
/// - digits: number of OTP digits (6, 7, or 8)
/// - period: time step in seconds (typically 30)
#[no_mangle]
pub extern "C" fn bittery_generate_totp(
    secret: *const c_char,
    algorithm: *const c_char,
    digits: u32,
    period: u64,
) -> TotpFfiResult {
    let secret_str = match c_str_to_string(secret) {
        Some(s) => s,
        None => {
            return TotpFfiResult {
                code: ptr::null_mut(),
                remaining_seconds: 0,
                period: 0,
                progress: 0.0,
                error: string_to_c_str("Invalid secret".to_string()),
            }
        }
    };
    let algorithm_str = match c_str_to_string(algorithm) {
        Some(s) => s,
        None => {
            return TotpFfiResult {
                code: ptr::null_mut(),
                remaining_seconds: 0,
                period: 0,
                progress: 0.0,
                error: string_to_c_str("Invalid algorithm".to_string()),
            }
        }
    };

    use bittery_crypto_core::generate_totp;

    match generate_totp(&secret_str, &algorithm_str, digits, period) {
        Ok(result) => TotpFfiResult {
            code: string_to_c_str(result.code),
            remaining_seconds: result.remaining_seconds,
            period: result.period,
            progress: result.progress,
            error: ptr::null_mut(),
        },
        Err(e) => TotpFfiResult {
            code: ptr::null_mut(),
            remaining_seconds: 0,
            period: 0,
            progress: 0.0,
            error: string_to_c_str(e.to_string()),
        },
    }
}
