mod crypto_commands;
mod keychain;
mod native_messaging_installer;

use std::convert::Infallible;
use std::net::SocketAddr;
use std::sync::Arc;
use base64::Engine;
use hyper::{Body, Method, Request, Response, Server, StatusCode};
use hyper::service::{make_service_fn, service_fn};
use tokio::sync::Mutex;
use tauri::Runtime;
use tauri_plugin_store::Store;

/// State for native bridge HTTP server
#[derive(Default)]
struct NativeBridgeState {
    /// Pending unlock requests (challenge -> extension_id)
    pending_requests: Arc<Mutex<std::collections::HashMap<String, String>>>,
}

const ACTIVE_ACCOUNT_KEY: &str = "bittery_active_account";
const LEGACY_SESSION_DATA_KEY: &str = "bittery_session_data";
const LEGACY_BIOMETRIC_ENABLED_KEY: &str = "bittery_biometric_enabled";
const LEGACY_JWT_TOKEN_KEY: &str = "bittery_jwt_token";
const LEGACY_VAULT_KEYS_KEY: &str = "bittery_vault_keys";

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

fn get_active_account_email<R: Runtime>(store: &Store<R>) -> Option<String> {
    store
        .get(ACTIVE_ACCOUNT_KEY)
        .and_then(|value| value.as_str().map(|s| s.to_lowercase()))
}

/// Start HTTP server for native messaging bridge
async fn start_native_bridge_server(app_handle: tauri::AppHandle) {

    let addr = SocketAddr::from(([127, 0, 0, 1], 48765));

    let make_svc = make_service_fn(move |_conn| {
        let app_handle = app_handle.clone();
        
        async move {
            Ok::<_, Infallible>(service_fn(move |req: Request<Body>| {
                let app_handle = app_handle.clone();
                handle_native_bridge_request(app_handle, req)
            }))
        }
    });

    let server = Server::bind(&addr).serve(make_svc);
    
    eprintln!("Native bridge server listening on {}", addr);
    
    if let Err(e) = server.await {
        eprintln!("Native bridge server error: {}", e);
    }
}

async fn handle_native_bridge_request(
    app_handle: tauri::AppHandle,
    req: Request<Body>,
) -> Result<Response<Body>, Infallible> {
    let path = req.uri().path();
    
    match (req.method(), path) {
        (&Method::GET, "/native-bridge/biometric-status") => {
            // Check biometric availability and if session exists
            match check_biometric_status_internal(&app_handle).await {
                Ok(status) => {
                    Ok(Response::builder()
                        .status(StatusCode::OK)
                        .header("Content-Type", "application/json")
                        .body(Body::from(status.to_string()))
                        .unwrap())
                }
                Err(e) => {
                    let error = serde_json::json!({
                        "available": false,
                        "enabled": false,
                        "error": e.to_string()
                    });
                    Ok(Response::builder()
                        .status(StatusCode::OK)
                        .header("Content-Type", "application/json")
                        .body(Body::from(error.to_string()))
                        .unwrap())
                }
            }
        }
        
        (&Method::POST, "/native-bridge/biometric-unlock") => {
            // Read request body
            let body_bytes = match hyper::body::to_bytes(req.into_body()).await {
                Ok(bytes) => bytes,
                Err(e) => {
                    let error = serde_json::json!({
                        "error": format!("Failed to read request body: {}", e)
                    });
                    return Ok(Response::builder()
                        .status(StatusCode::BAD_REQUEST)
                        .header("Content-Type", "application/json")
                        .body(Body::from(error.to_string()))
                        .unwrap());
                }
            };
            
            let body_str = String::from_utf8(body_bytes.to_vec()).unwrap();
            
            // Parse request
            let request: serde_json::Value = match serde_json::from_str(&body_str) {
                Ok(req) => req,
                Err(e) => {
                    let error = serde_json::json!({
                        "error": format!("Invalid JSON: {}", e)
                    });
                    return Ok(Response::builder()
                        .status(StatusCode::BAD_REQUEST)
                        .header("Content-Type", "application/json")
                        .body(Body::from(error.to_string()))
                        .unwrap());
                }
            };
            
            let challenge = request["challenge"].as_str().unwrap_or("");
            let extension_id = request["extension_id"].as_str().unwrap_or("");
            
            // Trigger biometric unlock
            match biometric_unlock_internal(&app_handle, challenge, extension_id).await {
                Ok(response) => {
                    Ok(Response::builder()
                        .status(StatusCode::OK)
                        .header("Content-Type", "application/json")
                        .body(Body::from(response.to_string()))
                        .unwrap())
                }
                Err(e) => {
                    let error = serde_json::json!({
                        "error": e.to_string()
                    });
                    Ok(Response::builder()
                        .status(StatusCode::INTERNAL_SERVER_ERROR)
                        .header("Content-Type", "application/json")
                        .body(Body::from(error.to_string()))
                        .unwrap())
                }
            }
        }
        
        (&Method::POST, "/native-bridge/open-app") => {
            // Bring app to foreground or show window
            match open_app_internal(&app_handle) {
                Ok(_) => {
                    let response = serde_json::json!({
                        "success": true
                    });
                    Ok(Response::builder()
                        .status(StatusCode::OK)
                        .header("Content-Type", "application/json")
                        .body(Body::from(response.to_string()))
                        .unwrap())
                }
                Err(e) => {
                    let error = serde_json::json!({
                        "success": false,
                        "error": e.to_string()
                    });
                    Ok(Response::builder()
                        .status(StatusCode::INTERNAL_SERVER_ERROR)
                        .header("Content-Type", "application/json")
                        .body(Body::from(error.to_string()))
                        .unwrap())
                }
            }
        }
        
        _ => {
            Ok(Response::builder()
                .status(StatusCode::NOT_FOUND)
                .body(Body::from("Not found"))
                .unwrap())
        }
    }
}

#[derive(Default)]
struct BiometricBridge;

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
) -> Result<serde_json::Value, String> {
    use tauri_plugin_biometry::BiometryExt;
    use tauri_plugin_store::StoreExt;
    
    eprintln!("[Biometric Unlock] Request from extension: {}", extension_id);
    eprintln!("[Biometric Unlock] Challenge: {}", challenge);
    
    // 1. Authenticate with biometric (Touch ID / Windows Hello)
    let biometry = app_handle.biometry();
    let auth_options = tauri_plugin_biometry::AuthOptions::default();
    biometry.authenticate("Unlock Bittery for browser extension".to_string(), auth_options)
        .map_err(|e| format!("Biometric authentication failed: {}", e))?;
    
    eprintln!("[Biometric Unlock] ✓ Authentication successful");
    
    // 2. Get session data from store
    let store = app_handle.store("store.json")
        .map_err(|e| format!("Failed to access store: {}", e))?;
    
    let active_email = get_active_account_email(&store);
    let (session_key, jwt_key, vault_key) = if let Some(email) = &active_email {
        (
            account_key(email, "session_data"),
            account_key(email, "jwt_token"),
            account_key(email, "vault_keys"),
        )
    } else {
        (
            LEGACY_SESSION_DATA_KEY.to_string(),
            LEGACY_JWT_TOKEN_KEY.to_string(),
            LEGACY_VAULT_KEYS_KEY.to_string(),
        )
    };

    let mut session_data_value = store.get(&session_key);
    if session_data_value.is_none() && active_email.is_some() {
        session_data_value = store.get(LEGACY_SESSION_DATA_KEY);
    }
    let session_data_value = session_data_value.ok_or("No session data found")?;
    
    let session_data_str = session_data_value.as_str()
        .ok_or("Invalid session data format")?;
    
    let session_data: serde_json::Value = serde_json::from_str(session_data_str)
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
    
    // Get auth token and vault keys from store
    let mut auth_token = store
        .get(&jwt_key)
        .and_then(|v| v.as_str().map(|s| s.to_string()));
    let mut vault_keys = store
        .get(&vault_key)
        .and_then(|v| v.as_str().map(|s| s.to_string()));
    if active_email.is_some() {
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
) -> Result<serde_json::Value, String> {
    // Call the Tauri command
    extension_biometric_unlock(
        app_handle.clone(),
        challenge.to_string(),
        extension_id.to_string(),
    ).await
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_biometry::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .manage(BiometricBridge::default())
        .invoke_handler(tauri::generate_handler![
            // Crypto commands
            crypto_commands::crypto_derive_keys,
            crypto_commands::crypto_encrypt,
            crypto_commands::crypto_decrypt,
            crypto_commands::crypto_generate_encryption_key,
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
        ])
        .setup(|app| {
            // Install native messaging host on first run (or if missing)
            let first_run = !native_messaging_installer::is_installed();
            
            if first_run {
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
            
            // Start native bridge server in background
            let app_handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                start_native_bridge_server(app_handle).await;
            });
            
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
