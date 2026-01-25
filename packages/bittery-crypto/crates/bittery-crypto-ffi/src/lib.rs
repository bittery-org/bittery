//! C FFI bindings for Bittery Crypto
//!
//! Provides C-compatible functions for use with React Native Nitro Module.

#[cfg(target_os = "android")]
mod jni;

use bittery_crypto_core::{
    decrypt, derive_keys, encrypt, generate_encryption_key, generate_rsa_key_pair,
    generate_secret_key, get_secret_key_hint, rsa_decrypt, rsa_encrypt,
    srp6a::{HashAlgorithm, PrimeGroup, SrpClient, SrpServer},
    validate_secret_key, EncryptedData,
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

/// Derive authentication and master unlock keys
#[no_mangle]
pub extern "C" fn bittery_derive_keys(
    account_password: *const c_char,
    secret_key: *const c_char,
    email: *const c_char,
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

    match derive_keys(&password, &secret, &email_str) {
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
        algorithm: "AES-GCM".to_string(),
    };

    match decrypt(&data, &key) {
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
            public_key: string_to_c_str(key_pair.public_key),
            private_key: string_to_c_str(key_pair.private_key),
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
    if validate_secret_key(&key) { 1 } else { 0 }
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
        "SHA-1" => HashAlgorithm::Sha1,
        "SHA-256" => HashAlgorithm::Sha256,
        "SHA-384" => HashAlgorithm::Sha384,
        "SHA-512" => HashAlgorithm::Sha512,
        _ => return ptr::null_mut(),
    };

    let group = match prime_group {
        1024 => PrimeGroup::G1024,
        1536 => PrimeGroup::G1536,
        2048 => PrimeGroup::G2048,
        3072 => PrimeGroup::G3072,
        4096 => PrimeGroup::G4096,
        6144 => PrimeGroup::G6144,
        8192 => PrimeGroup::G8192,
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

    let iterations_opt = if iterations > 0 { Some(iterations) } else { None };
    string_to_c_str(client.derive_safe_private_key(&salt_str, &password_str, iterations_opt))
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

    string_to_c_str(client.derive_verifier(&pk))
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
        public: string_to_c_str(ephemeral.public),
        secret: string_to_c_str(ephemeral.secret),
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
            key: string_to_c_str(session.key),
            proof: string_to_c_str(session.proof),
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
        "SHA-1" => HashAlgorithm::Sha1,
        "SHA-256" => HashAlgorithm::Sha256,
        "SHA-384" => HashAlgorithm::Sha384,
        "SHA-512" => HashAlgorithm::Sha512,
        _ => return ptr::null_mut(),
    };

    let group = match prime_group {
        1024 => PrimeGroup::G1024,
        1536 => PrimeGroup::G1536,
        2048 => PrimeGroup::G2048,
        3072 => PrimeGroup::G3072,
        4096 => PrimeGroup::G4096,
        6144 => PrimeGroup::G6144,
        8192 => PrimeGroup::G8192,
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

    let ephemeral = server.generate_ephemeral(&v);

    EphemeralResult {
        public: string_to_c_str(ephemeral.public),
        secret: string_to_c_str(ephemeral.secret),
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
            key: string_to_c_str(session.key),
            proof: string_to_c_str(session.proof),
            error: ptr::null_mut(),
        },
        Err(e) => SessionResult {
            key: ptr::null_mut(),
            proof: ptr::null_mut(),
            error: string_to_c_str(e.to_string()),
        },
    }
}
