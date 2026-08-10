use crate::error::AppError;

pub(crate) const ENCRYPTED_VAULT_KEY_MAX_BYTES: usize = 64 * 1024;

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
