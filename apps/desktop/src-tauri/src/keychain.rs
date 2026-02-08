//! OS Keychain access for secure storage of sensitive data
//!
//! Uses the `keyring` crate to store sensitive data in platform-specific secure storage:
//! - macOS: Keychain
//! - Windows: Credential Manager
//! - Linux: Secret Service (via libsecret/GNOME Keyring)

use keyring::Entry;

/// Service identifier for Bittery in the OS keychain
const SERVICE: &str = "com.bittery.desktop";

/// Store a value in the OS keychain
///
/// # Arguments
/// * `key` - The key name (will be combined with SERVICE as the "user" field)
/// * `value` - The value to store
#[tauri::command]
pub fn keychain_set(key: &str, value: &str) -> Result<(), String> {
    let entry = Entry::new(SERVICE, key)
        .map_err(|e| format!("Failed to create keychain entry: {}", e))?;

    entry
        .set_password(value)
        .map_err(|e| format!("Failed to store in keychain: {}", e))?;

    Ok(())
}

/// Retrieve a value from the OS keychain
///
/// # Arguments
/// * `key` - The key name to retrieve
///
/// # Returns
/// * `Ok(Some(value))` - The stored value
/// * `Ok(None)` - No value found for the key
/// * `Err(...)` - An error occurred
#[tauri::command]
pub fn keychain_get(key: &str) -> Result<Option<String>, String> {
    let entry = Entry::new(SERVICE, key)
        .map_err(|e| format!("Failed to create keychain entry: {}", e))?;

    match entry.get_password() {
        Ok(value) => Ok(Some(value)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(format!("Failed to retrieve from keychain: {}", e)),
    }
}

/// Delete a value from the OS keychain
///
/// # Arguments
/// * `key` - The key name to delete
///
/// # Returns
/// * `Ok(true)` - The entry was deleted
/// * `Ok(false)` - No entry existed with that key
/// * `Err(...)` - An error occurred
#[tauri::command]
pub fn keychain_delete(key: &str) -> Result<bool, String> {
    let entry = Entry::new(SERVICE, key)
        .map_err(|e| format!("Failed to create keychain entry: {}", e))?;

    match entry.delete_credential() {
        Ok(()) => Ok(true),
        Err(keyring::Error::NoEntry) => Ok(false),
        Err(e) => Err(format!("Failed to delete from keychain: {}", e)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_keychain_roundtrip() {
        let test_key = "bittery_test_key";
        let test_value = "test_secret_value_12345";

        // Clean up any existing entry
        let _ = keychain_delete(test_key);

        // Test that key doesn't exist initially
        let result = keychain_get(test_key).unwrap();
        assert!(result.is_none());

        // Store the value
        keychain_set(test_key, test_value).unwrap();

        // Retrieve and verify
        let result = keychain_get(test_key).unwrap();
        assert_eq!(result, Some(test_value.to_string()));

        // Delete the entry
        let deleted = keychain_delete(test_key).unwrap();
        assert!(deleted);

        // Verify it's gone
        let result = keychain_get(test_key).unwrap();
        assert!(result.is_none());

        // Delete again should return false
        let deleted = keychain_delete(test_key).unwrap();
        assert!(!deleted);
    }
}
