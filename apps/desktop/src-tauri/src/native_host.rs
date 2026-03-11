/**
 * Native Messaging Host for Chrome Extension Communication
 * 
 * Implements Chrome's Native Messaging protocol:
 * - Messages are prefixed with 4-byte length (little-endian)
 * - Messages are JSON payloads
 * - Communication via stdin/stdout
 * 
 * This binary acts as a bridge between the browser extension and the Tauri app.
 */

mod native_messaging_installer;

use serde::{Deserialize, Serialize};
use std::io::{self, Read, Write};
use std::process::Command;

#[derive(Debug, Serialize, Deserialize)]
#[serde(tag = "type")]
enum NativeMessage {
    #[serde(rename = "PING")]
    Ping,

    #[serde(rename = "CHECK_BIOMETRIC_AVAILABLE")]
    CheckBiometricAvailable,

    #[serde(rename = "GET_BRIDGE_AUTH")]
    GetBridgeAuth {
        extension_id: String,
    },

    #[serde(rename = "BIOMETRIC_UNLOCK_REQUEST")]
    BiometricUnlockRequest {
        challenge: String,
        extension_id: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        email: Option<String>,
    },

    #[serde(rename = "BIOMETRIC_UNLOCK_ALL_REQUEST")]
    BiometricUnlockAllRequest {
        challenge: String,
        extension_id: String,
    },

    #[serde(rename = "OPEN_DESKTOP_APP")]
    OpenDesktopApp,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(tag = "type")]
enum NativeResponse {
    #[serde(rename = "PONG")]
    Pong { version: String },
    
    #[serde(rename = "BIOMETRIC_STATUS")]
    BiometricStatus { 
        available: bool,
        enabled: bool,
        app_running: bool,
    },

    #[serde(rename = "BRIDGE_AUTH")]
    BridgeAuth {
        bridge_token: String,
        allowed_origin: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        bridge_version: Option<String>,
    },
    
    #[serde(rename = "BIOMETRIC_UNLOCK_SUCCESS")]
    BiometricUnlockSuccess { 
        encrypted_session: String,
        device_key: String,
        signature: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        auth_token: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        vault_keys: Option<String>,
    },
    
    #[serde(rename = "BIOMETRIC_UNLOCK_FAILED")]
    BiometricUnlockFailed {
        error: String,
    },

    #[serde(rename = "BIOMETRIC_UNLOCK_ALL_SUCCESS")]
    BiometricUnlockAllSuccess {
        device_key: String,
        signature: String,
        accounts: Vec<AccountUnlockData>,
        unlocked: Vec<String>,
        failed: Vec<String>,
    },

    #[serde(rename = "BIOMETRIC_UNLOCK_ALL_FAILED")]
    BiometricUnlockAllFailed {
        error: String,
    },

    #[serde(rename = "OPEN_DESKTOP_APP_RESULT")]
    OpenDesktopAppResult {
        success: bool,
        #[serde(skip_serializing_if = "Option::is_none")]
        error: Option<String>,
    },
    
    #[serde(rename = "ERROR")]
    Error { message: String },
}

#[derive(Debug, Serialize, Deserialize)]
struct AccountUnlockData {
    email: String,
    encrypted_session: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    auth_token: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    vault_keys: Option<String>,
}

#[derive(Debug, Deserialize)]
struct DesktopBridgeAuthResponse {
    #[serde(rename = "bridgeToken")]
    bridge_token: String,
    #[serde(rename = "allowedOrigin")]
    allowed_origin: Option<String>,
    #[serde(rename = "bridgeVersion")]
    bridge_version: Option<String>,
}

fn log_native(message: &str) {
    eprintln!("[native-host] {}", message);
}

fn summarize_message(message: &NativeMessage) -> String {
    match message {
        NativeMessage::Ping => "PING".to_string(),
        NativeMessage::CheckBiometricAvailable => {
            "CHECK_BIOMETRIC_AVAILABLE".to_string()
        }
        NativeMessage::GetBridgeAuth { extension_id } => {
            format!("GET_BRIDGE_AUTH extension_id={}", extension_id)
        }
        NativeMessage::BiometricUnlockRequest {
            extension_id,
            email,
            ..
        } => format!(
            "BIOMETRIC_UNLOCK_REQUEST extension_id={} email_present={}",
            extension_id,
            email.is_some()
        ),
        NativeMessage::BiometricUnlockAllRequest { extension_id, .. } => {
            format!("BIOMETRIC_UNLOCK_ALL_REQUEST extension_id={}", extension_id)
        }
        NativeMessage::OpenDesktopApp => "OPEN_DESKTOP_APP".to_string(),
    }
}

/// Read a message from stdin following Chrome's native messaging protocol
fn read_message() -> io::Result<NativeMessage> {
    let mut length_bytes = [0u8; 4];
    io::stdin().read_exact(&mut length_bytes)?;
    
    let length = u32::from_le_bytes(length_bytes) as usize;
    
    let mut buffer = vec![0u8; length];
    io::stdin().read_exact(&mut buffer)?;
    
    let message: NativeMessage = serde_json::from_slice(&buffer)
        .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))?;
    
    Ok(message)
}

/// Write a message to stdout following Chrome's native messaging protocol
fn write_message(response: &NativeResponse) -> io::Result<()> {
    let json = serde_json::to_vec(response)
        .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))?;
    
    let length = json.len() as u32;
    let length_bytes = length.to_le_bytes();
    
    io::stdout().write_all(&length_bytes)?;
    io::stdout().write_all(&json)?;
    io::stdout().flush()?;
    
    Ok(())
}

/// Check if the main Tauri app is running and communicate with it
async fn communicate_with_tauri(message: &NativeMessage) -> NativeResponse {
    // TODO: Implement actual communication with Tauri app
    // Options:
    // 1. HTTP request to localhost:PORT (requires Tauri to run HTTP server)
    // 2. Unix domain socket (macOS/Linux) or Named Pipe (Windows)
    // 3. Shared file with auth token
    
    match message {
        NativeMessage::Ping => {
            log_native("responding to PING");
            NativeResponse::Pong {
                version: env!("CARGO_PKG_VERSION").to_string(),
            }
        }
        
        NativeMessage::CheckBiometricAvailable => {
            log_native("checking desktop biometric status via bridge");
            // Try to communicate with Tauri app via HTTP
            match check_tauri_app().await {
                Ok(status) => status,
                Err(error) => {
                    log_native(&format!(
                        "desktop biometric status check failed: {}",
                        error
                    ));
                    NativeResponse::BiometricStatus {
                        available: false,
                        enabled: false,
                        app_running: false,
                    }
                }
            }
        }

        NativeMessage::GetBridgeAuth { extension_id } => {
            log_native(&format!(
                "loading bridge auth for extension_id={}",
                extension_id
            ));
            match fetch_bridge_auth(Some(extension_id.as_str())).await {
                Ok(auth) => {
                    let allowed_origin = auth.allowed_origin.unwrap_or_else(|| {
                        format!("chrome-extension://{}", extension_id)
                    });
                    log_native(&format!(
                        "bridge auth succeeded for extension_id={} allowed_origin={} version={}",
                        extension_id,
                        allowed_origin,
                        auth.bridge_version.as_deref().unwrap_or("unknown")
                    ));
                    NativeResponse::BridgeAuth {
                        bridge_token: auth.bridge_token,
                        allowed_origin,
                        bridge_version: auth.bridge_version,
                    }
                }
                Err(error) => {
                    log_native(&format!(
                        "bridge auth failed for extension_id={}: {}",
                        extension_id, error
                    ));
                    NativeResponse::Error {
                        message: error.to_string(),
                    }
                }
            }
        }
        
        NativeMessage::BiometricUnlockRequest { challenge, extension_id, email } => {
            log_native(&format!(
                "forwarding biometric unlock request extension_id={} challenge_len={} email_present={}",
                extension_id,
                challenge.len(),
                email.is_some()
            ));
            match request_biometric_unlock(challenge, extension_id, email.as_deref()).await {
                Ok(response) => response,
                Err(e) => {
                    log_native(&format!(
                        "biometric unlock bridge call failed for extension_id={}: {}",
                        extension_id, e
                    ));
                    NativeResponse::BiometricUnlockFailed {
                        error: e.to_string(),
                    }
                }
            }
        }

        NativeMessage::BiometricUnlockAllRequest { challenge, extension_id } => {
            log_native(&format!(
                "forwarding biometric unlock all request extension_id={} challenge_len={}",
                extension_id,
                challenge.len()
            ));
            match request_biometric_unlock_all(challenge, extension_id).await {
                Ok(response) => response,
                Err(e) => {
                    log_native(&format!(
                        "biometric unlock all bridge call failed for extension_id={}: {}",
                        extension_id, e
                    ));
                    NativeResponse::BiometricUnlockAllFailed {
                        error: e.to_string(),
                    }
                }
            }
        }

        NativeMessage::OpenDesktopApp => {
            log_native("received open desktop app request");
            match open_desktop_app() {
                Ok(()) => NativeResponse::OpenDesktopAppResult {
                    success: true,
                    error: None,
                },
                Err(error) => {
                    log_native(&format!("open desktop app failed: {}", error));
                    NativeResponse::OpenDesktopAppResult {
                        success: false,
                        error: Some(error),
                    }
                }
            }
        }
    }
}

fn try_command_status(command: &str, args: &[&str]) -> bool {
    Command::new(command)
        .args(args)
        .status()
        .map(|status| status.success())
        .unwrap_or(false)
}

fn try_command_spawn(command: &str, args: &[&str]) -> bool {
    Command::new(command).args(args).spawn().is_ok()
}

async fn open_desktop_app_async() -> Result<(), String> {
    // Try HTTP request first (if app is already running)
    match try_http_open_app().await {
        Ok(_) => {
            eprintln!("App opened via HTTP request");
            return Ok(());
        }
        Err(e) => {
            eprintln!("HTTP request failed: {}, trying system commands...", e);
        }
    }
    
    // Fall back to system commands
    open_desktop_app_system()
}

fn open_desktop_app() -> Result<(), String> {
    // This is a blocking wrapper for the async function
    tokio::task::block_in_place(|| {
        tokio::runtime::Handle::current().block_on(open_desktop_app_async())
    })
}

async fn try_http_open_app() -> Result<(), Box<dyn std::error::Error>> {
    log_native("requesting bridge auth for open-app");
    let bridge_auth = fetch_bridge_auth(None).await?;
    let client = bridge_http_client(2)?;
    log_native("POST /native-bridge/open-app");
    let response = client
        .post("http://localhost:48765/native-bridge/open-app")
        .bearer_auth(&bridge_auth.bridge_token)
        .send()
        .await?;
    log_native(&format!(
        "POST /native-bridge/open-app -> {}",
        response.status()
    ));
    
    if response.status().is_success() {
        Ok(())
    } else {
        Err(format!("HTTP request failed with status: {}", response.status()).into())
    }
}

fn open_desktop_app_system() -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        if try_command_status("open", &["-b", "com.bittery.desktop"]) {
            return Ok(());
        }

        if try_command_status("open", &["-a", "bittery"]) {
            return Ok(());
        }

        if try_command_status("open", &["-a", "Bittery"]) {
            return Ok(());
        }

        return Err("Unable to open Bittery via macOS open".to_string());
    }

    #[cfg(target_os = "windows")]
    {
        if try_command_status("cmd", &["/C", "start", "", "bittery"]) {
            return Ok(());
        }

        if try_command_status("cmd", &["/C", "start", "", "Bittery"]) {
            return Ok(());
        }

        return Err("Unable to open Bittery via Windows start".to_string());
    }

    #[cfg(target_os = "linux")]
    {
        if try_command_spawn("bittery", &[]) {
            return Ok(());
        }

        if try_command_status("gtk-launch", &["com.bittery.desktop"]) {
            return Ok(());
        }

        if try_command_status("xdg-open", &["bittery"]) {
            return Ok(());
        }

        return Err("Unable to open Bittery. Ensure the app is installed.".to_string());
    }

    #[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
    {
        Err("Unsupported platform".to_string())
    }
}

fn bridge_http_client(timeout_secs: u64) -> Result<reqwest::Client, Box<dyn std::error::Error>> {
    Ok(reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(timeout_secs))
        .build()?)
}

async fn fetch_bridge_auth(
    extension_id: Option<&str>,
) -> Result<DesktopBridgeAuthResponse, Box<dyn std::error::Error>> {
    if let Some(extension_id) = extension_id {
        if native_messaging_installer::allowed_origin_for_extension_id(extension_id).is_none() {
            log_native(&format!(
                "bridge auth rejected: extension_id={} is not allowlisted",
                extension_id
            ));
            return Err("Extension ID is not allowlisted".into());
        }
    }

    let client = bridge_http_client(2)?;
    let mut request = client.get("http://localhost:48765/native-bridge/auth");
    if let Some(extension_id) = extension_id {
        request = request.query(&[("extension_id", extension_id)]);
    }

    log_native(&format!(
        "GET /native-bridge/auth extension_id={}",
        extension_id.unwrap_or("<none>")
    ));

    let response = request.send().await?;
    log_native(&format!(
        "GET /native-bridge/auth -> {}",
        response.status()
    ));
    if !response.status().is_success() {
        return Err(format!("Bridge auth failed with status {}", response.status()).into());
    }

    let auth = response.json::<DesktopBridgeAuthResponse>().await?;
    if auth.bridge_token.is_empty() {
        return Err("Desktop bridge returned an empty token".into());
    }

    Ok(auth)
}

/// Check if Tauri app is running and has biometric available
async fn check_tauri_app() -> Result<NativeResponse, Box<dyn std::error::Error>> {
    log_native("checking biometric status through desktop bridge");
    let bridge_auth = fetch_bridge_auth(None).await?;
    let client = bridge_http_client(2)?;
    log_native("GET /native-bridge/biometric-status");
    let response = client
        .get("http://localhost:48765/native-bridge/biometric-status")
        .bearer_auth(&bridge_auth.bridge_token)
        .send()
        .await?;
    log_native(&format!(
        "GET /native-bridge/biometric-status -> {}",
        response.status()
    ));
    
    let status: BiometricStatusResponse = response.json().await?;
    
    Ok(NativeResponse::BiometricStatus {
        available: status.available,
        enabled: status.enabled,
        app_running: true,
    })
}

/// Request biometric unlock from Tauri app
async fn request_biometric_unlock(
    challenge: &str,
    extension_id: &str,
    email: Option<&str>,
) -> Result<NativeResponse, Box<dyn std::error::Error>> {
    let bridge_auth = fetch_bridge_auth(Some(extension_id)).await?;
    let client = bridge_http_client(30)?;

    let mut payload = serde_json::json!({
        "challenge": challenge,
        "extension_id": extension_id,
    });

    if let Some(email_str) = email {
        payload["email"] = serde_json::json!(email_str);
    }

    log_native(&format!(
        "POST /native-bridge/biometric-unlock extension_id={} email_present={}",
        extension_id,
        email.is_some()
    ));
    let response = client
        .post("http://localhost:48765/native-bridge/biometric-unlock")
        .bearer_auth(&bridge_auth.bridge_token)
        .json(&payload)
        .send()
        .await?;
    log_native(&format!(
        "POST /native-bridge/biometric-unlock -> {}",
        response.status()
    ));

    if response.status().is_success() {
        let unlock_response: BiometricUnlockResponse = response.json().await?;

        Ok(NativeResponse::BiometricUnlockSuccess {
            encrypted_session: unlock_response.encrypted_session,
            device_key: unlock_response.device_key,
            signature: unlock_response.signature,
            auth_token: unlock_response.auth_token,
            vault_keys: unlock_response.vault_keys,
        })
    } else {
        let error_text = response.text().await?;
        Ok(NativeResponse::BiometricUnlockFailed {
            error: error_text,
        })
    }
}

/// Request biometric unlock for all accounts from Tauri app
async fn request_biometric_unlock_all(
    challenge: &str,
    extension_id: &str,
) -> Result<NativeResponse, Box<dyn std::error::Error>> {
    let bridge_auth = fetch_bridge_auth(Some(extension_id)).await?;
    let client = bridge_http_client(30)?;

    let payload = serde_json::json!({
        "challenge": challenge,
        "extension_id": extension_id,
    });

    log_native(&format!(
        "POST /native-bridge/biometric-unlock-all extension_id={}",
        extension_id
    ));
    let response = client
        .post("http://localhost:48765/native-bridge/biometric-unlock-all")
        .bearer_auth(&bridge_auth.bridge_token)
        .json(&payload)
        .send()
        .await?;
    log_native(&format!(
        "POST /native-bridge/biometric-unlock-all -> {}",
        response.status()
    ));

    if response.status().is_success() {
        let unlock_response: BiometricUnlockAllResponse = response.json().await?;

        Ok(NativeResponse::BiometricUnlockAllSuccess {
            device_key: unlock_response.device_key,
            signature: unlock_response.signature,
            accounts: unlock_response.accounts,
            unlocked: unlock_response.unlocked,
            failed: unlock_response.failed,
        })
    } else {
        let error_text = response.text().await?;
        Ok(NativeResponse::BiometricUnlockAllFailed {
            error: error_text,
        })
    }
}

#[derive(Deserialize)]
struct BiometricStatusResponse {
    available: bool,
    enabled: bool,
}

#[derive(Deserialize)]
struct BiometricUnlockResponse {
    encrypted_session: String,
    device_key: String,
    signature: String,
    auth_token: Option<String>,
    vault_keys: Option<String>,
}

#[derive(Deserialize)]
struct BiometricUnlockAllResponse {
    device_key: String,
    signature: String,
    accounts: Vec<AccountUnlockData>,
    unlocked: Vec<String>,
    failed: Vec<String>,
}

/// Main entry point for native messaging host
#[tokio::main]
async fn main() {
    // Log to stderr (stdout is reserved for protocol messages)
    log_native("started");
    
    loop {
        match read_message() {
            Ok(message) => {
                log_native(&format!("received {}", summarize_message(&message)));
                
                let response = communicate_with_tauri(&message).await;
                
                if let Err(e) = write_message(&response) {
                    log_native(&format!("failed to write response: {}", e));
                    break;
                }
            }
            Err(e) => {
                log_native(&format!("failed to read message: {}", e));
                
                // Write error response if possible
                let _ = write_message(&NativeResponse::Error {
                    message: e.to_string(),
                });
                
                break;
            }
        }
    }
    
    log_native("stopped");
}
