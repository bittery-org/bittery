//! A peer-verified native stream owns one source facet; Core owns every authority decision.

use super::native::NativeRuntime;
use crate::{
    desktop_ipc::{
        read_frame_bounded, validate_frame_length, write_frame_bounded, DesktopEnvelope,
        DesktopEvent, DesktopResponse, DESKTOP_PROTOCOL_VERSION, MAX_IPC_FRAME_BYTES,
    },
    native_messaging_installer::extension_id_for_origin,
    native_runtime_ipc::{
        LegacyRuntimeHandshake, NativeRuntimeCommand, NativeRuntimeHandshake, NativeRuntimeMessage,
        NativeRuntimeRequest, MAX_RUNTIME_NATIVE_REQUEST_BYTES as INPUT_BYTES,
        MAX_RUNTIME_NATIVE_RESPONSE_BYTES as OUTPUT_BYTES, RUNTIME_NATIVE_PROTOCOL_VERSION,
    },
};
use bittery_client_core::{
    AccountAccessState, NativeAuthorityResponse, NativeSourceAttachment, ObservationHandle,
    ObservationSink, RuntimeError, RuntimeProjection,
};
use serde::Deserialize;
use std::{
    collections::{HashMap, HashSet},
    io,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
};
use tokio::{
    io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt},
    sync::{mpsc, watch},
    task::{AbortHandle, JoinSet},
    time::{timeout, Duration},
};
use zeroize::Zeroizing;

const QUEUED_FRAMES: usize = 16;
const MAX_CALLS: usize = 16;
const MAX_CONNECTION_REQUESTS: usize = 4096;
const SHUTDOWN_EVENT_WRITE_TIMEOUT: Duration = Duration::from_millis(100);

struct Wake(watch::Sender<()>);
impl ObservationSink for Wake {
    fn publish(&self, _projection: RuntimeProjection) {
        self.0.send_replace(());
    }
}

struct LegacyWake {
    events: mpsc::Sender<RuntimeProjection>,
    overflow: watch::Sender<bool>,
}
impl ObservationSink for LegacyWake {
    fn publish(&self, projection: RuntimeProjection) {
        if self.events.try_send(projection).is_err() {
            // A synchronous Core callback must never wait for socket I/O. An overflow
            // retires this connection instead of silently coalescing a lock edge.
            self.overflow.send_replace(true);
        }
    }
}

async fn write_legacy_event_frame<S>(
    stream: &mut S,
    overflow: &mut watch::Receiver<bool>,
    source: &NativeSourceAttachment,
    frame: DesktopEnvelope<DesktopResponse>,
) -> io::Result<()>
where
    S: AsyncWrite + Unpin,
{
    if *overflow.borrow() {
        return Err(invalid());
    }
    tokio::select! {
        biased;
        _ = overflow.changed() => Err(invalid()),
        _ = source.runtime_closed() => Err(io::Error::new(io::ErrorKind::ConnectionAborted, "Runtime owner closed")),
        result = write_frame_bounded(stream, &frame, MAX_IPC_FRAME_BYTES) => result,
    }
}

async fn write_legacy_shutdown_close<S>(
    stream: &mut S,
    overflow: &watch::Receiver<bool>,
    source: &NativeSourceAttachment,
) where
    S: AsyncWrite + Unpin,
{
    if *overflow.borrow() {
        return;
    }
    if let Ok(timestamp) = source.legacy_event_timestamp() {
        // Shutdown is already complete here. Give a readable peer its close
        // frame, but never let a stalled peer retain this source and its port.
        let _ = timeout(
            SHUTDOWN_EVENT_WRITE_TIMEOUT,
            write_frame_bounded(
                stream,
                &DesktopEnvelope::current(
                    None,
                    DesktopResponse::DesktopEvent(DesktopEvent::DesktopClose { timestamp }),
                ),
                MAX_IPC_FRAME_BYTES,
            ),
        )
        .await;
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LegacyStatus {
    unlocked_accounts: Vec<String>,
    timestamp: i64,
}

fn observed_unlocked(projection: &RuntimeProjection) -> Vec<String> {
    let RuntimeProjection::RuntimeStatus(status) = projection else {
        return Vec::new();
    };
    status
        .accounts
        .iter()
        .filter(|account| {
            account.access == AccountAccessState::Unlocked && account.failure.is_none()
        })
        .map(|account| account.account_id.as_str().to_owned())
        .collect()
}

async fn legacy_status(source: &NativeSourceAttachment) -> io::Result<LegacyStatus> {
    let encoded = source
        .encode_legacy_status(None)
        .await
        .map_err(|_| invalid())?;
    serde_json::from_str(&encoded).map_err(|_| invalid())
}

struct Call {
    active: Arc<AtomicBool>,
    abort: Option<AbortHandle>,
}

enum Outbound {
    Reply {
        id: String,
        active: Arc<AtomicBool>,
        response: Box<Result<NativeAuthorityResponse, RuntimeError>>,
    },
    Authority,
    Cancelled(String),
}

enum Finished {
    Io(io::Result<()>),
    Call {
        id: String,
        response: Box<Result<NativeAuthorityResponse, RuntimeError>>,
    },
}

enum SourceOperation {
    Export,
    BiometricExport(String),
    RevalidateIndependentRestrictions,
}

struct Port {
    source: Arc<NativeSourceAttachment>,
    observer: Arc<ObservationHandle>,
    tasks: JoinSet<Finished>,
}
impl Drop for Port {
    fn drop(&mut self) {
        // Revoke the Core channel/prompt before dropping any asynchronous waiter.
        self.source.close();
        self.observer.close();
        self.tasks.abort_all();
    }
}

struct LegacyPort {
    source: Arc<NativeSourceAttachment>,
}
impl Drop for LegacyPort {
    fn drop(&mut self) {
        // A cancelled socket task must revoke its source before a held blocking
        // encoder that owns another Arc is allowed to reach final admission.
        self.source.close();
    }
}

fn invalid() -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, "Invalid native source protocol")
}
fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 128
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.'))
}
fn admit_id(seen: &mut HashSet<String>, id: &str) -> io::Result<()> {
    if !valid_id(id) || seen.len() == MAX_CONNECTION_REQUESTS || !seen.insert(id.to_owned()) {
        return Err(invalid());
    }
    Ok(())
}

/// The caller must authenticate the OS peer before passing this stream. This adapter additionally
/// checks the launch origin that the native binary supplies; browser controls cannot override it.
pub(super) async fn serve<S>(native: Arc<NativeRuntime>, mut stream: S) -> io::Result<()>
where
    S: AsyncRead + AsyncWrite + Unpin + Send + 'static,
{
    let first: serde_json::Value = read_frame_bounded(&mut stream, INPUT_BYTES).await?;
    if first.get("mode").is_some() {
        let handshake: LegacyRuntimeHandshake =
            serde_json::from_value(first).map_err(|_| invalid())?;
        return serve_legacy(native, stream, handshake).await;
    }
    let handshake: NativeRuntimeHandshake = serde_json::from_value(first).map_err(|_| invalid())?;
    if handshake.protocol_version != RUNTIME_NATIVE_PROTOCOL_VERSION {
        return Err(invalid());
    }
    let extension = extension_id_for_origin(&handshake.browser_origin).ok_or_else(invalid)?;
    let mut seen = HashSet::new();
    admit_id(&mut seen, &handshake.request_id)?;
    let source = Arc::new(
        native
            .attach_native_source(extension, bittery_crypto_core::generate_uuid())
            .map_err(|_| invalid())?,
    );
    // The transport keeps only its Core facet; it must not keep the native owner alive.
    drop(native);
    let (wake, mut wakes) = watch::channel(());
    let observer = source
        .observe_changes(Arc::new(Wake(wake)))
        .map_err(|_| invalid())?;
    wakes.borrow_and_update();
    let mut port = Port {
        source,
        observer,
        tasks: JoinSet::new(),
    };
    let (mut reader, mut writer) = tokio::io::split(stream);
    let (requests, mut request_rx) = mpsc::channel(QUEUED_FRAMES);
    let (outputs, mut output_rx) = mpsc::channel(QUEUED_FRAMES);
    let (delivered, mut delivery_rx) = mpsc::channel(QUEUED_FRAMES);
    port.tasks.spawn(async move {
        let result = async {
            loop {
                let request =
                    match read_frame_bounded::<_, NativeRuntimeRequest>(&mut reader, INPUT_BYTES)
                        .await
                    {
                        Ok(request) => request,
                        Err(error) if error.kind() == io::ErrorKind::UnexpectedEof => return Ok(()),
                        Err(error) => return Err(error),
                    };
                requests.send(request).await.map_err(|_| invalid())?;
            }
        }
        .await;
        Finished::Io(result)
    });
    let encoding_source = port.source.clone();
    port.tasks.spawn(async move {
        let result = async {
            while let Some(output) = output_rx.recv().await {
                let (message, completed) = match output {
                    Outbound::Reply {
                        id,
                        active,
                        response,
                    } => {
                        if !active.load(Ordering::SeqCst) {
                            continue;
                        }
                        let encoded = (*response)
                            .and_then(|response| encoding_source.encode_response(&response));
                        let (failed, payload) = match encoded {
                            Ok(value) => (false, value),
                            Err(error) => (
                                true,
                                Zeroizing::new(
                                    serde_json::to_string(&error).map_err(|_| invalid())?,
                                ),
                            ),
                        };
                        (
                            NativeRuntimeMessage::Reply {
                                request_id: id.clone(),
                                failed,
                                payload,
                            },
                            Some(id),
                        )
                    }
                    Outbound::Authority => {
                        let response = NativeAuthorityResponse::Source {
                            snapshot: encoding_source.snapshot().map_err(|_| invalid())?,
                        };
                        let payload = encoding_source
                            .encode_response(&response)
                            .map_err(|_| invalid())?;
                        (NativeRuntimeMessage::Authority { payload }, None)
                    }
                    Outbound::Cancelled(id) => {
                        (NativeRuntimeMessage::Cancelled { request_id: id }, None)
                    }
                };
                write_frame_bounded(&mut writer, &message, OUTPUT_BYTES).await?;
                if let Some(id) = completed {
                    delivered.send(id).await.map_err(|_| invalid())?;
                }
            }
            Ok(())
        }
        .await;
        Finished::Io(result)
    });
    let initial_active = Arc::new(AtomicBool::new(true));
    let mut calls = HashMap::new();
    calls.insert(
        handshake.request_id.clone(),
        Call {
            active: initial_active.clone(),
            abort: None,
        },
    );
    outputs
        .try_send(Outbound::Reply {
            id: handshake.request_id,
            active: initial_active,
            response: Box::new(
                port.source
                    .snapshot()
                    .map(|snapshot| NativeAuthorityResponse::Source { snapshot }),
            ),
        })
        .map_err(|_| invalid())?;

    let result = loop {
        tokio::select! {
            _ = port.source.runtime_closed() => break Err(io::Error::new(io::ErrorKind::ConnectionAborted, "Runtime owner closed")),
            Some(request) = request_rx.recv() => {
                if request.protocol_version != RUNTIME_NATIVE_PROTOCOL_VERSION {
                    break Err(invalid());
                }
                if let Err(error) = admit_id(&mut seen, &request.request_id) { break Err(error); }
                if let NativeRuntimeCommand::Cancel { call_id } = request.command {
                    if !valid_id(&call_id) { break Err(invalid()); }
                    if let Some(call) = calls.remove(&call_id) {
                        call.active.store(false, Ordering::SeqCst);
                        if let Some(abort) = call.abort { abort.abort(); }
                    }
                    if outputs.try_send(Outbound::Cancelled(request.request_id)).is_err() { break Err(invalid()); }
                    continue;
                }
                if calls.len() >= MAX_CALLS { break Err(invalid()); }
                let active = Arc::new(AtomicBool::new(true));
                let id = request.request_id;
                match request.command {
                    NativeRuntimeCommand::Connect {} | NativeRuntimeCommand::Cancel { .. } => break Err(invalid()),
                    command @ (NativeRuntimeCommand::Snapshot {} | NativeRuntimeCommand::AcknowledgeRestrictions { .. }) => {
                        let response = match command {
                            NativeRuntimeCommand::Snapshot {} => port.source.snapshot().map(|snapshot| NativeAuthorityResponse::Source { snapshot }),
                            NativeRuntimeCommand::AcknowledgeRestrictions { acknowledgement } => {
                                let Ok(acknowledgement) = serde_json::from_str(&acknowledgement) else { break Err(invalid()); };
                                port.source.acknowledge_restrictions(acknowledgement).map(|()| NativeAuthorityResponse::Applied)
                            },
                            _ => unreachable!("only synchronous source controls are handled here"),
                        };
                        calls.insert(id.clone(), Call { active: active.clone(), abort: None });
                        let response = Box::new(response);
                        if outputs.try_send(Outbound::Reply { id, active, response }).is_err() { break Err(invalid()); }
                    },
                    command => {
                        let (challenge, operation) = match command {
                            NativeRuntimeCommand::Export { challenge } => (challenge, SourceOperation::Export),
                            NativeRuntimeCommand::ExportWithBiometric { challenge, prompt_message } => (challenge, SourceOperation::BiometricExport(prompt_message)),
                            NativeRuntimeCommand::RevalidateIndependentRestrictions { challenge } => (challenge, SourceOperation::RevalidateIndependentRestrictions),
                            _ => unreachable!("only source challenge commands are spawned"),
                        };
                        let Ok(challenge) = serde_json::from_str(&challenge) else { break Err(invalid()); };
                        let source = port.source.clone();
                        let call_id = id.clone();
                        let abort = port.tasks.spawn(async move {
                            let response = match operation {
                                SourceOperation::BiometricExport(prompt) => source.export_with_biometric(challenge, prompt).await,
                                SourceOperation::Export => source.export(challenge).await.map(|reply| NativeAuthorityResponse::Exported { reply }),
                                SourceOperation::RevalidateIndependentRestrictions => source.revalidate_independent_restrictions(challenge).await.map(|reply| NativeAuthorityResponse::IndependentRestrictionsRevalidated { reply }),
                            };
                            Finished::Call { id: call_id, response: Box::new(response) }
                        });
                        calls.insert(id, Call { active, abort: Some(abort) });
                    },
                }
            },
            Some(id) = delivery_rx.recv() => { calls.remove(&id); },
            changed = wakes.changed() => {
                if changed.is_err() || outputs.try_send(Outbound::Authority).is_err() { break Err(invalid()); }
            },
            finished = port.tasks.join_next() => match finished {
                Some(Ok(Finished::Io(result))) => break result,
                Some(Ok(Finished::Call { id, response })) => {
                    if let Some(call) = calls.get_mut(&id) {
                        call.abort = None;
                        if outputs.try_send(Outbound::Reply { id, active: call.active.clone(), response }).is_err() { break Err(invalid()); }
                    }
                },
                Some(Err(error)) if error.is_cancelled() => {},
                _ => break Err(invalid()),
            },
        }
    };
    port.source.close();
    port.observer.close();
    for call in calls.values() {
        call.active.store(false, Ordering::SeqCst);
    }
    port.tasks.abort_all();
    while port.tasks.join_next().await.is_some() {}
    result
}

async fn serve_legacy<S>(
    native: Arc<NativeRuntime>,
    mut stream: S,
    handshake: LegacyRuntimeHandshake,
) -> io::Result<()>
where
    S: AsyncRead + AsyncWrite + Unpin + Send + 'static,
{
    let extension = extension_id_for_origin(&handshake.browser_origin).ok_or_else(invalid)?;
    let port = LegacyPort {
        source: Arc::new(
            native
                .attach_native_source(extension, bittery_crypto_core::generate_uuid())
                .map_err(|_| invalid())?,
        ),
    };
    drop(native);
    let request = handshake.request;
    if request.protocol_version != Some(DESKTOP_PROTOCOL_VERSION) {
        write_frame_bounded(
            &mut stream,
            &DesktopEnvelope::current(
                request.request_id,
                DesktopResponse::ProtocolMismatch {
                    expected_version: DESKTOP_PROTOCOL_VERSION,
                    received_version: request.protocol_version,
                },
            ),
            MAX_IPC_FRAME_BYTES,
        )
        .await?;
        return Ok(());
    }
    if matches!(
        request.payload,
        crate::desktop_ipc::DesktopRequest::SubscribeDesktopEvents
    ) {
        return serve_legacy_events(port, stream, request.request_id).await;
    }
    let correlation = request.request_id;
    let (mut reader, mut writer) = tokio::io::split(stream);
    let result = match request.payload {
        crate::desktop_ipc::DesktopRequest::GetDesktopStatus => {
            let encoding_source = port.source.clone();
            let request_id = correlation.clone();
            let mut encoding = Box::pin(async move {
                encoding_source
                    .encode_legacy_status(request_id.as_deref())
                    .await
            });
            let mut next_byte = [0u8; 1];
            tokio::select! {
                biased;
                _ = reader.read(&mut next_byte) => return Ok(()),
                _ = port.source.runtime_closed() => return Ok(()),
                encoded = &mut encoding => encoded.map_err(|_| ()),
            }
        }
        crate::desktop_ipc::DesktopRequest::GetDesktopAccounts => {
            let encoding_source = port.source.clone();
            let request_id = correlation.clone();
            let mut encoding = Box::pin(async move {
                encoding_source
                    .encode_legacy_accounts(request_id.as_deref())
                    .await
            });
            let mut next_byte = [0u8; 1];
            tokio::select! {
                biased;
                _ = reader.read(&mut next_byte) => return Ok(()),
                _ = port.source.runtime_closed() => return Ok(()),
                encoded = &mut encoding => encoded.map_err(|_| ()),
            }
        }
        crate::desktop_ipc::DesktopRequest::GetDesktopAuthToken { account_id } => {
            let encoding_source = port.source.clone();
            let request_id = correlation.clone();
            let mut encoding = Box::pin(async move {
                encoding_source
                    .encode_legacy_auth_token(&account_id, request_id.as_deref())
                    .await
            });
            let mut next_byte = [0u8; 1];
            tokio::select! {
                biased;
                _ = reader.read(&mut next_byte) => return Ok(()),
                _ = port.source.runtime_closed() => return Ok(()),
                encoded = &mut encoding => encoded.map_err(|_| ()),
            }
        }
        crate::desktop_ipc::DesktopRequest::CheckBiometricAvailable => {
            let encoding_source = port.source.clone();
            let request_id = correlation.clone();
            let mut encoding = Box::pin(async move {
                encoding_source
                    .encode_legacy_biometric_status(request_id.as_deref())
                    .await
            });
            let mut next_byte = [0u8; 1];
            tokio::select! {
                biased;
                _ = reader.read(&mut next_byte) => return Ok(()),
                _ = port.source.runtime_closed() => return Ok(()),
                encoded = &mut encoding => encoded.map_err(|_| ()),
            }
        }
        crate::desktop_ipc::DesktopRequest::BiometricUnlockRequest {
            challenge,
            extension_id,
            account_id,
        } => {
            let encoding_source = port.source.clone();
            let request_id = correlation.clone();
            let mut encoding = Box::pin(async move {
                encoding_source
                    .encode_legacy_biometric_single(
                        account_id.as_deref(),
                        &extension_id,
                        &challenge,
                        request_id.as_deref(),
                    )
                    .await
            });
            let mut next_byte = [0u8; 1];
            tokio::select! {
                biased;
                _ = reader.read(&mut next_byte) => return Ok(()),
                _ = port.source.runtime_closed() => return Ok(()),
                encoded = &mut encoding => encoded.map_err(|_| ()),
            }
        }
        crate::desktop_ipc::DesktopRequest::BiometricUnlockAllRequest {
            challenge,
            extension_id,
        } => {
            let encoding_source = port.source.clone();
            let request_id = correlation.clone();
            let mut encoding = Box::pin(async move {
                encoding_source
                    .encode_legacy_biometric_all(&extension_id, &challenge, request_id.as_deref())
                    .await
            });
            let mut next_byte = [0u8; 1];
            tokio::select! {
                biased;
                _ = reader.read(&mut next_byte) => return Ok(()),
                _ = port.source.runtime_closed() => return Ok(()),
                encoded = &mut encoding => encoded.map_err(|_| ()),
            }
        }
        legacy_request @ (crate::desktop_ipc::DesktopRequest::GetDesktopItemsSnapshot {
            ..
        }
        | crate::desktop_ipc::DesktopRequest::GetDesktopVaultKeys { .. }) => {
            let encoding_source = port.source.clone();
            let request_id = correlation.clone();
            let mut encoding = tokio::task::spawn_blocking(move || match legacy_request {
                crate::desktop_ipc::DesktopRequest::GetDesktopItemsSnapshot { account_ids } => {
                    encoding_source
                        .encode_legacy_items_snapshot(account_ids.as_deref(), request_id.as_deref())
                }
                crate::desktop_ipc::DesktopRequest::GetDesktopVaultKeys { account_id } => {
                    encoding_source.encode_legacy_vault_keys(&account_id, request_id.as_deref())
                }
                _ => unreachable!("closed legacy read changed after dispatch"),
            });
            let mut next_byte = [0u8; 1];
            let encoded = tokio::select! {
                biased;
                _ = reader.read(&mut next_byte) => return Ok(()),
                _ = port.source.runtime_closed() => return Ok(()),
                completed = &mut encoding => completed.map_err(|_| invalid())?,
            };
            encoded.map_err(|_| ())
        }
        _ => Err(()),
    };
    match result {
        Ok(encoded) => {
            let length = validate_frame_length(encoded.len(), MAX_IPC_FRAME_BYTES)?;
            writer.write_all(&length.to_le_bytes()).await?;
            writer.write_all(encoded.as_bytes()).await?;
        }
        Err(()) => {
            write_frame_bounded(
                &mut writer,
                &DesktopEnvelope::current(
                    correlation,
                    DesktopResponse::Error {
                        message: "Native source is unavailable".into(),
                    },
                ),
                MAX_IPC_FRAME_BYTES,
            )
            .await?;
        }
    }
    Ok(())
}

async fn serve_legacy_events<S>(
    port: LegacyPort,
    mut stream: S,
    request_id: Option<String>,
) -> io::Result<()>
where
    S: AsyncRead + AsyncWrite + Unpin + Send + 'static,
{
    let (events, mut received) = mpsc::channel(QUEUED_FRAMES);
    let (overflow, mut overflowed) = watch::channel(false);
    let observer = port
        .source
        .observe_changes(Arc::new(LegacyWake { events, overflow }))
        .map_err(|_| invalid())?;
    let initial = received.recv().await.ok_or_else(invalid)?;
    let mut observed = observed_unlocked(&initial);
    let mut next_byte = [0u8; 1];
    let mut current = tokio::select! {
        biased;
        _ = overflowed.changed() => return Ok(()),
        _ = port.source.runtime_closed() => return Ok(()),
        result = stream.read(&mut next_byte) => {
            let _ = result?;
            return Ok(());
        },
        result = legacy_status(&port.source) => result
            .map(|status| status.unlocked_accounts)
            .unwrap_or_default(),
    };
    write_legacy_event_frame(
        &mut stream,
        &mut overflowed,
        &port.source,
        DesktopEnvelope::current(
            request_id,
            DesktopResponse::DesktopEventSubscription { subscribed: true },
        ),
    )
    .await?;

    loop {
        if *overflowed.borrow() {
            break;
        }
        let mut next_byte = [0u8; 1];
        let projection = tokio::select! {
            biased;
            _ = overflowed.changed() => break,
            _ = port.source.runtime_closed() => {
                write_legacy_shutdown_close(&mut stream, &overflowed, &port.source).await;
                break;
            },
            result = stream.read(&mut next_byte) => {
                // The subscribed browser peer has gone. This is only its own source scope.
                let _ = result?;
                break;
            },
            next = received.recv() => match next {
                Some(projection) => projection,
                None => break,
            },
        };
        if *overflowed.borrow() {
            break;
        }
        let next_observed = observed_unlocked(&projection);
        let lost_observed = observed.iter().any(|id| !next_observed.contains(id));
        observed = next_observed;
        let status = tokio::select! {
            biased;
            _ = overflowed.changed() => break,
            _ = port.source.runtime_closed() => {
                write_legacy_shutdown_close(&mut stream, &overflowed, &port.source).await;
                break;
            },
            result = stream.read(&mut next_byte) => {
                let _ = result?;
                break;
            },
            result = legacy_status(&port.source) => result,
        };
        let next_current = status
            .as_ref()
            .map(|status| status.unlocked_accounts.clone())
            .unwrap_or_default();
        let lost_current = current.iter().any(|id| !next_current.contains(id));
        let timestamp = status
            .as_ref()
            .map(|status| status.timestamp)
            .or_else(|_| port.source.legacy_event_timestamp())
            .map_err(|_| invalid())?;
        if lost_observed || lost_current {
            write_legacy_event_frame(
                &mut stream,
                &mut overflowed,
                &port.source,
                DesktopEnvelope::current(
                    None,
                    DesktopResponse::DesktopEvent(DesktopEvent::Lock {
                        reason: "Core authority changed".into(),
                        timestamp,
                    }),
                ),
            )
            .await?;
            current.clear();
        }
        if !next_current.is_empty() && current != next_current {
            write_legacy_event_frame(
                &mut stream,
                &mut overflowed,
                &port.source,
                DesktopEnvelope::current(
                    None,
                    DesktopResponse::DesktopEvent(DesktopEvent::Unlock {
                        accounts: next_current.clone(),
                        timestamp,
                    }),
                ),
            )
            .await?;
        }
        current = next_current;
    }
    observer.close();
    Ok(())
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use crate::desktop_ipc::{read_frame, write_frame};
    use bittery_client_core::{
        AuthClientConfig, ClientPlatform, NativeAuthoritySnapshot, RuntimeStatusProjection,
    };
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::UnixStream;

    async fn native() -> (tempfile::TempDir, Arc<NativeRuntime>) {
        let directory = tempfile::tempdir().unwrap();
        let native = Arc::new(
            NativeRuntime::open(
                directory.path(),
                AuthClientConfig::new(
                    "native-transport-test".into(),
                    ClientPlatform::Desktop,
                    "test".into(),
                )
                .unwrap(),
            )
            .await
            .unwrap(),
        );
        (directory, native)
    }

    async fn connect(
        native: Arc<NativeRuntime>,
    ) -> (
        UnixStream,
        tokio::task::JoinHandle<io::Result<()>>,
        NativeAuthoritySnapshot,
    ) {
        let (mut client, server) = UnixStream::pair().unwrap();
        let task = tokio::spawn(serve(native, server));
        write_frame(
            &mut client,
            &NativeRuntimeHandshake {
                protocol_version: 2,
                request_id: "connect".into(),
                browser_origin: crate::native_messaging_installer::allowed_extension_origins()[0]
                    .clone(),
            },
        )
        .await
        .unwrap();
        let snapshot = snapshot_reply(&mut client, "connect").await;
        (client, task, snapshot)
    }

    async fn snapshot_reply(client: &mut UnixStream, expected_id: &str) -> NativeAuthoritySnapshot {
        loop {
            let message: NativeRuntimeMessage =
                tokio::time::timeout(std::time::Duration::from_secs(5), read_frame(client))
                    .await
                    .unwrap()
                    .unwrap();
            match message {
                NativeRuntimeMessage::Authority { .. } => continue,
                NativeRuntimeMessage::Reply {
                    request_id,
                    failed,
                    payload,
                } => {
                    assert_eq!(request_id, expected_id);
                    assert!(!failed);
                    let response: NativeAuthorityResponse = serde_json::from_str(&payload).unwrap();
                    let NativeAuthorityResponse::Source { snapshot } = response else {
                        panic!("Expected Core source snapshot")
                    };
                    return snapshot;
                }
                _ => panic!("Expected correlated source reply"),
            }
        }
    }

    async fn finished(task: tokio::task::JoinHandle<io::Result<()>>) -> io::Result<()> {
        tokio::time::timeout(std::time::Duration::from_secs(5), task)
            .await
            .unwrap()
            .unwrap()
    }

    #[tokio::test]
    async fn overflowing_observer_interrupts_a_blocked_event_write() {
        let (_directory, native) = native().await;
        let source = native
            .attach_native_source("accepted-extension".into(), "overflow-write".into())
            .unwrap();
        let (events, _received) = mpsc::channel(QUEUED_FRAMES);
        let (overflow, mut overflowed) = watch::channel(false);
        let wake = LegacyWake { events, overflow };
        let projection = RuntimeProjection::RuntimeStatus(RuntimeStatusProjection {
            profile_admission_cleanup: None,
            account_id: None,
            revision: 0,
            accounts: vec![],
            closed: false,
        });
        for _ in 0..QUEUED_FRAMES {
            wake.publish(projection.clone());
        }
        let (mut blocked, _unread_peer) = tokio::io::duplex(1);
        let write = tokio::spawn(async move {
            write_legacy_event_frame(
                &mut blocked,
                &mut overflowed,
                &source,
                DesktopEnvelope::current(
                    None,
                    DesktopResponse::DesktopEvent(DesktopEvent::Lock {
                        reason: "Core authority changed".into(),
                        timestamp: 1,
                    }),
                ),
            )
            .await
        });
        tokio::task::yield_now().await;
        assert!(
            !write.is_finished(),
            "the event writer must still be blocked"
        );
        wake.publish(projection);
        assert!(
            tokio::time::timeout(std::time::Duration::from_secs(1), write)
                .await
                .expect("overflow must cancel the socket write")
                .unwrap()
                .is_err()
        );
        native.shutdown().await.unwrap();
    }

    async fn assert_runtime_shutdown_retires_blocked_event(blocked_stage: &str) {
        let (_directory, native) = native().await;
        let source = Arc::new(
            native
                .attach_native_source("accepted-extension".into(), "event-shutdown".into())
                .unwrap(),
        );
        let (mut client, server) = tokio::io::duplex(1);
        let mut serving = tokio::spawn(serve_legacy_events(
            LegacyPort { source },
            server,
            Some("subscribe".into()),
        ));
        if blocked_stage == "close" {
            let ack: DesktopEnvelope<DesktopResponse> =
                tokio::time::timeout(std::time::Duration::from_secs(5), read_frame(&mut client))
                    .await
                    .unwrap()
                    .unwrap();
            assert!(matches!(
                ack.payload,
                DesktopResponse::DesktopEventSubscription { subscribed: true }
            ));
        }
        if blocked_stage == "close" {
            native.shutdown().await.unwrap();
        }
        let mut first_byte = [0];
        tokio::time::timeout(
            std::time::Duration::from_secs(5),
            client.read_exact(&mut first_byte),
        )
        .await
        .expect("the selected event frame must start writing")
        .unwrap();
        if blocked_stage == "ack" {
            native.shutdown().await.unwrap();
        }
        let result =
            match tokio::time::timeout(std::time::Duration::from_millis(250), &mut serving).await {
                Ok(result) => result.unwrap(),
                Err(_) => {
                    serving.abort();
                    panic!("Core shutdown stranded the blocked {blocked_stage} event frame");
                }
            };
        if blocked_stage == "ack" {
            assert_eq!(result.unwrap_err().kind(), io::ErrorKind::ConnectionAborted);
        } else {
            result.unwrap();
        }
        let mut remaining = Vec::new();
        tokio::time::timeout(
            std::time::Duration::from_secs(1),
            client.read_to_end(&mut remaining),
        )
        .await
        .expect("source port must close after shutdown")
        .unwrap();
    }

    #[tokio::test]
    async fn runtime_shutdown_retires_event_socket_with_blocked_ack() {
        assert_runtime_shutdown_retires_blocked_event("ack").await;
    }

    #[tokio::test]
    async fn runtime_shutdown_retires_event_socket_with_blocked_close() {
        assert_runtime_shutdown_retires_blocked_event("close").await;
    }

    #[tokio::test]
    async fn runtime_shutdown_interrupts_blocked_lock_event_write() {
        let (_directory, native) = native().await;
        let source = native
            .attach_native_source("accepted-extension".into(), "lock-write".into())
            .unwrap();
        let (_overflow, mut overflowed) = watch::channel(false);
        let (mut blocked, mut client) = tokio::io::duplex(1);
        let mut write = tokio::spawn(async move {
            write_legacy_event_frame(
                &mut blocked,
                &mut overflowed,
                &source,
                DesktopEnvelope::current(
                    None,
                    DesktopResponse::DesktopEvent(DesktopEvent::Lock {
                        reason: "Core authority changed".into(),
                        timestamp: 1,
                    }),
                ),
            )
            .await
        });
        let mut first_byte = [0];
        client.read_exact(&mut first_byte).await.unwrap();
        native.shutdown().await.unwrap();
        let result = tokio::time::timeout(std::time::Duration::from_secs(1), &mut write)
            .await
            .expect("Core shutdown must cancel a blocked Lock frame")
            .unwrap();
        assert_eq!(result.unwrap_err().kind(), io::ErrorKind::ConnectionAborted);
    }

    #[tokio::test]
    async fn aborted_legacy_socket_retires_source_while_encoder_retains_clone() {
        let (_directory, native) = native().await;
        let source = Arc::new(
            native
                .attach_native_source("accepted-extension".into(), "held-transport".into())
                .unwrap(),
        );
        let encoder_clone = source.clone();
        assert!(encoder_clone.snapshot().is_ok());
        let (entered_tx, entered_rx) = tokio::sync::oneshot::channel();
        let socket_task = tokio::spawn(async move {
            let _port = LegacyPort { source };
            let _ = entered_tx.send(());
            std::future::pending::<()>().await;
        });
        entered_rx.await.unwrap();
        socket_task.abort();
        assert!(socket_task.await.unwrap_err().is_cancelled());
        assert!(encoder_clone.snapshot().is_err());
        native.shutdown().await.unwrap();
    }

    #[tokio::test]
    async fn framed_independent_revalidation_refusal_preserves_the_source_port() {
        let (_directory, native) = native().await;
        let (mut client, task, source) = connect(native.clone()).await;
        // The frame is well formed but refers to no installed Account. Core must refuse this
        // authority request without treating the new closed command as a broken transport.
        let scope = serde_json::json!({
            "accountId":"absent-account", "incarnation":"absent-generation",
            "serverUrl":"https://native-revalidation.test", "userId":"absent-user",
            "lockEpoch":"0"
        });
        let challenge = serde_json::json!({
            "version":1, "challengeId":"absent-challenge", "extensionId":source.extension_id,
            "sourceOwner":source.owner_id, "sourceChannel":source.channel_id,
            "sourceTransport":source.transport_id, "sourceKeyGeneration":"0",
            "destinationOwner":"consumer-owner", "destinationChannel":"consumer-channel",
            "destinationTransport":"consumer-transport", "source":scope, "destination":scope,
            "newDestination":false, "destinationInsecureTransportConfirmed":false,
            "purpose":{
                "type":"revalidateIndependentRestrictions", "restrictionFrontier":"0",
                "restrictionChainDigest":source.restriction_chain_digest,
                "excludedVaultIds":["d87bb04e-5a15-4072-9cc7-29ff1c363af9"]
            }
        });
        write_frame(&mut client, &serde_json::json!({
            "protocolVersion":2, "requestId":"revalidate-absent",
            "command":{"type":"revalidateIndependentRestrictions", "challenge":challenge.to_string()}
        })).await.unwrap();
        let refused = tokio::time::timeout(std::time::Duration::from_secs(5), async {
            loop {
                let response: NativeRuntimeMessage = read_frame(&mut client).await?;
                if let NativeRuntimeMessage::Reply {
                    request_id,
                    failed,
                    payload,
                } = response
                {
                    let error =
                        serde_json::from_str::<RuntimeError>(&payload).map_err(io::Error::other)?;
                    return Ok::<_, io::Error>((request_id, failed, error.code));
                }
            }
        })
        .await;
        if matches!(refused, Ok(Ok(_))) {
            write_frame(
                &mut client,
                &NativeRuntimeRequest {
                    protocol_version: 2,
                    request_id: "after-refused-revalidation".into(),
                    command: NativeRuntimeCommand::Snapshot {},
                },
            )
            .await
            .unwrap();
            let current = snapshot_reply(&mut client, "after-refused-revalidation").await;
            assert_eq!(current.channel_id, source.channel_id);
        }
        drop(client);
        let ended = finished(task).await;
        native.shutdown().await.unwrap();
        let (id, failed, code) = refused
            .expect("bounded native revalidation reply")
            .expect("revalidation refusal must be a Core result, not native EOF");
        assert_eq!(id, "revalidate-absent");
        assert!(failed);
        assert_eq!(code, bittery_client_core::RuntimeErrorCode::AccountMissing);
        ended.unwrap();
    }

    #[tokio::test]
    async fn framed_native_acknowledgements_are_bound_to_the_owning_source_port() {
        let (_directory, native) = native().await;
        let consumer_directory = tempfile::tempdir().unwrap();
        let consumer = NativeRuntime::open(
            consumer_directory.path(),
            AuthClientConfig::new(
                "native-acknowledgement-consumer".into(),
                ClientPlatform::Extension,
                "test".into(),
            )
            .unwrap(),
        )
        .await
        .unwrap();
        let control = super::super::native::source_acceptance::destination_control(&consumer);
        let (mut first, first_task, first_snapshot) = connect(native.clone()).await;
        let (mut second, second_task, second_snapshot) = connect(native.clone()).await;
        let channel = control
            .attach_desktop(first_snapshot, "acknowledgement-consumer-port".into())
            .await
            .unwrap();
        let acknowledgement = control.restriction_acknowledgement(&channel).unwrap();
        assert_eq!(acknowledgement.frontier, 0);
        for (stream, id, expected_failure) in [
            (&mut first, "acknowledge", false),
            (&mut second, "foreign-acknowledge", true),
        ] {
            write_frame(
                stream,
                &serde_json::json!({
                    "protocolVersion":2,
                    "requestId":id,
                    "command":{
                        "type":"acknowledgeRestrictions",
                        "acknowledgement":serde_json::to_string(&acknowledgement).unwrap()
                    }
                }),
            )
            .await
            .unwrap();
            loop {
                let response: NativeRuntimeMessage =
                    tokio::time::timeout(std::time::Duration::from_secs(5), read_frame(stream))
                        .await
                        .unwrap()
                        .expect(
                            "the native port must return a correlated Core acknowledgement result",
                        );
                if let NativeRuntimeMessage::Reply {
                    request_id,
                    failed,
                    payload,
                } = response
                {
                    assert_eq!(request_id, id);
                    assert_eq!(failed, expected_failure);
                    if !failed {
                        assert!(matches!(
                            serde_json::from_str::<NativeAuthorityResponse>(&payload).unwrap(),
                            NativeAuthorityResponse::Applied
                        ));
                    }
                    break;
                }
            }
        }
        write_frame(
            &mut second,
            &NativeRuntimeRequest {
                protocol_version: 2,
                request_id: "after-foreign-acknowledgement".into(),
                command: NativeRuntimeCommand::Snapshot {},
            },
        )
        .await
        .unwrap();
        assert_eq!(
            snapshot_reply(&mut second, "after-foreign-acknowledgement")
                .await
                .channel_id,
            second_snapshot.channel_id
        );
        drop(first);
        drop(second);
        finished(first_task).await.unwrap();
        finished(second_task).await.unwrap();
        consumer.shutdown().await.unwrap();
        native.shutdown().await.unwrap();
    }

    #[tokio::test]
    async fn framed_native_source_sqlite_unix_ports_survive_independent_eof() {
        let (_directory, native) = native().await;
        let (first, first_task, first_snapshot) = connect(native.clone()).await;
        let (mut second, second_task, second_snapshot) = connect(native.clone()).await;
        assert!(first_snapshot.accounts.is_empty());
        assert_ne!(first_snapshot.channel_id, second_snapshot.channel_id);
        drop(first);
        finished(first_task).await.unwrap();
        write_frame(
            &mut second,
            &NativeRuntimeRequest {
                protocol_version: 2,
                request_id: "snapshot-1".into(),
                command: NativeRuntimeCommand::Snapshot {},
            },
        )
        .await
        .unwrap();
        assert_eq!(
            snapshot_reply(&mut second, "snapshot-1").await.channel_id,
            second_snapshot.channel_id
        );
        drop(second);
        finished(second_task).await.unwrap();
        native.shutdown().await.unwrap();
    }

    #[tokio::test]
    async fn framed_native_source_refuses_origin_and_oversized_header_before_payload() {
        let (_directory, native) = native().await;
        let (mut client, server) = UnixStream::pair().unwrap();
        let task = tokio::spawn(serve(native.clone(), server));
        write_frame(
            &mut client,
            &NativeRuntimeHandshake {
                protocol_version: 2,
                request_id: "connect".into(),
                browser_origin: "chrome-extension://foreign/".into(),
            },
        )
        .await
        .unwrap();
        assert_eq!(
            finished(task).await.unwrap_err().kind(),
            io::ErrorKind::InvalidData
        );
        let (mut client, server) = UnixStream::pair().unwrap();
        let task = tokio::spawn(serve(native.clone(), server));
        client
            .write_all(&((INPUT_BYTES + 1) as u32).to_le_bytes())
            .await
            .unwrap();
        assert_eq!(
            finished(task).await.unwrap_err().kind(),
            io::ErrorKind::InvalidData
        );

        let (mut client, server) = UnixStream::pair().unwrap();
        let task = tokio::spawn(serve(native.clone(), server));
        write_frame(
            &mut client,
            &LegacyRuntimeHandshake {
                mode: crate::native_runtime_ipc::LegacyRuntimeMode::LegacySource,
                browser_origin: crate::native_messaging_installer::allowed_extension_origins()[0]
                    .clone(),
                request: DesktopEnvelope {
                    protocol_version: Some(9),
                    request_id: Some("legacy-mismatch".into()),
                    payload: crate::desktop_ipc::DesktopRequest::GetDesktopItemsSnapshot {
                        account_ids: None,
                    },
                },
            },
        )
        .await
        .unwrap();
        let reply: DesktopEnvelope<DesktopResponse> = read_frame(&mut client).await.unwrap();
        assert_eq!(reply.request_id.as_deref(), Some("legacy-mismatch"));
        assert!(matches!(
            reply.payload,
            DesktopResponse::ProtocolMismatch {
                expected_version: DESKTOP_PROTOCOL_VERSION,
                received_version: Some(9)
            }
        ));
        finished(task).await.unwrap();
        native.shutdown().await.unwrap();
    }

    #[tokio::test]
    async fn protocol1_requires_internal_legacy_mode_and_validated_origin() {
        let (_directory, native) = native().await;
        let request = DesktopEnvelope::current(
            Some("legacy-first".into()),
            crate::desktop_ipc::DesktopRequest::GetDesktopItemsSnapshot {
                account_ids: Some(vec!["absent-account".into()]),
            },
        );
        // A browser-shaped frame cannot declare its own source attachment on the Desktop socket.
        let (mut client, server) = UnixStream::pair().unwrap();
        let task = tokio::spawn(serve(native.clone(), server));
        write_frame(&mut client, &request).await.unwrap();
        assert_eq!(
            finished(task).await.unwrap_err().kind(),
            io::ErrorKind::InvalidData
        );

        let (mut client, server) = UnixStream::pair().unwrap();
        let task = tokio::spawn(serve(native.clone(), server));
        write_frame(
            &mut client,
            &LegacyRuntimeHandshake {
                mode: crate::native_runtime_ipc::LegacyRuntimeMode::LegacySource,
                browser_origin: "chrome-extension://foreign/".into(),
                request,
            },
        )
        .await
        .unwrap();
        assert_eq!(
            finished(task).await.unwrap_err().kind(),
            io::ErrorKind::InvalidData
        );
        native.shutdown().await.unwrap();
    }

    #[tokio::test]
    async fn legacy_event_subscription_acks_and_request_eof_does_not_close_it() {
        let (_directory, native) = native().await;
        let (mut subscriber, server) = UnixStream::pair().unwrap();
        let subscription = tokio::spawn(serve(native.clone(), server));
        write_frame(
            &mut subscriber,
            &LegacyRuntimeHandshake {
                mode: crate::native_runtime_ipc::LegacyRuntimeMode::LegacySource,
                browser_origin: crate::native_messaging_installer::allowed_extension_origins()[0]
                    .clone(),
                request: DesktopEnvelope::current(
                    Some("events".into()),
                    crate::desktop_ipc::DesktopRequest::SubscribeDesktopEvents,
                ),
            },
        )
        .await
        .unwrap();
        let ack: DesktopEnvelope<DesktopResponse> = read_frame(&mut subscriber).await.unwrap();
        assert_eq!(ack.request_id.as_deref(), Some("events"));
        assert!(matches!(
            ack.payload,
            DesktopResponse::DesktopEventSubscription { subscribed: true }
        ));

        let (mut request, server) = UnixStream::pair().unwrap();
        let ordinary = tokio::spawn(serve(native.clone(), server));
        write_frame(
            &mut request,
            &LegacyRuntimeHandshake {
                mode: crate::native_runtime_ipc::LegacyRuntimeMode::LegacySource,
                browser_origin: crate::native_messaging_installer::allowed_extension_origins()[0]
                    .clone(),
                request: DesktopEnvelope::current(
                    Some("status".into()),
                    crate::desktop_ipc::DesktopRequest::GetDesktopStatus,
                ),
            },
        )
        .await
        .unwrap();
        let _: DesktopEnvelope<DesktopResponse> = read_frame(&mut request).await.unwrap();
        drop(request);
        finished(ordinary).await.unwrap();
        assert!(tokio::time::timeout(
            std::time::Duration::from_millis(50),
            read_frame::<_, DesktopEnvelope<DesktopResponse>>(&mut subscriber)
        )
        .await
        .is_err());
        drop(subscriber);
        finished(subscription).await.unwrap();
        native.shutdown().await.unwrap();
    }

    #[tokio::test]
    async fn framed_native_source_rejects_recycled_request_identity_and_dropped_owner() {
        let (_directory, native) = native().await;
        let (mut client, task, _) = connect(native.clone()).await;
        write_frame(
            &mut client,
            &NativeRuntimeRequest {
                protocol_version: 2,
                request_id: "connect".into(),
                command: NativeRuntimeCommand::Snapshot {},
            },
        )
        .await
        .unwrap();
        assert_eq!(
            finished(task).await.unwrap_err().kind(),
            io::ErrorKind::InvalidData
        );
        let (mut client, task, _) = connect(native.clone()).await;
        native.shutdown().await.unwrap();
        assert!(finished(task).await.is_err());
        // Core shutdown closes the channel, so the stream cannot answer a fresh authority request.
        assert!(read_frame::<_, NativeRuntimeMessage>(&mut client)
            .await
            .is_err());
    }
    #[tokio::test]
    async fn framed_native_source_cannot_keep_dropped_native_owner_alive() {
        let (_directory, native) = native().await;
        let (mut client, task, _) = connect(native.clone()).await;
        drop(native);
        assert_eq!(
            finished(task).await.unwrap_err().kind(),
            io::ErrorKind::ConnectionAborted
        );
        assert!(read_frame::<_, NativeRuntimeMessage>(&mut client)
            .await
            .is_err());
    }
}

#[cfg(all(test, target_os = "linux"))]
#[path = "native_source_process_tests.rs"]
mod process_tests;
