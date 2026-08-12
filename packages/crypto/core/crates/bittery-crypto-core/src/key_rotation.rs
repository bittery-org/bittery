//! Key Rotation Utilities
//!
//! Handles vault key rotation for secure access revocation.
//! When a member is removed from a vault, all data must be re-encrypted
//! with a new key to ensure the removed member cannot decrypt future data.

use crate::encryption::{
    decrypt_with_aad, encrypt_with_aad, generate_encryption_key, AadContext, EncryptedData,
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
    /// The context this item's ciphertext is bound to, and that its replacement is re-bound to
    pub context: AadContext,
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

/// Re-encrypt an item with a new vault key under the same authenticated context.
///
/// # Arguments
/// * `item` - Item data to re-encrypt, including the context its ciphertext is bound to
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
    let old_encrypted_data = EncryptedData {
        ciphertext: item.encrypted_data.clone(),
        iv: item.encryption_iv.clone(),
        algorithm: item.encryption_algorithm.clone(),
    };

    let mut decrypted_data = decrypt_with_aad(&old_encrypted_data, old_vault_key, &item.context)?;
    let re_encrypted = encrypt_with_aad(&decrypted_data, new_vault_key, &item.context);
    let new_encrypted_data = match re_encrypted {
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

/// Rewrap an Attachment key under a rotated Vault key without exposing the Attachment key or
/// touching its encrypted object-storage bytes. The caller supplies the persisted envelope's
/// old and new contexts: the Vault, Attachment and owner stay fixed while the envelope version
/// advances. Changing any other context field makes this fail.
pub fn rewrap_attachment_key(
    encrypted_attachment_key: &EncryptedData,
    old_vault_key: &[u8],
    new_vault_key: &[u8],
    old_context: &AadContext,
    new_context: &AadContext,
) -> Result<EncryptedData, CryptoError> {
    let mut encoded_attachment_key =
        decrypt_with_aad(encrypted_attachment_key, old_vault_key, old_context)?;
    let mut attachment_key = BASE64
        .decode(encoded_attachment_key.as_bytes())
        .map_err(|error| CryptoError::Base64Decode(error.to_string()))?;
    encoded_attachment_key.zeroize();

    if attachment_key.len() != 32 {
        attachment_key.zeroize();
        return Err(CryptoError::InvalidKeyLength {
            expected: 32,
            actual: attachment_key.len(),
        });
    }

    let mut encoded_for_new_envelope = BASE64.encode(&attachment_key);
    attachment_key.zeroize();
    let result = encrypt_with_aad(&encoded_for_new_envelope, new_vault_key, new_context);
    encoded_for_new_envelope.zeroize();
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::encryption::decrypt;
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

    fn item_context(item_id: &str) -> AadContext {
        AadContext {
            vault_id: "vault-1".to_string(),
            entity_id: item_id.to_string(),
            entity_type: "item".to_string(),
            version: 4,
            user_id: "user-1".to_string(),
        }
    }

    #[test]
    fn test_re_encrypt_item_keeps_an_aad_bound_item_bound() {
        let old_key = generate_new_vault_key();
        let new_key = generate_new_vault_key();
        let context = item_context("test-item-1");

        let original_data = "Secret item data";
        let encrypted = encrypt_with_aad(original_data, &old_key, &context).unwrap();

        let item = ItemData {
            id: "test-item-1".to_string(),
            encrypted_data: encrypted.ciphertext,
            encryption_iv: encrypted.iv,
            encryption_algorithm: encrypted.algorithm,
            context: context.clone(),
        };

        let re_encrypted = re_encrypt_item(&item, &old_key, &new_key).unwrap();

        let new_encrypted = EncryptedData {
            ciphertext: re_encrypted.encrypted_data,
            iv: re_encrypted.encryption_iv,
            algorithm: "AES-GCM-AAD-V1".to_string(),
        };
        assert_eq!(
            decrypt_with_aad(&new_encrypted, &new_key, &context).unwrap(),
            original_data
        );
        // The binding survived: without it, and under a different context, it stays shut.
        assert!(decrypt(&new_encrypted, &new_key).is_err());
        assert!(decrypt_with_aad(&new_encrypted, &new_key, &item_context("other-item")).is_err());
    }

    /// Rotation re-binds a ciphertext to the *same* context it came in with. Any store that
    /// bumps the recorded encryption version or re-stamps the encrypting user alongside a
    /// rotation therefore describes a context the ciphertext was never sealed under, and the
    /// item can no longer be opened. This pins that the drift is fatal, not merely untidy.
    #[test]
    fn test_re_encrypt_item_is_unreadable_under_a_drifted_stored_context() {
        let old_key = generate_new_vault_key();
        let new_key = generate_new_vault_key();
        let context = item_context("item-1");

        let encrypted = encrypt_with_aad("Secret item data", &old_key, &context).unwrap();
        let item = ItemData {
            id: "item-1".to_string(),
            encrypted_data: encrypted.ciphertext,
            encryption_iv: encrypted.iv,
            encryption_algorithm: encrypted.algorithm,
            context: context.clone(),
        };

        let re_encrypted = re_encrypt_item(&item, &old_key, &new_key).unwrap();
        let rotated = EncryptedData {
            ciphertext: re_encrypted.encrypted_data,
            iv: re_encrypted.encryption_iv,
            algorithm: "AES-GCM-AAD-V1".to_string(),
        };

        // The context the caller supplied still opens it.
        assert_eq!(
            decrypt_with_aad(&rotated, &new_key, &context).unwrap(),
            "Secret item data"
        );

        // A store that recorded `version + 1` alongside the rotation has bricked the item.
        let bumped_version = AadContext {
            version: context.version + 1,
            ..context.clone()
        };
        assert!(decrypt_with_aad(&rotated, &new_key, &bumped_version).is_err());

        // So has one that re-stamped the rotating admin as the encrypting user.
        let rotating_admin = AadContext {
            user_id: "admin-user".to_string(),
            ..context.clone()
        };
        assert!(decrypt_with_aad(&rotated, &new_key, &rotating_admin).is_err());

        // Both at once — exactly what a rotation-apply UPDATE that touches both columns writes.
        let both = AadContext {
            version: context.version + 1,
            user_id: "admin-user".to_string(),
            ..context
        };
        assert!(decrypt_with_aad(&rotated, &new_key, &both).is_err());
    }

    #[test]
    fn test_re_encrypt_item_rejects_a_mismatched_context() {
        let old_key = generate_new_vault_key();
        let new_key = generate_new_vault_key();

        let encrypted =
            encrypt_with_aad("Secret item data", &old_key, &item_context("item-1")).unwrap();
        let item = ItemData {
            id: "item-1".to_string(),
            encrypted_data: encrypted.ciphertext,
            encryption_iv: encrypted.iv,
            encryption_algorithm: encrypted.algorithm,
            context: item_context("item-2"),
        };

        assert!(re_encrypt_item(&item, &old_key, &new_key).is_err());
    }

    #[test]
    fn test_rewrap_attachment_key_keeps_its_exact_context() {
        let old_vault_key = generate_new_vault_key();
        let new_vault_key = generate_new_vault_key();
        let attachment_key = generate_new_vault_key();
        let context = AadContext {
            vault_id: "vault-1".to_string(),
            entity_id: "attachment-1".to_string(),
            entity_type: "attachment_key".to_string(),
            version: 2,
            user_id: "user-1".to_string(),
        };
        let original =
            encrypt_with_aad(&BASE64.encode(attachment_key), &old_vault_key, &context).unwrap();

        let next_context = AadContext {
            version: context.version + 1,
            ..context.clone()
        };
        let rewrapped = rewrap_attachment_key(
            &original,
            &old_vault_key,
            &new_vault_key,
            &context,
            &next_context,
        )
        .unwrap();

        assert_eq!(
            decrypt_with_aad(&rewrapped, &new_vault_key, &next_context).unwrap(),
            BASE64.encode(attachment_key)
        );
        assert!(decrypt_with_aad(&rewrapped, &old_vault_key, &next_context).is_err());
        assert!(decrypt_with_aad(
            &rewrapped,
            &new_vault_key,
            &AadContext {
                entity_id: "attachment-2".to_string(),
                ..next_context
            },
        )
        .is_err());
    }
}
