//! RSA-4096 Key Generation and Encryption
//!
//! RSA-OAEP with SHA-256 for encrypting vault keys when sharing with team members.

use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use rand::rngs::OsRng;
use rsa::{
    pkcs8::{DecodePrivateKey, DecodePublicKey, EncodePrivateKey, EncodePublicKey, LineEnding},
    Oaep, RsaPrivateKey, RsaPublicKey,
};
use sha2::Sha256;

use crate::error::CryptoError;

/// RSA key size in bits
const RSA_KEY_SIZE: usize = 4096;

/// RSA key pair in PEM format
#[derive(Debug, Clone)]
pub struct RsaKeyPair {
    /// Public key in SPKI PEM format
    pub public_key: String,
    /// Private key in PKCS8 PEM format
    pub private_key: String,
}

/// Generate an RSA-4096 key pair for vault sharing
///
/// # Returns
/// `RsaKeyPair` containing PEM-encoded public and private keys
pub fn generate_rsa_key_pair() -> Result<RsaKeyPair, CryptoError> {
    let mut rng = OsRng;

    let private_key = RsaPrivateKey::new(&mut rng, RSA_KEY_SIZE)
        .map_err(|e| CryptoError::Rsa(format!("Key generation failed: {}", e)))?;

    let public_key = RsaPublicKey::from(&private_key);

    // Export to PEM format
    let public_key_pem = public_key
        .to_public_key_pem(LineEnding::LF)
        .map_err(|e| CryptoError::Rsa(format!("Public key export failed: {}", e)))?;

    let private_key_pem = private_key
        .to_pkcs8_pem(LineEnding::LF)
        .map_err(|e| CryptoError::Rsa(format!("Private key export failed: {}", e)))?;

    Ok(RsaKeyPair {
        public_key: public_key_pem,
        private_key: private_key_pem.to_string(),
    })
}

/// Encrypt data with RSA public key using OAEP padding
///
/// # Arguments
/// * `plaintext` - The string to encrypt
/// * `public_key_pem` - PEM-encoded public key (SPKI format)
///
/// # Returns
/// Base64-encoded ciphertext
pub fn rsa_encrypt(plaintext: &str, public_key_pem: &str) -> Result<String, CryptoError> {
    let public_key = parse_public_key_pem(public_key_pem)?;

    let mut rng = OsRng;
    let padding = Oaep::new::<Sha256>();

    let ciphertext = public_key
        .encrypt(&mut rng, padding, plaintext.as_bytes())
        .map_err(|e| CryptoError::Rsa(format!("Encryption failed: {}", e)))?;

    Ok(BASE64.encode(&ciphertext))
}

/// Decrypt data with RSA private key using OAEP padding
///
/// # Arguments
/// * `ciphertext` - Base64-encoded ciphertext
/// * `private_key_pem` - PEM-encoded private key (PKCS8 format)
///
/// # Returns
/// Decrypted plaintext string
pub fn rsa_decrypt(ciphertext: &str, private_key_pem: &str) -> Result<String, CryptoError> {
    let private_key = parse_private_key_pem(private_key_pem)?;

    let ciphertext_bytes = BASE64.decode(ciphertext)?;

    let padding = Oaep::new::<Sha256>();

    let plaintext_bytes = private_key
        .decrypt(padding, &ciphertext_bytes)
        .map_err(|e| CryptoError::Rsa(format!("Decryption failed: {}", e)))?;

    String::from_utf8(plaintext_bytes).map_err(|e| CryptoError::Utf8Error(e.to_string()))
}

/// Parse a PEM-encoded public key, handling various formats
fn parse_public_key_pem(pem: &str) -> Result<RsaPublicKey, CryptoError> {
    // Try SPKI format first (standard)
    if let Ok(key) = RsaPublicKey::from_public_key_pem(pem) {
        return Ok(key);
    }

    // Try parsing with stripped headers (for compatibility)
    let stripped = pem
        .replace("-----BEGIN PUBLIC KEY-----", "")
        .replace("-----END PUBLIC KEY-----", "")
        .replace(['\n', '\r', ' '], "");

    let der = BASE64
        .decode(&stripped)
        .map_err(|e| CryptoError::InvalidPem(format!("Invalid base64: {}", e)))?;

    RsaPublicKey::from_public_key_der(&der)
        .map_err(|e| CryptoError::InvalidPem(format!("Invalid public key: {}", e)))
}

/// Parse a PEM-encoded private key, handling various formats
fn parse_private_key_pem(pem: &str) -> Result<RsaPrivateKey, CryptoError> {
    // Try PKCS8 format first (standard)
    if let Ok(key) = RsaPrivateKey::from_pkcs8_pem(pem) {
        return Ok(key);
    }

    // Try parsing with stripped headers (for compatibility)
    let stripped = pem
        .replace("-----BEGIN PRIVATE KEY-----", "")
        .replace("-----END PRIVATE KEY-----", "")
        .replace(['\n', '\r', ' '], "");

    let der = BASE64
        .decode(&stripped)
        .map_err(|e| CryptoError::InvalidPem(format!("Invalid base64: {}", e)))?;

    RsaPrivateKey::from_pkcs8_der(&der)
        .map_err(|e| CryptoError::InvalidPem(format!("Invalid private key: {}", e)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_generate_key_pair() {
        let key_pair = generate_rsa_key_pair().unwrap();

        assert!(key_pair.public_key.contains("-----BEGIN PUBLIC KEY-----"));
        assert!(key_pair.public_key.contains("-----END PUBLIC KEY-----"));
        assert!(key_pair.private_key.contains("-----BEGIN PRIVATE KEY-----"));
        assert!(key_pair.private_key.contains("-----END PRIVATE KEY-----"));
    }

    #[test]
    fn test_encrypt_decrypt_roundtrip() {
        let key_pair = generate_rsa_key_pair().unwrap();
        let plaintext = "Hello, World! This is a secret vault key.";

        let ciphertext = rsa_encrypt(plaintext, &key_pair.public_key).unwrap();
        let decrypted = rsa_decrypt(&ciphertext, &key_pair.private_key).unwrap();

        assert_eq!(plaintext, decrypted);
    }

    #[test]
    fn test_different_encryptions_produce_different_ciphertext() {
        let key_pair = generate_rsa_key_pair().unwrap();
        let plaintext = "Test message";

        let ciphertext1 = rsa_encrypt(plaintext, &key_pair.public_key).unwrap();
        let ciphertext2 = rsa_encrypt(plaintext, &key_pair.public_key).unwrap();

        // OAEP padding is randomized
        assert_ne!(ciphertext1, ciphertext2);
    }

    #[test]
    fn test_wrong_key_fails_decryption() {
        let key_pair1 = generate_rsa_key_pair().unwrap();
        let key_pair2 = generate_rsa_key_pair().unwrap();
        let plaintext = "Secret";

        let ciphertext = rsa_encrypt(plaintext, &key_pair1.public_key).unwrap();
        let result = rsa_decrypt(&ciphertext, &key_pair2.private_key);

        assert!(result.is_err());
    }

    #[test]
    fn test_unicode_plaintext() {
        let key_pair = generate_rsa_key_pair().unwrap();
        let plaintext = "密码 🔐 Contraseña";

        let ciphertext = rsa_encrypt(plaintext, &key_pair.public_key).unwrap();
        let decrypted = rsa_decrypt(&ciphertext, &key_pair.private_key).unwrap();

        assert_eq!(plaintext, decrypted);
    }
}
