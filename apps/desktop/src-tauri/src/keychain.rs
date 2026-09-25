//! OS Keychain access for secure storage of sensitive data
//!
//! All key-value pairs are stored as a single JSON blob under one keychain entry
//! (`bittery_vault`). This means only **one** OS keychain prompt is needed per
//! app session (or after a binary signature change), instead of one prompt per
//! individual key.
//!
//! The shared owner's in-memory cache avoids redundant keychain reads after the
//! first load. Writes are write-through: the cache and the keychain entry are
//! always updated together.
//!
//! Uses the `keyring` crate for platform-specific secure storage:
//! - macOS: Keychain
//! - Windows: Credential Manager
//! - Linux: kernel keyring (keyutils)

use std::collections::{HashMap, HashSet};
use std::hash::{Hash, Hasher};
use std::sync::{Arc, LazyLock, Mutex};

use bittery_client_core::{PlatformStorageDeleteResult, SecretString};
use keyring::Entry;
use serde::{
    de::{MapAccess, SeqAccess, Visitor},
    Deserialize,
};
use serde_json::value::RawValue;
use zeroize::Zeroizing;

use crate::tauri_api::{KeychainDeleteArgs, KeychainGetArgs, KeychainSetArgs};

/// Service identifier for Bittery in the OS keychain
const SERVICE: &str = "com.bittery.desktop";

/// Single keychain entry that holds all key-value pairs as JSON.
const VAULT_KEY: &str = "bittery_vault";

/// The existing entry and its write-through cache share one owner.
/// A missing cached map means that this owner has not loaded the entry yet.
pub(crate) struct KeychainVault {
    entry: Mutex<Option<Entry>>,
    cache: Mutex<Option<HashMap<String, String>>>,
    namespace_identity: String,
}

static DEFAULT_VAULT: LazyLock<Arc<KeychainVault>> = LazyLock::new(|| {
    Arc::new(KeychainVault {
        entry: Mutex::new(None),
        cache: Mutex::new(None),
        namespace_identity: format!("desktop-keyring-v1:{SERVICE}:{VAULT_KEY}"),
    })
});

pub(crate) fn default_vault() -> Arc<KeychainVault> {
    Arc::clone(&DEFAULT_VAULT)
}

struct FreshKeys<'a>(&'a mut dyn FnMut(&str));

pub(crate) enum FreshSourceDeleteResult {
    Deleted,
    AlreadyAbsent,
    Changed,
}

pub(crate) enum FreshSourceResetResult {
    Reset,
    AlreadyAbsent,
}

struct StrictSourceValue;

struct ZeroizingKey(Zeroizing<String>);

impl PartialEq for ZeroizingKey {
    fn eq(&self, other: &Self) -> bool {
        self.0.as_str() == other.0.as_str()
    }
}

impl Eq for ZeroizingKey {}

impl Hash for ZeroizingKey {
    fn hash<H: Hasher>(&self, state: &mut H) {
        self.0.as_str().hash(state);
    }
}

impl<'de> Deserialize<'de> for StrictSourceValue {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        struct StrictSourceValueVisitor;

        impl<'de> Visitor<'de> for StrictSourceValueVisitor {
            type Value = StrictSourceValue;

            fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                formatter.write_str("a structurally valid protected map value")
            }

            fn visit_str<E>(self, value: &str) -> Result<Self::Value, E>
            where
                E: serde::de::Error,
            {
                drop(Zeroizing::new(value.to_owned()));
                Ok(StrictSourceValue)
            }

            fn visit_string<E>(self, value: String) -> Result<Self::Value, E>
            where
                E: serde::de::Error,
            {
                drop(Zeroizing::new(value));
                Ok(StrictSourceValue)
            }

            fn visit_none<E>(self) -> Result<Self::Value, E>
            where
                E: serde::de::Error,
            {
                Ok(StrictSourceValue)
            }

            fn visit_unit<E>(self) -> Result<Self::Value, E>
            where
                E: serde::de::Error,
            {
                Ok(StrictSourceValue)
            }

            fn visit_bool<E>(self, _: bool) -> Result<Self::Value, E>
            where
                E: serde::de::Error,
            {
                Ok(StrictSourceValue)
            }

            fn visit_i64<E>(self, _: i64) -> Result<Self::Value, E>
            where
                E: serde::de::Error,
            {
                Ok(StrictSourceValue)
            }

            fn visit_u64<E>(self, _: u64) -> Result<Self::Value, E>
            where
                E: serde::de::Error,
            {
                Ok(StrictSourceValue)
            }

            fn visit_f64<E>(self, _: f64) -> Result<Self::Value, E>
            where
                E: serde::de::Error,
            {
                Ok(StrictSourceValue)
            }

            fn visit_seq<A>(self, mut sequence: A) -> Result<Self::Value, A::Error>
            where
                A: SeqAccess<'de>,
            {
                while sequence.next_element::<StrictSourceValue>()?.is_some() {}
                Ok(StrictSourceValue)
            }

            fn visit_map<A>(self, mut map: A) -> Result<Self::Value, A::Error>
            where
                A: MapAccess<'de>,
            {
                let mut seen = HashSet::new();
                while let Some(key) = map.next_key::<String>()? {
                    if !seen.insert(ZeroizingKey(Zeroizing::new(key))) {
                        return Err(serde::de::Error::custom("duplicate protected map key"));
                    }
                    map.next_value::<StrictSourceValue>()?;
                }
                Ok(StrictSourceValue)
            }
        }

        deserializer.deserialize_any(StrictSourceValueVisitor)
    }
}

struct FreshSourceMap;

impl<'de> Visitor<'de> for FreshSourceMap {
    type Value = Vec<(String, &'de RawValue)>;

    fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("a protected map with unique string keys")
    }

    fn visit_map<A>(self, mut map: A) -> Result<Self::Value, A::Error>
    where
        A: MapAccess<'de>,
    {
        let mut entries = Vec::new();
        let mut seen = HashSet::new();
        while let Some(key) = map.next_key::<String>()? {
            if !seen.insert(key.clone()) {
                return Err(serde::de::Error::custom("duplicate protected map key"));
            }
            let value = map.next_value::<&RawValue>()?;
            let mut decoder = serde_json::Deserializer::from_str(value.get());
            StrictSourceValue::deserialize(&mut decoder)
                .map_err(|_| serde::de::Error::custom("invalid protected map value"))?;
            decoder
                .end()
                .map_err(|_| serde::de::Error::custom("invalid protected map value"))?;
            entries.push((key, value));
        }
        Ok(entries)
    }
}

fn decode_fresh_source_map(raw: &str) -> Result<Vec<(String, &RawValue)>, String> {
    let mut decoder = serde_json::Deserializer::from_str(raw);
    let entries = serde::Deserializer::deserialize_map(&mut decoder, FreshSourceMap)
        .map_err(|_| "Invalid protected credential map".to_owned())?;
    decoder
        .end()
        .map_err(|_| "Invalid protected credential map".to_owned())?;
    Ok(entries)
}

fn is_legacy_source_credential(key: &str) -> bool {
    if key == "bittery_device_key" {
        return true;
    }
    let Some(account_ref) = key.strip_prefix("bittery_account_") else {
        return false;
    };
    [
        "_secret_key",
        "_session_data",
        "_jwt_token",
        "_vault_keys",
        "_encrypted_private_key",
    ]
    .into_iter()
    .any(|suffix| account_ref.ends_with(suffix))
}

impl<'de> Visitor<'de> for FreshKeys<'_> {
    type Value = ();

    fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("a protected map with unique string keys and string values")
    }

    fn visit_map<A>(self, mut map: A) -> Result<(), A::Error>
    where
        A: MapAccess<'de>,
    {
        let mut seen = HashSet::new();
        while let Some(key) = map.next_key::<String>()? {
            if !seen.insert(key.clone()) {
                return Err(serde::de::Error::custom("duplicate protected map key"));
            }
            // Decode one value into zeroizing ownership, then discard it before emitting its key.
            // A payload-bearing map would both retain secrets and collapse duplicate evidence.
            drop(map.next_value::<SecretString>()?);
            (self.0)(&key);
        }
        Ok(())
    }
}

impl KeychainVault {
    #[cfg(test)]
    pub(crate) fn from_entry(entry: Entry, namespace_identity: String) -> Self {
        Self {
            entry: Mutex::new(Some(entry)),
            cache: Mutex::new(None),
            namespace_identity,
        }
    }

    pub(crate) fn namespace_identity(&self) -> &str {
        &self.namespace_identity
    }

    /// Trusted profile capture reads the original protected blob without consulting or filling
    /// the ordinary cache. The caller retains zeroizing ownership and distinguishes actual absence.
    pub(crate) fn read_fresh_source(&self) -> Result<Option<Zeroizing<String>>, String> {
        let _cache = self
            .cache
            .lock()
            .map_err(|_| "Vault cache lock poisoned".to_owned())?;
        match self.with_vault_entry(Entry::get_password)? {
            Ok(raw) => Ok(Some(Zeroizing::new(raw))),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(_) => Err("Failed to read physical vault from keychain".into()),
        }
    }

    /// Remove one freshly read legacy string only when its exact evidence still matches.
    ///
    /// The cache lock serializes this physical compare-and-delete with every cooperating vault
    /// writer. Unrelated raw JSON values are copied byte-for-byte into the rewritten map after the
    /// complete map has passed strict structural validation. The ordinary string-map cache is
    /// invalidated because the legacy map may contain values it cannot represent.
    pub(crate) fn compare_delete_fresh_source_string(
        &self,
        key: &str,
        matches_expected: impl FnOnce(&str) -> Result<bool, String>,
    ) -> Result<FreshSourceDeleteResult, String> {
        let mut cache = self
            .cache
            .lock()
            .map_err(|_| "Vault cache lock poisoned".to_owned())?;
        let raw = match self.with_vault_entry(Entry::get_password)? {
            Ok(raw) => Zeroizing::new(raw),
            Err(keyring::Error::NoEntry) => {
                *cache = None;
                return Ok(FreshSourceDeleteResult::AlreadyAbsent);
            }
            Err(_) => {
                *cache = None;
                return Err("Failed to read physical vault from keychain".into());
            }
        };
        *cache = None;
        let entries = decode_fresh_source_map(&raw)?;
        let Some(selected_index) = entries.iter().position(|(candidate, _)| candidate == key)
        else {
            return Ok(FreshSourceDeleteResult::AlreadyAbsent);
        };
        let selected = match serde_json::from_str::<SecretString>(entries[selected_index].1.get()) {
            Ok(selected) => selected,
            Err(_) => return Ok(FreshSourceDeleteResult::Changed),
        };
        if !matches_expected(selected.as_ref())? {
            return Ok(FreshSourceDeleteResult::Changed);
        }

        let mut rewritten = Zeroizing::new(String::with_capacity(raw.len()));
        rewritten.push('{');
        let mut first = true;
        for (index, (entry_key, value)) in entries.iter().enumerate() {
            if index == selected_index {
                continue;
            }
            if !first {
                rewritten.push(',');
            }
            first = false;
            rewritten.push_str(
                &serde_json::to_string(entry_key)
                    .map_err(|_| "Failed to serialize protected credential key".to_owned())?,
            );
            rewritten.push(':');
            rewritten.push_str(value.get());
        }
        rewritten.push('}');
        self.with_vault_entry(|entry| entry.set_password(&rewritten))?
            .map_err(|_| "Failed to store physical vault in keychain".to_owned())?;

        // Do not acknowledge deletion until a fresh durable read proves exact absence. A lost
        // write/read reply remains safely retryable: the next attempt observes AlreadyAbsent.
        match self.with_vault_entry(Entry::get_password)? {
            Ok(post) => {
                let post = Zeroizing::new(post);
                if decode_fresh_source_map(&post)?
                    .iter()
                    .any(|(candidate, _)| candidate == key)
                {
                    return Err("Protected credential deletion was not durable".into());
                }
                if post.as_bytes() != rewritten.as_bytes() {
                    return Err("Protected credential preservation was not durable".into());
                }
            }
            Err(keyring::Error::NoEntry) if rewritten.as_str() == "{}" => {}
            Err(keyring::Error::NoEntry) => {
                return Err("Protected credential preservation was not durable".into());
            }
            Err(_) => return Err("Failed to verify physical vault deletion".into()),
        }
        Ok(FreshSourceDeleteResult::Deleted)
    }

    /// Explicit whole-profile reset removes every key in the fixed legacy selector plan while
    /// retaining Runtime and unrelated entries in their original raw representation.
    pub(crate) fn reset_legacy_source_credentials(&self) -> Result<FreshSourceResetResult, String> {
        let mut cache = self
            .cache
            .lock()
            .map_err(|_| "Vault cache lock poisoned".to_owned())?;
        let raw = match self.with_vault_entry(Entry::get_password)? {
            Ok(raw) => Zeroizing::new(raw),
            Err(keyring::Error::NoEntry) => {
                *cache = None;
                return Ok(FreshSourceResetResult::AlreadyAbsent);
            }
            Err(_) => {
                *cache = None;
                return Err("Failed to read physical vault from keychain".into());
            }
        };
        *cache = None;
        let entries = decode_fresh_source_map(&raw)?;
        if !entries
            .iter()
            .any(|(key, _)| is_legacy_source_credential(key))
        {
            return Ok(FreshSourceResetResult::AlreadyAbsent);
        }
        let mut rewritten = Zeroizing::new(String::with_capacity(raw.len()));
        rewritten.push('{');
        let mut first = true;
        for (key, value) in &entries {
            if is_legacy_source_credential(key) {
                continue;
            }
            if !first {
                rewritten.push(',');
            }
            first = false;
            rewritten.push_str(
                &serde_json::to_string(key)
                    .map_err(|_| "Failed to serialize protected credential key".to_owned())?,
            );
            rewritten.push(':');
            rewritten.push_str(value.get());
        }
        rewritten.push('}');
        self.with_vault_entry(|entry| entry.set_password(&rewritten))?
            .map_err(|_| "Failed to store physical vault in keychain".to_owned())?;
        match self.with_vault_entry(Entry::get_password)? {
            Ok(post) => {
                let post = Zeroizing::new(post);
                let post_entries = decode_fresh_source_map(&post)?;
                if post_entries
                    .iter()
                    .any(|(key, _)| is_legacy_source_credential(key))
                    || post.as_bytes() != rewritten.as_bytes()
                {
                    return Err("Legacy credential reset was not durable".into());
                }
            }
            Err(keyring::Error::NoEntry) if rewritten.as_str() == "{}" => {}
            Err(_) => return Err("Failed to verify legacy credential reset".into()),
        }
        Ok(FreshSourceResetResult::Reset)
    }

    /// Read the physical entry under the existing owner, without consulting or changing its cache.
    /// The legacy format requires one raw blob; only temporary key names and one decoded secret
    /// value at a time are retained while validating it. The callback never receives values.
    pub(crate) fn visit_fresh_keys(&self, visitor: &mut dyn FnMut(&str)) -> Result<(), String> {
        let _cache = self
            .cache
            .lock()
            .map_err(|_| "Vault cache lock poisoned".to_owned())?;
        let raw = match self.with_vault_entry(Entry::get_password)? {
            Ok(raw) => Zeroizing::new(raw),
            Err(keyring::Error::NoEntry) => return Ok(()),
            Err(_) => return Err("Failed to read physical vault from keychain".into()),
        };
        let mut decoder = serde_json::Deserializer::from_str(&raw);
        serde::Deserializer::deserialize_map(&mut decoder, FreshKeys(visitor))
            .map_err(|_| "Invalid protected credential map".to_owned())?;
        decoder
            .end()
            .map_err(|_| "Invalid protected credential map".to_owned())
    }

    fn with_vault_entry<T>(
        &self,
        operation: impl FnOnce(&Entry) -> Result<T, keyring::Error>,
    ) -> Result<Result<T, keyring::Error>, String> {
        let mut stored_entry = self
            .entry
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

    fn read_vault_entry(&self) -> Result<HashMap<String, String>, String> {
        match self.with_vault_entry(Entry::get_password)? {
            Ok(json) => serde_json::from_str(&json).map_err(|error| {
                eprintln!("[keychain] Failed to deserialize vault: {}", error);
                format!("Failed to deserialize vault from keychain: {}", error)
            }),
            Err(keyring::Error::NoEntry) => Ok(HashMap::new()),
            Err(error) => Err(format!("Failed to read vault from keychain: {}", error)),
        }
    }

    /// Load the vault from cache or keychain. Returns a clone of the current data.
    fn load_vault(&self) -> Result<HashMap<String, String>, String> {
        let mut cache = self
            .cache
            .lock()
            .map_err(|e| format!("Vault cache lock poisoned: {}", e))?;
        if let Some(ref data) = *cache {
            return Ok(data.clone());
        }
        let data = self.read_vault_entry()?;
        *cache = Some(data.clone());
        Ok(data)
    }

    /// Persist the vault HashMap to the single keychain entry.
    fn save_vault(&self, data: &HashMap<String, String>) -> Result<(), String> {
        let json =
            serde_json::to_string(data).map_err(|e| format!("Failed to serialize vault: {}", e))?;
        self.with_vault_entry(|entry| entry.set_password(&json))?
            .map_err(|e| format!("Failed to store vault in keychain: {}", e))?;
        Ok(())
    }

    /// Commit before publishing to cached reads, retaining the existing cache-to-entry lock order.
    fn mutate_vault(
        &self,
        mutate: impl FnOnce(&mut HashMap<String, String>) -> bool,
    ) -> Result<bool, String> {
        let mut cache = self
            .cache
            .lock()
            .map_err(|error| format!("Vault cache lock poisoned: {}", error))?;
        if cache.is_none() {
            *cache = Some(self.read_vault_entry()?);
        }
        let data = cache.as_mut().unwrap();
        let mut updated = data.clone();
        let changed = mutate(&mut updated);
        if changed {
            self.save_vault(&updated)?;
            *data = updated;
        }
        Ok(changed)
    }

    pub(crate) fn set_value(&self, key: &str, value: &str) -> Result<(), String> {
        self.mutate_vault(|data| {
            data.insert(key.to_owned(), value.to_owned());
            true
        })
        .map(|_| ())
    }

    pub(crate) fn get_value(&self, key: &str) -> Result<Option<String>, String> {
        Ok(self.load_vault()?.get(key).cloned())
    }

    pub(crate) fn delete_value(&self, key: &str) -> Result<bool, String> {
        self.mutate_vault(|data| data.remove(key).is_some())
    }

    /// Delete one ordinary protected value only when a fresh physical read still matches.
    /// Unrelated raw JSON values remain byte-for-byte unchanged in the rewritten map.
    pub(crate) fn compare_delete_value(
        &self,
        key: &str,
        expected_value: &str,
    ) -> Result<PlatformStorageDeleteResult, String> {
        let mut cache = self
            .cache
            .lock()
            .map_err(|_| "Vault cache lock poisoned".to_owned())?;
        let raw = match self.with_vault_entry(Entry::get_password)? {
            Ok(raw) => Zeroizing::new(raw),
            Err(keyring::Error::NoEntry) => {
                *cache = None;
                return Ok(PlatformStorageDeleteResult::AlreadyAbsent);
            }
            Err(_) => {
                *cache = None;
                return Err("Failed to read physical vault from keychain".into());
            }
        };
        *cache = None;
        let entries = decode_fresh_source_map(&raw)?;
        let mut selected_index = None;
        let mut selected_matches = false;
        for (index, (candidate, value)) in entries.iter().enumerate() {
            let value = serde_json::from_str::<SecretString>(value.get())
                .map_err(|_| "Invalid protected credential map".to_owned())?;
            if candidate == key {
                selected_index = Some(index);
                selected_matches = value.as_ref().as_bytes() == expected_value.as_bytes();
            }
        }
        let Some(selected_index) = selected_index else {
            return Ok(PlatformStorageDeleteResult::AlreadyAbsent);
        };
        if !selected_matches {
            return Ok(PlatformStorageDeleteResult::Conflict);
        }

        let mut rewritten = Zeroizing::new(String::with_capacity(raw.len()));
        rewritten.push('{');
        let mut first = true;
        for (index, (entry_key, value)) in entries.iter().enumerate() {
            if index == selected_index {
                continue;
            }
            if !first {
                rewritten.push(',');
            }
            first = false;
            rewritten.push_str(
                &serde_json::to_string(entry_key)
                    .map_err(|_| "Failed to serialize protected credential key".to_owned())?,
            );
            rewritten.push(':');
            rewritten.push_str(value.get());
        }
        rewritten.push('}');
        self.with_vault_entry(|entry| entry.set_password(&rewritten))?
            .map_err(|_| "Failed to store physical vault in keychain".to_owned())?;

        match self.with_vault_entry(Entry::get_password)? {
            Ok(post) => {
                let post = Zeroizing::new(post);
                let post_entries = decode_fresh_source_map(&post)?;
                for (candidate, value) in &post_entries {
                    drop(
                        serde_json::from_str::<SecretString>(value.get())
                            .map_err(|_| "Invalid protected credential map".to_owned())?,
                    );
                    if candidate == key {
                        return Err("Protected value deletion was not durable".into());
                    }
                }
                if post.as_bytes() != rewritten.as_bytes() {
                    return Err("Protected value preservation was not durable".into());
                }
            }
            Err(keyring::Error::NoEntry) if rewritten.as_str() == "{}" => {}
            Err(keyring::Error::NoEntry) => {
                return Err("Protected value preservation was not durable".into());
            }
            Err(_) => return Err("Failed to verify protected value deletion".into()),
        }
        Ok(PlatformStorageDeleteResult::Deleted)
    }

    /// Remove exactly one caller-supplied namespace in one durable keychain update.
    pub(crate) fn delete_prefix(&self, prefix: &str) -> Result<(), String> {
        self.delete_prefix_except(prefix, None)
    }

    /// Remove a namespace from the fresh physical map while retaining one exact key.
    pub(crate) fn delete_prefix_except(
        &self,
        prefix: &str,
        preserve_key: Option<&str>,
    ) -> Result<(), String> {
        if prefix.is_empty() {
            return Err("Keychain deletion prefix is empty".into());
        }
        let mut cache = self
            .cache
            .lock()
            .map_err(|_| "Vault cache lock poisoned".to_owned())?;
        let raw = match self.with_vault_entry(Entry::get_password)? {
            Ok(raw) => Zeroizing::new(raw),
            Err(keyring::Error::NoEntry) => {
                *cache = None;
                return Ok(());
            }
            Err(_) => {
                *cache = None;
                return Err("Failed to read physical vault from keychain".into());
            }
        };
        *cache = None;
        let entries = decode_fresh_source_map(&raw)?;
        // DeviceSecret is a string-valued namespace. A foreign value kind is not permission to
        // normalize or partially rewrite the shared physical map.
        for (_, value) in &entries {
            drop(
                serde_json::from_str::<SecretString>(value.get())
                    .map_err(|_| "Invalid protected credential map".to_owned())?,
            );
        }
        let deletes = |key: &str| key.starts_with(prefix) && preserve_key != Some(key);
        if !entries.iter().any(|(key, _)| deletes(key)) {
            return Ok(());
        }
        let mut rewritten = Zeroizing::new(String::with_capacity(raw.len()));
        rewritten.push('{');
        let mut first = true;
        for (key, value) in &entries {
            if deletes(key) {
                continue;
            }
            if !first {
                rewritten.push(',');
            }
            first = false;
            rewritten.push_str(
                &serde_json::to_string(key)
                    .map_err(|_| "Failed to serialize protected credential key".to_owned())?,
            );
            rewritten.push(':');
            rewritten.push_str(value.get());
        }
        rewritten.push('}');
        self.with_vault_entry(|entry| entry.set_password(&rewritten))?
            .map_err(|_| "Failed to store physical vault in keychain".to_owned())?;
        let post = match self.with_vault_entry(Entry::get_password)? {
            Ok(post) => Zeroizing::new(post),
            Err(keyring::Error::NoEntry) if rewritten.as_str() == "{}" => return Ok(()),
            Err(keyring::Error::NoEntry) => {
                return Err("Protected namespace preservation was not durable".into());
            }
            Err(_) => return Err("Failed to verify physical vault deletion".into()),
        };
        let post_entries = decode_fresh_source_map(&post)?;
        for (key, value) in &post_entries {
            drop(
                serde_json::from_str::<SecretString>(value.get())
                    .map_err(|_| "Invalid protected credential map".to_owned())?,
            );
            if deletes(key) {
                return Err("Protected namespace deletion was not durable".into());
            }
        }
        if post.as_bytes() != rewritten.as_bytes() {
            return Err("Protected namespace preservation was not durable".into());
        }
        Ok(())
    }
}

/// Store a value in the OS keychain (inside the single vault blob)
///
/// The three commands in this file are thin adapters: they name their arguments
/// through `tauri_api`, so the generated TypeScript and the parameters Tauri
/// actually binds cannot drift apart, and then hand off to the plain functions
/// below, which is what the tests exercise.
#[tauri::command]
pub fn keychain_set(key: String, value: String) -> Result<(), String> {
    let args = KeychainSetArgs { key, value };
    set_value(&args.key, &args.value)
}

/// Retrieve a value from the OS keychain (from the single vault blob)
#[tauri::command]
pub fn keychain_get(key: String) -> Result<Option<String>, String> {
    let args = KeychainGetArgs { key };
    get_value(&args.key)
}

/// Delete a value from the OS keychain (from the single vault blob)
#[tauri::command]
pub fn keychain_delete(key: String) -> Result<bool, String> {
    let args = KeychainDeleteArgs { key };
    delete_value(&args.key)
}

pub(crate) fn set_value(key: &str, value: &str) -> Result<(), String> {
    DEFAULT_VAULT.set_value(key, value)
}

pub(crate) fn get_value(key: &str) -> Result<Option<String>, String> {
    DEFAULT_VAULT.get_value(key)
}

pub(crate) fn delete_value(key: &str) -> Result<bool, String> {
    DEFAULT_VAULT.delete_value(key)
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
        let _ = DEFAULT_VAULT.with_vault_entry(Entry::delete_credential);
        reset_cache();
        guard
    }

    /// Reset the in-memory cache between tests
    fn reset_cache() {
        let mut cache = DEFAULT_VAULT.cache.lock().unwrap();
        *cache = None;
    }

    #[test]
    fn test_keychain_roundtrip() {
        let _guard = setup();

        let test_key = "bittery_test_key";
        let test_value = "test_secret_value_12345";

        // Clean up any existing entry
        let _ = delete_value(test_key);

        // Reset cache so we re-read from keychain
        reset_cache();

        // Test that key doesn't exist initially
        let result = get_value(test_key).unwrap();
        assert!(result.is_none());

        // Store the value
        set_value(test_key, test_value).unwrap();

        // Retrieve and verify
        let result = get_value(test_key).unwrap();
        assert_eq!(result, Some(test_value.to_string()));

        // Delete the entry
        let deleted = delete_value(test_key).unwrap();
        assert!(deleted);

        // Verify it's gone
        let result = get_value(test_key).unwrap();
        assert!(result.is_none());

        // Delete again should return false
        let deleted = delete_value(test_key).unwrap();
        assert!(!deleted);
    }

    #[test]
    fn test_multiple_keys_single_vault() {
        let _guard = setup();

        let _ = delete_value("key_a");
        let _ = delete_value("key_b");
        reset_cache();

        set_value("key_a", "value_a").unwrap();
        set_value("key_b", "value_b").unwrap();

        assert_eq!(get_value("key_a").unwrap(), Some("value_a".to_string()));
        assert_eq!(get_value("key_b").unwrap(), Some("value_b".to_string()));

        // Deleting one key should not affect the other
        delete_value("key_a").unwrap();
        assert!(get_value("key_a").unwrap().is_none());
        assert_eq!(get_value("key_b").unwrap(), Some("value_b".to_string()));

        // Cleanup
        let _ = delete_value("key_b");
    }

    #[test]
    fn test_cache_survives_across_calls() {
        let _guard = setup();

        let _ = delete_value("cache_test");
        reset_cache();

        set_value("cache_test", "cached_value").unwrap();

        // Multiple reads should all return from cache
        for _ in 0..5 {
            assert_eq!(
                get_value("cache_test").unwrap(),
                Some("cached_value".to_string())
            );
        }

        // Cleanup
        let _ = delete_value("cache_test");
    }

    #[test]
    fn corrupt_vault_is_reported_and_not_overwritten() {
        let _guard = setup();
        let corrupt_payload = "{truncated";
        DEFAULT_VAULT
            .with_vault_entry(|entry| entry.set_password(corrupt_payload))
            .unwrap()
            .unwrap();

        let error = set_value("new_key", "new_value").unwrap_err();

        assert!(error.contains("deserialize"));
        assert_eq!(
            DEFAULT_VAULT
                .with_vault_entry(Entry::get_password)
                .unwrap()
                .unwrap(),
            corrupt_payload
        );
    }

    #[test]
    fn failed_writes_leave_the_cached_and_durable_values_unchanged() {
        let _guard = setup();
        set_value("account", "original").unwrap();
        let fail_write = || {
            DEFAULT_VAULT
                .with_vault_entry(|entry| {
                    entry
                        .get_credential()
                        .downcast_ref::<keyring::mock::MockCredential>()
                        .unwrap()
                        .set_error(keyring::Error::NoEntry);
                    Ok(())
                })
                .unwrap()
                .unwrap();
        };
        fail_write();
        assert!(set_value("account", "replacement").is_err());
        assert_eq!(get_value("account").unwrap().as_deref(), Some("original"));
        fail_write();
        assert!(delete_value("account").is_err());
        assert_eq!(get_value("account").unwrap().as_deref(), Some("original"));
        reset_cache();
        assert_eq!(get_value("account").unwrap().as_deref(), Some("original"));
    }

    #[test]
    fn prefix_deletion_preserves_other_keys_and_reports_failed_persistence() {
        let _guard = setup();
        set_value("account:%_one", "first").unwrap();
        set_value("account:%_two", "second").unwrap();
        set_value("account:other", "other").unwrap();
        DEFAULT_VAULT
            .with_vault_entry(|entry| {
                entry
                    .get_credential()
                    .downcast_ref::<keyring::mock::MockCredential>()
                    .unwrap()
                    .set_error(keyring::Error::Invalid(
                        "mock".to_owned(),
                        "prefix deletion failure".to_owned(),
                    ));
                Ok(())
            })
            .unwrap()
            .unwrap();
        assert!(DEFAULT_VAULT.delete_prefix("account:%_").is_err());
        assert_eq!(
            get_value("account:%_one").unwrap().as_deref(),
            Some("first")
        );
        DEFAULT_VAULT.delete_prefix("account:%_").unwrap();
        reset_cache();
        assert_eq!(get_value("account:%_one").unwrap(), None);
        assert_eq!(get_value("account:%_two").unwrap(), None);
        assert_eq!(
            get_value("account:other").unwrap().as_deref(),
            Some("other")
        );
        assert!(DEFAULT_VAULT.delete_prefix("").is_err());
        DEFAULT_VAULT.delete_prefix("missing").unwrap();
    }

    #[test]
    fn prefix_deletion_reads_physical_map_and_preserves_one_exact_key() {
        let _guard = setup();
        set_value("runtime:cached", "stale").unwrap();
        let physical = r#"{"runtime:cached":"fresh","runtime:hidden":"delete","runtime:catalog":"retain","legacy":"untouched"}"#;
        DEFAULT_VAULT
            .with_vault_entry(|entry| entry.set_password(physical))
            .unwrap()
            .unwrap();

        DEFAULT_VAULT
            .delete_prefix_except("runtime:", Some("runtime:catalog"))
            .unwrap();

        let retained = DEFAULT_VAULT
            .with_vault_entry(Entry::get_password)
            .unwrap()
            .unwrap();
        assert_eq!(
            retained,
            r#"{"runtime:catalog":"retain","legacy":"untouched"}"#
        );
        assert_eq!(
            get_value("runtime:catalog").unwrap().as_deref(),
            Some("retain")
        );
        assert_eq!(get_value("runtime:hidden").unwrap(), None);

        let malformed = r#"{"runtime:hidden":"delete","legacy":{"unknown":true}}"#;
        DEFAULT_VAULT
            .with_vault_entry(|entry| entry.set_password(malformed))
            .unwrap()
            .unwrap();
        assert!(DEFAULT_VAULT.delete_prefix("runtime:").is_err());
        assert_eq!(
            DEFAULT_VAULT
                .with_vault_entry(Entry::get_password)
                .unwrap()
                .unwrap(),
            malformed
        );
    }

    #[test]
    fn guarded_value_deletion_reads_fresh_bytes_and_preserves_unrelated_raw_values() {
        let _guard = setup();
        set_value("runtime:target", "cached-stale").unwrap();
        let physical = r#"{"runtime:target":"fresh\u002dvalue","unrelated":"preserve\u002draw"}"#;
        DEFAULT_VAULT
            .with_vault_entry(|entry| entry.set_password(physical))
            .unwrap()
            .unwrap();

        assert_eq!(
            DEFAULT_VAULT
                .compare_delete_value("runtime:target", "cached-stale")
                .unwrap(),
            PlatformStorageDeleteResult::Conflict
        );
        assert_eq!(
            DEFAULT_VAULT
                .with_vault_entry(Entry::get_password)
                .unwrap()
                .unwrap(),
            physical
        );
        assert_eq!(
            DEFAULT_VAULT
                .compare_delete_value("runtime:target", "fresh-value")
                .unwrap(),
            PlatformStorageDeleteResult::Deleted
        );
        assert_eq!(
            DEFAULT_VAULT
                .with_vault_entry(Entry::get_password)
                .unwrap()
                .unwrap(),
            r#"{"unrelated":"preserve\u002draw"}"#
        );
        assert_eq!(
            DEFAULT_VAULT
                .compare_delete_value("runtime:target", "fresh-value")
                .unwrap(),
            PlatformStorageDeleteResult::AlreadyAbsent
        );

        let malformed = r#"{"runtime:target":"fresh-value","unrelated":{"nested":"secret"}}"#;
        DEFAULT_VAULT
            .with_vault_entry(|entry| entry.set_password(malformed))
            .unwrap()
            .unwrap();
        assert!(DEFAULT_VAULT
            .compare_delete_value("runtime:target", "changed")
            .is_err());
        assert!(DEFAULT_VAULT
            .compare_delete_value("runtime:target", "fresh-value")
            .is_err());
        assert_eq!(
            DEFAULT_VAULT
                .with_vault_entry(Entry::get_password)
                .unwrap()
                .unwrap(),
            malformed
        );
    }
}
