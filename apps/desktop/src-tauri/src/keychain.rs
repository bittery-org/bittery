//! OS Keychain access for secure storage of sensitive data
//!
//! All key-value pairs are stored as a single JSON blob under one keychain entry
//! (`bittery_vault`). This means only **one** OS keychain prompt is needed per
//! app session (or after a binary signature change), instead of one prompt per
//! individual key.
//!
//! An in-memory cache (`VAULT_CACHE`) avoids redundant keychain reads after the
//! first load. Writes are write-through: the cache and the keychain entry are
//! always updated together.
//!
//! Uses the `keyring` crate for platform-specific secure storage:
//! - macOS: Keychain
//! - Windows: Credential Manager
//! - Linux: Secret Service (via libsecret/GNOME Keyring)

use std::collections::HashMap;
use std::sync::{LazyLock, Mutex};

use keyring::Entry;

/// Service identifier for Bittery in the OS keychain
const SERVICE: &str = "com.bittery.desktop";

/// Single keychain entry that holds all key-value pairs as JSON.
const VAULT_KEY: &str = "bittery_vault";

/// In-memory cache of the vault contents.
/// `None` means the vault hasn't been loaded from the keychain yet.
static VAULT_CACHE: LazyLock<Mutex<Option<HashMap<String, String>>>> =
    LazyLock::new(|| Mutex::new(None));

/// Load the vault from cache or keychain. Returns a clone of the current data.
fn load_vault() -> Result<HashMap<String, String>, String> {
    let mut cache = VAULT_CACHE
        .lock()
        .map_err(|e| format!("Vault cache lock poisoned: {}", e))?;

    if let Some(ref data) = *cache {
        return Ok(data.clone());
    }

    // First access this session — read the single keychain entry
    let entry = Entry::new(SERVICE, VAULT_KEY)
        .map_err(|e| format!("Failed to create vault keychain entry: {}", e))?;

    let data: HashMap<String, String> = match entry.get_password() {
        Ok(json) => serde_json::from_str(&json).unwrap_or_default(),
        Err(keyring::Error::NoEntry) => HashMap::new(),
        Err(e) => return Err(format!("Failed to read vault from keychain: {}", e)),
    };

    *cache = Some(data.clone());
    Ok(data)
}

/// Persist the vault HashMap to the single keychain entry.
fn save_vault(data: &HashMap<String, String>) -> Result<(), String> {
    let json =
        serde_json::to_string(data).map_err(|e| format!("Failed to serialize vault: {}", e))?;

    let entry = Entry::new(SERVICE, VAULT_KEY)
        .map_err(|e| format!("Failed to create vault keychain entry: {}", e))?;

    entry
        .set_password(&json)
        .map_err(|e| format!("Failed to store vault in keychain: {}", e))?;

    Ok(())
}

/// Try to migrate a key from a legacy individual keychain entry into the vault.
/// Returns the value if migration succeeded, `None` otherwise.
fn migrate_legacy_key(key: &str) -> Option<String> {
    let legacy_entry = match Entry::new(SERVICE, key) {
        Ok(e) => e,
        Err(_) => return None,
    };

    let value = match legacy_entry.get_password() {
        Ok(v) => v,
        Err(_) => return None,
    };

    // Best-effort delete of the old individual entry
    let _ = legacy_entry.delete_credential();

    Some(value)
}

/// Store a value in the OS keychain (inside the single vault blob)
#[tauri::command]
pub fn keychain_set(key: &str, value: &str) -> Result<(), String> {
    let mut cache = VAULT_CACHE
        .lock()
        .map_err(|e| format!("Vault cache lock poisoned: {}", e))?;

    // Ensure vault is loaded
    let data = match cache.as_mut() {
        Some(d) => d,
        None => {
            // Load from keychain first
            let loaded = {
                let entry = Entry::new(SERVICE, VAULT_KEY)
                    .map_err(|e| format!("Failed to create vault keychain entry: {}", e))?;
                match entry.get_password() {
                    Ok(json) => serde_json::from_str(&json).unwrap_or_default(),
                    Err(keyring::Error::NoEntry) => HashMap::new(),
                    Err(e) => return Err(format!("Failed to read vault from keychain: {}", e)),
                }
            };
            *cache = Some(loaded);
            cache.as_mut().unwrap()
        }
    };

    data.insert(key.to_string(), value.to_string());
    save_vault(data)?;

    Ok(())
}

/// Retrieve a value from the OS keychain (from the single vault blob)
///
/// On cache miss for a specific key, attempts lazy migration from a legacy
/// individual keychain entry.
#[tauri::command]
pub fn keychain_get(key: &str) -> Result<Option<String>, String> {
    let mut vault = load_vault()?;

    if let Some(value) = vault.get(key) {
        return Ok(Some(value.clone()));
    }

    // Key not in vault — try migrating from a legacy individual entry
    if let Some(value) = migrate_legacy_key(key) {
        // Store in vault for future reads
        vault.insert(key.to_string(), value.clone());

        // Update cache
        let mut cache = VAULT_CACHE
            .lock()
            .map_err(|e| format!("Vault cache lock poisoned: {}", e))?;
        *cache = Some(vault.clone());

        // Persist vault with the migrated key
        save_vault(&vault)?;

        return Ok(Some(value));
    }

    Ok(None)
}

/// Delete a value from the OS keychain (from the single vault blob)
#[tauri::command]
pub fn keychain_delete(key: &str) -> Result<bool, String> {
    let mut cache = VAULT_CACHE
        .lock()
        .map_err(|e| format!("Vault cache lock poisoned: {}", e))?;

    // Ensure vault is loaded
    let data = match cache.as_mut() {
        Some(d) => d,
        None => {
            let loaded = {
                let entry = Entry::new(SERVICE, VAULT_KEY)
                    .map_err(|e| format!("Failed to create vault keychain entry: {}", e))?;
                match entry.get_password() {
                    Ok(json) => serde_json::from_str(&json).unwrap_or_default(),
                    Err(keyring::Error::NoEntry) => HashMap::new(),
                    Err(e) => return Err(format!("Failed to read vault from keychain: {}", e)),
                }
            };
            *cache = Some(loaded);
            cache.as_mut().unwrap()
        }
    };

    let removed = data.remove(key).is_some();

    if removed {
        save_vault(data)?;
    }

    // Also try to clean up any legacy individual entry for this key
    if let Ok(legacy_entry) = Entry::new(SERVICE, key) {
        let _ = legacy_entry.delete_credential();
    }

    Ok(removed)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Reset the in-memory cache between tests
    fn reset_cache() {
        let mut cache = VAULT_CACHE.lock().unwrap();
        *cache = None;
    }

    #[test]
    fn test_keychain_roundtrip() {
        reset_cache();

        let test_key = "bittery_test_key";
        let test_value = "test_secret_value_12345";

        // Clean up any existing entry
        let _ = keychain_delete(test_key);

        // Reset cache so we re-read from keychain
        reset_cache();

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

    #[test]
    fn test_multiple_keys_single_vault() {
        reset_cache();

        let _ = keychain_delete("key_a");
        let _ = keychain_delete("key_b");
        reset_cache();

        keychain_set("key_a", "value_a").unwrap();
        keychain_set("key_b", "value_b").unwrap();

        assert_eq!(
            keychain_get("key_a").unwrap(),
            Some("value_a".to_string())
        );
        assert_eq!(
            keychain_get("key_b").unwrap(),
            Some("value_b".to_string())
        );

        // Deleting one key should not affect the other
        keychain_delete("key_a").unwrap();
        assert!(keychain_get("key_a").unwrap().is_none());
        assert_eq!(
            keychain_get("key_b").unwrap(),
            Some("value_b".to_string())
        );

        // Cleanup
        let _ = keychain_delete("key_b");
    }

    #[test]
    fn test_cache_survives_across_calls() {
        reset_cache();

        let _ = keychain_delete("cache_test");
        reset_cache();

        keychain_set("cache_test", "cached_value").unwrap();

        // Multiple reads should all return from cache
        for _ in 0..5 {
            assert_eq!(
                keychain_get("cache_test").unwrap(),
                Some("cached_value".to_string())
            );
        }

        // Cleanup
        let _ = keychain_delete("cache_test");
    }
}
