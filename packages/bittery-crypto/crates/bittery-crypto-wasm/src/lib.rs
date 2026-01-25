//! WebAssembly bindings for Bittery Crypto
//!
//! Exposes the core crypto library to JavaScript/TypeScript via wasm-bindgen.

use bittery_crypto_core::{
    decrypt, derive_keys, encrypt, generate_encryption_key, generate_rsa_key_pair,
    generate_secret_key, get_secret_key_hint, rsa_decrypt, rsa_encrypt,
    srp6a::{HashAlgorithm, PrimeGroup, SrpClient, SrpServer},
    validate_secret_key, EncryptedData,
};
use serde::{Deserialize, Serialize};
use wasm_bindgen::prelude::*;

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

// ============================================================================
// Key Derivation
// ============================================================================

/// Derive authentication and master unlock keys from password + secret key
#[wasm_bindgen(js_name = deriveKeys)]
pub fn js_derive_keys(
    account_password: &str,
    secret_key: &str,
    email: &str,
) -> Result<JsDerivedKeys, JsError> {
    let keys = derive_keys(account_password, secret_key, email)
        .map_err(|e| JsError::new(&e.to_string()))?;

    Ok(JsDerivedKeys {
        auth_key: base64_encode(&keys.auth_key),
        master_unlock_key: base64_encode(&keys.master_unlock_key),
    })
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

/// Generate a random 32-byte encryption key
#[wasm_bindgen(js_name = generateEncryptionKey)]
pub fn js_generate_encryption_key() -> String {
    base64_encode(&generate_encryption_key())
}

// ============================================================================
// RSA-4096
// ============================================================================

/// Generate RSA-4096 key pair
#[wasm_bindgen(js_name = generateRSAKeyPair)]
pub fn js_generate_rsa_key_pair() -> Result<JsRsaKeyPair, JsError> {
    let key_pair = generate_rsa_key_pair().map_err(|e| JsError::new(&e.to_string()))?;

    Ok(JsRsaKeyPair {
        public_key: key_pair.public_key,
        private_key: key_pair.private_key,
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

/// Validate secret key format
#[wasm_bindgen(js_name = validateSecretKey)]
pub fn js_validate_secret_key(secret_key: &str) -> bool {
    validate_secret_key(secret_key)
}

/// Get secret key hint (first segment)
#[wasm_bindgen(js_name = getSecretKeyHint)]
pub fn js_get_secret_key_hint(secret_key: &str) -> String {
    get_secret_key_hint(secret_key)
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
    ) -> String {
        self.client.derive_safe_private_key(salt, password, iterations)
    }

    /// Derive verifier from private key
    #[wasm_bindgen(js_name = deriveVerifier)]
    pub fn derive_verifier(&self, private_key: &str) -> String {
        self.client.derive_verifier(private_key)
    }

    /// Generate client ephemeral
    #[wasm_bindgen(js_name = generateEphemeral)]
    pub fn generate_ephemeral(&self) -> JsEphemeral {
        let ephemeral = self.client.generate_ephemeral();
        JsEphemeral {
            public: ephemeral.public,
            secret: ephemeral.secret,
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
            key: session.key,
            proof: session.proof,
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
    pub fn generate_ephemeral(&self, verifier: &str) -> JsEphemeral {
        let ephemeral = self.server.generate_ephemeral(verifier);
        JsEphemeral {
            public: ephemeral.public,
            secret: ephemeral.secret,
        }
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
            key: session.key,
            proof: session.proof,
        })
    }
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
    STANDARD.decode(data).map_err(|e| JsError::new(&e.to_string()))
}

fn parse_hash_algorithm(name: &str) -> Result<HashAlgorithm, JsError> {
    match name {
        "SHA-1" => Ok(HashAlgorithm::Sha1),
        "SHA-256" => Ok(HashAlgorithm::Sha256),
        "SHA-384" => Ok(HashAlgorithm::Sha384),
        "SHA-512" => Ok(HashAlgorithm::Sha512),
        _ => Err(JsError::new(&format!("Unknown hash algorithm: {}", name))),
    }
}

fn parse_prime_group(group: u32) -> Result<PrimeGroup, JsError> {
    match group {
        1024 => Ok(PrimeGroup::G1024),
        1536 => Ok(PrimeGroup::G1536),
        2048 => Ok(PrimeGroup::G2048),
        3072 => Ok(PrimeGroup::G3072),
        4096 => Ok(PrimeGroup::G4096),
        6144 => Ok(PrimeGroup::G6144),
        8192 => Ok(PrimeGroup::G8192),
        _ => Err(JsError::new(&format!("Unknown prime group: {}", group))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_derive_keys() {
        let result = js_derive_keys("password", "A3-ABCDEF-GHIJKL-MNOPQ-RSTUV-WXYZ2", "test@example.com");
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
}
