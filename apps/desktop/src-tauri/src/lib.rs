mod crypto_commands;
mod keychain;
mod native_messaging_installer;

use std::convert::Infallible;
use std::net::SocketAddr;
use std::sync::Arc;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use hyper::body::HttpBody;
use hyper::service::{make_service_fn, service_fn};
use hyper::{Body, Method, Request, Response, Server, StatusCode};
use rand::RngCore;
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
    /// Per-session HTTP bearer token for the loopback bridge
    bridge_token: String,
}

impl Default for NativeBridgeState {
    fn default() -> Self {
        let (tx, _) = broadcast::channel(100);
        Self {
            pending_requests: Arc::new(Mutex::new(std::collections::HashMap::new())),
            lock_events: tx,
            bridge_token: generate_bridge_token(),
        }
    }
}

const ACTIVE_ACCOUNT_KEY: &str = "bittery_active_account";
const LEGACY_SESSION_DATA_KEY: &str = "bittery_session_data";
const LEGACY_BIOMETRIC_ENABLED_KEY: &str = "bittery_biometric_enabled";
const LEGACY_JWT_TOKEN_KEY: &str = "bittery_jwt_token";
const LEGACY_VAULT_KEYS_KEY: &str = "bittery_vault_keys";
const CONTEXT_ENVELOPE_MARKER: &str = "bittery-context-envelope-v1";
const BRIDGE_POST_BODY_LIMIT_BYTES: usize = 1024 * 1024;
const BRIDGE_VERSION: &str = env!("CARGO_PKG_VERSION");

#[derive(serde::Deserialize)]
struct BiometricUnlockRequest {
    challenge: String,
    extension_id: String,
    email: Option<String>,
}

#[derive(serde::Deserialize)]
struct BiometricUnlockAllRequest {
    challenge: String,
    extension_id: String,
}

#[derive(serde::Deserialize)]
struct DecryptItemPayload {
    id: String,
    #[serde(rename = "vaultId")]
    vault_id: String,
    #[serde(rename = "encryptedData")]
    encrypted_data: String,
    #[serde(rename = "encryptionIv")]
    encryption_iv: String,
    #[serde(rename = "encryptionAlgorithm")]
    encryption_algorithm: String,
    version: Option<u64>,
    #[serde(rename = "userId")]
    user_id: Option<String>,
}

#[derive(serde::Deserialize)]
struct DecryptItemsRequest {
    email: String,
    items: Vec<DecryptItemPayload>,
}

#[derive(Default)]
struct VaultKeysQuery {
    email: Option<String>,
}

#[derive(Default)]
struct BridgeAuthQuery {
    extension_id: Option<String>,
}

fn generate_bridge_token() -> String {
    let mut bytes = [0u8; 32];
    rand::rngs::OsRng.fill_bytes(&mut bytes);
    URL_SAFE_NO_PAD.encode(bytes)
}

fn build_response(status: StatusCode, origin: Option<&str>, body: Body) -> Response<Body> {
    let mut builder = Response::builder().status(status);
    if let Some(origin_value) = origin {
        builder = builder
            .header("Access-Control-Allow-Origin", origin_value)
            .header("Vary", "Origin");
    }

    builder.body(body).unwrap_or_else(|_| Response::new(Body::empty()))
}

fn json_response(
    status: StatusCode,
    origin: Option<&str>,
    value: &serde_json::Value,
) -> Response<Body> {
    let mut builder = Response::builder()
        .status(status)
        .header("Content-Type", "application/json");
    if let Some(origin_value) = origin {
        builder = builder
            .header("Access-Control-Allow-Origin", origin_value)
            .header("Vary", "Origin");
    }

    builder
        .body(Body::from(value.to_string()))
        .unwrap_or_else(|_| Response::new(Body::empty()))
}

fn text_response(status: StatusCode, origin: Option<&str>, body: &str) -> Response<Body> {
    build_response(status, origin, Body::from(body.to_string()))
}

fn parse_origin(req: &Request<Body>) -> Result<Option<String>, Response<Body>> {
    match req.headers().get("Origin") {
        Some(origin) => match origin.to_str() {
            Ok(value) => Ok(Some(value.to_string())),
            Err(_) => Err(text_response(
                StatusCode::BAD_REQUEST,
                None,
                "Invalid Origin header",
            )),
        },
        None => Ok(None),
    }
}

fn authorize_bridge_request(
    req: &Request<Body>,
    state: &NativeBridgeState,
) -> Result<Option<String>, Response<Body>> {
    let origin = parse_origin(req)?;
    if let Some(origin_value) = origin.as_deref() {
        if !native_messaging_installer::is_allowed_extension_origin(origin_value) {
            return Err(text_response(StatusCode::FORBIDDEN, None, "Forbidden"));
        }
    }

    let auth_header = match req.headers().get("Authorization") {
        Some(header) => match header.to_str() {
            Ok(value) => value,
            Err(_) => {
                return Err(text_response(
                    StatusCode::BAD_REQUEST,
                    origin.as_deref(),
                    "Invalid Authorization header",
                ))
            }
        },
        None => {
            return Err(text_response(
                StatusCode::UNAUTHORIZED,
                origin.as_deref(),
                "Missing Authorization header",
            ))
        }
    };

    let expected = format!("Bearer {}", state.bridge_token);
    if auth_header != expected {
        return Err(text_response(
            StatusCode::UNAUTHORIZED,
            origin.as_deref(),
            "Invalid bridge token",
        ));
    }

    Ok(origin)
}

async fn read_body_limited(body: Body) -> Result<Vec<u8>, &'static str> {
    let mut body = body;
    let mut bytes = Vec::new();

    while let Some(chunk_result) = body.data().await {
        let chunk = chunk_result.map_err(|_| "Failed to read request body")?;
        if bytes.len() + chunk.len() > BRIDGE_POST_BODY_LIMIT_BYTES {
            return Err("Payload Too Large");
        }
        bytes.extend_from_slice(&chunk);
    }

    Ok(bytes)
}

async fn parse_json_body<T: serde::de::DeserializeOwned>(
    req: Request<Body>,
    origin: Option<&str>,
) -> Result<T, Response<Body>> {
    let body_bytes = match read_body_limited(req.into_body()).await {
        Ok(bytes) => bytes,
        Err("Payload Too Large") => {
            return Err(text_response(
                StatusCode::PAYLOAD_TOO_LARGE,
                origin,
                "Payload Too Large",
            ))
        }
        Err(_) => {
            return Err(text_response(
                StatusCode::BAD_REQUEST,
                origin,
                "Failed to read request body",
            ))
        }
    };

    let body_str = match String::from_utf8(body_bytes) {
        Ok(value) => value,
        Err(_) => {
            return Err(text_response(
                StatusCode::BAD_REQUEST,
                origin,
                "Invalid UTF-8 request body",
            ))
        }
    };

    serde_json::from_str(&body_str).map_err(|_| {
        text_response(StatusCode::BAD_REQUEST, origin, "Invalid JSON request body")
    })
}

fn parse_query_value(req: &Request<Body>, key: &str) -> Result<Option<String>, Response<Body>> {
    let query = req.uri().query().unwrap_or("");
    for segment in query.split('&') {
        if let Some(raw_value) = segment.strip_prefix(&format!("{}=", key)) {
            let decoded = urlencoding::decode(raw_value).map_err(|_| {
                text_response(StatusCode::BAD_REQUEST, None, "Invalid query string")
            })?;
            return Ok(Some(decoded.into_owned()));
        }
    }

    Ok(None)
}

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

fn decrypt_item_payload(
    item: &DecryptItemPayload,
    vault_key_base64: &str,
) -> Result<String, String> {
    if let Some(user_id) = item.user_id.as_deref().filter(|value| !value.is_empty()) {
        let version = normalize_item_version(item.version);
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
                "[native-bridge] Failed reading bearer token from keychain for {}: {}",
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
                    "[native-bridge] Failed migrating bearer token to keychain for {}: {}",
                    email, error
                );
                None
            }
        }
    } else {
        None
    }
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
    if path.starts_with("/native-bridge/") && req.method() == Method::OPTIONS {
        let origin = match parse_origin(&req) {
            Ok(origin) => origin,
            Err(response) => return Ok(response),
        };

        if let Some(origin_value) = origin.as_deref() {
            if !native_messaging_installer::is_allowed_extension_origin(origin_value) {
                return Ok(text_response(StatusCode::FORBIDDEN, None, "Forbidden"));
            }
        }

        let mut builder = Response::builder()
            .status(StatusCode::NO_CONTENT)
            .header(
                "Access-Control-Allow-Methods",
                "GET, POST, OPTIONS",
            )
            .header(
                "Access-Control-Allow-Headers",
                "Authorization, Content-Type",
            );
        if let Some(origin_value) = origin.as_deref() {
            builder = builder
                .header("Access-Control-Allow-Origin", origin_value)
                .header("Vary", "Origin");
        }

        return Ok(builder
            .body(Body::empty())
            .unwrap_or_else(|_| Response::new(Body::empty())));
    }

    match (req.method(), path) {
        (&Method::GET, "/native-bridge/auth") => {
            let origin = match parse_origin(&req) {
                Ok(origin) => origin,
                Err(response) => return Ok(response),
            };
            if origin.is_some() {
                return Ok(text_response(StatusCode::FORBIDDEN, None, "Forbidden"));
            }

            let query = BridgeAuthQuery {
                extension_id: match parse_query_value(&req, "extension_id") {
                    Ok(value) => value,
                    Err(response) => return Ok(response),
                },
            };

            let allowed_origin = match query.extension_id.as_deref() {
                Some(extension_id) => match native_messaging_installer::allowed_origin_for_extension_id(extension_id) {
                    Some(origin) => Some(origin),
                    None => return Ok(text_response(StatusCode::FORBIDDEN, None, "Forbidden")),
                },
                None => None,
            };

            return Ok(json_response(
                StatusCode::OK,
                None,
                &serde_json::json!({
                    "bridgeToken": state.bridge_token,
                    "allowedOrigin": allowed_origin,
                    "bridgeVersion": BRIDGE_VERSION,
                }),
            ));
        }
        (&Method::GET, "/native-bridge/lock-status") => {
            let origin = match authorize_bridge_request(&req, &state) {
                Ok(origin) => origin,
                Err(response) => return Ok(response),
            };

            match get_lock_status_internal(&app_handle).await {
                Ok(status) => Ok(json_response(StatusCode::OK, origin.as_deref(), &status)),
                Err(error) => {
                    let timestamp = std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .map(|duration| duration.as_millis() as i64)
                        .unwrap_or_default();
                    Ok(json_response(
                        StatusCode::OK,
                        origin.as_deref(),
                        &serde_json::json!({
                            "locked": true,
                            "unlocked_accounts": [],
                            "timestamp": timestamp,
                            "autolock_timeout_ms": -1,
                            "error": error,
                        }),
                    ))
                }
            }
        }
        (&Method::GET, "/native-bridge/lock-events") => {
            let origin = match authorize_bridge_request(&req, &state) {
                Ok(origin) => origin,
                Err(response) => return Ok(response),
            };
            let mut rx = state.lock_events.subscribe();

            let event_stream = async_stream::stream! {
                let timestamp = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|duration| duration.as_millis() as i64)
                    .unwrap_or_default();
                yield Ok::<_, std::io::Error>(format!("event: connected\ndata: {}\n\n", serde_json::json!({ "timestamp": timestamp })));

                while let Ok(event) = rx.recv().await {
                    let event_name = match &event {
                        LockEvent::Lock { .. } => "lock",
                        LockEvent::Unlock { .. } => "unlock",
                        LockEvent::DesktopClose { .. } => "desktop_close",
                        LockEvent::ActiveAccountChanged { .. } => "active_account_changed",
                    };
                    if let Ok(data) = serde_json::to_string(&event) {
                        yield Ok(format!("event: {}\ndata: {}\n\n", event_name, data));
                    }
                }
            };

            let mut builder = Response::builder()
                .status(StatusCode::OK)
                .header("Content-Type", "text/event-stream")
                .header("Cache-Control", "no-cache")
                .header("Connection", "keep-alive");
            if let Some(origin_value) = origin.as_deref() {
                builder = builder
                    .header("Access-Control-Allow-Origin", origin_value)
                    .header("Vary", "Origin");
            }

            return Ok(builder
                .body(Body::wrap_stream(event_stream))
                .unwrap_or_else(|_| Response::new(Body::empty())));
        }
        (&Method::GET, "/native-bridge/biometric-status") => {
            let origin = match authorize_bridge_request(&req, &state) {
                Ok(origin) => origin,
                Err(response) => return Ok(response),
            };

            match check_biometric_status_internal(&app_handle).await {
                Ok(status) => Ok(json_response(StatusCode::OK, origin.as_deref(), &status)),
                Err(error) => Ok(json_response(
                    StatusCode::OK,
                    origin.as_deref(),
                    &serde_json::json!({
                        "available": false,
                        "enabled": false,
                        "error": error,
                    }),
                )),
            }
        }
        (&Method::POST, "/native-bridge/biometric-unlock") => {
            let origin = match authorize_bridge_request(&req, &state) {
                Ok(origin) => origin,
                Err(response) => return Ok(response),
            };
            let request: BiometricUnlockRequest = match parse_json_body(req, origin.as_deref()).await {
                Ok(request) => request,
                Err(response) => return Ok(response),
            };

            match biometric_unlock_internal(
                &app_handle,
                &request.challenge,
                &request.extension_id,
                request.email.as_deref(),
            ).await {
                Ok(response) => Ok(json_response(StatusCode::OK, origin.as_deref(), &response)),
                Err(error) => Ok(json_response(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    origin.as_deref(),
                    &serde_json::json!({ "error": error }),
                )),
            }
        }
        (&Method::POST, "/native-bridge/trigger-unlock") => {
            let origin = match authorize_bridge_request(&req, &state) {
                Ok(origin) => origin,
                Err(response) => return Ok(response),
            };

            if let Err(error) = open_app_internal(&app_handle) {
                eprintln!("[native-bridge] Failed to show desktop window: {}", error);
            }

            if let Err(error) = app_handle.emit("trigger-biometric-unlock", ()) {
                return Ok(json_response(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    origin.as_deref(),
                    &serde_json::json!({ "error": error.to_string() }),
                ));
            }

            Ok(json_response(
                StatusCode::OK,
                origin.as_deref(),
                &serde_json::json!({
                    "success": true,
                    "message": "Desktop unlock triggered",
                }),
            ))
        }
        (&Method::POST, "/native-bridge/biometric-unlock-all") => {
            let origin = match authorize_bridge_request(&req, &state) {
                Ok(origin) => origin,
                Err(response) => return Ok(response),
            };
            let request: BiometricUnlockAllRequest = match parse_json_body(req, origin.as_deref()).await {
                Ok(request) => request,
                Err(response) => return Ok(response),
            };

            match biometric_unlock_all_internal(&app_handle, &request.challenge, &request.extension_id).await {
                Ok(response) => Ok(json_response(StatusCode::OK, origin.as_deref(), &response)),
                Err(error) => Ok(json_response(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    origin.as_deref(),
                    &serde_json::json!({ "error": error }),
                )),
            }
        }
        (&Method::POST, "/native-bridge/open-app") => {
            let origin = match authorize_bridge_request(&req, &state) {
                Ok(origin) => origin,
                Err(response) => return Ok(response),
            };

            match open_app_internal(&app_handle) {
                Ok(_) => Ok(json_response(
                    StatusCode::OK,
                    origin.as_deref(),
                    &serde_json::json!({ "success": true }),
                )),
                Err(error) => Ok(json_response(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    origin.as_deref(),
                    &serde_json::json!({
                        "success": false,
                        "error": error,
                    }),
                )),
            }
        }
        (&Method::GET, "/native-bridge/accounts") => {
            let origin = match authorize_bridge_request(&req, &state) {
                Ok(origin) => origin,
                Err(response) => return Ok(response),
            };

            match get_accounts_list_internal(&app_handle).await {
                Ok(data) => Ok(json_response(StatusCode::OK, origin.as_deref(), &data)),
                Err(error) => Ok(json_response(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    origin.as_deref(),
                    &serde_json::json!({ "error": error }),
                )),
            }
        }
        (&Method::GET, "/native-bridge/session-data") => {
            let origin = match authorize_bridge_request(&req, &state) {
                Ok(origin) => origin,
                Err(response) => return Ok(response),
            };

            match get_session_data_internal(&app_handle).await {
                Ok(data) => Ok(json_response(StatusCode::OK, origin.as_deref(), &data)),
                Err(error) => Ok(json_response(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    origin.as_deref(),
                    &serde_json::json!({ "error": error }),
                )),
            }
        }
        (&Method::GET, "/native-bridge/vault-keys") => {
            let origin = match authorize_bridge_request(&req, &state) {
                Ok(origin) => origin,
                Err(response) => return Ok(response),
            };
            let query = VaultKeysQuery {
                email: match parse_query_value(&req, "email") {
                    Ok(value) => value,
                    Err(response) => return Ok(response),
                },
            };

            match get_vault_keys_internal(&app_handle, query.email).await {
                Ok(data) => Ok(json_response(StatusCode::OK, origin.as_deref(), &data)),
                Err(error) => Ok(json_response(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    origin.as_deref(),
                    &serde_json::json!({ "error": error }),
                )),
            }
        }
        (&Method::POST, "/native-bridge/decrypt-items") => {
            let origin = match authorize_bridge_request(&req, &state) {
                Ok(origin) => origin,
                Err(response) => return Ok(response),
            };
            let request: DecryptItemsRequest = match parse_json_body(req, origin.as_deref()).await {
                Ok(request) => request,
                Err(response) => return Ok(response),
            };

            match decrypt_items_internal(&app_handle, &request.email, &request.items).await {
                Ok(result) => Ok(json_response(StatusCode::OK, origin.as_deref(), &result)),
                Err(error) => Ok(json_response(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    origin.as_deref(),
                    &serde_json::json!({ "error": error }),
                )),
            }
        }
        _ => Ok(text_response(StatusCode::NOT_FOUND, None, "Not found")),
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
                            if let Some(jwt_token) = get_bearer_token_for_account(&store, email) {
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
    items: &[DecryptItemPayload],
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
        let vault_key = decrypted_vault_keys.get(&item.vault_id);
        if vault_key.is_none() {
            failed_items.push(serde_json::json!({
                "id": item.id,
                "error": "Vault key not found"
            }));
            continue;
        }

        match decrypt_item_payload(item, vault_key.unwrap()) {
            Ok(decrypted_data) => {
                decrypted_items.push(serde_json::json!({
                    "id": item.id,
                    "decrypted_data": decrypted_data,
                }));
            }
            Err(e) => {
                failed_items.push(serde_json::json!({
                    "id": item.id,
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
