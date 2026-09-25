//! Real framed source/Core/SQLite coverage with a held native OS callback primitive.
//! No OS enrollment, browser registration, real credentials or production profile is involved.
use super::*;
use crate::{
    desktop_ipc::{read_frame_bounded, write_frame_bounded},
    native_runtime_ipc::{
        NativeRuntimeCommand, NativeRuntimeHandshake, NativeRuntimeMessage, NativeRuntimeRequest,
        MAX_RUNTIME_NATIVE_REQUEST_BYTES, MAX_RUNTIME_NATIVE_RESPONSE_BYTES,
        RUNTIME_NATIVE_PROTOCOL_VERSION,
    },
    runtime_host::{biometry::run_prompt, native_source_transport::serve},
};
use async_trait::async_trait;
use base64::{engine::general_purpose::STANDARD, Engine};
use bittery_client_core::{
    BiometricHardware, BiometricKind, BiometricPort, BiometricPromptResult, ClientPlatform,
    NativeAuthorityResponse, NativeAuthoritySnapshot, NativeImportChallenge, ObservationRequest,
    PlatformStorageArea, PlatformStorageDeleteResult, PlatformStorageRequest,
    PlatformStorageResponse, RequestCancellation, RuntimeProjection, RuntimeRequest, SecretString,
    SerializedHttpExecutor, SerializedPlatformStorageExecutor,
};
use serde_json::json;
use std::{collections::HashMap, sync::Mutex, time::Duration};
use tauri_plugin_biometry::PromptCancellation;
use tokio::{
    net::UnixStream,
    sync::{mpsc, oneshot, Semaphore},
    time::timeout,
};
use zeroize::Zeroizing;

const ACCOUNT: &str = "source-a";
const OTHER: &str = "source-b";
const INCARNATION: &str = "generation";
const PREFIX: &str = "bittery:runtime:platform-storage";

#[derive(Default)]
struct Platform(Mutex<HashMap<String, SecretString>>);

impl Platform {
    fn put(&self, area: PlatformStorageArea, key: String, value: serde_json::Value) {
        self.0
            .lock()
            .unwrap()
            .insert(format!("{area:?}:{key}"), value.to_string().into());
    }
}

#[async_trait]
impl SerializedPlatformStorageExecutor for Platform {
    async fn invoke(&self, request: Zeroizing<String>) -> Result<Zeroizing<String>, RuntimeError> {
        let request: PlatformStorageRequest = serde_json::from_str(&request).unwrap();
        let mut values = self.0.lock().unwrap();
        let response = match &request {
            PlatformStorageRequest::ListKeys { .. } => {
                panic!("native source cancellation fixture does not provide profile inventory")
            }
            PlatformStorageRequest::Get { area, key } => PlatformStorageResponse::Value {
                value: values.get(&format!("{area:?}:{key}")).cloned(),
            },
            PlatformStorageRequest::Set { area, key, value } => {
                values.insert(format!("{area:?}:{key}"), value.clone());
                PlatformStorageResponse::Done
            }
            PlatformStorageRequest::Delete { area, key } => {
                values.remove(&format!("{area:?}:{key}"));
                PlatformStorageResponse::Done
            }
            PlatformStorageRequest::DeleteIfUnchanged {
                area,
                key,
                expected_value,
            } => {
                let key = format!("{area:?}:{key}");
                let result = match values.get(&key) {
                    None => PlatformStorageDeleteResult::AlreadyAbsent,
                    Some(actual) if actual.as_ref() == expected_value.as_ref() => {
                        values.remove(&key);
                        PlatformStorageDeleteResult::Deleted
                    }
                    Some(_) => PlatformStorageDeleteResult::Conflict,
                };
                PlatformStorageResponse::DeleteResult { result }
            }
            PlatformStorageRequest::DeletePrefix {
                area,
                prefix,
                preserve_key,
            } => {
                let retained = preserve_key.as_ref().map(|key| format!("{area:?}:{key}"));
                values.retain(|key, _| {
                    !key.starts_with(&format!("{area:?}:{prefix}"))
                        || retained.as_ref() == Some(key)
                });
                PlatformStorageResponse::Done
            }
        };
        Ok(Zeroizing::new(serde_json::to_string(&response).unwrap()))
    }
}

struct Offline;
#[async_trait]
impl SerializedHttpExecutor for Offline {
    async fn invoke(&self, _: Zeroizing<String>) -> Result<String, RuntimeError> {
        Ok(json!({"type": "networkFailure"}).to_string())
    }
    fn cancel(&self, _: &str) {}
}

struct OsCallback {
    cancellation: PromptCancellation,
    release: std::sync::mpsc::Sender<()>,
    finished: oneshot::Receiver<()>,
}

struct HeldOsPrompt {
    permit: Arc<Semaphore>,
    entered: mpsc::UnboundedSender<OsCallback>,
}

#[async_trait]
impl BiometricPort for HeldOsPrompt {
    async fn hardware(&self) -> Result<BiometricHardware, RuntimeError> {
        Ok(BiometricHardware {
            has_hardware: true,
            is_enrolled: true,
            kind: Some(BiometricKind::Other),
        })
    }
    async fn authenticate(
        &self,
        _: &str,
        cancellation: RequestCancellation,
    ) -> BiometricPromptResult {
        let entered = self.entered.clone();
        run_prompt(self.permit.clone(), cancellation, move |signal| {
            let (release, released) = std::sync::mpsc::channel();
            let (finished, completion) = oneshot::channel();
            if entered
                .send(OsCallback {
                    cancellation: signal,
                    release,
                    finished: completion,
                })
                .is_err()
            {
                return BiometricPromptResult::Cancelled;
            }
            // The controlled OS may complete successfully after cancellation was requested.
            // Existing native run_prompt must suppress that result and retain its permit until exit.
            let _ = released.recv();
            let _ = finished.send(());
            BiometricPromptResult::Authenticated
        })
        .await
    }
}

fn configured(path: &Path, platform: Arc<Platform>, kind: ClientPlatform) -> Arc<Runtime> {
    Runtime::with_configured_serialized_executors(
        Arc::new(SqliteReplica::open(path).unwrap()),
        platform,
        Arc::new(Offline),
        AuthClientConfig::new("framed-native-cancellation".into(), kind, "test".into()).unwrap(),
    )
}

async fn source(directory: &Path, prompt: Arc<HeldOsPrompt>) -> Arc<NativeRuntime> {
    let platform = Arc::new(Platform::default());
    let path = directory.join("source.sqlite");
    let initial = configured(&path, platform.clone(), ClientPlatform::Desktop);
    initial.open().await.unwrap();
    for account in [ACCOUNT, OTHER] {
        initial
            .install_or_replace_account(
                account.into(),
                format!("user-{account}"),
                INCARNATION.into(),
            )
            .await
            .unwrap();
    }
    initial.close().await;
    drop(initial);
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64;
    let device_key = [7_u8; 32];
    let wrapped = bittery_crypto_core::encrypt(&STANDARD.encode([9_u8; 32]), &device_key).unwrap();
    platform.put(
        PlatformStorageArea::DeviceSecret,
        format!("{PREFIX}:device-key"),
        json!({"version":1,"keyBytes":device_key}),
    );
    let accounts = [ACCOUNT, OTHER].map(|account| {
        json!({
            "accountId":account,"activeIncarnation":INCARNATION,"pendingInstall":null
        })
    });
    platform.put(
        PlatformStorageArea::DevicePlain,
        format!("{PREFIX}:device-catalog"),
        json!({
            "version":1,"accounts":accounts
        }),
    );
    for account in [ACCOUNT, OTHER] {
        let base = format!(
            "{PREFIX}:account:{}:{account}:incarnation:{}:{INCARNATION}",
            account.len(),
            INCARNATION.len()
        );
        platform.put(PlatformStorageArea::DevicePlain, format!("{base}:metadata"), json!({
            "version":1,"accountId":account,"incarnation":INCARNATION,"userId":format!("user-{account}"),
            "email":format!("{account}@example.test"),"name":"Native fixture","normalizedServerUrl":"https://example.test",
            "teamName":null,"teamAvatarUrl":null,"secretKeyHint":"fixture","addedAtMs":now,"lastActiveAtMs":now,
            "biometricEnabled":true,"insecureTransportConfirmed":false,"pinnedKdfProfile":bittery_crypto_core::current_kdf_profile(),
            "verifiedTravelMode":{"enabled":false,"hiddenVaultIds":[],"serverEnabledAtMs":null,"serverUpdatedAtMs":null,"verifiedAtMs":now}
        }));
        platform.put(PlatformStorageArea::DeviceSecret, format!("{base}:quick-unlock"), json!({
            "version":1,"accountId":account,"incarnation":INCARNATION,"encryptedMasterUnlockKey":wrapped,
            "secretKey":bittery_crypto_core::generate_secret_key(),"createdAtMs":now,"lastMasterPasswordEntryMs":now,"biometricEnabled":true
        }));
        platform.put(PlatformStorageArea::DeviceSecret, format!("{base}:current-session"), json!({
            "version":1,"accountId":account,"incarnation":INCARNATION,"token":"synthetic-retained-session",
            "sessionId":"synthetic-session","expiresAtMs":now+3_600_000,"serverExpiresAtMs":null,"vaultKeys":[],"encryptedPrivateKey":"opaque-fixture"
        }));
    }
    let core = configured(&path, platform, ClientPlatform::Desktop);
    core.install_biometric_port(prompt);
    core.open().await.unwrap();
    Arc::new(NativeRuntime {
        core,
        runners: Mutex::new(Some(Vec::new())),
        shutdown_result: watch::channel(None).0,
        leases: None,
        file_capabilities: Arc::new(NativeFileCapabilities::default()),
        image_sources: None,
        recovery_files: Arc::new(NativeRecoveryFiles::default()),
        startup_error: None,
        device_gate: Arc::new(Mutex::new(None)),
    })
}

async fn send(client: &mut UnixStream, id: &str, command: NativeRuntimeCommand) {
    write_frame_bounded(
        client,
        &NativeRuntimeRequest {
            protocol_version: RUNTIME_NATIVE_PROTOCOL_VERSION,
            request_id: id.into(),
            command,
        },
        MAX_RUNTIME_NATIVE_REQUEST_BYTES,
    )
    .await
    .unwrap();
}

async fn message(client: &mut UnixStream) -> NativeRuntimeMessage {
    timeout(
        Duration::from_secs(5),
        read_frame_bounded(client, MAX_RUNTIME_NATIVE_RESPONSE_BYTES),
    )
    .await
    .unwrap()
    .unwrap()
}

async fn snapshot(client: &mut UnixStream, id: &str) -> NativeAuthoritySnapshot {
    loop {
        match message(client).await {
            NativeRuntimeMessage::Authority { .. } => {}
            NativeRuntimeMessage::Reply {
                request_id,
                failed: false,
                payload,
            } => {
                assert_eq!(
                    request_id, id,
                    "retired invocation must not emit a late reply"
                );
                let NativeAuthorityResponse::Source { snapshot } =
                    serde_json::from_str(&payload).unwrap()
                else {
                    panic!("Expected source snapshot")
                };
                return snapshot;
            }
            _ => panic!("Expected current correlated snapshot"),
        }
    }
}

async fn connect(
    native: Arc<NativeRuntime>,
) -> (
    UnixStream,
    JoinHandle<std::io::Result<()>>,
    NativeAuthoritySnapshot,
) {
    let (mut client, server) = UnixStream::pair().unwrap();
    let task = tokio::spawn(serve(native, server));
    write_frame_bounded(
        &mut client,
        &NativeRuntimeHandshake {
            protocol_version: RUNTIME_NATIVE_PROTOCOL_VERSION,
            request_id: "connect".into(),
            browser_origin: crate::native_messaging_installer::allowed_extension_origins()[0]
                .clone(),
        },
        MAX_RUNTIME_NATIVE_REQUEST_BYTES,
    )
    .await
    .unwrap();
    let authority = snapshot(&mut client, "connect").await;
    (client, task, authority)
}

async fn challenge(
    directory: &Path,
    authority: NativeAuthoritySnapshot,
) -> (Arc<Runtime>, NativeImportChallenge) {
    let destination = configured(
        &directory.join(format!("{}.sqlite", bittery_crypto_core::generate_uuid())),
        Arc::new(Platform::default()),
        ClientPlatform::Extension,
    );
    destination.open().await.unwrap();
    let control = destination.native_authority();
    let channel = control
        .attach_desktop(authority, "fixture-consumer".into())
        .await
        .unwrap();
    let challenge = control
        .prepare_import_for_source(&channel, &ACCOUNT.into(), false)
        .await
        .unwrap();
    (destination, challenge)
}

fn assert_locked(authority: &NativeAuthoritySnapshot) {
    assert_eq!(authority.accounts.len(), 2);
    assert!(authority.accounts.iter().all(|account| !account.unlocked));
}

#[tokio::test]
async fn framed_biometric_retirement_suppresses_late_os_success_and_preserves_sibling() {
    for retirement in ["cancel", "disconnect", "lock"] {
        let directory = tempfile::tempdir().unwrap();
        let (entered, mut callbacks) = mpsc::unbounded_channel();
        let prompt = Arc::new(HeldOsPrompt {
            permit: Arc::new(Semaphore::new(1)),
            entered,
        });
        let native = source(directory.path(), prompt.clone()).await;
        let (mut first, first_task, authority) = connect(native.clone()).await;
        let (mut sibling, sibling_task, sibling_authority) = connect(native.clone()).await;
        assert_locked(&authority);
        let (destination, prepared) = challenge(directory.path(), authority).await;
        send(
            &mut first,
            "held-biometric",
            NativeRuntimeCommand::ExportWithBiometric {
                challenge: serde_json::to_string(&prepared).unwrap(),
                prompt_message: "Controlled native fixture".into(),
            },
        )
        .await;
        let callback = timeout(Duration::from_secs(5), callbacks.recv())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(prompt.permit.available_permits(), 0);
        let mut first = Some(first);
        match retirement {
            "cancel" => {
                send(
                    first.as_mut().unwrap(),
                    "cancel-held",
                    NativeRuntimeCommand::Cancel {
                        call_id: "held-biometric".into(),
                    },
                )
                .await;
                loop {
                    match message(first.as_mut().unwrap()).await {
                        NativeRuntimeMessage::Authority { .. } => {}
                        NativeRuntimeMessage::Cancelled { request_id } => {
                            assert_eq!(request_id, "cancel-held");
                            break;
                        }
                        _ => panic!("Cancel must not publish the held export"),
                    }
                }
            }
            "disconnect" => {
                drop(first.take());
            }
            "lock" => {
                native
                    .core
                    .request(
                        RuntimeRequest::Lock {
                            account_id: ACCOUNT.into(),
                        },
                        RequestCancellation::new(),
                    )
                    .await
                    .unwrap();
            }
            _ => unreachable!(),
        }
        timeout(Duration::from_secs(5), async {
            while !callback.cancellation.is_cancelled() {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        assert_eq!(
            prompt.permit.available_permits(),
            0,
            "requesting cancellation is not OS callback completion"
        );
        send(
            &mut sibling,
            "during-held-callback",
            NativeRuntimeCommand::Snapshot {},
        )
        .await;
        let current = snapshot(&mut sibling, "during-held-callback").await;
        assert_eq!(current.channel_id, sibling_authority.channel_id);
        assert_locked(&current);
        callback.release.send(()).unwrap();
        callback.finished.await.unwrap();
        timeout(Duration::from_secs(5), async {
            while prompt.permit.available_permits() == 0 {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        if let Some(client) = first.as_mut() {
            if retirement == "lock" {
                loop {
                    match message(client).await {
                        NativeRuntimeMessage::Authority { .. } => {}
                        NativeRuntimeMessage::Reply {
                            request_id, failed, ..
                        } => {
                            assert_eq!(request_id, "held-biometric");
                            assert!(failed);
                            break;
                        }
                        _ => panic!("Lock must refuse the retired export"),
                    }
                }
            }
            send(
                client,
                "after-late-success",
                NativeRuntimeCommand::Snapshot {},
            )
            .await;
            assert_locked(&snapshot(client, "after-late-success").await);
        }
        send(
            &mut sibling,
            "sibling-after-late-success",
            NativeRuntimeCommand::Snapshot {},
        )
        .await;
        assert_locked(&snapshot(&mut sibling, "sibling-after-late-success").await);
        let RuntimeProjection::RuntimeStatus(status) = super::tests::snapshot(
            &destination,
            ObservationRequest::RuntimeStatus { account_id: None },
        )
        .unwrap() else {
            panic!("Expected consumer status")
        };
        assert!(
            status.accounts.is_empty(),
            "retired prompt must not install its reserved consumer Account"
        );
        if retirement == "cancel" {
            send(
                &mut sibling,
                "fresh-authority",
                NativeRuntimeCommand::Snapshot {},
            )
            .await;
            let authority = snapshot(&mut sibling, "fresh-authority").await;
            let (fresh_destination, fresh_challenge) = challenge(directory.path(), authority).await;
            let destination_control = fresh_destination.native_authority();
            send(
                &mut sibling,
                "fresh-biometric",
                NativeRuntimeCommand::ExportWithBiometric {
                    challenge: serde_json::to_string(&fresh_challenge).unwrap(),
                    prompt_message: "Fresh explicit fixture gesture".into(),
                },
            )
            .await;
            let fresh_callback = timeout(Duration::from_secs(5), callbacks.recv())
                .await
                .unwrap()
                .unwrap();
            assert!(!fresh_callback.cancellation.is_cancelled());
            fresh_callback.release.send(()).unwrap();
            fresh_callback.finished.await.unwrap();
            let reply = loop {
                match message(&mut sibling).await {
                    NativeRuntimeMessage::Authority { .. } => {}
                    NativeRuntimeMessage::Reply {
                        request_id,
                        failed,
                        payload,
                    } => {
                        assert_eq!(request_id, "fresh-biometric");
                        assert!(!failed);
                        let NativeAuthorityResponse::Exported { reply } =
                            serde_json::from_str(&payload).unwrap()
                        else {
                            panic!("A fresh explicit completed prompt must export through the framed socket");
                        };
                        break reply;
                    }
                    _ => panic!("Expected fresh correlated biometric export"),
                }
            };
            send(
                &mut sibling,
                "after-fresh-export",
                NativeRuntimeCommand::Snapshot {},
            )
            .await;
            let current = snapshot(&mut sibling, "after-fresh-export").await;
            destination_control
                .apply_authority(&fresh_challenge.destination_channel, current.clone())
                .await
                .unwrap();
            destination_control.complete_import(reply).await.unwrap();
            let RuntimeProjection::RuntimeStatus(status) = super::tests::snapshot(
                &fresh_destination,
                ObservationRequest::RuntimeStatus { account_id: None },
            )
            .unwrap() else {
                panic!("Expected consumer status")
            };
            assert_eq!(status.accounts.len(), 1);
            assert_eq!(
                status.accounts[0].access,
                bittery_client_core::AccountAccessState::Unlocked
            );
            assert!(
                current
                    .accounts
                    .iter()
                    .find(|account| account.scope.account_id.as_str() == ACCOUNT)
                    .unwrap()
                    .unlocked
            );
            assert!(
                !current
                    .accounts
                    .iter()
                    .find(|account| account.scope.account_id.as_str() == OTHER)
                    .unwrap()
                    .unlocked
            );
            fresh_destination.close().await;
        }
        drop(first);
        drop(sibling);
        for task in [first_task, sibling_task] {
            let result = timeout(Duration::from_secs(5), task)
                .await
                .unwrap()
                .unwrap();
            // Linux may reset a closed socket with unread authority events, or its writer may
            // observe BrokenPipe. Neither permits a protocol error or surviving transport task.
            assert!(
                result.is_ok()
                    || result.as_ref().is_err_and(|error| matches!(
                        error.kind(),
                        std::io::ErrorKind::ConnectionReset | std::io::ErrorKind::BrokenPipe
                    )),
                "unexpected source-port shutdown result: {result:?}"
            );
        }
        destination.close().await;
        native.shutdown().await.unwrap();
    }
}
