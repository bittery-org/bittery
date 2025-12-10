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

use serde::{Deserialize, Serialize};
use std::io::{self, Read, Write};

#[derive(Debug, Serialize, Deserialize)]
#[serde(tag = "type")]
enum NativeMessage {
    #[serde(rename = "PING")]
    Ping,
    
    #[serde(rename = "CHECK_BIOMETRIC_AVAILABLE")]
    CheckBiometricAvailable,
    
    #[serde(rename = "BIOMETRIC_UNLOCK_REQUEST")]
    BiometricUnlockRequest { 
        challenge: String,
        extension_id: String,
    },
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
    
    #[serde(rename = "ERROR")]
    Error { message: String },
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
            NativeResponse::Pong {
                version: env!("CARGO_PKG_VERSION").to_string(),
            }
        }
        
        NativeMessage::CheckBiometricAvailable => {
            // Try to communicate with Tauri app via HTTP
            match check_tauri_app().await {
                Ok(status) => status,
                Err(e) => NativeResponse::BiometricStatus {
                    available: false,
                    enabled: false,
                    app_running: false,
                },
            }
        }
        
        NativeMessage::BiometricUnlockRequest { challenge, extension_id } => {
            // Forward to Tauri app for biometric authentication
            match request_biometric_unlock(challenge, extension_id).await {
                Ok(response) => response,
                Err(e) => NativeResponse::BiometricUnlockFailed {
                    error: e.to_string(),
                },
            }
        }
    }
}

/// Check if Tauri app is running and has biometric available
async fn check_tauri_app() -> Result<NativeResponse, Box<dyn std::error::Error>> {
    // Try to connect to Tauri app on localhost
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(2))
        .build()?;
    
    let response = client
        .get("http://localhost:48765/native-bridge/biometric-status")
        .send()
        .await?;
    
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
) -> Result<NativeResponse, Box<dyn std::error::Error>> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30)) // Longer timeout for user interaction
        .build()?;
    
    let response = client
        .post("http://localhost:48765/native-bridge/biometric-unlock")
        .json(&serde_json::json!({
            "challenge": challenge,
            "extension_id": extension_id,
        }))
        .send()
        .await?;
    
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

/// Main entry point for native messaging host
#[tokio::main]
async fn main() {
    // Log to stderr (stdout is reserved for protocol messages)
    eprintln!("Bittery Native Messaging Host started");
    
    loop {
        match read_message() {
            Ok(message) => {
                eprintln!("Received message: {:?}", message);
                
                let response = communicate_with_tauri(&message).await;
                
                if let Err(e) = write_message(&response) {
                    eprintln!("Failed to write response: {}", e);
                    break;
                }
            }
            Err(e) => {
                eprintln!("Failed to read message: {}", e);
                
                // Write error response if possible
                let _ = write_message(&NativeResponse::Error {
                    message: e.to_string(),
                });
                
                break;
            }
        }
    }
    
    eprintln!("Bittery Native Messaging Host stopped");
}
