//! First protocol1 compatibility tracer through the actual native host and Core socket owner.
//!
//! This is opt-in because it signs in one explicitly provisioned disposable Server Account. The
//! legacy host process and Runtime helper are copied beside one another so the production Unix
//! peer checks see their real executable basenames and installation directory.

use super::{tests, NativeRuntime};
use base64::{
    engine::general_purpose::{STANDARD as BASE64, URL_SAFE_NO_PAD as BASE64_URL},
    Engine,
};
use bittery_client_core::{
    AccountAccessState, AuthClientConfig, BiometricHardware, BiometricPort, BiometricPromptResult,
    ClientPlatform, CreateVaultType, ImportItemDraft, ItemDraft, LoginItemData, ObservationRequest,
    Passkey, PasskeyStatus, PasskeyStatusReason, PublicItemDraft, RequestCancellation,
    RuntimeError, RuntimeProjection, RuntimeRequest, RuntimeResponse, SecretString,
    VaultProjectionRole, VaultProjectionType,
};
use serde::{Deserialize, Serialize};
use std::{
    io::{self, Write},
    os::{
        fd::AsRawFd,
        unix::fs::{OpenOptionsExt, PermissionsExt},
    },
    path::Path,
    process::Stdio,
    sync::atomic::{AtomicUsize, Ordering},
    time::Duration,
};
use tokio::{
    io::AsyncReadExt,
    net::UnixListener,
    process::{Child, Command},
    time::timeout,
};
use zeroize::Zeroize;

const CHILD_DIRECTORY: &str = "BITTERY_NATIVE_LEGACY_CHILD_DIRECTORY";
const CREDENTIALS: &str = "BITTERY_NATIVE_LEGACY_CREDENTIALS";
const SNAPSHOT_TEST: &str = "runtime_host::native::legacy_acceptance::actual_protocol1_snapshot_reads_populated_native_core";
const SHARED_READ_ONLY_TEST: &str =
    "runtime_host::native::legacy_acceptance::actual_protocol1_shared_read_only_member_reaches_old_extension";
const SHARED_FIXTURE: &str = "BITTERY_NATIVE_LEGACY_SHARED_FIXTURE";
const SHARED_STAGE: &str = "BITTERY_NATIVE_LEGACY_SHARED_STAGE";
const VAULT_KEYS_TEST: &str =
    "runtime_host::native::legacy_acceptance::actual_protocol1_vault_keys_reach_old_extension";
const UNKNOWN_VAULT_KEYS_TEST: &str =
    "runtime_host::native::legacy_acceptance::actual_protocol1_vault_keys_refuse_unknown_account";
const ACCOUNTS_TEST: &str =
    "runtime_host::native::legacy_acceptance::actual_protocol1_accounts_reach_old_desktop_sync_consumer";
const STATUS_TEST: &str =
    "runtime_host::native::legacy_acceptance::actual_protocol1_status_reaches_old_desktop_client";
const AUTH_TOKEN_TEST: &str =
    "runtime_host::native::legacy_acceptance::actual_protocol1_auth_token_reaches_old_hydration_consumer";
const BIOMETRIC_TEST: &str =
    "runtime_host::native::legacy_acceptance::actual_protocol1_biometric_reaches_old_decoder";
const BIOMETRIC_ALL_TEST: &str =
    "runtime_host::native::legacy_acceptance::actual_protocol1_biometric_all_reaches_old_decoder";
const BIOMETRIC_STATUS_TEST: &str =
    "runtime_host::native::legacy_acceptance::actual_protocol1_biometric_status_reaches_old_client";
const BIOMETRIC_HELD_EOF_TEST: &str =
    "runtime_host::native::legacy_acceptance::actual_host_cancels_held_biometric_prompt_on_browser_eof";
const EVENT_TEST: &str =
    "runtime_host::native::legacy_acceptance::actual_protocol1_core_lock_retires_old_extension_transport";
const PACKAGED_BROWSER_TEST: &str =
    "runtime_host::native::legacy_acceptance::packaged_chromium_source_helper";
const BIOMETRIC_HELD_ENTERED: &str = "native-legacy-biometric-prompt-entered";
const BIOMETRIC_CHALLENGE: &str = "legacy-biometric-correlation-1";
const BIOMETRIC_ALL_CHALLENGE: &str = "legacy-biometric-all-correlation-1";
const VAULT_KEYS_REQUEST_ID: &str = "desktop-123456789-1";
const ACCOUNTS_REQUEST_ID: &str = "desktop-123456789-1";
const HELD_EOF_TEST: &str =
    "runtime_host::native::legacy_acceptance::actual_host_retires_held_source_on_browser_eof";
const HELD_STDOUT_TEST: &str =
    "runtime_host::native::legacy_acceptance::actual_host_retires_held_source_on_stdout_failure";
const HELPER_OUTCOME: &str = "native-legacy-helper-outcome";
const HELD_READY: &str = "native-legacy-held-ready";
const HELD_REQUEST: &str = "native-legacy-held-request";
const HELD_CLOSED: &str = "native-legacy-held-closed";
const FIXTURE_VAULT_NAME: &str = "Native legacy compatibility acceptance Vault";
const FIXTURE_ITEM_TITLE: &str = "Native legacy compatibility acceptance ES256 Login";
const FIXTURE_RICH_LOGIN_TITLE: &str = "Native legacy compatibility acceptance Rich Login";
const FIXTURE_SECURE_NOTE_TITLE: &str = "Native legacy compatibility acceptance Secure Note";
const FIXTURE_CREDIT_CARD_TITLE: &str = "Native legacy compatibility acceptance Credit Card";
const FIXTURE_IDENTITY_TITLE: &str = "Native legacy compatibility acceptance Identity";
const FIXTURE_TOTP_TITLE: &str = "Native legacy compatibility acceptance TOTP";
const FIXTURE_USERNAME: &str = "native-legacy-fixture-user";
const FIXTURE_PASSWORD: &str = "native-legacy-private-fixture-value";
const FIXTURE_RP_ID: &str = "native-legacy.invalid";
const FIXTURE_SIGN_COUNT: u32 = 7;
const FIXTURE_CHALLENGE: [u8; 32] = [73; 32];

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Credentials {
    server_url: String,
    email: SecretString,
    password: SecretString,
    secret_key: SecretString,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SeededAccount {
    account_id: String,
    vault_id: String,
    item_id: String,
    item_title: String,
    username: String,
    credential_id: String,
    public_key: String,
    rp_id: String,
    sign_count: u32,
    additional_items: Vec<SeededCategoryItem>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SeededCategoryItem {
    item_id: String,
    title: String,
    category: String,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SharedReadOnlyFixture {
    user_id: String,
    vault_id: String,
    vault_name: String,
    item_id: String,
    item_title: String,
    username: String,
    password: SecretString,
}

#[derive(Clone, Copy)]
enum ActualLegacyTrace {
    Snapshot,
    SharedReadOnly,
    VaultKeys,
    UnknownVaultKeys,
    Accounts,
    Status,
    AuthToken,
    Biometric,
    BiometricAll,
    BiometricStatus,
    BiometricHeldEof,
}

impl ActualLegacyTrace {
    fn test_name(self) -> &'static str {
        match self {
            Self::Snapshot => SNAPSHOT_TEST,
            Self::SharedReadOnly => SHARED_READ_ONLY_TEST,
            Self::VaultKeys => VAULT_KEYS_TEST,
            Self::UnknownVaultKeys => UNKNOWN_VAULT_KEYS_TEST,
            Self::Accounts => ACCOUNTS_TEST,
            Self::Status => STATUS_TEST,
            Self::AuthToken => AUTH_TOKEN_TEST,
            Self::Biometric => BIOMETRIC_TEST,
            Self::BiometricAll => BIOMETRIC_ALL_TEST,
            Self::BiometricStatus => BIOMETRIC_STATUS_TEST,
            Self::BiometricHeldEof => BIOMETRIC_HELD_EOF_TEST,
        }
    }

    fn request_id(self) -> &'static str {
        match self {
            Self::Snapshot => "legacy-snapshot-1",
            Self::SharedReadOnly => "legacy-shared-read-only-1",
            Self::VaultKeys => VAULT_KEYS_REQUEST_ID,
            Self::UnknownVaultKeys => "legacy-unknown-keys-1",
            Self::Accounts => ACCOUNTS_REQUEST_ID,
            Self::Status => "desktop-123456789-1",
            Self::AuthToken => "desktop-123456789-1",
            Self::Biometric => "legacy-biometric-1",
            Self::BiometricAll => "legacy-biometric-all-1",
            Self::BiometricStatus => "desktop-123456789-1",
            Self::BiometricHeldEof => "legacy-biometric-held-1",
        }
    }

    fn request(self, seeded: &SeededAccount) -> crate::desktop_ipc::DesktopRequest {
        match self {
            Self::Snapshot | Self::SharedReadOnly => {
                crate::desktop_ipc::DesktopRequest::GetDesktopItemsSnapshot {
                    account_ids: Some(vec![seeded.account_id.clone()]),
                }
            }
            Self::VaultKeys => crate::desktop_ipc::DesktopRequest::GetDesktopVaultKeys {
                account_id: seeded.account_id.clone(),
            },
            Self::UnknownVaultKeys => crate::desktop_ipc::DesktopRequest::GetDesktopVaultKeys {
                account_id: format!("{}-unknown", seeded.account_id),
            },
            Self::Accounts => crate::desktop_ipc::DesktopRequest::GetDesktopAccounts,
            Self::Status => crate::desktop_ipc::DesktopRequest::GetDesktopStatus,
            Self::AuthToken => crate::desktop_ipc::DesktopRequest::GetDesktopAuthToken {
                account_id: seeded.account_id.clone(),
            },
            Self::Biometric | Self::BiometricHeldEof => {
                crate::desktop_ipc::DesktopRequest::BiometricUnlockRequest {
                    challenge: BIOMETRIC_CHALLENGE.into(),
                    extension_id: crate::native_messaging_installer::allowed_extension_origins()
                        .into_iter()
                        .next()
                        .and_then(|origin| {
                            crate::native_messaging_installer::extension_id_for_origin(&origin)
                        })
                        .expect("fixture has a validated Extension origin"),
                    account_id: Some(seeded.account_id.clone()),
                }
            }
            Self::BiometricAll => crate::desktop_ipc::DesktopRequest::BiometricUnlockAllRequest {
                challenge: BIOMETRIC_ALL_CHALLENGE.into(),
                extension_id: crate::native_messaging_installer::allowed_extension_origins()
                    .into_iter()
                    .next()
                    .and_then(|origin| {
                        crate::native_messaging_installer::extension_id_for_origin(&origin)
                    })
                    .expect("fixture has a validated Extension origin"),
            },
            Self::BiometricStatus => crate::desktop_ipc::DesktopRequest::CheckBiometricAvailable,
        }
    }
}

struct ControlledBiometricPrimitive {
    prompts: std::sync::Arc<AtomicUsize>,
    held_marker: Option<std::path::PathBuf>,
}

#[async_trait::async_trait]
impl BiometricPort for ControlledBiometricPrimitive {
    async fn hardware(&self) -> Result<BiometricHardware, RuntimeError> {
        Ok(BiometricHardware {
            has_hardware: true,
            is_enrolled: true,
            kind: Some(bittery_client_core::BiometricKind::Fingerprint),
        })
    }

    async fn authenticate(
        &self,
        _: &str,
        cancellation: RequestCancellation,
    ) -> BiometricPromptResult {
        self.prompts.fetch_add(1, Ordering::SeqCst);
        if let Some(marker) = &self.held_marker {
            if write_private(marker.clone(), b"entered").is_err() {
                return BiometricPromptResult::Failed;
            }
            cancellation.cancelled().await;
            return BiometricPromptResult::Cancelled;
        }
        BiometricPromptResult::Authenticated
    }
}

#[tokio::test]
#[ignore = "Requires one freshly provisioned real Server Account and the actual native host binary"]
async fn actual_protocol1_snapshot_reads_populated_native_core(
) -> Result<(), Box<dyn std::error::Error>> {
    if let Some(directory) = std::env::var_os(CHILD_DIRECTORY) {
        return runtime_helper(Path::new(&directory)).await;
    }
    run_actual_host(ActualLegacyTrace::Snapshot).await
}

/// The stage is `unshared` before the public Vault grant and `read-only` after it.
/// Both runs sign in the same disposable recipient and use Server-synced authority.
#[tokio::test]
#[ignore = "Requires a fresh public Team/Member fixture and the actual feature-enabled native host"]
async fn actual_protocol1_shared_read_only_member_reaches_old_extension(
) -> Result<(), Box<dyn std::error::Error>> {
    if let Some(directory) = std::env::var_os(CHILD_DIRECTORY) {
        return runtime_helper(Path::new(&directory)).await;
    }
    run_actual_host(ActualLegacyTrace::SharedReadOnly).await
}

#[tokio::test]
#[ignore = "Requires one freshly provisioned real Server Account and the actual native host binary"]
async fn actual_protocol1_vault_keys_reach_old_extension() -> Result<(), Box<dyn std::error::Error>>
{
    if let Some(directory) = std::env::var_os(CHILD_DIRECTORY) {
        return runtime_helper(Path::new(&directory)).await;
    }
    run_actual_host(ActualLegacyTrace::VaultKeys).await
}

#[tokio::test]
#[ignore = "Requires one freshly provisioned real Server Account and the actual native host binary"]
async fn actual_protocol1_auth_token_reaches_old_hydration_consumer(
) -> Result<(), Box<dyn std::error::Error>> {
    if let Some(directory) = std::env::var_os(CHILD_DIRECTORY) {
        return runtime_helper(Path::new(&directory)).await;
    }
    run_actual_host(ActualLegacyTrace::AuthToken).await
}

#[tokio::test]
#[ignore = "Requires a populated real Account and a controlled biometric primitive; not OS hardware acceptance"]
async fn actual_protocol1_biometric_reaches_old_decoder() -> Result<(), Box<dyn std::error::Error>>
{
    if let Some(directory) = std::env::var_os(CHILD_DIRECTORY) {
        return runtime_helper(Path::new(&directory)).await;
    }
    run_actual_host(ActualLegacyTrace::Biometric).await
}

#[tokio::test]
#[ignore = "Requires a populated real Account and a controlled biometric primitive; not OS hardware acceptance"]
async fn actual_protocol1_biometric_all_reaches_old_decoder(
) -> Result<(), Box<dyn std::error::Error>> {
    if let Some(directory) = std::env::var_os(CHILD_DIRECTORY) {
        return runtime_helper(Path::new(&directory)).await;
    }
    run_actual_host(ActualLegacyTrace::BiometricAll).await
}

#[tokio::test]
#[ignore = "Requires a populated real Account and a controlled biometric primitive; not OS hardware acceptance"]
async fn actual_protocol1_biometric_status_reaches_old_client(
) -> Result<(), Box<dyn std::error::Error>> {
    if let Some(directory) = std::env::var_os(CHILD_DIRECTORY) {
        return runtime_helper(Path::new(&directory)).await;
    }
    run_actual_host(ActualLegacyTrace::BiometricStatus).await
}

#[tokio::test]
#[ignore = "Requires a populated real Account, actual host and controlled held primitive; not OS hardware acceptance"]
async fn actual_host_cancels_held_biometric_prompt_on_browser_eof(
) -> Result<(), Box<dyn std::error::Error>> {
    if let Some(directory) = std::env::var_os(CHILD_DIRECTORY) {
        return runtime_helper(Path::new(&directory)).await;
    }
    run_actual_host(ActualLegacyTrace::BiometricHeldEof).await
}

#[tokio::test]
#[ignore = "Requires one freshly provisioned real Server Account and the actual native host binary"]
async fn actual_protocol1_vault_keys_refuse_unknown_account(
) -> Result<(), Box<dyn std::error::Error>> {
    if let Some(directory) = std::env::var_os(CHILD_DIRECTORY) {
        return runtime_helper(Path::new(&directory)).await;
    }
    run_actual_host(ActualLegacyTrace::UnknownVaultKeys).await
}

#[tokio::test]
#[ignore = "Requires one freshly provisioned real Server Account and the actual native host binary"]
async fn actual_protocol1_accounts_reach_old_desktop_sync_consumer(
) -> Result<(), Box<dyn std::error::Error>> {
    if let Some(directory) = std::env::var_os(CHILD_DIRECTORY) {
        return runtime_helper(Path::new(&directory)).await;
    }
    run_actual_host(ActualLegacyTrace::Accounts).await
}

#[tokio::test]
#[ignore = "Requires one freshly provisioned real Server Account and the actual native host binary"]
async fn actual_protocol1_status_reaches_old_desktop_client(
) -> Result<(), Box<dyn std::error::Error>> {
    if let Some(directory) = std::env::var_os(CHILD_DIRECTORY) {
        return runtime_helper(Path::new(&directory)).await;
    }
    run_actual_host(ActualLegacyTrace::Status).await
}

#[tokio::test]
#[ignore = "Requires a populated real Account and the actual feature-enabled native host"]
async fn actual_protocol1_core_lock_retires_old_extension_transport(
) -> Result<(), Box<dyn std::error::Error>> {
    if let Some(directory) = std::env::var_os(CHILD_DIRECTORY) {
        return runtime_helper(Path::new(&directory)).await;
    }
    run_event_host().await
}

/// Serves the real packaged Chromium/native-host fixture. The browser runner owns the profile,
/// native manifest and process; this helper owns only its populated Core, existing socket and
/// explicit Lock/stop markers. No production listener or alternate secret source is installed.
#[tokio::test]
#[ignore = "Requires a disposable packaged Chromium profile and the real native host"]
async fn packaged_chromium_source_helper() -> Result<(), Box<dyn std::error::Error>> {
    let directory = std::env::var_os(CHILD_DIRECTORY)
        .ok_or("BITTERY_NATIVE_LEGACY_CHILD_DIRECTORY must name the private browser fixture")?;
    packaged_browser_source(Path::new(&directory)).await
}

async fn packaged_browser_source(directory: &Path) -> Result<(), Box<dyn std::error::Error>> {
    let credentials: Credentials = tests::read_acceptance_credentials(CREDENTIALS)?;
    let native = std::sync::Arc::new(
        NativeRuntime::open(
            directory.join("runtime"),
            AuthClientConfig::new(
                "native-legacy-packaged-browser".into(),
                ClientPlatform::Desktop,
                "test".into(),
            )?,
        )
        .await?,
    );
    let mut connections = 0usize;
    let biometric_prompts = std::sync::Arc::new(AtomicUsize::new(0));
    let run = async {
        let account_id = tests::sign_in_acceptance_account(
            &native,
            &credentials.server_url,
            &credentials.email,
            &credentials.password,
            &credentials.secret_key,
        )
        .await?;
        tests::check_access(&native, &account_id, AccountAccessState::Unlocked)?;
        let seeded = seed_or_reuse_fixture(&native, &account_id).await?;
        native
            .core
            .install_biometric_port(std::sync::Arc::new(ControlledBiometricPrimitive {
                prompts: biometric_prompts.clone(),
                held_marker: None,
            }));
        native
            .core
            .request(
                RuntimeRequest::SetBiometricEnabled {
                    account_id: account_id.clone(),
                    enabled: true,
                },
                RequestCancellation::new(),
            )
            .await?;
        let socket = crate::ipc_security::prepare_desktop_ipc_socket_path()?;
        let listener = UnixListener::bind(socket)?;
        write_private(
            directory.join("native-legacy-seeded-account.json"),
            &serde_json::to_vec(&seeded)?,
        )?;
        write_private(directory.join("native-legacy-ready"), b"ready")?;
        let mut tasks = tokio::task::JoinSet::new();
        let mut locked = false;
        timeout(Duration::from_secs(300), async {
            loop {
                tokio::select! {
                    accepted = listener.accept() => {
                        let (stream, _) = accepted?;
                        crate::ipc_security::authorize_unix_peer(
                            stream.as_raw_fd(),
                            crate::ipc_security::PeerRole::NativeHost,
                            crate::ipc_security::PeerPolicy::Required,
                        ).map_err(io::Error::other)?;
                        connections += 1;
                        let native = native.clone();
                        tasks.spawn(async move {
                            crate::runtime_host::native_source_transport::serve(native, stream).await
                        });
                    }
                    _ = tokio::time::sleep(Duration::from_millis(20)) => {
                        if !locked && directory.join("native-legacy-browser-lock").exists() {
                            native.core.request(
                                RuntimeRequest::Lock { account_id: account_id.clone() },
                                RequestCancellation::new(),
                            ).await?;
                            locked = true;
                            write_private(directory.join("native-legacy-browser-locked"), b"locked")?;
                        }
                        if directory.join("native-legacy-browser-stop").exists() {
                            break Ok::<(), Box<dyn std::error::Error>>(());
                        }
                    }
                }
            }
        }).await??;
        tasks.abort_all();
        while tasks.join_next().await.is_some() {}
        Ok::<(), Box<dyn std::error::Error>>(())
    }.await;
    let cleanup = tests::cleanup_acceptance_account(&native).await;
    let shutdown = native.shutdown().await;
    let outcome = format!(
        "run={}; connections={connections}; biometric_prompts={}; cleanup={}; shutdown={}",
        if run.is_ok() { "complete" } else { "failed" },
        biometric_prompts.load(Ordering::SeqCst),
        if cleanup.is_ok() {
            "complete"
        } else {
            "failed"
        },
        if shutdown.is_ok() {
            "complete"
        } else {
            "failed"
        },
    );
    write_private(
        directory.join("native-legacy-browser-outcome"),
        outcome.as_bytes(),
    )?;
    run?;
    cleanup.map_err(io::Error::other)?;
    shutdown?;
    Ok(())
}

#[tokio::test]
#[ignore = "Requires the actual feature-enabled native host binary"]
async fn actual_host_retires_held_source_on_browser_eof() -> Result<(), Box<dyn std::error::Error>>
{
    if let Some(directory) = std::env::var_os(CHILD_DIRECTORY) {
        return held_socket_helper(Path::new(&directory)).await;
    }
    run_held_host(HELD_EOF_TEST, false).await
}

#[cfg(unix)]
#[tokio::test]
#[ignore = "Requires the actual feature-enabled native host binary"]
async fn actual_host_retires_held_source_on_stdout_failure(
) -> Result<(), Box<dyn std::error::Error>> {
    if let Some(directory) = std::env::var_os(CHILD_DIRECTORY) {
        return held_socket_helper(Path::new(&directory)).await;
    }
    run_held_host(HELD_STDOUT_TEST, true).await
}

async fn run_held_host(
    helper_test: &str,
    close_stdout: bool,
) -> Result<(), Box<dyn std::error::Error>> {
    let binary = std::env::var_os("BITTERY_NATIVE_HOST_ACCEPTANCE_BINARY").ok_or(
        "BITTERY_NATIVE_HOST_ACCEPTANCE_BINARY must name the actual native host executable",
    )?;
    let directory = tempfile::Builder::new()
        .prefix("b97-held-")
        .tempdir_in("/tmp")?;
    std::fs::set_permissions(directory.path(), std::fs::Permissions::from_mode(0o700))?;
    let runtime_path = directory.path().join("Bittery");
    let host_path = directory.path().join("bittery-native-host");
    std::fs::copy(std::env::current_exe()?, &runtime_path)?;
    std::fs::copy(binary, &host_path)?;

    let mut helper = Command::new(&runtime_path)
        .args(["--exact", helper_test, "--ignored", "--test-threads=1"])
        .env(CHILD_DIRECTORY, directory.path())
        .env("XDG_RUNTIME_DIR", directory.path())
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .spawn()?;
    let mut host: Option<Child> = None;
    let attempt = async {
        wait_for_file(&mut helper, &directory.path().join(HELD_READY)).await?;
        let origin = crate::native_messaging_installer::allowed_extension_origins()
            .into_iter()
            .next()
            .ok_or("Native messaging host has no allowed extension origin")?;
        let child = Command::new(&host_path)
            .arg(origin)
            .env("XDG_RUNTIME_DIR", directory.path())
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true)
            .spawn()?;
        host = Some(child);
        let child = host.as_mut().unwrap();
        crate::desktop_ipc::write_frame(
            child
                .stdin
                .as_mut()
                .ok_or("Native host stdin was not piped")?,
            &crate::desktop_ipc::DesktopEnvelope::current(
                Some("held-snapshot".to_owned()),
                crate::desktop_ipc::DesktopRequest::GetDesktopItemsSnapshot {
                    account_ids: Some(vec!["held-account".to_owned()]),
                },
            ),
        )
        .await?;
        wait_for_file(&mut helper, &directory.path().join(HELD_REQUEST)).await?;
        // The authenticated Desktop socket is withholding its reply. Browser port loss must
        // retire that in-flight read without waiting for Core or emitting a response.
        if close_stdout {
            drop(child.stdout.take());
        } else {
            drop(child.stdin.take());
        }
        let status = timeout(Duration::from_secs(10), child.wait()).await??;
        if !status.success() {
            return Err("Native host failed after browser port loss".into());
        }
        if let Some(stdout) = child.stdout.as_mut() {
            let mut output = Vec::new();
            stdout.read_to_end(&mut output).await?;
            if !output.is_empty() {
                output.zeroize();
                return Err("Native host emitted a reply after browser port loss".into());
            }
        }
        wait_for_file(&mut helper, &directory.path().join(HELD_CLOSED)).await?;
        if !timeout(Duration::from_secs(10), helper.wait())
            .await??
            .success()
        {
            return Err("Held Desktop socket helper failed after browser port loss".into());
        }
        Ok::<(), Box<dyn std::error::Error>>(())
    }
    .await;
    if let Some(child) = host.as_mut() {
        if child.try_wait()?.is_none() {
            let _ = child.kill().await;
            let _ = child.wait().await;
        }
    }
    if helper.try_wait()?.is_none() {
        let _ = helper.kill().await;
        let _ = helper.wait().await;
    }
    attempt
}

async fn held_socket_helper(directory: &Path) -> Result<(), Box<dyn std::error::Error>> {
    let socket = crate::ipc_security::prepare_desktop_ipc_socket_path()?;
    let listener = UnixListener::bind(socket)?;
    write_private(directory.join(HELD_READY), b"ready")?;
    let (mut stream, _) = timeout(Duration::from_secs(30), listener.accept()).await??;
    crate::ipc_security::authorize_unix_peer(
        stream.as_raw_fd(),
        crate::ipc_security::PeerRole::NativeHost,
        crate::ipc_security::PeerPolicy::Required,
    )
    .map_err(io::Error::other)?;
    let handshake: serde_json::Value = timeout(
        Duration::from_secs(10),
        crate::desktop_ipc::read_frame(&mut stream),
    )
    .await??;
    if handshake["mode"] != "legacySource"
        || handshake["request"]["type"] != "GET_DESKTOP_ITEMS_SNAPSHOT"
        || handshake["request"]["requestId"] != "held-snapshot"
    {
        return Err("Held Desktop socket did not receive the closed legacy handshake".into());
    }
    write_private(directory.join(HELD_REQUEST), b"held")?;
    let mut byte = [0u8; 1];
    if timeout(Duration::from_secs(10), stream.read(&mut byte)).await?? != 0 {
        return Err("Held Desktop socket received data after browser EOF".into());
    }
    write_private(directory.join(HELD_CLOSED), b"closed")?;
    Ok(())
}

async fn runtime_helper(directory: &Path) -> Result<(), Box<dyn std::error::Error>> {
    let credentials: Credentials = tests::read_acceptance_credentials(CREDENTIALS)?;
    let native = std::sync::Arc::new(
        NativeRuntime::open(
            directory.join("runtime"),
            AuthClientConfig::new(
                "native-legacy-acceptance".into(),
                ClientPlatform::Desktop,
                "test".into(),
            )?,
        )
        .await?,
    );

    let mut listener_result = "not-started";
    let prompts = std::sync::Arc::new(AtomicUsize::new(0));
    let setup_result = async {
        let account_id = if std::env::var_os(SHARED_STAGE).is_some() {
            sign_in_shared_read_only_recipient(&native, &credentials).await?
        } else {
            tests::sign_in_acceptance_account(
                &native,
                &credentials.server_url,
                &credentials.email,
                &credentials.password,
                &credentials.secret_key,
            )
            .await?
        };
        tests::check_access(&native, &account_id, AccountAccessState::Unlocked)?;
        let seeded = if std::env::var_os(SHARED_STAGE).is_some() {
            prepare_shared_read_only_fixture(&native, &account_id).await?
        } else {
            seed_or_reuse_fixture(&native, &account_id).await?
        };
        if std::env::var_os("BITTERY_NATIVE_LEGACY_BIOMETRIC_TRACE").is_some() {
            native
                .core
                .install_biometric_port(std::sync::Arc::new(ControlledBiometricPrimitive {
                    prompts: prompts.clone(),
                    held_marker: std::env::var_os("BITTERY_NATIVE_LEGACY_HELD_BIOMETRIC_TRACE")
                        .map(|directory| Path::new(&directory).join(BIOMETRIC_HELD_ENTERED)),
                }));
            native
                .core
                .request(
                    RuntimeRequest::SetBiometricEnabled {
                        account_id: account_id.clone(),
                        enabled: true,
                    },
                    RequestCancellation::new(),
                )
                .await
                .map_err(|_| "Cannot enable controlled Core biometric preference".to_owned())?;
            native
                .core
                .request(
                    RuntimeRequest::Lock {
                        account_id: account_id.clone(),
                    },
                    RequestCancellation::new(),
                )
                .await
                .map_err(|_| "Cannot lock controlled Core biometric Account".to_owned())?;
            tests::check_access(&native, &account_id, AccountAccessState::Locked)?;
        }
        Ok::<_, String>(seeded)
    }
    .await;

    let served = if let Ok(seeded) = &setup_result {
        match serve_actual_host_connections(&native, directory, seeded).await {
            Ok(result) => {
                listener_result = result;
                Ok(())
            }
            Err(error) => Err(error),
        }
    } else {
        Ok(())
    };

    // Always run scoped local teardown after setup or listener failure. The Web registration
    // harness owns the separate exact Server Account deletion after this helper exits.
    let local_cleanup = tests::cleanup_acceptance_account(&native).await;
    let shutdown = native.shutdown().await;
    let outcome = format!(
        "setup={}; listener={listener_result}; local_cleanup={}; shutdown={}; biometric_prompts={}",
        if setup_result.is_ok() {
            "complete"
        } else {
            "failed"
        },
        if local_cleanup.is_ok() {
            "complete"
        } else {
            "failed"
        },
        if shutdown.is_ok() {
            "complete"
        } else {
            "failed"
        },
        prompts.load(Ordering::SeqCst),
    );
    write_private(directory.join(HELPER_OUTCOME), outcome.as_bytes())?;

    setup_result.map_err(io::Error::other)?;
    served?;
    local_cleanup.map_err(io::Error::other)?;
    shutdown?;
    Ok(())
}

async fn sign_in_shared_read_only_recipient(
    native: &NativeRuntime,
    credentials: &Credentials,
) -> Result<bittery_client_core::AccountId, String> {
    let path = std::env::var_os(SHARED_FIXTURE)
        .ok_or("Shared read-only acceptance needs its protected fixture file")?;
    let fixture: SharedReadOnlyFixture = serde_json::from_slice(
        &std::fs::read(path).map_err(|_| "Cannot read shared read-only fixture")?,
    )
    .map_err(|_| "Shared read-only fixture schema changed")?;
    let response = tests::acceptance_request(
        &native.core,
        RuntimeRequest::SignIn {
            server_url: credentials.server_url.clone(),
            email: credentials.email.as_ref().to_owned(),
            master_password: credentials.password.as_ref().to_owned(),
            secret_key: credentials.secret_key.as_ref().to_owned(),
            insecure_transport_confirmed: true,
        },
    )
    .await
    .map_err(|error| format!("Shared recipient sign-in: {error}"))?;
    let RuntimeResponse::SignedIn {
        account_id,
        user_id,
    } = response
    else {
        return Err("Shared recipient sign-in did not install a native Account".into());
    };
    if user_id != fixture.user_id {
        return Err("Native sign-in User differs from the invited Server Member".into());
    }
    Ok(account_id)
}

async fn prepare_shared_read_only_fixture(
    native: &NativeRuntime,
    account_id: &bittery_client_core::AccountId,
) -> Result<SeededAccount, String> {
    let path = std::env::var_os(SHARED_FIXTURE)
        .ok_or("Shared read-only acceptance needs its protected fixture file")?;
    let fixture: SharedReadOnlyFixture = serde_json::from_slice(
        &std::fs::read(path).map_err(|_| "Cannot read shared read-only fixture")?,
    )
    .map_err(|_| "Shared read-only fixture schema changed")?;
    let stage = std::env::var(SHARED_STAGE).map_err(|_| "Shared stage is missing")?;
    if stage != "unshared" && stage != "read-only" {
        return Err("Shared stage must be unshared or read-only".into());
    }
    timeout(Duration::from_secs(45), async {
        loop {
            if let Some(items) = tests::sample_acceptance_items(
                native,
                account_id,
                "Shared read-only Server authority wait",
            )? {
                let target = items.items.iter().filter(|item| item.item_id == fixture.item_id).collect::<Vec<_>>();
                let vault = items.vaults.iter().filter(|vault| vault.vault_id == fixture.vault_id).collect::<Vec<_>>();
                if stage == "unshared" {
                    if !target.is_empty() || !vault.is_empty() {
                        return Err("Unshared recipient received target Vault/Item authority".into());
                    }
                    return Ok::<(), String>(());
                }
                if let ([item], [vault]) = (target.as_slice(), vault.as_slice()) {
                    if item.account_id != *account_id
                        || item.vault_id != fixture.vault_id
                        || item.data.title() != fixture.item_title
                        || item.status != bittery_client_core::ItemProjectionStatus::Authoritative
                        || vault.name != fixture.vault_name
                        || vault.vault_type != VaultProjectionType::Team
                        || vault.icon.as_deref() != Some("lock")
                        || vault.role != VaultProjectionRole::ReadOnly
                    {
                        return Err("Server-synced recipient Item/Vault is not exact current ReadOnly authority".into());
                    }
                    return Ok(());
                }
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    })
    .await
    .map_err(|_| "Server-synced ReadOnly recipient did not converge".to_owned())??;
    Ok(SeededAccount {
        account_id: account_id.as_str().to_owned(),
        vault_id: fixture.vault_id,
        item_id: fixture.item_id,
        item_title: fixture.item_title,
        username: fixture.username,
        credential_id: String::new(),
        public_key: String::new(),
        rp_id: String::new(),
        sign_count: 0,
        additional_items: Vec::new(),
    })
}

async fn seed_or_reuse_fixture(
    native: &NativeRuntime,
    account_id: &bittery_client_core::AccountId,
) -> Result<SeededAccount, String> {
    // The dedicated public test Account survives the baseline RED and its later green reruns.
    // Use exact stable names, and refuse ambiguity, so retries reuse one authoritative remote
    // Vault/Login instead of leaving a trail of Server fixtures behind.
    let mut items = wait_for_authoritative_items(native, account_id).await?;
    let mut vault_id = unique_fixture_vault(&items)?;
    if let Some(item) = unique_fixture_item(&items)? {
        let login =
            validate_existing_fixture(native, account_id, vault_id.as_deref(), item).await?;
        return complete_fixture_categories(native, account_id, login).await;
    }

    if vault_id.is_none() {
        let RuntimeResponse::VaultCreationAccepted {
            vault_id: created_vault,
            ..
        } = tests::acceptance_request(
            &native.core,
            RuntimeRequest::CreateVault {
                account_id: account_id.clone(),
                name: FIXTURE_VAULT_NAME.to_owned(),
                vault_type: CreateVaultType::Personal,
                icon: "folder".into(),
                image_source: None,
            },
        )
        .await?
        else {
            return Err("Real Runtime did not accept the native compatibility Vault".into());
        };
        wait_for_vault(native, account_id, &created_vault).await?;
        vault_id = Some(created_vault);
    }

    // Re-sample after Vault creation to catch a fixture that finished syncing during setup.
    // A second exact-match check prevents accidental duplicate fixture rows under that race.
    items = wait_for_authoritative_items(native, account_id).await?;
    if let Some(item) = unique_fixture_item(&items)? {
        let login =
            validate_existing_fixture(native, account_id, vault_id.as_deref(), item).await?;
        return complete_fixture_categories(native, account_id, login).await;
    }

    let target_vault = vault_id.ok_or("Fixture Vault setup did not produce an exact Vault")?;
    let pair = bittery_crypto_core::generate_passkey_keypair()
        .map_err(|_| "Cannot generate native compatibility ES256 credential")?;
    let credential_id = BASE64_URL.encode(bittery_crypto_core::generate_credential_id());
    let passkey = Passkey {
        credential_id,
        rp_id: FIXTURE_RP_ID.into(),
        rp_name: "Native legacy compatibility acceptance".into(),
        user_handle: BASE64_URL.encode(account_id.as_str().as_bytes()),
        user_name: FIXTURE_USERNAME.into(),
        user_display_name: "Native legacy fixture user".into(),
        private_key: BASE64.encode(pair.private_key),
        public_key: BASE64.encode(&pair.public_key_cose),
        algorithm: -7,
        sign_count: FIXTURE_SIGN_COUNT,
        transports: vec!["internal".into(), "hybrid".into()],
        created_at: "2026-09-23T00:00:00.000Z".into(),
        last_used_at: None,
        status: Some(PasskeyStatus::Active),
        status_reason: None,
        status_updated_at: None,
    };
    drop(pair);
    let draft = ItemDraft::Login(LoginItemData {
        title: FIXTURE_ITEM_TITLE.into(),
        url: Some("https://native-legacy.invalid".into()),
        urls: Vec::new(),
        username: Some(FIXTURE_USERNAME.into()),
        password: Some(FIXTURE_PASSWORD.into()),
        password_history: Vec::new(),
        passkeys: vec![passkey],
        notes: None,
        note: None,
        custom_fields: Vec::new(),
        tags: Vec::new(),
        totp_secret: None,
        totp_issuer: None,
        totp_account_name: None,
        totp_algorithm: None,
        totp_digits: None,
        totp_period: None,
    });
    let RuntimeResponse::ImportBatchAccepted {
        operation_id,
        vault_id: imported_vault,
        item_ids,
        ..
    } = tests::acceptance_request(
        &native.core,
        RuntimeRequest::ImportItems {
            account_id: account_id.clone(),
            vault_id: target_vault.clone(),
            items: vec![ImportItemDraft {
                draft,
                favorite: false,
            }],
        },
    )
    .await?
    else {
        return Err("Real Runtime did not accept the native compatibility ES256 Login".into());
    };
    if imported_vault != target_vault || item_ids.len() != 1 {
        return Err("Real Runtime changed the exact imported fixture Vault or Item count".into());
    }
    tests::wait_for_acceptance_item(native, account_id, FIXTURE_ITEM_TITLE).await?;
    wait_for_import_applied(native, account_id, &operation_id).await?;
    items = wait_for_authoritative_items(native, account_id).await?;
    let item = unique_fixture_item(&items)?
        .ok_or("Core omitted the exact accepted native compatibility ES256 Login")?;
    let login = validate_existing_fixture(native, account_id, Some(&target_vault), item).await?;
    complete_fixture_categories(native, account_id, login).await
}

fn category_fixture_definitions() -> [(&'static str, &'static str); 5] {
    [
        (
            FIXTURE_RICH_LOGIN_TITLE,
            r#"{"category":"login","data":{"title":"Native legacy compatibility acceptance Rich Login","url":"https://rich.native-legacy.invalid","urls":["https://rich.native-legacy.invalid","https://second.native-legacy.invalid"],"username":"rich-fixture-user","password":"rich-login-password-canary","passwordHistory":[{"password":"prior-password-canary","changedAt":"2026-09-22T00:00:00Z"}],"notes":"rich-login-notes-canary","note":"rich-login-note-canary","customFields":[{"id":"login-field","label":"Login field","value":"login-field-canary","type":"password"}],"tags":["login-tag"],"totpSecret":"login-totp-canary","totpIssuer":"Login issuer","totpAccountName":"Login account","totpAlgorithm":"SHA256","totpDigits":8,"totpPeriod":45}}"#,
        ),
        (
            FIXTURE_SECURE_NOTE_TITLE,
            r#"{"category":"secure-note","data":{"title":"Native legacy compatibility acceptance Secure Note","note":"secure-note-canary","notes":"secure-note-optional-notes","customFields":[{"id":"note-field","label":"Note field","value":"note-field-canary","type":"password"}],"tags":["note-tag"]}}"#,
        ),
        (
            FIXTURE_CREDIT_CARD_TITLE,
            r#"{"category":"credit-card","data":{"title":"Native legacy compatibility acceptance Credit Card","cardholderName":"Card Holder","cardNumber":"4111111111111111","cvv":"731","expiryDate":"12/35","billingAddress":"Card billing address","notes":"credit-card-notes-canary","customFields":[{"id":"card-field","label":"Card field","value":"card-field-canary","type":"password"}],"totpSecret":"card-totp-canary","totpIssuer":"Card issuer","totpAccountName":"Card account","totpAlgorithm":"SHA256","totpDigits":8,"totpPeriod":45,"tags":["card-tag"]}}"#,
        ),
        (
            FIXTURE_IDENTITY_TITLE,
            r#"{"category":"identity","data":{"title":"Native legacy compatibility acceptance Identity","firstName":"Ada","middleName":"M","lastName":"Lovelace","email":"ada@native-legacy.invalid","addresses":[{"id":"address-1","street":"Identity street","city":"Identity city","state":"Identity state","zip":"12345","country":"Identity country"}],"phoneNumbers":[{"id":"phone-1","label":"mobile","number":"+10000000000"}],"ssn":"identity-ssn-canary","passportNumber":"identity-passport-canary","driversLicense":"identity-license-canary","dateOfBirth":"1815-12-10","notes":"identity-notes-canary","customFields":[{"id":"identity-field","label":"Identity field","value":"identity-field-canary","type":"password"}],"totpSecret":"identity-totp-canary","totpIssuer":"Identity issuer","totpAccountName":"Identity account","totpAlgorithm":"SHA1","totpDigits":6,"totpPeriod":30,"tags":["identity-tag"]}}"#,
        ),
        (
            FIXTURE_TOTP_TITLE,
            r#"{"category":"authenticator","data":{"title":"Native legacy compatibility acceptance TOTP","totpSecret":"authenticator-totp-canary","totpIssuer":"Authenticator issuer","totpAccountName":"Authenticator account","totpAlgorithm":"SHA512","totpDigits":7,"totpPeriod":60,"notes":"authenticator-notes-canary","customFields":[{"id":"authenticator-field","label":"Authenticator field","value":"authenticator-field-canary","type":"password"}],"tags":["authenticator-tag"]}}"#,
        ),
    ]
}

fn construct_category_fixture_draft(
    title: &str,
    raw: &str,
    login_id: &str,
) -> Result<ItemDraft, String> {
    let mut draft: ItemDraft = serde_json::from_str(raw)
        .map_err(|_| "Cannot construct an exact private category fixture".to_owned())?;
    if let ItemDraft::Authenticator(authenticator) = &mut draft {
        authenticator.linked_item_id = Some(login_id.to_owned());
    }
    if title == FIXTURE_RICH_LOGIN_TITLE {
        let ItemDraft::Login(login) = &mut draft else {
            return Err("Rich Login fixture changed category".into());
        };
        let pair = bittery_crypto_core::generate_passkey_keypair()
            .map_err(|_| "Cannot generate rich Login ES256 credential")?;
        login.passkeys.push(Passkey {
            credential_id: BASE64_URL.encode(bittery_crypto_core::generate_credential_id()),
            rp_id: "rich.native-legacy.invalid".into(),
            rp_name: "Native rich Login fixture".into(),
            user_handle: BASE64_URL.encode(login_id.as_bytes()),
            user_name: "rich-fixture-user".into(),
            user_display_name: "Rich fixture user".into(),
            private_key: BASE64.encode(pair.private_key),
            public_key: BASE64.encode(&pair.public_key_cose),
            algorithm: -7,
            sign_count: 9,
            transports: vec!["internal".into()],
            created_at: "2026-09-23T00:00:00Z".into(),
            last_used_at: Some("2026-09-23T01:00:00Z".into()),
            status: Some(PasskeyStatus::Suspect),
            status_reason: Some(PasskeyStatusReason::Manual),
            status_updated_at: Some("2026-09-23T02:00:00Z".into()),
        });
        drop(pair);
    }
    if draft.title() != title {
        return Err("A private category fixture changed its exact title".into());
    }
    Ok(draft)
}

fn matches_fixture_category(item: &bittery_client_core::ItemProjection, category: &str) -> bool {
    matches!(
        (category, &item.data),
        ("login", PublicItemDraft::Login(_))
            | ("secure-note", PublicItemDraft::SecureNote(_))
            | ("credit-card", PublicItemDraft::CreditCard(_))
            | ("identity", PublicItemDraft::Identity(_))
            | ("totp", PublicItemDraft::Authenticator(_))
    )
}

async fn complete_fixture_categories(
    native: &NativeRuntime,
    account_id: &bittery_client_core::AccountId,
    mut login: SeededAccount,
) -> Result<SeededAccount, String> {
    let current = wait_for_authoritative_items(native, account_id).await?;
    let mut missing = Vec::new();
    for (title, raw) in category_fixture_definitions() {
        let mut found = current
            .items
            .iter()
            .filter(|item| item.deleted_at.is_none() && item.data.title() == title);
        if let Some(item) = found.next() {
            if found.next().is_some()
                || item.account_id != *account_id
                || item.vault_id != login.vault_id
                || item.status != bittery_client_core::ItemProjectionStatus::Authoritative
            {
                return Err("An existing private category fixture is ambiguous or stale".into());
            }
        } else {
            missing.push(ImportItemDraft {
                draft: construct_category_fixture_draft(title, raw, &login.item_id)?,
                favorite: false,
            });
        }
    }
    if !missing.is_empty() {
        let missing_count = missing.len();
        let RuntimeResponse::ImportBatchAccepted {
            operation_id,
            vault_id,
            item_ids,
            ..
        } = tests::acceptance_request(
            &native.core,
            RuntimeRequest::ImportItems {
                account_id: account_id.clone(),
                vault_id: login.vault_id.clone(),
                items: missing,
            },
        )
        .await?
        else {
            return Err("Real Runtime did not accept the additional category Items".into());
        };
        if vault_id != login.vault_id || item_ids.len() != missing_count {
            return Err("Runtime changed the category Import Vault or Item count".into());
        }
        wait_for_import_applied(native, account_id, &operation_id).await?;
    }
    let expected = [
        (FIXTURE_RICH_LOGIN_TITLE, "login"),
        (FIXTURE_SECURE_NOTE_TITLE, "secure-note"),
        (FIXTURE_CREDIT_CARD_TITLE, "credit-card"),
        (FIXTURE_IDENTITY_TITLE, "identity"),
        (FIXTURE_TOTP_TITLE, "totp"),
    ];
    login.additional_items = timeout(Duration::from_secs(60), async {
        loop {
            let current = wait_for_authoritative_items(native, account_id).await?;
            let mut found = Vec::new();
            for (title, category) in expected {
                let mut matches = current
                    .items
                    .iter()
                    .filter(|item| item.deleted_at.is_none() && item.data.title() == title);
                let Some(item) = matches.next() else {
                    break;
                };
                if matches.next().is_some()
                    || item.account_id != *account_id
                    || item.vault_id != login.vault_id
                    || item.status != bittery_client_core::ItemProjectionStatus::Authoritative
                    || !matches_fixture_category(item, category)
                {
                    return Err(
                        "Server-synced private category fixture changed identity or type"
                            .to_owned(),
                    );
                }
                found.push(SeededCategoryItem {
                    item_id: item.item_id.clone(),
                    title: title.to_owned(),
                    category: category.to_owned(),
                });
            }
            if found.len() == expected.len() {
                return Ok(found);
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    })
    .await
    .map_err(|_| "Real Server did not synchronize all private category Items".to_owned())??;
    Ok(login)
}

async fn validate_existing_fixture(
    native: &NativeRuntime,
    account_id: &bittery_client_core::AccountId,
    vault_id: Option<&str>,
    item: &bittery_client_core::ItemProjection,
) -> Result<SeededAccount, String> {
    let expected_vault =
        vault_id.ok_or("Native legacy ES256 Login exists without its exact fixture Vault")?;
    let (username, password) = login_credentials(&item.data)?;
    if item.account_id != *account_id
        || item.status != bittery_client_core::ItemProjectionStatus::Authoritative
        || item.vault_id != expected_vault
        || username != FIXTURE_USERNAME
        || password != FIXTURE_PASSWORD
    {
        return Err("Existing native legacy Item does not match the exact accepted fixture".into());
    }

    // Ordinary Items is the renderer/public projection: retain the passkey metadata, and prove
    // it does not contain a private scalar before using the separately authorized Export loan.
    let public_json = zeroize::Zeroizing::new(
        serde_json::to_string(item)
            .map_err(|_| "Cannot inspect ordinary native legacy Item projection")?,
    );
    if public_json.contains("privateKey") {
        return Err("Ordinary Core Items projection exposed passkey signing material".into());
    }
    let public_key = match &item.data {
        PublicItemDraft::Login(login) if login.passkeys.len() == 1 => {
            login.passkeys[0].public_key.clone()
        }
        PublicItemDraft::Login(_) => {
            return Err("Ordinary Core Items projection lost the exact passkey metadata".into())
        }
        _ => return Err("Native legacy fixture is not a Login Item".into()),
    };

    // The private Core-only observation is scoped to this exact Vault and is dropped before the
    // helper serves the old native host. Its private scalar is moved into a zeroizing owner.
    let RuntimeProjection::VaultExport(exported) = tests::snapshot(
        &native.core,
        ObservationRequest::VaultExport {
            account_id: account_id.clone(),
            vault_ids: vec![expected_vault.to_owned()],
        },
    )?
    else {
        return Err("Explicit Core VaultExport returned the wrong projection".into());
    };
    let mut exported = zeroize::Zeroizing::new(exported);
    if exported.account_id != *account_id {
        return Err("Explicit Core VaultExport changed the fixture Account identity".into());
    }
    let mut matches = exported
        .items
        .iter_mut()
        .filter(|candidate| candidate.item_id == item.item_id);
    let exported_item = matches
        .next()
        .ok_or("Explicit Core VaultExport omitted the exact fixture Item")?;
    if matches.next().is_some()
        || exported_item.account_id != *account_id
        || exported_item.vault_id != expected_vault
        || exported_item.status != bittery_client_core::ItemProjectionStatus::Authoritative
    {
        return Err(
            "Explicit Core VaultExport returned an ambiguous or mismatched fixture Item".into(),
        );
    }
    let ItemDraft::Login(private_login) = &mut exported_item.data else {
        return Err("Explicit Core VaultExport returned a non-Login fixture Item".into());
    };
    if private_login.title != FIXTURE_ITEM_TITLE
        || private_login.username.as_deref() != Some(FIXTURE_USERNAME)
        || private_login.password.as_deref() != Some(FIXTURE_PASSWORD)
        || private_login.passkeys.len() != 1
    {
        return Err(
            "Explicit Core VaultExport did not retain the exact ES256 fixture payload".into(),
        );
    }
    let passkey = &mut private_login.passkeys[0];
    let private_key = zeroize::Zeroizing::new(std::mem::take(&mut passkey.private_key));
    let private_key_bytes = zeroize::Zeroizing::new(
        BASE64
            .decode(private_key.as_str())
            .map_err(|_| "Core Export passkey private key is not Base64")?,
    );
    if private_key_bytes.len() != 32
        || passkey.algorithm != -7
        || passkey.rp_id != FIXTURE_RP_ID
        || passkey.user_name != FIXTURE_USERNAME
        || passkey.credential_id.is_empty()
        || passkey.public_key != public_key
        || BASE64
            .decode(&passkey.public_key)
            .map_err(|_| "Core Export passkey public key is not Base64")?
            .is_empty()
        || passkey.sign_count != FIXTURE_SIGN_COUNT
        || passkey.status != Some(PasskeyStatus::Active)
    {
        return Err(
            "Explicit Core VaultExport returned an invalid ES256 fixture credential".into(),
        );
    }
    Ok(SeededAccount {
        account_id: account_id.as_str().to_owned(),
        vault_id: expected_vault.to_owned(),
        item_id: item.item_id.clone(),
        item_title: FIXTURE_ITEM_TITLE.to_owned(),
        username: username.to_owned(),
        credential_id: passkey.credential_id.clone(),
        public_key: passkey.public_key.clone(),
        rp_id: passkey.rp_id.clone(),
        sign_count: passkey.sign_count,
        additional_items: Vec::new(),
    })
}

async fn wait_for_import_applied(
    native: &NativeRuntime,
    account_id: &bittery_client_core::AccountId,
    operation_id: &str,
) -> Result<(), String> {
    timeout(Duration::from_secs(60), async {
        loop {
            let RuntimeProjection::Operations(operations) = tests::snapshot(
                &native.core,
                ObservationRequest::Operations {
                    account_id: account_id.clone(),
                },
            )?
            else {
                return Err("Core returned the wrong Import Operation projection".into());
            };
            if let Some(operation) = operations
                .operations
                .iter()
                .find(|operation| operation.operation_id == operation_id)
            {
                if operation.resolution == bittery_client_core::OperationResolution::Applied {
                    return Ok::<(), String>(());
                }
                if operation.resolution == bittery_client_core::OperationResolution::Rejected {
                    return Err("Real Server rejected the ES256 fixture Import".into());
                }
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    })
    .await
    .map_err(|_| "Real Server did not apply the ES256 fixture Import".to_owned())?
}

async fn wait_for_authoritative_items(
    native: &NativeRuntime,
    account_id: &bittery_client_core::AccountId,
) -> Result<bittery_client_core::ItemsProjection, String> {
    timeout(Duration::from_secs(60), async {
        loop {
            if let Some(items) =
                tests::sample_acceptance_items(native, account_id, "Native legacy fixture setup")?
            {
                return Ok(items);
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    })
    .await
    .map_err(|_| "Core did not expose authoritative Items for the fixture Account".to_owned())?
}

fn unique_fixture_vault(
    items: &bittery_client_core::ItemsProjection,
) -> Result<Option<String>, String> {
    let mut matches = items
        .vaults
        .iter()
        .filter(|vault| vault.name == FIXTURE_VAULT_NAME);
    let Some(vault) = matches.next() else {
        return Ok(None);
    };
    if matches.next().is_some() {
        return Err("More than one exact native legacy fixture Vault exists".into());
    }
    Ok(Some(vault.vault_id.clone()))
}

fn unique_fixture_item(
    items: &bittery_client_core::ItemsProjection,
) -> Result<Option<&bittery_client_core::ItemProjection>, String> {
    let mut matches = items
        .items
        .iter()
        .filter(|item| item.deleted_at.is_none() && item.data.title() == FIXTURE_ITEM_TITLE);
    let Some(item) = matches.next() else {
        return Ok(None);
    };
    if matches.next().is_some() {
        return Err("More than one exact native legacy fixture Login exists".into());
    }
    Ok(Some(item))
}

fn login_credentials(data: &PublicItemDraft) -> Result<(&str, &str), String> {
    match data {
        PublicItemDraft::Login(login) => Ok((
            login
                .username
                .as_deref()
                .ok_or("Native legacy fixture Login omitted its username")?,
            login
                .password
                .as_deref()
                .ok_or("Native legacy fixture Login omitted its password")?,
        )),
        _ => Err("Native legacy fixture marker is not a Login Item".into()),
    }
}

async fn wait_for_vault(
    native: &NativeRuntime,
    account_id: &bittery_client_core::AccountId,
    vault_id: &str,
) -> Result<(), String> {
    timeout(Duration::from_secs(60), async {
        loop {
            if let Some(items) = tests::sample_acceptance_items(
                native,
                account_id,
                "Native legacy Vault authority wait",
            )? {
                if items.vaults.iter().any(|vault| vault.vault_id == vault_id) {
                    return Ok::<(), String>(());
                }
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    })
    .await
    .map_err(|_| "Real Server Vault did not become current Core authority".to_owned())?
}

async fn serve_actual_host_connections(
    native: &std::sync::Arc<NativeRuntime>,
    directory: &Path,
    seeded: &SeededAccount,
) -> Result<&'static str, Box<dyn std::error::Error>> {
    let socket = crate::ipc_security::prepare_desktop_ipc_socket_path()?;
    let listener = UnixListener::bind(socket)?;
    write_private(
        directory.join("native-legacy-seeded-account.json"),
        &serde_json::to_vec(seeded)?,
    )?;
    write_private(directory.join("native-legacy-ready"), b"ready")?;

    if std::env::var_os("BITTERY_NATIVE_LEGACY_EVENT_TRACE").is_some() {
        let (stream, _) = timeout(Duration::from_secs(60), listener.accept()).await??;
        crate::ipc_security::authorize_unix_peer(
            stream.as_raw_fd(),
            crate::ipc_security::PeerRole::NativeHost,
            crate::ipc_security::PeerPolicy::Required,
        )
        .map_err(io::Error::other)?;
        let serve = tokio::spawn(crate::runtime_host::native_source_transport::serve(
            native.clone(),
            stream,
        ));
        timeout(Duration::from_secs(30), async {
            while !directory.join("native-legacy-event-acknowledged").exists() {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await?;
        native
            .core
            .request(
                RuntimeRequest::Lock {
                    account_id: seeded.account_id.clone().into(),
                },
                RequestCancellation::new(),
            )
            .await?;
        write_private(directory.join("native-legacy-core-locked"), b"locked")?;
        timeout(Duration::from_secs(30), serve).await???;
        return Ok("closed-cleanly");
    }

    let expected_connections = if std::env::var_os(SHARED_STAGE).is_some() {
        2
    } else {
        1
    };
    for _ in 0..expected_connections {
        let (stream, _) = timeout(Duration::from_secs(60), listener.accept()).await??;
        crate::ipc_security::authorize_unix_peer(
            stream.as_raw_fd(),
            crate::ipc_security::PeerRole::NativeHost,
            crate::ipc_security::PeerPolicy::Required,
        )
        .map_err(io::Error::other)?;
        // Each protocol1 host request opens a fresh authenticated native socket.
        // The shared fixture reads its snapshot and wrapped keys from the same Core.
        match timeout(
            Duration::from_secs(60),
            crate::runtime_host::native_source_transport::serve(native.clone(), stream),
        )
        .await
        {
            Ok(Ok(())) => {}
            Ok(Err(_)) => return Ok("rejected-first-frame"),
            Err(_) => return Err("Actual native source connection did not retire".into()),
        }
    }
    Ok(if expected_connections == 2 {
        "closed-twice"
    } else {
        "closed-cleanly"
    })
}

async fn run_actual_host(trace: ActualLegacyTrace) -> Result<(), Box<dyn std::error::Error>> {
    let credentials = std::env::var_os(CREDENTIALS)
        .ok_or("BITTERY_NATIVE_LEGACY_CREDENTIALS must name a protected fresh-account file")?;
    let binary = std::env::var_os("BITTERY_NATIVE_HOST_ACCEPTANCE_BINARY").ok_or(
        "BITTERY_NATIVE_HOST_ACCEPTANCE_BINARY must name the actual native host executable",
    )?;
    let scratch = if matches!(trace, ActualLegacyTrace::SharedReadOnly) {
        let fixture = std::env::var_os(SHARED_FIXTURE).ok_or("Shared fixture path is missing")?;
        Path::new(&fixture)
            .parent()
            .ok_or("Shared fixture has no parent")?
            .to_path_buf()
    } else {
        Path::new("/tmp").to_path_buf()
    };
    let directory = tempfile::Builder::new()
        .prefix("b97-")
        .tempdir_in(scratch)?;
    std::fs::set_permissions(directory.path(), std::fs::Permissions::from_mode(0o700))?;

    // Required peer identity is path based. Install both actual executables beside one another,
    // with the production accepted basenames, without bypassing origin or Unix peer validation.
    let runtime_path = directory.path().join("Bittery");
    let host_path = directory.path().join("bittery-native-host");
    std::fs::copy(std::env::current_exe()?, &runtime_path)?;
    std::fs::copy(binary, &host_path)?;

    let mut helper = Command::new(&runtime_path)
        .args([
            "--exact",
            trace.test_name(),
            "--ignored",
            "--nocapture",
            "--test-threads=1",
        ])
        .env(CHILD_DIRECTORY, directory.path())
        .env(CREDENTIALS, credentials)
        .env("XDG_RUNTIME_DIR", directory.path())
        .envs(
            matches!(
                trace,
                ActualLegacyTrace::Biometric
                    | ActualLegacyTrace::BiometricAll
                    | ActualLegacyTrace::BiometricStatus
                    | ActualLegacyTrace::BiometricHeldEof
            )
            .then_some((
                "BITTERY_NATIVE_LEGACY_BIOMETRIC_TRACE",
                "controlled-primitive",
            )),
        )
        .envs(
            matches!(trace, ActualLegacyTrace::BiometricHeldEof).then_some((
                "BITTERY_NATIVE_LEGACY_HELD_BIOMETRIC_TRACE",
                directory.path().as_os_str(),
            )),
        )
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .spawn()?;

    let mut host: Option<Child> = None;
    let attempt = async {
        wait_for_file(&mut helper, &directory.path().join("native-legacy-ready")).await?;
        let seeded: SeededAccount = serde_json::from_slice(&std::fs::read(
            directory.path().join("native-legacy-seeded-account.json"),
        )?)?;
        let origin = crate::native_messaging_installer::allowed_extension_origins()
            .into_iter()
            .next()
            .ok_or("Native messaging host has no allowed extension origin")?;
        let mut child = Command::new(&host_path)
            .arg(origin)
            .env("XDG_RUNTIME_DIR", directory.path())
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true)
            .spawn()?;
        let input = child
            .stdin
            .as_mut()
            .ok_or("Native host stdin was not piped")?;
        crate::desktop_ipc::write_frame(
            input,
            &crate::desktop_ipc::DesktopEnvelope::current(
                Some(trace.request_id().to_owned()),
                trace.request(&seeded),
            ),
        )
        .await?;
        host = Some(child);
        let child = host.as_mut().unwrap();
        if matches!(trace, ActualLegacyTrace::BiometricHeldEof) {
            wait_for_file(&mut helper, &directory.path().join(BIOMETRIC_HELD_ENTERED)).await?;
            // Browser loss occurs while the real Core67 prompt future is still pending.
            drop(child.stdin.take());
            let output = child
                .stdout
                .as_mut()
                .ok_or("Native host stdout was not piped")?;
            let mut first_byte = [0u8; 1];
            if timeout(Duration::from_secs(10), output.read(&mut first_byte)).await?? != 0 {
                return Err("Held biometric prompt wrote bytes after browser EOF".into());
            }
            timeout(Duration::from_secs(10), child.wait()).await??;
            wait_for_file(&mut helper, &directory.path().join(HELPER_OUTCOME)).await?;
            let outcome = std::fs::read_to_string(directory.path().join(HELPER_OUTCOME))?;
            if !outcome.contains("setup=complete")
                || !outcome.contains("listener=closed-cleanly")
                || !outcome.contains("local_cleanup=complete")
                || !outcome.contains("shutdown=complete")
                || !outcome.contains("biometric_prompts=1")
            {
                return Err("Held biometric browser EOF did not release the Core owner".into());
            }
            return Ok::<(), Box<dyn std::error::Error>>(());
        }
        let output = child
            .stdout
            .as_mut()
            .ok_or("Native host stdout was not piped")?;
        let response = PrivateSnapshotResponse::new(
            timeout(
                Duration::from_secs(30),
                crate::desktop_ipc::read_frame(output),
            )
            .await??,
        );
        let shared_keys = if matches!(trace, ActualLegacyTrace::SharedReadOnly) {
            let input = child
                .stdin
                .as_mut()
                .ok_or("Native host stdin closed before shared key read")?;
            crate::desktop_ipc::write_frame(
                input,
                &crate::desktop_ipc::DesktopEnvelope::current(
                    Some(VAULT_KEYS_REQUEST_ID.to_owned()),
                    crate::desktop_ipc::DesktopRequest::GetDesktopVaultKeys {
                        account_id: seeded.account_id.clone(),
                    },
                ),
            )
            .await?;
            Some(PrivateSnapshotResponse::new(
                timeout(
                    Duration::from_secs(30),
                    crate::desktop_ipc::read_frame(output),
                )
                .await??,
            ))
        } else {
            None
        };
        if let Some(input) = child.stdin.take() {
            drop(input);
        }
        timeout(Duration::from_secs(10), child.wait()).await??;
        wait_for_file(&mut helper, &directory.path().join(HELPER_OUTCOME)).await?;
        let helper_outcome = std::fs::read_to_string(directory.path().join(HELPER_OUTCOME))?;
        let listener_closed = if matches!(trace, ActualLegacyTrace::SharedReadOnly) {
            helper_outcome.contains("listener=closed-twice")
        } else {
            helper_outcome.contains("listener=closed-cleanly")
        };
        let listener_rejected = helper_outcome.contains("listener=rejected-first-frame");
        if !helper_outcome.contains("setup=complete")
            || (!listener_closed && !listener_rejected)
            || !helper_outcome.contains("local_cleanup=complete")
            || !helper_outcome.contains("shutdown=complete")
        {
            return Err("Native Runtime helper did not complete scoped fixture cleanup".into());
        }
        let expected_prompts = match trace {
            ActualLegacyTrace::Biometric
            | ActualLegacyTrace::BiometricAll
            | ActualLegacyTrace::BiometricHeldEof => Some(1),
            ActualLegacyTrace::BiometricStatus => Some(0),
            _ => None,
        };
        if expected_prompts
            .is_some_and(|count| !helper_outcome.contains(&format!("biometric_prompts={count}")))
        {
            return Err("Controlled Core67 primitive received an unexpected prompt count".into());
        }
        // Keep the rejection itself distinct from fixture/auth failures. On green, hand the
        // unmodified generated envelope to the actual Extension decoder and its static WASM
        // CryptoPort, then scrub the in-process private snapshot on every outcome.
        let validation = match (trace, &response.envelope.payload) {
            (ActualLegacyTrace::Biometric, _) if listener_rejected => {
                verify_biometric_and_old_decoder(&response.envelope, &seeded)
            }
            (ActualLegacyTrace::BiometricAll, _) if listener_rejected => {
                verify_biometric_all_and_old_decoder(&response.envelope, &seeded)
            }
            (ActualLegacyTrace::BiometricStatus, _) if listener_rejected => {
                verify_biometric_status_and_old_client(&response.envelope)
            }
            (_, crate::desktop_ipc::DesktopResponse::Error { .. }) if listener_rejected => Err(
                "actual protocol1 request was rejected at the populated Core source first frame"
                    .into(),
            ),
            (
                ActualLegacyTrace::Snapshot,
                crate::desktop_ipc::DesktopResponse::DesktopItemsSnapshot { .. },
            ) if listener_closed => verify_snapshot_and_old_extension(&response.envelope, &seeded),
            (
                ActualLegacyTrace::SharedReadOnly,
                crate::desktop_ipc::DesktopResponse::DesktopItemsSnapshot { .. },
            ) if listener_closed => verify_shared_read_only_and_old_extension(
                &response.envelope,
                shared_keys
                    .as_ref()
                    .ok_or("Shared native key reply is missing")?,
                &seeded,
            ),
            (
                ActualLegacyTrace::VaultKeys,
                crate::desktop_ipc::DesktopResponse::DesktopVaultKeys { .. },
            ) if listener_closed => verify_vault_keys_and_old_extension(
                &response.envelope,
                &seeded,
                FIXTURE_VAULT_NAME,
                "personal",
                "owner",
                "folder",
            ),
            (
                ActualLegacyTrace::Accounts,
                crate::desktop_ipc::DesktopResponse::DesktopAccounts { .. },
            ) if listener_closed => {
                verify_accounts_and_old_desktop_sync(&response.envelope, &seeded)
            }
            (
                ActualLegacyTrace::Status,
                crate::desktop_ipc::DesktopResponse::DesktopStatus { .. },
            ) if listener_closed => {
                verify_status_and_old_desktop_client(&response.envelope, &seeded)
            }
            (
                ActualLegacyTrace::AuthToken,
                crate::desktop_ipc::DesktopResponse::DesktopAuthToken { .. },
            ) if listener_closed => {
                verify_auth_token_and_old_hydration(&response.envelope, &seeded)
            }
            (ActualLegacyTrace::Biometric, _) if listener_closed => {
                verify_biometric_and_old_decoder(&response.envelope, &seeded)
            }
            (ActualLegacyTrace::BiometricAll, _) if listener_closed => {
                verify_biometric_all_and_old_decoder(&response.envelope, &seeded)
            }
            (ActualLegacyTrace::BiometricStatus, _) if listener_closed => {
                verify_biometric_status_and_old_client(&response.envelope)
            }
            (
                ActualLegacyTrace::UnknownVaultKeys,
                crate::desktop_ipc::DesktopResponse::Error { message },
            ) if listener_closed => {
                if response.envelope.protocol_version
                    != Some(crate::desktop_ipc::DESKTOP_PROTOCOL_VERSION)
                    || response.envelope.request_id.as_deref() != Some(trace.request_id())
                    || message != "Native source is unavailable"
                {
                    Err("unknown Account returned a mismatched or non-generic native error".into())
                } else {
                    Ok(())
                }
            }
            (_, crate::desktop_ipc::DesktopResponse::Error { .. }) => Err(
                "actual protocol1 request received ERROR after the Core source accepted it".into(),
            ),
            _ => Err("actual protocol1 request received an unexpected legacy response".into()),
        };
        validation?;
        Ok::<(), Box<dyn std::error::Error>>(())
    }
    .await;

    // Retire external processes on both the expected baseline RED and unexpected setup failure.
    if let Some(child) = host.as_mut() {
        if child.try_wait()?.is_none() {
            let _ = child.kill().await;
            let _ = child.wait().await;
        }
    }
    if helper.try_wait()?.is_none() {
        let _ = helper.kill().await;
        let _ = helper.wait().await;
    }
    attempt
}

async fn run_event_host() -> Result<(), Box<dyn std::error::Error>> {
    let credentials = std::env::var_os(CREDENTIALS)
        .ok_or("BITTERY_NATIVE_LEGACY_CREDENTIALS must name the protected Account file")?;
    let binary = std::env::var_os("BITTERY_NATIVE_HOST_ACCEPTANCE_BINARY")
        .ok_or("BITTERY_NATIVE_HOST_ACCEPTANCE_BINARY must name the actual native host")?;
    let directory = tempfile::Builder::new()
        .prefix("b97-events-")
        .tempdir_in("/var/tmp")?;
    std::fs::set_permissions(directory.path(), std::fs::Permissions::from_mode(0o700))?;
    let runtime_path = directory.path().join("Bittery");
    let host_path = directory.path().join("bittery-native-host");
    std::fs::copy(std::env::current_exe()?, &runtime_path)?;
    std::fs::copy(binary, &host_path)?;
    let mut helper = Command::new(&runtime_path)
        .args([
            "--exact",
            EVENT_TEST,
            "--ignored",
            "--nocapture",
            "--test-threads=1",
        ])
        .env(CHILD_DIRECTORY, directory.path())
        .env(CREDENTIALS, credentials)
        .env("BITTERY_NATIVE_LEGACY_EVENT_TRACE", "1")
        .env("XDG_RUNTIME_DIR", directory.path())
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .spawn()?;
    let mut host: Option<Child> = None;
    let attempt = async {
        wait_for_file(&mut helper, &directory.path().join("native-legacy-ready")).await?;
        let seeded: SeededAccount = serde_json::from_slice(&std::fs::read(
            directory.path().join("native-legacy-seeded-account.json"),
        )?)?;
        let origin = crate::native_messaging_installer::allowed_extension_origins()
            .into_iter()
            .next()
            .ok_or("No allowed native origin")?;
        let child = Command::new(&host_path)
            .arg(origin)
            .env("XDG_RUNTIME_DIR", directory.path())
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true)
            .spawn()?;
        host = Some(child);
        let child = host.as_mut().unwrap();
        crate::desktop_ipc::write_frame(
            child.stdin.as_mut().ok_or("No host stdin")?,
            &crate::desktop_ipc::DesktopEnvelope::current(
                Some("events-1".into()),
                crate::desktop_ipc::DesktopRequest::SubscribeDesktopEvents,
            ),
        )
        .await?;
        let ack: crate::desktop_ipc::DesktopEnvelope<crate::desktop_ipc::DesktopResponse> =
            timeout(
                Duration::from_secs(30),
                crate::desktop_ipc::read_frame(child.stdout.as_mut().ok_or("No host stdout")?),
            )
            .await??;
        if ack.request_id.as_deref() != Some("events-1")
            || !matches!(
                ack.payload,
                crate::desktop_ipc::DesktopResponse::DesktopEventSubscription { subscribed: true }
            )
        {
            return Err("Actual host did not acknowledge the Core event subscription".into());
        }
        write_private(
            directory.path().join("native-legacy-event-acknowledged"),
            b"ack",
        )?;
        wait_for_file(
            &mut helper,
            &directory.path().join("native-legacy-core-locked"),
        )
        .await?;
        let event: crate::desktop_ipc::DesktopEnvelope<crate::desktop_ipc::DesktopResponse> =
            timeout(
                Duration::from_secs(30),
                crate::desktop_ipc::read_frame(child.stdout.as_mut().ok_or("No host stdout")?),
            )
            .await??;
        let crate::desktop_ipc::DesktopResponse::DesktopEvent(
            crate::desktop_ipc::DesktopEvent::Lock { timestamp, .. },
        ) = &event.payload
        else {
            return Err("Core Lock did not reach the actual host event connection".into());
        };
        if event.request_id.is_some() || *timestamp <= 0 {
            return Err("Actual Core Lock event lost protocol1 envelope fields".into());
        }
        verify_event_and_old_transport(&event, &seeded)?;
        drop(child.stdin.take());
        timeout(Duration::from_secs(10), child.wait()).await??;
        wait_for_file(&mut helper, &directory.path().join(HELPER_OUTCOME)).await?;
        let outcome = std::fs::read_to_string(directory.path().join(HELPER_OUTCOME))?;
        if !outcome.contains("setup=complete")
            || !outcome.contains("listener=closed-cleanly")
            || !outcome.contains("local_cleanup=complete")
            || !outcome.contains("shutdown=complete")
        {
            return Err("Core event helper did not complete scoped cleanup".into());
        }
        Ok::<(), Box<dyn std::error::Error>>(())
    }
    .await;
    if let Some(child) = host.as_mut() {
        if child.try_wait()?.is_none() {
            let _ = child.kill().await;
            let _ = child.wait().await;
        }
    }
    if helper.try_wait()?.is_none() {
        let _ = helper.kill().await;
        let _ = helper.wait().await;
    }
    attempt
}

fn verify_event_and_old_transport(
    event: &crate::desktop_ipc::DesktopEnvelope<crate::desktop_ipc::DesktopResponse>,
    seeded: &SeededAccount,
) -> Result<(), Box<dyn std::error::Error>> {
    let script = r#"
const path = await import("node:path");
const envelope = JSON.parse(await Bun.stdin.text());
if (envelope.protocolVersion !== 1 || envelope.type !== "DESKTOP_EVENT" ||
    envelope.event !== "lock" || !Number.isSafeInteger(envelope.payload.timestamp)) {
  throw new Error("Core event changed the old wire");
}
let deliver;
const posted = [];
const port = {
  onMessage: { addListener(listener) { deliver = listener; } },
  onDisconnect: { addListener() {} },
  postMessage(message) { posted.push(message); }, disconnect() {},
};
const background = path.resolve("apps/extension/src/background");
const { NativeMessagingClient } = await import(path.join(background, "native-messaging-client.ts"));
const { DesktopClient } = await import(path.join(background, "desktop-client.ts"));
const transport = new NativeMessagingClient({ connectNative: () => port });
const client = new DesktopClient({ nativeClient: transport });
let observed = false;
transport.subscribeToDesktopEvents((value) => { observed = value.event === "lock"; });
deliver({ protocolVersion: 1, requestId: posted[0].requestId,
  type: "DESKTOP_EVENT_SUBSCRIPTION", subscribed: true });
await Promise.resolve();
const stale = client.getAuthToken(process.env.BITTERY_EXPECTED_ACCOUNT);
const request = posted[1];
deliver(envelope);
deliver({ protocolVersion: 1, requestId: request.requestId,
  type: "DESKTOP_AUTH_TOKEN", accountId: process.env.BITTERY_EXPECTED_ACCOUNT,
  email: "fixture@example.invalid", authToken: "stale" });
if (!observed || await stale !== null || transport.currentDeliveryGeneration() !== 1)
  throw new Error("old transport published after Core Lock");
"#;
    let mut child = std::process::Command::new("bun")
        .arg("-e")
        .arg(script)
        .current_dir(
            Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("../../..")
                .canonicalize()?,
        )
        .env("BITTERY_EXPECTED_ACCOUNT", &seeded.account_id)
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()?;
    child
        .stdin
        .take()
        .ok_or("No old consumer stdin")?
        .write_all(&serde_json::to_vec(event)?)?;
    let output = child.wait_with_output()?;
    if !output.status.success() {
        return Err(format!(
            "Actual old event consumer refused Core Lock: {}",
            String::from_utf8_lossy(&output.stderr)
        )
        .into());
    }
    Ok(())
}

fn verify_snapshot_and_old_extension(
    response: &crate::desktop_ipc::DesktopEnvelope<crate::desktop_ipc::DesktopResponse>,
    seeded: &SeededAccount,
) -> Result<(), Box<dyn std::error::Error>> {
    if response.protocol_version != Some(crate::desktop_ipc::DESKTOP_PROTOCOL_VERSION)
        || response.request_id.as_deref() != Some("legacy-snapshot-1")
    {
        return Err("actual protocol1 snapshot lost its version or request correlation".into());
    }
    let crate::desktop_ipc::DesktopResponse::DesktopItemsSnapshot {
        items,
        generated_at,
    } = &response.payload
    else {
        return Err("actual protocol1 snapshot response changed variant".into());
    };
    if *generated_at <= 0 || seeded.additional_items.len() != 5 {
        return Err(
            "actual protocol1 snapshot lost its generated time or category fixture set".into(),
        );
    }
    let matching: Vec<_> = items
        .iter()
        .filter(|item| {
            item.get("title").and_then(serde_json::Value::as_str)
                == Some(seeded.item_title.as_str())
        })
        .collect();
    let [item] = matching.as_slice() else {
        return Err(
            "actual protocol1 snapshot omitted or duplicated the authoritative ES256 Login".into(),
        );
    };
    if item.get("id").and_then(serde_json::Value::as_str) != Some(seeded.item_id.as_str())
        || item.get("accountId").and_then(serde_json::Value::as_str)
            != Some(seeded.account_id.as_str())
        || item.get("vaultId").and_then(serde_json::Value::as_str) != Some(seeded.vault_id.as_str())
        || item.get("username").and_then(serde_json::Value::as_str)
            != Some(seeded.username.as_str())
        || item.get("password").and_then(serde_json::Value::as_str) != Some(FIXTURE_PASSWORD)
    {
        return Err(
            "actual protocol1 snapshot lost private payload or exact Core source metadata".into(),
        );
    }

    let script = r#"
const { parseDesktopSnapshotItem } = await import("./apps/extension/src/background/desktop-snapshot.ts");
const { crypto } = await import("./apps/extension/src/lib/crypto.ts");
const { uniffiInitAsync } = await import("./apps/extension/node_modules/@bittery/crypto-wasm/index.ts");
const { createHash, createPublicKey, verify } = await import("node:crypto");
const { isDeepStrictEqual } = await import("node:util");
const stage = (name) => process.stderr.write(`native-legacy-stage:${name}\n`);
stage("imports");
const raw = await Bun.stdin.text();
stage("stdin-read");
const envelope = JSON.parse(raw);
stage("json-parsed");
if (envelope.type !== "DESKTOP_ITEMS_SNAPSHOT" || !Array.isArray(envelope.items)) {
  throw new Error("actual old snapshot decoder received no snapshot payload");
}
if (typeof envelope.generatedAt !== "number") throw new Error("old snapshot generatedAt lost its numeric wire type");
const expectedCategories = JSON.parse(process.env.BITTERY_EXPECTED_CATEGORIES);
if (!Array.isArray(expectedCategories) || expectedCategories.length !== 5) throw new Error("real category fixture metadata is incomplete");
const exactPrivateFields = {
  "secure-note": {
    note: "secure-note-canary", notes: "secure-note-optional-notes",
    customFields: [{ id: "note-field", label: "Note field", value: "note-field-canary", type: "password" }],
    tags: ["note-tag"],
  },
  "credit-card": {
    cardholderName: "Card Holder", cardNumber: "4111111111111111", cvv: "731", expiryDate: "12/35",
    billingAddress: "Card billing address", notes: "credit-card-notes-canary",
    customFields: [{ id: "card-field", label: "Card field", value: "card-field-canary", type: "password" }],
    totpSecret: "card-totp-canary", totpIssuer: "Card issuer", totpAccountName: "Card account",
    totpAlgorithm: "SHA256", totpDigits: 8, totpPeriod: 45, tags: ["card-tag"],
  },
  identity: {
    firstName: "Ada", middleName: "M", lastName: "Lovelace", email: "ada@native-legacy.invalid",
    addresses: [{ id: "address-1", street: "Identity street", city: "Identity city", state: "Identity state", zip: "12345", country: "Identity country" }],
    phoneNumbers: [{ id: "phone-1", label: "mobile", number: "+10000000000" }],
    ssn: "identity-ssn-canary", passportNumber: "identity-passport-canary",
    driversLicense: "identity-license-canary", dateOfBirth: "1815-12-10", notes: "identity-notes-canary",
    customFields: [{ id: "identity-field", label: "Identity field", value: "identity-field-canary", type: "password" }],
    totpSecret: "identity-totp-canary", totpIssuer: "Identity issuer", totpAccountName: "Identity account",
    totpAlgorithm: "SHA1", totpDigits: 6, totpPeriod: 30, tags: ["identity-tag"],
  },
  totp: {
    totpSecret: "authenticator-totp-canary", totpIssuer: "Authenticator issuer",
    totpAccountName: "Authenticator account", totpAlgorithm: "SHA512", totpDigits: 7,
    totpPeriod: 60, linkedItemId: process.env.BITTERY_EXPECTED_ITEM, notes: "authenticator-notes-canary",
    customFields: [{ id: "authenticator-field", label: "Authenticator field", value: "authenticator-field-canary", type: "password" }],
    tags: ["authenticator-tag"],
  },
};
for (const { title, category, itemId } of expectedCategories) {
  stage(`category-${category}`);
  const candidates = envelope.items.filter((value) => value.title === title);
  if (candidates.length !== 1) throw new Error("actual old decoder did not receive one Item for each private category");
  const rawItem = candidates[0];
  const categoryItem = parseDesktopSnapshotItem(rawItem);
  if (!categoryItem || categoryItem.category !== category || categoryItem.id !== itemId ||
      categoryItem.accountId !== process.env.BITTERY_EXPECTED_ACCOUNT ||
      categoryItem.vaultId !== process.env.BITTERY_EXPECTED_VAULT ||
      categoryItem.favorite !== false || typeof categoryItem.createdAt !== "string" ||
      typeof categoryItem.updatedAt !== "string") {
    throw new Error("actual old decoder changed a private Item category or exact source identity");
  }
  if (rawItem.account !== undefined || rawItem.deletedAt !== undefined || rawItem.version !== undefined ||
      rawItem.status !== undefined || rawItem.attachments !== undefined ||
      rawItem.vault?.accountId !== process.env.BITTERY_EXPECTED_ACCOUNT ||
      rawItem.vault?.id !== process.env.BITTERY_EXPECTED_VAULT ||
      rawItem.vault?.name !== "Native legacy compatibility acceptance Vault" ||
      rawItem.vault?.type !== "personal" || rawItem.vault?.icon !== "folder" ||
      rawItem.vault?.imageUrl !== null || typeof rawItem.accountEmail !== "string") {
    throw new Error("Core legacy formatter changed source metadata precedence or optionality");
  }
  for (const [field, value] of Object.entries(exactPrivateFields[category] ?? {})) {
    if (!isDeepStrictEqual(categoryItem[field], value)) throw new Error("actual old decoder lost a private category field");
  }
  if (category !== "login" && ("url" in categoryItem || "password" in categoryItem)) throw new Error("absent private optional fields became present");
}
stage("five-category-decoded");
stage("rich-login");
const richCandidates = envelope.items.filter((value) => value.title === "Native legacy compatibility acceptance Rich Login");
if (richCandidates.length !== 1) throw new Error("actual old decoder did not receive the full optional Login fixture");
const rich = parseDesktopSnapshotItem(richCandidates[0]);
const richFields = {
  url: "https://rich.native-legacy.invalid", urls: ["https://rich.native-legacy.invalid", "https://second.native-legacy.invalid"],
  username: "rich-fixture-user", password: "rich-login-password-canary",
  passwordHistory: [{ password: "prior-password-canary", changedAt: "2026-09-22T00:00:00Z" }],
  notes: "rich-login-notes-canary", note: "rich-login-note-canary",
  customFields: [{ id: "login-field", label: "Login field", value: "login-field-canary", type: "password" }],
  tags: ["login-tag"], totpSecret: "login-totp-canary", totpIssuer: "Login issuer",
  totpAccountName: "Login account", totpAlgorithm: "SHA256", totpDigits: 8, totpPeriod: 45,
};
if (!rich || rich.category !== "login" || rich.accountId !== process.env.BITTERY_EXPECTED_ACCOUNT ||
    rich.vaultId !== process.env.BITTERY_EXPECTED_VAULT) throw new Error("rich Login lost exact Core source identity");
for (const [field, value] of Object.entries(richFields)) {
  if (!isDeepStrictEqual(rich[field], value)) throw new Error("actual old decoder lost a supported Login optional field");
}
const [richPasskey] = rich.passkeys ?? [];
if (rich.passkeys?.length !== 1 || !richPasskey || richPasskey.rpId !== "rich.native-legacy.invalid" ||
    richPasskey.algorithm !== -7 || richPasskey.signCount !== 9 ||
    richPasskey.lastUsedAt !== "2026-09-23T01:00:00Z" || richPasskey.status !== "suspect" ||
    richPasskey.statusReason !== "manual" || richPasskey.statusUpdatedAt !== "2026-09-23T02:00:00Z" ||
    Buffer.from(richPasskey.privateKey ?? "", "base64").length !== 32 ||
    typeof richPasskey.publicKey !== "string" || richPasskey.publicKey.length === 0) {
  throw new Error("actual old decoder lost optional passkey metadata or private scalar");
}
const matching = envelope.items.filter((value) => value.title === process.env.BITTERY_EXPECTED_TITLE);
stage("item-selected");
if (matching.length !== 1) throw new Error("actual old snapshot decoder did not receive exactly one real Server Item");
const item = matching[0];
const decoded = parseDesktopSnapshotItem(item);
stage("decoded");
if (!decoded || decoded.id !== process.env.BITTERY_EXPECTED_ITEM || decoded.accountId !== process.env.BITTERY_EXPECTED_ACCOUNT || decoded.vaultId !== process.env.BITTERY_EXPECTED_VAULT || decoded.username !== process.env.BITTERY_EXPECTED_USERNAME || decoded.password !== process.env.BITTERY_EXPECTED_PASSWORD || typeof decoded.createdAt !== "string" || typeof decoded.updatedAt !== "string") {
  throw new Error("actual old snapshot decoder changed the Core private Item contract");
}
if ("account" in decoded || "deletedAt" in decoded || "version" in decoded || "status" in decoded ||
    "attachments" in decoded || "urls" in decoded || "notes" in decoded || "totpSecret" in decoded ||
    decoded.vault?.imageUrl !== null) {
  throw new Error("old Login snapshot changed omission or explicit-null behavior");
}
const passkeys = decoded.passkeys ?? [];
if (passkeys.length !== 1) throw new Error("actual decoder omitted the real ES256 credential");
const passkey = passkeys[0];
stage("credential");
if (passkey.credentialId !== process.env.BITTERY_EXPECTED_CREDENTIAL || passkey.publicKey !== process.env.BITTERY_EXPECTED_PUBLIC_KEY || passkey.rpId !== process.env.BITTERY_EXPECTED_RP_ID || passkey.algorithm !== -7 || passkey.signCount !== Number(process.env.BITTERY_EXPECTED_SIGN_COUNT) || typeof passkey.privateKey !== "string" || passkey.privateKey.length === 0) {
  throw new Error("actual decoder did not carry the exact private ES256 credential");
}

// Use the same static CryptoPort that Extension background passkey-handlers calls. The
// independently captured public COSE key verifies the resulting assertion with Node crypto.
await uniffiInitAsync();
await crypto.initialize();
stage("crypto-initialized");
const clientDataJSON = JSON.stringify({ type: "webauthn.get", challenge: process.env.BITTERY_FIXTURE_CHALLENGE, origin: `https://${passkey.rpId}`, crossOrigin: false });
const clientDataHash = createHash("sha256").update(clientDataJSON).digest();
const nextSignCount = Math.max(passkey.signCount + 1, Math.floor(Date.now() / 1000));
const assertion = await crypto.signPasskeyAssertion(passkey.privateKey, passkey.rpId, clientDataHash.toString("base64"), nextSignCount);
stage("signed");
const authenticatorData = Buffer.from(assertion.authenticatorData);
if (authenticatorData.length !== 37 || !authenticatorData.subarray(0, 32).equals(createHash("sha256").update(passkey.rpId).digest()) || authenticatorData[32] !== 0x1d || authenticatorData.readUInt32BE(33) !== nextSignCount) {
  throw new Error("actual Extension signer produced unexpected WebAuthn authenticator data");
}

function decodeCosePublicKey(encoded) {
  const bytes = Buffer.from(encoded, "base64");
  let offset = 0;
  function read() {
    if (offset >= bytes.length) throw new Error("truncated captured COSE public key");
    const head = bytes[offset++];
    const major = head >> 5;
    const additional = head & 31;
    const length = additional < 24 ? additional : additional === 24 ? bytes[offset++] : -1;
    if (length < 0) throw new Error("unsupported captured COSE integer or length");
    if (major === 0) return length;
    if (major === 1) return -1 - length;
    if (major === 2) {
      const value = bytes.subarray(offset, offset + length);
      if (value.length !== length) throw new Error("truncated captured COSE coordinate");
      offset += length;
      return value;
    }
    if (major === 5) {
      const result = new Map();
      for (let index = 0; index < length; index++) result.set(read(), read());
      return result;
    }
    throw new Error("unexpected captured COSE public key value");
  }
  const cose = read();
  if (offset !== bytes.length || !(cose instanceof Map) || cose.size !== 5 || cose.get(1) !== 2 || cose.get(3) !== -7 || cose.get(-1) !== 1) {
    throw new Error("captured passkey public key is not ES256 P-256 COSE");
  }
  const x = cose.get(-2);
  const y = cose.get(-3);
  if (!Buffer.isBuffer(x) || !Buffer.isBuffer(y) || x.length !== 32 || y.length !== 32) {
    throw new Error("captured passkey public key has invalid P-256 coordinates");
  }
  return createPublicKey({ key: { kty: "EC", crv: "P-256", x: x.toString("base64url"), y: y.toString("base64url") }, format: "jwk" });
}

const publicKey = decodeCosePublicKey(process.env.BITTERY_EXPECTED_PUBLIC_KEY);
stage("public-key-decoded");
if (!verify("sha256", Buffer.concat([authenticatorData, clientDataHash]), publicKey, Buffer.from(assertion.signatureDer))) {
  throw new Error("Extension WASM ES256 signature did not verify against the captured public credential");
}
"legacy decoder accepted Core snapshot and Extension ES256 signature verified";
"#;
    let mut child = std::process::Command::new("bun")
        .arg("-e")
        .arg(script)
        .current_dir(
            Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("../../..")
                .canonicalize()?,
        )
        .env("BITTERY_EXPECTED_TITLE", &seeded.item_title)
        .env("BITTERY_EXPECTED_ITEM", &seeded.item_id)
        .env("BITTERY_EXPECTED_ACCOUNT", &seeded.account_id)
        .env("BITTERY_EXPECTED_VAULT", &seeded.vault_id)
        .env("BITTERY_EXPECTED_USERNAME", &seeded.username)
        .env("BITTERY_EXPECTED_PASSWORD", FIXTURE_PASSWORD)
        .env("BITTERY_EXPECTED_CREDENTIAL", &seeded.credential_id)
        .env("BITTERY_EXPECTED_PUBLIC_KEY", &seeded.public_key)
        .env("BITTERY_EXPECTED_RP_ID", &seeded.rp_id)
        .env("BITTERY_EXPECTED_SIGN_COUNT", seeded.sign_count.to_string())
        .env(
            "BITTERY_EXPECTED_CATEGORIES",
            serde_json::to_string(&seeded.additional_items)?,
        )
        .env(
            "BITTERY_FIXTURE_CHALLENGE",
            BASE64_URL.encode(FIXTURE_CHALLENGE),
        )
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()?;
    let bytes = zeroize::Zeroizing::new(serde_json::to_vec(response)?);
    child
        .stdin
        .take()
        .ok_or("Old decoder stdin was not piped")?
        .write_all(&bytes)?;
    let output = child.wait_with_output()?;
    if !output.status.success() {
        let diagnostic = String::from_utf8_lossy(&output.stderr);
        let stage = diagnostic
            .lines()
            .filter_map(|line| line.strip_prefix("native-legacy-stage:"))
            .next_back()
            .unwrap_or("before-imports");
        return Err(format!(
            "actual Extension decoder or signer rejected Core's response after {stage}"
        )
        .into());
    }
    Ok(())
}

fn verify_shared_read_only_and_old_extension(
    response: &crate::desktop_ipc::DesktopEnvelope<crate::desktop_ipc::DesktopResponse>,
    keys: &PrivateSnapshotResponse,
    seeded: &SeededAccount,
) -> Result<(), Box<dyn std::error::Error>> {
    let path = std::env::var_os(SHARED_FIXTURE).ok_or("Shared fixture path is missing")?;
    let fixture: SharedReadOnlyFixture = serde_json::from_slice(&std::fs::read(path)?)?;
    let stage = std::env::var(SHARED_STAGE)?;
    if response.protocol_version != Some(crate::desktop_ipc::DESKTOP_PROTOCOL_VERSION)
        || response.request_id.as_deref() != Some("legacy-shared-read-only-1")
    {
        return Err("Shared native snapshot lost exact protocol1 correlation".into());
    }
    let crate::desktop_ipc::DesktopResponse::DesktopItemsSnapshot {
        items,
        generated_at,
    } = &response.payload
    else {
        return Err("Shared native snapshot changed response variant".into());
    };
    if *generated_at <= 0 {
        return Err("Shared native snapshot lost time or recipient Account".into());
    }
    let target: Vec<_> = items
        .iter()
        .filter(|item| item.get("id").and_then(serde_json::Value::as_str) == Some(&fixture.item_id))
        .collect();
    let crate::desktop_ipc::DesktopResponse::DesktopVaultKeys {
        account_id,
        vault_keys,
        ..
    } = &keys.envelope.payload
    else {
        return Err("Shared native wrapped-key reply changed variant".into());
    };
    if account_id != &seeded.account_id
        || keys.envelope.request_id.as_deref() != Some(VAULT_KEYS_REQUEST_ID)
    {
        return Err("Shared native wrapped-key reply lost recipient correlation".into());
    }
    let parsed_keys: Vec<serde_json::Value> = serde_json::from_str(vault_keys)?;
    let target_keys: Vec<_> = parsed_keys
        .iter()
        .filter(|key| {
            key.get("vaultId").and_then(serde_json::Value::as_str) == Some(&fixture.vault_id)
        })
        .collect();
    if stage == "unshared" {
        if !target.is_empty() || !target_keys.is_empty() {
            return Err("Unshared recipient received shared private Item or Vault key".into());
        }
        println!("Actual unshared recipient native snapshot and wrapped-key control passed");
        return Ok(());
    }
    if stage != "read-only" || target.len() != 1 || target_keys.len() != 1 {
        return Err("ReadOnly recipient did not receive one exact private Item and key".into());
    }
    let raw = target[0];
    if raw.get("accountId").and_then(serde_json::Value::as_str) != Some(&seeded.account_id)
        || raw.get("vaultId").and_then(serde_json::Value::as_str) != Some(&fixture.vault_id)
        || raw.get("title").and_then(serde_json::Value::as_str) != Some(&fixture.item_title)
        || raw.get("username").and_then(serde_json::Value::as_str) != Some(&fixture.username)
        || raw.get("password").and_then(serde_json::Value::as_str)
            != Some(fixture.password.as_ref())
        || raw
            .pointer("/vault/name")
            .and_then(serde_json::Value::as_str)
            != Some(&fixture.vault_name)
        || raw
            .pointer("/vault/type")
            .and_then(serde_json::Value::as_str)
            != Some("team")
    {
        return Err("ReadOnly native snapshot lost current private Item or Vault metadata".into());
    }
    verify_vault_keys_and_old_extension(
        &keys.envelope,
        seeded,
        &fixture.vault_name,
        "team",
        "read-only",
        "lock",
    )?;
    let script = r#"
const { parseDesktopSnapshotItem } = await import("./apps/extension/src/background/desktop-snapshot.ts");
const envelope = JSON.parse(await Bun.stdin.text());
if (envelope.type !== "DESKTOP_ITEMS_SNAPSHOT" || !Array.isArray(envelope.items) ||
    typeof envelope.generatedAt !== "number") throw Error("old decoder lost native snapshot shape");
const items = envelope.items.filter(item => item.id === process.env.BITTERY_EXPECTED_ITEM);
if (items.length !== 1) throw Error("old decoder received ambiguous recipient Item");
const item = parseDesktopSnapshotItem(items[0]);
if (!item || item.id !== process.env.BITTERY_EXPECTED_ITEM ||
    item.accountId !== process.env.BITTERY_EXPECTED_ACCOUNT ||
    item.vaultId !== process.env.BITTERY_EXPECTED_VAULT ||
    item.category !== "login" || item.title !== process.env.BITTERY_EXPECTED_TITLE ||
    item.username !== process.env.BITTERY_EXPECTED_USERNAME ||
    item.password !== process.env.BITTERY_EXPECTED_PASSWORD ||
    item.vault?.id !== process.env.BITTERY_EXPECTED_VAULT ||
    item.vault?.name !== process.env.BITTERY_EXPECTED_VAULT_NAME ||
    item.vault?.type !== "team" || item.vault?.imageUrl !== null) {
  throw Error("unchanged old decoder rejected exact ReadOnly recipient private Login");
}
"old decoder accepted exact Server-synced ReadOnly recipient private Login";
"#;
    let mut child = std::process::Command::new("bun")
        .arg("-e")
        .arg(script)
        .current_dir(
            Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("../../..")
                .canonicalize()?,
        )
        .env("BITTERY_EXPECTED_ITEM", &fixture.item_id)
        .env("BITTERY_EXPECTED_ACCOUNT", &seeded.account_id)
        .env("BITTERY_EXPECTED_VAULT", &fixture.vault_id)
        .env("BITTERY_EXPECTED_TITLE", &fixture.item_title)
        .env("BITTERY_EXPECTED_USERNAME", &fixture.username)
        .env("BITTERY_EXPECTED_PASSWORD", fixture.password.as_ref())
        .env("BITTERY_EXPECTED_VAULT_NAME", &fixture.vault_name)
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()?;
    let bytes = zeroize::Zeroizing::new(serde_json::to_vec(response)?);
    child
        .stdin
        .take()
        .ok_or("Old decoder stdin was not piped")?
        .write_all(&bytes)?;
    let output = child.wait_with_output()?;
    if !output.status.success() {
        return Err("Unchanged old snapshot decoder rejected ReadOnly recipient Login".into());
    }
    println!(
        "Actual Server-synced ReadOnly Member native host and old snapshot/key consumers passed"
    );
    Ok(())
}

fn verify_auth_token_and_old_hydration(
    response: &crate::desktop_ipc::DesktopEnvelope<crate::desktop_ipc::DesktopResponse>,
    seeded: &SeededAccount,
) -> Result<(), Box<dyn std::error::Error>> {
    if response.protocol_version != Some(crate::desktop_ipc::DESKTOP_PROTOCOL_VERSION)
        || response.request_id.as_deref() != Some("desktop-123456789-1")
    {
        return Err("actual protocol1 auth-token reply lost request correlation".into());
    }
    let crate::desktop_ipc::DesktopResponse::DesktopAuthToken {
        account_id,
        email,
        auth_token,
        expires_at,
        user_id,
    } = &response.payload
    else {
        return Err("actual protocol1 auth-token reply changed variant".into());
    };
    if account_id != &seeded.account_id
        || email.is_empty()
        || auth_token.is_empty()
        || expires_at.is_none_or(|expiry| expiry <= 0)
        || user_id.as_ref().is_none_or(String::is_empty)
    {
        return Err(
            "actual protocol1 auth-token reply lost current Account or Session fields".into(),
        );
    }

    let script = r#"
const { mock } = await import("bun:test");
const path = await import("node:path");
const stage = (name) => process.stderr.write(`native-legacy-auth-token-stage:${name}\n`);
const envelope = JSON.parse(await Bun.stdin.text());
const accountId = process.env.BITTERY_EXPECTED_ACCOUNT;
if (envelope.protocolVersion !== 1 || envelope.requestId !== "desktop-123456789-1" ||
    envelope.type !== "DESKTOP_AUTH_TOKEN" || envelope.accountId !== accountId ||
    typeof envelope.email !== "string" || !envelope.email ||
    typeof envelope.authToken !== "string" || !envelope.authToken ||
    !Number.isSafeInteger(envelope.expiresAt) ||
    typeof envelope.userId !== "string" || !envelope.userId ||
    Object.keys(envelope).some((field) => !new Set([
      "protocolVersion", "requestId", "type", "accountId", "email", "authToken",
      "expiresAt", "userId"
    ]).has(field))) {
  throw new Error("old token consumer received changed protocol1 fields");
}
stage("wire-fields");
let deliver;
let requests = 0;
const stored = [];
const port = {
  onMessage: { addListener(listener) { deliver = listener; } },
  onDisconnect: { addListener() {} },
  postMessage(message) {
    requests += 1;
    if (message.protocolVersion !== 1 || message.requestId !== envelope.requestId ||
        message.type !== "GET_DESKTOP_AUTH_TOKEN" || message.accountId !== accountId) {
      throw new Error("old DesktopClient changed the exact Account token request");
    }
    queueMicrotask(() => deliver(envelope));
  },
  disconnect() {},
};
Date.now = () => 123456789;
globalThis.chrome = { runtime: { connectNative: () => port, lastError: undefined } };
const background = path.resolve("apps/extension/src/background");
const exactAccount = (id) => { if (id !== accountId) throw new Error("hydration retargeted the Account"); };
mock.module(path.resolve("apps/extension/src/lib/storage.ts"), () => ({
  storage: {
    getAccountMetadata: async (id) => { exactAccount(id); return { accountId }; },
    getAuthToken: async (id) => { exactAccount(id); return null; },
    storeAuthToken: async (token, id) => { exactAccount(id); stored.push({ token, id }); },
    getVaultKeys: async (id) => { exactAccount(id); return [{ vaultId: "existing-key" }]; },
    tryRestoreSession: async (allowPrompt, id) => {
      exactAccount(id);
      if (allowPrompt !== false) throw new Error("hydration changed restore behavior");
    },
  },
}));
mock.module(path.join(background, "desktop-status.ts"), () => ({ isDesktopUnlockedNow: async () => true }));
mock.module(path.join(background, "native-messaging.ts"), () => ({
  handleNativeBiometricUnlockAll: async () => { throw new Error("token hydration invoked biometric transfer"); },
}));
stage("controlled-dependencies");
const { hydrateDesktopAccountMaterial } = await import(path.join(background, "desktop-key-material.ts"));
await hydrateDesktopAccountMaterial(accountId);
if (requests !== 1 || stored.length !== 1 || stored[0].id !== accountId ||
    stored[0].token !== envelope.authToken) {
  throw new Error("old hydration did not store the exact native token for the exact Account");
}
stage("stored-exact-token");
"old hydration stored the exact current Core token";
"#;
    let mut child = std::process::Command::new("bun")
        .arg("-e")
        .arg(script)
        .current_dir(
            Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("../../..")
                .canonicalize()?,
        )
        .env("BITTERY_EXPECTED_ACCOUNT", &seeded.account_id)
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()?;
    let bytes = zeroize::Zeroizing::new(serde_json::to_vec(response)?);
    child
        .stdin
        .take()
        .ok_or("Old token consumer stdin was not piped")?
        .write_all(&bytes)?;
    let output = child.wait_with_output()?;
    if !output.status.success() {
        let diagnostic = String::from_utf8_lossy(&output.stderr);
        let stage = diagnostic
            .lines()
            .filter_map(|line| line.strip_prefix("native-legacy-auth-token-stage:"))
            .next_back()
            .unwrap_or("before-imports");
        return Err(
            format!("actual old token consumer rejected Core's reply after {stage}").into(),
        );
    }
    Ok(())
}

fn verify_vault_keys_and_old_extension(
    response: &crate::desktop_ipc::DesktopEnvelope<crate::desktop_ipc::DesktopResponse>,
    seeded: &SeededAccount,
    expected_vault_name: &str,
    expected_vault_type: &str,
    expected_role: &str,
    expected_icon: &str,
) -> Result<(), Box<dyn std::error::Error>> {
    if response.protocol_version != Some(crate::desktop_ipc::DESKTOP_PROTOCOL_VERSION)
        || response.request_id.as_deref() != Some(VAULT_KEYS_REQUEST_ID)
    {
        return Err(
            "actual protocol1 wrapped-key reply lost version or request correlation".into(),
        );
    }
    let crate::desktop_ipc::DesktopResponse::DesktopVaultKeys {
        account_id,
        email,
        vault_keys,
    } = &response.payload
    else {
        return Err("actual protocol1 wrapped-key reply changed variant".into());
    };
    if account_id != &seeded.account_id || email.is_empty() || vault_keys.is_empty() {
        return Err("actual protocol1 wrapped-key reply lost exact Account identity".into());
    }

    let script = r#"
const { mock } = await import("bun:test");
const path = await import("node:path");
const stage = (name) => process.stderr.write(`native-legacy-vault-key-stage:${name}\n`);
stage("imports");
const envelope = JSON.parse(await Bun.stdin.text());
const accountId = process.env.BITTERY_EXPECTED_ACCOUNT;
const vaultId = process.env.BITTERY_EXPECTED_VAULT;
if (envelope.protocolVersion !== 1 || envelope.requestId !== "desktop-123456789-1") {
  throw new Error("old transport received changed protocol1 correlation");
}

let deliver;
let requests = 0;
const stored = [];
const port = {
  onMessage: { addListener(listener) { deliver = listener; } },
  onDisconnect: { addListener() {} },
  postMessage(message) {
    requests += 1;
    if (message.protocolVersion !== 1 || message.requestId !== envelope.requestId ||
        message.type !== "GET_DESKTOP_VAULT_KEYS" || message.accountId !== accountId) {
      throw new Error("old hydration changed exact wrapped-key request");
    }
    queueMicrotask(() => deliver(envelope));
  },
  disconnect() {},
};
Date.now = () => 123456789;
globalThis.chrome = { runtime: { connectNative: () => port } };
const background = path.resolve("apps/extension/src/background");
const lib = path.resolve("apps/extension/src/lib");
const exactAccount = (received) => {
  if (received !== accountId) throw new Error("hydration retargeted the Account");
};
mock.module(path.join(lib, "storage.ts"), () => ({
  storage: {
    getAccountMetadata: async (id) => { exactAccount(id); return { accountId }; },
    getAuthToken: async (id) => { exactAccount(id); return "existing-local-token"; },
    getVaultKeys: async (id) => { exactAccount(id); return null; },
    storeVaultKeys: async (keys, id) => { exactAccount(id); stored.push({ keys, id }); },
    tryRestoreSession: async (allowPrompt, id) => {
      exactAccount(id);
      if (allowPrompt !== false) throw new Error("hydration changed restore behavior");
    },
  },
}));
mock.module(path.join(background, "desktop-status.ts"), () => ({
  isDesktopUnlockedNow: async () => true,
}));
mock.module(path.join(background, "native-messaging.ts"), () => ({
  handleNativeBiometricUnlockAll: async () => {
    throw new Error("wrapped-key hydration must not invoke biometric transfer");
  },
}));
stage("controlled-dependencies");
const { hydrateDesktopAccountMaterial } = await import(
  path.join(background, "desktop-key-material.ts")
);
await hydrateDesktopAccountMaterial(accountId);
stage("hydrated");
if (requests !== 1 || stored.length !== 1 || stored[0].id !== accountId) {
  throw new Error("old hydration did not store one exact-Account wrapped-key reply");
}
const keys = stored[0].keys;
if (!Array.isArray(keys) || !keys.every((key) => key && typeof key === "object" &&
    typeof key.vaultId === "string" && typeof key.encryptedVaultKey === "string")) {
  throw new Error("old hydration did not pass the wrapped-key array to storage");
}
// Parse the unchanged host envelope only as an independent byte-for-byte oracle. The array
// under test is the one passed by the real hydration consumer to storage.storeVaultKeys.
const expected = JSON.parse(envelope.vaultKeys);
if (!Array.isArray(expected) || keys.length !== expected.length ||
    expected.some((record) => keys.filter((key) => key.vaultId === record.vaultId &&
      key.encryptedVaultKey === record.encryptedVaultKey).length !== 1)) {
  throw new Error("old hydration altered the current wrapped-key records");
}
stage("stored-wrapped-key-array");
const selected = keys.filter((key) => key.vaultId === vaultId);
if (selected.length !== 1) throw new Error("current fixture Vault key is missing or duplicated");
const key = selected[0];
if (key.vaultName !== process.env.BITTERY_EXPECTED_VAULT_NAME ||
    key.vaultType !== process.env.BITTERY_EXPECTED_VAULT_TYPE ||
    key.role !== process.env.BITTERY_EXPECTED_ROLE ||
    key.vaultIcon !== process.env.BITTERY_EXPECTED_VAULT_ICON ||
    key.vaultImageUrl !== null) {
  throw new Error("wrapped-key authority metadata changed type, role, or nullability");
}
stage("wrapped-key-metadata");
if (process.env.BITTERY_EXPECTED_ROLE === "read-only") {
  // Member grants use the recipient's 4096-bit RSA key; the current native
  // Core already decrypted this exact grant to publish the private Login.
  const ciphertext = Buffer.from(key.encryptedVaultKey, "base64");
  if (ciphertext.length !== 512 || ciphertext.toString("base64") !== key.encryptedVaultKey) {
    throw new Error("current member RSA-wrapped Vault key changed its compatible wrapper");
  }
} else {
  const wrapped = JSON.parse(key.encryptedVaultKey);
  if (typeof wrapped.algorithm !== "string" || typeof wrapped.ciphertext !== "string" ||
      typeof wrapped.iv !== "string" || wrapped.context?.vaultId !== vaultId ||
      wrapped.context?.purpose !== "vault-key-wrap") {
    throw new Error("current MUK-wrapped Vault key changed its compatible wrapper");
  }
}
stage("wrapped-key-decoded");
"old hydration stored the current Core wrapped-key record";
"#;
    let mut child = std::process::Command::new("bun")
        .arg("-e")
        .arg(script)
        .current_dir(
            Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("../../..")
                .canonicalize()?,
        )
        .env("BITTERY_EXPECTED_ACCOUNT", &seeded.account_id)
        .env("BITTERY_EXPECTED_VAULT", &seeded.vault_id)
        .env("BITTERY_EXPECTED_VAULT_NAME", expected_vault_name)
        .env("BITTERY_EXPECTED_VAULT_TYPE", expected_vault_type)
        .env("BITTERY_EXPECTED_ROLE", expected_role)
        .env("BITTERY_EXPECTED_VAULT_ICON", expected_icon)
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()?;
    let bytes = zeroize::Zeroizing::new(serde_json::to_vec(response)?);
    child
        .stdin
        .take()
        .ok_or("Old wrapped-key consumer stdin was not piped")?
        .write_all(&bytes)?;
    let output = child.wait_with_output()?;
    if !output.status.success() {
        let diagnostic = String::from_utf8_lossy(&output.stderr);
        let stage = diagnostic
            .lines()
            .filter_map(|line| line.strip_prefix("native-legacy-vault-key-stage:"))
            .next_back()
            .unwrap_or("before-imports");
        return Err(format!(
            "actual old DesktopClient or key parser rejected Core's wrapped-key reply after {stage}"
        )
        .into());
    }
    Ok(())
}

fn verify_accounts_and_old_desktop_sync(
    response: &crate::desktop_ipc::DesktopEnvelope<crate::desktop_ipc::DesktopResponse>,
    seeded: &SeededAccount,
) -> Result<(), Box<dyn std::error::Error>> {
    if response.protocol_version != Some(crate::desktop_ipc::DESKTOP_PROTOCOL_VERSION)
        || response.request_id.as_deref() != Some(ACCOUNTS_REQUEST_ID)
    {
        return Err(
            "actual protocol1 accounts reply lost its version or request correlation".into(),
        );
    }
    let crate::desktop_ipc::DesktopResponse::DesktopAccounts {
        accounts,
        active_account,
        unlocked_accounts,
    } = &response.payload
    else {
        return Err("actual protocol1 accounts reply changed variant".into());
    };
    if accounts.len() != 1
        || accounts[0].account_id != seeded.account_id
        || active_account.is_some()
        || unlocked_accounts != &vec![seeded.account_id.clone()]
    {
        return Err(
            "actual protocol1 accounts reply changed catalog identity or headless state".into(),
        );
    }

    let script = r#"
const { mock } = await import("bun:test");
const path = await import("node:path");
const stage = (name) => process.stderr.write(`native-legacy-accounts-stage:${name}\n`);
stage("imports");
const envelope = JSON.parse(await Bun.stdin.text());
const accountId = process.env.BITTERY_EXPECTED_ACCOUNT;
const configuredServerUrl = "https://extension-configured.example";
if (envelope.protocolVersion !== 1 || envelope.requestId !== "desktop-123456789-1" ||
    envelope.type !== "DESKTOP_ACCOUNTS" || envelope.activeAccount !== null ||
    !Array.isArray(envelope.accounts) || envelope.accounts.length !== 1 ||
    !Array.isArray(envelope.unlockedAccounts) ||
    envelope.unlockedAccounts.length !== 1 || envelope.unlockedAccounts[0] !== accountId) {
  throw new Error("old account consumer received a changed protocol1 catalog envelope");
}
const entry = envelope.accounts[0];
const allowedFields = new Set(["accountId", "email", "userId", "name", "secretKeyHint",
  "teamName", "teamAvatarUrl", "addedAt", "lastActiveAt", "biometricEnabled"]);
const requiredFields = ["accountId", "email", "userId", "name", "secretKeyHint",
  "teamAvatarUrl", "addedAt", "lastActiveAt", "biometricEnabled"];
stage("wire-allowed-fields");
if (Object.keys(entry).some((field) => !allowedFields.has(field))) {
  throw new Error("wire Account entry has an unexpected field");
}
stage("wire-required-fields");
if (requiredFields.some((field) => !Object.hasOwn(entry, field))) {
  throw new Error("wire Account entry omitted a required field");
}
stage("wire-account-identity");
if (entry.accountId !== accountId) throw new Error("wire Account ID changed");
stage("wire-string-metadata");
if (typeof entry.email !== "string" || !entry.email || typeof entry.userId !== "string" ||
    !entry.userId || typeof entry.name !== "string" || typeof entry.secretKeyHint !== "string" ||
    !entry.secretKeyHint) throw new Error("wire Account string metadata changed type");
stage("wire-team-metadata");
if ((entry.teamName !== undefined && typeof entry.teamName !== "string") ||
    (entry.teamAvatarUrl !== null && typeof entry.teamAvatarUrl !== "string")) {
  throw new Error("wire Account team optional/null semantics changed");
}
stage("wire-timestamps");
if (!Number.isSafeInteger(entry.addedAt) || !Number.isSafeInteger(entry.lastActiveAt)) {
  throw new Error("wire Account timestamps are not safe integers");
}
stage("wire-biometric");
if (typeof entry.biometricEnabled !== "boolean") {
  throw new Error("wire Account biometric field changed type");
}
stage("wire-excluded-fields");
if ("serverUrl" in entry || "insecureTransportConfirmed" in entry) {
  throw new Error("wire Account included configured transport policy");
}
stage("wire-shape");

let deliver;
let requests = 0;
const existing = {
  accountId: "same-email-different-account-id",
  email: entry.email,
  userId: "different-user-id",
  name: "Keep this distinct account",
  serverUrl: "https://existing-account.example",
  secretKeyHint: "existing-hint",
  insecureTransportConfirmed: true,
};
const accounts = [existing];
const additions = [];
const activeSelections = [];
const storage = {
  getAccountsList: async () => accounts.slice(),
  getServerUrl: async () => configuredServerUrl,
  addAccount: async (account) => {
    additions.push(account);
    const index = accounts.findIndex((current) => current.accountId === account.accountId);
    if (index < 0) accounts.push(account);
    else accounts[index] = account;
  },
  setActiveAccount: async (accountId) => activeSelections.push(accountId),
};
const port = {
  onMessage: { addListener(listener) { deliver = listener; } },
  onDisconnect: { addListener() {} },
  postMessage(message) {
    requests += 1;
    if (message.protocolVersion !== 1 || message.requestId !== "desktop-123456789-1" ||
        message.type !== "GET_DESKTOP_ACCOUNTS") {
      throw new Error("old DesktopClient changed its accounts request");
    }
    queueMicrotask(() => deliver(envelope));
  },
  disconnect() {},
};
Date.now = () => 123456789;
globalThis.chrome = { runtime: { connectNative: () => port, lastError: undefined } };
const background = path.resolve("apps/extension/src/background");
mock.module(path.resolve("apps/extension/src/lib/storage.ts"), () => ({ storage }));
stage("consumer-storage-mock");
mock.module(path.join(background, "vault-session/index.ts"), () => ({
  vaultSession: { dispatch: async () => undefined },
  vaultSessionPorts: { desktop: { readCached: () => null } },
}));
stage("consumer-vault-mock");
mock.module(path.join(background, "events/index.ts"), () => ({ emitBackgroundEvent: () => undefined }));
stage("consumer-events-mock");
mock.module(path.join(background, "services/desktop-recovery.ts"), () => ({
  evaluateDesktopRecoveryDecision: () => ({ shouldAttemptRecovery: false }),
}));
stage("consumer-recovery-mock");
const { desktopClient } = await import(path.join(background, "desktop-client.ts"));
stage("desktop-client-import");
const { DesktopSyncService, desktopAccountToMetadata } = await import(
  path.join(background, "desktop-sync.ts")
);
stage("actual-consumers-imported");
const received = await desktopClient.getAccounts();
if (received?.type !== "DESKTOP_ACCOUNTS" || received.accounts[0].accountId !== accountId) {
  throw new Error("actual DesktopClient.getAccounts did not return Core catalog identity");
}
const sync = new DesktopSyncService({ refresh: async () => undefined });
await sync.syncAccountsFromDesktop();
stage("actual-sync-installed");
if (requests !== 1 || additions.length !== 1 || activeSelections.length !== 0 ||
    accounts.length !== 2 || accounts[0] !== existing || accounts[1].accountId !== accountId) {
  throw new Error("actual DesktopSync did not add by exact Account ID while activeAccount was null");
}
const installed = accounts[1];
const converted = desktopAccountToMetadata(entry, configuredServerUrl);
if (installed.email !== entry.email || installed.userId !== entry.userId ||
    installed.name !== entry.name || installed.secretKeyHint !== entry.secretKeyHint ||
    installed.addedAt !== entry.addedAt || installed.lastActiveAt !== entry.lastActiveAt ||
    installed.biometricEnabled !== entry.biometricEnabled || installed.serverUrl !== configuredServerUrl ||
    installed.insecureTransportConfirmed !== false || installed.teamAvatarUrl !== entry.teamAvatarUrl ||
    installed.teamName !== entry.teamName ||
    JSON.stringify(installed) !== JSON.stringify(converted) ||
    existing.userId !== "different-user-id" || existing.serverUrl !== "https://existing-account.example") {
  throw new Error("actual DesktopSync account conversion changed metadata or retargeted equal email");
}
stage("configured-server-and-safe-consent");
"actual old DesktopClient and DesktopSync installed the exact Core Account metadata";
"#;
    let mut child = std::process::Command::new("bun")
        .arg("-e")
        .arg(script)
        .current_dir(
            Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("../../..")
                .canonicalize()?,
        )
        .env("BITTERY_EXPECTED_ACCOUNT", &seeded.account_id)
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()?;
    let bytes = zeroize::Zeroizing::new(serde_json::to_vec(response)?);
    child
        .stdin
        .take()
        .ok_or("Old DesktopSync consumer stdin was not piped")?
        .write_all(&bytes)?;
    let output = child.wait_with_output()?;
    if !output.status.success() {
        let diagnostic = String::from_utf8_lossy(&output.stderr);
        let stage = diagnostic
            .lines()
            .filter_map(|line| line.strip_prefix("native-legacy-accounts-stage:"))
            .next_back()
            .unwrap_or("before-imports");
        return Err(format!(
            "actual old DesktopClient or DesktopSync rejected Core's account reply after {stage}"
        )
        .into());
    }
    Ok(())
}

fn verify_status_and_old_desktop_client(
    response: &crate::desktop_ipc::DesktopEnvelope<crate::desktop_ipc::DesktopResponse>,
    seeded: &SeededAccount,
) -> Result<(), Box<dyn std::error::Error>> {
    let crate::desktop_ipc::DesktopResponse::DesktopStatus {
        available,
        locked,
        unlocked_accounts,
        timestamp,
        autolock_timeout_ms,
        theme,
    } = &response.payload
    else {
        return Err("actual status changed variant".into());
    };
    if response.protocol_version != Some(crate::desktop_ipc::DESKTOP_PROTOCOL_VERSION)
        || response.request_id.as_deref() != Some("desktop-123456789-1")
        || !available
        || *locked
        || unlocked_accounts != &vec![seeded.account_id.clone()]
        || *timestamp <= 0
        || *autolock_timeout_ms != 600_000
        || theme.is_some()
    {
        return Err(
            "actual Core status lost process, Account, timeout or headless identity".into(),
        );
    }
    let script = r#"
const path = await import("node:path");
const envelope = JSON.parse(await Bun.stdin.text());
const accountId = process.env.BITTERY_EXPECTED_ACCOUNT;
if (envelope.protocolVersion !== 1 || envelope.requestId !== "desktop-123456789-1" ||
    envelope.type !== "DESKTOP_STATUS" || envelope.available !== true || envelope.locked !== false ||
    JSON.stringify(envelope.unlockedAccounts) !== JSON.stringify([accountId]) ||
    !Number.isSafeInteger(envelope.timestamp) || envelope.timestamp <= 0 ||
    envelope.autolockTimeoutMs !== 600000 || "theme" in envelope) {
  throw new Error("actual status wire changed");
}
let deliver;
let requests = 0;
const port = {
  onMessage: { addListener(listener) { deliver = listener; } },
  onDisconnect: { addListener() {} },
  postMessage(message) {
    requests += 1;
    if (message.protocolVersion !== 1 || message.requestId !== "desktop-123456789-1" ||
        message.type !== "GET_DESKTOP_STATUS") throw new Error("old status request changed");
    queueMicrotask(() => deliver(envelope));
  },
  disconnect() {},
};
Date.now = () => 123456789;
const background = path.resolve("apps/extension/src/background");
const { NativeMessagingClient } = await import(path.join(background, "native-messaging-client.ts"));
const { DesktopClient } = await import(path.join(background, "desktop-client.ts"));
const nativeClient = new NativeMessagingClient({ connectNative: () => port });
const status = await new DesktopClient({ nativeClient }).getLockStatus();
if (requests !== 1 || !status || !status.available || status.locked ||
    JSON.stringify(status.unlockedAccounts) !== JSON.stringify([accountId]) ||
    status.timestamp !== envelope.timestamp || status.autolockTimeoutMs !== 600000 ||
    status.theme !== null) throw new Error("old DesktopClient rejected Core status");
"actual NativeMessagingClient and DesktopClient consumed Core status";
"#;
    let mut child = std::process::Command::new("bun")
        .arg("-e")
        .arg(script)
        .current_dir(
            Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("../../..")
                .canonicalize()?,
        )
        .env("BITTERY_EXPECTED_ACCOUNT", &seeded.account_id)
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()?;
    let bytes = zeroize::Zeroizing::new(serde_json::to_vec(response)?);
    child
        .stdin
        .take()
        .ok_or("Old status consumer stdin was not piped")?
        .write_all(&bytes)?;
    let output = child.wait_with_output()?;
    if !output.status.success() {
        return Err(format!(
            "actual old status consumer rejected Core: {}",
            String::from_utf8_lossy(&output.stderr)
        )
        .into());
    }
    Ok(())
}

fn verify_biometric_and_old_decoder(
    response: &crate::desktop_ipc::DesktopEnvelope<crate::desktop_ipc::DesktopResponse>,
    seeded: &SeededAccount,
) -> Result<(), Box<dyn std::error::Error>> {
    let script = r#"
const { decodeSingleBiometricTransferResponse } = await import("./apps/extension/src/background/biometric-transfer.ts");
const envelope = JSON.parse(await Bun.stdin.text());
const accountId = process.env.BITTERY_EXPECTED_ACCOUNT;
const decoded = decodeSingleBiometricTransferResponse(envelope, {
  accountId, challenge: "legacy-biometric-correlation-1",
});
if (envelope.protocolVersion !== 1 || envelope.requestId !== "legacy-biometric-1" ||
    envelope.type !== "BIOMETRIC_UNLOCK_SUCCESS" || !decoded.ok ||
    decoded.material.accountId !== accountId ||
    decoded.material.deviceKey.length !== 32 ||
    decoded.material.encryptedMuk.algorithm !== "AES-GCM-AAD-V1" ||
    typeof decoded.material.authToken !== "string" ||
    !decoded.material.vaultKeys?.some((vault) => vault.vaultId === process.env.BITTERY_EXPECTED_VAULT)) {
  throw new Error("unchanged old biometric decoder rejected current Core material or correlation");
}
"actual old biometric decoder consumed the controlled Core67 ceremony";
"#;
    let mut child = std::process::Command::new("bun")
        .arg("-e")
        .arg(script)
        .current_dir(
            Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("../../..")
                .canonicalize()?,
        )
        .env("BITTERY_EXPECTED_ACCOUNT", &seeded.account_id)
        .env("BITTERY_EXPECTED_VAULT", &seeded.vault_id)
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()?;
    let bytes = zeroize::Zeroizing::new(serde_json::to_vec(response)?);
    child
        .stdin
        .take()
        .ok_or("Old biometric consumer stdin was not piped")?
        .write_all(&bytes)?;
    let output = child.wait_with_output()?;
    if !output.status.success() {
        return Err(format!(
            "actual old biometric decoder rejected Core: {}",
            String::from_utf8_lossy(&output.stderr)
        )
        .into());
    }
    Ok(())
}

fn verify_biometric_all_and_old_decoder(
    response: &crate::desktop_ipc::DesktopEnvelope<crate::desktop_ipc::DesktopResponse>,
    seeded: &SeededAccount,
) -> Result<(), Box<dyn std::error::Error>> {
    let script = r#"
const { decodeAllBiometricTransferResponse } = await import("./apps/extension/src/background/biometric-transfer.ts");
const envelope = JSON.parse(await Bun.stdin.text());
const accountId = process.env.BITTERY_EXPECTED_ACCOUNT;
const decoded = decodeAllBiometricTransferResponse(envelope, {
  expectedAccountIds: [accountId], challenge: "legacy-biometric-all-correlation-1",
});
if (envelope.protocolVersion !== 1 || envelope.requestId !== "legacy-biometric-all-1" ||
    envelope.type !== "BIOMETRIC_UNLOCK_ALL_SUCCESS" || !decoded.ok ||
    JSON.stringify(envelope.unlocked) !== JSON.stringify([accountId]) ||
    JSON.stringify(envelope.failed) !== JSON.stringify([]) ||
    decoded.materials.length !== 1 || decoded.materials[0].accountId !== accountId ||
    decoded.materials[0].deviceKey.length !== 32 ||
    decoded.materials[0].encryptedMuk.algorithm !== "AES-GCM-AAD-V1" ||
    !decoded.materials[0].vaultKeys?.some((vault) => vault.vaultId === process.env.BITTERY_EXPECTED_VAULT)) {
  throw new Error("unchanged old all-biometric decoder rejected current Core material or correlation");
}
"actual old all-biometric decoder consumed one controlled Core67 prompt";
"#;
    let mut child = std::process::Command::new("bun")
        .arg("-e")
        .arg(script)
        .current_dir(
            Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("../../..")
                .canonicalize()?,
        )
        .env("BITTERY_EXPECTED_ACCOUNT", &seeded.account_id)
        .env("BITTERY_EXPECTED_VAULT", &seeded.vault_id)
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()?;
    let bytes = zeroize::Zeroizing::new(serde_json::to_vec(response)?);
    child
        .stdin
        .take()
        .ok_or("Old all-biometric consumer stdin was not piped")?
        .write_all(&bytes)?;
    let output = child.wait_with_output()?;
    if !output.status.success() {
        return Err(format!(
            "actual old all-biometric decoder rejected Core: {}",
            String::from_utf8_lossy(&output.stderr)
        )
        .into());
    }
    Ok(())
}

fn verify_biometric_status_and_old_client(
    response: &crate::desktop_ipc::DesktopEnvelope<crate::desktop_ipc::DesktopResponse>,
) -> Result<(), Box<dyn std::error::Error>> {
    let script = r#"
const { NativeMessagingClient } = await import("./apps/extension/src/background/native-messaging-client.ts");
const envelope = JSON.parse(await Bun.stdin.text());
let deliver;
const port = {
  onMessage: { addListener(listener) { deliver = listener; } },
  onDisconnect: { addListener() {} },
  postMessage(message) {
    if (message.protocolVersion !== 1 || message.requestId !== "desktop-123456789-1" ||
        message.type !== "CHECK_BIOMETRIC_AVAILABLE") throw new Error("old availability request changed");
    queueMicrotask(() => deliver(envelope));
  },
  disconnect() {},
};
Date.now = () => 123456789;
const client = new NativeMessagingClient({ connectNative: () => port });
const status = await client.request({ type: "CHECK_BIOMETRIC_AVAILABLE" });
if (status.type !== "BIOMETRIC_STATUS" || status.available !== true || status.enabled !== false ||
    status.appRunning !== true || status.requestId !== "desktop-123456789-1" ||
    status.protocolVersion !== 1) {
  throw new Error("unchanged old native client rejected Core67 headless availability");
}
"actual old native client consumed Core67 availability";
"#;
    let mut child = std::process::Command::new("bun")
        .arg("-e")
        .arg(script)
        .current_dir(
            Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("../../..")
                .canonicalize()?,
        )
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()?;
    let bytes = zeroize::Zeroizing::new(serde_json::to_vec(response)?);
    child
        .stdin
        .take()
        .ok_or("Old biometric status client stdin was not piped")?
        .write_all(&bytes)?;
    let output = child.wait_with_output()?;
    if !output.status.success() {
        return Err(format!(
            "actual old biometric status client rejected Core: {}",
            String::from_utf8_lossy(&output.stderr)
        )
        .into());
    }
    Ok(())
}
type SnapshotScrubAudit =
    Box<dyn Fn(&crate::desktop_ipc::DesktopEnvelope<crate::desktop_ipc::DesktopResponse>)>;

struct PrivateSnapshotResponse {
    envelope: crate::desktop_ipc::DesktopEnvelope<crate::desktop_ipc::DesktopResponse>,
    after_scrub: Option<SnapshotScrubAudit>,
}

impl PrivateSnapshotResponse {
    fn new(
        envelope: crate::desktop_ipc::DesktopEnvelope<crate::desktop_ipc::DesktopResponse>,
    ) -> Self {
        Self {
            envelope,
            after_scrub: None,
        }
    }
}

impl Drop for PrivateSnapshotResponse {
    fn drop(&mut self) {
        scrub_snapshot_secrets(&mut self.envelope);
        if let Some(audit) = self.after_scrub.take() {
            audit(&self.envelope);
        }
    }
}

fn scrub_snapshot_secrets(
    response: &mut crate::desktop_ipc::DesktopEnvelope<crate::desktop_ipc::DesktopResponse>,
) {
    fn scrub(value: &mut serde_json::Value) {
        match value {
            serde_json::Value::Object(fields) => {
                for (mut name, mut field) in std::mem::take(fields) {
                    scrub(&mut field);
                    name.zeroize();
                }
            }
            serde_json::Value::Array(values) => {
                let mut owned = std::mem::take(values);
                for field in &mut owned {
                    scrub(field);
                }
            }
            serde_json::Value::String(secret) => secret.zeroize(),
            _ => {}
        }
        *value = serde_json::Value::Null;
    }

    match &mut response.payload {
        crate::desktop_ipc::DesktopResponse::DesktopItemsSnapshot { items, .. } => {
            items.iter_mut().for_each(scrub);
        }
        crate::desktop_ipc::DesktopResponse::DesktopVaultKeys { vault_keys, .. } => {
            vault_keys.zeroize();
        }
        crate::desktop_ipc::DesktopResponse::DesktopAuthToken { auth_token, .. } => {
            auth_token.zeroize();
        }
        crate::desktop_ipc::DesktopResponse::BiometricUnlockSuccess {
            encrypted_session,
            device_key,
            signature,
            auth_token,
            vault_keys,
            ..
        } => {
            encrypted_session.zeroize();
            device_key.zeroize();
            signature.zeroize();
            if let Some(token) = auth_token {
                token.zeroize();
            }
            if let Some(keys) = vault_keys {
                keys.zeroize();
            }
        }
        crate::desktop_ipc::DesktopResponse::BiometricUnlockAllSuccess {
            device_key,
            signature,
            accounts,
            ..
        } => {
            device_key.zeroize();
            signature.zeroize();
            for account in accounts {
                account.encrypted_session.zeroize();
                if let Some(token) = &mut account.auth_token {
                    token.zeroize();
                }
                if let Some(keys) = &mut account.vault_keys {
                    keys.zeroize();
                }
            }
        }
        _ => {}
    }
}

#[test]
fn parsed_snapshot_scrub_clears_non_password_category_fields() {
    let mut response = crate::desktop_ipc::DesktopEnvelope::current(
        Some("scrub-canaries".to_owned()),
        crate::desktop_ipc::DesktopResponse::DesktopItemsSnapshot {
            items: vec![serde_json::json!({
                "category": "credit-card",
                "cvv": "cvv-canary",
                "totpSecret": "totp-canary",
                "customFields": [{ "label": "private-label", "value": "field-canary" }],
                "identity": { "ssn": "identity-canary" }
            })],
            generated_at: 1,
        },
    );
    scrub_snapshot_secrets(&mut response);
    let crate::desktop_ipc::DesktopResponse::DesktopItemsSnapshot { items, .. } = &response.payload
    else {
        panic!("expected snapshot");
    };
    assert!(items[0]["cvv"].is_null());
    assert!(items[0]["totpSecret"].is_null());
    assert!(items[0]["customFields"][0]["label"].is_null());
    assert!(items[0]["customFields"][0]["value"].is_null());
    assert!(items[0]["identity"]["ssn"].is_null());
}

#[test]
fn parsed_snapshot_owner_scrubs_non_password_data_on_success_and_early_error() {
    use std::{cell::Cell, rc::Rc};

    fn complete(owner: PrivateSnapshotResponse, early_error: bool) -> Result<(), &'static str> {
        let _owner = owner;
        if early_error {
            Err("fixture validation refused")?;
        }
        Ok(())
    }

    let audited = Rc::new(Cell::new(0));
    for early_error in [false, true] {
        let envelope = crate::desktop_ipc::DesktopEnvelope::current(
            Some("scrub-canaries".to_owned()),
            crate::desktop_ipc::DesktopResponse::DesktopItemsSnapshot {
                items: vec![serde_json::json!({
                    "category": "totp",
                    "totpSecret": "authenticator-canary",
                    "identity": { "ssn": "identity-canary" }
                })],
                generated_at: 1,
            },
        );
        let mut owner = PrivateSnapshotResponse::new(envelope);
        let observed = Rc::clone(&audited);
        owner.after_scrub = Some(Box::new(move |response| {
            let crate::desktop_ipc::DesktopResponse::DesktopItemsSnapshot { items, .. } =
                &response.payload
            else {
                panic!("expected snapshot");
            };
            assert!(items.iter().all(serde_json::Value::is_null));
            observed.set(observed.get() + 1);
        }));
        assert_eq!(complete(owner, early_error).is_err(), early_error);
    }
    assert_eq!(audited.get(), 2);
}

async fn wait_for_file(child: &mut Child, path: &Path) -> Result<(), Box<dyn std::error::Error>> {
    timeout(Duration::from_secs(120), async {
        loop {
            if path.exists() {
                return Ok::<(), io::Error>(());
            }
            if child.try_wait()?.is_some() {
                return Err(io::Error::other(
                    "Native Runtime fixture helper exited early",
                ));
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await??;
    Ok(())
}

fn write_private(path: std::path::PathBuf, bytes: &[u8]) -> io::Result<()> {
    let mut options = std::fs::OpenOptions::new();
    options.create(true).truncate(true).write(true);
    options.mode(0o600);
    options.open(path)?.write_all(bytes)
}
