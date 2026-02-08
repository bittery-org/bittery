//! AES-256-GCM Encryption/Decryption
//!
//! Provides secure symmetric encryption using AES-256-GCM.

use aes_gcm::{
    aead::{Aead, KeyInit},
    Aes256Gcm, Nonce,
};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use rand::{rngs::OsRng, RngCore};
use serde::{Deserialize, Serialize};
use zeroize::Zeroize;

use crate::error::CryptoError;

/// AES-256 key length in bytes
const KEY_LENGTH: usize = 32;

/// GCM nonce/IV length in bytes (96 bits recommended for GCM)
const IV_LENGTH: usize = 12;

/// Algorithm identifier for encrypted data
const ALGORITHM: &str = "AES-GCM";

/// Encrypted data structure matching the TypeScript interface
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EncryptedData {
    /// Base64-encoded ciphertext
    pub ciphertext: String,
    /// Base64-encoded initialization vector
    pub iv: String,
    /// Algorithm identifier
    pub algorithm: String,
}

/// Encrypt plaintext using AES-256-GCM
///
/// # Arguments
/// * `plaintext` - The string to encrypt
/// * `key` - 32-byte encryption key
///
/// # Returns
/// `EncryptedData` containing base64-encoded ciphertext and IV
pub fn encrypt(plaintext: &str, key: &[u8]) -> Result<EncryptedData, CryptoError> {
    if key.len() != KEY_LENGTH {
        return Err(CryptoError::InvalidKeyLength {
            expected: KEY_LENGTH,
            actual: key.len(),
        });
    }

    // Create cipher
    let cipher =
        Aes256Gcm::new_from_slice(key).map_err(|e| CryptoError::Encryption(e.to_string()))?;

    // Generate random IV
    let mut iv = [0u8; IV_LENGTH];
    let mut rng = OsRng;
    rng.fill_bytes(&mut iv);
    let nonce = Nonce::from_slice(&iv);

    // Encrypt
    let mut plaintext_bytes = plaintext.as_bytes().to_vec();
    let ciphertext = match cipher.encrypt(nonce, plaintext_bytes.as_slice()) {
        Ok(value) => value,
        Err(e) => {
            plaintext_bytes.zeroize();
            iv.zeroize();
            return Err(CryptoError::Encryption(e.to_string()));
        }
    };
    let iv_base64 = BASE64.encode(iv);
    plaintext_bytes.zeroize();
    iv.zeroize();

    Ok(EncryptedData {
        ciphertext: BASE64.encode(&ciphertext),
        iv: iv_base64,
        algorithm: ALGORITHM.to_string(),
    })
}

/// Decrypt data using AES-256-GCM
///
/// # Arguments
/// * `encrypted_data` - The encrypted data structure
/// * `key` - 32-byte encryption key
///
/// # Returns
/// Decrypted plaintext string
pub fn decrypt(encrypted_data: &EncryptedData, key: &[u8]) -> Result<String, CryptoError> {
    if key.len() != KEY_LENGTH {
        return Err(CryptoError::InvalidKeyLength {
            expected: KEY_LENGTH,
            actual: key.len(),
        });
    }

    // Create cipher
    let cipher =
        Aes256Gcm::new_from_slice(key).map_err(|e| CryptoError::Decryption(e.to_string()))?;

    // Decode base64
    let mut ciphertext = BASE64.decode(&encrypted_data.ciphertext)?;
    let mut iv = BASE64.decode(&encrypted_data.iv)?;

    if iv.len() != IV_LENGTH {
        return Err(CryptoError::InvalidIvLength {
            expected: IV_LENGTH,
            actual: iv.len(),
        });
    }

    let nonce = Nonce::from_slice(&iv);

    // Decrypt
    let plaintext_bytes = match cipher.decrypt(nonce, ciphertext.as_slice()) {
        Ok(value) => value,
        Err(e) => {
            ciphertext.zeroize();
            iv.zeroize();
            return Err(CryptoError::Decryption(e.to_string()));
        }
    };

    let plaintext = match String::from_utf8(plaintext_bytes) {
        Ok(value) => value,
        Err(e) => {
            let err_msg = e.utf8_error().to_string();
            let mut bytes = e.into_bytes();
            bytes.zeroize();
            ciphertext.zeroize();
            iv.zeroize();
            return Err(CryptoError::Utf8Error(err_msg));
        }
    };

    ciphertext.zeroize();
    iv.zeroize();
    Ok(plaintext)
}

/// Generate a random 32-byte encryption key
pub fn generate_encryption_key() -> [u8; KEY_LENGTH] {
    let mut key = [0u8; KEY_LENGTH];
    let mut rng = OsRng;
    rng.fill_bytes(&mut key);
    key
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_encrypt_decrypt_roundtrip() {
        let key = generate_encryption_key();
        let plaintext = "Hello, World! This is a test message.";

        let encrypted = encrypt(plaintext, &key).unwrap();
        let decrypted = decrypt(&encrypted, &key).unwrap();

        assert_eq!(plaintext, decrypted);
    }

    #[test]
    fn test_encrypt_produces_different_ciphertext() {
        let key = generate_encryption_key();
        let plaintext = "Test message";

        let encrypted1 = encrypt(plaintext, &key).unwrap();
        let encrypted2 = encrypt(plaintext, &key).unwrap();

        // Different IVs should produce different ciphertexts
        assert_ne!(encrypted1.ciphertext, encrypted2.ciphertext);
        assert_ne!(encrypted1.iv, encrypted2.iv);
    }

    #[test]
    fn test_wrong_key_fails_decryption() {
        let key1 = generate_encryption_key();
        let key2 = generate_encryption_key();
        let plaintext = "Secret message";

        let encrypted = encrypt(plaintext, &key1).unwrap();
        let result = decrypt(&encrypted, &key2);

        assert!(result.is_err());
    }

    #[test]
    fn test_invalid_key_length() {
        let short_key = [0u8; 16];
        let plaintext = "Test";

        let result = encrypt(plaintext, &short_key);
        assert!(matches!(result, Err(CryptoError::InvalidKeyLength { .. })));
    }

    #[test]
    fn test_algorithm_field() {
        let key = generate_encryption_key();
        let encrypted = encrypt("test", &key).unwrap();

        assert_eq!(encrypted.algorithm, "AES-GCM");
    }

    #[test]
    fn test_unicode_plaintext() {
        let key = generate_encryption_key();
        let plaintext = "Hello 世界! 🔐 Ñoño";

        let encrypted = encrypt(plaintext, &key).unwrap();
        let decrypted = decrypt(&encrypted, &key).unwrap();

        assert_eq!(plaintext, decrypted);
    }
}
