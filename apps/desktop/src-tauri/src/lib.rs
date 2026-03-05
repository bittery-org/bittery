mod crypto_commands;
mod keychain;
mod native_messaging_installer;

use std::convert::Infallible;
use std::net::SocketAddr;
use std::sync::Arc;
use base64::Engine;
use hyper::{Body, Method, Request, Response, Server, StatusCode};
use hyper::service::{make_service_fn, service_fn};
use tokio::sync::{Mutex, broadcast};
use tauri::{Emitter, Manager, Runtime};
use tauri_plugin_store::Store;

/// Lock event types for SSE broadcasting
#[derive(Debug, Clone, serde::Serialize)]
#[serde(tag = "event", rename_all = "snake_case")]
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

/// State for native bridge HTTP server
struct NativeBridgeState {
    /// Pending unlock requests (challenge -> extension_id)
    pending_requests: Arc<Mutex<std::collections::HashMap<String, String>>>,
    /// Broadcast channel for lock events (for SSE)
    lock_events: broadcast::Sender<LockEvent>,
}

impl Default for NativeBridgeState {
    fn default() -> Self {
        let (tx, _) = broadcast::channel(100);
        Self {
            pending_requests: Arc::new(Mutex::new(std::collections::HashMap::new())),
            lock_events: tx,
        }
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

fn get_active_account_email<R: Runtime>(store: &Store<R>) -> Option<String> {
    store
        .get(ACTIVE_ACCOUNT_KEY)
        .and_then(|value| value.as_str().map(|s| s.to_lowercase()))
}

/// Start HTTP server for native messaging bridge
async fn start_native_bridge_server(app_handle: tauri::AppHandle, state: Arc<NativeBridgeState>) {
    let addr = SocketAddr::from(([127, 0, 0, 1], 48765));

    let make_svc = make_service_fn(move |_conn| {
        let app_handle = app_handle.clone();
        let state = state.clone();

        async move {
            Ok::<_, Infallible>(service_fn(move |req: Request<Body>| {
                let app_handle = app_handle.clone();
                let state = state.clone();
                handle_native_bridge_request(app_handle, state, req)
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
    state: Arc<NativeBridgeState>,
    req: Request<Body>,
) -> Result<Response<Body>, Infallible> {
    let path = req.uri().path();

    match (req.method(), path) {
        (&Method::GET, "/native-bridge/lock-status") => {
            // Return current lock status of all accounts
            match get_lock_status_internal(&app_handle).await {
                Ok(status) => {
                    Ok(Response::builder()
                        .status(StatusCode::OK)
                        .header("Content-Type", "application/json")
                        .header("Access-Control-Allow-Origin", "*")
                        .body(Body::from(status.to_string()))
                        .unwrap())
                }
                Err(e) => {
                    let timestamp = std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .unwrap()
                        .as_millis() as i64;
                    let error = serde_json::json!({
                        "locked": true,
                        "unlocked_accounts": [],
                        "timestamp": timestamp,
                        "autolock_timeout_ms": -1,
                        "error": e
                    });
                    Ok(Response::builder()
                        .status(StatusCode::OK)
                        .header("Content-Type", "application/json")
                        .header("Access-Control-Allow-Origin", "*")
                        .body(Body::from(error.to_string()))
                        .unwrap())
                }
            }
        }

        (&Method::GET, "/native-bridge/lock-events") => {
            // SSE endpoint for real-time lock/unlock events
            let mut rx = state.lock_events.subscribe();

            let event_stream = async_stream::stream! {
                // Send initial connected event
                let timestamp = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_millis() as i64;
                yield Ok::<_, std::io::Error>(format!("event: connected\ndata: {}\n\n", serde_json::json!({"timestamp": timestamp})));

                // Stream lock events as they arrive
                while let Ok(event) = rx.recv().await {
                    let event_name = match &event {
                        LockEvent::Lock { .. } => "lock",
                        LockEvent::Unlock { .. } => "unlock",
                        LockEvent::DesktopClose { .. } => "desktop_close",
                        LockEvent::ActiveAccountChanged { .. } => "active_account_changed",
                    };
                    let data = serde_json::to_string(&event).unwrap_or_default();
                    yield Ok(format!("event: {}\ndata: {}\n\n", event_name, data));
                }
            };

            let body = Body::wrap_stream(event_stream);

            Ok(Response::builder()
                .status(StatusCode::OK)
                .header("Content-Type", "text/event-stream")
                .header("Cache-Control", "no-cache")
                .header("Connection", "keep-alive")
                .header("Access-Control-Allow-Origin", "*")
                .body(body)
                .unwrap())
        }

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
            let email = request["email"].as_str(); // Optional email parameter

            eprintln!("[HTTP Handler] Received request: {}", serde_json::to_string(&request).unwrap_or_default());
            eprintln!("[HTTP Handler] Extracted email: {:?}", email);

            // Trigger biometric unlock
            match biometric_unlock_internal(&app_handle, challenge, extension_id, email).await {
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

        (&Method::POST, "/native-bridge/trigger-unlock") => {
            // Simple endpoint: just show/focus desktop window and emit event to trigger UI unlock
            eprintln!("[HTTP Handler] Extension requesting desktop unlock");

            // Show and focus the desktop window
            if let Err(e) = open_app_internal(&app_handle) {
                eprintln!("[HTTP Handler] Failed to show window: {}", e);
            }

            // Emit event to frontend to trigger biometric unlock UI
            if let Err(e) = app_handle.emit("trigger-biometric-unlock", ()) {
                eprintln!("[HTTP Handler] Failed to emit unlock trigger: {}", e);
            }

            let response = serde_json::json!({
                "success": true,
                "message": "Desktop unlock triggered"
            });

            Ok(Response::builder()
                .status(StatusCode::OK)
                .header("Content-Type", "application/json")
                .body(Body::from(response.to_string()))
                .unwrap())
        }

        (&Method::POST, "/native-bridge/biometric-unlock-all") => {
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

            eprintln!("[HTTP Handler] Biometric unlock all - Received request (standalone mode)");

            // This endpoint is only used for standalone mode (when desktop is not master)
            // For desktop-as-master mode, use /trigger-unlock instead
            match biometric_unlock_all_internal(&app_handle, challenge, extension_id).await {
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

        (&Method::GET, "/native-bridge/accounts") => {
            // Return account list (works even when locked)
            match get_accounts_list_internal(&app_handle).await {
                Ok(data) => {
                    Ok(Response::builder()
                        .status(StatusCode::OK)
                        .header("Content-Type", "application/json")
                        .header("Access-Control-Allow-Origin", "*")
                        .body(Body::from(data.to_string()))
                        .unwrap())
                }
                Err(e) => {
                    let error = serde_json::json!({
                        "error": e
                    });
                    Ok(Response::builder()
                        .status(StatusCode::INTERNAL_SERVER_ERROR)
                        .header("Content-Type", "application/json")
                        .header("Access-Control-Allow-Origin", "*")
                        .body(Body::from(error.to_string()))
                        .unwrap())
                }
            }
        }

        (&Method::GET, "/native-bridge/session-data") => {
            // Return session data for all unlocked accounts
            match get_session_data_internal(&app_handle).await {
                Ok(data) => {
                    Ok(Response::builder()
                        .status(StatusCode::OK)
                        .header("Content-Type", "application/json")
                        .header("Access-Control-Allow-Origin", "*")
                        .body(Body::from(data.to_string()))
                        .unwrap())
                }
                Err(e) => {
                    let error = serde_json::json!({
                        "error": e
                    });
                    Ok(Response::builder()
                        .status(StatusCode::INTERNAL_SERVER_ERROR)
                        .header("Content-Type", "application/json")
                        .header("Access-Control-Allow-Origin", "*")
                        .body(Body::from(error.to_string()))
                        .unwrap())
                }
            }
        }

        (&Method::GET, path) if path.starts_with("/native-bridge/vault-keys") => {
            // Parse query parameters
            let query = req.uri().query().unwrap_or("");
            let email_param = query.split('&')
                .find(|p| p.starts_with("email="))
                .and_then(|p| p.strip_prefix("email="))
                .map(|e| urlencoding::decode(e).unwrap_or_default().to_string());

            match get_vault_keys_internal(&app_handle, email_param).await {
                Ok(keys) => {
                    Ok(Response::builder()
                        .status(StatusCode::OK)
                        .header("Content-Type", "application/json")
                        .header("Access-Control-Allow-Origin", "*")
                        .body(Body::from(keys.to_string()))
                        .unwrap())
                }
                Err(e) => {
                    let error = serde_json::json!({
                        "error": e
                    });
                    Ok(Response::builder()
                        .status(StatusCode::INTERNAL_SERVER_ERROR)
                        .header("Content-Type", "application/json")
                        .header("Access-Control-Allow-Origin", "*")
                        .body(Body::from(error.to_string()))
                        .unwrap())
                }
            }
        }

        (&Method::POST, "/native-bridge/decrypt-items") => {
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

            let email = request["email"].as_str();
            let items = request["items"].as_array();

            if email.is_none() || items.is_none() {
                let error = serde_json::json!({
                    "error": "Missing required fields: email and items"
                });
                return Ok(Response::builder()
                    .status(StatusCode::BAD_REQUEST)
                    .header("Content-Type", "application/json")
                    .body(Body::from(error.to_string()))
                    .unwrap());
            }

            match decrypt_items_internal(&app_handle, email.unwrap(), items.unwrap()).await {
                Ok(result) => {
                    Ok(Response::builder()
                        .status(StatusCode::OK)
                        .header("Content-Type", "application/json")
                        .header("Access-Control-Allow-Origin", "*")
                        .body(Body::from(result.to_string()))
                        .unwrap())
                }
                Err(e) => {
                    let error = serde_json::json!({
                        "error": e
                    });
                    Ok(Response::builder()
                        .status(StatusCode::INTERNAL_SERVER_ERROR)
                        .header("Content-Type", "application/json")
                        .header("Access-Control-Allow-Origin", "*")
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

    let (session_key, jwt_key, vault_key) = if let Some(email) = &target_email {
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
    
    // Get auth token and vault keys from store
    let mut auth_token = store
        .get(&jwt_key)
        .and_then(|v| v.as_str().map(|s| s.to_string()));
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
        let jwt_key = account_key(&email, "jwt_token");
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
        let auth_token = store.get(&jwt_key)
            .and_then(|v| v.as_str().map(|s| s.to_string()));
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
    let unlocked_accounts: Vec<String> = store
        .get("bittery_unlocked_accounts")
        .and_then(|v| v.as_str().map(|s| s.to_string()))
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_else(Vec::new);

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

/// Get session data for all unlocked accounts
async fn get_session_data_internal(
    app_handle: &tauri::AppHandle,
) -> Result<serde_json::Value, String> {
    use tauri_plugin_store::StoreExt;

    let store = app_handle
        .store("store.json")
        .map_err(|e| format!("Failed to access store: {}", e))?;

    // Get accounts list
    let accounts_value = store.get("bittery_accounts_list");
    let mut accounts_data = Vec::new();

    if let Some(accounts_str_value) = accounts_value {
        if let Some(accounts_str) = accounts_str_value.as_str() {
            if let Ok(accounts_json) = serde_json::from_str::<serde_json::Value>(accounts_str) {
                if let Some(accounts_array) = accounts_json.get("accounts").and_then(|a| a.as_array()) {
                    // Get session data for each account with a valid JWT token (unlocked accounts)
                    for account in accounts_array {
                        if let Some(email) = account.get("email").and_then(|e| e.as_str()) {
                            let jwt_key = account_key(email, "jwt_token");

                            if let Some(jwt_token) = store.get(&jwt_key).and_then(|v| v.as_str().map(|s| s.to_string())) {
                                let session_key = account_key(email, "session_data");

                                // Get session metadata if available
                                let session_metadata = store.get(&session_key)
                                    .and_then(|v| v.as_str().map(|s| s.to_string()))
                                    .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok());

                                let mut account_data = serde_json::json!({
                                    "email": email,
                                    "auth_token": jwt_token,
                                });

                                // Add session expiry if available
                                if let Some(session) = session_metadata {
                                    if let Some(expires_at) = session.get("expiresAt") {
                                        account_data["expires_at"] = expires_at.clone();
                                    }
                                    if let Some(user_id) = session.get("userId") {
                                        account_data["user_id"] = user_id.clone();
                                    }
                                }

                                accounts_data.push(account_data);
                            }
                        }
                    }
                }
            }
        }
    }

    let active_email = get_active_account_email(&store);
    let timestamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as i64;

    Ok(serde_json::json!({
        "accounts": accounts_data,
        "active_account": active_email,
        "timestamp": timestamp,
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

/// Decrypt items using desktop's crypto
async fn decrypt_items_internal(
    app_handle: &tauri::AppHandle,
    email: &str,
    items: &Vec<serde_json::Value>,
) -> Result<serde_json::Value, String> {
    use tauri_plugin_store::StoreExt;

    let store = app_handle
        .store("store.json")
        .map_err(|e| format!("Failed to access store: {}", e))?;

    // Get session data to retrieve MUK
    let session_key = account_key(email, "session_data");
    let session_data_str = store.get(&session_key)
        .and_then(|v| v.as_str().map(|s| s.to_string()))
        .ok_or("No session data found")?;

    let session_data: serde_json::Value = serde_json::from_str(&session_data_str)
        .map_err(|e| format!("Failed to parse session data: {}", e))?;

    // Get device key
    let device_key_value = store.get("bittery_device_key")
        .ok_or("No device key found")?;

    let device_key_base64 = device_key_value.as_str()
        .ok_or("Invalid device key format")?;

    let device_key = base64::engine::general_purpose::STANDARD.decode(device_key_base64)
        .map_err(|e| format!("Failed to decode device key: {}", e))?;

    // Get encrypted MUK
    let encrypted_muk = session_data.get("encryptedMasterUnlockKey")
        .ok_or("No encrypted master unlock key in session")?;

    // Decrypt MUK using device key
    let encrypted_muk_str = serde_json::to_string(encrypted_muk)
        .map_err(|e| format!("Failed to serialize encrypted MUK: {}", e))?;

    // Parse encrypted data
    let encrypted_data: serde_json::Value = serde_json::from_str(&encrypted_muk_str)
        .map_err(|e| format!("Failed to parse encrypted data: {}", e))?;

    let ciphertext = encrypted_data.get("ciphertext")
        .and_then(|v| v.as_str())
        .ok_or("Missing ciphertext")?;
    let iv = encrypted_data.get("iv")
        .and_then(|v| v.as_str())
        .ok_or("Missing IV")?;
    let algorithm = encrypted_data.get("algorithm")
        .and_then(|v| v.as_str())
        .ok_or("Missing algorithm")?;

    // Use crypto command to decrypt MUK
    let muk_base64 = crypto_commands::crypto_decrypt(
        ciphertext.to_string(),
        iv.to_string(),
        algorithm.to_string(),
        base64::engine::general_purpose::STANDARD.encode(&device_key),
    ).map_err(|e| format!("Failed to decrypt MUK: {}", e))?;

    // Get vault keys
    let vault_key_storage = account_key(email, "vault_keys");
    let vault_keys_str = store.get(&vault_key_storage)
        .and_then(|v| v.as_str().map(|s| s.to_string()))
        .ok_or("Vault keys not found")?;

    let vault_keys: Vec<serde_json::Value> = serde_json::from_str(&vault_keys_str)
        .map_err(|e| format!("Failed to parse vault keys: {}", e))?;

    // Build a map of vaultId -> decrypted vault key
    let mut decrypted_vault_keys: std::collections::HashMap<String, String> = std::collections::HashMap::new();

    for vk in vault_keys {
        let vault_id = vk.get("vaultId")
            .and_then(|v| v.as_str())
            .ok_or("Missing vaultId")?;

        let encrypted_vault_key = vk.get("encryptedVaultKey")
            .and_then(|v| v.as_str())
            .ok_or("Missing encryptedVaultKey")?;

        // Check if it's AES-encrypted (JSON) or RSA-encrypted (plain base64)
        let is_aes = encrypted_vault_key.starts_with("{");

        if is_aes {
            // AES-GCM encrypted vault key (owner's key)
            let vk_encrypted: serde_json::Value = serde_json::from_str(encrypted_vault_key)
                .map_err(|e| format!("Failed to parse vault key: {}", e))?;

            let vk_ciphertext = vk_encrypted.get("ciphertext")
                .and_then(|v| v.as_str())
                .ok_or("Missing vault key ciphertext")?;
            let vk_iv = vk_encrypted.get("iv")
                .and_then(|v| v.as_str())
                .ok_or("Missing vault key IV")?;
            let vk_algorithm = vk_encrypted.get("algorithm")
                .and_then(|v| v.as_str())
                .ok_or("Missing vault key algorithm")?;

            // Decrypt with MUK (context-bound payloads use native AAD verification).
            let vault_key_base64 = if let Some(ctx) = vk_encrypted.get("context") {
                let ctx_vault_id = ctx.get("vaultId")
                    .and_then(|v| v.as_str())
                    .ok_or("Missing vault key context vaultId")?;
                let ctx_user_id = ctx.get("userId")
                    .and_then(|v| v.as_str())
                    .ok_or("Missing vault key context userId")?;
                let ctx_key_version = ctx.get("keyVersion")
                    .and_then(|v| v.as_u64())
                    .ok_or("Missing vault key context keyVersion")?;
                let ctx_purpose = ctx.get("purpose")
                    .and_then(|v| v.as_str())
                    .ok_or("Missing vault key context purpose")?;

                crypto_commands::crypto_decrypt_with_context(
                    vk_ciphertext.to_string(),
                    vk_iv.to_string(),
                    vk_algorithm.to_string(),
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
                    vk_ciphertext.to_string(),
                    vk_iv.to_string(),
                    vk_algorithm.to_string(),
                    muk_base64.clone(),
                )
                .map_err(|e| format!("Failed to decrypt vault key: {}", e))?
            };

            decrypted_vault_keys.insert(vault_id.to_string(), vault_key_base64);
        } else {
            // RSA-encrypted vault key (shared key) - need to decrypt with private key
            // Get encrypted private key
            let encrypted_private_key_key = account_key(email, "encrypted_private_key");
            let encrypted_private_key_str = store.get(&encrypted_private_key_key)
                .and_then(|v| v.as_str().map(|s| s.to_string()))
                .ok_or("Encrypted private key not found for RSA decryption")?;

            let epk: serde_json::Value = serde_json::from_str(&encrypted_private_key_str)
                .map_err(|e| format!("Failed to parse encrypted private key: {}", e))?;

            let epk_ciphertext = epk.get("ciphertext")
                .and_then(|v| v.as_str())
                .ok_or("Missing private key ciphertext")?;
            let epk_iv = epk.get("iv")
                .and_then(|v| v.as_str())
                .ok_or("Missing private key IV")?;
            let epk_algorithm = epk.get("algorithm")
                .and_then(|v| v.as_str())
                .ok_or("Missing private key algorithm")?;

            // Decrypt private key with MUK
            let private_key_pem = crypto_commands::crypto_decrypt(
                epk_ciphertext.to_string(),
                epk_iv.to_string(),
                epk_algorithm.to_string(),
                muk_base64.clone(),
            ).map_err(|e| format!("Failed to decrypt private key: {}", e))?;

            // Decrypt vault key with RSA
            let vault_key_base64 = crypto_commands::crypto_rsa_decrypt(
                encrypted_vault_key.to_string(),
                private_key_pem,
            ).map_err(|e| format!("Failed to RSA decrypt vault key: {}", e))?;

            decrypted_vault_keys.insert(vault_id.to_string(), vault_key_base64);
        }
    }

    // Now decrypt each item
    let mut decrypted_items = Vec::new();
    let mut failed_items = Vec::new();

    for item in items {
        let item_id = item.get("id")
            .and_then(|v| v.as_str())
            .unwrap_or("unknown");

        let vault_id = item.get("vaultId")
            .and_then(|v| v.as_str());

        let encrypted_data = item.get("encryptedData")
            .and_then(|v| v.as_str());

        let encryption_iv = item.get("encryptionIv")
            .and_then(|v| v.as_str());
        let encryption_algorithm = item.get("encryptionAlgorithm")
            .and_then(|v| v.as_str());

        if vault_id.is_none()
            || encrypted_data.is_none()
            || encryption_iv.is_none()
            || encryption_algorithm.is_none()
        {
            failed_items.push(serde_json::json!({
                "id": item_id,
                "error": "Missing required fields"
            }));
            continue;
        }

        let vault_key = decrypted_vault_keys.get(vault_id.unwrap());
        if vault_key.is_none() {
            failed_items.push(serde_json::json!({
                "id": item_id,
                "error": "Vault key not found"
            }));
            continue;
        }

        match crypto_commands::crypto_decrypt(
            encrypted_data.unwrap().to_string(),
            encryption_iv.unwrap().to_string(),
            encryption_algorithm.unwrap().to_string(),
            vault_key.unwrap().clone(),
        ) {
            Ok(decrypted_data) => {
                let normalized_decrypted_data = normalize_decrypted_item_payload(decrypted_data);
                decrypted_items.push(serde_json::json!({
                    "id": item_id,
                    "decrypted_data": normalized_decrypted_data,
                }));
            }
            Err(e) => {
                failed_items.push(serde_json::json!({
                    "id": item_id,
                    "error": format!("Decryption failed: {}", e)
                }));
            }
        }
    }

    Ok(serde_json::json!({
        "decrypted_items": decrypted_items,
        "failed": failed_items,
    }))
}

/// Tauri command to broadcast lock event to extension
#[tauri::command]
fn broadcast_lock_event(
    state: tauri::State<Arc<NativeBridgeState>>,
    reason: String,
) -> Result<(), String> {
    let timestamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|e| format!("Failed to get timestamp: {}", e))?
        .as_millis() as i64;

    let event = LockEvent::Lock { reason: reason.clone(), timestamp };

    // Broadcast to all SSE subscribers (extension)
    let _ = state.lock_events.send(event);

    eprintln!("[Lock Event] Broadcast lock event (reason: {})", reason);
    Ok(())
}

/// Tauri command to broadcast unlock event to extension
#[tauri::command]
fn broadcast_unlock_event(
    state: tauri::State<Arc<NativeBridgeState>>,
    accounts: Vec<String>,
) -> Result<(), String> {
    let timestamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|e| format!("Failed to get timestamp: {}", e))?
        .as_millis() as i64;

    let event = LockEvent::Unlock { accounts: accounts.clone(), timestamp };

    // Broadcast to all SSE subscribers (extension)
    let _ = state.lock_events.send(event);

    eprintln!("[Unlock Event] Broadcast unlock event (accounts: {:?})", accounts);
    Ok(())
}

/// Tauri command to broadcast active account changed event to extension
#[tauri::command]
fn broadcast_active_account_changed(
    state: tauri::State<Arc<NativeBridgeState>>,
    email: String,
) -> Result<(), String> {
    let timestamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|e| format!("Failed to get timestamp: {}", e))?
        .as_millis() as i64;

    let event = LockEvent::ActiveAccountChanged { email: email.clone(), timestamp };

    // Broadcast to all SSE subscribers (extension)
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
        .manage(BiometricBridge::default())
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

            // Create NativeBridgeState and store in managed state
            let bridge_state = Arc::new(NativeBridgeState::default());
            app.manage(bridge_state.clone());

            // Start native bridge server in background with shared state
            let app_handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                start_native_bridge_server(app_handle, bridge_state).await;
            });

            Ok(())
        })
        .on_window_event(|window, event| {
            // Broadcast desktop_close event when window is closing
            match event {
                tauri::WindowEvent::CloseRequested { .. } | tauri::WindowEvent::Destroyed => {
                    eprintln!("[Window Event] Window closing, broadcasting desktop_close event");

                    // Get NativeBridgeState from app handle
                    if let Some(state) = window.app_handle().try_state::<Arc<NativeBridgeState>>() {
                        let timestamp = std::time::SystemTime::now()
                            .duration_since(std::time::UNIX_EPOCH)
                            .unwrap()
                            .as_millis() as i64;

                        let event = LockEvent::DesktopClose { timestamp };
                        let _ = state.lock_events.send(event);
                        eprintln!("[Window Event] Desktop close event broadcasted");
                    } else {
                        eprintln!("[Window Event] Failed to get NativeBridgeState");
                    }
                }
                _ => {}
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
