//! AES-256-GCM Encryption/Decryption
//!
//! Provides secure symmetric encryption using AES-256-GCM.

use aes_gcm::{
    aead::{Aead, KeyInit, Payload},
    Aes256Gcm, Nonce,
};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use rand::Rng;
use serde::{Deserialize, Serialize};
use zeroize::Zeroize;

use crate::error::CryptoError;
use crate::system_rng;

/// AES-256 key length in bytes
const KEY_LENGTH: usize = 32;

/// GCM nonce/IV length in bytes (96 bits recommended for GCM)
const IV_LENGTH: usize = 12;

/// Algorithm identifier for encrypted data
const ALGORITHM: &str = "AES-GCM-AAD-V1";

/// Authenticated context for entity-bound encryption.
///
/// Field names are serialized as camelCase for cross-platform compatibility.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AadContext {
    pub vault_id: String,
    pub entity_id: String,
    pub entity_type: String,
    pub version: u64,
    pub user_id: String,
}

impl AadContext {
    pub fn to_aad_bytes(&self) -> Result<Vec<u8>, CryptoError> {
        validate_context_field(&self.vault_id, "vaultId")?;
        validate_context_field(&self.entity_id, "entityId")?;
        validate_context_field(&self.entity_type, "entityType")?;
        validate_context_field(&self.user_id, "userId")?;

        let mut out = Vec::with_capacity(
            self.vault_id.len()
                + self.entity_id.len()
                + self.entity_type.len()
                + self.user_id.len()
                + 32,
        );
        out.extend_from_slice(self.vault_id.as_bytes());
        out.push(0);
        out.extend_from_slice(self.entity_id.as_bytes());
        out.push(0);
        out.extend_from_slice(self.entity_type.as_bytes());
        out.push(0);
        out.extend_from_slice(self.version.to_string().as_bytes());
        out.push(0);
        out.extend_from_slice(self.user_id.as_bytes());
        Ok(out)
    }
}

fn validate_context_field(value: &str, field_name: &str) -> Result<(), CryptoError> {
    if value.contains('\0') {
        return Err(CryptoError::InvalidInput(format!(
            "AAD context field {} contains NUL byte",
            field_name
        )));
    }
    Ok(())
}

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
    encrypt_internal(plaintext, key, &[])
}

/// Encrypt plaintext using AES-256-GCM with authenticated context.
pub fn encrypt_with_aad(
    plaintext: &str,
    key: &[u8],
    context: &AadContext,
) -> Result<EncryptedData, CryptoError> {
    let aad = context.to_aad_bytes()?;
    encrypt_internal(plaintext, key, &aad)
}

fn encrypt_internal(plaintext: &str, key: &[u8], aad: &[u8]) -> Result<EncryptedData, CryptoError> {
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
    let mut rng = system_rng();
    rng.fill_bytes(&mut iv);
    let nonce = Nonce::from(iv);

    // Encrypt
    let mut plaintext_bytes = plaintext.as_bytes().to_vec();
    let ciphertext = match cipher.encrypt(
        &nonce,
        Payload {
            msg: plaintext_bytes.as_slice(),
            aad,
        },
    ) {
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
    decrypt_internal(encrypted_data, key, &[])
}

/// Decrypt data using AES-256-GCM with authenticated context.
pub fn decrypt_with_aad(
    encrypted_data: &EncryptedData,
    key: &[u8],
    context: &AadContext,
) -> Result<String, CryptoError> {
    let aad = context.to_aad_bytes()?;
    decrypt_internal(encrypted_data, key, &aad)
}

fn decrypt_internal(
    encrypted_data: &EncryptedData,
    key: &[u8],
    aad: &[u8],
) -> Result<String, CryptoError> {
    if key.len() != KEY_LENGTH {
        return Err(CryptoError::InvalidKeyLength {
            expected: KEY_LENGTH,
            actual: key.len(),
        });
    }

    if encrypted_data.algorithm != ALGORITHM {
        return Err(CryptoError::InvalidInput(format!(
            "Unsupported encryption algorithm: {}",
            encrypted_data.algorithm
        )));
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

    // Length is already validated above; `try_from` re-checks it rather than
    // panicking, so a malformed IV can never reach the AEAD.
    let nonce = match Nonce::try_from(&iv[..]) {
        Ok(value) => value,
        Err(_) => {
            let actual = iv.len();
            ciphertext.zeroize();
            iv.zeroize();
            return Err(CryptoError::InvalidIvLength {
                expected: IV_LENGTH,
                actual,
            });
        }
    };

    // Decrypt
    let plaintext_bytes = match cipher.decrypt(
        &nonce,
        Payload {
            msg: ciphertext.as_slice(),
            aad,
        },
    ) {
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
    let mut rng = system_rng();
    rng.fill_bytes(&mut key);
    key
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Ciphertexts produced by the WebCrypto `AES-GCM` implementation (Node
    /// `crypto.webcrypto.subtle`) with a fixed key and IV.
    ///
    /// A roundtrip test cannot detect a wire-format change, because it would
    /// change on both sides at once. These pin the on-disk format (raw
    /// ciphertext followed by the 128-bit tag) against an independent
    /// implementation, so an `aes-gcm` upgrade cannot silently make already
    /// stored vault data undecryptable, or break browser interop.
    const KAT_KEY: [u8; 32] = [
        0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x0e,
        0x0f, 0x10, 0x11, 0x12, 0x13, 0x14, 0x15, 0x16, 0x17, 0x18, 0x19, 0x1a, 0x1b, 0x1c, 0x1d,
        0x1e, 0x1f,
    ];
    const KAT_IV_B64: &str = "EBESExQVFhcYGRob";
    const KAT_PLAINTEXT: &str = "Hello 世界! 🔐";

    fn kat_context() -> AadContext {
        AadContext {
            vault_id: "vault-1".to_string(),
            entity_id: "item-1".to_string(),
            entity_type: "item".to_string(),
            version: 7,
            user_id: "user-1".to_string(),
        }
    }

    #[test]
    fn test_decrypts_webcrypto_ciphertext_without_aad() {
        let encrypted = EncryptedData {
            ciphertext: "NZv0eibp3gtckp2RLlmZzEPAz6UUcHrqsa1saUQzUK3Rcg==".to_string(),
            iv: KAT_IV_B64.to_string(),
            algorithm: ALGORITHM.to_string(),
        };

        assert_eq!(decrypt(&encrypted, &KAT_KEY).unwrap(), KAT_PLAINTEXT);
    }

    #[test]
    fn test_decrypts_webcrypto_ciphertext_with_aad() {
        let encrypted = EncryptedData {
            ciphertext: "NZv0eibp3gtckp2RLlmZzEPArimh+VTfr9PS3PTfE3sGQw==".to_string(),
            iv: KAT_IV_B64.to_string(),
            algorithm: ALGORITHM.to_string(),
        };

        assert_eq!(
            decrypt_with_aad(&encrypted, &KAT_KEY, &kat_context()).unwrap(),
            KAT_PLAINTEXT
        );
    }

    #[test]
    fn test_tag_tampering_is_rejected() {
        let mut raw = BASE64
            .decode("NZv0eibp3gtckp2RLlmZzEPAz6UUcHrqsa1saUQzUK3Rcg==")
            .unwrap();
        // Flip a bit in the trailing 128-bit GCM authentication tag.
        let last = raw.len() - 1;
        raw[last] ^= 0x01;

        let encrypted = EncryptedData {
            ciphertext: BASE64.encode(&raw),
            iv: KAT_IV_B64.to_string(),
            algorithm: ALGORITHM.to_string(),
        };

        assert!(matches!(
            decrypt(&encrypted, &KAT_KEY),
            Err(CryptoError::Decryption(_))
        ));
    }

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

        assert_eq!(encrypted.algorithm, "AES-GCM-AAD-V1");
    }

    #[test]
    fn test_unicode_plaintext() {
        let key = generate_encryption_key();
        let plaintext = "Hello 世界! 🔐 Ñoño";

        let encrypted = encrypt(plaintext, &key).unwrap();
        let decrypted = decrypt(&encrypted, &key).unwrap();

        assert_eq!(plaintext, decrypted);
    }

    #[test]
    fn test_encrypt_decrypt_roundtrip_with_aad_context() {
        let key = generate_encryption_key();
        let context = AadContext {
            vault_id: "vault-1".to_string(),
            entity_id: "item-1".to_string(),
            entity_type: "item".to_string(),
            version: 4,
            user_id: "user-1".to_string(),
        };

        let encrypted = encrypt_with_aad("hello", &key, &context).unwrap();
        let decrypted = decrypt_with_aad(&encrypted, &key, &context).unwrap();
        assert_eq!(decrypted, "hello");
    }

    #[test]
    fn test_decrypt_fails_when_aad_context_changes() {
        let key = generate_encryption_key();
        let context = AadContext {
            vault_id: "vault-1".to_string(),
            entity_id: "item-1".to_string(),
            entity_type: "item".to_string(),
            version: 1,
            user_id: "user-1".to_string(),
        };
        let modified_context = AadContext {
            entity_id: "item-2".to_string(),
            ..context.clone()
        };

        let encrypted = encrypt_with_aad("hello", &key, &context).unwrap();
        let decrypted = decrypt_with_aad(&encrypted, &key, &modified_context);
        assert!(decrypted.is_err());
    }

    #[test]
    fn test_aad_serialization_is_deterministic() {
        let context = AadContext {
            vault_id: "vault-1".to_string(),
            entity_id: "item-1".to_string(),
            entity_type: "item".to_string(),
            version: 99,
            user_id: "user-1".to_string(),
        };

        let serialized_1 = context.to_aad_bytes().unwrap();
        let serialized_2 = context.to_aad_bytes().unwrap();
        assert_eq!(serialized_1, serialized_2);
        assert_eq!(serialized_1, b"vault-1\0item-1\0item\099\0user-1".to_vec());
    }

    #[test]
    fn unsupported_algorithm_is_rejected() {
        let key = generate_encryption_key();
        let encrypted = EncryptedData {
            ciphertext: "Zm9v".to_string(),
            iv: "YmFy".to_string(),
            algorithm: "AES-GCM".to_string(),
        };

        let result = decrypt(&encrypted, &key);
        assert!(matches!(result, Err(CryptoError::InvalidInput(_))));
    }
}
