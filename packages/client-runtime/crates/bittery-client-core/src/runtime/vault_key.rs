//! Existing Vault wrappers opened under one live Account key lifetime.

use crate::{replica::AuthorityVaultRecord, RuntimeError, RuntimeErrorCode};
use bittery_crypto_core::{
    decrypt_rsa_wrapped_key, decrypt_vault_key_with_muk, EncryptedData, WrappedVaultKeyData,
};
use zeroize::Zeroizing;

pub(super) struct VaultKeyMaterial {
    pub(super) master_unlock_key: Zeroizing<[u8; 32]>,
    pub(super) encrypted_private_key: Option<String>,
}

impl std::ops::Deref for VaultKeyMaterial {
    type Target = [u8; 32];
    fn deref(&self) -> &Self::Target {
        &self.master_unlock_key
    }
}

/// RSA member wrappers are bare base64; owner wrappers are JSON with authenticated context.
/// The caller already holds current verified Vault authority for this Account incarnation.
pub(super) fn unwrap_vault_key(
    vault: &AuthorityVaultRecord,
    user_id: &str,
    material: &VaultKeyMaterial,
) -> Result<Vec<u8>, RuntimeError> {
    if vault.encrypted_vault_key.trim_start().starts_with('{') {
        let wrapped: WrappedVaultKeyData = serde_json::from_str(&vault.encrypted_vault_key)
            .map_err(|_| invalid("wrapped Vault key is invalid"))?;
        if wrapped.context.vault_id != vault.id || wrapped.context.user_id != user_id {
            return Err(invalid("wrapped Vault key context does not match"));
        }
        return decrypt_vault_key_with_muk(
            &vault.encrypted_vault_key,
            &*material.master_unlock_key,
            &wrapped.context,
        )
        .map_err(|_| unavailable());
    }
    let encrypted_private_key: EncryptedData = serde_json::from_str(
        material
            .encrypted_private_key
            .as_deref()
            .ok_or_else(unavailable)?,
    )
    .map_err(|_| unavailable())?;
    decrypt_rsa_wrapped_key(
        &vault.encrypted_vault_key,
        &encrypted_private_key,
        &*material.master_unlock_key,
        None,
    )
    .map_err(|_| unavailable())
}

fn invalid(message: &str) -> RuntimeError {
    RuntimeError::new(RuntimeErrorCode::InvariantViolation, message)
}

fn unavailable() -> RuntimeError {
    RuntimeError::new(
        RuntimeErrorCode::AuthenticationRequired,
        "Vault key could not be unwrapped",
    )
}
