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
static VAULT_ENTRY: LazyLock<Mutex<Option<Entry>>> = LazyLock::new(|| Mutex::new(None));

fn with_vault_entry<T>(
    operation: impl FnOnce(&Entry) -> Result<T, keyring::Error>,
) -> Result<Result<T, keyring::Error>, String> {
    let mut stored_entry = VAULT_ENTRY
        .lock()
        .map_err(|e| format!("Vault keychain entry lock poisoned: {}", e))?;
    if stored_entry.is_none() {
        *stored_entry = Some(
            Entry::new(SERVICE, VAULT_KEY)
                .map_err(|e| format!("Failed to create vault keychain entry: {}", e))?,
        );
    }

    Ok(operation(stored_entry.as_ref().unwrap()))
}

fn read_vault_entry() -> Result<HashMap<String, String>, String> {
    match with_vault_entry(Entry::get_password)? {
        Ok(json) => serde_json::from_str(&json).map_err(|error| {
            eprintln!("[keychain] Failed to deserialize vault: {}", error);
            format!("Failed to deserialize vault from keychain: {}", error)
        }),
        Err(keyring::Error::NoEntry) => Ok(HashMap::new()),
        Err(error) => Err(format!("Failed to read vault from keychain: {}", error)),
    }
}

/// Load the vault from cache or keychain. Returns a clone of the current data.
fn load_vault() -> Result<HashMap<String, String>, String> {
    let mut cache = VAULT_CACHE
        .lock()
        .map_err(|e| format!("Vault cache lock poisoned: {}", e))?;

    if let Some(ref data) = *cache {
        return Ok(data.clone());
    }

    let data = read_vault_entry()?;

    *cache = Some(data.clone());
    Ok(data)
}

/// Persist the vault HashMap to the single keychain entry.
fn save_vault(data: &HashMap<String, String>) -> Result<(), String> {
    let json =
        serde_json::to_string(data).map_err(|e| format!("Failed to serialize vault: {}", e))?;

    with_vault_entry(|entry| entry.set_password(&json))?
        .map_err(|e| format!("Failed to store vault in keychain: {}", e))?;

    Ok(())
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
            let loaded = read_vault_entry()?;
            *cache = Some(loaded);
            cache.as_mut().unwrap()
        }
    };

    data.insert(key.to_string(), value.to_string());
    save_vault(data)?;

    Ok(())
}

/// Retrieve a value from the OS keychain (from the single vault blob)
#[tauri::command]
pub fn keychain_get(key: &str) -> Result<Option<String>, String> {
    Ok(load_vault()?.get(key).cloned())
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
            let loaded = read_vault_entry()?;
            *cache = Some(loaded);
            cache.as_mut().unwrap()
        }
    };

    let removed = data.remove(key).is_some();

    if removed {
        save_vault(data)?;
    }

    Ok(removed)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{MutexGuard, Once};

    static INSTALL_MOCK_KEYRING: Once = Once::new();
    static TEST_LOCK: Mutex<()> = Mutex::new(());

    fn setup() -> MutexGuard<'static, ()> {
        let guard = TEST_LOCK.lock().unwrap_or_else(|error| error.into_inner());
        INSTALL_MOCK_KEYRING.call_once(|| {
            keyring::set_default_credential_builder(keyring::mock::default_credential_builder());
        });
        let _ = with_vault_entry(Entry::delete_credential);
        reset_cache();
        guard
    }

    /// Reset the in-memory cache between tests
    fn reset_cache() {
        let mut cache = VAULT_CACHE.lock().unwrap();
        *cache = None;
    }

    #[test]
    fn test_keychain_roundtrip() {
        let _guard = setup();

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
        let _guard = setup();

        let _ = keychain_delete("key_a");
        let _ = keychain_delete("key_b");
        reset_cache();

        keychain_set("key_a", "value_a").unwrap();
        keychain_set("key_b", "value_b").unwrap();

        assert_eq!(keychain_get("key_a").unwrap(), Some("value_a".to_string()));
        assert_eq!(keychain_get("key_b").unwrap(), Some("value_b".to_string()));

        // Deleting one key should not affect the other
        keychain_delete("key_a").unwrap();
        assert!(keychain_get("key_a").unwrap().is_none());
        assert_eq!(keychain_get("key_b").unwrap(), Some("value_b".to_string()));

        // Cleanup
        let _ = keychain_delete("key_b");
    }

    #[test]
    fn test_cache_survives_across_calls() {
        let _guard = setup();

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

    #[test]
    fn corrupt_vault_is_reported_and_not_overwritten() {
        let _guard = setup();
        let corrupt_payload = "{truncated";
        with_vault_entry(|entry| entry.set_password(corrupt_payload))
            .unwrap()
            .unwrap();

        let error = keychain_set("new_key", "new_value").unwrap_err();

        assert!(error.contains("deserialize"));
        assert_eq!(
            with_vault_entry(Entry::get_password).unwrap().unwrap(),
            corrupt_payload
        );
    }
}
