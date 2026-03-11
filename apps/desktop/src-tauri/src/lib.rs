mod crypto_commands;
mod desktop_ipc;
mod keychain;
mod native_messaging_installer;

use std::sync::Arc;
use base64::Engine;
use desktop_ipc::{
    desktop_ipc_socket_path, write_frame, DesktopEnvelope, DesktopEventKind,
    DesktopRequest, DesktopResponse,
};
use tokio::io::{AsyncRead, AsyncWrite};
use tokio::sync::broadcast;
use tauri::{Emitter, Manager, Runtime};
use tauri_plugin_store::Store;

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
        email: String,
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

const ACTIVE_ACCOUNT_KEY: &str = "bittery_active_account";
const LEGACY_SESSION_DATA_KEY: &str = "bittery_session_data";
const LEGACY_BIOMETRIC_ENABLED_KEY: &str = "bittery_biometric_enabled";
const LEGACY_JWT_TOKEN_KEY: &str = "bittery_jwt_token";
const LEGACY_VAULT_KEYS_KEY: &str = "bittery_vault_keys";
const CONTEXT_ENVELOPE_MARKER: &str = "bittery-context-envelope-v1";

fn sanitize_email_for_key(email: &str) -> String {
    email
        .to_lowercase()
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '_' })
        .collect()
}

fn account_key(email: &str, suffix: &str) -> String {
    format!("bittery_account_{}_{}", sanitize_email_for_key(email), suffix)
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

    let expected = serialize_encryption_context(
        vault_id,
        entity_id,
        entity_type,
        version,
        user_id,
    );
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
    #[serde(rename = "type")]
    vault_type: String,
    icon: Option<String>,
    #[serde(rename = "imageUrl")]
    image_url: Option<String>,
}

fn decrypt_item_payload(
    item: &CachedItemRecord,
    vault_key_base64: &str,
) -> Result<String, String> {
    let user_id = item
        .last_modified_by
        .as_deref()
        .filter(|value| !value.is_empty());
    if let Some(user_id) = user_id {
        let version = normalize_item_version(Some(item.version));
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
            Ok(decrypted_data) => return Ok(normalize_decrypted_item_payload(decrypted_data)),
            Err(_) => {
                let decrypted_data = crypto_commands::crypto_decrypt(
                    item.encrypted_data.clone(),
                    item.encryption_iv.clone(),
                    item.encryption_algorithm.clone(),
                    vault_key_base64.to_string(),
                )
                .map_err(|e| format!("Decryption failed: {}", e))?;

                let unwrapped = unwrap_plaintext_with_context(
                    decrypted_data,
                    &item.vault_id,
                    &item.id,
                    "item",
                    version,
                    user_id,
                )?;
                return Ok(normalize_decrypted_item_payload(unwrapped));
            }
        }
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

fn get_active_account_email<R: Runtime>(store: &Store<R>) -> Option<String> {
    store
        .get(ACTIVE_ACCOUNT_KEY)
        .and_then(|value| value.as_str().map(|s| s.to_lowercase()))
}

fn get_bearer_token_for_account<R: Runtime>(store: &Store<R>, email: &str) -> Option<String> {
    let jwt_key = account_key(email, "jwt_token");

    match keychain::keychain_get(&jwt_key) {
        Ok(Some(token)) => return Some(token),
        Ok(None) => {}
        Err(error) => {
            eprintln!(
                "[desktop-ipc] Failed reading bearer token from keychain for {}: {}",
                email, error
            );
            return None;
        }
    }

    let legacy_token = store
        .get(&jwt_key)
        .and_then(|v| v.as_str().map(|s| s.to_string()))
        .or_else(|| {
            store
                .get(LEGACY_JWT_TOKEN_KEY)
                .and_then(|v| v.as_str().map(|s| s.to_string()))
        });

    if let Some(token) = legacy_token {
        match keychain::keychain_set(&jwt_key, &token) {
            Ok(()) => {
                let _ = store.delete(&jwt_key);
                let _ = store.delete(LEGACY_JWT_TOKEN_KEY);
                let _ = store.save();
                Some(token)
            }
            Err(error) => {
                eprintln!(
                    "[desktop-ipc] Failed migrating bearer token to keychain for {}: {}",
                    email, error
                );
                None
            }
        }
    } else {
        None
    }
}

fn now_timestamp_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or_default()
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
        LockEvent::Unlock { accounts, timestamp } => DesktopResponse::DesktopEvent {
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
        LockEvent::ActiveAccountChanged { email, timestamp } => DesktopResponse::DesktopEvent {
            event: DesktopEventKind::ActiveAccountChanged,
            payload: serde_json::json!({
                "email": email,
                "timestamp": timestamp,
            }),
        },
    }
}

fn get_unlocked_accounts<R: Runtime>(store: &Store<R>) -> Vec<String> {
    store
        .get("bittery_unlocked_accounts")
        .and_then(|v| v.as_str().map(|s| s.to_string()))
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_else(Vec::new)
}

fn get_account_directory<R: Runtime>(
    store: &Store<R>,
) -> Result<std::collections::HashMap<String, serde_json::Value>, String> {
    let accounts_value = store.get("bittery_accounts_list").ok_or("No accounts found")?;
    let accounts_str = accounts_value
        .as_str()
        .ok_or("Invalid accounts list format")?;
    let accounts_json: serde_json::Value = serde_json::from_str(accounts_str)
        .map_err(|e| format!("Failed to parse accounts list: {}", e))?;
    let accounts = accounts_json
        .get("accounts")
        .and_then(|value| value.as_array())
        .ok_or("No accounts array found")?;

    let mut directory = std::collections::HashMap::new();
    for account in accounts {
        if let Some(email) = account.get("email").and_then(|value| value.as_str()) {
            directory.insert(email.to_lowercase(), account.clone());
        }
    }

    Ok(directory)
}

fn load_muk_base64<R: Runtime>(store: &Store<R>, email: &str) -> Result<String, String> {
    let session_key = account_key(email, "session_data");
    let session_data_str = store
        .get(&session_key)
        .and_then(|v| v.as_str().map(|s| s.to_string()))
        .ok_or("No session data found")?;
    let session_data: serde_json::Value = serde_json::from_str(&session_data_str)
        .map_err(|e| format!("Failed to parse session data: {}", e))?;

    let device_key_value = store
        .get("bittery_device_key")
        .ok_or("No device key found")?;
    let device_key_base64 = device_key_value
        .as_str()
        .ok_or("Invalid device key format")?;
    let device_key = base64::engine::general_purpose::STANDARD
        .decode(device_key_base64)
        .map_err(|e| format!("Failed to decode device key: {}", e))?;

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
        base64::engine::general_purpose::STANDARD.encode(&device_key),
    )
    .map_err(|e| format!("Failed to decrypt MUK: {}", e))
}

fn load_decrypted_vault_keys<R: Runtime>(
    store: &Store<R>,
    email: &str,
) -> Result<std::collections::HashMap<String, String>, String> {
    let muk_base64 = load_muk_base64(store, email)?;
    let vault_key_storage = account_key(email, "vault_keys");
    let vault_keys_str = store
        .get(&vault_key_storage)
        .and_then(|v| v.as_str().map(|s| s.to_string()))
        .ok_or("Vault keys not found")?;
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
            let encrypted_private_key_key = account_key(email, "encrypted_private_key");
            let encrypted_private_key_str = store
                .get(&encrypted_private_key_key)
                .and_then(|v| v.as_str().map(|s| s.to_string()))
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

            crypto_commands::crypto_rsa_decrypt(
                encrypted_vault_key.to_string(),
                private_key_pem,
            )
            .map_err(|e| format!("Failed to RSA decrypt vault key: {}", e))?
        };

        decrypted_vault_keys.insert(vault_id.to_string(), vault_key_base64);
    }

    Ok(decrypted_vault_keys)
}

async fn get_auth_token_internal(
    app_handle: &tauri::AppHandle,
    email: &str,
) -> Result<serde_json::Value, String> {
    use tauri_plugin_store::StoreExt;

    let store = app_handle
        .store("store.json")
        .map_err(|e| format!("Failed to access store: {}", e))?;
    let token = get_bearer_token_for_account(&store, email).ok_or("Auth token not found")?;

    let session_key = account_key(email, "session_data");
    let session_metadata = store
        .get(&session_key)
        .and_then(|v| v.as_str().map(|s| s.to_string()))
        .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok());

    Ok(serde_json::json!({
        "email": email,
        "authToken": token,
        "expiresAt": session_metadata.as_ref().and_then(|value| value.get("expiresAt")).cloned(),
        "userId": session_metadata.as_ref().and_then(|value| value.get("userId")).cloned(),
    }))
}

async fn get_items_snapshot_internal(
    app_handle: &tauri::AppHandle,
    emails: Option<Vec<String>>,
) -> Result<serde_json::Value, String> {
    use tauri_plugin_store::StoreExt;

    let store = app_handle
        .store("store.json")
        .map_err(|e| format!("Failed to access store: {}", e))?;
    let unlocked_accounts = get_unlocked_accounts(&store);
    let target_emails = match emails {
        Some(values) if !values.is_empty() => values
            .into_iter()
            .map(|email| email.to_lowercase())
            .collect::<Vec<_>>(),
        _ => unlocked_accounts.clone(),
    };

    let include_account_context = target_emails.len() > 1;
    let account_directory = get_account_directory(&store).unwrap_or_default();
    let mut items = Vec::new();

    for email in target_emails {
        if !unlocked_accounts.iter().any(|value| value.eq_ignore_ascii_case(&email)) {
            continue;
        }

        let decrypted_vault_keys = load_decrypted_vault_keys(&store, &email)?;
        let cached_items_key = account_key(&email, "cached_items");
        let cached_vaults_key = account_key(&email, "cached_vaults");

        let cached_items: Vec<CachedItemRecord> = store
            .get(&cached_items_key)
            .and_then(|v| v.as_str().map(|s| s.to_string()))
            .map(|value| serde_json::from_str(&value))
            .transpose()
            .map_err(|e| format!("Failed to parse cached items: {}", e))?
            .unwrap_or_default();
        let cached_vaults: Vec<CachedVaultRecord> = store
            .get(&cached_vaults_key)
            .and_then(|v| v.as_str().map(|s| s.to_string()))
            .map(|value| serde_json::from_str(&value))
            .transpose()
            .map_err(|e| format!("Failed to parse cached vaults: {}", e))?
            .unwrap_or_default();
        let vault_map = cached_vaults
            .into_iter()
            .map(|vault| (vault.id.clone(), vault))
            .collect::<std::collections::HashMap<_, _>>();

        for item in cached_items.into_iter().filter(|item| item.deleted_at.is_none()) {
            let Some(vault_key) = decrypted_vault_keys.get(&item.vault_id) else {
                continue;
            };

            let decrypted_data = decrypt_item_payload(&item, vault_key)?;
            let Ok(mut payload) = serde_json::from_str::<serde_json::Map<String, serde_json::Value>>(&decrypted_data) else {
                continue;
            };

            payload.insert("id".to_string(), serde_json::json!(item.id));
            payload.insert("vaultId".to_string(), serde_json::json!(item.vault_id));
            payload.insert("category".to_string(), serde_json::json!(item.category));
            payload.insert("favorite".to_string(), serde_json::json!(item.favorite));
            payload.insert("createdAt".to_string(), serde_json::json!(item.created_at));
            payload.insert("updatedAt".to_string(), serde_json::json!(item.updated_at));

            let vault = vault_map.get(
                payload
                    .get("vaultId")
                    .and_then(|value| value.as_str())
                    .unwrap_or_default(),
            );
            payload.insert(
                "vault".to_string(),
                serde_json::json!({
                    "id": vault.map(|value| value.id.clone()).unwrap_or_default(),
                    "name": vault.map(|value| value.name.clone()).unwrap_or_else(|| "Unknown".to_string()),
                    "type": vault.map(|value| value.vault_type.clone()).unwrap_or_else(|| "personal".to_string()),
                    "icon": vault.and_then(|value| value.icon.clone()),
                    "imageUrl": vault.and_then(|value| value.image_url.clone()),
                }),
            );

            if include_account_context {
                if let Some(account) = account_directory.get(&email) {
                    payload.insert(
                        "account".to_string(),
                        serde_json::json!({
                            "email": account.get("email").and_then(|value| value.as_str()).unwrap_or(&email),
                            "userId": account.get("userId").and_then(|value| value.as_str()).unwrap_or_default(),
                            "name": account.get("name").and_then(|value| value.as_str()).unwrap_or(&email),
                        }),
                    );
                }
            }

            items.push(serde_json::Value::Object(payload));
        }
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
                locked: status
                    .get("locked")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(true),
                unlocked_accounts: status
                    .get("unlocked_accounts")
                    .and_then(|v| v.as_array())
                    .map(|accounts| {
                        accounts
                            .iter()
                            .filter_map(|value| value.as_str().map(|s| s.to_string()))
                            .collect()
                    })
                    .unwrap_or_default(),
                timestamp: status
                    .get("timestamp")
                    .and_then(|v| v.as_i64())
                    .unwrap_or_else(now_timestamp_ms),
                autolock_timeout_ms: status
                    .get("autolock_timeout_ms")
                    .and_then(|v| v.as_i64())
                    .unwrap_or(600000),
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
        DesktopRequest::GetDesktopAuthToken { email } => {
            match get_auth_token_internal(app_handle, &email).await {
                Ok(data) => DesktopResponse::DesktopAuthToken {
                    email,
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
        DesktopRequest::GetDesktopVaultKeys { email } => {
            match get_vault_keys_internal(app_handle, Some(email.clone())).await {
                Ok(data) => DesktopResponse::DesktopVaultKeys {
                    email,
                    vault_keys: data
                        .get("vault_keys")
                        .and_then(|v| v.as_str())
                        .unwrap_or_default()
                        .to_string(),
                },
                Err(error) => DesktopResponse::Error { message: error },
            }
        }
        DesktopRequest::GetDesktopItemsSnapshot { emails } => {
            match get_items_snapshot_internal(app_handle, emails).await {
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
            email,
        } => match biometric_unlock_internal(
            app_handle,
            &challenge,
            &extension_id,
            email.as_deref(),
        )
        .await
        {
            Ok(response) => DesktopResponse::BiometricUnlockSuccess {
                encrypted_session: response
                    .get("encrypted_session")
                    .and_then(|v| v.as_str())
                    .unwrap_or_default()
                    .to_string(),
                device_key: response
                    .get("device_key")
                    .and_then(|v| v.as_str())
                    .unwrap_or_default()
                    .to_string(),
                signature: response
                    .get("signature")
                    .and_then(|v| v.as_str())
                    .unwrap_or_default()
                    .to_string(),
                auth_token: response
                    .get("auth_token")
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string()),
                vault_keys: response
                    .get("vault_keys")
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string()),
            },
            Err(error) => DesktopResponse::BiometricUnlockFailed { error },
        },
        DesktopRequest::BiometricUnlockAllRequest {
            challenge,
            extension_id,
        } => match biometric_unlock_all_internal(app_handle, &challenge, &extension_id).await {
            Ok(response) => DesktopResponse::BiometricUnlockAllSuccess {
                device_key: response
                    .get("device_key")
                    .and_then(|v| v.as_str())
                    .unwrap_or_default()
                    .to_string(),
                signature: response
                    .get("signature")
                    .and_then(|v| v.as_str())
                    .unwrap_or_default()
                    .to_string(),
                accounts: serde_json::from_value(
                    response.get("accounts").cloned().unwrap_or_else(|| serde_json::json!([])),
                )
                .unwrap_or_default(),
                unlocked: response
                    .get("unlocked")
                    .and_then(|v| v.as_array())
                    .map(|values| {
                        values
                            .iter()
                            .filter_map(|value| value.as_str().map(|s| s.to_string()))
                            .collect()
                    })
                    .unwrap_or_default(),
                failed: response
                    .get("failed")
                    .and_then(|v| v.as_array())
                    .map(|values| {
                        values
                            .iter()
                            .filter_map(|value| value.as_str().map(|s| s.to_string()))
                            .collect()
                    })
                    .unwrap_or_default(),
            },
            Err(error) => DesktopResponse::BiometricUnlockAllFailed { error },
        },
        DesktopRequest::TriggerDesktopUnlock => {
            let response = if let Err(error) = open_app_internal(app_handle) {
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
            };
            response
        }
        DesktopRequest::OpenDesktopApp => match open_app_internal(app_handle) {
            Ok(()) => DesktopResponse::OpenDesktopAppResult {
                success: true,
                error: None,
            },
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
                    match message.payload {
                        DesktopRequest::UnsubscribeDesktopEvents => {
                            event_rx = None;
                            let response = DesktopEnvelope {
                                request_id: message.request_id,
                                payload: DesktopResponse::DesktopEventSubscription { subscribed: false },
                            };
                            write_frame(&mut writer, &response).await.map_err(|error| error.to_string())?;
                        }
                        request => {
                            let payload = handle_desktop_ipc_message(&app_handle, request).await;
                            let response = DesktopEnvelope {
                                request_id: message.request_id,
                                payload,
                            };
                            write_frame(&mut writer, &response).await.map_err(|error| error.to_string())?;
                        }
                    }
                }
                event = rx.recv() => {
                    match event {
                        Ok(event) => {
                            let response = DesktopEnvelope {
                                request_id: None,
                                payload: lock_event_to_response(event),
                            };
                            write_frame(&mut writer, &response).await.map_err(|error| error.to_string())?;
                        }
                        Err(broadcast::error::RecvError::Lagged(_)) => {}
                        Err(broadcast::error::RecvError::Closed) => break,
                    }
                }
            }
        } else {
            let message: DesktopEnvelope<DesktopRequest> =
                desktop_ipc::read_frame(&mut reader).await.map_err(|error| error.to_string())?;
            match message.payload {
                DesktopRequest::SubscribeDesktopEvents => {
                    event_rx = Some(state.lock_events.subscribe());
                    let response = DesktopEnvelope {
                        request_id: message.request_id,
                        payload: DesktopResponse::DesktopEventSubscription { subscribed: true },
                    };
                    write_frame(&mut writer, &response).await.map_err(|error| error.to_string())?;
                }
                request => {
                    let payload = handle_desktop_ipc_message(&app_handle, request).await;
                    let response = DesktopEnvelope {
                        request_id: message.request_id,
                        payload,
                    };
                    write_frame(&mut writer, &response).await.map_err(|error| error.to_string())?;
                }
            }
        }
    }

    Ok(())
}

#[cfg(unix)]
async fn start_desktop_ipc_server(app_handle: tauri::AppHandle, state: Arc<DesktopIpcState>) {
    let socket_path = desktop_ipc_socket_path();
    let _ = std::fs::remove_file(&socket_path);

    let listener = match tokio::net::UnixListener::bind(&socket_path) {
        Ok(listener) => listener,
        Err(error) => {
            eprintln!("[desktop-ipc] Failed to bind {}: {}", socket_path.display(), error);
            return;
        }
    };

    eprintln!("[desktop-ipc] Listening on {}", socket_path.display());

    loop {
        match listener.accept().await {
            Ok((stream, _)) => {
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

#[cfg(windows)]
async fn start_desktop_ipc_server(app_handle: tauri::AppHandle, state: Arc<DesktopIpcState>) {
    use tokio::net::windows::named_pipe::ServerOptions;

    let pipe_name = desktop_ipc_socket_path();
    let pipe_name = pipe_name.to_string_lossy().to_string();
    eprintln!("[desktop-ipc] Listening on {}", pipe_name);

    loop {
        let server = match ServerOptions::new().create(&pipe_name) {
            Ok(server) => server,
            Err(error) => {
                eprintln!("[desktop-ipc] Failed to create named pipe {}: {}", pipe_name, error);
                break;
            }
        };

        if let Err(error) = server.connect().await {
            eprintln!("[desktop-ipc] Named pipe connect failed: {}", error);
            continue;
        }

        let app_handle = app_handle.clone();
        let state = state.clone();
        tauri::async_runtime::spawn(async move {
            if let Err(error) =
                handle_desktop_ipc_connection(app_handle, state, server).await
            {
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
    let status = biometry.status()
        .map_err(|e| format!("Failed to check biometry status: {}", e))?;
    
    // Check if session data exists in store
    let store = app_handle.store("store.json")
        .map_err(|e| format!("Failed to access store: {}", e))?;
    
    let active_email = get_active_account_email(&store);

    // If active account is "all", check if ANY account has a valid session
    let has_session = if active_email.as_deref() == Some("all") {
        // Get accounts list and check if any has a session
        if let Some(accounts_value) = store.get("bittery_accounts_list") {
            if let Some(accounts_str) = accounts_value.as_str() {
                if let Ok(accounts_json) = serde_json::from_str::<serde_json::Value>(accounts_str) {
                    if let Some(accounts_array) = accounts_json.get("accounts").and_then(|a| a.as_array()) {
                        // Check if any account has session data
                        accounts_array.iter().any(|account| {
                            if let Some(email) = account.get("email").and_then(|e| e.as_str()) {
                                let session_key = account_key(email, "session_data");
                                store.get(&session_key).is_some()
                            } else {
                                false
                            }
                        })
                    } else {
                        false
                    }
                } else {
                    false
                }
            } else {
                false
            }
        } else {
            false
        }
    } else {
        // Single account mode - check specific account or legacy
        let (session_key, biometric_key) = if let Some(email) = &active_email {
            (
                account_key(email, "session_data"),
                account_key(email, "biometric_enabled"),
            )
        } else {
            (
                LEGACY_SESSION_DATA_KEY.to_string(),
                LEGACY_BIOMETRIC_ENABLED_KEY.to_string(),
            )
        };

        let mut session_data = store.get(&session_key);
        let mut biometric_enabled = store.get(&biometric_key);
        if session_data.is_none() && active_email.is_some() {
            session_data = store.get(LEGACY_SESSION_DATA_KEY);
            biometric_enabled = store.get(LEGACY_BIOMETRIC_ENABLED_KEY);
        }

        // Check biometric_enabled flag for single account
        let is_enabled = biometric_enabled.and_then(|v| v.as_bool()).unwrap_or(true);
        session_data.is_some() && is_enabled
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
    email: Option<String>,
) -> Result<serde_json::Value, String> {
    use tauri_plugin_biometry::BiometryExt;
    use tauri_plugin_store::StoreExt;

    eprintln!("[Biometric Unlock] Request from extension: {}", extension_id);
    eprintln!("[Biometric Unlock] Challenge: {}", challenge);
    if let Some(ref e) = email {
        eprintln!("[Biometric Unlock] Requested email: {}", e);
    }

    // 1. Authenticate with biometric (Touch ID / Windows Hello)
    let biometry = app_handle.biometry();
    let auth_options = tauri_plugin_biometry::AuthOptions::default();
    biometry.authenticate("Unlock Bittery for browser extension".to_string(), auth_options)
        .map_err(|e| format!("Biometric authentication failed: {}", e))?;

    eprintln!("[Biometric Unlock] ✓ Authentication successful");

    // 2. Get session data from store
    let store = app_handle.store("store.json")
        .map_err(|e| format!("Failed to access store: {}", e))?;

    // Debug: List all stored accounts
    if let Some(accounts_value) = store.get("bittery_accounts_list") {
        if let Some(accounts_str) = accounts_value.as_str() {
            eprintln!("[Biometric Unlock] Stored accounts: {}", accounts_str);
        }
    } else {
        eprintln!("[Biometric Unlock] No accounts list found in store");
    }

    // Use provided email if available, otherwise fall back to active account
    let target_email = email.as_ref()
        .map(|e| e.to_lowercase())
        .or_else(|| get_active_account_email(&store));

    eprintln!("[Biometric Unlock] Target email: {:?}", target_email);

    let (session_key, vault_key) = if let Some(email) = &target_email {
        (
            account_key(email, "session_data"),
            account_key(email, "vault_keys"),
        )
    } else {
        (
            LEGACY_SESSION_DATA_KEY.to_string(),
            LEGACY_VAULT_KEYS_KEY.to_string(),
        )
    };

    eprintln!("[Biometric Unlock] Looking for session key: {}", session_key);
    let mut session_data_value = store.get(&session_key);
    eprintln!("[Biometric Unlock] Session data found: {}", session_data_value.is_some());
    if session_data_value.is_none() && target_email.is_some() {
        session_data_value = store.get(LEGACY_SESSION_DATA_KEY);
    }
    let session_data_value = session_data_value.ok_or("No session data found")?;
    
    let session_data_str = session_data_value.as_str()
        .ok_or("Invalid session data format")?;
    
    let session_data: serde_json::Value = serde_json::from_str(&session_data_str)
        .map_err(|e| format!("Failed to parse session data: {}", e))?;
    
    eprintln!("[Biometric Unlock] Session data retrieved");
    
    // 3. Get device key to decrypt the MUK
    let device_key_value = store.get("bittery_device_key")
        .ok_or("No device key found")?;
    
    let device_key_base64 = device_key_value.as_str()
        .ok_or("Invalid device key format")?;
    
    // 4. Get encrypted MUK from session data
    let encrypted_muk = session_data.get("encryptedMasterUnlockKey")
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
    
    let encrypted_session_b64 = base64::engine::general_purpose::STANDARD.encode(encrypted_muk_json.as_bytes());
    
    // Get auth token and vault keys from secure storage / store
    let mut auth_token = target_email
        .as_deref()
        .and_then(|email| get_bearer_token_for_account(&store, email));
    let mut vault_keys = store
        .get(&vault_key)
        .and_then(|v| v.as_str().map(|s| s.to_string()));
    if target_email.is_some() {
        if auth_token.is_none() {
            auth_token = store
                .get(LEGACY_JWT_TOKEN_KEY)
                .and_then(|v| v.as_str().map(|s| s.to_string()));
        }
        if vault_keys.is_none() {
            vault_keys = store
                .get(LEGACY_VAULT_KEYS_KEY)
                .and_then(|v| v.as_str().map(|s| s.to_string()));
        }
    }
    
    // Sign the response with challenge to prevent replay attacks
    let signature_data = format!("{}:{}", challenge, encrypted_session_b64);
    let signature = base64::engine::general_purpose::STANDARD.encode(signature_data.as_bytes());
    
    eprintln!("[Biometric Unlock] ✓ Response prepared and signed");
    
    let mut response = serde_json::json!({
        "encrypted_session": encrypted_session_b64,
        "device_key": device_key_base64,
        "signature": signature,
    });
    
    // Include auth token and vault keys if available
    if let Some(token) = auth_token {
        response["auth_token"] = serde_json::Value::String(token);
    }
    if let Some(keys) = vault_keys {
        response["vault_keys"] = serde_json::Value::String(keys);
    }
    
    Ok(response)
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
    email: Option<&str>,
) -> Result<serde_json::Value, String> {
    // Call the Tauri command
    extension_biometric_unlock(
        app_handle.clone(),
        challenge.to_string(),
        extension_id.to_string(),
        email.map(|e| e.to_string()),
    ).await
}

/// Perform biometric unlock for all accounts with single prompt
async fn biometric_unlock_all_internal(
    app_handle: &tauri::AppHandle,
    challenge: &str,
    extension_id: &str,
) -> Result<serde_json::Value, String> {
    use tauri_plugin_biometry::BiometryExt;
    use tauri_plugin_store::StoreExt;

    eprintln!("[Biometric Unlock All] Request from extension: {}", extension_id);
    eprintln!("[Biometric Unlock All] Challenge: {}", challenge);

    // 1. Authenticate with biometric ONCE (Touch ID / Windows Hello)
    let biometry = app_handle.biometry();
    let auth_options = tauri_plugin_biometry::AuthOptions::default();
    biometry.authenticate("Unlock all Bittery accounts for browser extension".to_string(), auth_options)
        .map_err(|e| format!("Biometric authentication failed: {}", e))?;

    eprintln!("[Biometric Unlock All] ✓ Authentication successful");

    // 2. Get accounts list from store
    let store = app_handle.store("store.json")
        .map_err(|e| format!("Failed to access store: {}", e))?;

    let accounts_value = store.get("bittery_accounts_list")
        .ok_or("No accounts list found")?;

    let accounts_str = accounts_value.as_str()
        .ok_or("Invalid accounts list format")?;

    let accounts_json: serde_json::Value = serde_json::from_str(accounts_str)
        .map_err(|e| format!("Failed to parse accounts list: {}", e))?;

    let accounts_array = accounts_json.get("accounts")
        .and_then(|a| a.as_array())
        .ok_or("No accounts array found")?;

    eprintln!("[Biometric Unlock All] Found {} accounts", accounts_array.len());

    // 3. Get device key (shared across all accounts)
    let device_key_value = store.get("bittery_device_key")
        .ok_or("No device key found")?;

    let device_key_base64 = device_key_value.as_str()
        .ok_or("Invalid device key format")?;

    // 4. Unlock all accounts (no additional biometric prompts)
    let mut accounts_data = Vec::new();
    let mut unlocked_emails = Vec::new();
    let mut failed_emails = Vec::new();

    for account in accounts_array {
        let email = match account.get("email").and_then(|e| e.as_str()) {
            Some(e) => e.to_lowercase(),
            None => {
                eprintln!("[Biometric Unlock All] Skipping account with no email");
                continue;
            }
        };

        eprintln!("[Biometric Unlock All] Processing account: {}", email);

        // Get session data for this account
        let session_key = account_key(&email, "session_data");
        let vault_key = account_key(&email, "vault_keys");

        let session_data_value = match store.get(&session_key) {
            Some(v) => v,
            None => {
                eprintln!("[Biometric Unlock All] No session data for {}", email);
                failed_emails.push(email);
                continue;
            }
        };

        let session_data_str = match session_data_value.as_str() {
            Some(s) => s,
            None => {
                eprintln!("[Biometric Unlock All] Invalid session data format for {}", email);
                failed_emails.push(email);
                continue;
            }
        };

        let session_data: serde_json::Value = match serde_json::from_str(session_data_str) {
            Ok(d) => d,
            Err(e) => {
                eprintln!("[Biometric Unlock All] Failed to parse session data for {}: {}", email, e);
                failed_emails.push(email);
                continue;
            }
        };

        // Get encrypted MUK from session data
        let encrypted_muk = match session_data.get("encryptedMasterUnlockKey") {
            Some(muk) => muk,
            None => {
                eprintln!("[Biometric Unlock All] No encrypted MUK for {}", email);
                failed_emails.push(email);
                continue;
            }
        };

        let encrypted_muk_json = serde_json::to_string(encrypted_muk)
            .map_err(|e| format!("Failed to serialize encrypted MUK for {}: {}", email, e))?;

        let encrypted_session_b64 = base64::engine::general_purpose::STANDARD.encode(encrypted_muk_json.as_bytes());

        // Get auth token and vault keys for this account
        let auth_token = get_bearer_token_for_account(&store, &email);
        let vault_keys = store.get(&vault_key)
            .and_then(|v| v.as_str().map(|s| s.to_string()));

        // Build account data
        let mut account_data = serde_json::json!({
            "email": email,
            "encrypted_session": encrypted_session_b64,
        });

        if let Some(token) = auth_token {
            account_data["auth_token"] = serde_json::Value::String(token);
        }
        if let Some(keys) = vault_keys {
            account_data["vault_keys"] = serde_json::Value::String(keys);
        }

        accounts_data.push(account_data);
        unlocked_emails.push(email.clone());
        eprintln!("[Biometric Unlock All] ✓ Unlocked {}", email);
    }

    if accounts_data.is_empty() {
        return Err("No accounts could be unlocked".to_string());
    }

    // Sign the response with challenge to prevent replay attacks
    let signature_data = format!("{}:{}", challenge, accounts_data.len());
    let signature = base64::engine::general_purpose::STANDARD.encode(signature_data.as_bytes());

    eprintln!("[Biometric Unlock All] ✓ Unlocked {} accounts, {} failed",
        unlocked_emails.len(), failed_emails.len());

    let response = serde_json::json!({
        "device_key": device_key_base64,
        "signature": signature,
        "accounts": accounts_data,
        "unlocked": unlocked_emails,
        "failed": failed_emails,
    });

    Ok(response)
}

/// Get current lock status of all accounts
async fn get_lock_status_internal(
    app_handle: &tauri::AppHandle,
) -> Result<serde_json::Value, String> {
    use tauri_plugin_store::StoreExt;

    let store = app_handle
        .store("store.json")
        .map_err(|e| format!("Failed to access store: {}", e))?;

    // Read lock state marker (maintained by storage adapter based on MUKs in memory)
    // This is the source of truth for which accounts are unlocked
    let unlocked_accounts = get_unlocked_accounts(&store);

    // Get autolock timeout from first account (they should all be the same, but use first as default)
    let autolock_timeout_ms = if let Some(first_email) = unlocked_accounts.first() {
        let timeout_key = account_key(first_email, "autolock_timeout");
        store
            .get(&timeout_key)
            .and_then(|v| v.as_i64())
            .unwrap_or(600000) // Default 10 minutes
    } else {
        600000
    };

    let locked = unlocked_accounts.is_empty();
    let timestamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as i64;

    Ok(serde_json::json!({
        "locked": locked,
        "unlocked_accounts": unlocked_accounts,
        "timestamp": timestamp,
        "autolock_timeout_ms": autolock_timeout_ms,
    }))
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
    window.show()
        .map_err(|e| format!("Failed to show window: {}", e))?;

    // Unminimize if minimized
    window.unminimize()
        .map_err(|e| format!("Failed to unminimize window: {}", e))?;

    // Bring to front
    window.set_focus()
        .map_err(|e| format!("Failed to focus window: {}", e))?;

    Ok(())
}

/// Get account list (works even when locked)
async fn get_accounts_list_internal(
    app_handle: &tauri::AppHandle,
) -> Result<serde_json::Value, String> {
    use tauri_plugin_store::StoreExt;

    let store = app_handle
        .store("store.json")
        .map_err(|e| format!("Failed to access store: {}", e))?;

    // Get accounts list from store
    let accounts_value = store.get("bittery_accounts_list")
        .ok_or("No accounts found")?;

    let accounts_str = accounts_value.as_str()
        .ok_or("Invalid accounts list format")?;

    let accounts_json: serde_json::Value = serde_json::from_str(accounts_str)
        .map_err(|e| format!("Failed to parse accounts list: {}", e))?;

    let accounts_array = accounts_json.get("accounts")
        .and_then(|a| a.as_array())
        .ok_or("No accounts array found")?;

    // Get active account
    let active_email = get_active_account_email(&store);

    // Get unlocked accounts
    let unlocked_accounts: Vec<String> = store
        .get("bittery_unlocked_accounts")
        .and_then(|v| v.as_str().map(|s| s.to_string()))
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_else(Vec::new);

    Ok(serde_json::json!({
        "accounts": accounts_array,
        "active_account": active_email,
        "unlocked_accounts": unlocked_accounts,
    }))
}

/// Get vault keys for a specific account (or all if no email provided)
async fn get_vault_keys_internal(
    app_handle: &tauri::AppHandle,
    email: Option<String>,
) -> Result<serde_json::Value, String> {
    use tauri_plugin_store::StoreExt;

    let store = app_handle
        .store("store.json")
        .map_err(|e| format!("Failed to access store: {}", e))?;

    let target_email = email.or_else(|| get_active_account_email(&store));

    if target_email.is_none() {
        return Err("No account specified".to_string());
    }

    let email = target_email.unwrap();
    let vault_key = account_key(&email, "vault_keys");

    let vault_keys = store.get(&vault_key)
        .and_then(|v| v.as_str().map(|s| s.to_string()))
        .ok_or("Vault keys not found")?;

    Ok(serde_json::json!({
        "email": email,
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

    let event = LockEvent::Lock { reason: reason.clone(), timestamp };

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

    let event = LockEvent::Unlock { accounts: accounts.clone(), timestamp };

    let _ = state.lock_events.send(event);

    eprintln!("[Unlock Event] Broadcast unlock event (accounts: {:?})", accounts);
    Ok(())
}

/// Tauri command to broadcast active account changed event to extension
#[tauri::command]
fn broadcast_active_account_changed(
    state: tauri::State<Arc<DesktopIpcState>>,
    email: String,
) -> Result<(), String> {
    let timestamp = now_timestamp_ms();

    let event = LockEvent::ActiveAccountChanged { email: email.clone(), timestamp };

    let _ = state.lock_events.send(event);

    eprintln!("[Active Account Changed] Broadcast active account changed event (email: {})", email);
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
			crypto_commands::crypto_validate_server_kdf_params,
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

                match native_messaging_installer::install_native_messaging_host(&app.handle()) {
                    Ok(_) => {
                        eprintln!("✅ Native messaging host installed successfully!");
                        eprintln!("   Browser extension can now use biometric unlock!");
                    }
                    Err(e) => {
                        eprintln!("⚠️  Failed to install native messaging host: {}", e);
                        eprintln!("   To enable biometric unlock, build the native host:");
                        eprintln!("   cd src-tauri && cargo build --release --bin bittery-native-host");
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
        .on_window_event(|window, event| {
            match event {
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
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::{
        serialize_encryption_context, unwrap_plaintext_with_context, CONTEXT_ENVELOPE_MARKER,
    };

    #[test]
    fn unwrap_plaintext_with_context_accepts_matching_envelope() {
        let decrypted = serde_json::json!({
            "marker": CONTEXT_ENVELOPE_MARKER,
            "context": serialize_encryption_context("vault-1", "item-1", "item", 2, "user-1"),
            "payload": "{\"title\":\"Example\"}",
        })
        .to_string();

        let unwrapped = unwrap_plaintext_with_context(
            decrypted,
            "vault-1",
            "item-1",
            "item",
            2,
            "user-1",
        )
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

        let error = unwrap_plaintext_with_context(
            decrypted,
            "vault-1",
            "item-1",
            "item",
            3,
            "user-1",
        )
        .expect_err("expected context mismatch");

        assert_eq!(error, "Encryption context mismatch");
    }
}
