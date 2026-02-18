//! Key Derivation Functions
//!
//! Derives authentication and encryption keys from Account Password + Secret Key
//! using PBKDF2 for initial derivation and HKDF to split into two keys.

use hkdf::Hkdf;
use pbkdf2::pbkdf2_hmac;
use sha2::Sha256;
use zeroize::{Zeroize, ZeroizeOnDrop};

use crate::error::CryptoError;

/// Number of PBKDF2 iterations for master key derivation
const PBKDF2_ITERATIONS: u32 = 310_000;

/// Key length in bytes (256 bits)
const KEY_LENGTH: usize = 32;

/// Info string for auth key derivation via HKDF
const AUTH_KEY_INFO: &[u8] = b"bittery-auth-key";

/// Info string for master unlock key derivation via HKDF
const UNLOCK_KEY_INFO: &[u8] = b"bittery-unlock-key";

/// Derived keys from password and secret key
#[derive(Debug, Clone, Zeroize, ZeroizeOnDrop)]
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
/// 1. Combine with length prefixes to avoid concatenation collisions
/// 2. PBKDF2(SHA-256, 310k iterations) with email.lowercase() as salt
/// 3. HKDF(SHA-256) with different info strings for each key
pub fn derive_keys(
    account_password: &str,
    secret_key: &str,
    email: &str,
) -> Result<DerivedKeys, CryptoError> {
    let mut master_key = derive_master_key(account_password, secret_key, email)?;
    let derived_keys = derive_keys_from_master_key(&master_key, email);
    master_key.zeroize();
    derived_keys
}

/// Derive the intermediate 32-byte master key from password + secret key
///
/// This is the PBKDF2 step used before HKDF key splitting.
pub fn derive_master_key(
    account_password: &str,
    secret_key: &str,
    email: &str,
) -> Result<[u8; KEY_LENGTH], CryptoError> {
    // Combine with length prefixes: [len(password)][password][len(secret)][secret]
    let password_bytes = account_password.as_bytes();
    let secret_bytes = secret_key.as_bytes();
    let password_len = u32::try_from(password_bytes.len())
        .map_err(|_| CryptoError::InvalidInput("Password too long".to_string()))?;
    let secret_len = u32::try_from(secret_bytes.len())
        .map_err(|_| CryptoError::InvalidInput("Secret key too long".to_string()))?;

    let mut combined = Vec::with_capacity(8 + password_bytes.len() + secret_bytes.len());
    combined.extend_from_slice(&password_len.to_be_bytes());
    combined.extend_from_slice(password_bytes);
    combined.extend_from_slice(&secret_len.to_be_bytes());
    combined.extend_from_slice(secret_bytes);

    // Use lowercase email as salt for PBKDF2
    let mut salt_bytes = email.to_lowercase().into_bytes();

    // Derive master key using PBKDF2
    let mut master_key = [0u8; KEY_LENGTH];
    pbkdf2_hmac::<Sha256>(&combined, &salt_bytes, PBKDF2_ITERATIONS, &mut master_key);

    combined.zeroize();
    salt_bytes.zeroize();

    Ok(master_key)
}

/// Split a raw master key into auth key + master unlock key
///
/// This is the HKDF step used by the login/signup flows.
pub fn derive_keys_from_master_key(
    master_key: &[u8],
    email: &str,
) -> Result<DerivedKeys, CryptoError> {
    if master_key.len() != KEY_LENGTH {
        return Err(CryptoError::InvalidKeyLength {
            expected: KEY_LENGTH,
            actual: master_key.len(),
        });
    }

    let mut salt_bytes = email.to_lowercase().into_bytes();

    // Split master key into auth key and master unlock key using HKDF
    let hkdf = Hkdf::<Sha256>::new(Some(&salt_bytes), master_key);

    let mut auth_key = [0u8; KEY_LENGTH];
    if let Err(e) = hkdf.expand(AUTH_KEY_INFO, &mut auth_key) {
        salt_bytes.zeroize();
        return Err(CryptoError::KeyDerivation(e.to_string()));
    }

    let mut master_unlock_key = [0u8; KEY_LENGTH];
    if let Err(e) = hkdf.expand(UNLOCK_KEY_INFO, &mut master_unlock_key) {
        auth_key.zeroize();
        salt_bytes.zeroize();
        return Err(CryptoError::KeyDerivation(e.to_string()));
    }

    salt_bytes.zeroize();

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

    #[test]
    fn test_length_prefixed_inputs_prevent_pipe_collisions() {
        let email = "test@example.com";
        let keys1 = derive_keys("a|b", "c", email).unwrap();
        let keys2 = derive_keys("a", "b|c", email).unwrap();

        assert_ne!(keys1.auth_key, keys2.auth_key);
        assert_ne!(keys1.master_unlock_key, keys2.master_unlock_key);
    }

    #[test]
    fn test_derive_keys_from_master_key_matches_derive_keys() {
        let password = "test_password";
        let secret_key = "A3-ABCDEF-GHIJKL-MNOPQ-RSTUV-WXYZ2";
        let email = "test@example.com";

        let derived_direct = derive_keys(password, secret_key, email).unwrap();
        let master_key = derive_master_key(password, secret_key, email).unwrap();
        let derived_from_master = derive_keys_from_master_key(&master_key, email).unwrap();

        assert_eq!(derived_direct.auth_key, derived_from_master.auth_key);
        assert_eq!(
            derived_direct.master_unlock_key,
            derived_from_master.master_unlock_key
        );
    }

    #[test]
    fn test_derive_keys_from_master_key_invalid_length() {
        let short_master_key = [0u8; 16];
        let result = derive_keys_from_master_key(&short_master_key, "test@example.com");
        assert!(matches!(result, Err(CryptoError::InvalidKeyLength { .. })));
    }
}
