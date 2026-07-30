//! Recovery Key Management
//!
//! Provides a secondary high-entropy recovery key used to encrypt/decrypt
//! the intermediate password-derived master key for account recovery flows.

use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use pbkdf2::pbkdf2_hmac;
use rand::Rng;
use sha2::Sha256;
use zeroize::Zeroize;

use crate::identity::normalize_email;
use crate::secret_key::CHARSET;
use crate::{decrypt, encrypt, system_rng, CryptoError, EncryptedData};

/// Version prefix for recovery keys
const VERSION_PREFIX: &str = "R1";

/// Number of PBKDF2 iterations for recovery key encryption key derivation
const RECOVERY_PBKDF2_ITERATIONS: u32 = 100_000;

/// Master key length in bytes (256 bits)
const MASTER_KEY_LENGTH: usize = 32;

/// Generate a cryptographically secure Recovery Key
///
/// Format: R1-XXXXXX-XXXXXX-XXXXX-XXXXX-XXXXX-XXXXX-XXXXX
pub fn generate_recovery_key() -> String {
    let segments = [
        VERSION_PREFIX.to_string(),
        generate_segment(6),
        generate_segment(6),
        generate_segment(5),
        generate_segment(5),
        generate_segment(5),
        generate_segment(5),
        generate_segment(5),
    ];
    segments.join("-")
}

/// Validate Recovery Key format
///
/// Pattern: R1-XXXXXX-XXXXXX-XXXXX-XXXXX-XXXXX-XXXXX-XXXXX
/// where X is [A-Z2-7]
pub fn validate_recovery_key(recovery_key: &str) -> bool {
    let parts: Vec<&str> = recovery_key.split('-').collect();
    if parts.len() != 8 {
        return false;
    }

    if parts[0] != VERSION_PREFIX {
        return false;
    }

    let expected_lengths = [6, 6, 5, 5, 5, 5, 5];
    for (i, &expected_len) in expected_lengths.iter().enumerate() {
        let segment = parts[i + 1];
        if segment.len() != expected_len {
            return false;
        }

        if !segment.chars().all(|c| CHARSET.contains(&(c as u8))) {
            return false;
        }
    }

    true
}

/// Derive a 32-byte encryption key from Recovery Key + email
///
/// Uses PBKDF2(SHA-256, 100k iterations) with lowercase email as salt.
pub fn derive_recovery_encryption_key(
    recovery_key: &str,
    email: &str,
) -> Result<[u8; MASTER_KEY_LENGTH], CryptoError> {
    if !validate_recovery_key(recovery_key) {
        return Err(CryptoError::InvalidInput(
            "Invalid recovery key format".to_string(),
        ));
    }

    let mut derived_key = [0u8; MASTER_KEY_LENGTH];
    let mut salt_bytes = normalize_email(email).into_bytes();

    pbkdf2_hmac::<Sha256>(
        recovery_key.as_bytes(),
        &salt_bytes,
        RECOVERY_PBKDF2_ITERATIONS,
        &mut derived_key,
    );

    salt_bytes.zeroize();
    Ok(derived_key)
}

/// Encrypt a raw 32-byte master key with a recovery key
pub fn encrypt_master_key(
    master_key: &[u8],
    recovery_key: &str,
    email: &str,
) -> Result<EncryptedData, CryptoError> {
    if master_key.len() != MASTER_KEY_LENGTH {
        return Err(CryptoError::InvalidKeyLength {
            expected: MASTER_KEY_LENGTH,
            actual: master_key.len(),
        });
    }

    let mut encryption_key = derive_recovery_encryption_key(recovery_key, email)?;
    let encoded_master_key = BASE64.encode(master_key);
    let result = encrypt(&encoded_master_key, &encryption_key);
    encryption_key.zeroize();
    result
}

/// Decrypt an encrypted master key blob using the recovery key
pub fn decrypt_master_key(
    encrypted: &EncryptedData,
    recovery_key: &str,
    email: &str,
) -> Result<[u8; MASTER_KEY_LENGTH], CryptoError> {
    let mut encryption_key = derive_recovery_encryption_key(recovery_key, email)?;
    let mut encoded_master_key = decrypt(encrypted, &encryption_key)?;
    encryption_key.zeroize();

    let mut decoded_master_key = BASE64.decode(&encoded_master_key)?;
    encoded_master_key.zeroize();

    if decoded_master_key.len() != MASTER_KEY_LENGTH {
        decoded_master_key.zeroize();
        return Err(CryptoError::InvalidKeyLength {
            expected: MASTER_KEY_LENGTH,
            actual: decoded_master_key.len(),
        });
    }

    let mut master_key = [0u8; MASTER_KEY_LENGTH];
    master_key.copy_from_slice(&decoded_master_key);
    decoded_master_key.zeroize();

    Ok(master_key)
}

fn generate_segment(length: usize) -> String {
    let mut rng = system_rng();
    let mut bytes = vec![0u8; length];
    rng.fill_bytes(&mut bytes);

    bytes
        .iter()
        .map(|&byte| CHARSET[(byte as usize) % CHARSET.len()] as char)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    const TEST_RECOVERY_KEY: &str = "R1-ABCDEF-GHIJKL-MNOPQ-RSTUV-WXYZ2-BCDEF-GHIJK";

    #[test]
    fn test_generate_recovery_key_format() {
        let recovery_key = generate_recovery_key();

        assert!(recovery_key.starts_with("R1-"));

        let parts: Vec<&str> = recovery_key.split('-').collect();
        assert_eq!(parts.len(), 8);
        assert_eq!(parts[0], "R1");
        assert_eq!(parts[1].len(), 6);
        assert_eq!(parts[2].len(), 6);
        assert_eq!(parts[3].len(), 5);
        assert_eq!(parts[4].len(), 5);
        assert_eq!(parts[5].len(), 5);
        assert_eq!(parts[6].len(), 5);
        assert_eq!(parts[7].len(), 5);
    }

    #[test]
    fn test_validate_recovery_key_valid() {
        assert!(validate_recovery_key(TEST_RECOVERY_KEY));
        assert!(validate_recovery_key(&generate_recovery_key()));
    }

    #[test]
    fn test_validate_recovery_key_invalid() {
        assert!(!validate_recovery_key(
            "R2-ABCDEF-GHIJKL-MNOPQ-RSTUV-WXYZ2-BCDEF-GHIJK"
        ));
        assert!(!validate_recovery_key(
            "R1-ABCDE-GHIJKL-MNOPQ-RSTUV-WXYZ2-BCDEF-GHIJK"
        ));
        assert!(!validate_recovery_key(
            "R1-ABC019-GHIJKL-MNOPQ-RSTUV-WXYZ2-BCDEF-GHIJK"
        ));
        assert!(!validate_recovery_key(""));
    }

    #[test]
    fn test_derive_recovery_encryption_key_email_case_insensitive() {
        let key1 = derive_recovery_encryption_key(TEST_RECOVERY_KEY, "Test@Example.com").unwrap();
        let key2 = derive_recovery_encryption_key(TEST_RECOVERY_KEY, "test@example.com").unwrap();
        assert_eq!(key1, key2);
    }

    #[test]
    fn test_derive_recovery_encryption_key_nfkc_normalizes_email_salt() {
        let nfc = derive_recovery_encryption_key(TEST_RECOVERY_KEY, "müller@example.com").unwrap();
        let nfd = derive_recovery_encryption_key(TEST_RECOVERY_KEY, "mu\u{0308}ller@example.com")
            .unwrap();

        assert_eq!(nfc, nfd);
    }

    #[test]
    fn test_encrypt_decrypt_master_key_roundtrip() {
        let master_key = [42u8; MASTER_KEY_LENGTH];
        let encrypted =
            encrypt_master_key(&master_key, TEST_RECOVERY_KEY, "test@example.com").unwrap();
        let decrypted =
            decrypt_master_key(&encrypted, TEST_RECOVERY_KEY, "test@example.com").unwrap();

        assert_eq!(master_key, decrypted);
    }

    #[test]
    fn test_decrypt_master_key_wrong_recovery_key_fails() {
        let master_key = [42u8; MASTER_KEY_LENGTH];
        let encrypted =
            encrypt_master_key(&master_key, TEST_RECOVERY_KEY, "test@example.com").unwrap();
        let wrong_key = "R1-ZYXWVU-TSRQPO-NMLKJ-HGFED-CBA23-UVWXY-ABCDE";

        let result = decrypt_master_key(&encrypted, wrong_key, "test@example.com");
        assert!(result.is_err());
    }

    #[test]
    fn test_encrypt_master_key_invalid_length() {
        let too_short = [7u8; 16];
        let result = encrypt_master_key(&too_short, TEST_RECOVERY_KEY, "test@example.com");
        assert!(matches!(result, Err(CryptoError::InvalidKeyLength { .. })));
    }
}
