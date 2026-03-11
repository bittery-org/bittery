/**
 * Native messaging host for browser extensions.
 *
 * The browser-facing transport stays Chrome native messaging over stdio.
 * The desktop-facing transport is a local IPC socket/pipe using the shared
 * length-prefixed JSON codec defined in `desktop_ipc.rs`.
 */

mod desktop_ipc;
mod native_messaging_installer;

use desktop_ipc::{
    desktop_ipc_socket_path, read_frame, write_frame, DesktopEnvelope, DesktopRequest,
    DesktopResponse,
};
use std::io::{self, Read, Write};
use std::process::Command;
use std::sync::Arc;
use tokio::sync::{mpsc, Mutex};
use tokio::task::JoinHandle;

type NativeRequest = DesktopEnvelope<DesktopRequest>;
type NativeResponse = DesktopEnvelope<DesktopResponse>;

fn log_native(message: &str) {
    eprintln!("[native-host] {}", message);
}

fn now_timestamp_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or_default()
}

fn summarize_message(message: &DesktopRequest) -> String {
    match message {
        DesktopRequest::Ping => "PING".to_string(),
        DesktopRequest::GetDesktopStatus => "GET_DESKTOP_STATUS".to_string(),
        DesktopRequest::GetDesktopAccounts => "GET_DESKTOP_ACCOUNTS".to_string(),
        DesktopRequest::GetDesktopAuthToken { email } => {
            format!("GET_DESKTOP_AUTH_TOKEN email={}", email)
        }
        DesktopRequest::GetDesktopVaultKeys { email } => {
            format!("GET_DESKTOP_VAULT_KEYS email={}", email)
        }
        DesktopRequest::GetDesktopItemsSnapshot { emails } => format!(
            "GET_DESKTOP_ITEMS_SNAPSHOT emails={}",
            emails.as_ref().map(|values| values.len()).unwrap_or_default()
        ),
        DesktopRequest::SubscribeDesktopEvents => "SUBSCRIBE_DESKTOP_EVENTS".to_string(),
        DesktopRequest::UnsubscribeDesktopEvents => "UNSUBSCRIBE_DESKTOP_EVENTS".to_string(),
        DesktopRequest::CheckBiometricAvailable => {
            "CHECK_BIOMETRIC_AVAILABLE".to_string()
        }
        DesktopRequest::BiometricUnlockRequest {
            extension_id,
            email,
            ..
        } => format!(
            "BIOMETRIC_UNLOCK_REQUEST extension_id={} email_present={}",
            extension_id,
            email.is_some()
        ),
        DesktopRequest::BiometricUnlockAllRequest { extension_id, .. } => format!(
            "BIOMETRIC_UNLOCK_ALL_REQUEST extension_id={}",
            extension_id
        ),
        DesktopRequest::TriggerDesktopUnlock => "TRIGGER_DESKTOP_UNLOCK".to_string(),
        DesktopRequest::OpenDesktopApp => "OPEN_DESKTOP_APP".to_string(),
    }
}

fn read_native_message() -> io::Result<NativeRequest> {
    let mut length_bytes = [0u8; 4];
    io::stdin().read_exact(&mut length_bytes)?;
    let length = u32::from_le_bytes(length_bytes) as usize;

    let mut buffer = vec![0u8; length];
    io::stdin().read_exact(&mut buffer)?;

    serde_json::from_slice(&buffer)
        .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))
}

fn write_native_message(response: &NativeResponse) -> io::Result<()> {
    let json = serde_json::to_vec(response)
        .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))?;
    let length = json.len() as u32;
    io::stdout().write_all(&length.to_le_bytes())?;
    io::stdout().write_all(&json)?;
    io::stdout().flush()?;
    Ok(())
}

fn is_allowlisted_extension_id(extension_id: &str) -> bool {
    native_messaging_installer::allowed_origin_for_extension_id(extension_id).is_some()
}

fn validate_extension_request(request: &DesktopRequest) -> Result<(), String> {
    match request {
        DesktopRequest::BiometricUnlockRequest { extension_id, .. }
        | DesktopRequest::BiometricUnlockAllRequest { extension_id, .. } => {
            if !is_allowlisted_extension_id(extension_id) {
                return Err("Extension ID is not allowlisted".to_string());
            }
        }
        _ => {}
    }

    Ok(())
}

#[cfg(unix)]
async fn send_ipc_request(request: NativeRequest) -> Result<NativeResponse, String> {
    let socket_path = desktop_ipc_socket_path();
    let mut stream = tokio::net::UnixStream::connect(&socket_path)
        .await
        .map_err(|error| format!("Desktop IPC unavailable at {}: {}", socket_path.display(), error))?;
    write_frame(&mut stream, &request)
        .await
        .map_err(|error| format!("Failed writing IPC request: {}", error))?;
    read_frame(&mut stream)
        .await
        .map_err(|error| format!("Failed reading IPC response: {}", error))
}

#[cfg(windows)]
async fn send_ipc_request(request: NativeRequest) -> Result<NativeResponse, String> {
    use tokio::net::windows::named_pipe::ClientOptions;

    let pipe_name = desktop_ipc_socket_path();
    let pipe_name = pipe_name.to_string_lossy().to_string();
    let mut stream = ClientOptions::new()
        .open(&pipe_name)
        .map_err(|error| format!("Desktop IPC unavailable at {}: {}", pipe_name, error))?;
    write_frame(&mut stream, &request)
        .await
        .map_err(|error| format!("Failed writing IPC request: {}", error))?;
    read_frame(&mut stream)
        .await
        .map_err(|error| format!("Failed reading IPC response: {}", error))
}

#[cfg(not(any(unix, windows)))]
async fn send_ipc_request(_request: NativeRequest) -> Result<NativeResponse, String> {
    Err("Desktop IPC client is unavailable on this platform build".to_string())
}

fn try_command_status(command: &str, args: &[&str]) -> bool {
    Command::new(command)
        .args(args)
        .status()
        .map(|status| status.success())
        .unwrap_or(false)
}

#[cfg(target_os = "linux")]
fn try_command_spawn(command: &str, args: &[&str]) -> bool {
    Command::new(command).args(args).spawn().is_ok()
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

async fn open_desktop_app() -> DesktopResponse {
    let request = NativeRequest {
        request_id: None,
        payload: DesktopRequest::OpenDesktopApp,
    };

    match send_ipc_request(request).await {
        Ok(response) => response.payload,
        Err(_) => match open_desktop_app_system() {
            Ok(()) => DesktopResponse::OpenDesktopAppResult {
                success: true,
                error: None,
            },
            Err(error) => DesktopResponse::OpenDesktopAppResult {
                success: false,
                error: Some(error),
            },
        },
    }
}

async fn handle_request(request: NativeRequest) -> NativeResponse {
    if let Err(error) = validate_extension_request(&request.payload) {
        return NativeResponse {
            request_id: request.request_id,
            payload: DesktopResponse::Error { message: error },
        };
    }

    let request_id = request.request_id.clone();
    let request_payload = request.payload.clone();
    let payload = match request_payload {
        DesktopRequest::Ping => DesktopResponse::Pong {
            version: env!("CARGO_PKG_VERSION").to_string(),
        },
        DesktopRequest::OpenDesktopApp => open_desktop_app().await,
        DesktopRequest::GetDesktopStatus => match send_ipc_request(NativeRequest {
            request_id: request_id.clone(),
            payload: DesktopRequest::GetDesktopStatus,
        })
        .await
        {
            Ok(response) => response.payload,
            Err(_) => DesktopResponse::DesktopStatus {
                available: false,
                locked: true,
                unlocked_accounts: Vec::new(),
                timestamp: now_timestamp_ms(),
                autolock_timeout_ms: -1,
            },
        },
        DesktopRequest::CheckBiometricAvailable => match send_ipc_request(NativeRequest {
            request_id: request_id.clone(),
            payload: DesktopRequest::CheckBiometricAvailable,
        })
        .await
        {
            Ok(response) => response.payload,
            Err(_) => DesktopResponse::BiometricStatus {
                available: false,
                enabled: false,
                app_running: false,
            },
        },
        other_request => {
            let forward = NativeRequest {
                request_id: request_id.clone(),
                payload: other_request,
            };
            match send_ipc_request(forward).await {
                Ok(response) => {
                    return response;
                }
                Err(error) => DesktopResponse::Error { message: error },
            }
        }
    };

    NativeResponse {
        request_id: request_id,
        payload,
    }
}

#[derive(Default)]
struct SubscriptionState {
    task: Option<JoinHandle<()>>,
}

async fn start_event_subscription(
    request: NativeRequest,
    out_tx: mpsc::UnboundedSender<NativeResponse>,
    subscription_state: Arc<Mutex<SubscriptionState>>,
) {
    let mut state = subscription_state.lock().await;
    if state.task.is_some() {
        let _ = out_tx.send(NativeResponse {
            request_id: request.request_id,
            payload: DesktopResponse::DesktopEventSubscription { subscribed: true },
        });
        return;
    }

    #[cfg(unix)]
    {
        let socket_path = desktop_ipc_socket_path();
        let mut stream = match tokio::net::UnixStream::connect(&socket_path).await {
            Ok(stream) => stream,
            Err(error) => {
                let _ = out_tx.send(NativeResponse {
                    request_id: request.request_id,
                    payload: DesktopResponse::Error {
                        message: format!(
                            "Desktop IPC unavailable at {}: {}",
                            socket_path.display(),
                            error
                        ),
                    },
                });
                return;
            }
        };

        if let Err(error) = write_frame(&mut stream, &request).await {
            let _ = out_tx.send(NativeResponse {
                request_id: request.request_id,
                payload: DesktopResponse::Error {
                    message: format!("Failed writing subscribe request: {}", error),
                },
            });
            return;
        }

        let ack: NativeResponse = match read_frame(&mut stream).await {
            Ok(message) => message,
            Err(error) => {
                let _ = out_tx.send(NativeResponse {
                    request_id: request.request_id,
                    payload: DesktopResponse::Error {
                        message: format!("Failed reading subscribe ack: {}", error),
                    },
                });
                return;
            }
        };

        let _ = out_tx.send(ack);
        let forward_tx = out_tx.clone();
        state.task = Some(tokio::spawn(async move {
            let mut stream = stream;
            loop {
                match read_frame::<_, NativeResponse>(&mut stream).await {
                    Ok(message) => {
                        if forward_tx.send(message).is_err() {
                            break;
                        }
                    }
                    Err(error) => {
                        log_native(&format!("desktop event subscription ended: {}", error));
                        break;
                    }
                }
            }
        }));
        return;
    }

    #[cfg(windows)]
    {
        use tokio::net::windows::named_pipe::ClientOptions;

        let pipe_name = desktop_ipc_socket_path();
        let pipe_name = pipe_name.to_string_lossy().to_string();
        let mut stream = match ClientOptions::new().open(&pipe_name) {
            Ok(stream) => stream,
            Err(error) => {
                let _ = out_tx.send(NativeResponse {
                    request_id: request.request_id,
                    payload: DesktopResponse::Error {
                        message: format!("Desktop IPC unavailable at {}: {}", pipe_name, error),
                    },
                });
                return;
            }
        };

        if let Err(error) = write_frame(&mut stream, &request).await {
            let _ = out_tx.send(NativeResponse {
                request_id: request.request_id,
                payload: DesktopResponse::Error {
                    message: format!("Failed writing subscribe request: {}", error),
                },
            });
            return;
        }

        let ack: NativeResponse = match read_frame(&mut stream).await {
            Ok(message) => message,
            Err(error) => {
                let _ = out_tx.send(NativeResponse {
                    request_id: request.request_id,
                    payload: DesktopResponse::Error {
                        message: format!("Failed reading subscribe ack: {}", error),
                    },
                });
                return;
            }
        };

        let _ = out_tx.send(ack);
        let forward_tx = out_tx.clone();
        state.task = Some(tokio::spawn(async move {
            let mut stream = stream;
            loop {
                match read_frame::<_, NativeResponse>(&mut stream).await {
                    Ok(message) => {
                        if forward_tx.send(message).is_err() {
                            break;
                        }
                    }
                    Err(error) => {
                        log_native(&format!("desktop event subscription ended: {}", error));
                        break;
                    }
                }
            }
        }));
        return;
    }

    #[cfg(not(any(unix, windows)))]
    {
        let _ = out_tx.send(NativeResponse {
            request_id: request.request_id,
            payload: DesktopResponse::Error {
                message: "Desktop event subscription is unavailable on this platform build"
                    .to_string(),
            },
        });
    }
}

async fn stop_event_subscription(
    request_id: Option<String>,
    out_tx: &mpsc::UnboundedSender<NativeResponse>,
    subscription_state: Arc<Mutex<SubscriptionState>>,
) {
    let mut state = subscription_state.lock().await;
    if let Some(task) = state.task.take() {
        task.abort();
    }

    let _ = out_tx.send(NativeResponse {
        request_id,
        payload: DesktopResponse::DesktopEventSubscription { subscribed: false },
    });
}

#[tokio::main]
async fn main() {
    log_native("started");

    let (out_tx, mut out_rx) = mpsc::unbounded_channel::<NativeResponse>();
    let writer_lock = Arc::new(Mutex::new(()));
    let subscription_state = Arc::new(Mutex::new(SubscriptionState::default()));

    let writer_task = {
        let writer_lock = writer_lock.clone();
        tokio::spawn(async move {
            while let Some(response) = out_rx.recv().await {
                let _guard = writer_lock.lock().await;
                if let Err(error) = write_native_message(&response) {
                    log_native(&format!("failed to write response: {}", error));
                    break;
                }
            }
        })
    };

    loop {
        match read_native_message() {
            Ok(message) => {
                log_native(&format!("received {}", summarize_message(&message.payload)));
                match message.payload {
                    DesktopRequest::SubscribeDesktopEvents => {
                        start_event_subscription(
                            message,
                            out_tx.clone(),
                            subscription_state.clone(),
                        )
                        .await;
                    }
                    DesktopRequest::UnsubscribeDesktopEvents => {
                        stop_event_subscription(
                            message.request_id,
                            &out_tx,
                            subscription_state.clone(),
                        )
                        .await;
                    }
                    _ => {
                        let response = handle_request(message).await;
                        if out_tx.send(response).is_err() {
                            break;
                        }
                    }
                }
            }
            Err(error) => {
                log_native(&format!("failed to read message: {}", error));
                let _ = out_tx.send(NativeResponse {
                    request_id: None,
                    payload: DesktopResponse::Error {
                        message: error.to_string(),
                    },
                });
                break;
            }
        }
    }

    stop_event_subscription(None, &out_tx, subscription_state.clone()).await;
    drop(out_tx);
    let _ = writer_task.await;
    log_native("stopped");
}
