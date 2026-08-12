use serde::Deserialize;

use crate::{
    error::AppError,
    shapes::{
        rotation_member_key_shape, rotation_reencrypted_item_shape, vault_key_rotation_shape,
    },
};

pub(crate) const ENCRYPTED_VAULT_KEY_MAX_BYTES: usize = 64 * 1024;

rotation_member_key_shape!(service_struct {
    #[derive(Debug, Clone, Deserialize)]
    #[serde(rename_all = "camelCase")]
    #[serde(deny_unknown_fields)]
    pub struct RotationMemberKeyInput
});

rotation_reencrypted_item_shape!(service_struct {
    #[derive(Debug, Clone, Deserialize)]
    #[serde(rename_all = "camelCase")]
    #[serde(deny_unknown_fields)]
    pub struct RotationReEncryptedItemInput
});

vault_key_rotation_shape!(service_struct {
    /// Rotating a vault key is one ceremony whether it is reached by removing a vault member or
    /// by a member leaving the team, so both flows take this input rather than declaring it twice.
    #[derive(Debug, Clone, Deserialize)]
    #[serde(rename_all = "camelCase")]
    #[serde(deny_unknown_fields)]
    pub struct VaultKeyRotationInput
}, member = RotationMemberKeyInput, item = RotationReEncryptedItemInput);

pub(crate) fn validate_encrypted_vault_key(value: &str) -> Result<(), AppError> {
    if value.trim().is_empty() || value.len() > ENCRYPTED_VAULT_KEY_MAX_BYTES {
        return Err(AppError::bad_request("Invalid encrypted vault key"));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encrypted_vault_key_limit_is_byte_based_and_inclusive() {
        assert!(validate_encrypted_vault_key(&"k".repeat(ENCRYPTED_VAULT_KEY_MAX_BYTES)).is_ok());
        assert!(
            validate_encrypted_vault_key(&"k".repeat(ENCRYPTED_VAULT_KEY_MAX_BYTES + 1)).is_err()
        );
        assert!(validate_encrypted_vault_key("   ").is_err());
    }
}
