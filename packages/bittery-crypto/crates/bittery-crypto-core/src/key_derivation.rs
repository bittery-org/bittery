//! Key Derivation Functions
//!
//! Derives authentication and encryption keys from Account Password + Secret Key
//! using PBKDF2 for initial derivation and HKDF to split into two keys.

use hkdf::Hkdf;
use pbkdf2::pbkdf2_hmac;
use sha2::Sha256;

use crate::error::CryptoError;

/// Number of PBKDF2 iterations for master key derivation
const PBKDF2_ITERATIONS: u32 = 100_000;

/// Key length in bytes (256 bits)
const KEY_LENGTH: usize = 32;

/// Info string for auth key derivation via HKDF
const AUTH_KEY_INFO: &[u8] = b"bittery-auth-key";

/// Info string for master unlock key derivation via HKDF
const UNLOCK_KEY_INFO: &[u8] = b"bittery-unlock-key";

/// Derived keys from password and secret key
#[derive(Debug, Clone)]
pub struct DerivedKeys {
    /// Authentication key for SRP protocol
    pub auth_key: [u8; KEY_LENGTH],
    /// Master unlock key for encrypting vault keys
    pub master_unlock_key: [u8; KEY_LENGTH],
}

/// Derive authentication and master unlock keys from password + secret key
///
/// # Arguments
/// * `account_password` - User's account password
/// * `secret_key` - User's secret key (A3-XXXXXX format)
/// * `email` - User's email (used as salt)
///
/// # Returns
/// `DerivedKeys` containing auth_key and master_unlock_key
///
/// # Algorithm
/// 1. Combine: `"${password}|${secretKey}"` UTF-8
/// 2. PBKDF2(SHA-256, 100k iterations) with email.lowercase() as salt
/// 3. HKDF(SHA-256) with different info strings for each key
pub fn derive_keys(
    account_password: &str,
    secret_key: &str,
    email: &str,
) -> Result<DerivedKeys, CryptoError> {
    // Combine password and secret key
    let combined = format!("{}|{}", account_password, secret_key);
    let combined_bytes = combined.as_bytes();

    // Use lowercase email as salt for PBKDF2
    let salt = email.to_lowercase();
    let salt_bytes = salt.as_bytes();

    // Derive master key using PBKDF2
    let mut master_key = [0u8; KEY_LENGTH];
    pbkdf2_hmac::<Sha256>(combined_bytes, salt_bytes, PBKDF2_ITERATIONS, &mut master_key);

    // Split master key into auth key and master unlock key using HKDF
    let hkdf = Hkdf::<Sha256>::new(Some(salt_bytes), &master_key);

    let mut auth_key = [0u8; KEY_LENGTH];
    hkdf.expand(AUTH_KEY_INFO, &mut auth_key)
        .map_err(|e| CryptoError::KeyDerivation(e.to_string()))?;

    let mut master_unlock_key = [0u8; KEY_LENGTH];
    hkdf.expand(UNLOCK_KEY_INFO, &mut master_unlock_key)
        .map_err(|e| CryptoError::KeyDerivation(e.to_string()))?;

    Ok(DerivedKeys {
        auth_key,
        master_unlock_key,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_derive_keys_deterministic() {
        let password = "test_password";
        let secret_key = "A3-ABCDEF-GHIJKL-MNOPQ-RSTUV-WXYZ2";
        let email = "test@example.com";

        let keys1 = derive_keys(password, secret_key, email).unwrap();
        let keys2 = derive_keys(password, secret_key, email).unwrap();

        assert_eq!(keys1.auth_key, keys2.auth_key);
        assert_eq!(keys1.master_unlock_key, keys2.master_unlock_key);
    }

    #[test]
    fn test_derive_keys_different_inputs_different_outputs() {
        let password = "test_password";
        let secret_key = "A3-ABCDEF-GHIJKL-MNOPQ-RSTUV-WXYZ2";
        let email = "test@example.com";

        let keys1 = derive_keys(password, secret_key, email).unwrap();
        let keys2 = derive_keys("different_password", secret_key, email).unwrap();

        assert_ne!(keys1.auth_key, keys2.auth_key);
        assert_ne!(keys1.master_unlock_key, keys2.master_unlock_key);
    }

    #[test]
    fn test_derive_keys_email_case_insensitive() {
        let password = "test_password";
        let secret_key = "A3-ABCDEF-GHIJKL-MNOPQ-RSTUV-WXYZ2";

        let keys1 = derive_keys(password, secret_key, "Test@Example.com").unwrap();
        let keys2 = derive_keys(password, secret_key, "test@example.com").unwrap();

        assert_eq!(keys1.auth_key, keys2.auth_key);
        assert_eq!(keys1.master_unlock_key, keys2.master_unlock_key);
    }

    #[test]
    fn test_key_lengths() {
        let keys = derive_keys("password", "secret", "email@test.com").unwrap();
        assert_eq!(keys.auth_key.len(), 32);
        assert_eq!(keys.master_unlock_key.len(), 32);
    }
}
