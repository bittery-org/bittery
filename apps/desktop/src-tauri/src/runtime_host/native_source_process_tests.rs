//! Opt-in actual executable proof. The helper is the real NativeRuntime composition, not Tauri UI.
use super::*;
use bittery_client_core::{AuthClientConfig, ClientPlatform, NativeAuthoritySnapshot};
use std::{os::fd::AsRawFd, path::Path, process::Stdio, time::Duration};
use tokio::{
    io::AsyncRead,
    net::UnixListener,
    process::{Child, Command},
    time::{timeout, timeout_at, Instant},
};

use super::super::native::source_acceptance::{self, InstalledAccounts};

#[derive(serde::Serialize, serde::Deserialize)]
#[serde(tag = "type", rename_all = "camelCase", deny_unknown_fields)]
enum HelperControl {
    Lock {
        account_id: bittery_client_core::AccountId,
    },
    Unlock {
        account_id: bittery_client_core::AccountId,
    },
    Travel {
        account_id: bittery_client_core::AccountId,
        enabled: bool,
        restoration: TravelRestoration,
    },
    Shutdown,
}

#[derive(Clone, Copy, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
enum TravelRestoration {
    BorrowedTransfer,
    IndependentRevalidation,
}

impl TravelRestoration {
    fn label(self) -> &'static str {
        match self {
            Self::BorrowedTransfer => "borrowed",
            Self::IndependentRevalidation => "independent",
        }
    }

    fn marker(self, enabled: bool) -> String {
        format!("travel-{}-{enabled}", self.label())
    }
}

const CHILD_DIRECTORY: &str = "BITTERY_NATIVE_SOURCE_PROCESS_CHILD_DIRECTORY";
const TEST: &str =
    "runtime_host::native_source_transport::process_tests::real_native_binary_source_ports";

async fn helper(directory: &Path) -> Result<(), Box<dyn std::error::Error>> {
    let native = Arc::new(
        NativeRuntime::open(
            &directory.join("runtime"),
            AuthClientConfig::new(
                "native-source-process-proof".into(),
                ClientPlatform::Desktop,
                "test".into(),
            )?,
        )
        .await?,
    );
    let mut installed = if std::env::var_os("BITTERY_NATIVE_SOURCE_CREDENTIALS").is_some() {
        Some(InstalledAccounts::read().map_err(io::Error::other)?)
    } else {
        None
    };
    let mut accept = JoinSet::new();
    let result = async {
        if let Some(accounts) = installed.as_mut() {
            accounts.install(&native).await.map_err(io::Error::other)?;
        }
        let socket = crate::ipc_security::prepare_desktop_ipc_socket_path()?;
        let listener = UnixListener::bind(socket)?;
        let owner = native.clone();
        accept.spawn(async move {
            let mut ports = JoinSet::new();
            loop {
                tokio::select! {
                    result = listener.accept() => {
                        let (stream, _) = result?;
                        crate::ipc_security::authorize_unix_peer(stream.as_raw_fd(), crate::ipc_security::PeerRole::NativeHost,
                            crate::ipc_security::PeerPolicy::Required).map_err(io::Error::other)?;
                        ports.spawn(serve(owner.clone(), stream));
                    },
                    Some(_) = ports.join_next(), if !ports.is_empty() => {},
                }
            }
            #[allow(unreachable_code)]
            Ok::<(), io::Error>(())
        });
        std::fs::write(directory.join("ready"), serde_json::to_vec(
            &installed.as_ref().map(|accounts| accounts.ids()).unwrap_or_default())?)?;
        let mut input = tokio::io::stdin();
        loop {
            match read_frame_bounded::<_, HelperControl>(&mut input, INPUT_BYTES).await {
                Ok(HelperControl::Lock { account_id }) => InstalledAccounts::lock(&native, account_id).await.map_err(io::Error::other)?,
                Ok(HelperControl::Unlock { account_id }) => installed.as_ref().ok_or("No populated source fixture")?
                    .unlock(&native, &account_id).await.map_err(io::Error::other)?,
                Ok(HelperControl::Travel { account_id, enabled, restoration }) => {
                    installed.as_ref().ok_or("No populated source fixture")?
                        .set_travel(&native, &account_id, enabled).await.map_err(io::Error::other)?;
                    // A test control completion only; current authority still comes from native frames.
                    std::fs::write(directory.join(restoration.marker(enabled)), b"completed")?;
                },
                Ok(HelperControl::Shutdown) => break,
                Err(error) if error.kind() == io::ErrorKind::UnexpectedEof => break,
                Err(error) => return Err(error.into()),
            }
        }
        Ok::<(), Box<dyn std::error::Error>>(())
    }.await;
    // Cleanup runs after every completed control/install path, including parent EOF. A closed
    // evidence marker is written only after both scoped Server deletion and local teardown pass.
    let server_cleanup = match installed.as_ref() {
        Some(accounts) => accounts.delete_new_server_accounts(&native).await,
        None => Ok(()),
    };
    let local_cleanup = source_acceptance::cleanup(&native).await;
    let shutdown = native.shutdown().await;
    accept.abort_all();
    while accept.join_next().await.is_some() {}
    std::fs::write(
        directory.join("helper-outcome"),
        format!(
            "phase={}; server_cleanup={}; local_cleanup={}; shutdown={}",
            result
                .as_ref()
                .err()
                .map(|error| error.to_string())
                .unwrap_or_else(|| "complete".into()),
            server_cleanup
                .as_ref()
                .err()
                .cloned()
                .unwrap_or_else(|| "complete".into()),
            local_cleanup
                .as_ref()
                .err()
                .cloned()
                .unwrap_or_else(|| "complete".into()),
            if shutdown.is_ok() {
                "complete"
            } else {
                "failed"
            }
        ),
    )?;
    if server_cleanup.is_ok() && local_cleanup.is_ok() && shutdown.is_ok() {
        std::fs::write(
            directory.join("cleanup-complete"),
            b"scoped teardown complete",
        )?;
    }
    server_cleanup.map_err(io::Error::other)?;
    local_cleanup.map_err(io::Error::other)?;
    shutdown?;
    result
}

async fn reply<R: AsyncRead + Unpin>(
    reader: &mut R,
    id: &str,
) -> Result<NativeAuthoritySnapshot, Box<dyn std::error::Error>> {
    match read_response(reader, id, Duration::from_secs(10)).await? {
        NativeAuthorityResponse::Source { snapshot } => Ok(snapshot),
        _ => Err("Unexpected Core reply variant".into()),
    }
}

async fn read_response<R: AsyncRead + Unpin>(
    reader: &mut R,
    id: &str,
    wait: Duration,
) -> Result<NativeAuthorityResponse, Box<dyn std::error::Error>> {
    let deadline = Instant::now() + wait;
    loop {
        let message: NativeRuntimeMessage =
            timeout_at(deadline, read_frame_bounded(reader, OUTPUT_BYTES)).await??;
        match message {
            NativeRuntimeMessage::Authority { .. } => {}
            NativeRuntimeMessage::Reply {
                request_id,
                failed: false,
                payload,
            } if request_id == id => {
                return Ok(serde_json::from_str(&payload)?);
            }
            NativeRuntimeMessage::Reply {
                request_id,
                failed,
                payload,
            } => {
                // Report closed error codes and correlation only; native payloads may contain keys.
                let code = if failed {
                    serde_json::from_str::<RuntimeError>(&payload)
                        .ok()
                        .map(|error| error.code)
                } else {
                    None
                };
                return Err(format!(
                    "Native reply for {id}: received {request_id}, failed={failed}, code={code:?}"
                )
                .into());
            }
            NativeRuntimeMessage::Cancelled { request_id } => {
                return Err(format!("Native reply for {id} was cancelled: {request_id}").into());
            }
        }
    }
}

fn launch(path: &Path, directory: &Path, origin: &str) -> io::Result<Child> {
    Command::new(path)
        .arg(origin)
        .env("XDG_RUNTIME_DIR", directory)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .spawn()
}

#[tokio::test]
#[ignore = "Requires an explicitly built real native host binary; launches isolated actual OS peer-checked processes"]
async fn real_native_binary_source_ports() -> Result<(), Box<dyn std::error::Error>> {
    if let Some(directory) = std::env::var_os(CHILD_DIRECTORY) {
        return helper(Path::new(&directory)).await;
    }
    let binary = std::env::var_os("BITTERY_NATIVE_HOST_ACCEPTANCE_BINARY").ok_or(
        "BITTERY_NATIVE_HOST_ACCEPTANCE_BINARY must name the actual native host executable",
    )?;
    // E2E sets a long repository TMPDIR; Unix sockets have a fixed SUN_LEN path bound.
    // Use a short private installation while retaining the production peer/path verification.
    let directory = tempfile::Builder::new().prefix("bns-").tempdir_in("/tmp")?;
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(directory.path(), std::fs::Permissions::from_mode(0o700))?;
    // Existing peer verification requires sibling canonical installed executable names. The test
    // copies actual built executables into an isolated installation, with no identity bypass.
    let desktop_path = directory.path().join("Bittery");
    let host_path = directory.path().join("bittery-native-host");
    std::fs::copy(std::env::current_exe()?, &desktop_path)?;
    std::fs::copy(binary, &host_path)?;
    let mut desktop = Command::new(desktop_path)
        .args(["--exact", TEST, "--ignored", "--nocapture"])
        .env(CHILD_DIRECTORY, directory.path())
        .env("XDG_RUNTIME_DIR", directory.path())
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .spawn()?;
    let mut hosts = Vec::<Child>::new();
    let result = async {
        timeout(Duration::from_secs(90), async {
            while !directory.path().join("ready").exists() {
                if desktop.try_wait()?.is_some() {
                    return Err(io::Error::other(
                        "Native Runtime helper exited before readiness",
                    ));
                }
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
            Ok::<(), io::Error>(())
        })
        .await??;
        let origin = &crate::native_messaging_installer::allowed_extension_origins()[0];
        hosts.push(launch(
            &host_path,
            directory.path(),
            "chrome-extension://untrusted/",
        )?);
        if timeout(Duration::from_secs(10), hosts.last_mut().unwrap().wait()).await??.success() {
            return Err("Native executable admitted a foreign browser origin".into());
        }
        hosts.pop();
        let mut scopes = Vec::new();
        for index in 0..2 {
            hosts.push(launch(&host_path, directory.path(), origin)?);
            let host = hosts.last_mut().unwrap();
            let id = format!("connect-{index}");
            write_frame_bounded(
                host.stdin.as_mut().unwrap(),
                &NativeRuntimeRequest {
                    protocol_version: RUNTIME_NATIVE_PROTOCOL_VERSION,
                    request_id: id.clone(),
                    command: NativeRuntimeCommand::Connect {},
                },
                INPUT_BYTES,
            )
            .await?;
            scopes.push(reply(host.stdout.as_mut().unwrap(), &id).await?);
        }
        let desktop_pid = desktop.id().ok_or("Missing actual Desktop helper PID")?;
        let first_pid = hosts[0].id().ok_or("Missing first actual native host PID")?;
        let second_pid = hosts[1].id().ok_or("Missing second actual native host PID")?;
        if first_pid == second_pid || first_pid == desktop_pid || second_pid == desktop_pid
            || scopes[0].owner_id != scopes[1].owner_id || scopes[0].channel_id == scopes[1].channel_id {
            return Err("Actual native process or Core channel identity mismatch".into());
        }
        if std::env::var_os("BITTERY_NATIVE_SOURCE_CREDENTIALS").is_some() {
            populated_transfer(&mut hosts[0], &mut desktop, &scopes[0], directory.path()).await?;
        } else if scopes.iter().any(|scope| !scope.accounts.is_empty()) {
            return Err("Expected isolated empty native catalogs".into());
        }
        // Actual first native process EOF must not detach the second Core source channel.
        drop(hosts[0].stdin.take());
        timeout(Duration::from_secs(10), hosts[0].wait()).await??;
        write_frame_bounded(
            hosts[1].stdin.as_mut().unwrap(),
            &NativeRuntimeRequest {
                protocol_version: RUNTIME_NATIVE_PROTOCOL_VERSION,
                request_id: "after-other-eof".into(),
                command: NativeRuntimeCommand::Snapshot {},
            },
            INPUT_BYTES,
        )
        .await?;
        let surviving = reply(hosts[1].stdout.as_mut().unwrap(), "after-other-eof").await?;
        if surviving.channel_id != scopes[1].channel_id { return Err("Sibling channel was replaced".into()); }
        // The second browser stdin is still open: actual Desktop Core loss must end the proxy.
        write_frame_bounded(desktop.stdin.as_mut().unwrap(), &HelperControl::Shutdown, INPUT_BYTES).await?;
        let status = timeout(Duration::from_secs(70), desktop.wait()).await??;
        if !status.success() { return Err("Native Runtime helper did not shut down cleanly".into()); }
        timeout(Duration::from_secs(10), hosts[1].wait()).await??;
        eprintln!("Observed actual NativeRuntime helper PID {desktop_pid}; native host PIDs {first_pid} and {second_pid}; independent EOF and Desktop shutdown passed");
        Ok::<(), Box<dyn std::error::Error>>(())
    }
    .await;
    let phase_outcome = result
        .as_ref()
        .err()
        .map(|error| error.to_string())
        .unwrap_or_else(|| "complete".into());
    let evidence_write_failed =
        std::fs::write(directory.path().join("parent-outcome"), &phase_outcome).is_err();
    // EOF asks the helper to perform the same scoped cleanup even if a test phase failed.
    drop(desktop.stdin.take());
    let helper_finished = timeout(Duration::from_secs(70), desktop.wait()).await;
    let mut cleanup_errors = Vec::new();
    if evidence_write_failed {
        cleanup_errors.push("parent outcome write failed");
    }
    for child in &mut hosts {
        match child.try_wait() {
            Ok(Some(_)) => {}
            Ok(None) => {
                if child.kill().await.is_err() {
                    cleanup_errors.push("native process kill failed");
                }
            }
            Err(_) => cleanup_errors.push("native process status failed"),
        }
        if child.wait().await.is_err() {
            cleanup_errors.push("native process reap failed");
        }
    }
    if helper_finished.is_err() {
        if desktop.kill().await.is_err() {
            cleanup_errors.push("Desktop helper kill failed");
        }
        if desktop.wait().await.is_err() {
            cleanup_errors.push("Desktop helper reap failed");
        }
        cleanup_errors.push("Desktop helper cleanup timed out");
    } else if matches!(&helper_finished, Ok(Err(_))) {
        cleanup_errors.push("Desktop helper status failed");
    }
    if directory.path().join("destination").exists()
        && !directory.path().join("consumer-cleanup-complete").exists()
    {
        cleanup_errors.push("consumer local cleanup was not proven complete");
    }
    if !cleanup_errors.is_empty() || !directory.path().join("cleanup-complete").exists() {
        let outcome = std::fs::read_to_string(directory.path().join("helper-outcome"))
            .unwrap_or_else(|_| "Helper did not record completed cleanup".into());
        let retained = directory.keep();
        return Err(io::Error::other(format!(
            "Scoped native acceptance cleanup incomplete (parent phase: {phase_outcome}; {outcome}; process errors: {cleanup_errors:?}); isolated evidence retained at {}",
            retained.display()
        ))
        .into());
    }
    helper_finished??;
    result
}

async fn exported(
    host: &mut Child,
    id: &str,
    challenge: bittery_client_core::NativeImportChallenge,
) -> Result<bittery_client_core::NativeTransferReply, Box<dyn std::error::Error>> {
    write_frame_bounded(
        host.stdin.as_mut().ok_or("Native input is closed")?,
        &NativeRuntimeRequest {
            protocol_version: RUNTIME_NATIVE_PROTOCOL_VERSION,
            request_id: id.into(),
            command: NativeRuntimeCommand::Export {
                challenge: serde_json::to_string(&challenge)?,
            },
        },
        INPUT_BYTES,
    )
    .await?;
    let response = read_response(
        host.stdout.as_mut().ok_or("Native output is closed")?,
        id,
        Duration::from_secs(15),
    )
    .await;
    if response.is_err() {
        let diagnosis = async {
        // Diagnose a refused captured challenge using only nonsecret current authority facts.
        let diagnostic_id = format!("{id}-refusal-snapshot");
        write_frame_bounded(
            host.stdin.as_mut().ok_or("Native input is closed")?,
            &NativeRuntimeRequest {
                protocol_version: RUNTIME_NATIVE_PROTOCOL_VERSION,
                request_id: diagnostic_id.clone(),
                command: NativeRuntimeCommand::Snapshot {},
            },
            INPUT_BYTES,
        )
        .await?;
        let snapshot = reply(
            host.stdout.as_mut().ok_or("Native output is closed")?,
            &diagnostic_id,
        )
        .await?;
        if let Some(current) = snapshot
            .accounts
            .iter()
            .find(|account| account.scope.account_id == challenge.source.account_id)
        {
            eprintln!("Native export refusal source diagnostics: same_scope={}, captured_generation={}, current_generation={}, unlocked={}, key_authorization_available={}, policy_verification={:?}",
                current.scope == challenge.source, challenge.source_key_generation, current.key_generation,
                current.unlocked, current.key_authorization_available, current.policy_verification);
        } else {
            eprintln!("Native export refusal source diagnostics: captured Account absent");
        }
        Ok::<(), Box<dyn std::error::Error>>(())
        }.await;
        if diagnosis.is_err() {
            eprintln!("Native export refusal source diagnostics: fresh snapshot unavailable");
        }
    }
    match response? {
        NativeAuthorityResponse::Exported { reply } => Ok(reply),
        _ => Err("Expected a Core encrypted export".into()),
    }
}

async fn populated_transfer(
    host: &mut Child,
    desktop: &mut Child,
    source: &NativeAuthoritySnapshot,
    directory: &Path,
) -> Result<(), Box<dyn std::error::Error>> {
    if source.accounts.len() != 2 {
        return Err("Expected two actual signed-in source Accounts".into());
    }
    // This second composition is a real shared Core consumer of actual native frames. It is not
    // the production offscreen/IndexedDB Extension host and is labelled separately in evidence.
    let mut destination = NativeRuntime::open(
        directory.join("destination"),
        AuthClientConfig::new(
            "native-source-destination-proof".into(),
            ClientPlatform::Extension,
            "test".into(),
        )?,
    )
    .await?;
    let mut accounts = InstalledAccounts::read().map_err(io::Error::other)?;
    let result = async {
        accounts.install(&destination).await.map_err(io::Error::other)?;
        let control = source_acceptance::destination_control(&destination);
        let channel = control.attach_desktop(source.clone(), "actual-native-port".into()).await?;
        // Both independent Accounts were already unlocked. Attaching an unlocked Desktop does
        // not retire that access; preparing each import retires its destination before binding.
        for id in accounts.ids() { source_acceptance::require_access(&destination, id, bittery_client_core::AccountAccessState::Unlocked, "initial unlocked Desktop attachment").map_err(io::Error::other)?; }
        for (index, authority) in source.accounts.iter().enumerate() {
            let challenge = control.prepare_import_for_source(&channel, &authority.scope.account_id, true).await?;
            source_acceptance::require_access(&destination, &challenge.destination.account_id, bittery_client_core::AccountAccessState::Locked, "import preparation").map_err(io::Error::other)?;
            let reply = exported(host, &format!("export-{index}"), challenge).await?;
            control.complete_import(reply).await?;
        }
        accounts.wait_for_items(&destination).await.map_err(io::Error::other)?;
        let challenge = control.prepare_import_for_source(&channel, &source.accounts[0].scope.account_id, true).await?;
        let previous_owner_reply = exported(host, "previous-owner-export", challenge).await?;
        destination.shutdown().await?;
        drop(control);
        destination = NativeRuntime::open(
            directory.join("destination"),
            AuthClientConfig::new("native-source-destination-proof".into(), ClientPlatform::Extension, "test".into())?,
        ).await?;
        for id in accounts.ids() { source_acceptance::require_access(&destination, id, bittery_client_core::AccountAccessState::Locked, "consumer Runtime owner replacement").map_err(io::Error::other)?; }
        let control = source_acceptance::destination_control(&destination);
        let channel = control.attach_desktop(source.clone(), "replacement-consumer-owner".into()).await?;
        if control.complete_import(previous_owner_reply).await.is_ok() { return Err("Delayed native export survived consumer Runtime owner replacement".into()); }
        let mut first_destination = None;
        for (index, authority) in source.accounts.iter().enumerate() {
            let challenge = control.prepare_import_for_source(&channel, &authority.scope.account_id, true).await?;
            if index == 0 { first_destination = Some(challenge.destination.account_id.clone()); }
            let reply = exported(host, &format!("replacement-export-{index}"), challenge).await?;
            control.complete_import(reply).await?;
        }
        accounts.wait_for_items(&destination).await.map_err(io::Error::other)?;
        let first_destination = first_destination.ok_or("Missing native destination binding")?;
        populated_travel(host, desktop, directory, &destination, &accounts,
            (&source.accounts[0].scope.account_id, &first_destination),
            (&control, &channel, TravelRestoration::BorrowedTransfer)).await?;
        // Standalone unlock is permitted only after disconnecting the Desktop authority.
        // A fresh source port starts its own restriction prefix before independent reattachment.
        control.retire_channel(&channel).await?;
        drop(host.stdin.take());
        timeout(Duration::from_secs(10), host.wait()).await??;
        for id in accounts.ids() {
            accounts.unlock(&destination, id).await.map_err(io::Error::other)?;
        }
        let host_path = directory.join("bittery-native-host");
        let origin = &crate::native_messaging_installer::allowed_extension_origins()[0];
        *host = launch(&host_path, directory, origin)?;
        let independent_pid = host.id().ok_or("Missing independent reattachment process")?;
        write_frame_bounded(host.stdin.as_mut().ok_or("Native input closed")?,
            &NativeRuntimeRequest {
                protocol_version: RUNTIME_NATIVE_PROTOCOL_VERSION,
                request_id: "independent-reconnect".into(),
                command: NativeRuntimeCommand::Connect {},
            }, INPUT_BYTES).await?;
        let independent_source = reply(host.stdout.as_mut().ok_or("Native output closed")?, "independent-reconnect").await?;
        let channel = control.attach_desktop(independent_source, "independently-unlocked-consumer".into()).await?;
        eprintln!("Actual native consumer disconnected, unlocked its own Accounts, and reattached through native host PID {independent_pid}");
        populated_travel(host, desktop, directory, &destination, &accounts,
            (&source.accounts[0].scope.account_id, &first_destination),
            (&control, &channel, TravelRestoration::IndependentRevalidation)).await?;
        let first = &source.accounts[0].scope.account_id;
        let challenge = control.prepare_import_for_source(&channel, first, true).await?;
        let locked_destination = challenge.destination.account_id.clone();
        let delayed_reply = exported(host, "held-export", challenge).await?;
        write_frame_bounded(desktop.stdin.as_mut().ok_or("Desktop control closed")?, &HelperControl::Lock { account_id: first.clone() }, INPUT_BYTES).await?;
        let locked = timeout(Duration::from_secs(15), async {
            loop {
                let message: NativeRuntimeMessage = read_frame_bounded(host.stdout.as_mut().ok_or_else(|| io::Error::other("Native output closed"))?, OUTPUT_BYTES).await?;
                if let NativeRuntimeMessage::Authority { payload } = message {
                    let NativeAuthorityResponse::Source { snapshot } = serde_json::from_str(&payload).map_err(io::Error::other)? else { return Err(io::Error::other("Expected source authority event")); };
                    if snapshot.accounts.iter().any(|account| &account.scope.account_id == first && !account.unlocked) { return Ok(snapshot); }
                }
            }
        }).await??;
        if locked.accounts.iter().filter(|account| account.unlocked).count() != 1 { return Err("Lock affected the wrong source Account scope".into()); }
        control.apply_authority(&channel, locked).await?;
        if control.complete_import(delayed_reply).await.is_ok() { return Err("Delayed native export survived actual Desktop Lock".into()); }
        for id in accounts.ids() {
            let expected = if id == &locked_destination { bittery_client_core::AccountAccessState::Locked } else { bittery_client_core::AccountAccessState::Unlocked };
            source_acceptance::require_access(&destination, id, expected, "selective Desktop Lock").map_err(io::Error::other)?;
        }
        drop(host.stdin.take());
        timeout(Duration::from_secs(10), host.wait()).await??;
        control.retire_channel(&channel).await?;
        for id in accounts.ids() { accounts.unlock(&destination, id).await.map_err(io::Error::other)?; }
        eprintln!("Actual native binary exported keys for two real Server Accounts; own-Replica reads, consumer Runtime replacement with fresh grants, selective Desktop Lock, delayed reply refusal and explicit standalone Quick Unlock passed; production Extension remains a separate gate");
        Ok::<(), Box<dyn std::error::Error>>(())
    }.await;
    let cleanup = source_acceptance::cleanup(&destination)
        .await
        .map_err(io::Error::other);
    let shutdown = destination.shutdown().await;
    if cleanup.is_err() || shutdown.is_err() {
        return Err(io::Error::other(format!(
            "Native consumer phase={}; local_cleanup={}; shutdown={}",
            result
                .as_ref()
                .err()
                .map(|error| error.to_string())
                .unwrap_or_else(|| "complete".into()),
            cleanup
                .as_ref()
                .err()
                .map(|error| error.to_string())
                .unwrap_or_else(|| "complete".into()),
            if shutdown.is_ok() {
                "complete"
            } else {
                "failed"
            },
        ))
        .into());
    }
    std::fs::write(
        directory.join("consumer-cleanup-complete"),
        b"scoped consumer teardown complete",
    )?;
    result
}

async fn populated_travel(
    host: &mut Child,
    desktop: &mut Child,
    directory: &Path,
    destination: &NativeRuntime,
    accounts: &InstalledAccounts,
    (source_account, destination_account): (
        &bittery_client_core::AccountId,
        &bittery_client_core::AccountId,
    ),
    (control, channel, restoration): (
        &bittery_client_core::NativeAuthorityFacade,
        &str,
        TravelRestoration,
    ),
) -> Result<(), Box<dyn std::error::Error>> {
    let hidden = accounts
        .hidden_vault_id(destination_account)
        .map_err(io::Error::other)?;
    let unrelated_ids: Vec<_> = {
        let before = source_acceptance::items(destination, destination_account)
            .map_err(io::Error::other)?
            .ok_or("Native Travel consumer is not readable")?;
        if !before.items.iter().any(|item| item.vault_id == hidden)
            || !before.items.iter().any(|item| item.vault_id != hidden)
        {
            return Err("Native Travel requires populated selected and unrelated Vaults".into());
        }
        before
            .items
            .iter()
            .filter(|item| item.vault_id != hidden)
            .map(|item| item.item_id.clone())
            .collect()
    };
    let pending_move = match restoration {
        TravelRestoration::BorrowedTransfer => Some(
            accounts
                .accept_pending_move(destination, destination_account, directory)
                .await
                .map_err(io::Error::other)?,
        ),
        TravelRestoration::IndependentRevalidation => None,
    };
    for enabled in [true, false] {
        write_frame_bounded(
            desktop.stdin.as_mut().ok_or("Desktop control closed")?,
            &HelperControl::Travel {
                account_id: source_account.clone(),
                enabled,
                restoration,
            },
            INPUT_BYTES,
        )
        .await?;
        let deadline = tokio::time::Instant::now() + Duration::from_secs(60);
        let mut sequence = 0;
        loop {
            sequence += 1;
            let id = format!("travel-{}-{enabled}-{sequence}", restoration.label());
            write_frame_bounded(
                host.stdin.as_mut().ok_or("Native input closed")?,
                &NativeRuntimeRequest {
                    protocol_version: RUNTIME_NATIVE_PROTOCOL_VERSION,
                    request_id: id.clone(),
                    command: NativeRuntimeCommand::Snapshot {},
                },
                INPUT_BYTES,
            )
            .await?;
            let snapshot = reply(host.stdout.as_mut().ok_or("Native output closed")?, &id).await?;
            control.apply_authority(channel, snapshot.clone()).await?;
            let source_ready = snapshot.accounts.iter().any(|account| {
                &account.scope.account_id == source_account
                    && account.unlocked
                    && account.key_authorization_available
                    && !matches!(
                        account.policy_verification,
                        Some(bittery_client_core::NativePolicyVerification::Pending { .. })
                    )
            });
            let command_done = directory.join(restoration.marker(enabled)).exists();
            let visible = source_acceptance::items(destination, destination_account)
                .map_err(io::Error::other)?;
            if source_ready
                && command_done
                && visible.as_ref().is_some_and(|items| {
                    !items.vaults.iter().any(|vault| vault.vault_id == hidden)
                        && !items.items.iter().any(|item| item.vault_id == hidden)
                        && unrelated_ids
                            .iter()
                            .all(|id| items.items.iter().any(|item| &item.item_id == id))
                })
            {
                break;
            }
            if tokio::time::Instant::now() >= deadline {
                return Err(
                    "Native Travel did not conserve selected restriction and unrelated access"
                        .into(),
                );
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        for id in accounts.ids() {
            source_acceptance::require_access(
                destination,
                id,
                bittery_client_core::AccountAccessState::Unlocked,
                "connected Travel restriction",
            )
            .map_err(io::Error::other)?;
        }
        accounts
            .wait_for_items(destination)
            .await
            .map_err(io::Error::other)?;
        if enabled {
            let acknowledgement = control.restriction_acknowledgement(channel)?;
            if acknowledgement.frontier == 0 || !acknowledgement.adoptions.iter().any(|adoption|
                matches!(&adoption.disposition, bittery_client_core::NativeRestrictionDisposition::JournalOwned { account_id, .. }
                    if account_id == destination_account)) {
                return Err("Native Travel ACK did not prove the consumer's exact durable adoption".into());
            }
            for suffix in ["acknowledge", "acknowledge-replay"] {
                let id = format!("travel-{}-{suffix}", restoration.label());
                write_frame_bounded(
                    host.stdin.as_mut().ok_or("Native input closed")?,
                    &NativeRuntimeRequest {
                        protocol_version: RUNTIME_NATIVE_PROTOCOL_VERSION,
                        request_id: id.clone(),
                        command: NativeRuntimeCommand::AcknowledgeRestrictions {
                            acknowledgement: serde_json::to_string(&acknowledgement)?,
                        },
                    },
                    INPUT_BYTES,
                )
                .await?;
                if !matches!(
                    read_response(
                        host.stdout.as_mut().ok_or("Native output closed")?,
                        &id,
                        Duration::from_secs(10),
                    )
                    .await?,
                    NativeAuthorityResponse::Applied
                ) {
                    return Err("Native Travel ACK returned another Core result".into());
                }
            }
            let id = format!("after-travel-{}-acknowledgement", restoration.label());
            write_frame_bounded(
                host.stdin.as_mut().ok_or("Native input closed")?,
                &NativeRuntimeRequest {
                    protocol_version: RUNTIME_NATIVE_PROTOCOL_VERSION,
                    request_id: id.clone(),
                    command: NativeRuntimeCommand::Snapshot {},
                },
                INPUT_BYTES,
            )
            .await?;
            let acknowledged =
                reply(host.stdout.as_mut().ok_or("Native output closed")?, &id).await?;
            if !acknowledged.restrictions.is_empty()
                || acknowledged.restriction_frontier != acknowledgement.frontier
                || acknowledged.restriction_chain_digest != acknowledgement.chain_digest
            {
                return Err(
                    "Actual native ACK did not consume its exact source restriction prefix".into(),
                );
            }
            control.apply_authority(channel, acknowledged).await?;
        }
        if let Some(pending) = &pending_move {
            pending
                .require_hidden_and_retained(destination)
                .map_err(io::Error::other)?;
        }
    }
    // Disabled Server policy and ready source authority do not clear existing exclusions.
    match restoration {
        TravelRestoration::BorrowedTransfer => {
            let challenge = control
                .prepare_import_for_source(channel, source_account, true)
                .await?;
            if &challenge.destination.account_id != destination_account {
                return Err(
                    "Fresh native Travel transfer changed destination Account identity".into(),
                );
            }
            let transfer = exported(host, "travel-fresh-transfer", challenge).await?;
            control.complete_import(transfer).await?;
        }
        TravelRestoration::IndependentRevalidation => {
            revalidate_independent(host, control, channel, source_account, destination_account)
                .await?;
        }
    }
    timeout(Duration::from_secs(60), async {
        loop {
            if source_acceptance::items(destination, destination_account)
                .map_err(io::Error::other)?
                .is_some_and(|items| {
                    items.items.iter().any(|item| item.vault_id == hidden)
                        && unrelated_ids
                            .iter()
                            .all(|id| items.items.iter().any(|item| &item.item_id == id))
                })
            {
                return Ok::<(), io::Error>(());
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    })
    .await??;
    accounts
        .wait_for_items(destination)
        .await
        .map_err(io::Error::other)?;
    if let Some(pending) = &pending_move {
        pending
            .converge(destination)
            .await
            .map_err(io::Error::other)?;
    }
    match restoration {
        TravelRestoration::BorrowedTransfer => eprintln!("Actual native binary Travel restriction and acknowledgement preserved unrelated Vault and Account access; only fresh transfer restored hidden authority"),
        TravelRestoration::IndependentRevalidation => eprintln!("Actual native binary independently revalidated hidden authority after explicit local unlock; unrelated Vault and Account reads remained available"),
    }
    Ok(())
}

async fn revalidate_independent(
    host: &mut Child,
    control: &bittery_client_core::NativeAuthorityFacade,
    channel: &str,
    source_account: &bittery_client_core::AccountId,
    destination_account: &bittery_client_core::AccountId,
) -> Result<(), Box<dyn std::error::Error>> {
    let prepared = control
        .invoke(Zeroizing::new(serde_json::to_string(
            &bittery_client_core::NativeAuthorityRequest::PrepareIndependentRevalidation {
                channel_id: channel.into(),
                source_account: source_account.clone(),
            },
        )?))
        .await?;
    let NativeAuthorityResponse::Prepared { challenge } = serde_json::from_str(&prepared)? else {
        return Err("Independent native revalidation did not prepare a challenge".into());
    };
    if &challenge.destination.account_id != destination_account || challenge.new_destination {
        return Err("Independent native revalidation changed destination identity".into());
    }
    let id = "travel-independent-revalidation";
    write_frame_bounded(
        host.stdin.as_mut().ok_or("Native input closed")?,
        &NativeRuntimeRequest {
            protocol_version: RUNTIME_NATIVE_PROTOCOL_VERSION,
            request_id: id.into(),
            command: NativeRuntimeCommand::RevalidateIndependentRestrictions {
                challenge: serde_json::to_string(&challenge)?,
            },
        },
        INPUT_BYTES,
    )
    .await?;
    let NativeAuthorityResponse::IndependentRestrictionsRevalidated { reply } = read_response(
        host.stdout.as_mut().ok_or("Native output closed")?,
        id,
        Duration::from_secs(15),
    )
    .await?
    else {
        return Err("Independent native revalidation returned another source result".into());
    };
    let completed = control
        .invoke(Zeroizing::new(serde_json::to_string(
            &bittery_client_core::NativeAuthorityRequest::CompleteIndependentRevalidation { reply },
        )?))
        .await?;
    if !matches!(
        serde_json::from_str(&completed)?,
        NativeAuthorityResponse::Applied
    ) {
        return Err("Independent native revalidation did not complete".into());
    }
    Ok(())
}
