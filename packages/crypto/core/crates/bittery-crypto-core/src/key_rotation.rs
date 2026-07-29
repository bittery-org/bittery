//! Key Rotation Utilities
//!
//! Handles vault key rotation for secure access revocation.
//! When a member is removed from a vault, all data must be re-encrypted
//! with a new key to ensure the removed member cannot decrypt future data.

use crate::encryption::{
    decrypt, decrypt_with_aad, encrypt, encrypt_with_aad, generate_encryption_key, AadContext,
    EncryptedData,
};
use crate::error::CryptoError;
use crate::rsa::rsa_encrypt;
use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use serde::{Deserialize, Serialize};
use zeroize::Zeroize;

/// Item data for re-encryption
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ItemData {
    /// Item ID
    pub id: String,
    /// Base64-encoded ciphertext
    pub encrypted_data: String,
    /// Base64-encoded IV
    pub encryption_iv: String,
    /// Encryption algorithm (should be "AES-GCM")
    pub encryption_algorithm: String,
}

/// Re-encrypted item result
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReEncryptedItem {
    /// Item ID
    pub item_id: String,
    /// New base64-encoded ciphertext
    pub encrypted_data: String,
    /// New base64-encoded IV
    pub encryption_iv: String,
}

/// Member key data for encryption
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MemberKeyData {
    /// User ID
    pub user_id: String,
    /// PEM-encoded RSA public key
    pub public_key: String,
}

/// Member with encrypted vault key
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MemberEncryptedKey {
    /// User ID
    pub user_id: String,
    /// Encrypted vault key (RSA-encrypted for other members, AES-GCM for current user)
    pub encrypted_vault_key: String,
}

/// Key rotation result
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct KeyRotationResult {
    /// Encrypted keys for each member
    pub member_encrypted_keys: Vec<MemberEncryptedKey>,
    /// Re-encrypted items
    pub re_encrypted_items: Vec<ReEncryptedItem>,
}

/// Fixed entity type for MUK-wrapped vault keys.
pub const VAULT_KEY_WRAP_ENTITY_TYPE: &str = "vault_key";
/// Fixed purpose for MUK-wrapped vault keys.
pub const VAULT_KEY_WRAP_PURPOSE: &str = "vault-key-wrap";

/// Context metadata for MUK-wrapped vault keys.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct VaultKeyWrapContext {
    /// Vault that this key belongs to
    pub vault_id: String,
    /// User that this wrapped key is bound to
    pub user_id: String,
    /// Vault key version
    pub key_version: u64,
    /// Wrap purpose marker
    pub purpose: String,
}

impl VaultKeyWrapContext {
    pub fn new(vault_id: &str, user_id: &str, key_version: u64) -> Self {
        Self {
            vault_id: vault_id.to_string(),
            user_id: user_id.to_string(),
            key_version,
            purpose: VAULT_KEY_WRAP_PURPOSE.to_string(),
        }
    }

    fn to_aad_context(&self) -> AadContext {
        AadContext {
            vault_id: self.vault_id.clone(),
            entity_id: self.purpose.clone(),
            entity_type: VAULT_KEY_WRAP_ENTITY_TYPE.to_string(),
            version: self.key_version,
            user_id: self.user_id.clone(),
        }
    }
}

/// JSON payload stored in `encryptedVaultKey` for owner/MUK wrapping.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WrappedVaultKeyData {
    #[serde(flatten)]
    pub encrypted: EncryptedData,
    pub context: VaultKeyWrapContext,
}

/// Validation result for rotation data
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ValidationResult {
    /// Whether the data is valid
    pub valid: bool,
    /// Error messages if invalid
    pub errors: Vec<String>,
}

/// Generate a new vault key for rotation
pub fn generate_new_vault_key() -> [u8; 32] {
    generate_encryption_key()
}

/// Encrypt a vault key with a member's RSA public key
///
/// # Arguments
/// * `vault_key` - 32-byte vault encryption key
/// * `member_public_key` - PEM-encoded RSA public key
///
/// # Returns
/// Base64-encoded RSA ciphertext
pub fn encrypt_vault_key_for_member(
    vault_key: &[u8],
    member_public_key: &str,
) -> Result<String, CryptoError> {
    let mut vault_key_base64 = BASE64.encode(vault_key);
    let encrypted = rsa_encrypt(&vault_key_base64, member_public_key);
    vault_key_base64.zeroize();
    encrypted
}

/// Encrypt a vault key with AES-GCM (for the owner using Master Unlock Key)
///
/// # Arguments
/// * `vault_key` - 32-byte vault encryption key
/// * `master_unlock_key` - 32-byte Master Unlock Key
///
/// # Returns
/// JSON-serialized EncryptedData
pub fn encrypt_vault_key_with_muk(
    vault_key: &[u8],
    master_unlock_key: &[u8],
    wrap_context: &VaultKeyWrapContext,
) -> Result<String, CryptoError> {
    let mut vault_key_base64 = BASE64.encode(vault_key);
    let aad_context = wrap_context.to_aad_context();
    let encrypted = match encrypt_with_aad(&vault_key_base64, master_unlock_key, &aad_context) {
        Ok(value) => value,
        Err(e) => {
            vault_key_base64.zeroize();
            return Err(e);
        }
    };
    vault_key_base64.zeroize();
    serde_json::to_string(&WrappedVaultKeyData {
        encrypted,
        context: wrap_context.clone(),
    })
    .map_err(|e| CryptoError::Encryption(format!("JSON serialization failed: {}", e)))
}

/// Decrypt and validate a vault key wrapped with MUK + AAD context.
pub fn decrypt_vault_key_with_muk(
    wrapped_json: &str,
    master_unlock_key: &[u8],
    expected_context: &VaultKeyWrapContext,
) -> Result<Vec<u8>, CryptoError> {
    let wrapped: WrappedVaultKeyData = serde_json::from_str(wrapped_json)
        .map_err(|e| CryptoError::InvalidInput(format!("Invalid wrapped vault key JSON: {}", e)))?;

    if wrapped.context != *expected_context {
        return Err(CryptoError::InvalidInput(
            "Vault key wrap context mismatch".to_string(),
        ));
    }

    let aad_context = wrapped.context.to_aad_context();
    let mut decrypted_base64 =
        decrypt_with_aad(&wrapped.encrypted, master_unlock_key, &aad_context)?;
    let decrypted = BASE64
        .decode(decrypted_base64.as_bytes())
        .map_err(|e| CryptoError::Base64Decode(e.to_string()))?;
    decrypted_base64.zeroize();
    Ok(decrypted)
}

/// Re-encrypt an item with a new vault key
///
/// Decrypts the item with the old key and re-encrypts with the new key.
///
/// # Arguments
/// * `item` - Item data to re-encrypt
/// * `old_vault_key` - 32-byte old vault encryption key
/// * `new_vault_key` - 32-byte new vault encryption key
///
/// # Returns
/// Re-encrypted item with new ciphertext and IV
pub fn re_encrypt_item(
    item: &ItemData,
    old_vault_key: &[u8],
    new_vault_key: &[u8],
) -> Result<ReEncryptedItem, CryptoError> {
    // Decrypt with old key
    let old_encrypted_data = EncryptedData {
        ciphertext: item.encrypted_data.clone(),
        iv: item.encryption_iv.clone(),
        algorithm: item.encryption_algorithm.clone(),
    };

    let mut decrypted_data = decrypt(&old_encrypted_data, old_vault_key)?;

    // Re-encrypt with new key
    let new_encrypted_data = match encrypt(&decrypted_data, new_vault_key) {
        Ok(value) => value,
        Err(e) => {
            decrypted_data.zeroize();
            return Err(e);
        }
    };
    decrypted_data.zeroize();

    Ok(ReEncryptedItem {
        item_id: item.id.clone(),
        encrypted_data: new_encrypted_data.ciphertext,
        encryption_iv: new_encrypted_data.iv,
    })
}

/// Perform a complete key rotation
///
/// 1. Generate a new vault key
/// 2. Encrypt the new key for each remaining member:
///    - For the current user: encrypt with Master Unlock Key (AES-GCM)
///    - For other members: encrypt with their RSA public keys
/// 3. Re-encrypt all items with the new key
///
/// # Arguments
/// * `old_vault_key` - 32-byte old vault encryption key
/// * `members` - Member data with public keys
/// * `items` - Items to re-encrypt
/// * `current_user_id` - Current user's ID (for MUK encryption)
/// * `master_unlock_key` - Current user's Master Unlock Key
///
/// # Returns
/// Key rotation result with new keys and re-encrypted items
pub fn perform_key_rotation(
    old_vault_key: &[u8],
    members: &[MemberKeyData],
    items: &[ItemData],
    vault_id: &str,
    key_version: u64,
    current_user_id: &str,
    master_unlock_key: &[u8],
) -> Result<KeyRotationResult, CryptoError> {
    // 1. Generate new vault key
    let mut new_vault_key = generate_new_vault_key();

    // 2. Encrypt new vault key for each member
    let mut member_encrypted_keys = Vec::with_capacity(members.len());
    for member in members {
        let encrypted_key = if member.user_id == current_user_id {
            // Current user: encrypt with AES-GCM using Master Unlock Key
            let wrap_context = VaultKeyWrapContext::new(vault_id, current_user_id, key_version);
            match encrypt_vault_key_with_muk(&new_vault_key, master_unlock_key, &wrap_context) {
                Ok(value) => value,
                Err(e) => {
                    new_vault_key.zeroize();
                    return Err(e);
                }
            }
        } else {
            // Other members: encrypt with RSA using their public key
            match encrypt_vault_key_for_member(&new_vault_key, &member.public_key) {
                Ok(value) => value,
                Err(e) => {
                    new_vault_key.zeroize();
                    return Err(e);
                }
            }
        };

        member_encrypted_keys.push(MemberEncryptedKey {
            user_id: member.user_id.clone(),
            encrypted_vault_key: encrypted_key,
        });
    }

    // 3. Re-encrypt all items with the new key
    let mut re_encrypted_items = Vec::with_capacity(items.len());
    for item in items {
        let re_encrypted = match re_encrypt_item(item, old_vault_key, &new_vault_key) {
            Ok(value) => value,
            Err(e) => {
                new_vault_key.zeroize();
                return Err(e);
            }
        };
        re_encrypted_items.push(re_encrypted);
    }

    let result = KeyRotationResult {
        member_encrypted_keys,
        re_encrypted_items,
    };
    new_vault_key.zeroize();
    Ok(result)
}

/// Validate that rotation can be performed
///
/// Checks that all members have valid public keys.
pub fn validate_rotation_data(members: &[MemberKeyData]) -> ValidationResult {
    let mut errors = Vec::new();

    for member in members {
        if member.public_key.is_empty() {
            errors.push(format!("Member {} has no public key", member.user_id));
        } else if !member.public_key.contains("-----BEGIN PUBLIC KEY-----") {
            errors.push(format!(
                "Member {} has invalid public key format",
                member.user_id
            ));
        }
    }

    ValidationResult {
        valid: errors.is_empty(),
        errors,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::rsa::{generate_rsa_key_pair, rsa_decrypt};

    #[test]
    fn test_generate_new_vault_key() {
        let key1 = generate_new_vault_key();
        let key2 = generate_new_vault_key();

        assert_eq!(key1.len(), 32);
        assert_eq!(key2.len(), 32);
        assert_ne!(key1, key2); // Should be random
    }

    #[test]
    fn test_encrypt_vault_key_for_member() {
        let key_pair = generate_rsa_key_pair().unwrap();
        let vault_key = generate_new_vault_key();

        let encrypted = encrypt_vault_key_for_member(&vault_key, &key_pair.public_key).unwrap();
        let decrypted = rsa_decrypt(&encrypted, &key_pair.private_key).unwrap();

        assert_eq!(decrypted, BASE64.encode(vault_key));
    }

    #[test]
    fn test_encrypt_vault_key_with_muk() {
        let vault_key = generate_new_vault_key();
        let muk = generate_new_vault_key();
        let context = VaultKeyWrapContext::new("vault-1", "user-1", 3);

        let encrypted_json = encrypt_vault_key_with_muk(&vault_key, &muk, &context).unwrap();

        // Should be valid JSON
        let wrapped: WrappedVaultKeyData = serde_json::from_str(&encrypted_json).unwrap();
        assert_eq!(wrapped.context, context);
        let decrypted = decrypt_vault_key_with_muk(&encrypted_json, &muk, &context).unwrap();
        assert_eq!(decrypted, vault_key.to_vec());

        // Context mismatch must fail.
        let wrong_context = VaultKeyWrapContext::new("vault-2", "user-1", 3);
        assert!(decrypt_vault_key_with_muk(&encrypted_json, &muk, &wrong_context).is_err());
    }

    #[test]
    fn test_re_encrypt_item() {
        let old_key = generate_new_vault_key();
        let new_key = generate_new_vault_key();

        // Create original encrypted item
        let original_data = "Secret item data";
        let encrypted = encrypt(original_data, &old_key).unwrap();

        let item = ItemData {
            id: "test-item-1".to_string(),
            encrypted_data: encrypted.ciphertext,
            encryption_iv: encrypted.iv,
            encryption_algorithm: encrypted.algorithm,
        };

        // Re-encrypt
        let re_encrypted = re_encrypt_item(&item, &old_key, &new_key).unwrap();

        // Should be able to decrypt with new key
        let new_encrypted = EncryptedData {
            ciphertext: re_encrypted.encrypted_data,
            iv: re_encrypted.encryption_iv,
            algorithm: "AES-GCM-AAD-V1".to_string(),
        };
        let decrypted = decrypt(&new_encrypted, &new_key).unwrap();

        assert_eq!(decrypted, original_data);

        // Should NOT be able to decrypt with old key
        let result = decrypt(&new_encrypted, &old_key);
        assert!(result.is_err());
    }

    #[test]
    fn test_perform_key_rotation() {
        let owner_keys = generate_rsa_key_pair().unwrap();
        let member_keys = generate_rsa_key_pair().unwrap();

        let old_vault_key = generate_new_vault_key();
        let muk = generate_new_vault_key();

        // Create test items
        let item1 = encrypt("Item 1 data", &old_vault_key).unwrap();
        let item2 = encrypt("Item 2 data", &old_vault_key).unwrap();

        let items = vec![
            ItemData {
                id: "item-1".to_string(),
                encrypted_data: item1.ciphertext,
                encryption_iv: item1.iv,
                encryption_algorithm: item1.algorithm,
            },
            ItemData {
                id: "item-2".to_string(),
                encrypted_data: item2.ciphertext,
                encryption_iv: item2.iv,
                encryption_algorithm: item2.algorithm,
            },
        ];

        let members = vec![
            MemberKeyData {
                user_id: "owner-id".to_string(),
                public_key: owner_keys.public_key.clone(),
            },
            MemberKeyData {
                user_id: "member-id".to_string(),
                public_key: member_keys.public_key.clone(),
            },
        ];

        let result = perform_key_rotation(
            &old_vault_key,
            &members,
            &items,
            "vault-1",
            2,
            "owner-id",
            &muk,
        )
        .unwrap();

        // Should have encrypted keys for all members
        assert_eq!(result.member_encrypted_keys.len(), 2);

        // Should have re-encrypted all items
        assert_eq!(result.re_encrypted_items.len(), 2);

        // Owner's key should be AES-GCM encrypted (JSON format)
        let owner_key_entry = result
            .member_encrypted_keys
            .iter()
            .find(|k| k.user_id == "owner-id")
            .unwrap();
        let owner_decrypted = decrypt_vault_key_with_muk(
            &owner_key_entry.encrypted_vault_key,
            &muk,
            &VaultKeyWrapContext::new("vault-1", "owner-id", 2),
        )
        .unwrap();

        // Member's key should be RSA encrypted
        let member_key_entry = result
            .member_encrypted_keys
            .iter()
            .find(|k| k.user_id == "member-id")
            .unwrap();
        let member_decrypted = rsa_decrypt(
            &member_key_entry.encrypted_vault_key,
            &member_keys.private_key,
        )
        .unwrap();
        let member_key_bytes = BASE64.decode(member_decrypted.as_bytes()).unwrap();
        assert_eq!(member_key_bytes, owner_decrypted);
    }

    #[test]
    fn test_validate_rotation_data() {
        // Valid data
        let valid_members = vec![MemberKeyData {
            user_id: "user1".to_string(),
            public_key: "-----BEGIN PUBLIC KEY-----\nMIIB...\n-----END PUBLIC KEY-----".to_string(),
        }];
        let valid_result = validate_rotation_data(&valid_members);
        assert!(valid_result.valid);
        assert!(valid_result.errors.is_empty());

        // Missing public key
        let invalid_members = vec![MemberKeyData {
            user_id: "user2".to_string(),
            public_key: "".to_string(),
        }];
        let invalid_result = validate_rotation_data(&invalid_members);
        assert!(!invalid_result.valid);
        assert!(!invalid_result.errors.is_empty());

        // Invalid format
        let bad_format = vec![MemberKeyData {
            user_id: "user3".to_string(),
            public_key: "not-a-valid-key".to_string(),
        }];
        let bad_result = validate_rotation_data(&bad_format);
        assert!(!bad_result.valid);
    }
}
