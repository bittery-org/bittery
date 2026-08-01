//! RSA-4096 Key Generation and Encryption
//!
//! RSA-OAEP with SHA-256 for encrypting vault keys when sharing with team members.

use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
// `rsa` 0.9 is still on the `digest` 0.10 / `rand_core` 0.6 generation (there is
// no stable release on `digest` 0.11 yet). Both are therefore taken from `rsa`'s
// own re-exports rather than from the workspace `sha2` 0.11 / `rand` 0.10, so
// the two RustCrypto generations can coexist without ever being mixed up.
// `rsa::rand_core::OsRng` is the OS entropy source, same as before.
use rsa::rand_core::OsRng;
use rsa::sha2::Sha256;
use rsa::{
    pkcs8::{DecodePrivateKey, DecodePublicKey, EncodePrivateKey, EncodePublicKey, LineEnding},
    Oaep, RsaPrivateKey, RsaPublicKey,
};
use zeroize::{Zeroize, ZeroizeOnDrop};

use crate::error::CryptoError;

/// RSA key size in bits
const RSA_KEY_SIZE: usize = 4096;

/// RSA key pair in PEM format
#[derive(Clone, Zeroize, ZeroizeOnDrop)]
pub struct RsaKeyPair {
    /// Public key in SPKI PEM format
    pub public_key: String,
    /// Private key in PKCS8 PEM format
    pub private_key: String,
}

// Hand-written so that `{:?}` (or a stray `dbg!`) can never print the PKCS#8
// private-key PEM. A derived `Debug` would.
impl std::fmt::Debug for RsaKeyPair {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("RsaKeyPair")
            .field("public_key", &self.public_key)
            .field("private_key", &"[redacted]")
            .finish()
    }
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

    // `decrypt` (unblinded) is the failure mode behind RUSTSEC-2023-0071 (Marvin):
    // the timing of the modular exponentiation leaks information about the private
    // key. `rsa` 0.9.10 has no fixed release and 0.10.0-rc does not address it
    // either, so RNG blinding is the available mitigation and must not be dropped.
    let mut rng = OsRng;
    let plaintext_bytes = private_key
        .decrypt_blinded(&mut rng, padding, &ciphertext_bytes)
        .map_err(|e| CryptoError::Rsa(format!("Decryption failed: {}", e)))?;

    String::from_utf8(plaintext_bytes).map_err(|e| CryptoError::Utf8Error(e.to_string()))
}

/// Parse a PEM-encoded public key (strict SPKI PEM only)
fn parse_public_key_pem(pem: &str) -> Result<RsaPublicKey, CryptoError> {
    RsaPublicKey::from_public_key_pem(pem)
        .map_err(|e| CryptoError::InvalidPem(format!("Invalid public key PEM: {}", e)))
}

/// Parse a PEM-encoded private key (strict PKCS8 PEM only)
fn parse_private_key_pem(pem: &str) -> Result<RsaPrivateKey, CryptoError> {
    RsaPrivateKey::from_pkcs8_pem(pem)
        .map_err(|e| CryptoError::InvalidPem(format!("Invalid private key PEM: {}", e)))
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

    #[test]
    fn test_debug_does_not_leak_private_key() {
        let key_pair = generate_rsa_key_pair().unwrap();
        let rendered = format!("{key_pair:?}");

        assert!(!rendered.contains("-----BEGIN PRIVATE KEY-----"));
        assert!(!rendered.contains(key_pair.private_key.trim()));
        assert!(rendered.contains("[redacted]"));
        // The public half stays visible — it is not secret and is useful in logs.
        assert!(rendered.contains("-----BEGIN PUBLIC KEY-----"));
    }

    #[test]
    fn test_parse_rejects_non_pem_public_key() {
        let key_pair = generate_rsa_key_pair().unwrap();
        let non_pem = key_pair
            .public_key
            .replace("-----BEGIN PUBLIC KEY-----", "")
            .replace("-----END PUBLIC KEY-----", "")
            .replace(['\n', '\r'], "");

        let result = rsa_encrypt("test", &non_pem);
        assert!(result.is_err());
    }
}
