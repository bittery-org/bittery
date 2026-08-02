mod crypto_commands;
mod desktop_ipc;
mod ipc_security;
mod keychain;
mod native_messaging_installer;

use base64::Engine;
use desktop_ipc::{
    write_frame, AccountUnlockData, BiometricUnlockAllMaterial, BiometricUnlockMaterial,
    DesktopEnvelope, DesktopEventKind, DesktopRequest, DesktopResponse, DESKTOP_PROTOCOL_VERSION,
};
#[cfg(windows)]
use ipc_security::desktop_ipc_socket_path;
use std::sync::Arc;
use tauri::{Emitter, Manager, Runtime};
use tauri_plugin_store::Store;
use tokio::io::{AsyncRead, AsyncWrite};
use tokio::sync::broadcast;

#[derive(Debug, Clone)]
enum LockEvent {
    Lock {
        reason: String,
        timestamp: i64,
    },
    Unlock {
        accounts: Vec<String>,
        timestamp: i64,
    },
    DesktopClose {
        timestamp: i64,
    },
    ActiveAccountChanged {
        account_id: String,
        timestamp: i64,
    },
    ThemeChanged {
        theme: String,
        timestamp: i64,
    },
}

struct DesktopIpcState {
    lock_events: broadcast::Sender<LockEvent>,
}

impl Default for DesktopIpcState {
    fn default() -> Self {
        let (tx, _) = broadcast::channel(100);
        Self { lock_events: tx }
    }
}

const CONTEXT_ENVELOPE_MARKER: &str = "bittery-context-envelope-v1";
/// Persisted UI appearance preference ("light" | "dark" | "system"). Kept in
/// the Rust-side store so the native host can report it to the extension even
/// before the desktop frontend window has loaded (next-themes only writes the
/// value to the webview's localStorage, which Rust cannot read).
///
/// This key is Rust-owned: the TypeScript storage layer neither reads nor
/// writes it, which is why it is spelled out here rather than published in the
/// native-host view.
const UI_THEME_KEY: &str = "bittery_ui_theme";

fn read_store_string<R: Runtime>(store: &Store<R>, key: &str) -> Option<String> {
    store
        .get(key)
        .and_then(|value| value.as_str().map(|s| s.to_string()))
}

// The published native-host view
//
// `packages/storage/src/account-store.ts` writes one versioned projection of
// everything this process needs, as a JSON *string* under the plain store key
// below. Rust is an adapter of that published format: it never rebuilds a
// storage key, never decides which store a value lives in, and never defaults a
// value the app already resolved.

/// The plain `store.json` key holding the projection. It is `globalKey("native_view")`
/// on the TypeScript side; it is the single key this file may name itself,
/// because every other key it opens is read out of the document stored here.
const NATIVE_VIEW_KEY: &str = "bittery_native_view";

/// The only `NativeHostView.v` this build understands. A document carrying any
/// other version is refused, never partially interpreted: the writer is free to
/// change field meanings behind a bump, so guessing would be a correctness bug
/// with security consequences (`biometricEnabled` is an authorisation input).
const NATIVE_VIEW_VERSION: u64 = 2;

/// Which store a published key lives in. This exists so Rust never re-derives
/// the tier table: `Secret` is the OS keychain, `Plain` is `store.json`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
enum NativeKeyStore {
    Secret,
    Plain,
}

/// A key plus the store it lives in, exactly as published.
#[derive(Debug, Clone, serde::Deserialize)]
struct NativeKeyRef {
    key: String,
    store: NativeKeyStore,
}

/// One account's published entry.
#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct NativeAccountView {
    account_id: String,
    email: String,
    /// The displayable half of the account's metadata, republished by
    /// `AccountStore` so this process can hand it to the browser extension
    /// without reading `bittery_accounts_list` -- which would put a second copy
    /// of the key scheme back in this file.
    user_id: String,
    name: String,
    secret_key_hint: String,
    /// Optional upstream. Absent here means absent there; never substituted.
    #[serde(default)]
    team_name: Option<String>,
    #[serde(default)]
    team_avatar_url: Option<String>,
    added_at: i64,
    last_active_at: i64,
    /// Resolved by `AccountStore`; never defaulted here.
    biometric_enabled: bool,
    token: NativeKeyRef,
    session_data: NativeKeyRef,
    vault_keys: NativeKeyRef,
    encrypted_private_key: NativeKeyRef,
    /// Fully-resolved `store.json` key prefixes for this account's cached
    /// records -- one record per key. Prefix-scan them; never concatenate.
    items_key_prefix: String,
    vaults_key_prefix: String,
}

#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct NativeHostView {
    v: u64,
    active_account_id: Option<String>,
    unlocked_account_ids: Vec<String>,
    auto_lock_timeout_ms: i64,
    device_key: NativeKeyRef,
    accounts: Vec<NativeAccountView>,
}

impl NativeHostView {
    fn account(&self, account_id: &str) -> Option<&NativeAccountView> {
        self.accounts
            .iter()
            .find(|account| account.account_id == account_id)
    }

    fn is_unlocked(&self, account_id: &str) -> bool {
        self.unlocked_account_ids
            .iter()
            .any(|value| value == account_id)
    }
}

/// Why the published view could not be used. Both variants mean the same thing
/// operationally -- this process knows nothing about any account -- but they are
/// distinguished so the log says which happened.
#[derive(Debug, Clone, PartialEq, Eq)]
enum NativeViewProblem {
    /// Never written: the app has not initialised yet, or the store was reset.
    Absent,
    /// Written, but not in a shape or version this build understands.
    Unreadable(String),
}

impl NativeViewProblem {
    fn message(&self) -> String {
        match self {
            Self::Absent => format!(
                "No {} published yet -- the desktop app has not initialised its storage",
                NATIVE_VIEW_KEY
            ),
            Self::Unreadable(detail) => {
                format!("Could not read {}: {}", NATIVE_VIEW_KEY, detail)
            }
        }
    }
}

/// The version field, read on its own so an unknown version is refused before
/// any other field is interpreted.
#[derive(serde::Deserialize)]
struct NativeViewVersionProbe {
    v: u64,
}

/// Parse the published document. Pure, so it is unit-testable without a Store.
///
/// No `unwrap()` anywhere on this path: the document is external input.
fn parse_native_view(raw: Option<String>) -> Result<NativeHostView, NativeViewProblem> {
    let Some(raw) = raw else {
        return Err(NativeViewProblem::Absent);
    };

    let probe: NativeViewVersionProbe = serde_json::from_str(&raw)
        .map_err(|error| NativeViewProblem::Unreadable(format!("invalid JSON: {}", error)))?;

    if probe.v != NATIVE_VIEW_VERSION {
        return Err(NativeViewProblem::Unreadable(format!(
            "unsupported schema version {} (this build understands {})",
            probe.v, NATIVE_VIEW_VERSION
        )));
    }

    let view: NativeHostView = serde_json::from_str(&raw)
        .map_err(|error| NativeViewProblem::Unreadable(format!("unexpected shape: {}", error)))?;

    // The probe and the document must agree; they are two reads of the same
    // bytes, and a disagreement means something is very wrong with the writer.
    if view.v != NATIVE_VIEW_VERSION {
        return Err(NativeViewProblem::Unreadable(format!(
            "unsupported schema version {} (this build understands {})",
            view.v, NATIVE_VIEW_VERSION
        )));
    }

    Ok(view)
}

fn load_native_view<R: Runtime>(store: &Store<R>) -> Result<NativeHostView, NativeViewProblem> {
    parse_native_view(read_store_string(store, NATIVE_VIEW_KEY))
}

/// Route a published ref to the store it names. Split from [`read_key_ref`] so
/// the routing itself can be tested without a keychain or a Tauri store.
fn read_key_ref_with<S, P>(key_ref: &NativeKeyRef, read_secret: S, read_plain: P) -> Option<String>
where
    S: FnOnce(&str) -> Option<String>,
    P: FnOnce(&str) -> Option<String>,
{
    match key_ref.store {
        NativeKeyStore::Secret => read_secret(&key_ref.key),
        NativeKeyStore::Plain => read_plain(&key_ref.key),
    }
}

/// Read a published key. `"secret"` goes to the OS keychain, `"plain"` to
/// `store.json` -- and this process never decides which.
fn read_key_ref<R: Runtime>(store: &Store<R>, key_ref: &NativeKeyRef) -> Option<String> {
    read_key_ref_with(
        key_ref,
        |key| match keychain::keychain_get(key) {
            Ok(value) => value,
            Err(error) => {
                eprintln!("[desktop-ipc] Keychain read failed for {}: {}", key, error);
                None
            }
        },
        |key| read_store_string(store, key),
    )
}

/// Values of every `store.json` entry whose key starts with `prefix`.
///
/// Cached items and vaults are one record per key under the prefixes the view
/// publishes, so a scan is the whole read. Pure, for testability.
fn records_under_prefix(entries: Vec<(String, serde_json::Value)>, prefix: &str) -> Vec<String> {
    entries
        .into_iter()
        .filter(|(key, _)| key.starts_with(prefix))
        .filter_map(|(_, value)| value.as_str().map(|value| value.to_string()))
        .collect()
}

/// Deserialize scanned records, skipping any that are corrupt.
///
/// These are disposable encrypted blobs: a bad record costs a re-sync and must
/// never fail the whole snapshot. `ItemCache` skips corrupt records on the
/// TypeScript side for the same reason.
fn decode_records<T: serde::de::DeserializeOwned>(raw: Vec<String>, kind: &str) -> Vec<T> {
    let mut decoded = Vec::with_capacity(raw.len());
    for value in raw {
        match serde_json::from_str(&value) {
            Ok(record) => decoded.push(record),
            Err(error) => eprintln!(
                "[desktop-ipc] Skipping corrupt cached {} record: {}",
                kind, error
            ),
        }
    }
    decoded
}

fn read_records<R: Runtime, T: serde::de::DeserializeOwned>(
    store: &Store<R>,
    prefix: &str,
    kind: &str,
) -> Vec<T> {
    decode_records(records_under_prefix(store.entries(), prefix), kind)
}

fn normalize_item_version(version: Option<u64>) -> u64 {
    match version {
        Some(value) if value >= 1 => value,
        _ => 1,
    }
}

fn serialize_encryption_context(
    vault_id: &str,
    entity_id: &str,
    entity_type: &str,
    version: u64,
    user_id: &str,
) -> String {
    format!(
        "{}\0{}\0{}\0{}\0{}",
        vault_id, entity_id, entity_type, version, user_id
    )
}

fn unwrap_plaintext_with_context(
    decrypted_data: String,
    vault_id: &str,
    entity_id: &str,
    entity_type: &str,
    version: u64,
    user_id: &str,
) -> Result<String, String> {
    let parsed: serde_json::Value = serde_json::from_str(&decrypted_data)
        .map_err(|_| "Missing encryption context envelope".to_string())?;

    let marker = parsed
        .get("marker")
        .and_then(|value| value.as_str())
        .ok_or("Invalid encryption context envelope".to_string())?;
    let context = parsed
        .get("context")
        .and_then(|value| value.as_str())
        .ok_or("Invalid encryption context envelope".to_string())?;
    let payload = parsed
        .get("payload")
        .and_then(|value| value.as_str())
        .ok_or("Invalid encryption context envelope".to_string())?;

    if marker != CONTEXT_ENVELOPE_MARKER {
        return Err("Invalid encryption context marker".to_string());
    }

    let expected = serialize_encryption_context(vault_id, entity_id, entity_type, version, user_id);
    if context != expected {
        return Err("Encryption context mismatch".to_string());
    }

    Ok(payload.to_string())
}

fn normalize_decrypted_item_payload(decrypted_data: String) -> String {
    let parsed: serde_json::Value = match serde_json::from_str(&decrypted_data) {
        Ok(value) => value,
        Err(_) => return decrypted_data,
    };

    let marker = parsed.get("marker").and_then(|value| value.as_str());
    let payload = parsed.get("payload").and_then(|value| value.as_str());

    if marker == Some(CONTEXT_ENVELOPE_MARKER) {
        if let Some(payload_json) = payload {
            return payload_json.to_string();
        }
    }

    decrypted_data
}

#[derive(Debug, Clone, serde::Deserialize)]
struct CachedItemRecord {
    id: String,
    #[serde(rename = "vaultId")]
    vault_id: String,
    category: String,
    favorite: bool,
    #[serde(rename = "encryptedData")]
    encrypted_data: String,
    #[serde(rename = "encryptionIv")]
    encryption_iv: String,
    #[serde(rename = "encryptionAlgorithm")]
    encryption_algorithm: String,
    version: u64,
    #[serde(rename = "lastModifiedBy")]
    last_modified_by: Option<String>,
    #[serde(rename = "createdAt")]
    created_at: String,
    #[serde(rename = "updatedAt")]
    updated_at: String,
    #[serde(rename = "deletedAt", default)]
    deleted_at: Option<String>,
}

#[derive(Debug, Clone, serde::Deserialize)]
struct CachedVaultRecord {
    id: String,
    name: String,
    #[serde(rename = "type", default = "default_cached_vault_type")]
    vault_type: String,
    icon: Option<String>,
    #[serde(rename = "imageUrl")]
    image_url: Option<String>,
}

fn default_cached_vault_type() -> String {
    "personal".to_string()
}

fn decrypt_item_payload(item: &CachedItemRecord, vault_key_base64: &str) -> Result<String, String> {
    let user_id = item
        .last_modified_by
        .as_deref()
        .filter(|value| !value.is_empty());
    if let Some(user_id) = user_id {
        let stored_version = normalize_item_version(Some(item.version));
        let mut last_error: Option<String> = None;

        for version in (1..=stored_version).rev() {
            match crypto_commands::crypto_decrypt_with_context(
                item.encrypted_data.clone(),
                item.encryption_iv.clone(),
                item.encryption_algorithm.clone(),
                vault_key_base64.to_string(),
                item.vault_id.clone(),
                item.id.clone(),
                "item".to_string(),
                version,
                user_id.to_string(),
            ) {
                Ok(decrypted_data) => {
                    if version != stored_version {
                        eprintln!(
                            "[desktop-ipc] Recovered item {} with fallback encryption version {} (stored version {})",
                            item.id, version, stored_version
                        );
                    }
                    return Ok(normalize_decrypted_item_payload(decrypted_data));
                }
                Err(error) => {
                    last_error = Some(format!("Decryption failed: {}", error));
                }
            }
        }

        let decrypted_data = crypto_commands::crypto_decrypt(
            item.encrypted_data.clone(),
            item.encryption_iv.clone(),
            item.encryption_algorithm.clone(),
            vault_key_base64.to_string(),
        )
        .map_err(|e| last_error.unwrap_or_else(|| format!("Decryption failed: {}", e)))?;

        let unwrapped = unwrap_plaintext_with_context(
            decrypted_data,
            &item.vault_id,
            &item.id,
            "item",
            stored_version,
            user_id,
        )?;
        return Ok(normalize_decrypted_item_payload(unwrapped));
    }

    crypto_commands::crypto_decrypt(
        item.encrypted_data.clone(),
        item.encryption_iv.clone(),
        item.encryption_algorithm.clone(),
        vault_key_base64.to_string(),
    )
    .map(normalize_decrypted_item_payload)
    .map_err(|e| format!("Decryption failed: {}", e))
}

fn build_snapshot_item_payload(
    item: &CachedItemRecord,
    decrypted_data: &str,
    vault: Option<&CachedVaultRecord>,
    include_account_context: bool,
    account_id: &str,
    email: &str,
    account: Option<&serde_json::Value>,
) -> Option<serde_json::Value> {
    let Ok(mut payload) =
        serde_json::from_str::<serde_json::Map<String, serde_json::Value>>(decrypted_data)
    else {
        return None;
    };

    payload.insert("id".to_string(), serde_json::json!(item.id));
    payload.insert("vaultId".to_string(), serde_json::json!(item.vault_id));
    payload.insert("category".to_string(), serde_json::json!(item.category));
    payload.insert("favorite".to_string(), serde_json::json!(item.favorite));
    payload.insert("createdAt".to_string(), serde_json::json!(item.created_at));
    payload.insert("updatedAt".to_string(), serde_json::json!(item.updated_at));
    payload.insert("accountId".to_string(), serde_json::json!(account_id));
    payload.insert("accountEmail".to_string(), serde_json::json!(email));

    payload.insert(
        "vault".to_string(),
				serde_json::json!({
					"accountId": account_id,
            "id": vault.map(|value| value.id.clone()).unwrap_or_default(),
            "name": vault.map(|value| value.name.clone()).unwrap_or_else(|| "Unknown".to_string()),
            "type": vault.map(|value| value.vault_type.clone()).unwrap_or_else(|| "personal".to_string()),
            "icon": vault.and_then(|value| value.icon.clone()),
            "imageUrl": vault.and_then(|value| value.image_url.clone()),
        }),
    );

    if include_account_context {
        if let Some(account) = account {
            payload.insert(
                "account".to_string(),
                serde_json::json!({
                    "email": account.get("email").and_then(|value| value.as_str()).unwrap_or(email),
                    "userId": account.get("userId").and_then(|value| value.as_str()).unwrap_or_default(),
                    "name": account.get("name").and_then(|value| value.as_str()).unwrap_or(email),
                }),
            );
        }
    }

    Some(serde_json::Value::Object(payload))
}

fn now_timestamp_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or_default()
}

fn biometric_signature(challenge: &str, bound_to: impl std::fmt::Display) -> String {
    base64::engine::general_purpose::STANDARD.encode(format!("{}:{}", challenge, bound_to))
}

fn is_clean_disconnect(error: &str) -> bool {
    error.contains("early eof") || error.contains("unexpected end of file")
}

fn lock_event_to_response(event: LockEvent) -> DesktopResponse {
    match event {
        LockEvent::Lock { reason, timestamp } => DesktopResponse::DesktopEvent {
            event: DesktopEventKind::Lock,
            payload: serde_json::json!({
                "reason": reason,
                "timestamp": timestamp,
            }),
        },
        LockEvent::Unlock {
            accounts,
            timestamp,
        } => DesktopResponse::DesktopEvent {
            event: DesktopEventKind::Unlock,
            payload: serde_json::json!({
                "accounts": accounts,
                "timestamp": timestamp,
            }),
        },
        LockEvent::DesktopClose { timestamp } => DesktopResponse::DesktopEvent {
            event: DesktopEventKind::DesktopClose,
            payload: serde_json::json!({ "timestamp": timestamp }),
        },
        LockEvent::ActiveAccountChanged {
            account_id,
            timestamp,
        } => DesktopResponse::DesktopEvent {
            event: DesktopEventKind::ActiveAccountChanged,
            payload: serde_json::json!({
                "accountId": account_id,
                "timestamp": timestamp,
            }),
        },
        LockEvent::ThemeChanged { theme, timestamp } => DesktopResponse::DesktopEvent {
            event: DesktopEventKind::ThemeChanged,
            payload: serde_json::json!({
                "theme": theme,
                "timestamp": timestamp,
            }),
        },
    }
}

/// Read the device key through the published ref.
///
/// It is secret-tier, so the ref says `"secret"` and this lands in the OS
/// keychain.
fn load_device_key_base64<R: Runtime>(
    store: &Store<R>,
    view: &NativeHostView,
) -> Result<String, String> {
    let device_key_base64 = read_key_ref(store, &view.device_key).ok_or("No device key found")?;
    // Decoded only to reject a malformed value early; the base64 form is what
    // both the crypto commands and the extension response want.
    base64::engine::general_purpose::STANDARD
        .decode(&device_key_base64)
        .map_err(|e| format!("Failed to decode device key: {}", e))?;
    Ok(device_key_base64)
}

fn load_session_data<R: Runtime>(
    store: &Store<R>,
    account: &NativeAccountView,
) -> Result<serde_json::Value, String> {
    let session_data_str =
        read_key_ref(store, &account.session_data).ok_or("No session data found")?;
    serde_json::from_str(&session_data_str)
        .map_err(|e| format!("Failed to parse session data: {}", e))
}

fn load_muk_base64<R: Runtime>(
    store: &Store<R>,
    view: &NativeHostView,
    account: &NativeAccountView,
) -> Result<String, String> {
    let session_data = load_session_data(store, account)?;
    let device_key_base64 = load_device_key_base64(store, view)?;

    let encrypted_muk = session_data
        .get("encryptedMasterUnlockKey")
        .ok_or("No encrypted master unlock key in session")?;
    let encrypted_data: serde_json::Value = serde_json::from_str(
        &serde_json::to_string(encrypted_muk)
            .map_err(|e| format!("Failed to serialize encrypted MUK: {}", e))?,
    )
    .map_err(|e| format!("Failed to parse encrypted MUK: {}", e))?;

    let ciphertext = encrypted_data
        .get("ciphertext")
        .and_then(|v| v.as_str())
        .ok_or("Missing ciphertext")?;
    let iv = encrypted_data
        .get("iv")
        .and_then(|v| v.as_str())
        .ok_or("Missing IV")?;
    let algorithm = encrypted_data
        .get("algorithm")
        .and_then(|v| v.as_str())
        .ok_or("Missing algorithm")?;

    crypto_commands::crypto_decrypt(
        ciphertext.to_string(),
        iv.to_string(),
        algorithm.to_string(),
        device_key_base64,
    )
    .map_err(|e| format!("Failed to decrypt MUK: {}", e))
}

fn load_decrypted_vault_keys<R: Runtime>(
    store: &Store<R>,
    view: &NativeHostView,
    account: &NativeAccountView,
) -> Result<std::collections::HashMap<String, String>, String> {
    let muk_base64 = load_muk_base64(store, view, account)?;
    let vault_keys_str = read_key_ref(store, &account.vault_keys).ok_or("Vault keys not found")?;
    let vault_keys: Vec<serde_json::Value> = serde_json::from_str(&vault_keys_str)
        .map_err(|e| format!("Failed to parse vault keys: {}", e))?;

    let mut decrypted_vault_keys = std::collections::HashMap::new();

    for vk in vault_keys {
        let vault_id = vk
            .get("vaultId")
            .and_then(|v| v.as_str())
            .ok_or("Missing vaultId")?;
        let encrypted_vault_key = vk
            .get("encryptedVaultKey")
            .and_then(|v| v.as_str())
            .ok_or("Missing encryptedVaultKey")?;

        let vault_key_base64 = if encrypted_vault_key.starts_with("{") {
            let vk_encrypted: serde_json::Value = serde_json::from_str(encrypted_vault_key)
                .map_err(|e| format!("Failed to parse vault key: {}", e))?;
            let ciphertext = vk_encrypted
                .get("ciphertext")
                .and_then(|v| v.as_str())
                .ok_or("Missing vault key ciphertext")?;
            let iv = vk_encrypted
                .get("iv")
                .and_then(|v| v.as_str())
                .ok_or("Missing vault key IV")?;
            let algorithm = vk_encrypted
                .get("algorithm")
                .and_then(|v| v.as_str())
                .ok_or("Missing vault key algorithm")?;

            if let Some(ctx) = vk_encrypted.get("context") {
                let ctx_vault_id = ctx
                    .get("vaultId")
                    .and_then(|v| v.as_str())
                    .ok_or("Missing vault key context vaultId")?;
                let ctx_user_id = ctx
                    .get("userId")
                    .and_then(|v| v.as_str())
                    .ok_or("Missing vault key context userId")?;
                let ctx_key_version = ctx
                    .get("keyVersion")
                    .and_then(|v| v.as_u64())
                    .ok_or("Missing vault key context keyVersion")?;
                let ctx_purpose = ctx
                    .get("purpose")
                    .and_then(|v| v.as_str())
                    .ok_or("Missing vault key context purpose")?;

                crypto_commands::crypto_decrypt_with_context(
                    ciphertext.to_string(),
                    iv.to_string(),
                    algorithm.to_string(),
                    muk_base64.clone(),
                    ctx_vault_id.to_string(),
                    ctx_purpose.to_string(),
                    "vault_key".to_string(),
                    ctx_key_version,
                    ctx_user_id.to_string(),
                )
                .map_err(|e| format!("Failed to decrypt vault key with context: {}", e))?
            } else {
                crypto_commands::crypto_decrypt(
                    ciphertext.to_string(),
                    iv.to_string(),
                    algorithm.to_string(),
                    muk_base64.clone(),
                )
                .map_err(|e| format!("Failed to decrypt vault key: {}", e))?
            }
        } else {
            let encrypted_private_key_str = read_key_ref(store, &account.encrypted_private_key)
                .ok_or("Encrypted private key not found for RSA decryption")?;
            let epk: serde_json::Value = serde_json::from_str(&encrypted_private_key_str)
                .map_err(|e| format!("Failed to parse encrypted private key: {}", e))?;
            let epk_ciphertext = epk
                .get("ciphertext")
                .and_then(|v| v.as_str())
                .ok_or("Missing private key ciphertext")?;
            let epk_iv = epk
                .get("iv")
                .and_then(|v| v.as_str())
                .ok_or("Missing private key IV")?;
            let epk_algorithm = epk
                .get("algorithm")
                .and_then(|v| v.as_str())
                .ok_or("Missing private key algorithm")?;
            let private_key_pem = crypto_commands::crypto_decrypt(
                epk_ciphertext.to_string(),
                epk_iv.to_string(),
                epk_algorithm.to_string(),
                muk_base64.clone(),
            )
            .map_err(|e| format!("Failed to decrypt private key: {}", e))?;

            crypto_commands::crypto_rsa_decrypt(encrypted_vault_key.to_string(), private_key_pem)
                .map_err(|e| format!("Failed to RSA decrypt vault key: {}", e))?
        };

        decrypted_vault_keys.insert(vault_id.to_string(), vault_key_base64);
    }

    Ok(decrypted_vault_keys)
}

/// The bearer token, read through the account's published `token` ref.
///
/// The ref says which store holds it, and on desktop that is always the
/// keychain.
fn get_bearer_token_for_account_id<R: Runtime>(
    store: &Store<R>,
    account: &NativeAccountView,
) -> Option<String> {
    read_key_ref(store, &account.token)
}

async fn get_auth_token_internal(
    app_handle: &tauri::AppHandle,
    account_id: &str,
) -> Result<serde_json::Value, String> {
    use tauri_plugin_store::StoreExt;

    let store = app_handle
        .store("store.json")
        .map_err(|e| format!("Failed to access store: {}", e))?;
    let view = load_native_view(&store).map_err(|problem| problem.message())?;
    let account = view.account(account_id).ok_or("Account not found")?;

    let token = get_bearer_token_for_account_id(&store, account).ok_or("Auth token not found")?;
    let session_metadata = read_key_ref(&store, &account.session_data)
        .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok());

    Ok(serde_json::json!({
        "accountId": account_id,
        "email": account.email,
        "authToken": token,
        "expiresAt": session_metadata.as_ref().and_then(|value| value.get("expiresAt")).cloned(),
        "userId": session_metadata.as_ref().and_then(|value| value.get("userId")).cloned(),
    }))
}

async fn get_items_snapshot_internal(
    app_handle: &tauri::AppHandle,
    account_ids: Option<Vec<String>>,
) -> Result<serde_json::Value, String> {
    use tauri_plugin_store::StoreExt;

    let store = app_handle
        .store("store.json")
        .map_err(|e| format!("Failed to access store: {}", e))?;

    // A missing or unreadable view means this process knows about no accounts,
    // which is an empty snapshot -- not an error and not a guess.
    let view = match load_native_view(&store) {
        Ok(view) => view,
        Err(problem) => {
            eprintln!("[desktop-ipc] Empty items snapshot: {}", problem.message());
            return Ok(serde_json::json!({
                "items": Vec::<serde_json::Value>::new(),
                "generatedAt": now_timestamp_ms(),
            }));
        }
    };

    let target_account_ids = match account_ids {
        Some(values) if !values.is_empty() => values,
        _ => view.unlocked_account_ids.clone(),
    };

    let include_account_context = target_account_ids.len() > 1;
    let mut items = Vec::new();
    let mut skipped_items = 0usize;

    for account_id in target_account_ids {
        if !view.is_unlocked(&account_id) {
            continue;
        }
        let account = view.account(&account_id).ok_or("Account not found")?;
        let email = account.email.as_str();

        let decrypted_vault_keys = load_decrypted_vault_keys(&store, &view, account)?;

        // Cached items and vaults are one `store.json` record per key under the
        // prefixes the view publishes. Scan them; concatenate nothing.
        let cached_items: Vec<CachedItemRecord> =
            read_records(&store, &account.items_key_prefix, "item");
        let cached_vaults: Vec<CachedVaultRecord> =
            read_records(&store, &account.vaults_key_prefix, "vault");
        let vault_map = cached_vaults
            .into_iter()
            .map(|vault| (vault.id.clone(), vault))
            .collect::<std::collections::HashMap<_, _>>();

        // The multi-account payload carries the account's identity. `userId`
        // comes from the published session document; the view itself publishes
        // only accountId, email and biometricEnabled per account.
        let account_context = include_account_context.then(|| {
            let user_id = read_key_ref(&store, &account.session_data)
                .and_then(|raw| serde_json::from_str::<serde_json::Value>(&raw).ok())
                .and_then(|session| {
                    session
                        .get("userId")
                        .and_then(|value| value.as_str())
                        .map(|value| value.to_string())
                })
                .unwrap_or_default();
            serde_json::json!({ "email": email, "userId": user_id })
        });

        for item in cached_items
            .into_iter()
            .filter(|item| item.deleted_at.is_none())
        {
            let Some(vault_key) = decrypted_vault_keys.get(&item.vault_id) else {
                continue;
            };

            let decrypted_data = match decrypt_item_payload(&item, vault_key) {
                Ok(data) => data,
                Err(error) => {
                    skipped_items += 1;
                    eprintln!(
                        "[desktop-ipc] Failed to decrypt cached item {} for {}: {}",
                        item.id, email, error
                    );
                    continue;
                }
            };

            let Some(payload) = build_snapshot_item_payload(
                &item,
                &decrypted_data,
                vault_map.get(&item.vault_id),
                include_account_context,
                &account_id,
                email,
                account_context.as_ref(),
            ) else {
                continue;
            };
            items.push(payload);
        }
    }

    if skipped_items > 0 {
        eprintln!(
            "[desktop-ipc] Skipped {} cached item(s) while building desktop snapshot",
            skipped_items
        );
    }

    Ok(serde_json::json!({
        "items": items,
        "generatedAt": now_timestamp_ms(),
    }))
}

async fn handle_desktop_ipc_message(
    app_handle: &tauri::AppHandle,
    request: DesktopRequest,
) -> DesktopResponse {
    match request {
        DesktopRequest::Ping => DesktopResponse::Pong {
            version: env!("CARGO_PKG_VERSION").to_string(),
        },
        DesktopRequest::GetDesktopStatus => match get_lock_status_internal(app_handle).await {
            Ok(status) => DesktopResponse::DesktopStatus {
                available: true,
                locked: status.locked,
                unlocked_accounts: status.unlocked_accounts,
                timestamp: status.timestamp,
                autolock_timeout_ms: status.autolock_timeout_ms,
                theme: status.theme,
            },
            Err(error) => DesktopResponse::Error { message: error },
        },
        DesktopRequest::GetDesktopAccounts => match get_accounts_list_internal(app_handle).await {
            Ok(data) => DesktopResponse::DesktopAccounts {
                accounts: data
                    .get("accounts")
                    .and_then(|v| v.as_array())
                    .cloned()
                    .unwrap_or_default(),
                active_account: data
                    .get("active_account")
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string()),
                unlocked_accounts: data
                    .get("unlocked_accounts")
                    .and_then(|v| v.as_array())
                    .map(|accounts| {
                        accounts
                            .iter()
                            .filter_map(|value| value.as_str().map(|s| s.to_string()))
                            .collect()
                    })
                    .unwrap_or_default(),
            },
            Err(error) => DesktopResponse::Error { message: error },
        },
        DesktopRequest::GetDesktopAuthToken { account_id } => {
            match get_auth_token_internal(app_handle, &account_id).await {
                Ok(data) => DesktopResponse::DesktopAuthToken {
                    account_id,
                    email: data
                        .get("email")
                        .and_then(|v| v.as_str())
                        .unwrap_or_default()
                        .to_string(),
                    auth_token: data
                        .get("authToken")
                        .and_then(|v| v.as_str())
                        .unwrap_or_default()
                        .to_string(),
                    expires_at: data.get("expiresAt").and_then(|v| v.as_i64()),
                    user_id: data
                        .get("userId")
                        .and_then(|v| v.as_str())
                        .map(|s| s.to_string()),
                },
                Err(error) => DesktopResponse::Error { message: error },
            }
        }
        DesktopRequest::GetDesktopVaultKeys { account_id } => {
            match get_vault_keys_internal(app_handle, Some(account_id.clone())).await {
                Ok(data) => DesktopResponse::DesktopVaultKeys {
                    account_id,
                    email: data
                        .get("email")
                        .and_then(|v| v.as_str())
                        .unwrap_or_default()
                        .to_string(),
                    vault_keys: data
                        .get("vault_keys")
                        .and_then(|v| v.as_str())
                        .unwrap_or_default()
                        .to_string(),
                },
                Err(error) => DesktopResponse::Error { message: error },
            }
        }
        DesktopRequest::GetDesktopItemsSnapshot { account_ids } => {
            match get_items_snapshot_internal(app_handle, account_ids).await {
                Ok(data) => DesktopResponse::DesktopItemsSnapshot {
                    items: data
                        .get("items")
                        .and_then(|v| v.as_array())
                        .cloned()
                        .unwrap_or_default(),
                    generated_at: data
                        .get("generatedAt")
                        .and_then(|v| v.as_i64())
                        .unwrap_or_else(now_timestamp_ms),
                },
                Err(error) => DesktopResponse::Error { message: error },
            }
        }
        DesktopRequest::CheckBiometricAvailable => {
            match check_biometric_status_internal(app_handle).await {
                Ok(status) => DesktopResponse::BiometricStatus {
                    available: status
                        .get("available")
                        .and_then(|v| v.as_bool())
                        .unwrap_or(false),
                    enabled: status
                        .get("enabled")
                        .and_then(|v| v.as_bool())
                        .unwrap_or(false),
                    app_running: true,
                },
                Err(error) => DesktopResponse::Error { message: error },
            }
        }
        DesktopRequest::BiometricUnlockRequest {
            challenge,
            extension_id,
            account_id,
        } => match biometric_unlock_internal(
            app_handle,
            &challenge,
            &extension_id,
            account_id.as_deref(),
        )
        .await
        {
            Ok(response) => DesktopResponse::BiometricUnlockSuccess {
                account_id: response.account.account_id,
                email: response.account.email,
                encrypted_session: response.account.encrypted_session,
                device_key: response.device_key,
                signature: response.signature,
                auth_token: response.account.auth_token,
                vault_keys: response.account.vault_keys,
            },
            Err(error) => DesktopResponse::BiometricUnlockFailed { error },
        },
        DesktopRequest::BiometricUnlockAllRequest {
            challenge,
            extension_id,
        } => match biometric_unlock_all_internal(app_handle, &challenge, &extension_id).await {
            Ok(response) => DesktopResponse::BiometricUnlockAllSuccess {
                device_key: response.device_key,
                signature: response.signature,
                accounts: response.accounts,
                unlocked: response.unlocked,
                failed: response.failed,
            },
            Err(error) => DesktopResponse::BiometricUnlockAllFailed { error },
        },
        DesktopRequest::TriggerDesktopUnlock => {
            if let Err(error) = open_app_internal(app_handle) {
                DesktopResponse::TriggerDesktopUnlockResult {
                    success: false,
                    error: Some(error),
                }
            } else if let Err(error) = app_handle.emit("trigger-biometric-unlock", ()) {
                DesktopResponse::TriggerDesktopUnlockResult {
                    success: false,
                    error: Some(error.to_string()),
                }
            } else {
                DesktopResponse::TriggerDesktopUnlockResult {
                    success: true,
                    error: None,
                }
            }
        }
        DesktopRequest::OpenDesktopApp {
            intent,
            url,
            item_id,
            vault_id,
        } => match open_app_internal(app_handle) {
            Ok(()) => {
                match intent.as_deref() {
                    Some("create_item") => {
                        let _ =
                            app_handle.emit("open-create-item", serde_json::json!({ "url": url }));
                    }
                    Some("view_item") => {
                        let _ = app_handle.emit(
                            "open-item",
                            serde_json::json!({ "itemId": item_id, "vaultId": vault_id }),
                        );
                    }
                    _ => {}
                }
                DesktopResponse::OpenDesktopAppResult {
                    success: true,
                    error: None,
                }
            }
            Err(error) => DesktopResponse::OpenDesktopAppResult {
                success: false,
                error: Some(error),
            },
        },
        DesktopRequest::SubscribeDesktopEvents | DesktopRequest::UnsubscribeDesktopEvents => {
            DesktopResponse::DesktopEventSubscription { subscribed: false }
        }
    }
}

async fn handle_desktop_ipc_connection<S>(
    app_handle: tauri::AppHandle,
    state: Arc<DesktopIpcState>,
    stream: S,
) -> Result<(), String>
where
    S: AsyncRead + AsyncWrite + Unpin + Send + 'static,
{
    let (mut reader, mut writer) = tokio::io::split(stream);
    let mut event_rx: Option<broadcast::Receiver<LockEvent>> = None;

    loop {
        if let Some(rx) = event_rx.as_mut() {
            tokio::select! {
                message = desktop_ipc::read_frame::<_, DesktopEnvelope<DesktopRequest>>(&mut reader) => {
                    let message = message.map_err(|error| error.to_string())?;
                    if message.protocol_version != Some(DESKTOP_PROTOCOL_VERSION) {
                        eprintln!(
                            "[desktop-ipc] Protocol mismatch expected={} received={}",
                            DESKTOP_PROTOCOL_VERSION,
                            message.protocol_version.map(|version| version.to_string()).unwrap_or_else(|| "legacy".to_string()),
                        );
                        let response = DesktopEnvelope::current(
                            message.request_id,
                            DesktopResponse::ProtocolMismatch {
                                expected_version: DESKTOP_PROTOCOL_VERSION,
                                received_version: message.protocol_version,
                            },
                        );
                        write_frame(&mut writer, &response).await.map_err(|error| error.to_string())?;
                    } else {
                        match message.payload {
                        DesktopRequest::UnsubscribeDesktopEvents => {
                            event_rx = None;
                            let response = DesktopEnvelope::current(
                                message.request_id,
                                DesktopResponse::DesktopEventSubscription { subscribed: false },
                            );
                            write_frame(&mut writer, &response).await.map_err(|error| error.to_string())?;
                        }
                        request => {
                            let payload = handle_desktop_ipc_message(&app_handle, request).await;
                            let response = DesktopEnvelope::current(message.request_id, payload);
                            write_frame(&mut writer, &response).await.map_err(|error| error.to_string())?;
                        }
                        }
                    }
                }
                event = rx.recv() => {
                    match event {
                        Ok(event) => {
                            let response = DesktopEnvelope::current(
                                None,
                                lock_event_to_response(event),
                            );
                            write_frame(&mut writer, &response).await.map_err(|error| error.to_string())?;
                        }
                        Err(broadcast::error::RecvError::Lagged(_)) => {}
                        Err(broadcast::error::RecvError::Closed) => break,
                    }
                }
            }
        } else {
            let message: DesktopEnvelope<DesktopRequest> = desktop_ipc::read_frame(&mut reader)
                .await
                .map_err(|error| error.to_string())?;
            if message.protocol_version != Some(DESKTOP_PROTOCOL_VERSION) {
                eprintln!(
                    "[desktop-ipc] Protocol mismatch expected={} received={}",
                    DESKTOP_PROTOCOL_VERSION,
                    message
                        .protocol_version
                        .map(|version| version.to_string())
                        .unwrap_or_else(|| "legacy".to_string()),
                );
                let response = DesktopEnvelope::current(
                    message.request_id,
                    DesktopResponse::ProtocolMismatch {
                        expected_version: DESKTOP_PROTOCOL_VERSION,
                        received_version: message.protocol_version,
                    },
                );
                write_frame(&mut writer, &response)
                    .await
                    .map_err(|error| error.to_string())?;
            } else {
                match message.payload {
                    DesktopRequest::SubscribeDesktopEvents => {
                        event_rx = Some(state.lock_events.subscribe());
                        let response = DesktopEnvelope::current(
                            message.request_id,
                            DesktopResponse::DesktopEventSubscription { subscribed: true },
                        );
                        write_frame(&mut writer, &response)
                            .await
                            .map_err(|error| error.to_string())?;
                    }
                    request => {
                        let payload = handle_desktop_ipc_message(&app_handle, request).await;
                        let response = DesktopEnvelope::current(message.request_id, payload);
                        write_frame(&mut writer, &response)
                            .await
                            .map_err(|error| error.to_string())?;
                    }
                }
            }
        }
    }

    Ok(())
}

#[cfg(unix)]
async fn start_desktop_ipc_server(app_handle: tauri::AppHandle, state: Arc<DesktopIpcState>) {
    use std::os::unix::io::AsRawFd;

    // The socket goes in a directory we create at 0700 rather than one whose
    // mode depends on the process umask.
    let socket_path = match ipc_security::prepare_desktop_ipc_socket_path() {
        Ok(path) => path,
        Err(error) => {
            eprintln!(
                "[desktop-ipc] Refusing to start: could not prepare a private socket directory: {}",
                error
            );
            return;
        }
    };
    let _ = std::fs::remove_file(&socket_path);

    let listener = match tokio::net::UnixListener::bind(&socket_path) {
        Ok(listener) => listener,
        Err(error) => {
            eprintln!(
                "[desktop-ipc] Failed to bind {}: {}",
                socket_path.display(),
                error
            );
            return;
        }
    };

    if let Err(error) = ipc_security::restrict_socket_file(&socket_path) {
        eprintln!(
            "[desktop-ipc] Refusing to start: could not restrict {}: {}",
            socket_path.display(),
            error
        );
        let _ = std::fs::remove_file(&socket_path);
        return;
    }

    eprintln!("[desktop-ipc] Listening on {}", socket_path.display());

    loop {
        match listener.accept().await {
            Ok((stream, _)) => {
                // This endpoint hands out vault keys and session tokens, so the
                // peer has to prove it is our own native messaging host running
                // as this same user before it gets to send a single frame.
                match ipc_security::authorize_unix_peer(
                    stream.as_raw_fd(),
                    ipc_security::PeerRole::NativeHost,
                    ipc_security::PeerPolicy::Required,
                ) {
                    Ok(_) => {}
                    Err(reason) => {
                        eprintln!("[desktop-ipc] Rejected connection: {}", reason);
                        drop(stream);
                        continue;
                    }
                }

                let app_handle = app_handle.clone();
                let state = state.clone();
                tauri::async_runtime::spawn(async move {
                    if let Err(error) =
                        handle_desktop_ipc_connection(app_handle, state, stream).await
                    {
                        if !is_clean_disconnect(&error.to_lowercase()) {
                            eprintln!("[desktop-ipc] Connection ended: {}", error);
                        }
                    }
                });
            }
            Err(error) => {
                eprintln!("[desktop-ipc] Accept failed: {}", error);
                break;
            }
        }
    }
}

/// Create one instance of the desktop IPC named pipe.
///
/// Every instance carries the explicit security descriptor from
/// `ipc_security`; passing `NULL` here would fall back to the default NPFS
/// DACL, which grants `Everyone` and `ANONYMOUS` read access.
#[cfg(windows)]
fn create_desktop_ipc_pipe_instance(
    pipe_name: &str,
    security: &mut ipc_security::PipeSecurity,
    first: bool,
) -> std::io::Result<tokio::net::windows::named_pipe::NamedPipeServer> {
    use tokio::net::windows::named_pipe::ServerOptions;

    let mut options = ServerOptions::new();
    options.first_pipe_instance(first);
    options.reject_remote_clients(true);

    // SAFETY: `security.as_ptr()` points at a live `SECURITY_ATTRIBUTES` that
    // outlives the call, since `security` is borrowed for it.
    unsafe { options.create_with_security_attributes_raw(pipe_name, security.as_ptr()) }
}

#[cfg(windows)]
async fn start_desktop_ipc_server(app_handle: tauri::AppHandle, state: Arc<DesktopIpcState>) {
    use std::os::windows::io::AsRawHandle;

    let pipe_name = desktop_ipc_socket_path();
    let pipe_name = pipe_name.to_string_lossy().to_string();

    let mut security = match ipc_security::PipeSecurity::for_current_user() {
        Ok(security) => security,
        Err(error) => {
            eprintln!(
                "[desktop-ipc] FATAL: could not build the pipe security descriptor: {}. \
                 Browser extension integration is disabled for this session.",
                error
            );
            return;
        }
    };

    // The first instance claims the name exclusively. If something already owns
    // it, `FILE_FLAG_FIRST_PIPE_INSTANCE` fails with ERROR_ACCESS_DENIED, which
    // means another process is squatting a pipe our extension would otherwise
    // trust. That has to be loud, not a silent fallback.
    let mut server = match create_desktop_ipc_pipe_instance(&pipe_name, &mut security, true) {
        Ok(server) => server,
        Err(error) => {
            eprintln!(
                "[desktop-ipc] FATAL: {}",
                ipc_security::describe_pipe_create_error(&pipe_name, error.raw_os_error(), true)
            );
            return;
        }
    };

    eprintln!("[desktop-ipc] Listening on {}", pipe_name);

    loop {
        if let Err(error) = server.connect().await {
            eprintln!("[desktop-ipc] Named pipe connect failed: {}", error);
            server = match create_desktop_ipc_pipe_instance(&pipe_name, &mut security, false) {
                Ok(next) => next,
                Err(error) => {
                    eprintln!(
                        "[desktop-ipc] FATAL: {}. Browser extension integration is disabled \
                         until Bittery is restarted.",
                        ipc_security::describe_pipe_create_error(
                            &pipe_name,
                            error.raw_os_error(),
                            false
                        )
                    );
                    return;
                }
            };
            continue;
        }

        let connected = server;
        // Replace the instance before handling the connection so the next
        // client never finds the name unserved.
        server = match create_desktop_ipc_pipe_instance(&pipe_name, &mut security, false) {
            Ok(next) => next,
            Err(error) => {
                eprintln!(
                    "[desktop-ipc] FATAL: {}. Browser extension integration is disabled \
                     until Bittery is restarted.",
                    ipc_security::describe_pipe_create_error(
                        &pipe_name,
                        error.raw_os_error(),
                        false
                    )
                );
                return;
            }
        };

        // The descriptor keeps other users out; this keeps every *other program
        // this user runs* out.
        if let Err(reason) = ipc_security::authorize_pipe_peer(
            connected.as_raw_handle(),
            ipc_security::PipeSide::Client,
            ipc_security::PeerRole::NativeHost,
            ipc_security::PeerPolicy::Required,
        ) {
            eprintln!("[desktop-ipc] Rejected connection: {}", reason);
            drop(connected);
            continue;
        }

        let app_handle = app_handle.clone();
        let state = state.clone();
        tauri::async_runtime::spawn(async move {
            if let Err(error) = handle_desktop_ipc_connection(app_handle, state, connected).await {
                if !is_clean_disconnect(&error.to_lowercase()) {
                    eprintln!("[desktop-ipc] Connection ended: {}", error);
                }
            }
        });
    }
}

/// Tauri command to check biometric status and session validity
#[tauri::command]
async fn check_extension_biometric_status(
    app_handle: tauri::AppHandle,
) -> Result<serde_json::Value, String> {
    use tauri_plugin_biometry::BiometryExt;
    use tauri_plugin_store::StoreExt;

    // Check if biometry is available
    let biometry = app_handle.biometry();
    let status = biometry
        .status()
        .map_err(|e| format!("Failed to check biometry status: {}", e))?;

    // Check if session data exists in store
    let store = app_handle
        .store("store.json")
        .map_err(|e| format!("Failed to access store: {}", e))?;

    // No usable view means no active account, which is "not enabled" -- the
    // honest answer while the app has not initialised.
    let active_account = match load_native_view(&store) {
        Ok(view) => view
            .active_account_id
            .as_deref()
            .and_then(|account_id| view.account(account_id).cloned()),
        Err(problem) => {
            eprintln!(
                "[Biometric Status] Reporting not-enabled: {}",
                problem.message()
            );
            None
        }
    };

    // `biometricEnabled` is published already resolved, so there is nothing to
    // default here. Quick-unlock also needs a stored session to unlock into.
    let has_session = match active_account {
        Some(account) => {
            account.biometric_enabled && read_key_ref(&store, &account.session_data).is_some()
        }
        None => false,
    };

    Ok(serde_json::json!({
        "available": status.is_available,
        "enabled": has_session,
    }))
}

/// Tauri command to perform biometric unlock
#[tauri::command]
async fn extension_biometric_unlock(
    app_handle: tauri::AppHandle,
    challenge: String,
    extension_id: String,
    account_id: Option<String>,
) -> Result<BiometricUnlockMaterial, String> {
    use tauri_plugin_biometry::BiometryExt;
    use tauri_plugin_store::StoreExt;

    eprintln!(
        "[Biometric Unlock] Request from extension: {}",
        extension_id
    );
    eprintln!("[Biometric Unlock] Challenge: {}", challenge);
    if let Some(ref id) = account_id {
        eprintln!("[Biometric Unlock] Requested account: {}", id);
    }

    // 1. Authenticate with biometric (Touch ID / Windows Hello)
    let biometry = app_handle.biometry();
    let auth_options = tauri_plugin_biometry::AuthOptions::default();
    biometry
        .authenticate(
            "Unlock Bittery for browser extension".to_string(),
            auth_options,
        )
        .map_err(|e| format!("Biometric authentication failed: {}", e))?;

    eprintln!("[Biometric Unlock] ✓ Authentication successful");

    // 2. Get session data from store
    let store = app_handle
        .store("store.json")
        .map_err(|e| format!("Failed to access store: {}", e))?;

    let view = load_native_view(&store).map_err(|problem| problem.message())?;
    eprintln!(
        "[Biometric Unlock] Published accounts: {}",
        view.accounts.len()
    );

    let target_account_id = account_id
        .or_else(|| view.active_account_id.clone())
        .ok_or("No account specified")?;
    let account = view
        .account(&target_account_id)
        .ok_or("Account not found")?;
    let target_email = account.email.clone();

    // Enforce the per-account biometric preference before releasing any
    // secrets. The value is published already resolved.
    if !account.biometric_enabled {
        eprintln!(
            "[Biometric Unlock] Biometrics disabled for account: {}",
            target_account_id
        );
        return Err("Biometric unlock is disabled for this account".to_string());
    }

    eprintln!("[Biometric Unlock] Target account: {}", target_account_id);
    let session_data = load_session_data(&store, account)?;

    eprintln!("[Biometric Unlock] Session data retrieved");

    // 3. Get device key to decrypt the MUK (keychain-only).
    let device_key_base64 = load_device_key_base64(&store, &view)?;

    // 4. Get encrypted MUK from session data
    let encrypted_muk = session_data
        .get("encryptedMasterUnlockKey")
        .ok_or("No encrypted master unlock key in session")?;

    eprintln!("[Biometric Unlock] Encrypted MUK retrieved");

    // 5. Send the encrypted MUK and device key to extension
    // The extension will decrypt it using the device key
    // This is secure because:
    // - Device key never leaves the device
    // - Biometric authentication was required
    // - Communication is over localhost only
    // - Extension has same security boundary as desktop app

    let encrypted_muk_json = serde_json::to_string(encrypted_muk)
        .map_err(|e| format!("Failed to serialize encrypted MUK: {}", e))?;

    let encrypted_session_b64 =
        base64::engine::general_purpose::STANDARD.encode(encrypted_muk_json.as_bytes());

    // Get auth token and vault keys through their published refs
    let auth_token = get_bearer_token_for_account_id(&store, account);
    let vault_keys = read_key_ref(&store, &account.vault_keys);

    // Sign the response with challenge to prevent replay attacks
    let signature = biometric_signature(&challenge, &encrypted_session_b64);

    eprintln!("[Biometric Unlock] ✓ Response prepared and signed");

    Ok(BiometricUnlockMaterial {
        account: AccountUnlockData {
            account_id: target_account_id,
            email: target_email,
            encrypted_session: encrypted_session_b64,
            auth_token,
            vault_keys,
        },
        device_key: device_key_base64,
        signature,
    })
}

/// Check biometric status
async fn check_biometric_status_internal(
    app_handle: &tauri::AppHandle,
) -> Result<serde_json::Value, String> {
    // Call the Tauri command
    check_extension_biometric_status(app_handle.clone()).await
}

/// Perform biometric unlock and return encrypted session
async fn biometric_unlock_internal(
    app_handle: &tauri::AppHandle,
    challenge: &str,
    extension_id: &str,
    account_id: Option<&str>,
) -> Result<BiometricUnlockMaterial, String> {
    // Call the Tauri command
    extension_biometric_unlock(
        app_handle.clone(),
        challenge.to_string(),
        extension_id.to_string(),
        account_id.map(|id| id.to_string()),
    )
    .await
}

/// Perform biometric unlock for all accounts with single prompt
async fn biometric_unlock_all_internal(
    app_handle: &tauri::AppHandle,
    challenge: &str,
    extension_id: &str,
) -> Result<BiometricUnlockAllMaterial, String> {
    use tauri_plugin_biometry::BiometryExt;
    use tauri_plugin_store::StoreExt;

    eprintln!(
        "[Biometric Unlock All] Request from extension: {}",
        extension_id
    );
    eprintln!("[Biometric Unlock All] Challenge: {}", challenge);

    // 1. Authenticate with biometric ONCE (Touch ID / Windows Hello)
    let biometry = app_handle.biometry();
    let auth_options = tauri_plugin_biometry::AuthOptions::default();
    biometry
        .authenticate(
            "Unlock all Bittery accounts for browser extension".to_string(),
            auth_options,
        )
        .map_err(|e| format!("Biometric authentication failed: {}", e))?;

    eprintln!("[Biometric Unlock All] ✓ Authentication successful");

    // 2. Get accounts list from store
    let store = app_handle
        .store("store.json")
        .map_err(|e| format!("Failed to access store: {}", e))?;

    let view = load_native_view(&store).map_err(|problem| problem.message())?;

    eprintln!(
        "[Biometric Unlock All] Found {} accounts",
        view.accounts.len()
    );

    // 3. Get device key (shared across all accounts) through its published ref
    let device_key_base64 = load_device_key_base64(&store, &view)?;

    // 4. Unlock all accounts (no additional biometric prompts)
    let mut accounts_data: Vec<AccountUnlockData> = Vec::new();
    let mut unlocked_account_ids = Vec::new();
    let mut failed_account_ids = Vec::new();

    for account in &view.accounts {
        let account_id = account.account_id.clone();
        let email = account.email.to_lowercase();

        eprintln!("[Biometric Unlock All] Processing account: {}", email);

        // Respect the per-account biometric preference: skip (do not expose the
        // MUK for) any account whose owner has disabled biometric unlock.
        if !account.biometric_enabled {
            eprintln!(
                "[Biometric Unlock All] Skipping account with biometrics disabled: {}",
                email
            );
            continue;
        }

        let session_data = match load_session_data(&store, account) {
            Ok(data) => data,
            Err(error) => {
                eprintln!(
                    "[Biometric Unlock All] No usable session data for {}: {}",
                    email, error
                );
                failed_account_ids.push(account_id);
                continue;
            }
        };

        // Get encrypted MUK from session data
        let encrypted_muk = match session_data.get("encryptedMasterUnlockKey") {
            Some(muk) => muk,
            None => {
                eprintln!("[Biometric Unlock All] No encrypted MUK for {}", email);
                failed_account_ids.push(account_id);
                continue;
            }
        };

        let encrypted_muk_json = serde_json::to_string(encrypted_muk)
            .map_err(|e| format!("Failed to serialize encrypted MUK for {}: {}", email, e))?;

        let encrypted_session_b64 =
            base64::engine::general_purpose::STANDARD.encode(encrypted_muk_json.as_bytes());

        // Get auth token and vault keys for this account
        let auth_token = get_bearer_token_for_account_id(&store, account);
        let vault_keys = read_key_ref(&store, &account.vault_keys);

        let account_data = AccountUnlockData {
            account_id: account_id.clone(),
            email: email.clone(),
            encrypted_session: encrypted_session_b64,
            auth_token,
            vault_keys,
        };

        accounts_data.push(account_data);
        unlocked_account_ids.push(account_id);
        eprintln!("[Biometric Unlock All] ✓ Unlocked {}", email);
    }

    if accounts_data.is_empty() {
        return Err("No accounts could be unlocked".to_string());
    }

    // Sign the response with challenge to prevent replay attacks
    let signature = biometric_signature(challenge, accounts_data.len());

    eprintln!(
        "[Biometric Unlock All] ✓ Unlocked {} accounts, {} failed",
        unlocked_account_ids.len(),
        failed_account_ids.len()
    );

    Ok(BiometricUnlockAllMaterial {
        device_key: device_key_base64,
        signature,
        accounts: accounts_data,
        unlocked: unlocked_account_ids,
        failed: failed_account_ids,
    })
}

/// The lock state this process reports to the extension.
///
/// A struct rather than a `serde_json::Value` so the one caller reads typed
/// fields; the view publishes the resolved value, so there is nothing left to
/// default.
struct DesktopStatusView {
    locked: bool,
    unlocked_accounts: Vec<String>,
    timestamp: i64,
    autolock_timeout_ms: i64,
    theme: Option<String>,
}

/// Get current lock status of all accounts
async fn get_lock_status_internal(
    app_handle: &tauri::AppHandle,
) -> Result<DesktopStatusView, String> {
    use tauri_plugin_store::StoreExt;

    let store = app_handle
        .store("store.json")
        .map_err(|e| format!("Failed to access store: {}", e))?;

    // UI appearance preference (app-wide, mirrors the frontend's next-themes
    // value). Rust-owned, so it is not part of the published view. Absent until
    // the frontend syncs it via `set_ui_theme`.
    let theme = read_store_string(&store, UI_THEME_KEY);

    // Without a usable view nothing is unlocked, which is the safe *and* honest
    // answer: the app has not initialised, so no MUK is in memory either. The
    // auto-lock timeout is reported as 0, meaning "unknown" rather than a made
    // up interval the user never chose.
    let (unlocked_accounts, autolock_timeout_ms) = match load_native_view(&store) {
        Ok(view) => (view.unlocked_account_ids, view.auto_lock_timeout_ms),
        Err(problem) => {
            eprintln!("[desktop-ipc] Reporting locked: {}", problem.message());
            (Vec::new(), 0)
        }
    };

    Ok(DesktopStatusView {
        locked: unlocked_accounts.is_empty(),
        unlocked_accounts,
        timestamp: now_timestamp_ms(),
        autolock_timeout_ms,
        theme,
    })
}

/// Bring the app window to foreground
fn open_app_internal(app_handle: &tauri::AppHandle) -> Result<(), String> {
    use tauri::Manager;

    // Get the main window - try both "main" and the first available window
    let window = app_handle
        .get_webview_window("main")
        .or_else(|| app_handle.webview_windows().values().next().cloned())
        .ok_or("No window found")?;

    // Show the window if hidden
    window
        .show()
        .map_err(|e| format!("Failed to show window: {}", e))?;

    // Unminimize if minimized
    window
        .unminimize()
        .map_err(|e| format!("Failed to unminimize window: {}", e))?;

    // Bring to front
    window
        .set_focus()
        .map_err(|e| format!("Failed to focus window: {}", e))?;

    Ok(())
}

/// Get account list (works even when locked)
///
/// One entry of the accounts response the browser extension consumes. It is a
/// pure republication of the view's account entry: the extension stores the
/// result as its own `AccountMetadata`, so every field it needs is published
/// rather than defaulted or re-derived here.
#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct AccountsListEntry<'a> {
    account_id: &'a str,
    email: &'a str,
    user_id: &'a str,
    name: &'a str,
    secret_key_hint: &'a str,
    /// Omitted entirely when the view omitted it, so "no team" never arrives at
    /// the consumer as an empty string.
    #[serde(skip_serializing_if = "Option::is_none")]
    team_name: Option<&'a str>,
    /// Nullable rather than skipped: the consumer's field is `string | null`.
    team_avatar_url: Option<&'a str>,
    added_at: i64,
    last_active_at: i64,
    biometric_enabled: bool,
}

/// Every field here comes from the published view. Reaching into
/// `bittery_accounts_list` directly would put a second copy of the key scheme
/// back in this file.
async fn get_accounts_list_internal(
    app_handle: &tauri::AppHandle,
) -> Result<serde_json::Value, String> {
    use tauri_plugin_store::StoreExt;

    let store = app_handle
        .store("store.json")
        .map_err(|e| format!("Failed to access store: {}", e))?;

    // No view means no accounts. That is a clean empty answer, not an error:
    // the extension polls this endpoint before the desktop app has initialised.
    let view = match load_native_view(&store) {
        Ok(view) => view,
        Err(problem) => {
            eprintln!("[desktop-ipc] Reporting no accounts: {}", problem.message());
            return Ok(serde_json::json!({
                "accounts": Vec::<serde_json::Value>::new(),
                "active_account": serde_json::Value::Null,
                "unlocked_accounts": Vec::<String>::new(),
            }));
        }
    };

    let accounts = view
        .accounts
        .iter()
        .map(|account| AccountsListEntry {
            account_id: &account.account_id,
            email: &account.email,
            user_id: &account.user_id,
            name: &account.name,
            secret_key_hint: &account.secret_key_hint,
            team_name: account.team_name.as_deref(),
            team_avatar_url: account.team_avatar_url.as_deref(),
            added_at: account.added_at,
            last_active_at: account.last_active_at,
            biometric_enabled: account.biometric_enabled,
        })
        .collect::<Vec<_>>();

    Ok(serde_json::json!({
        "accounts": accounts,
        "active_account": view.active_account_id,
        "unlocked_accounts": view.unlocked_account_ids,
    }))
}

/// Get vault keys for a specific stable account ID.
async fn get_vault_keys_internal(
    app_handle: &tauri::AppHandle,
    account_id: Option<String>,
) -> Result<serde_json::Value, String> {
    use tauri_plugin_store::StoreExt;

    let store = app_handle
        .store("store.json")
        .map_err(|e| format!("Failed to access store: {}", e))?;
    let view = load_native_view(&store).map_err(|problem| problem.message())?;

    let account_id = account_id
        .or_else(|| view.active_account_id.clone())
        .ok_or("No account specified")?;
    let account = view.account(&account_id).ok_or("Account not found")?;
    let vault_keys = read_key_ref(&store, &account.vault_keys).ok_or("Vault keys not found")?;

    Ok(serde_json::json!({
        "accountId": account_id,
        "email": account.email,
        "vault_keys": vault_keys,
    }))
}

/// Tauri command to broadcast lock event to extension
#[tauri::command]
fn broadcast_lock_event(
    state: tauri::State<Arc<DesktopIpcState>>,
    reason: String,
) -> Result<(), String> {
    let timestamp = now_timestamp_ms();

    let event = LockEvent::Lock {
        reason: reason.clone(),
        timestamp,
    };

    let _ = state.lock_events.send(event);

    eprintln!("[Lock Event] Broadcast lock event (reason: {})", reason);
    Ok(())
}

/// Tauri command to broadcast unlock event to extension
#[tauri::command]
fn broadcast_unlock_event(
    state: tauri::State<Arc<DesktopIpcState>>,
    accounts: Vec<String>,
) -> Result<(), String> {
    let timestamp = now_timestamp_ms();

    let event = LockEvent::Unlock {
        accounts: accounts.clone(),
        timestamp,
    };

    let _ = state.lock_events.send(event);

    eprintln!(
        "[Unlock Event] Broadcast unlock event (accounts: {:?})",
        accounts
    );
    Ok(())
}

/// Tauri command to broadcast active account changed event to extension
#[tauri::command]
fn broadcast_active_account_changed(
    state: tauri::State<Arc<DesktopIpcState>>,
    account_id: String,
) -> Result<(), String> {
    let timestamp = now_timestamp_ms();

    let event = LockEvent::ActiveAccountChanged {
        account_id: account_id.clone(),
        timestamp,
    };

    let _ = state.lock_events.send(event);

    eprintln!(
        "[Active Account Changed] Broadcast active account changed event (accountId: {})",
        account_id
    );
    Ok(())
}

/// Tauri command to persist the UI appearance preference and notify subscribed
/// extensions. The desktop frontend calls this whenever its next-themes value
/// changes so the value is available to the native host (and survives restarts)
/// even before the frontend window has loaded.
#[tauri::command]
fn set_ui_theme(
    app_handle: tauri::AppHandle,
    state: tauri::State<Arc<DesktopIpcState>>,
    theme: String,
) -> Result<(), String> {
    use tauri_plugin_store::StoreExt;

    // Only accept known values so the stored preference stays well-formed.
    if !matches!(theme.as_str(), "light" | "dark" | "system") {
        return Err(format!("Invalid theme value: {}", theme));
    }

    let store = app_handle
        .store("store.json")
        .map_err(|e| format!("Failed to access store: {}", e))?;
    store.set(UI_THEME_KEY, serde_json::Value::String(theme.clone()));
    store
        .save()
        .map_err(|e| format!("Failed to persist theme: {}", e))?;

    let timestamp = now_timestamp_ms();
    let event = LockEvent::ThemeChanged {
        theme: theme.clone(),
        timestamp,
    };
    let _ = state.lock_events.send(event);

    eprintln!("[UI Theme] Set UI theme to {}", theme);
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_biometry::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .invoke_handler(tauri::generate_handler![
            // Crypto commands
            crypto_commands::crypto_derive_keys,
            crypto_commands::crypto_encrypt,
            crypto_commands::crypto_encrypt_with_context,
            crypto_commands::crypto_decrypt,
            crypto_commands::crypto_decrypt_with_context,
            crypto_commands::crypto_validate_kdf_profile,
            crypto_commands::crypto_generate_encryption_key,
            crypto_commands::crypto_generate_uuid,
            crypto_commands::crypto_generate_rsa_key_pair,
            crypto_commands::crypto_rsa_encrypt,
            crypto_commands::crypto_rsa_decrypt,
            crypto_commands::crypto_generate_secret_key,
            crypto_commands::crypto_validate_secret_key,
            crypto_commands::crypto_get_secret_key_hint,
            crypto_commands::crypto_srp_generate_salt,
            crypto_commands::crypto_srp_derive_safe_private_key,
            crypto_commands::crypto_srp_derive_verifier,
            crypto_commands::crypto_srp_generate_ephemeral,
            crypto_commands::crypto_srp_derive_session,
            crypto_commands::crypto_srp_verify_session,
            // Key rotation commands
            crypto_commands::crypto_encrypt_vault_key_for_member,
            crypto_commands::crypto_encrypt_vault_key_with_muk,
            crypto_commands::crypto_re_encrypt_item,
            crypto_commands::crypto_perform_key_rotation,
            crypto_commands::crypto_validate_rotation_data,
            // Keychain commands (OS secure storage)
            keychain::keychain_set,
            keychain::keychain_get,
            keychain::keychain_delete,
            // Lock event broadcasting
            broadcast_lock_event,
            broadcast_unlock_event,
            broadcast_active_account_changed,
            set_ui_theme,
        ])
        .setup(|app| {
            // In development mode, always reinstall to pick up changes
            // In production, only install if missing
            #[cfg(debug_assertions)]
            let should_install = true;

            #[cfg(not(debug_assertions))]
            let should_install = !native_messaging_installer::is_installed();

            if should_install {
                #[cfg(debug_assertions)]
                eprintln!("🔧 [DEV MODE] (Re)installing native messaging host...");

                #[cfg(not(debug_assertions))]
                eprintln!("🔧 First run detected - installing native messaging host...");

                match native_messaging_installer::install_native_messaging_host(app.handle()) {
                    Ok(_) => {
                        eprintln!("✅ Native messaging host installed successfully!");
                        eprintln!("   Browser extension can now use biometric unlock!");
                    }
                    Err(e) => {
                        eprintln!("⚠️  Failed to install native messaging host: {}", e);
                        eprintln!("   To enable biometric unlock, build the native host:");
                        eprintln!(
                            "   cd src-tauri && cargo build --release --bin bittery-native-host"
                        );
                        eprintln!("   Then restart the app.");
                    }
                }
            } else {
                eprintln!("✅ Native messaging host already installed");
            }

            let ipc_state = Arc::new(DesktopIpcState::default());
            app.manage(ipc_state.clone());

            let app_handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                start_desktop_ipc_server(app_handle, ipc_state).await;
            });

            Ok(())
        })
        .on_window_event(|window, event| match event {
            tauri::WindowEvent::CloseRequested { .. } | tauri::WindowEvent::Destroyed => {
                eprintln!("[Window Event] Window closing, broadcasting desktop_close event");

                if let Some(state) = window.app_handle().try_state::<Arc<DesktopIpcState>>() {
                    let timestamp = now_timestamp_ms();
                    let event = LockEvent::DesktopClose { timestamp };
                    let _ = state.lock_events.send(event);
                } else {
                    eprintln!("[Window Event] Failed to get DesktopIpcState");
                }
            }
            _ => {}
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::{
        biometric_signature, build_snapshot_item_payload, decode_records, parse_native_view,
        read_key_ref_with, records_under_prefix, serialize_encryption_context,
        unwrap_plaintext_with_context, CachedItemRecord, CachedVaultRecord, NativeKeyStore,
        NativeViewProblem, CONTEXT_ENVELOPE_MARKER, NATIVE_VIEW_VERSION,
    };

    #[test]
    fn biometric_signature_binds_the_issued_challenge_and_material() {
        let signature = biometric_signature("challenge-1", "encrypted-session");

        assert_eq!(signature, "Y2hhbGxlbmdlLTE6ZW5jcnlwdGVkLXNlc3Npb24=");
        assert_ne!(
            signature,
            biometric_signature("challenge-2", "encrypted-session")
        );
        assert_ne!(
            signature,
            biometric_signature("challenge-1", "other-session")
        );
    }

    // ----------------------------------------------------------------------
    // The published native-host view
    // ----------------------------------------------------------------------

    /// A document shaped exactly like the one `account-store.ts` writes: two
    /// accounts, secret-tier refs for the four per-account secrets and for the
    /// device key, and fully-resolved `record:` prefixes.
    fn native_view_document(version: u64) -> String {
        serde_json::json!({
            "v": version,
            "activeAccountId": "acct-a",
            "unlockedAccountIds": ["acct-a"],
            "autoLockTimeoutMs": 300000,
            "deviceKey": { "key": "bittery_device_key", "store": "secret" },
            "accounts": [
                {
                    "accountId": "acct-a",
                    "email": "alice@example.com",
                    "userId": "user-a",
                    "name": "Alice Example",
                    "secretKeyHint": "A3-XXXXXX",
                    "teamName": "Acme",
                    "teamAvatarUrl": "https://cdn.example.com/acme.png",
                    "addedAt": 1700000000000i64,
                    "lastActiveAt": 1700000009999i64,
                    "biometricEnabled": true,
                    "token": { "key": "bittery_account_acct-a_jwt_token", "store": "secret" },
                    "sessionData": { "key": "bittery_account_acct-a_session_data", "store": "secret" },
                    "vaultKeys": { "key": "bittery_account_acct-a_vault_keys", "store": "secret" },
                    "encryptedPrivateKey": { "key": "bittery_account_acct-a_encrypted_private_key", "store": "secret" },
                    "itemsKeyPrefix": "record:acct-a:items:",
                    "vaultsKeyPrefix": "record:acct-a:vaults:"
                },
                // No team fields at all: the optional half must survive being absent.
                {
                    "accountId": "acct-b",
                    "email": "bob@example.com",
                    "userId": "user-b",
                    "name": "Bob Example",
                    "secretKeyHint": "A3-YYYYYY",
                    "addedAt": 1700000000001i64,
                    "lastActiveAt": 1700000009998i64,
                    "biometricEnabled": false,
                    "token": { "key": "bittery_account_acct-b_jwt_token", "store": "secret" },
                    "sessionData": { "key": "bittery_account_acct-b_session_data", "store": "secret" },
                    "vaultKeys": { "key": "bittery_account_acct-b_vault_keys", "store": "secret" },
                    "encryptedPrivateKey": { "key": "bittery_account_acct-b_encrypted_private_key", "store": "secret" },
                    "itemsKeyPrefix": "record:acct-b:items:",
                    "vaultsKeyPrefix": "record:acct-b:vaults:"
                }
            ]
        })
        .to_string()
    }

    #[test]
    fn parse_native_view_reads_a_representative_document() {
        let view = parse_native_view(Some(native_view_document(NATIVE_VIEW_VERSION)))
            .expect("the published document must parse");

        assert_eq!(view.v, NATIVE_VIEW_VERSION);
        assert_eq!(view.active_account_id.as_deref(), Some("acct-a"));
        assert_eq!(view.unlocked_account_ids, vec!["acct-a".to_string()]);
        // The resolved timeout, not a Rust-side default.
        assert_eq!(view.auto_lock_timeout_ms, 300000);
        assert_eq!(view.device_key.key, "bittery_device_key");
        assert_eq!(view.device_key.store, NativeKeyStore::Secret);

        assert!(view.is_unlocked("acct-a"));
        assert!(!view.is_unlocked("acct-b"));

        let alice = view.account("acct-a").expect("acct-a must be published");
        assert_eq!(alice.email, "alice@example.com");
        // The displayable metadata the extension stores verbatim.
        assert_eq!(alice.user_id, "user-a");
        assert_eq!(alice.name, "Alice Example");
        assert_eq!(alice.secret_key_hint, "A3-XXXXXX");
        assert_eq!(alice.team_name.as_deref(), Some("Acme"));
        assert_eq!(
            alice.team_avatar_url.as_deref(),
            Some("https://cdn.example.com/acme.png")
        );
        assert_eq!(alice.added_at, 1700000000000);
        assert_eq!(alice.last_active_at, 1700000009999);
        assert!(alice.biometric_enabled);
        assert_eq!(alice.token.key, "bittery_account_acct-a_jwt_token");
        assert_eq!(alice.session_data.store, NativeKeyStore::Secret);
        assert_eq!(alice.items_key_prefix, "record:acct-a:items:");
        assert_eq!(alice.vaults_key_prefix, "record:acct-a:vaults:");

        // A published `false` is honoured; nothing here defaults it to `true`.
        let bob = view.account("acct-b").expect("acct-b must be published");
        assert!(!bob.biometric_enabled);
        // An omitted optional stays omitted; nothing here invents a placeholder.
        assert_eq!(bob.team_name, None);
        assert_eq!(bob.team_avatar_url, None);

        assert!(view.account("acct-missing").is_none());
    }

    #[test]
    fn parse_native_view_reports_an_absent_document() {
        let problem =
            parse_native_view(None).expect_err("an absent document must not parse to a view");

        assert_eq!(problem, NativeViewProblem::Absent);
    }

    #[test]
    fn parse_native_view_refuses_an_unknown_version() {
        // A future writer may change what the fields mean, so a version this
        // build does not know must be refused rather than misread.
        let problem = parse_native_view(Some(native_view_document(99)))
            .expect_err("an unknown schema version must be refused");

        match problem {
            NativeViewProblem::Unreadable(detail) => {
                assert!(detail.contains("unsupported schema version 99"), "{detail}");
            }
            other => panic!("expected Unreadable, got {other:?}"),
        }
    }

    #[test]
    fn parse_native_view_refuses_malformed_json() {
        let problem = parse_native_view(Some("not json".to_string()))
            .expect_err("malformed JSON must be refused");

        assert!(matches!(problem, NativeViewProblem::Unreadable(_)));
    }

    #[test]
    fn key_refs_route_to_the_store_they_name() {
        let view = parse_native_view(Some(native_view_document(NATIVE_VIEW_VERSION)))
            .expect("the published document must parse");
        let alice = view.account("acct-a").expect("acct-a must be published");

        // A "secret" ref must reach the keychain and never the store.
        let resolved = read_key_ref_with(
            &alice.token,
            |key| Some(format!("keychain:{key}")),
            |_| panic!("a secret ref must not be read from store.json"),
        );
        assert_eq!(
            resolved.as_deref(),
            Some("keychain:bittery_account_acct-a_jwt_token")
        );

        // A "plain" ref must reach store.json and never the keychain.
        let plain = super::NativeKeyRef {
            key: "bittery_native_view".to_string(),
            store: NativeKeyStore::Plain,
        };
        let resolved = read_key_ref_with(
            &plain,
            |_| panic!("a plain ref must not be read from the keychain"),
            |key| Some(format!("store:{key}")),
        );
        assert_eq!(resolved.as_deref(), Some("store:bittery_native_view"));
    }

    // ----------------------------------------------------------------------
    // Record prefix scan
    // ----------------------------------------------------------------------

    #[test]
    fn records_under_prefix_selects_only_the_published_prefix() {
        let entries = vec![
            (
                "record:acct-a:items:item-1".to_string(),
                serde_json::json!("one"),
            ),
            (
                "record:acct-a:items:item-2".to_string(),
                serde_json::json!("two"),
            ),
            // Same account, different collection.
            (
                "record:acct-a:vaults:vault-1".to_string(),
                serde_json::json!("vault"),
            ),
            // Same collection, different account.
            (
                "record:acct-b:items:item-3".to_string(),
                serde_json::json!("other"),
            ),
            // Not a record at all.
            ("bittery_native_view".to_string(), serde_json::json!("view")),
            // A non-string value is not a record this port ever wrote.
            (
                "record:acct-a:items:item-4".to_string(),
                serde_json::json!(42),
            ),
        ];

        let found = records_under_prefix(entries, "record:acct-a:items:");

        assert_eq!(found, vec!["one".to_string(), "two".to_string()]);
    }

    #[test]
    fn decode_records_skips_corrupt_entries() {
        let raw = vec![
            r#"{"id":"vault-1","name":"Main","type":"personal","icon":null,"imageUrl":null}"#
                .to_string(),
            "{ not json".to_string(),
            r#"{"id":"vault-2","name":"Shared","type":"team","icon":null,"imageUrl":null}"#
                .to_string(),
        ];

        let vaults: Vec<CachedVaultRecord> = decode_records(raw, "vault");

        assert_eq!(vaults.len(), 2);
        assert_eq!(vaults[0].id, "vault-1");
        assert_eq!(vaults[1].id, "vault-2");
    }

    #[test]
    fn unwrap_plaintext_with_context_accepts_matching_envelope() {
        let decrypted = serde_json::json!({
            "marker": CONTEXT_ENVELOPE_MARKER,
            "context": serialize_encryption_context("vault-1", "item-1", "item", 2, "user-1"),
            "payload": "{\"title\":\"Example\"}",
        })
        .to_string();

        let unwrapped =
            unwrap_plaintext_with_context(decrypted, "vault-1", "item-1", "item", 2, "user-1")
                .expect("expected envelope to unwrap");

        assert_eq!(unwrapped, "{\"title\":\"Example\"}");
    }

    #[test]
    fn unwrap_plaintext_with_context_rejects_mismatched_context() {
        let decrypted = serde_json::json!({
            "marker": CONTEXT_ENVELOPE_MARKER,
            "context": serialize_encryption_context("vault-1", "item-1", "item", 2, "user-1"),
            "payload": "{\"title\":\"Example\"}",
        })
        .to_string();

        let error =
            unwrap_plaintext_with_context(decrypted, "vault-1", "item-1", "item", 3, "user-1")
                .expect_err("expected context mismatch");

        assert_eq!(error, "Encryption context mismatch");
    }

    #[test]
    fn build_snapshot_item_payload_returns_none_for_invalid_json() {
        let item = CachedItemRecord {
            id: "item-1".to_string(),
            vault_id: "vault-1".to_string(),
            category: "login".to_string(),
            favorite: false,
            encrypted_data: "ciphertext".to_string(),
            encryption_iv: "iv".to_string(),
            encryption_algorithm: "AES-GCM-AAD-V1".to_string(),
            version: 1,
            last_modified_by: Some("user-1".to_string()),
            created_at: "2026-03-12T00:00:00.000Z".to_string(),
            updated_at: "2026-03-12T00:00:00.000Z".to_string(),
            deleted_at: None,
        };
        let vault = CachedVaultRecord {
            id: "vault-1".to_string(),
            name: "Main".to_string(),
            vault_type: "personal".to_string(),
            icon: None,
            image_url: None,
        };

        let payload = build_snapshot_item_payload(
            &item,
            "not-json",
            Some(&vault),
            false,
            "account-1",
            "alice@example.com",
            None,
        );

        assert!(payload.is_none());
    }

    #[test]
    fn build_snapshot_item_payload_includes_metadata_for_valid_json() {
        let item = CachedItemRecord {
            id: "item-1".to_string(),
            vault_id: "vault-1".to_string(),
            category: "login".to_string(),
            favorite: true,
            encrypted_data: "ciphertext".to_string(),
            encryption_iv: "iv".to_string(),
            encryption_algorithm: "AES-GCM-AAD-V1".to_string(),
            version: 1,
            last_modified_by: Some("user-1".to_string()),
            created_at: "2026-03-12T00:00:00.000Z".to_string(),
            updated_at: "2026-03-12T01:00:00.000Z".to_string(),
            deleted_at: None,
        };
        let vault = CachedVaultRecord {
            id: "vault-1".to_string(),
            name: "Main".to_string(),
            vault_type: "personal".to_string(),
            icon: Some("lock".to_string()),
            image_url: None,
        };
        let account = serde_json::json!({
            "email": "alice@example.com",
            "userId": "user-1",
            "name": "Alice",
        });

        let payload = build_snapshot_item_payload(
            &item,
            "{\"title\":\"Example\"}",
            Some(&vault),
            true,
            "account-1",
            "alice@example.com",
            Some(&account),
        )
        .expect("expected payload");

        assert_eq!(
            payload.get("id").and_then(|value| value.as_str()),
            Some("item-1")
        );
        assert_eq!(
            payload.get("title").and_then(|value| value.as_str()),
            Some("Example")
        );
        assert_eq!(
            payload
                .get("account")
                .and_then(|value| value.get("email"))
                .and_then(|value| value.as_str()),
            Some("alice@example.com")
        );
    }

    #[test]
    fn cached_vault_record_defaults_legacy_entries_to_personal_type() {
        let vault: CachedVaultRecord =
            serde_json::from_str(r#"{"id":"vault-1","name":"Main","icon":null,"imageUrl":null}"#)
                .expect("legacy cached vault should deserialize");

        assert_eq!(vault.vault_type, "personal");
    }

    // ----------------------------------------------------------------------
    // Dependency lock guard
    //
    // `tauri-runtime`, `tauri-runtime-wry` and `wry` are a matched triple: the
    // runtime declares the traits, tauri-runtime-wry implements them on top of
    // wry. Upstream has shipped source-breaking changes across them in a MINOR
    // bump -- tauri-runtime 2.10 -> 2.11 added
    // `WebviewDispatch::eval_script_with_callback` with no default body, and
    // dropped `Sync` from `NewWindowHandler`, which only compiles against a
    // wry whose `with_new_window_req_handler` no longer demands `Send + Sync`
    // (0.55, not 0.54). Nothing in Cargo.toml, where the only requirement is
    // `tauri = "2"`, stops cargo from resolving one of the three forward and
    // leaving the others behind. All three are transitive, and `wry` does not
    // even match a `tauri-*` Dependabot pattern, so no manifest pin or
    // grouping rule reaches it.
    //
    // Dependabot produced exactly that skew (tauri-runtime 2.11.3 against
    // tauri-runtime-wry 2.10.1 and wry 0.54.2), and it only surfaced as
    // E0046/E0277 after a full tauri build in CI. These checks read the
    // committed lock instead, so the next skew fails in milliseconds with an
    // actionable message.
    // ----------------------------------------------------------------------

    /// Minimal `[[package]]` reader. The lock is TOML, but pulling in a TOML
    /// parser as a dev-dependency just to read two version strings is not worth
    /// the added supply-chain surface, so walk the blocks directly.
    fn locked_versions(lock: &str, crate_name: &str) -> Vec<String> {
        let mut versions = Vec::new();
        let mut current: Option<String> = None;

        for line in lock.lines() {
            let line = line.trim();
            if line == "[[package]]" {
                current = None;
            } else if let Some(value) = line.strip_prefix("name = ") {
                current = unquoted(value).map(str::to_string);
            } else if let Some(value) = line.strip_prefix("version = ") {
                if current.as_deref() == Some(crate_name) {
                    if let Some(version) = unquoted(value) {
                        versions.push(version.to_string());
                    }
                }
            }
        }

        versions
    }

    fn unquoted(value: &str) -> Option<&str> {
        value.strip_prefix('"')?.strip_suffix('"')
    }

    /// `"2.11.3"` -> `"2.11"`. Cargo treats a 2.x minor bump as compatible, so
    /// the minor is the granularity at which this pair actually has to agree.
    fn major_minor(version: &str) -> &str {
        match version.match_indices('.').nth(1) {
            Some((index, _)) => &version[..index],
            None => version,
        }
    }

    /// Resolves a crate to its single locked version, treating "absent" and
    /// "resolved more than once" as failures rather than passing quietly. A
    /// guard that no-ops when it stops understanding the lock is worse than no
    /// guard at all.
    fn sole_locked_version(lock: &str, crate_name: &str) -> Result<String, String> {
        let mut versions = locked_versions(lock, crate_name);

        match versions.len() {
            1 => Ok(versions.remove(0)),
            0 => Err(format!(
                "Cargo.lock contains no `{crate_name}` entry. Either the lock is missing or \
                 unparseable, or the dependency graph changed shape -- this guard must be \
                 updated deliberately rather than left silently passing."
            )),
            _ => Err(format!(
                "Cargo.lock resolved `{crate_name}` to more than one version ({}). The tauri \
                 family must appear exactly once each.",
                versions.join(", ")
            )),
        }
    }

    /// The `wry` requirement each `tauri-runtime-wry` minor declares, keyed by
    /// that minor and taken from the published manifests.
    ///
    /// Cargo.lock records *resolved* versions and bare dependency names, never
    /// requirement ranges, so the declared `wry = "^0.55.0"` genuinely cannot
    /// be read back out of the lock. It is mirrored here instead. Each entry
    /// uses the lowest floor declared across that minor's patch releases, so
    /// the check can only ever be too lenient, never falsely red.
    ///
    /// An unrecognised `tauri-runtime-wry` minor is a hard failure rather than
    /// a silent pass: a minor bump is precisely the moment a human should
    /// re-check this pairing and extend the table.
    const TAURI_RUNTIME_WRY_TO_WRY: &[(&str, &str)] =
        &[("2.9", "^0.53.4"), ("2.10", "^0.54.0"), ("2.11", "^0.55.0")];

    fn parse_version(version: &str) -> Option<(u64, u64, u64)> {
        // Ignore any pre-release/build suffix; the tauri family does not use
        // one, and a numeric prefix is all this comparison needs.
        let core = version
            .split(['-', '+'])
            .next()
            .unwrap_or_default()
            .trim_start_matches('^');
        let mut parts = core.split('.');
        let major = parts.next()?.parse().ok()?;
        let minor = parts.next()?.parse().ok()?;
        let patch = parts.next().unwrap_or("0").parse().ok()?;

        Some((major, minor, patch))
    }

    /// Cargo caret semantics, including the 0.x rule that makes this guard
    /// necessary: `^0.55.0` admits 0.55.x but *not* 0.56.0, because for a 0.x
    /// crate the minor is the breaking-change axis.
    fn caret_admits(requirement: &str, version: &str) -> Option<bool> {
        let (req_major, req_minor, req_patch) = parse_version(requirement)?;
        let (major, minor, patch) = parse_version(version)?;

        if major != req_major {
            return Some(false);
        }

        if req_major == 0 {
            return Some(minor == req_minor && patch >= req_patch);
        }

        Some((minor, patch) >= (req_minor, req_patch))
    }

    fn tauri_family_is_coherent(lock: &str) -> Result<(), String> {
        let runtime = sole_locked_version(lock, "tauri-runtime")?;
        let runtime_wry = sole_locked_version(lock, "tauri-runtime-wry")?;
        let wry = sole_locked_version(lock, "wry")?;

        if major_minor(&runtime) != major_minor(&runtime_wry) {
            return Err(format!(
                "Cargo.lock resolved tauri-runtime {runtime} against tauri-runtime-wry \
                 {runtime_wry}. Upstream only supports these two crates at the same minor \
                 version; a split does not compile (E0046: `eval_script_with_callback` is \
                 unimplemented, E0277: `NewWindowHandler` is no longer `Sync`). Do not pin \
                 one crate back -- re-resolve the whole family together from \
                 apps/desktop/src-tauri, e.g. `cargo update -p tauri --precise <latest 2.x>`, \
                 then re-run `cargo check --all-targets`."
            ));
        }

        let minor = major_minor(&runtime_wry);
        let requirement = TAURI_RUNTIME_WRY_TO_WRY
            .iter()
            .find(|(known, _)| *known == minor)
            .map(|(_, requirement)| *requirement)
            .ok_or_else(|| {
                format!(
                    "This guard has no recorded `wry` requirement for tauri-runtime-wry \
                     {runtime_wry}. Look up the `wry` requirement that tauri-runtime-wry \
                     {minor}.x declares (`cargo tree -p tauri-runtime-wry`, or its manifest on \
                     crates.io) and add it to TAURI_RUNTIME_WRY_TO_WRY. Do not delete this \
                     check -- a tauri-runtime-wry minor bump is exactly when the wry pairing \
                     needs verifying."
                )
            })?;

        let admitted = caret_admits(requirement, &wry).ok_or_else(|| {
            format!("could not compare wry {wry} against the requirement {requirement}")
        })?;

        if admitted {
            return Ok(());
        }

        Err(format!(
            "Cargo.lock resolved wry {wry}, but tauri-runtime-wry {runtime_wry} declares \
             `wry = \"{requirement}\"`. wry is 0.x, so a minor bump is breaking: 0.54 requires \
             `Send + Sync` on `with_new_window_req_handler` while tauri-runtime 2.11 dropped \
             `Sync` from `NewWindowHandler` (E0277). wry is transitive and matches no \
             `tauri-*` grouping pattern, so re-resolve the family together from \
             apps/desktop/src-tauri, e.g. `cargo update -p tauri --precise <latest 2.x>`, then \
             re-run `cargo check --all-targets`."
        ))
    }

    /// Builds a lock fixture shaped like the real `[[package]]` blocks,
    /// including a `dependencies` list so the parser is exercised against
    /// entries that merely *mention* these crate names.
    fn lock_fixture(runtime: &str, runtime_wry: &str, wry: &str) -> String {
        format!(
            r#"
[[package]]
name = "tauri-runtime"
version = "{runtime}"
source = "registry+https://github.com/rust-lang/crates.io-index"

[[package]]
name = "tauri-runtime-wry"
version = "{runtime_wry}"
source = "registry+https://github.com/rust-lang/crates.io-index"
dependencies = [
 "tauri-runtime",
 "wry",
]

[[package]]
name = "wry"
version = "{wry}"
source = "registry+https://github.com/rust-lang/crates.io-index"
"#
        )
    }

    #[test]
    fn committed_cargo_lock_resolves_the_tauri_family_coherently() {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("Cargo.lock");
        let lock = std::fs::read_to_string(&path)
            .unwrap_or_else(|error| panic!("could not read {}: {error}", path.display()));

        if let Err(problem) = tauri_family_is_coherent(&lock) {
            panic!("{problem}");
        }
    }

    #[test]
    fn tauri_family_guard_rejects_the_skew_from_pr_91() {
        // The exact resolution Dependabot produced in PR #91.
        let problem = tauri_family_is_coherent(&lock_fixture("2.11.3", "2.10.1", "0.54.2"))
            .expect_err("the PR #91 resolution must be rejected");

        // The message has to stand on its own for whoever trips it later.
        assert!(problem.contains("tauri-runtime 2.11.3"), "{problem}");
        assert!(problem.contains("tauri-runtime-wry 2.10.1"), "{problem}");
        assert!(
            problem.contains("cargo update -p tauri --precise"),
            "{problem}"
        );
    }

    #[test]
    fn tauri_family_guard_rejects_a_wry_only_skew() {
        // The runtime pair agrees, so a two-crate check would pass this --
        // but wry 0.54 still demands `Send + Sync` and will not compile.
        let problem = tauri_family_is_coherent(&lock_fixture("2.11.3", "2.11.4", "0.54.2"))
            .expect_err("wry 0.54 against tauri-runtime-wry 2.11 must be rejected");

        assert!(problem.contains("wry 0.54.2"), "{problem}");
        assert!(problem.contains("^0.55.0"), "{problem}");
    }

    #[test]
    fn tauri_family_guard_accepts_the_committed_combination() {
        assert!(tauri_family_is_coherent(&lock_fixture("2.11.3", "2.11.4", "0.55.1")).is_ok());
        // The pairing shipped on main before this bump.
        assert!(tauri_family_is_coherent(&lock_fixture("2.9.2", "2.9.3", "0.53.5")).is_ok());
    }

    #[test]
    fn tauri_family_guard_fails_loudly_on_an_unknown_tauri_runtime_wry_minor() {
        // A future minor whose wry requirement nobody has verified yet must
        // stop the build rather than wave the resolution through.
        let problem = tauri_family_is_coherent(&lock_fixture("2.12.0", "2.12.0", "0.56.0"))
            .expect_err("an unrecorded minor must not pass");

        assert!(problem.contains("TAURI_RUNTIME_WRY_TO_WRY"), "{problem}");
    }

    #[test]
    fn tauri_family_guard_fails_loudly_on_an_unparseable_lock() {
        let problem =
            tauri_family_is_coherent("").expect_err("an empty or unreadable lock must not pass");

        assert!(problem.contains("no `tauri-runtime` entry"), "{problem}");
    }

    #[test]
    fn tauri_family_guard_rejects_a_crate_resolved_twice() {
        let fixture = lock_fixture("2.11.3", "2.11.4", "0.55.1");
        let lock = format!("{fixture}\n{fixture}");

        let problem = tauri_family_is_coherent(&lock)
            .expect_err("two resolutions of one crate must not pass");

        assert!(problem.contains("more than one version"), "{problem}");
    }

    #[test]
    fn caret_admits_applies_the_zero_major_rule_that_wry_depends_on() {
        // 0.x: the minor is the breaking axis, so ^0.55.0 must not admit 0.56.
        assert_eq!(caret_admits("^0.55.0", "0.55.0"), Some(true));
        assert_eq!(caret_admits("^0.55.0", "0.55.1"), Some(true));
        assert_eq!(caret_admits("^0.55.0", "0.56.0"), Some(false));
        assert_eq!(caret_admits("^0.55.0", "0.54.2"), Some(false));
        assert_eq!(caret_admits("^0.53.4", "0.53.2"), Some(false));

        // >=1.0: the major is the breaking axis.
        assert_eq!(caret_admits("^2.11.3", "2.12.0"), Some(true));
        assert_eq!(caret_admits("^2.11.3", "2.11.2"), Some(false));
        assert_eq!(caret_admits("^2.11.3", "3.0.0"), Some(false));
    }

    #[test]
    fn locked_versions_does_not_confuse_dependency_lists_with_packages() {
        // `dependencies = [ "tauri-runtime", ... ]` entries must not be
        // mistaken for package declarations.
        let versions =
            locked_versions(&lock_fixture("2.11.3", "2.11.4", "0.55.1"), "tauri-runtime");

        assert_eq!(versions, vec!["2.11.3".to_string()]);
    }
}
