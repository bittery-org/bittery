//! C FFI bindings for Bittery Crypto
//!
//! Provides C-compatible functions for use with React Native Nitro Module.

#[cfg(target_os = "android")]
mod jni;

use bittery_crypto_core::{
    decrypt, decrypt_master_key, decrypt_with_aad, derive_keys, derive_keys_from_master_key,
    derive_master_key, encrypt, encrypt_master_key, encrypt_with_aad, generate_credential_id,
    generate_encryption_key, generate_passkey_keypair, generate_recovery_key,
    generate_rsa_key_pair, generate_secret_key, generate_uuid, get_secret_key_hint,
    kdf_policy::KdfProfile,
    key_rotation::{self, ItemData, MemberKeyData, VaultKeyWrapContext},
    passkey::{build_passkey_attestation_object, sign_passkey_assertion},
    rsa_decrypt, rsa_encrypt,
    srp6a::{HashAlgorithm, PrimeGroup, SrpClient, SrpServer},
    validate_recovery_key, validate_secret_key, AadContext, EncryptedData,
};
use std::ffi::{CStr, CString};
use std::os::raw::c_char;
use std::ptr;
use zeroize::{Zeroize, Zeroizing};

// ============================================================================
// Memory Management
// ============================================================================

/// Reclaim a C string allocated by this library, wipe its bytes, and return the
/// now-zeroed buffer so the allocation is released with the size it was created
/// with.
///
/// The buffer has to be reclaimed before anything is overwritten: the nul
/// terminator is what lets `CString::from_raw` recover the allocation length, so
/// zeroing first would hand the allocator the wrong size.
///
/// # Safety
/// `s` must be non-null, must have come from `CString::into_raw` in this
/// library, and must not have been freed already.
unsafe fn reclaim_and_wipe(s: *mut c_char) -> Vec<u8> {
    let mut bytes = CString::from_raw(s).into_bytes();
    bytes.zeroize();
    bytes
}

/// Free a string allocated by Rust.
///
/// The buffer is zeroed before it is released, so strings that carry key
/// material - derived keys, private keys, SRP session keys, decrypted plaintext,
/// TOTP codes - do not survive in the freed allocation.
///
/// Every `char *` returned by this library must be released with this function.
/// The allocation belongs to Rust, so releasing it with `free()` is undefined
/// behaviour and also skips the wipe. Any copy the caller made of the string
/// before freeing it is the caller's to clear; Rust cannot reach it.
///
/// # Safety
/// `s` must either be null or a pointer returned by this library and not yet
/// freed. Passing a pointer this library did not allocate, or freeing the same
/// pointer twice, is undefined behaviour.
#[no_mangle]
pub unsafe extern "C" fn bittery_free_string(s: *mut c_char) {
    if !s.is_null() {
        drop(unsafe { reclaim_and_wipe(s) });
    }
}

/// Helper to convert C string to Rust string
fn c_str_to_string(s: *const c_char) -> Option<String> {
    if s.is_null() {
        return None;
    }
    unsafe { CStr::from_ptr(s).to_str().ok().map(|s| s.to_owned()) }
}

/// Copy a C string carrying secret material into a Rust `String` that is wiped
/// when it goes out of scope.
///
/// Only the Rust-side copy is wiped. The incoming `const char *` belongs to the
/// caller and is never written to by this library, so clearing it is the
/// caller's responsibility.
fn c_str_to_secret_string(s: *const c_char) -> Option<Zeroizing<String>> {
    c_str_to_string(s).map(Zeroizing::new)
}

/// Helper to convert Rust string to C string
fn string_to_c_str(s: String) -> *mut c_char {
    CString::new(s)
        .map(|cs| cs.into_raw())
        .unwrap_or(ptr::null_mut())
}

/// Copy a secret `String` into a C string and wipe the Rust-side copy.
///
/// The returned buffer still holds the secret in plaintext; it is wiped when the
/// caller hands it back to `bittery_free_string`.
fn secret_string_to_c_str(mut s: String) -> *mut c_char {
    copy_secret_into_c_str(&mut s)
}

/// Copy `s` into a freshly allocated C string, then wipe `s`.
fn copy_secret_into_c_str(s: &mut String) -> *mut c_char {
    // Size the buffer for the trailing nul up front. `CString::new` grows the
    // vector by one byte and then shrinks it to fit; either step can reallocate,
    // and a reallocation would copy the secret into a new block and release the
    // old one unwiped.
    let mut buffer = Vec::with_capacity(s.len() + 1);
    buffer.extend_from_slice(s.as_bytes());
    s.zeroize();

    match CString::new(buffer) {
        Ok(c_string) => c_string.into_raw(),
        Err(error) => {
            // Interior nul byte: `CString` hands the buffer back rather than
            // taking ownership of it.
            let mut rejected = error.into_vec();
            rejected.zeroize();
            ptr::null_mut()
        }
    }
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
/// The caller must provide the complete canonical profile. Null algorithms,
/// zero sentinels, and out-of-policy iteration counts are rejected.
#[no_mangle]
pub extern "C" fn bittery_derive_keys(
    account_password: *const c_char,
    secret_key: *const c_char,
    email: *const c_char,
    schema_version: u32,
    algorithm: *const c_char,
    iterations: u32,
) -> DerivedKeysResult {
    let password = match c_str_to_secret_string(account_password) {
        Some(s) => s,
        None => {
            return DerivedKeysResult {
                auth_key: ptr::null_mut(),
                master_unlock_key: ptr::null_mut(),
                error: string_to_c_str("Invalid password".to_string()),
            }
        }
    };

    let secret = match c_str_to_secret_string(secret_key) {
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

    let algorithm = match c_str_to_string(algorithm) {
        Some(value) => value,
        None => {
            return DerivedKeysResult {
                auth_key: ptr::null_mut(),
                master_unlock_key: ptr::null_mut(),
                error: string_to_c_str("Invalid KDF algorithm".to_string()),
            }
        }
    };
    let profile = KdfProfile {
        schema_version,
        algorithm,
        iterations,
    };

    match derive_keys(&password, &secret, &email_str, &profile) {
        Ok(keys) => {
            use base64::{engine::general_purpose::STANDARD, Engine};
            DerivedKeysResult {
                auth_key: secret_string_to_c_str(STANDARD.encode(&keys.auth_key)),
                master_unlock_key: secret_string_to_c_str(STANDARD.encode(&keys.master_unlock_key)),
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

/// Derive the intermediate master key (PBKDF2 output) from password + secret key.
///
/// Returns the master key as base64, or an `"ERROR:"`-prefixed message.
#[no_mangle]
pub extern "C" fn bittery_derive_master_key(
    account_password: *const c_char,
    secret_key: *const c_char,
    email: *const c_char,
    schema_version: u32,
    algorithm: *const c_char,
    iterations: u32,
) -> *mut c_char {
    let password = match c_str_to_secret_string(account_password) {
        Some(s) => s,
        None => return string_to_c_str("ERROR:Invalid password".to_string()),
    };
    let secret = match c_str_to_secret_string(secret_key) {
        Some(s) => s,
        None => return string_to_c_str("ERROR:Invalid secret key".to_string()),
    };
    let email_str = match c_str_to_string(email) {
        Some(s) => s,
        None => return string_to_c_str("ERROR:Invalid email".to_string()),
    };
    let algorithm_str = match c_str_to_string(algorithm) {
        Some(value) => value,
        None => return string_to_c_str("ERROR:Invalid KDF algorithm".to_string()),
    };
    let profile = KdfProfile {
        schema_version,
        algorithm: algorithm_str,
        iterations,
    };

    use base64::{engine::general_purpose::STANDARD, Engine};
    match derive_master_key(&password, &secret, &email_str, &profile) {
        Ok(mut master_key) => {
            let encoded = secret_string_to_c_str(STANDARD.encode(master_key.as_slice()));
            master_key.zeroize();
            encoded
        }
        Err(e) => string_to_c_str(format!("ERROR:{}", e)),
    }
}

/// Split a raw master key into auth key + master unlock key.
#[no_mangle]
pub extern "C" fn bittery_derive_keys_from_master_key(
    master_key_base64: *const c_char,
    email: *const c_char,
) -> DerivedKeysResult {
    let master_key_str = match c_str_to_secret_string(master_key_base64) {
        Some(s) => s,
        None => {
            return DerivedKeysResult {
                auth_key: ptr::null_mut(),
                master_unlock_key: ptr::null_mut(),
                error: string_to_c_str("Invalid master key".to_string()),
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

    use base64::{engine::general_purpose::STANDARD, Engine};
    let master_key = match STANDARD.decode(&master_key_str) {
        Ok(k) => Zeroizing::new(k),
        Err(e) => {
            return DerivedKeysResult {
                auth_key: ptr::null_mut(),
                master_unlock_key: ptr::null_mut(),
                error: string_to_c_str(format!("Invalid master key base64: {}", e)),
            }
        }
    };

    match derive_keys_from_master_key(&master_key, &email_str) {
        Ok(keys) => DerivedKeysResult {
            auth_key: secret_string_to_c_str(STANDARD.encode(&keys.auth_key)),
            master_unlock_key: secret_string_to_c_str(STANDARD.encode(&keys.master_unlock_key)),
            error: ptr::null_mut(),
        },
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
    let plaintext_str = match c_str_to_secret_string(plaintext) {
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

    let key_str = match c_str_to_secret_string(key_base64) {
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
        Ok(k) => Zeroizing::new(k),
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

    let key_str = match c_str_to_secret_string(key_base64) {
        Some(s) => s,
        None => return string_to_c_str("ERROR:Invalid key".to_string()),
    };

    use base64::{engine::general_purpose::STANDARD, Engine};
    let key = match STANDARD.decode(&key_str) {
        Ok(k) => Zeroizing::new(k),
        Err(e) => return string_to_c_str(format!("ERROR:Invalid key base64: {}", e)),
    };

    let data = EncryptedData {
        ciphertext: ciphertext_str,
        iv: iv_str,
        algorithm: algorithm_str,
    };

    match decrypt(&data, &key) {
        Ok(plaintext) => secret_string_to_c_str(plaintext),
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
    let plaintext_str = match c_str_to_secret_string(plaintext) {
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
    let key_str = match c_str_to_secret_string(key_base64) {
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
        Ok(k) => Zeroizing::new(k),
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
    let key_str = match c_str_to_secret_string(key_base64) {
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
        Ok(k) => Zeroizing::new(k),
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
        Ok(plaintext) => secret_string_to_c_str(plaintext),
        Err(e) => string_to_c_str(format!("ERROR:{}", e)),
    }
}

/// Generate a random encryption key (base64 encoded)
#[no_mangle]
pub extern "C" fn bittery_generate_encryption_key() -> *mut c_char {
    use base64::{engine::general_purpose::STANDARD, Engine};
    let mut key = generate_encryption_key();
    // `as_slice()` and not `key`: the key is a `[u8; 32]`, so passing it by
    // value would copy the key material onto the stack for the duration of
    // `encode` and leave that copy unwiped. Borrowing as a slice is what
    // `clippy::needless_borrow` wants and keeps the single wipeable copy.
    let encoded = secret_string_to_c_str(STANDARD.encode(key.as_slice()));
    key.zeroize();
    encoded
}

/// Generate a random UUID v4 string.
#[no_mangle]
pub extern "C" fn bittery_generate_uuid() -> *mut c_char {
    string_to_c_str(generate_uuid())
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
            private_key: secret_string_to_c_str(key_pair.private_key.clone()),
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
    let plaintext_str = match c_str_to_secret_string(plaintext) {
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

    let pem = match c_str_to_secret_string(private_key_pem) {
        Some(s) => s,
        None => return string_to_c_str("ERROR:Invalid private key".to_string()),
    };

    match rsa_decrypt(&ciphertext_str, &pem) {
        Ok(plaintext) => secret_string_to_c_str(plaintext),
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
        // `PasskeyKeypair` is `ZeroizeOnDrop`, so the scalar is wiped when
        // `result` goes out of scope. The explicit wipe stays as defence in
        // depth: it shortens the window to the base64 encode above.
        Ok(mut result) => {
            let private_key = secret_string_to_c_str(STANDARD.encode(result.private_key));
            result.private_key.zeroize();
            PasskeyKeypairResult {
                private_key,
                public_key_cose: string_to_c_str(STANDARD.encode(&result.public_key_cose)),
                error: ptr::null_mut(),
            }
        }
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

    let private_key_str = match c_str_to_secret_string(private_key_base64) {
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
        Ok(value) => Zeroizing::new(value),
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
    secret_string_to_c_str(generate_secret_key())
}

/// Validate secret key format (returns 1 for valid, 0 for invalid)
#[no_mangle]
pub extern "C" fn bittery_validate_secret_key(secret_key: *const c_char) -> i32 {
    let key = match c_str_to_secret_string(secret_key) {
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
    let key = match c_str_to_secret_string(secret_key) {
        Some(s) => s,
        None => return ptr::null_mut(),
    };
    // The hint is the deliberately public prefix of the secret key.
    string_to_c_str(get_secret_key_hint(&key))
}

/// Generate a new recovery key
#[no_mangle]
pub extern "C" fn bittery_generate_recovery_key() -> *mut c_char {
    secret_string_to_c_str(generate_recovery_key())
}

/// Validate recovery key format (returns 1 for valid, 0 for invalid)
#[no_mangle]
pub extern "C" fn bittery_validate_recovery_key(recovery_key: *const c_char) -> i32 {
    let key = match c_str_to_secret_string(recovery_key) {
        Some(s) => s,
        None => return 0,
    };
    if validate_recovery_key(&key) {
        1
    } else {
        0
    }
}

/// Encrypt a raw 32-byte master key using recovery key material
#[no_mangle]
pub extern "C" fn bittery_encrypt_master_key(
    master_key_base64: *const c_char,
    recovery_key: *const c_char,
    email: *const c_char,
) -> EncryptResult {
    let master_key_str = match c_str_to_secret_string(master_key_base64) {
        Some(s) => s,
        None => {
            return EncryptResult {
                ciphertext: ptr::null_mut(),
                iv: ptr::null_mut(),
                algorithm: ptr::null_mut(),
                error: string_to_c_str("Invalid master key".to_string()),
            }
        }
    };
    let recovery_key_str = match c_str_to_secret_string(recovery_key) {
        Some(s) => s,
        None => {
            return EncryptResult {
                ciphertext: ptr::null_mut(),
                iv: ptr::null_mut(),
                algorithm: ptr::null_mut(),
                error: string_to_c_str("Invalid recovery key".to_string()),
            }
        }
    };
    let email_str = match c_str_to_string(email) {
        Some(s) => s,
        None => {
            return EncryptResult {
                ciphertext: ptr::null_mut(),
                iv: ptr::null_mut(),
                algorithm: ptr::null_mut(),
                error: string_to_c_str("Invalid email".to_string()),
            }
        }
    };

    use base64::{engine::general_purpose::STANDARD, Engine};
    let master_key = match STANDARD.decode(&master_key_str) {
        Ok(k) => Zeroizing::new(k),
        Err(e) => {
            return EncryptResult {
                ciphertext: ptr::null_mut(),
                iv: ptr::null_mut(),
                algorithm: ptr::null_mut(),
                error: string_to_c_str(format!("Invalid master key base64: {}", e)),
            }
        }
    };

    match encrypt_master_key(&master_key, &recovery_key_str, &email_str) {
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

/// Decrypt an encrypted master key blob using the recovery key
///
/// Returns the master key as base64, or an `"ERROR:"`-prefixed message.
#[no_mangle]
pub extern "C" fn bittery_decrypt_master_key(
    ciphertext: *const c_char,
    iv: *const c_char,
    algorithm: *const c_char,
    recovery_key: *const c_char,
    email: *const c_char,
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
    let recovery_key_str = match c_str_to_secret_string(recovery_key) {
        Some(s) => s,
        None => return string_to_c_str("ERROR:Invalid recovery key".to_string()),
    };
    let email_str = match c_str_to_string(email) {
        Some(s) => s,
        None => return string_to_c_str("ERROR:Invalid email".to_string()),
    };

    let data = EncryptedData {
        ciphertext: ciphertext_str,
        iv: iv_str,
        algorithm: algorithm_str,
    };

    use base64::{engine::general_purpose::STANDARD, Engine};
    match decrypt_master_key(&data, &recovery_key_str, &email_str) {
        Ok(mut master_key) => {
            let encoded = secret_string_to_c_str(STANDARD.encode(master_key.as_slice()));
            master_key.zeroize();
            encoded
        }
        Err(e) => string_to_c_str(format!("ERROR:{}", e)),
    }
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
///
/// # Safety
/// `handle` must either be null or a pointer returned by
/// `bittery_srp_client_new` that has not been freed yet. The handle must not be
/// used afterwards.
#[no_mangle]
pub unsafe extern "C" fn bittery_srp_client_free(handle: *mut SrpClientHandle) {
    if !handle.is_null() {
        unsafe {
            drop(Box::from_raw(handle));
        }
    }
}

/// Generate salt
///
/// # Safety
/// `handle` must either be null or a live pointer returned by
/// `bittery_srp_client_new` that has not been freed.
#[no_mangle]
pub unsafe extern "C" fn bittery_srp_client_generate_salt(
    handle: *const SrpClientHandle,
) -> *mut c_char {
    if handle.is_null() {
        return ptr::null_mut();
    }
    let client = unsafe { &(*handle).client };
    string_to_c_str(client.generate_salt())
}

/// Derive safe private key
///
/// # Safety
/// `handle` must either be null or a live pointer returned by
/// `bittery_srp_client_new` that has not been freed. `salt` and `password` must
/// either be null or point to nul-terminated C strings that stay valid for the
/// duration of the call.
#[no_mangle]
pub unsafe extern "C" fn bittery_srp_client_derive_safe_private_key(
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
    let password_str = match c_str_to_secret_string(password) {
        Some(s) => s,
        None => return ptr::null_mut(),
    };

    let iterations_opt = if iterations > 0 {
        Some(iterations)
    } else {
        None
    };
    match client.derive_safe_private_key(&salt_str, &password_str, iterations_opt) {
        Ok(private_key) => secret_string_to_c_str(private_key),
        Err(_) => ptr::null_mut(),
    }
}

/// Derive verifier
///
/// # Safety
/// `handle` must either be null or a live pointer returned by
/// `bittery_srp_client_new` that has not been freed. `private_key` must either
/// be null or point to a nul-terminated C string that stays valid for the
/// duration of the call.
#[no_mangle]
pub unsafe extern "C" fn bittery_srp_client_derive_verifier(
    handle: *const SrpClientHandle,
    private_key: *const c_char,
) -> *mut c_char {
    if handle.is_null() {
        return ptr::null_mut();
    }
    let client = unsafe { &(*handle).client };

    let pk = match c_str_to_secret_string(private_key) {
        Some(s) => s,
        None => return ptr::null_mut(),
    };

    // The verifier is password-equivalent, so it is treated as secret material.
    match client.derive_verifier(&pk) {
        Ok(verifier) => secret_string_to_c_str(verifier),
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
///
/// # Safety
/// `handle` must either be null or a live pointer returned by
/// `bittery_srp_client_new` that has not been freed.
#[no_mangle]
pub unsafe extern "C" fn bittery_srp_client_generate_ephemeral(
    handle: *const SrpClientHandle,
) -> EphemeralResult {
    if handle.is_null() {
        return EphemeralResult {
            public: ptr::null_mut(),
            secret: ptr::null_mut(),
        };
    }
    let client = unsafe { &(*handle).client };
    // `Ephemeral` is `ZeroizeOnDrop` in the core; the clones below are the copies
    // this crate owns.
    let ephemeral = client.generate_ephemeral();

    EphemeralResult {
        public: string_to_c_str(ephemeral.public.clone()),
        secret: secret_string_to_c_str(ephemeral.secret.clone()),
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
///
/// # Safety
/// `handle` must either be null or a live pointer returned by
/// `bittery_srp_client_new` that has not been freed. Every `*const c_char`
/// argument must either be null or point to a nul-terminated C string that
/// stays valid for the duration of the call.
#[no_mangle]
pub unsafe extern "C" fn bittery_srp_client_derive_session(
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

    let cse = match c_str_to_secret_string(client_secret_ephemeral) {
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
    let pk = match c_str_to_secret_string(private_key) {
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
            key: secret_string_to_c_str(session.key.clone()),
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
///
/// # Safety
/// `handle` must either be null or a live pointer returned by
/// `bittery_srp_client_new` that has not been freed. Every `*const c_char`
/// argument must either be null or point to a nul-terminated C string that
/// stays valid for the duration of the call.
#[no_mangle]
pub unsafe extern "C" fn bittery_srp_client_verify_session(
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

    // `Session` is `ZeroizeOnDrop` in the core, so moving the session key into
    // it is what wipes this crate's copy.
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
    let vault_key_str = match c_str_to_secret_string(vault_key_base64) {
        Some(s) => s,
        None => return string_to_c_str("ERROR:Invalid vault key".to_string()),
    };
    let public_key = match c_str_to_string(member_public_key) {
        Some(s) => s,
        None => return string_to_c_str("ERROR:Invalid public key".to_string()),
    };

    use base64::{engine::general_purpose::STANDARD, Engine};
    let vault_key = match STANDARD.decode(&vault_key_str) {
        Ok(k) => Zeroizing::new(k),
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
    let vault_key_str = match c_str_to_secret_string(vault_key_base64) {
        Some(s) => s,
        None => return string_to_c_str("ERROR:Invalid vault key".to_string()),
    };
    let muk_str = match c_str_to_secret_string(master_unlock_key_base64) {
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
        Ok(k) => Zeroizing::new(k),
        Err(e) => return string_to_c_str(format!("ERROR:Invalid vault key base64: {}", e)),
    };
    let muk = match STANDARD.decode(&muk_str) {
        Ok(k) => Zeroizing::new(k),
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
    let old_key_str = match c_str_to_secret_string(old_vault_key_base64) {
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
    let new_key_str = match c_str_to_secret_string(new_vault_key_base64) {
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
        Ok(k) => Zeroizing::new(k),
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
        Ok(k) => Zeroizing::new(k),
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
    let old_key_str = match c_str_to_secret_string(old_vault_key_base64) {
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
    let muk_str = match c_str_to_secret_string(master_unlock_key_base64) {
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
        Ok(k) => Zeroizing::new(k),
        Err(e) => {
            return KeyRotationResultFFI {
                member_encrypted_keys_json: ptr::null_mut(),
                re_encrypted_items_json: ptr::null_mut(),
                error: string_to_c_str(format!("Invalid old key base64: {}", e)),
            }
        }
    };
    let muk = match STANDARD.decode(&muk_str) {
        Ok(k) => Zeroizing::new(k),
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
///
/// # Safety
/// Every non-null string in `result` must be a pointer returned by this library
/// and not yet freed. Freeing the same result twice is undefined behaviour.
#[no_mangle]
pub unsafe extern "C" fn bittery_free_key_rotation_result(result: KeyRotationResultFFI) {
    bittery_free_string(result.member_encrypted_keys_json);
    bittery_free_string(result.re_encrypted_items_json);
    bittery_free_string(result.error);
}

/// Free re-encrypted item result
///
/// # Safety
/// Every non-null string in `result` must be a pointer returned by this library
/// and not yet freed. Freeing the same result twice is undefined behaviour.
#[no_mangle]
pub unsafe extern "C" fn bittery_free_re_encrypted_item_result(result: ReEncryptedItemResult) {
    bittery_free_string(result.item_id);
    bittery_free_string(result.encrypted_data);
    bittery_free_string(result.encryption_iv);
    bittery_free_string(result.error);
}

/// Free validation result
///
/// # Safety
/// `result.errors_json` must be null or a pointer returned by this library that
/// has not been freed yet.
#[no_mangle]
pub unsafe extern "C" fn bittery_free_validation_result(result: ValidationResultFFI) {
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
///
/// # Safety
/// `handle` must either be null or a pointer returned by
/// `bittery_srp_server_new` that has not been freed yet. The handle must not be
/// used afterwards.
#[no_mangle]
pub unsafe extern "C" fn bittery_srp_server_free(handle: *mut SrpServerHandle) {
    if !handle.is_null() {
        unsafe {
            drop(Box::from_raw(handle));
        }
    }
}

/// Generate server ephemeral
///
/// # Safety
/// `handle` must either be null or a live pointer returned by
/// `bittery_srp_server_new` that has not been freed. `verifier` must either be
/// null or point to a nul-terminated C string that stays valid for the duration
/// of the call.
#[no_mangle]
pub unsafe extern "C" fn bittery_srp_server_generate_ephemeral(
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

    let v = match c_str_to_secret_string(verifier) {
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
            secret: secret_string_to_c_str(ephemeral.secret.clone()),
        },
        Err(_) => EphemeralResult {
            public: ptr::null_mut(),
            secret: ptr::null_mut(),
        },
    }
}

/// Derive server session
///
/// # Safety
/// `handle` must either be null or a live pointer returned by
/// `bittery_srp_server_new` that has not been freed. Every `*const c_char`
/// argument must either be null or point to a nul-terminated C string that
/// stays valid for the duration of the call.
#[no_mangle]
pub unsafe extern "C" fn bittery_srp_server_derive_session(
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

    let sse = match c_str_to_secret_string(server_secret_ephemeral) {
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
    let v = match c_str_to_secret_string(verifier) {
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
            key: secret_string_to_c_str(session.key.clone()),
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
///
/// Both strings are zeroed before they are released.
///
/// # Safety
/// `result.code` and `result.error` must each be null or a pointer returned by
/// this library that has not been freed yet.
#[no_mangle]
pub unsafe extern "C" fn bittery_free_totp_result(result: TotpFfiResult) {
    bittery_free_string(result.code);
    bittery_free_string(result.error);
}

/// Generate a TOTP code for the current time
///
/// - secret: base32-encoded shared secret
/// - algorithm: "SHA1", "SHA256", or "SHA512" (anything else falls back to SHA1)
/// - digits: number of OTP digits; must be 6, 7 or 8
/// - period: time step in seconds (typically 30); must be >= 1
///
/// `digits` and `period` are validated by the core: out-of-range values return a
/// `TotpFfiResult` with a null `code` and a non-null `error` describing the
/// problem. The caller must free the result with `bittery_free_totp_result`.
#[no_mangle]
pub extern "C" fn bittery_generate_totp(
    secret: *const c_char,
    algorithm: *const c_char,
    digits: u32,
    period: u64,
) -> TotpFfiResult {
    let secret_str = match c_str_to_secret_string(secret) {
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
            code: secret_string_to_c_str(result.code),
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

// ============================================================================
// Tests
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    const SECRET: &str = "master-unlock-key-material";

    #[test]
    fn reclaim_and_wipe_zeroes_the_whole_allocation() {
        let raw = CString::new(SECRET).unwrap().into_raw();

        let mut wiped = unsafe { reclaim_and_wipe(raw) };

        // `Vec::zeroize` clears the length and zeroes the full capacity, so none
        // of the bytes the C caller could have read are left behind.
        assert!(wiped.is_empty());
        assert_eq!(wiped.capacity(), SECRET.len() + 1);
        assert!(wiped
            .spare_capacity_mut()
            .iter()
            .all(|byte| unsafe { byte.assume_init() } == 0));
    }

    #[test]
    fn free_string_ignores_null() {
        unsafe { bittery_free_string(ptr::null_mut()) };
    }

    #[test]
    fn copy_secret_into_c_str_wipes_the_source_string() {
        let mut secret = String::from("srp-session-key");
        let capacity = secret.capacity();

        let raw = copy_secret_into_c_str(&mut secret);

        assert!(secret.is_empty());
        assert_eq!(secret.capacity(), capacity);
        assert!(unsafe { secret.as_mut_vec() }
            .spare_capacity_mut()
            .iter()
            .all(|byte| unsafe { byte.assume_init() } == 0));

        // The C string is an independent, intact copy.
        assert_eq!(
            unsafe { CStr::from_ptr(raw) }.to_str().unwrap(),
            "srp-session-key"
        );
        unsafe { bittery_free_string(raw) };
    }

    #[test]
    fn secret_string_to_c_str_preserves_the_value_for_the_caller() {
        let raw = secret_string_to_c_str(String::from("A3-ABCDEF-GHIJKL"));

        assert_eq!(
            unsafe { CStr::from_ptr(raw) }.to_str().unwrap(),
            "A3-ABCDEF-GHIJKL"
        );
        unsafe { bittery_free_string(raw) };
    }

    #[test]
    fn secret_string_to_c_str_rejects_interior_nul() {
        let raw = secret_string_to_c_str(String::from("aa\0bb"));

        assert!(raw.is_null());
    }

    #[test]
    fn free_totp_result_releases_code_and_error() {
        let result = TotpFfiResult {
            code: secret_string_to_c_str(String::from("123456")),
            remaining_seconds: 12,
            period: 30,
            progress: 60.0,
            error: ptr::null_mut(),
        };

        unsafe { bittery_free_totp_result(result) };
    }
}
