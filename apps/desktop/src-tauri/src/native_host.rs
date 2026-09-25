//! Native messaging host for browser extensions.
//!
//! The browser-facing transport stays Chrome native messaging over stdio.
//! The desktop-facing transport is a local IPC socket/pipe using the shared
//! length-prefixed JSON codec defined in `desktop_ipc.rs`.

mod desktop_ipc;
mod ipc_security;
mod native_runtime_ipc;
mod native_runtime_proxy;
// This binary only consumes the extension-ID allowlist from the installer
// module; the manifest-installation half is used exclusively by the Tauri app.
#[allow(dead_code)]
mod native_messaging_installer;

use desktop_ipc::{
    read_frame, validate_frame_length, write_frame, DesktopEnvelope, DesktopRequest,
    DesktopResponse, DESKTOP_PROTOCOL_VERSION, MAX_IPC_FRAME_BYTES,
};
#[cfg(unix)]
use ipc_security::desktop_ipc_socket_candidates;
#[cfg(windows)]
use ipc_security::desktop_ipc_socket_path;
use std::io::{self, Read, Write};
#[cfg(unix)]
use std::os::fd::{AsRawFd, RawFd};
use std::process::Command;
use std::sync::Arc;
#[cfg(feature = "native-runtime-legacy-source")]
use tokio::io::AsyncReadExt;
use tokio::sync::{mpsc, watch, Mutex};
use tokio::task::JoinHandle;
#[cfg(unix)]
use tokio::{io::unix::AsyncFd, io::Interest};
use zeroize::Zeroizing;

type NativeRequest = DesktopEnvelope<DesktopRequest>;
type NativeResponse = DesktopEnvelope<DesktopResponse>;
const MAX_NATIVE_RESPONSE_BYTES: usize = 1024 * 1024;
const NATIVE_INPUT_QUEUE_LENGTH: usize = 4;
const NATIVE_OUTPUT_QUEUE_LENGTH: usize = 4;

enum NativeOutput {
    Typed(NativeResponse),
    #[cfg(feature = "native-runtime-legacy-source")]
    Opaque(Zeroizing<Vec<u8>>),
}

impl From<NativeResponse> for NativeOutput {
    fn from(response: NativeResponse) -> Self {
        Self::Typed(response)
    }
}

fn log_native(message: &str) {
    eprintln!("[native-host] {}", message);
}

#[cfg(not(feature = "native-runtime-legacy-source"))]
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
        DesktopRequest::GetDesktopAuthToken { account_id } => {
            format!("GET_DESKTOP_AUTH_TOKEN account_id={}", account_id)
        }
        DesktopRequest::GetDesktopVaultKeys { account_id } => {
            format!("GET_DESKTOP_VAULT_KEYS account_id={}", account_id)
        }
        DesktopRequest::GetDesktopItemsSnapshot { account_ids } => format!(
            "GET_DESKTOP_ITEMS_SNAPSHOT account_ids={}",
            account_ids
                .as_ref()
                .map(|values| values.len())
                .unwrap_or_default()
        ),
        DesktopRequest::SubscribeDesktopEvents => "SUBSCRIBE_DESKTOP_EVENTS".to_string(),
        DesktopRequest::UnsubscribeDesktopEvents => "UNSUBSCRIBE_DESKTOP_EVENTS".to_string(),
        DesktopRequest::CheckBiometricAvailable => "CHECK_BIOMETRIC_AVAILABLE".to_string(),
        DesktopRequest::BiometricUnlockRequest {
            extension_id,
            account_id,
            ..
        } => format!(
            "BIOMETRIC_UNLOCK_REQUEST extension_id={} account_id_present={}",
            extension_id,
            account_id.is_some()
        ),
        DesktopRequest::BiometricUnlockAllRequest { extension_id, .. } => {
            format!("BIOMETRIC_UNLOCK_ALL_REQUEST extension_id={}", extension_id)
        }
        DesktopRequest::TriggerDesktopUnlock => "TRIGGER_DESKTOP_UNLOCK".to_string(),
        DesktopRequest::OpenDesktopApp { .. } => "OPEN_DESKTOP_APP".to_string(),
    }
}

fn read_native_message_from<T: serde::de::DeserializeOwned>(
    input: &mut impl Read,
) -> io::Result<T> {
    let mut length_bytes = [0u8; 4];
    input.read_exact(&mut length_bytes)?;
    let length = u32::from_le_bytes(length_bytes) as usize;
    validate_frame_length(length, MAX_IPC_FRAME_BYTES)?;

    let mut buffer = Zeroizing::new(vec![0u8; length]);
    input.read_exact(&mut buffer)?;

    serde_json::from_slice(&buffer)
        .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))
}

fn read_native_message<T: serde::de::DeserializeOwned>() -> io::Result<T> {
    read_native_message_from(&mut io::stdin())
}

fn write_native_message(response: &NativeResponse) -> io::Result<()> {
    let json = Zeroizing::new(
        serde_json::to_vec(response)
            .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))?,
    );
    let length = validate_frame_length(json.len(), MAX_NATIVE_RESPONSE_BYTES)?;
    io::stdout().write_all(&length.to_le_bytes())?;
    io::stdout().write_all(&json)?;
    io::stdout().flush()?;
    Ok(())
}

#[cfg(feature = "native-runtime-legacy-source")]
fn write_opaque_native_message(bytes: &[u8]) -> io::Result<()> {
    let length = validate_frame_length(bytes.len(), MAX_NATIVE_RESPONSE_BYTES)?;
    io::stdout().write_all(&length.to_le_bytes())?;
    io::stdout().write_all(bytes)?;
    io::stdout().flush()
}

fn validate_extension_request(
    request: &DesktopRequest,
    browser_extension_id: &str,
) -> Result<(), String> {
    match request {
        DesktopRequest::BiometricUnlockRequest { extension_id, .. }
        | DesktopRequest::BiometricUnlockAllRequest { extension_id, .. }
            if extension_id != browser_extension_id =>
        {
            return Err("Extension identity does not match the browser origin".to_string());
        }
        _ => {}
    }

    Ok(())
}

/// Connect to the desktop app's IPC endpoint and check who answered.
///
/// The desktop app makes the real authorization decision — it is the side
/// holding the vault keys. Checking from here as well means a squatted socket
/// is caught from both ends, because the extension would otherwise trust
/// whatever a squatter chose to answer with. The policy is deliberately
/// [`PeerPolicy::BestEffort`]: a peer positively identified as something other
/// than the desktop app is refused, but a peer we simply cannot identify is
/// allowed through so a platform quirk cannot brick the integration.
///
/// [`PeerPolicy::BestEffort`]: ipc_security::PeerPolicy::BestEffort
#[cfg(unix)]
async fn connect_desktop_ipc() -> Result<tokio::net::UnixStream, String> {
    use std::os::unix::io::AsRawFd;

    let candidates = desktop_ipc_socket_candidates();
    let mut last_error = "no socket path is configured".to_string();

    for path in &candidates {
        match tokio::net::UnixStream::connect(path).await {
            Ok(stream) => {
                if let Err(reason) = ipc_security::authorize_unix_peer(
                    stream.as_raw_fd(),
                    ipc_security::PeerRole::DesktopApp,
                    ipc_security::PeerPolicy::BestEffort,
                ) {
                    // Do not fall through to the next candidate: something is
                    // impersonating the desktop app and that is worth reporting.
                    return Err(format!(
                        "Refusing to talk to the process listening on {}: {}",
                        path.display(),
                        reason
                    ));
                }
                return Ok(stream);
            }
            Err(error) => {
                last_error = format!("{}: {}", path.display(), error);
            }
        }
    }

    Err(format!("Desktop IPC unavailable ({})", last_error))
}

/// See the Unix variant for the rationale behind the best-effort policy.
#[cfg(windows)]
async fn connect_desktop_ipc() -> Result<tokio::net::windows::named_pipe::NamedPipeClient, String> {
    use std::os::windows::io::AsRawHandle;
    use tokio::net::windows::named_pipe::ClientOptions;

    let pipe_name = desktop_ipc_socket_path();
    let pipe_name = pipe_name.to_string_lossy().to_string();
    let stream = ClientOptions::new()
        .open(&pipe_name)
        .map_err(|error| format!("Desktop IPC unavailable at {}: {}", pipe_name, error))?;

    if let Err(reason) = ipc_security::authorize_pipe_peer(
        stream.as_raw_handle(),
        ipc_security::PipeSide::Server,
        ipc_security::PeerRole::DesktopApp,
        ipc_security::PeerPolicy::BestEffort,
    ) {
        return Err(format!(
            "Refusing to talk to the process serving {}: {}",
            pipe_name, reason
        ));
    }

    Ok(stream)
}

#[cfg(any(unix, windows))]
async fn send_ipc_request(request: NativeRequest) -> Result<NativeResponse, String> {
    let mut stream = connect_desktop_ipc().await?;
    write_frame(&mut stream, &request)
        .await
        .map_err(|error| format!("Failed writing IPC request: {}", error))?;
    read_frame(&mut stream)
        .await
        .map_err(|error| format!("Failed reading IPC response: {}", error))
}

/// Protocol 1 stays on the browser wire. Its private source request uses a separate closed
/// Desktop handshake whose origin comes only from this process's validated launch argument.
#[cfg(all(feature = "native-runtime-legacy-source", any(unix, windows)))]
async fn send_legacy_source_request(
    handshake: native_runtime_ipc::LegacyRuntimeHandshake,
) -> Result<Zeroizing<Vec<u8>>, String> {
    let mut stream = connect_desktop_ipc().await?;
    write_frame(&mut stream, &handshake)
        .await
        .map_err(|error| format!("Failed writing native source request: {error}"))?;
    let mut header = [0u8; 4];
    stream
        .read_exact(&mut header)
        .await
        .map_err(|error| format!("Failed reading native source response: {error}"))?;
    let length = u32::from_le_bytes(header) as usize;
    validate_frame_length(length, MAX_NATIVE_RESPONSE_BYTES)
        .map_err(|error| format!("Invalid native source response: {error}"))?;
    let mut bytes = Zeroizing::new(vec![0u8; length]);
    stream
        .read_exact(&mut bytes)
        .await
        .map_err(|error| format!("Failed reading native source response: {error}"))?;
    Ok(bytes)
}

#[cfg(all(feature = "native-runtime-legacy-source", not(any(unix, windows))))]
async fn send_legacy_source_request(
    _handshake: native_runtime_ipc::LegacyRuntimeHandshake,
) -> Result<Zeroizing<Vec<u8>>, String> {
    Err("Native source transport is unavailable".into())
}

enum LegacySourceForwardFrame {
    #[cfg(not(feature = "native-runtime-legacy-source"))]
    ExistingApplication(NativeRequest),
    #[cfg(feature = "native-runtime-legacy-source")]
    NativeRuntime(native_runtime_ipc::LegacyRuntimeHandshake),
}

fn legacy_source_forward_frame(
    request: NativeRequest,
    browser_extension_id: &str,
) -> LegacySourceForwardFrame {
    #[cfg(not(feature = "native-runtime-legacy-source"))]
    {
        let _ = browser_extension_id;
        LegacySourceForwardFrame::ExistingApplication(request)
    }
    #[cfg(feature = "native-runtime-legacy-source")]
    {
        LegacySourceForwardFrame::NativeRuntime(native_runtime_ipc::LegacyRuntimeHandshake {
            mode: native_runtime_ipc::LegacyRuntimeMode::LegacySource,
            browser_origin: format!("chrome-extension://{browser_extension_id}/"),
            request,
        })
    }
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

        Err("Unable to open Bittery via macOS open".to_string())
    }

    #[cfg(target_os = "windows")]
    {
        if try_command_status("cmd", &["/C", "start", "", "bittery"]) {
            return Ok(());
        }

        if try_command_status("cmd", &["/C", "start", "", "Bittery"]) {
            return Ok(());
        }

        Err("Unable to open Bittery via Windows start".to_string())
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

        Err("Unable to open Bittery. Ensure the app is installed.".to_string())
    }

    #[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
    {
        Err("Unsupported platform".to_string())
    }
}

async fn open_desktop_app(payload: DesktopRequest) -> DesktopResponse {
    let request = NativeRequest {
        protocol_version: Some(DESKTOP_PROTOCOL_VERSION),
        request_id: None,
        payload,
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

async fn handle_request(request: NativeRequest, browser_extension_id: &str) -> NativeOutput {
    if let Err(error) = validate_extension_request(&request.payload, browser_extension_id) {
        return NativeResponse {
            protocol_version: Some(DESKTOP_PROTOCOL_VERSION),
            request_id: request.request_id,
            payload: DesktopResponse::Error { message: error },
        }
        .into();
    }

    let request_id = request.request_id.clone();
    let request_payload = request.payload.clone();
    let payload = match request_payload {
        DesktopRequest::Ping => DesktopResponse::Pong {
            version: env!("CARGO_PKG_VERSION").to_string(),
        },
        request @ DesktopRequest::OpenDesktopApp { .. } => open_desktop_app(request).await,
        #[cfg(not(feature = "native-runtime-legacy-source"))]
        DesktopRequest::GetDesktopStatus => match send_ipc_request(NativeRequest {
            protocol_version: Some(DESKTOP_PROTOCOL_VERSION),
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
                theme: None,
            },
        },
        #[cfg(feature = "native-runtime-legacy-source")]
        DesktopRequest::GetDesktopStatus => {
            let forward = NativeRequest {
                protocol_version: Some(DESKTOP_PROTOCOL_VERSION),
                request_id: request_id.clone(),
                payload: DesktopRequest::GetDesktopStatus,
            };
            let LegacySourceForwardFrame::NativeRuntime(handshake) =
                legacy_source_forward_frame(forward, browser_extension_id);
            match send_legacy_source_request(handshake).await {
                Ok(bytes) => return NativeOutput::Opaque(bytes),
                Err(error) => DesktopResponse::Error { message: error },
            }
        }
        #[cfg(not(feature = "native-runtime-legacy-source"))]
        DesktopRequest::CheckBiometricAvailable => match send_ipc_request(NativeRequest {
            protocol_version: Some(DESKTOP_PROTOCOL_VERSION),
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
        #[cfg(feature = "native-runtime-legacy-source")]
        request @ (DesktopRequest::CheckBiometricAvailable
        | DesktopRequest::BiometricUnlockRequest { .. }
        | DesktopRequest::BiometricUnlockAllRequest { .. }) => {
            let forward = NativeRequest {
                protocol_version: Some(DESKTOP_PROTOCOL_VERSION),
                request_id: request_id.clone(),
                payload: request,
            };
            let LegacySourceForwardFrame::NativeRuntime(handshake) =
                legacy_source_forward_frame(forward, browser_extension_id);
            match send_legacy_source_request(handshake).await {
                Ok(bytes) => return NativeOutput::Opaque(bytes),
                Err(error) => DesktopResponse::Error { message: error },
            }
        }
        request @ (DesktopRequest::GetDesktopAccounts
        | DesktopRequest::GetDesktopAuthToken { .. }
        | DesktopRequest::GetDesktopItemsSnapshot { .. }
        | DesktopRequest::GetDesktopVaultKeys { .. }) => {
            let forward = NativeRequest {
                protocol_version: Some(DESKTOP_PROTOCOL_VERSION),
                request_id: request_id.clone(),
                payload: request,
            };
            match legacy_source_forward_frame(forward, browser_extension_id) {
                #[cfg(not(feature = "native-runtime-legacy-source"))]
                LegacySourceForwardFrame::ExistingApplication(request) => {
                    match send_ipc_request(request).await {
                        Ok(response) => return response.into(),
                        Err(error) => DesktopResponse::Error { message: error },
                    }
                }
                #[cfg(feature = "native-runtime-legacy-source")]
                LegacySourceForwardFrame::NativeRuntime(handshake) => {
                    match send_legacy_source_request(handshake).await {
                        Ok(bytes) => return NativeOutput::Opaque(bytes),
                        Err(error) => DesktopResponse::Error { message: error },
                    }
                }
            }
        }
        other_request => {
            let forward = NativeRequest {
                protocol_version: Some(DESKTOP_PROTOCOL_VERSION),
                request_id: request_id.clone(),
                payload: other_request,
            };
            match send_ipc_request(forward).await {
                Ok(response) => {
                    return response.into();
                }
                Err(error) => DesktopResponse::Error { message: error },
            }
        }
    };

    NativeResponse {
        protocol_version: Some(DESKTOP_PROTOCOL_VERSION),
        request_id,
        payload,
    }
    .into()
}

#[derive(Default)]
struct SubscriptionState {
    task: Option<JoinHandle<()>>,
}

async fn start_event_subscription(
    request: NativeRequest,
    browser_extension_id: &str,
    out_tx: mpsc::Sender<NativeOutput>,
    subscription_state: Arc<Mutex<SubscriptionState>>,
    retired_tx: watch::Sender<bool>,
) {
    let mut state = subscription_state.lock().await;
    if state.task.as_ref().is_some_and(JoinHandle::is_finished) {
        state.task.take();
    }
    if state.task.is_some() {
        let _ = out_tx
            .send(
                NativeResponse {
                    protocol_version: Some(DESKTOP_PROTOCOL_VERSION),
                    request_id: request.request_id,
                    payload: DesktopResponse::DesktopEventSubscription { subscribed: true },
                }
                .into(),
            )
            .await;
        return;
    }

    // Unix and Windows only differ in the transport type, which
    // `connect_desktop_ipc` hides; keeping one body means the peer check cannot
    // be present on one platform and forgotten on the other.
    #[cfg(any(unix, windows))]
    {
        let mut stream = match connect_desktop_ipc().await {
            Ok(stream) => stream,
            Err(error) => {
                let _ = out_tx
                    .send(
                        NativeResponse {
                            protocol_version: Some(DESKTOP_PROTOCOL_VERSION),
                            request_id: request.request_id,
                            payload: DesktopResponse::Error { message: error },
                        }
                        .into(),
                    )
                    .await;
                return;
            }
        };

        #[cfg(feature = "native-runtime-legacy-source")]
        let handshake = native_runtime_ipc::LegacyRuntimeHandshake {
            mode: native_runtime_ipc::LegacyRuntimeMode::LegacySource,
            browser_origin: format!("chrome-extension://{browser_extension_id}/"),
            request: request.clone(),
        };
        #[cfg(feature = "native-runtime-legacy-source")]
        let subscribe = write_frame(&mut stream, &handshake);
        #[cfg(not(feature = "native-runtime-legacy-source"))]
        let subscribe = {
            let _ = browser_extension_id;
            write_frame(&mut stream, &request)
        };
        if let Err(error) = subscribe.await {
            let _ = out_tx
                .send(
                    NativeResponse {
                        protocol_version: Some(DESKTOP_PROTOCOL_VERSION),
                        request_id: request.request_id,
                        payload: DesktopResponse::Error {
                            message: format!("Failed writing subscribe request: {}", error),
                        },
                    }
                    .into(),
                )
                .await;
            return;
        }

        let ack: NativeResponse = match read_frame(&mut stream).await {
            Ok(message) => message,
            Err(error) => {
                let _ = out_tx
                    .send(
                        NativeResponse {
                            protocol_version: Some(DESKTOP_PROTOCOL_VERSION),
                            request_id: request.request_id,
                            payload: DesktopResponse::Error {
                                message: format!("Failed reading subscribe ack: {}", error),
                            },
                        }
                        .into(),
                    )
                    .await;
                return;
            }
        };

        if out_tx.try_send(ack.into()).is_err() {
            retired_tx.send_replace(true);
            return;
        }
        let forward_tx = out_tx.clone();
        state.task = Some(tokio::spawn(async move {
            let mut stream = stream;
            loop {
                match read_frame::<_, NativeResponse>(&mut stream).await {
                    Ok(message) => {
                        // A blocked browser writer cannot hold the source reader behind
                        // the output queue and conceal a terminal event-stream failure.
                        if forward_tx.try_send(message.into()).is_err() {
                            retired_tx.send_replace(true);
                            break;
                        }
                    }
                    Err(error) => {
                        log_native(&format!("desktop event subscription ended: {}", error));
                        retired_tx.send_replace(true);
                        break;
                    }
                }
            }
        }));
    }

    #[cfg(not(any(unix, windows)))]
    {
        let _ = out_tx
            .send(
                NativeResponse {
                    protocol_version: Some(DESKTOP_PROTOCOL_VERSION),
                    request_id: request.request_id,
                    payload: DesktopResponse::Error {
                        message: "Desktop event subscription is unavailable on this platform build"
                            .to_string(),
                    },
                }
                .into(),
            )
            .await;
    }
}

async fn stop_event_subscription(
    request_id: Option<String>,
    out_tx: &mpsc::Sender<NativeOutput>,
    subscription_state: Arc<Mutex<SubscriptionState>>,
) {
    let mut state = subscription_state.lock().await;
    if let Some(task) = state.task.take() {
        task.abort();
    }

    let _ = out_tx
        .send(
            NativeResponse {
                protocol_version: Some(DESKTOP_PROTOCOL_VERSION),
                request_id,
                payload: DesktopResponse::DesktopEventSubscription { subscribed: false },
            }
            .into(),
        )
        .await;
}

async fn abort_event_subscription(subscription_state: &Arc<Mutex<SubscriptionState>>) {
    if let Some(task) = subscription_state.lock().await.task.take() {
        task.abort();
    }
}

fn spawn_legacy_input(
    input_tx: mpsc::Sender<io::Result<NativeRequest>>,
    retired_tx: watch::Sender<bool>,
) {
    // The browser pipe is an OS handle. Keep its blocking read off the request
    // task so EOF can cancel an in-flight Core/IPC read, including a held prompt.
    std::thread::spawn(move || {
        let mut input = io::stdin();
        loop {
            let next = read_native_message_from(&mut input);
            match next {
                Err(error) if error.kind() == io::ErrorKind::UnexpectedEof => {
                    retired_tx.send_replace(true);
                    return;
                }
                other => {
                    let stop = other.is_err();
                    if input_tx.try_send(other).is_err() {
                        // A peer cannot force unbounded parsed requests or private replies
                        // to accumulate while the Core request is held.
                        retired_tx.send_replace(true);
                        return;
                    }
                    if stop {
                        return;
                    }
                }
            }
        }
    });
}

#[cfg(unix)]
struct NativeStdoutReadiness;

#[cfg(unix)]
impl AsRawFd for NativeStdoutReadiness {
    fn as_raw_fd(&self) -> RawFd {
        libc::STDOUT_FILENO
    }
}

#[cfg(unix)]
fn watch_stdout_retirement(retired_tx: watch::Sender<bool>) {
    // Native messaging stdout is a browser-owned pipe. Its write end has no
    // ordinary readable data; readable readiness means the peer hung up or the
    // descriptor failed. Tokio's existing reactor observes that OS event while
    // a Core socket is held, without a separate polling loop or policy owner.
    tokio::spawn(async move {
        let Ok(stdout) = AsyncFd::with_interest(NativeStdoutReadiness, Interest::READABLE) else {
            // A non-pipe stdout cannot be registered (for example, a test console).
            // A later write failure still retires the port in the writer task.
            return;
        };
        if stdout.readable().await.is_ok() {
            retired_tx.send_replace(true);
        }
    });
}

#[derive(serde::Deserialize)]
#[serde(untagged)]
enum FirstNativeRequest {
    Runtime(Box<native_runtime_ipc::NativeRuntimeRequest>),
    Legacy(Box<NativeRequest>),
}

#[cfg(any(unix, windows))]
async fn run_runtime_source(
    request: native_runtime_ipc::NativeRuntimeRequest,
    browser_extension_id: &str,
) -> Result<(), String> {
    let desktop = connect_desktop_ipc().await?;
    native_runtime_proxy::relay(
        tokio::io::stdin(),
        tokio::io::stdout(),
        desktop,
        request,
        format!("chrome-extension://{browser_extension_id}/"),
    )
    .await
    .map_err(|_| "Native source port closed".to_owned())
}

#[cfg(not(any(unix, windows)))]
async fn run_runtime_source(
    _request: native_runtime_ipc::NativeRuntimeRequest,
    _browser_extension_id: &str,
) -> Result<(), String> {
    Err("Native source transport unavailable on this platform build".to_owned())
}

#[tokio::main]
async fn main() {
    let Some(browser_extension_id) = std::env::args_os().nth(1).and_then(|origin| {
        origin
            .to_str()
            .and_then(native_messaging_installer::extension_id_for_origin)
    }) else {
        log_native("refused missing or unsupported browser origin");
        std::process::exit(1);
    };
    log_native("started");

    let mut first = Some(match read_native_message::<FirstNativeRequest>() {
        Ok(FirstNativeRequest::Legacy(request)) => Ok(*request),
        Ok(FirstNativeRequest::Runtime(request)) => {
            let result = run_runtime_source(*request, &browser_extension_id).await;
            if let Err(error) = &result {
                log_native(error);
            }
            // Tokio cannot cancel the OS-backed stdin worker. The port has retired and its
            // socket is dropped; exit this dedicated native process without waiting for stdin.
            std::process::exit(if result.is_ok() { 0 } else { 1 });
        }
        Err(error) => Err(error),
    });

    let (retired_tx, mut retired_rx) = watch::channel(false);
    #[cfg(unix)]
    watch_stdout_retirement(retired_tx.clone());
    let (input_tx, mut input_rx) = mpsc::channel(NATIVE_INPUT_QUEUE_LENGTH);
    spawn_legacy_input(input_tx, retired_tx.clone());

    let (out_tx, mut out_rx) = mpsc::channel::<NativeOutput>(NATIVE_OUTPUT_QUEUE_LENGTH);
    let subscription_state = Arc::new(Mutex::new(SubscriptionState::default()));

    let writer_task = {
        let mut writer_retired = retired_rx.clone();
        let writer_retired_tx = retired_tx.clone();
        tokio::spawn(async move {
            loop {
                let response = tokio::select! {
                    biased;
                    _ = writer_retired.changed() => break,
                    response = out_rx.recv() => response,
                };
                let Some(response) = response else { break };
                let written = match response {
                    NativeOutput::Typed(response) => write_native_message(&response),
                    #[cfg(feature = "native-runtime-legacy-source")]
                    NativeOutput::Opaque(bytes) => write_opaque_native_message(&bytes),
                };
                if let Err(error) = written {
                    log_native(&format!("failed to write response: {}", error));
                    writer_retired_tx.send_replace(true);
                    break;
                }
            }
        })
    };

    loop {
        if *retired_rx.borrow() {
            break;
        }
        let next = if let Some(first) = first.take() {
            first
        } else {
            tokio::select! {
                biased;
                _ = retired_rx.changed() => break,
                next = input_rx.recv() => match next {
                    Some(next) => next,
                    None => break,
                },
            }
        };
        let keep_running = tokio::select! {
            biased;
            _ = retired_rx.changed() => false,
            keep_running = async {
                match next {
                    Ok(message) => {
                log_native(&format!("received {}", summarize_message(&message.payload)));
                if message.protocol_version != Some(DESKTOP_PROTOCOL_VERSION) {
                    log_native(&format!(
                        "protocol mismatch expected={} received={}",
                        DESKTOP_PROTOCOL_VERSION,
                        message
                            .protocol_version
                            .map(|version| version.to_string())
                            .unwrap_or_else(|| "missing".to_string())
                    ));
                    return out_tx.send(
                        NativeResponse::current(
                            message.request_id,
                            DesktopResponse::ProtocolMismatch {
                                expected_version: DESKTOP_PROTOCOL_VERSION,
                                received_version: message.protocol_version,
                            },
                        )
                        .into(),
                    ).await.is_ok();
                }
                match message.payload {
                    DesktopRequest::SubscribeDesktopEvents => {
                        start_event_subscription(
                            message,
                            &browser_extension_id,
                            out_tx.clone(),
                            subscription_state.clone(),
                            retired_tx.clone(),
                        )
                        .await;
                        true
                    }
                    DesktopRequest::UnsubscribeDesktopEvents => {
                        stop_event_subscription(
                            message.request_id,
                            &out_tx,
                            subscription_state.clone(),
                        )
                        .await;
                        true
                    }
                    _ => {
                        let response = handle_request(message, &browser_extension_id).await;
                        out_tx.send(response).await.is_ok()
                    }
                }
            }
            Err(error) => {
                log_native(&format!("failed to read message: {}", error));
                let _ = out_tx.send(
                    NativeResponse {
                        protocol_version: Some(DESKTOP_PROTOCOL_VERSION),
                        request_id: None,
                        payload: DesktopResponse::Error {
                            message: error.to_string(),
                        },
                    }
                    .into(),
                ).await;
                false
            }
        }
            } => keep_running,
        };
        if !keep_running {
            break;
        }
    }

    abort_event_subscription(&subscription_state).await;
    drop(out_tx);
    if *retired_rx.borrow() {
        // A stdout write may be blocked in an OS call, and the stdin worker may
        // still be blocked after stdout failure. This dedicated host process has
        // already dropped the Core request; no port work is allowed to continue.
        log_native("stopped after port retirement");
        std::process::exit(0);
    }
    let _ = writer_task.await;
    log_native("stopped");
}

#[cfg(test)]
mod legacy_source_owner_tests {
    use super::*;

    #[test]
    fn protocol1_status_uses_the_selected_composition_owner() {
        let request =
            NativeRequest::current(Some("status-1".into()), DesktopRequest::GetDesktopStatus);
        let frame = legacy_source_forward_frame(request, "accepted-origin");
        #[cfg(not(feature = "native-runtime-legacy-source"))]
        {
            let LegacySourceForwardFrame::ExistingApplication(frame) = frame;
            let encoded = serde_json::to_value(frame).unwrap();
            assert_eq!(encoded["type"], "GET_DESKTOP_STATUS");
            assert_eq!(encoded["requestId"], "status-1");
            assert!(encoded.get("browserOrigin").is_none());
        }
        #[cfg(feature = "native-runtime-legacy-source")]
        {
            let LegacySourceForwardFrame::NativeRuntime(frame) = frame;
            let encoded = serde_json::to_value(frame).unwrap();
            assert_eq!(encoded["mode"], "legacySource");
            assert_eq!(
                encoded["browserOrigin"],
                "chrome-extension://accepted-origin/"
            );
            assert_eq!(encoded["request"]["type"], "GET_DESKTOP_STATUS");
            assert_eq!(encoded["request"]["requestId"], "status-1");
        }
    }

    #[test]
    fn protocol1_auth_token_uses_the_selected_composition_owner() {
        let request = NativeRequest::current(
            Some("auth-token-1".into()),
            DesktopRequest::GetDesktopAuthToken {
                account_id: "account-1".into(),
            },
        );
        let frame = legacy_source_forward_frame(request, "accepted-origin");
        #[cfg(not(feature = "native-runtime-legacy-source"))]
        {
            let LegacySourceForwardFrame::ExistingApplication(frame) = frame;
            let encoded = serde_json::to_value(frame).unwrap();
            assert_eq!(encoded["type"], "GET_DESKTOP_AUTH_TOKEN");
            assert_eq!(encoded["accountId"], "account-1");
            assert_eq!(encoded["requestId"], "auth-token-1");
            assert!(encoded.get("browserOrigin").is_none());
        }
        #[cfg(feature = "native-runtime-legacy-source")]
        {
            let LegacySourceForwardFrame::NativeRuntime(frame) = frame;
            let encoded = serde_json::to_value(frame).unwrap();
            assert_eq!(encoded["mode"], "legacySource");
            assert_eq!(
                encoded["browserOrigin"],
                "chrome-extension://accepted-origin/"
            );
            assert_eq!(encoded["request"]["type"], "GET_DESKTOP_AUTH_TOKEN");
            assert_eq!(encoded["request"]["accountId"], "account-1");
            assert_eq!(encoded["request"]["requestId"], "auth-token-1");
        }
    }

    #[test]
    fn protocol1_account_catalog_uses_the_selected_composition_owner() {
        let request = NativeRequest::current(
            Some("accounts-1".into()),
            DesktopRequest::GetDesktopAccounts,
        );
        let frame = legacy_source_forward_frame(request, "accepted-origin");
        #[cfg(not(feature = "native-runtime-legacy-source"))]
        {
            let LegacySourceForwardFrame::ExistingApplication(frame) = frame;
            let encoded = serde_json::to_value(frame).unwrap();
            assert_eq!(encoded["type"], "GET_DESKTOP_ACCOUNTS");
            assert_eq!(encoded["requestId"], "accounts-1");
            assert!(encoded.get("browserOrigin").is_none());
        }
        #[cfg(feature = "native-runtime-legacy-source")]
        {
            let LegacySourceForwardFrame::NativeRuntime(frame) = frame;
            let encoded = serde_json::to_value(frame).unwrap();
            assert_eq!(encoded["mode"], "legacySource");
            assert_eq!(
                encoded["browserOrigin"],
                "chrome-extension://accepted-origin/"
            );
            assert_eq!(encoded["request"]["type"], "GET_DESKTOP_ACCOUNTS");
            assert_eq!(encoded["request"]["requestId"], "accounts-1");
        }
    }

    #[test]
    fn protocol1_snapshot_uses_the_selected_composition_owner() {
        let request = NativeRequest::current(
            Some("snapshot-1".into()),
            DesktopRequest::GetDesktopItemsSnapshot {
                account_ids: Some(vec!["account-1".into()]),
            },
        );
        let frame = legacy_source_forward_frame(request, "accepted-origin");
        #[cfg(not(feature = "native-runtime-legacy-source"))]
        {
            let LegacySourceForwardFrame::ExistingApplication(frame) = frame;
            let encoded = serde_json::to_value(frame).unwrap();
            assert_eq!(encoded["type"], "GET_DESKTOP_ITEMS_SNAPSHOT");
            assert_eq!(encoded["accountIds"], serde_json::json!(["account-1"]));
            assert!(encoded.get("browserOrigin").is_none());
        }
        #[cfg(feature = "native-runtime-legacy-source")]
        {
            let LegacySourceForwardFrame::NativeRuntime(frame) = frame;
            let encoded = serde_json::to_value(frame).unwrap();
            assert_eq!(encoded["mode"], "legacySource");
            assert_eq!(
                encoded["browserOrigin"],
                "chrome-extension://accepted-origin/"
            );
            assert_eq!(encoded["request"]["type"], "GET_DESKTOP_ITEMS_SNAPSHOT");
            assert_eq!(
                encoded["request"]["accountIds"],
                serde_json::json!(["account-1"])
            );
        }
    }

    #[test]
    fn protocol1_wrapped_keys_use_the_selected_composition_owner() {
        let request = NativeRequest::current(
            Some("wrapped-keys-1".into()),
            DesktopRequest::GetDesktopVaultKeys {
                account_id: "account-1".into(),
            },
        );
        let frame = legacy_source_forward_frame(request, "accepted-origin");
        #[cfg(not(feature = "native-runtime-legacy-source"))]
        {
            let LegacySourceForwardFrame::ExistingApplication(frame) = frame;
            let encoded = serde_json::to_value(frame).unwrap();
            assert_eq!(encoded["type"], "GET_DESKTOP_VAULT_KEYS");
            assert_eq!(encoded["accountId"], "account-1");
            assert!(encoded.get("browserOrigin").is_none());
        }
        #[cfg(feature = "native-runtime-legacy-source")]
        {
            let LegacySourceForwardFrame::NativeRuntime(frame) = frame;
            let encoded = serde_json::to_value(frame).unwrap();
            assert_eq!(encoded["mode"], "legacySource");
            assert_eq!(
                encoded["browserOrigin"],
                "chrome-extension://accepted-origin/"
            );
            assert_eq!(encoded["request"]["type"], "GET_DESKTOP_VAULT_KEYS");
            assert_eq!(encoded["request"]["accountId"], "account-1");
        }
    }
}
