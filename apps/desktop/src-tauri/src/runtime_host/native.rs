//! Native assembly of the shared Core; production host cutover is a separate ticket.

use super::{
    binary_transfer::NativeBinaryTransfer,
    connection::RuntimeConnection,
    device_lease::{DeviceLeaseMode, NativeDeviceLease},
    file_capabilities::NativeFileCapabilities,
    files::NativeFiles,
    http::NativeHttpExecutor,
    lease::NativeAccountLeases,
    recovery::NativeRecovery,
    recovery_files::NativeRecoveryFiles,
    storage::{NativePlatformStorage, OpenedStorage},
    vault_image_source::NativeVaultImageSources,
};
use bittery_client_core::{
    AttachmentDownloadFacade, AttachmentMovePreparationFacade, AttachmentUploadFacade,
    AuthClientConfig, Runtime, RuntimeError, RuntimeErrorCode, SqliteAttachmentArtifactStore,
    SqliteReplica, SqliteVaultImageArtifactStore, VaultImageIngressFacade,
};
use std::{path::Path, sync::Arc};
use tokio::{sync::watch, task::JoinHandle};

type RuntimeRunner = JoinHandle<Result<(), RuntimeError>>;

/// Owns the process Runtime and drives its futures. Renderer attachments own only their callers.
/// The application must await `shutdown` before retiring this owner.
pub(super) struct NativeRuntime {
    core: Arc<Runtime>,
    runners: std::sync::Mutex<Option<Vec<RuntimeRunner>>>,
    shutdown_result: watch::Sender<Option<Result<(), RuntimeError>>>,
    leases: Option<Arc<NativeAccountLeases>>,
    file_capabilities: Arc<NativeFileCapabilities>,
    image_sources: Option<Arc<NativeVaultImageSources>>,
    recovery_files: Arc<NativeRecoveryFiles>,
    startup_error: Option<RuntimeError>,
    device_gate: Arc<std::sync::Mutex<Option<NativeDeviceLease>>>,
}

impl NativeRuntime {
    pub(super) async fn open(
        directory: impl AsRef<Path>,
        config: AuthClientConfig,
    ) -> Result<Self, RuntimeError> {
        let directory = directory.as_ref().to_path_buf();
        let storage_directory = directory.clone();
        let (replica, platform, artifacts, images, files, leases, device_lease) =
            tokio::task::spawn_blocking(move || {
                let directory = storage_directory;
                std::fs::create_dir_all(&directory).map_err(|_| storage_unavailable())?;
                let device_lease =
                    NativeDeviceLease::try_acquire(&directory, DeviceLeaseMode::Shared)?
                        .ok_or_else(storage_unavailable)?;
                Ok::<_, RuntimeError>((
                    SqliteReplica::open(directory.join("replica.sqlite")),
                    NativePlatformStorage::open(directory.join("platform.sqlite")),
                    SqliteAttachmentArtifactStore::open(directory.join("attachments.sqlite")),
                    SqliteVaultImageArtifactStore::open(directory.join("vault-images.sqlite")),
                    NativeFiles::open(directory.join("host-files")),
                    NativeAccountLeases::open(directory.join("account-leases")),
                    device_lease,
                ))
            })
            .await
            .map_err(|_| storage_unavailable())??;
        let mut startup_error = [
            replica.as_ref().err(),
            platform.as_ref().err(),
            artifacts.as_ref().err(),
            images.as_ref().err(),
            files.as_ref().err(),
            leases.as_ref().err(),
        ]
        .into_iter()
        .flatten()
        .next()
        .cloned();
        let replica = Arc::new(OpenedStorage(replica));
        let platform = Arc::new(OpenedStorage(platform));
        let files = files.ok().map(Arc::new);
        let leases = leases.ok().map(Arc::new);
        let transfer = files
            .as_ref()
            .map(|files| NativeBinaryTransfer::new(files.clone()).map(Arc::new))
            .transpose()?;
        let http = Arc::new(NativeHttpExecutor::new()?);
        let file_capabilities = Arc::new(NativeFileCapabilities::default());
        let mut image_sources = None;
        let core = if startup_error.is_none() {
            let artifacts = Arc::new(artifacts.expect("Successful native storage admission"));
            let preparation = AttachmentMovePreparationFacade::new(
                artifacts.clone(),
                artifacts,
                transfer.as_ref().expect("Native transfer admitted").clone(),
            );
            let core =
                Runtime::with_configured_serialized_executors_and_attachment_move_preparation(
                    replica,
                    platform,
                    http,
                    config,
                    preparation,
                    leases.as_ref().expect("Native lease admitted").clone(),
                );
            let incarnation = bittery_crypto_core::generate_uuid();
            let sources = Arc::new(
                NativeVaultImageSources::new(incarnation.clone())
                    .map_err(|_| storage_unavailable())?,
            );
            core.install_vault_image_ingress(VaultImageIngressFacade::new(
                incarnation,
                sources.clone(),
                Arc::new(images.expect("Native image store admitted")),
            )?);
            image_sources = Some(sources);
            core
        } else {
            Runtime::with_configured_serialized_executors(replica, platform, http, config)
        };
        if let Some(transfer) = transfer {
            core.install_attachment_upload(AttachmentUploadFacade::new(
                file_capabilities.clone(),
                transfer.clone(),
            ));
            core.install_attachment_download(AttachmentDownloadFacade::new(
                transfer,
                file_capabilities.clone(),
            ));
        }
        if let Some(files) = files {
            core.install_teardown_host_cleanup(files);
        }
        let device_gate = Arc::new(std::sync::Mutex::new(Some(device_lease)));
        let recovery_files = Arc::new(NativeRecoveryFiles::default());
        core.set_recovery_executor(Arc::new(NativeRecovery::new(
            directory,
            device_gate.clone(),
            recovery_files.clone(),
        )))?;
        if startup_error.is_none() {
            startup_error = core.open().await.err();
        }
        let mut runners = Vec::new();
        if startup_error.is_none() {
            let dispatch_core = core.clone();
            runners.push(tokio::spawn(async move {
                dispatch_core.run_operation_dispatch().await;
                Ok(())
            }));
            let sync_core = core.clone();
            runners.push(tokio::spawn(async move {
                sync_core.run_live_sync().await;
                Ok(())
            }));
            runners.push(tokio::spawn(core.clone().run_attachment_move_preparation()));
        }
        Ok(Self {
            core,
            runners: std::sync::Mutex::new(Some(runners)),
            shutdown_result: watch::channel(None).0,
            leases,
            file_capabilities,
            image_sources,
            recovery_files,
            startup_error,
            device_gate,
        })
    }

    pub(super) fn attach_native_source(
        &self,
        extension_id: String,
        transport_id: String,
    ) -> Result<bittery_client_core::NativeSourceAttachment, RuntimeError> {
        self.core
            .native_authority()
            .attach_source_scoped(extension_id, transport_id)
    }

    pub(super) fn connection(&self) -> RuntimeConnection {
        RuntimeConnection::with_startup_error(self.core.clone(), self.startup_error.clone())
    }

    pub(super) async fn shutdown(&self) -> Result<(), RuntimeError> {
        let mut completion = self.shutdown_result.subscribe();
        self.start_shutdown();
        loop {
            if let Some(result) = completion.borrow_and_update().clone() {
                return result;
            }
            completion
                .changed()
                .await
                .map_err(|_| storage_unavailable())?;
        }
    }

    fn start_shutdown(&self) {
        let Some(runners) = self
            .runners
            .lock()
            .expect("Native runner ownership poisoned")
            .take()
        else {
            return;
        };
        let core = self.core.clone();
        let leases = self.leases.clone();
        let device_gate = self.device_gate.clone();
        let completion = self.shutdown_result.clone();
        // A single owned job outlives a dropped shutdown waiter and the original Tokio executor.
        // Keep all capability guards until Core retires its work; never abort accepted work here.
        std::thread::spawn(move || {
            let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                let executor = tokio::runtime::Builder::new_current_thread()
                    .enable_all()
                    .build()
                    .map_err(|_| storage_unavailable())?;
                executor.block_on(async {
                    core.close().await;
                    let mut failure = None;
                    for runner in runners {
                        match runner.await {
                            Ok(Ok(())) => {}
                            Ok(Err(error)) => {
                                failure.get_or_insert(error);
                            }
                            Err(_) => {
                                failure.get_or_insert(RuntimeError {
                                    code: RuntimeErrorCode::InvariantViolation,
                                    message: "Native Runtime scheduling task failed".into(),
                                    recovery_bound: None,
                                    team_page_problem: None,
                                });
                            }
                        }
                    }
                    if let Some(leases) = leases {
                        leases.close();
                    }
                    device_gate
                        .lock()
                        .map_err(|_| storage_unavailable())?
                        .take();
                    failure.map_or(Ok(()), Err)
                })
            }))
            .unwrap_or_else(|_| {
                Err(RuntimeError {
                    code: RuntimeErrorCode::InvariantViolation,
                    message: "Native Runtime shutdown failed".into(),
                    recovery_bound: None,
                    team_page_problem: None,
                })
            });
            completion.send_replace(Some(result));
        });
    }
}

impl Drop for NativeRuntime {
    fn drop(&mut self) {
        self.start_shutdown();
    }
}

fn storage_unavailable() -> RuntimeError {
    RuntimeError {
        code: RuntimeErrorCode::StorageUnavailable,
        message: "Native Runtime storage is unavailable".into(),
        recovery_bound: None,
        team_page_problem: None,
    }
}

#[cfg(test)]
#[path = "native_vault_acceptance.rs"]
mod vault_acceptance;

#[cfg(test)]
#[path = "native_protected_image_acceptance.rs"]
mod protected_image_acceptance;

#[cfg(test)]
#[path = "native_travel_settings_acceptance.rs"]
mod travel_settings_acceptance;

#[cfg(test)]
#[path = "native_travel_loss_acceptance.rs"]
mod travel_loss_acceptance;

#[cfg(test)]
#[path = "native_recovery_acceptance.rs"]
mod recovery_acceptance;

#[cfg(test)]
#[path = "native_cross_account_move_acceptance.rs"]
mod cross_account_move_acceptance;

#[cfg(test)]
#[path = "native_source_acceptance.rs"]
pub(super) mod source_acceptance;

#[cfg(all(test, unix))]
#[path = "native_legacy_acceptance.rs"]
mod legacy_acceptance;

#[cfg(all(test, unix))]
#[path = "native_source_cancellation_tests.rs"]
mod source_cancellation_tests;

#[cfg(test)]
mod tests {
    use super::*;
    use bittery_client_core::{
        AccountAccessState, AccountId, ClientPlatform, ItemProjectionStatus, ObservationRequest,
        ObservationSink, PlatformStorageArea, PlatformStorageRequest, PlatformStorageResponse,
        RequestCancellation, RuntimeProjection, RuntimeRequest, RuntimeResponse, SecretString,
        SerializedPlatformStorageExecutor, TeardownStatus,
    };
    use std::sync::Mutex;
    use zeroize::Zeroizing;

    #[derive(Default)]
    struct Projections(Mutex<Vec<RuntimeProjection>>);

    impl ObservationSink for Projections {
        fn publish(&self, projection: RuntimeProjection) {
            self.0.lock().unwrap().push(projection);
        }
    }

    fn config() -> AuthClientConfig {
        AuthClientConfig::new(
            "native-assembly-test".into(),
            ClientPlatform::Desktop,
            "test".into(),
        )
        .unwrap()
    }

    #[derive(serde::Deserialize)]
    #[serde(rename_all = "camelCase")]
    pub(super) struct AcceptanceCredentials {
        server_url: String,
        email: SecretString,
        password: SecretString,
        secret_key: SecretString,
        expected_item_title: String,
        pub(super) target_vault_id: String,
        #[serde(default)]
        incoming_travel: bool,
        #[serde(default)]
        foreground_travel: Option<super::travel_settings_acceptance::Scenario>,
        pub(super) policy_request: std::path::PathBuf,
        pub(super) policy_acknowledgement: std::path::PathBuf,
        network_control: std::path::PathBuf,
        network_acknowledgement: std::path::PathBuf,
        network_blocked_move: std::path::PathBuf,
        network_deletion_target: std::path::PathBuf,
        network_deletion_reply: std::path::PathBuf,
        #[serde(default)]
        pub(super) network_travel_committed: std::path::PathBuf,
    }

    fn observed_snapshot(
        core: &Arc<Runtime>,
        request: ObservationRequest,
    ) -> Result<Option<RuntimeProjection>, RuntimeError> {
        let projections = Arc::new(Projections::default());
        let _observation = core.observe(request, projections.clone())?;
        let result = projections.0.lock().unwrap().pop();
        Ok(result)
    }

    pub(super) fn snapshot(
        core: &Arc<Runtime>,
        request: ObservationRequest,
    ) -> Result<RuntimeProjection, String> {
        observed_snapshot(core, request)
            .map_err(|error| format!("Observation failed: {:?}", error.code))?
            .ok_or_else(|| "Observation published no initial projection".to_owned())
    }

    // Only bounded convergence loops use this sample. One-shot assertions remain strict.
    pub(super) fn sample_acceptance_items(
        native: &NativeRuntime,
        account_id: &AccountId,
        stage: &str,
    ) -> Result<Option<bittery_client_core::ItemsProjection>, String> {
        match observed_snapshot(
            &native.core,
            ObservationRequest::Items {
                account_id: account_id.clone(),
            },
        ) {
            Ok(Some(RuntimeProjection::Items(items))) if items.account_id == *account_id => {
                return Ok(Some(items));
            }
            // observe() can succeed after capturing an initial projection whose delivery
            // token is then paused before sink publication, leaving this sample empty.
            Ok(None) => {}
            Err(error) if error.code == RuntimeErrorCode::AuthorityMissing => {}
            Err(error) => {
                return Err(format!(
                    "{stage}: Items observation failed: {:?}",
                    error.code
                ));
            }
            Ok(_) => {
                return Err(format!(
                    "{stage}: Expected initial Items projection for the same Account"
                ));
            }
        }
        let RuntimeProjection::TravelMode(travel) = snapshot(
            &native.core,
            ObservationRequest::TravelMode {
                account_id: account_id.clone(),
            },
        )
        .map_err(|error| format!("{stage}: Travel readiness: {error}"))?
        else {
            return Err(format!("{stage}: Expected Travel readiness projection"));
        };
        if travel.account_id != *account_id {
            return Err(format!("{stage}: Travel readiness Account differs"));
        }
        if travel.enforcement == bittery_client_core::TravelModeEnforcement::Unverified {
            return Ok(None);
        }
        // Verification may finish between the two public observations. Recheck once
        // strictly; an earlier refused sample alone cannot prove current unavailability.
        match snapshot(
            &native.core,
            ObservationRequest::Items {
                account_id: account_id.clone(),
            },
        )
        .map_err(|error| format!("{stage}: Items readiness recheck: {error}"))?
        {
            RuntimeProjection::Items(items) if items.account_id == *account_id => Ok(Some(items)),
            _ => Err(format!(
                "{stage}: Expected rechecked Items projection for the same Account"
            )),
        }
    }

    pub(super) async fn acceptance_request(
        core: &Runtime,
        request: RuntimeRequest,
    ) -> Result<RuntimeResponse, String> {
        core.request(request, RequestCancellation::new())
            .await
            .map_err(|error| {
                // Only closed, static authentication classifications are diagnostic output;
                // arbitrary Server text and credential values never enter fixture logs.
                let detail = match error.message.as_str() {
                    "Authentication Server request failed" => " (transport)",
                    "Authentication Server returned an unexpected status" => {
                        " (unexpected HTTP status)"
                    }
                    "Authentication Server returned invalid JSON" => " (invalid response schema)",
                    "Server Session is already expired" => " (expired Server Session)",
                    "Server KDF profile is invalid" => " (invalid KDF profile)",
                    _ => "",
                };
                format!("Runtime request failed: {:?}{detail}", error.code)
            })
    }

    pub(super) fn check_access(
        native: &NativeRuntime,
        account_id: &AccountId,
        expected: AccountAccessState,
    ) -> Result<(), String> {
        let RuntimeProjection::RuntimeStatus(status) = snapshot(
            &native.core,
            ObservationRequest::RuntimeStatus { account_id: None },
        )?
        else {
            return Err("Expected Runtime status projection".into());
        };
        if let Some(failure) = status
            .accounts
            .iter()
            .find(|account| account.account_id == *account_id)
            .and_then(|account| account.failure)
        {
            return Err(format!(
                "Installed Account is failed while checking {expected:?}: {failure:?}"
            ));
        }
        if status.accounts.len() != 1
            || status.accounts[0].account_id != *account_id
            || status.accounts[0].access != expected
        {
            return Err("Installed Account access differs from expected state".into());
        }
        Ok(())
    }

    pub(super) async fn wait_for_acceptance_item(
        native: &NativeRuntime,
        account_id: &AccountId,
        title: &str,
    ) -> Result<(), String> {
        let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(30);
        loop {
            let Some(items) = sample_acceptance_items(native, account_id, "Provisioned Item wait")?
            else {
                if tokio::time::Instant::now() >= deadline {
                    return Err(
                        "Provisioned Item wait timed out with Unverified Travel enforcement".into(),
                    );
                }
                tokio::time::sleep(std::time::Duration::from_millis(100)).await;
                continue;
            };
            if items.items.iter().any(|item| {
                item.data.title() == title && item.status == ItemProjectionStatus::Authoritative
            }) {
                return Ok(());
            }
            if tokio::time::Instant::now() >= deadline {
                eprintln!("Native Item wait diagnostics: revision={}, matching status={:?}, visible Vaults={}, visible Items={}",
                    items.replica_revision,
                    items.items.iter().filter(|item| item.data.title() == title).map(|item| item.status).collect::<Vec<_>>(),
                    items.vaults.len(), items.items.len());
                if let Ok(RuntimeProjection::Operations(operations)) = snapshot(
                    &native.core,
                    ObservationRequest::Operations {
                        account_id: account_id.clone(),
                    },
                ) {
                    eprintln!(
                        "Native Item wait Operation diagnostics: {:?}",
                        operations
                            .operations
                            .iter()
                            .map(|operation| (
                                operation.kind,
                                operation.resolution,
                                &operation.attempt_count,
                                &operation.next_attempt_at_ms,
                                &operation.rejection_code,
                            ))
                            .collect::<Vec<_>>()
                    );
                }
                return Err("Provisioned Item did not reach authoritative projection".into());
            }
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        }
    }

    fn acceptance_credentials() -> Result<AcceptanceCredentials, String> {
        read_acceptance_credentials("BITTERY_NATIVE_ACCEPTANCE_CREDENTIALS")
    }

    pub(super) fn read_acceptance_credentials<T: serde::de::DeserializeOwned>(
        environment: &str,
    ) -> Result<T, String> {
        let path = std::env::var_os(environment)
            .ok_or("Acceptance environment must name a protected credentials file")?;
        let mut file = std::fs::File::open(path).map_err(|_| "Cannot open credentials file")?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = file
                .metadata()
                .map_err(|_| "Cannot inspect credentials file permissions")?
                .permissions()
                .mode();
            if mode & 0o077 != 0 {
                return Err("Credentials file must not permit group or other access".into());
            }
        }
        let mut bytes = Zeroizing::new(Vec::new());
        std::io::Read::read_to_end(&mut file, &mut bytes)
            .map_err(|_| "Cannot read credentials file")?;
        serde_json::from_slice(&bytes).map_err(|_| "Invalid credentials file".into())
    }

    pub(super) async fn cleanup_acceptance_account(native: &NativeRuntime) -> Result<(), String> {
        // This catalog belongs only to the fresh directory. Never wipe the shared OS keychain.
        let RuntimeProjection::RuntimeStatus(status) = snapshot(
            &native.core,
            ObservationRequest::RuntimeStatus { account_id: None },
        )?
        else {
            return Err("Expected Runtime status for scoped cleanup".into());
        };
        for account in status.accounts {
            let response = acceptance_request(
                &native.core,
                RuntimeRequest::RemoveAccount {
                    account_id: account.account_id,
                },
            )
            .await?;
            let RuntimeResponse::Teardown {
                status, failures, ..
            } = response
            else {
                return Err("Expected scoped teardown result".into());
            };
            if status != TeardownStatus::Complete || !failures.is_empty() {
                return Err("Native scoped teardown did not complete every phase".into());
            }
        }
        let RuntimeProjection::RuntimeStatus(status) = snapshot(
            &native.core,
            ObservationRequest::RuntimeStatus { account_id: None },
        )?
        else {
            return Err("Expected Runtime status after scoped cleanup".into());
        };
        if !status.accounts.is_empty() {
            return Err("Scoped cleanup retained an Account".into());
        }
        Ok(())
    }

    async fn acceptance_attachments(
        native: &NativeRuntime,
        account_id: &AccountId,
        title: &str,
        directory: &Path,
    ) -> Result<(), String> {
        use super::super::file_capabilities::UploadSelection;
        let RuntimeProjection::Items(items) = snapshot(
            &native.core,
            ObservationRequest::Items {
                account_id: account_id.clone(),
            },
        )?
        else {
            return Err("Expected native Items before Attachment upload".into());
        };
        let item = items
            .items
            .iter()
            .find(|item| item.data.title() == title)
            .ok_or("Provisioned Item missing before Attachment upload")?;
        let source_path = directory.join("selected-attachment");
        let expected = vec![0x59; bittery_client_core::ARTIFACT_CHUNK_BYTES * 2 + 17];
        std::fs::write(&source_path, &expected)
            .map_err(|_| "Cannot create selected attachment fixture")?;
        let caller = native
            .file_capabilities
            .caller()
            .map_err(|_| "Cannot open native file caller")?;
        let scope = native
            .file_capabilities
            .scope(&caller, account_id.clone(), &item.vault_id)
            .map_err(|_| "Cannot scope native selected file")?;
        let selection = UploadSelection {
            account_id: account_id.clone(),
            item_id: item.item_id.clone(),
            name: "native-attachment.bin".into(),
            content_type: "application/octet-stream".into(),
            expected_bytes: expected.len() as u64,
        };
        let source_capability_id = native
            .file_capabilities
            .grant_upload(
                scope,
                selection.clone(),
                std::fs::File::open(&source_path)
                    .map_err(|_| "Cannot open selected attachment fixture")?,
            )
            .map_err(|_| "Cannot grant selected file")?;
        let response = acceptance_request(
            &native.core,
            RuntimeRequest::UploadAttachment {
                account_id: account_id.clone(),
                item_id: item.item_id.clone(),
                name: selection.name,
                content_type: selection.content_type,
                file_size: selection.expected_bytes,
                source_capability_id,
            },
        )
        .await
        .map_err(|error| format!("Native Attachment upload: {error}"))?;
        let RuntimeResponse::AttachmentUploaded { attachment_id, .. } = response else {
            return Err("Native Attachment upload did not complete".into());
        };
        acceptance_request(
            &native.core,
            RuntimeRequest::RenameAttachment {
                account_id: account_id.clone(),
                attachment_id: attachment_id.clone(),
                name: "renamed-native.bin".into(),
            },
        )
        .await
        .map_err(|error| format!("Native Attachment rename: {error}"))?;
        let destination = directory.join("saved-attachment");
        let scope = native
            .file_capabilities
            .scope(&caller, account_id.clone(), &item.vault_id)
            .map_err(|_| "Cannot scope native save target")?;
        let sink_capability_id = native
            .file_capabilities
            .grant_download(
                scope,
                attachment_id.clone(),
                tempfile::tempfile_in(directory)
                    .map_err(|_| "Cannot create private output staging")?,
                destination.clone(),
            )
            .map_err(|_| "Cannot grant save target")?;
        let response = acceptance_request(
            &native.core,
            RuntimeRequest::DownloadAttachment {
                account_id: account_id.clone(),
                attachment_id: attachment_id.clone(),
                sink_capability_id,
            },
        )
        .await
        .map_err(|error| format!("Native Attachment download: {error}"))?;
        if !matches!(response, RuntimeResponse::AttachmentDownloaded { .. })
            || std::fs::read(&destination).map_err(|_| "Cannot read saved native attachment")?
                != expected
        {
            return Err("Native Attachment download differs from selected file".into());
        }
        acceptance_request(
            &native.core,
            RuntimeRequest::DeleteAttachment {
                account_id: account_id.clone(),
                attachment_id,
            },
        )
        .await
        .map_err(|error| format!("Native Attachment delete: {error}"))?;
        eprintln!("Real native Core Attachment upload, rename, verified download and delete passed; OS file dialogs remain separate");
        Ok(())
    }

    pub(super) async fn acceptance_network(
        credentials: &AcceptanceCredentials,
        mode: &str,
    ) -> Result<(), String> {
        std::fs::write(&credentials.network_control, mode)
            .map_err(|_| "Cannot control native network fixture")?;
        tokio::time::timeout(std::time::Duration::from_secs(10), async {
            loop {
                let acknowledged =
                    std::fs::read_to_string(&credentials.network_acknowledgement).ok();
                if acknowledged.as_deref() == Some(mode)
                    || (mode == "deletion-first"
                        && acknowledged.as_deref() == Some("offline")
                        && std::fs::metadata(&credentials.network_deletion_reply)
                            .is_ok_and(|metadata| metadata.len() > 0))
                {
                    break;
                }
                tokio::time::sleep(std::time::Duration::from_millis(20)).await;
            }
        })
        .await
        .map_err(|_| "Native network fixture did not acknowledge connection state".to_owned())
    }

    async fn acceptance_pending_move(
        native: &NativeRuntime,
        account_id: &AccountId,
        credentials: &AcceptanceCredentials,
        directory: &Path,
    ) -> Result<(), String> {
        use super::super::file_capabilities::UploadSelection;
        let RuntimeProjection::Items(items) = snapshot(
            &native.core,
            ObservationRequest::Items {
                account_id: account_id.clone(),
            },
        )?
        else {
            return Err("Expected Items before Move".into());
        };
        let item = items
            .items
            .iter()
            .find(|item| item.data.title() == credentials.expected_item_title)
            .ok_or("Move source Item missing")?;
        let bytes = vec![0x31; bittery_client_core::ARTIFACT_CHUNK_BYTES * 2 + 29];
        let path = directory.join("move-attachment");
        std::fs::write(&path, bytes).map_err(|_| "Cannot prepare selected Move attachment")?;
        let caller = native
            .file_capabilities
            .caller()
            .map_err(|_| "Cannot open Move file caller")?;
        let scope = native
            .file_capabilities
            .scope(&caller, account_id.clone(), &item.vault_id)
            .map_err(|_| "Cannot scope Move file")?;
        let selection = UploadSelection {
            account_id: account_id.clone(),
            item_id: item.item_id.clone(),
            name: "move-attachment.bin".into(),
            content_type: "application/octet-stream".into(),
            expected_bytes: (bittery_client_core::ARTIFACT_CHUNK_BYTES * 2 + 29) as u64,
        };
        let source_capability_id = native
            .file_capabilities
            .grant_upload(
                scope,
                selection.clone(),
                std::fs::File::open(path).map_err(|_| "Cannot open selected Move attachment")?,
            )
            .map_err(|_| "Cannot grant Move file")?;
        let RuntimeResponse::AttachmentUploaded { attachment_id, .. } = acceptance_request(
            &native.core,
            RuntimeRequest::UploadAttachment {
                account_id: account_id.clone(),
                item_id: selection.item_id.clone(),
                name: selection.name,
                content_type: selection.content_type,
                file_size: selection.expected_bytes,
                source_capability_id,
            },
        )
        .await?
        else {
            return Err("Move attachment upload did not complete".into());
        };
        acceptance_network(credentials, "offline").await?;
        let response = acceptance_request(
            &native.core,
            RuntimeRequest::MoveItem {
                account_id: account_id.clone(),
                item_id: item.item_id.clone(),
                target_vault_id: credentials.target_vault_id.clone(),
                target_account_id: None,
            },
        )
        .await?;
        let RuntimeResponse::Accepted { operation_id, .. } = response else {
            return Err("Offline Move did not produce durable acceptance".into());
        };
        let RuntimeProjection::Items(pending) = snapshot(
            &native.core,
            ObservationRequest::Items {
                account_id: account_id.clone(),
            },
        )?
        else {
            return Err("Expected offline Items".into());
        };
        if !pending.items.iter().any(|row| {
            row.item_id == item.item_id
                && row.vault_id == credentials.target_vault_id
                && row.status == ItemProjectionStatus::Pending
        }) {
            return Err("Offline Replica did not render its pending Move".into());
        }
        for (name, value) in [
            ("acceptance-move-operation-id", operation_id.clone()),
            ("acceptance-move-item-id", item.item_id.clone()),
            ("acceptance-move-attachment-id", attachment_id),
        ] {
            std::fs::write(directory.join(name), value)
                .map_err(|_| "Cannot write Move identity handoff")?;
        }
        // Read the actual persisted scheduling evidence. Move preparation has its own durable
        // schedule before the final Operation is eligible for dispatch.
        let evidence = rusqlite::Connection::open_with_flags(
            directory.join("replica.sqlite"),
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
        )
        .map_err(|_| "Cannot read native retry evidence")?;
        let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(30);
        loop {
            let mut statement = evidence.prepare("SELECT payload_json FROM replica_rows WHERE account_id = ?1 AND record_id = ?2").map_err(|_| "Cannot select retry evidence")?;
            let rows = statement
                .query_map(
                    rusqlite::params![account_id.as_str(), operation_id],
                    |row| row.get::<_, String>(0),
                )
                .map_err(|_| "Cannot query retry evidence")?;
            let mut attempted = false;
            for row in rows {
                let value: serde_json::Value =
                    serde_json::from_str(&row.map_err(|_| "Cannot read retry record")?)
                        .map_err(|_| "Cannot decode retry evidence")?;
                attempted |= value
                    .get("scheduling")
                    .and_then(|value| value.get("attemptCount"))
                    .and_then(|value| value.as_str())
                    .and_then(|count| count.parse::<u64>().ok())
                    .is_some_and(|count| count > 0);
            }
            if attempted {
                break;
            }
            if tokio::time::Instant::now() >= deadline {
                return Err("Offline Move did not record its failed preparation attempt".into());
            }
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        }
        acceptance_network(credentials, "prepare-only").await?;
        let artifacts = rusqlite::Connection::open_with_flags(
            directory.join("attachments.sqlite"),
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
        )
        .map_err(|_| "Cannot read prepared artifact evidence")?;
        let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(120);
        loop {
            let published: i64 = artifacts.query_row("SELECT COUNT(*) FROM attachment_move_artifacts WHERE account_id=?1 AND operation_id=?2 AND publication_state=2 AND byte_length>0 AND chunk_count>1", rusqlite::params![account_id.as_str(), operation_id], |row| row.get(0)).map_err(|_| "Cannot inspect published Move artifact")?;
            let RuntimeProjection::Operations(operations) = snapshot(
                &native.core,
                ObservationRequest::Operations {
                    account_id: account_id.clone(),
                },
            )?
            else {
                return Err("Expected prepared Move Operation".into());
            };
            let attempted = operations.operations.iter().any(|op| {
                op.operation_id == operation_id
                    && op.resolution == bittery_client_core::OperationResolution::Pending
                    && op
                        .attempt_count
                        .as_ref()
                        .and_then(|count| count.parse::<u64>().ok())
                        .is_some_and(|count| count > 0)
            });
            let blocked_exact_request = std::fs::read_to_string(&credentials.network_blocked_move)
                .is_ok_and(|observed| observed == operation_id);
            if published > 0 && attempted && blocked_exact_request {
                break;
            }
            if tokio::time::Instant::now() >= deadline {
                return Err(
                    "Move did not durably prepare ciphertext before blocked final dispatch".into(),
                );
            }
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        }
        acceptance_network(credentials, "offline").await?;
        eprintln!("Actual native offline acceptance, resumed ciphertext preparation and failed final Move dispatch passed before process loss");
        Ok(())
    }

    pub(super) async fn acceptance_converged_move(
        native: &NativeRuntime,
        account_id: &AccountId,
        credentials: &AcceptanceCredentials,
        directory: &Path,
    ) -> Result<(), String> {
        let read = |name| {
            std::fs::read_to_string(directory.join(name))
                .map_err(|_| "Cannot read accepted Move handoff".to_owned())
        };
        let item_id = read("acceptance-move-item-id")?;
        let operation_id = read("acceptance-move-operation-id")?;
        let attachment_id = read("acceptance-move-attachment-id")?;
        let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(120);
        loop {
            let Some(items) = sample_acceptance_items(native, account_id, "Reconnected Move wait")?
            else {
                if tokio::time::Instant::now() >= deadline {
                    return Err(
                        "Reconnected Move wait timed out with Unverified Travel enforcement".into(),
                    );
                }
                tokio::time::sleep(std::time::Duration::from_millis(100)).await;
                continue;
            };
            let RuntimeProjection::Operations(operations) = snapshot(
                &native.core,
                ObservationRequest::Operations {
                    account_id: account_id.clone(),
                },
            )?
            else {
                return Err("Expected reconnect Operations".into());
            };
            let authoritative = items.items.iter().any(|item| {
                item.item_id == item_id
                    && item.vault_id == credentials.target_vault_id
                    && item.status == ItemProjectionStatus::Authoritative
            });
            let applied = operations.operations.iter().any(|op| {
                op.operation_id == operation_id
                    && op.resolution == bittery_client_core::OperationResolution::Applied
            });
            if authoritative && applied {
                break;
            }
            if tokio::time::Instant::now() >= deadline {
                return Err("Original accepted Move did not converge after process restart".into());
            }
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        }
        let caller = native
            .file_capabilities
            .caller()
            .map_err(|_| "Cannot open verified Move download caller")?;
        let scope = native
            .file_capabilities
            .scope(&caller, account_id.clone(), &credentials.target_vault_id)
            .map_err(|_| "Cannot scope Move download")?;
        let destination = directory.join("saved-moved-attachment");
        let sink_capability_id = native
            .file_capabilities
            .grant_download(
                scope,
                attachment_id.clone(),
                tempfile::tempfile_in(directory)
                    .map_err(|_| "Cannot create Move download staging")?,
                destination.clone(),
            )
            .map_err(|_| "Cannot grant Move download")?;
        let response = acceptance_request(
            &native.core,
            RuntimeRequest::DownloadAttachment {
                account_id: account_id.clone(),
                attachment_id: attachment_id.clone(),
                sink_capability_id,
            },
        )
        .await
        .map_err(|error| format!("Reopened Move Attachment download: {error}"))?;
        if !matches!(response, RuntimeResponse::AttachmentDownloaded { .. })
            || std::fs::read(destination).map_err(|_| "Cannot read verified moved Attachment")?
                != vec![0x31; bittery_client_core::ARTIFACT_CHUNK_BYTES * 2 + 29]
        {
            return Err("Moved Attachment did not decrypt to original selected bytes".into());
        }
        acceptance_request(
            &native.core,
            RuntimeRequest::DeleteAttachment {
                account_id: account_id.clone(),
                attachment_id,
            },
        )
        .await
        .map_err(|error| format!("Reopened Move Attachment deletion: {error}"))?;
        eprintln!("Original accepted Move applied after restart/reconnect; target-Vault Attachment decrypted to exact original bytes");
        Ok(())
    }

    async fn acceptance_vault_rename(
        native: &NativeRuntime,
        account_id: &AccountId,
        credentials: &AcceptanceCredentials,
    ) -> Result<(), String> {
        let RuntimeProjection::Items(items) = snapshot(
            &native.core,
            ObservationRequest::Items {
                account_id: account_id.clone(),
            },
        )?
        else {
            return Err("Cannot read Vault rename fixture".into());
        };
        let item = items
            .items
            .iter()
            .find(|item| item.data.title() == credentials.expected_item_title)
            .ok_or("Cannot find native rename source Item")?;
        let vault_id = item.vault_id.clone();
        let original_name = items
            .vaults
            .iter()
            .find(|vault| vault.vault_id == vault_id)
            .ok_or("Cannot find native rename source Vault")?
            .name
            .clone();
        acceptance_network(credentials, "offline").await?;
        let response = acceptance_request(
            &native.core,
            RuntimeRequest::UpdateVault {
                account_id: account_id.clone(),
                vault_id: vault_id.clone(),
                name: Some("Native Runtime renamed Vault".into()),
                icon: bittery_client_core::VaultIconPatch::Unchanged,
                image: bittery_client_core::VaultImageChange::Unchanged,
            },
        )
        .await?;
        let RuntimeResponse::VaultUpdateAccepted { operation_id, .. } = response else {
            return Err("Native Vault rename was not durably accepted offline".into());
        };
        let RuntimeProjection::Items(items) = snapshot(
            &native.core,
            ObservationRequest::Items {
                account_id: account_id.clone(),
            },
        )?
        else {
            return Err("Cannot read offline Vault rename projection".into());
        };
        if !items
            .vaults
            .iter()
            .any(|vault| vault.vault_id == vault_id && vault.name == original_name)
        {
            return Err("Offline acceptance published unconfirmed Vault metadata".into());
        }
        acceptance_network(credentials, "online").await?;
        tokio::time::timeout(std::time::Duration::from_secs(30), async {
            loop {
                check_access(native, account_id, AccountAccessState::Unlocked)?;
                let operations = snapshot(
                    &native.core,
                    ObservationRequest::Operations {
                        account_id: account_id.clone(),
                    },
                )?;
                let items = sample_acceptance_items(native, account_id, "Vault rename wait")?;
                if let (RuntimeProjection::Operations(operations), Some(items)) =
                    (operations, items)
                {
                    if operations.operations.iter().any(|operation| {
                        operation.operation_id == operation_id
                            && operation.resolution
                                == bittery_client_core::OperationResolution::Applied
                    }) && items.vaults.iter().any(|vault| {
                        vault.vault_id == vault_id && vault.name == "Native Runtime renamed Vault"
                    }) {
                        return Ok::<_, String>(());
                    }
                }
                tokio::time::sleep(std::time::Duration::from_millis(20)).await;
            }
        })
        .await
        .map_err(|_| {
            "Native Vault rename did not converge through current authority".to_owned()
        })??;
        eprintln!("Actual native offline Vault rename reconciled its retained Server outcome and current Runtime authority");
        acceptance_vault_image_updates(native, account_id, &vault_id).await?;
        Ok(())
    }

    pub(super) fn acceptance_image_source(
        native: &NativeRuntime,
        account_id: &AccountId,
        vault_id: Option<&str>,
        image: &[u8],
    ) -> Result<
        (
            bittery_client_core::VaultImageSourceInput,
            super::super::vault_image_source::VaultImageCaller,
        ),
        String,
    > {
        let sources = native
            .image_sources
            .as_ref()
            .ok_or("Native image source unavailable")?;
        let caller = sources
            .caller()
            .map_err(|_| "Native image caller unavailable")?;
        let scope = match vault_id {
            Some(vault_id) => sources.scope_for_vault(&caller, account_id.clone(), vault_id),
            None => sources.scope(&caller, account_id.clone()),
        }
        .map_err(|_| "Native image scope unavailable")?;
        let mut file = tempfile::tempfile().map_err(|_| "Native image file unavailable")?;
        std::io::Write::write_all(&mut file, image)
            .map_err(|_| "Native image file write failed")?;
        let source = sources
            .grant(scope, "image/png".into(), file)
            .map_err(|_| "Native image grant failed")?;
        Ok((source, caller))
    }

    async fn acceptance_vault_image_updates(
        native: &NativeRuntime,
        account_id: &AccountId,
        vault_id: &str,
    ) -> Result<(), String> {
        const IMAGE: &[u8] = include_bytes!("../../icons/32x32.png");
        let (source, caller) = acceptance_image_source(native, account_id, Some(vault_id), IMAGE)?;
        let response = acceptance_request(
            &native.core,
            RuntimeRequest::UpdateVault {
                account_id: account_id.clone(),
                vault_id: vault_id.into(),
                name: None,
                icon: bittery_client_core::VaultIconPatch::Set {
                    value: "star".into(),
                },
                image: bittery_client_core::VaultImageChange::Source { source },
            },
        )
        .await?;
        drop(caller);
        let updated = wait_for_vault_update(native, account_id, vault_id, response, true).await?;
        if updated.icon.as_deref() != Some("star") {
            return Err("Native image update lost its icon patch".into());
        }
        let image_url = updated
            .image_url
            .ok_or("Native image update has no public image")?;
        let response = reqwest::Client::new()
            .get(image_url)
            .send()
            .await
            .map_err(|_| "Native published image request failed")?;
        if !response.status().is_success()
            || response
                .bytes()
                .await
                .map_err(|_| "Native published image read failed")?
                .as_ref()
                != IMAGE
        {
            return Err("Native published image differs from the selected file".into());
        }
        let response = acceptance_request(
            &native.core,
            RuntimeRequest::UpdateVault {
                account_id: account_id.clone(),
                vault_id: vault_id.into(),
                name: None,
                icon: bittery_client_core::VaultIconPatch::Clear,
                image: bittery_client_core::VaultImageChange::Remove,
            },
        )
        .await?;
        let removed = wait_for_vault_update(native, account_id, vault_id, response, false).await?;
        if removed.icon.is_some() {
            return Err("Native image removal lost its clear-icon patch".into());
        }
        eprintln!("Actual native file image replacement survived caller release, published exact bytes, then image/icon removal converged");
        Ok(())
    }

    async fn wait_for_vault_update(
        native: &NativeRuntime,
        account_id: &AccountId,
        vault_id: &str,
        response: RuntimeResponse,
        has_image: bool,
    ) -> Result<bittery_client_core::VaultProjection, String> {
        let RuntimeResponse::VaultUpdateAccepted { operation_id, .. } = response else {
            return Err("Native Vault update was not durably accepted".into());
        };
        tokio::time::timeout(std::time::Duration::from_secs(40), async {
            loop {
                check_access(native, account_id, AccountAccessState::Unlocked)?;
                if let (RuntimeProjection::Operations(operations), Some(items)) = (
                    snapshot(
                        &native.core,
                        ObservationRequest::Operations {
                            account_id: account_id.clone(),
                        },
                    )?,
                    sample_acceptance_items(native, account_id, "Vault image update wait")?,
                ) {
                    if operations.operations.iter().any(|operation| {
                        operation.operation_id == operation_id
                            && operation.resolution
                                == bittery_client_core::OperationResolution::Applied
                    }) {
                        if let Some(vault) = items.vaults.into_iter().find(|vault| {
                            vault.vault_id == vault_id && vault.image_url.is_some() == has_image
                        }) {
                            return Ok::<_, String>(vault);
                        }
                    }
                }
                tokio::time::sleep(std::time::Duration::from_millis(20)).await;
            }
        })
        .await
        .map_err(|_| "Native Vault image update did not converge".to_owned())?
    }

    pub(super) async fn sign_in_acceptance_account(
        native: &NativeRuntime,
        server_url: &str,
        email: &SecretString,
        password: &SecretString,
        secret_key: &SecretString,
    ) -> Result<AccountId, String> {
        let response = acceptance_request(
            &native.core,
            RuntimeRequest::SignIn {
                server_url: server_url.to_owned(),
                email: email.as_ref().to_owned(),
                master_password: password.as_ref().to_owned(),
                secret_key: secret_key.as_ref().to_owned(),
                insecure_transport_confirmed: true,
            },
        )
        .await
        .map_err(|error| format!("Sign-in: {error}"))?;
        let RuntimeResponse::SignedIn { account_id, .. } = response else {
            return Err("Sign-in did not install an Account".into());
        };
        Ok(account_id)
    }

    async fn acceptance_sign_in(
        native: &NativeRuntime,
        credentials: &AcceptanceCredentials,
        directory: &Path,
    ) -> Result<(), String> {
        let account_id = sign_in_acceptance_account(
            native,
            &credentials.server_url,
            &credentials.email,
            &credentials.password,
            &credentials.secret_key,
        )
        .await?;
        check_access(native, &account_id, AccountAccessState::Unlocked)?;
        wait_for_acceptance_item(native, &account_id, &credentials.expected_item_title)
            .await
            .map_err(|error| format!("Sign-in Item convergence: {error}"))?;
        if let Some(loss) = credentials.foreground_travel {
            if matches!(
                loss,
                super::travel_settings_acceptance::Scenario::CallerDrop
            ) {
                super::travel_loss_acceptance::caller_drop(
                    native,
                    &account_id,
                    credentials,
                    &credentials.password,
                    &credentials.expected_item_title,
                )
                .await?;
            } else if !matches!(
                loss,
                super::travel_settings_acceptance::Scenario::RuntimeLoss
            ) {
                super::travel_settings_acceptance::exercise(
                    native,
                    &account_id,
                    credentials,
                    &credentials.password,
                    &credentials.expected_item_title,
                    loss,
                )
                .await?;
            }
        }
        acceptance_vault_rename(native, &account_id, credentials)
            .await
            .map_err(|error| format!("Sign-in Vault rename: {error}"))?;
        acceptance_attachments(
            native,
            &account_id,
            &credentials.expected_item_title,
            directory,
        )
        .await
        .map_err(|error| format!("Sign-in attachments: {error}"))?;
        super::vault_acceptance::create(native, &account_id, directory)
            .await
            .map_err(|error| format!("Sign-in Vault creation: {error}"))?;
        super::protected_image_acceptance::create_update_target(native, &account_id, directory)
            .await
            .map_err(|error| format!("Sign-in protected image target: {error}"))?;
        acceptance_pending_move(native, &account_id, credentials, directory)
            .await
            .map_err(|error| format!("Sign-in pending Move: {error}"))?;
        super::protected_image_acceptance::accept(native, &account_id, directory)
            .await
            .map_err(|error| format!("Sign-in protected image acceptance: {error}"))?;
        super::vault_acceptance::accept(
            native,
            &account_id,
            directory,
            &credentials.network_deletion_target,
        )
        .await
        .map_err(|error| format!("Sign-in Vault mutation acceptance: {error}"))?;
        acceptance_network(credentials, "deletion-first").await?;
        super::vault_acceptance::await_lost_reply(
            &account_id,
            directory,
            &credentials.network_deletion_reply,
        )
        .await?;
        acceptance_network(credentials, "offline").await?;
        acceptance_request(
            &native.core,
            RuntimeRequest::Lock {
                account_id: account_id.clone(),
            },
        )
        .await
        .map_err(|error| format!("Lock: {error}"))?;
        check_access(native, &account_id, AccountAccessState::Locked)?;
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut handoff = options
            .open(directory.join("acceptance-account-id"))
            .map_err(|_| "Cannot create Account identity handoff")?;
        std::io::Write::write_all(&mut handoff, account_id.as_str().as_bytes())
            .map_err(|_| "Cannot write Account identity handoff")?;
        eprintln!("Real Server sign-in, authoritative read, and lock passed in the first process");
        Ok(())
    }

    async fn acceptance_restore(
        native: &NativeRuntime,
        credentials: &AcceptanceCredentials,
        directory: &Path,
    ) -> Result<(), String> {
        let account_id = AccountId::from(
            std::fs::read_to_string(directory.join("acceptance-account-id"))
                .map_err(|_| "Cannot read Account identity handoff")?,
        );
        check_access(native, &account_id, AccountAccessState::Locked)?;
        acceptance_network(
            credentials,
            if credentials.incoming_travel {
                "bootstrap-only"
            } else {
                "online"
            },
        )
        .await?;
        acceptance_request(
            &native.core,
            RuntimeRequest::QuickUnlock {
                account_id: account_id.clone(),
                master_password: credentials.password.as_ref().to_owned(),
            },
        )
        .await
        .map_err(|error| format!("Quick Unlock: {error}"))?;
        check_access(native, &account_id, AccountAccessState::Unlocked)?;
        if credentials.incoming_travel {
            super::protected_image_acceptance::exercise_hidden(
                native,
                &account_id,
                directory,
                credentials,
            )
            .await?;
        }
        wait_for_acceptance_item(native, &account_id, &credentials.expected_item_title).await?;
        super::vault_acceptance::converge(native, &account_id, directory).await?;
        super::protected_image_acceptance::converge(native, &account_id, directory).await?;
        if !credentials.incoming_travel {
            acceptance_converged_move(native, &account_id, credentials, directory).await?;
        }
        eprintln!("Same locked Account reopened in a new process; Quick Unlock and authoritative read passed");
        Ok(())
    }

    #[tokio::test]
    #[ignore = "Requires a real Server, uniquely provisioned Account, protected credentials file, and real OS keychain; run alone"]
    async fn real_server_sign_in_and_authenticated_reopen() -> Result<(), String> {
        const PHASE: &str = "BITTERY_NATIVE_ACCEPTANCE_CHILD_PHASE";
        const DIRECTORY: &str = "BITTERY_NATIVE_ACCEPTANCE_RUNTIME_DIRECTORY";
        let Some(phase) = std::env::var_os(PHASE) else {
            // Each child runs exactly one ignored test, so keychain mock initializers cannot run.
            let directory =
                tempfile::tempdir().map_err(|_| "Cannot create isolated Runtime directory")?;
            let executable = std::env::current_exe()
                .map_err(|_| "Cannot locate native acceptance test executable")?;
            let run = |phase: &str| -> Result<(), String> {
                let output = std::process::Command::new(&executable)
                    .args([
                        "runtime_host::native::tests::real_server_sign_in_and_authenticated_reopen",
                        "--ignored",
                        "--exact",
                        "--nocapture",
                    ])
                    .env(PHASE, phase)
                    .env(DIRECTORY, directory.path())
                    .stdin(std::process::Stdio::null())
                    .output()
                    .map_err(|_| format!("Cannot start native acceptance {phase} process"))?;
                eprint!("{}", String::from_utf8_lossy(&output.stderr));
                let accepted = if phase == "travel-loss-dispatch" {
                    output.status.code() == Some(super::travel_loss_acceptance::PROCESS_EXIT)
                        && String::from_utf8_lossy(&output.stderr)
                            .contains(super::travel_loss_acceptance::PROCESS_BOUNDARY)
                } else {
                    output.status.success()
                        && String::from_utf8_lossy(&output.stdout).contains("1 passed; 0 failed")
                };
                if accepted {
                    Ok(())
                } else {
                    Err(format!("Native acceptance {phase} process failed"))
                }
            };
            let credentials = acceptance_credentials()?;
            let loss = if matches!(
                credentials.foreground_travel,
                Some(super::travel_settings_acceptance::Scenario::RuntimeLoss)
            ) {
                run("travel-loss-dispatch").and_then(|()| run("travel-loss-restore"))
            } else {
                Ok(())
            };
            let result = loss
                .and_then(|()| run("sign-in"))
                .and_then(|()| run("repair"))
                .and_then(|()| run("restore"))
                .and_then(|()| run("rebootstrap-reopen"));
            if let Err(error) = result {
                if let Err(cleanup_error) = run("cleanup") {
                    let retained = directory.keep();
                    eprintln!(
                        "Failed acceptance storage retained for scoped cleanup at {}",
                        retained.display()
                    );
                    return Err(format!("{error}; {cleanup_error}"));
                }
                return Err(error);
            }
            eprintln!("Real native process restart acceptance passed; Tauri UI and retained-Session biometric acceptance remain separate");
            return Ok(());
        };
        let directory = std::env::var_os(DIRECTORY)
            .map(std::path::PathBuf::from)
            .ok_or("Child acceptance phase requires its isolated Runtime directory")?;
        let credentials = acceptance_credentials()?;
        let native = NativeRuntime::open(&directory, config())
            .await
            .map_err(|error| format!("Runtime open failed: {:?}", error.code))?;
        if let Ok(RuntimeProjection::RuntimeStatus(status)) = snapshot(
            &native.core,
            ObservationRequest::RuntimeStatus { account_id: None },
        ) {
            eprintln!(
                "Native acceptance phase {:?} opened: startup={:?}, access/failure={:?}",
                phase,
                native.startup_error.as_ref().map(|error| error.code),
                status
                    .accounts
                    .iter()
                    .map(|account| (account.access, account.failure, account.waiting_reason))
                    .collect::<Vec<_>>(),
            );
        }
        let flow = match phase.to_str() {
            Some("travel-loss-dispatch") => {
                async {
                    let account = sign_in_acceptance_account(
                        &native,
                        &credentials.server_url,
                        &credentials.email,
                        &credentials.password,
                        &credentials.secret_key,
                    )
                    .await?;
                    wait_for_acceptance_item(&native, &account, &credentials.expected_item_title)
                        .await?;
                    super::travel_loss_acceptance::dispatch_process_loss(
                        &native,
                        &account,
                        &credentials,
                        &directory,
                    )
                    .await
                }
                .await
            }
            Some("travel-loss-restore") => {
                async {
                    let account = AccountId::from(
                        std::fs::read_to_string(directory.join("travel-loss-account-id"))
                            .map_err(|_| "Cannot read Travel loss Account identity")?,
                    );
                    check_access(&native, &account, AccountAccessState::Locked)?;
                    super::travel_loss_acceptance::restore_process_loss(
                        &native,
                        &account,
                        &credentials,
                        &credentials.password,
                        &credentials.expected_item_title,
                    )
                    .await
                }
                .await
            }
            Some("sign-in") => match acceptance_sign_in(&native, &credentials, &directory).await {
                Ok(()) => {
                    super::recovery_acceptance::export_locked_and_damage(
                        &native,
                        &directory,
                        credentials.password.as_ref(),
                    )
                    .await
                }
                Err(error) => Err(error),
            },
            Some("repair") => super::recovery_acceptance::repair_selected_archive(
                &native,
                &directory,
                credentials.password.as_ref(),
            )
            .await
            .and_then(|()| {
                let account = AccountId::from(
                    std::fs::read_to_string(directory.join("acceptance-account-id"))
                        .map_err(|_| "Cannot read accepted Account identity")?,
                );
                super::vault_acceptance::verify_pending(&account, &directory)
            }),
            Some("restore") => {
                match super::recovery_acceptance::verify_reopened_artifacts(&directory) {
                    Ok(()) => match acceptance_restore(&native, &credentials, &directory).await {
                        Ok(()) => {
                            super::recovery_acceptance::rebootstrap_after_convergence(
                                &native, &directory,
                            )
                            .await
                        }
                        Err(error) => Err(error),
                    },
                    Err(error) => Err(error),
                }
            }
            Some("rebootstrap-reopen") => super::recovery_acceptance::verify_rebootstrap_reopen(
                &native,
                &directory,
                credentials.password.as_ref(),
                &credentials.target_vault_id,
            )
            .await
            .and_then(|()| {
                let account = AccountId::from(
                    std::fs::read_to_string(directory.join("acceptance-account-id"))
                        .map_err(|_| "Cannot read accepted Account identity")?,
                );
                super::vault_acceptance::verify_final(&native, &account, &directory)?;
                super::protected_image_acceptance::verify_final(&account, &directory)
            }),
            Some("cleanup") => Ok(()),
            _ => Err("Unknown native acceptance child phase".into()),
        };
        if flow.is_err() {
            let _ = super::protected_image_acceptance::diagnose_pending(&directory);
            if let Ok(RuntimeProjection::RuntimeStatus(status)) = snapshot(
                &native.core,
                ObservationRequest::RuntimeStatus { account_id: None },
            ) {
                eprintln!(
                    "Native failed-phase diagnostics: startup={:?}, access/failure={:?}",
                    native.startup_error.as_ref().map(|error| error.code),
                    status
                        .accounts
                        .iter()
                        .map(|account| (account.access, account.failure, account.waiting_reason))
                        .collect::<Vec<_>>(),
                );
            }
        }
        // Successful recovery phases retain the installed Account for the next real process.
        let cleanup =
            if (phase == "sign-in" || phase == "repair" || phase == "restore") && flow.is_ok() {
                Ok(())
            } else {
                cleanup_acceptance_account(&native).await
            };
        let shutdown = native
            .shutdown()
            .await
            .map_err(|error| format!("Runtime shutdown failed: {:?}", error.code));
        if let Err(error) = &cleanup {
            eprintln!("Scoped acceptance cleanup failed: {error}");
        }
        flow.and(cleanup).and(shutdown)
    }

    #[tokio::test]
    #[ignore = "Requires the real OS keychain; run this exact test alone with --ignored"]
    async fn real_os_keychain_roundtrip_and_scoped_cleanup() -> Result<(), RuntimeError> {
        let directory = tempfile::tempdir().unwrap();
        let platform = NativePlatformStorage::open(directory.path().join("platform.sqlite"))?;
        let key = format!(
            "bittery:runtime:acceptance:{}:secret",
            directory.path().file_name().unwrap().to_string_lossy()
        );
        async fn invoke(
            platform: &NativePlatformStorage,
            request: PlatformStorageRequest,
        ) -> Result<PlatformStorageResponse, RuntimeError> {
            let response = platform
                .invoke(Zeroizing::new(serde_json::to_string(&request).unwrap()))
                .await?;
            Ok(serde_json::from_str(&response).unwrap())
        }

        let roundtrip = async {
            invoke(
                &platform,
                PlatformStorageRequest::Set {
                    area: PlatformStorageArea::DeviceSecret,
                    key: key.clone(),
                    value: SecretString::from("disposable-keychain-capability-probe"),
                },
            )
            .await?;
            invoke(
                &platform,
                PlatformStorageRequest::Get {
                    area: PlatformStorageArea::DeviceSecret,
                    key: key.clone(),
                },
            )
            .await
        }
        .await;
        // Even a failed Set can be ambiguous: always attempt this probe's individual cleanup.
        let cleanup = invoke(
            &platform,
            PlatformStorageRequest::Delete {
                area: PlatformStorageArea::DeviceSecret,
                key: key.clone(),
            },
        )
        .await;
        if let Err(error) = &roundtrip {
            eprintln!("Real OS keychain roundtrip failed: {:?}", error.code);
        }
        if let Err(error) = &cleanup {
            eprintln!("Real OS keychain scoped cleanup failed: {:?}", error.code);
        }
        let response = roundtrip?;
        cleanup?;
        assert!(matches!(
            &response,
            PlatformStorageResponse::Value { value: Some(value) }
                if value.as_ref() == "disposable-keychain-capability-probe"
        ));
        let response = invoke(
            &platform,
            PlatformStorageRequest::Get {
                area: PlatformStorageArea::DeviceSecret,
                key,
            },
        )
        .await?;
        assert!(matches!(
            response,
            PlatformStorageResponse::Value { value: None }
        ));
        Ok(())
    }

    #[tokio::test]
    async fn corrupt_normal_storage_keeps_one_core_available_for_explicit_recovery() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("replica.sqlite");
        let original = b"preserve corrupt physical bytes";
        std::fs::write(&path, original).unwrap();
        let native = NativeRuntime::open(directory.path(), config())
            .await
            .expect("Failed normal open must retain the recovery-capable owner");
        let connection = native.connection();
        assert_eq!(
            connection
                .observe(
                    "normal".into(),
                    r#"{"type":"runtimeStatus","accountId":null}"#,
                    Arc::new(Projections::default())
                )
                .unwrap_err()
                .code,
            RuntimeErrorCode::StorageUnavailable
        );
        let response = connection
            .request("inspect".into(), r#"{"type":"inspectRecovery"}"#)
            .await
            .unwrap();
        let outcome: bittery_client_core::RuntimeOutcome = serde_json::from_str(&response).unwrap();
        assert!(matches!(
            outcome,
            bittery_client_core::RuntimeOutcome::Succeeded(
                RuntimeResponse::RecoveryDiagnosed { .. }
            )
        ));
        assert_eq!(std::fs::read(path).unwrap(), original);
        native.shutdown().await.unwrap();
    }

    #[tokio::test]
    async fn dropped_native_owner_retires_core_while_renderer_connection_survives() {
        let directory = tempfile::tempdir().unwrap();
        let native = NativeRuntime::open(directory.path(), config())
            .await
            .unwrap();
        let connection = native.connection();
        drop(native);
        tokio::time::timeout(std::time::Duration::from_secs(3), async {
            loop {
                if let Some(maintenance) =
                    NativeDeviceLease::try_acquire(directory.path(), DeviceLeaseMode::Exclusive)
                        .unwrap()
                {
                    let error = connection
                        .observe(
                            "retired-owner".into(),
                            &serde_json::to_string(&ObservationRequest::RuntimeStatus {
                                account_id: None,
                            })
                            .unwrap(),
                            Arc::new(Projections::default()),
                        )
                        .unwrap_err();
                    assert_eq!(error.code, RuntimeErrorCode::RuntimeClosed);
                    drop(maintenance);
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("Native owner Drop must drain Core and release maintenance exclusion");
    }

    #[test]
    fn dropped_owner_drains_after_its_original_executor_has_stopped() {
        let directory = tempfile::tempdir().unwrap();
        let executor = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        let native = executor
            .block_on(NativeRuntime::open(directory.path(), config()))
            .unwrap();
        let connection = native.connection();
        let mut completion = native.shutdown_result.subscribe();
        drop(executor);
        drop(native);
        let waiter = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        waiter.block_on(async {
            tokio::time::timeout(std::time::Duration::from_secs(3), async {
                loop {
                    if let Some(result) = completion.borrow_and_update().clone() {
                        // The stopped original executor cancelled its scheduling tasks; cleanup
                        // must finish and report that failure, rather than wait forever or lie.
                        assert_eq!(
                            result.unwrap_err().code,
                            RuntimeErrorCode::InvariantViolation
                        );
                        break;
                    }
                    completion.changed().await.unwrap();
                }
            })
            .await
            .unwrap();
        });
        let error = connection
            .observe(
                "retired".into(),
                &serde_json::to_string(&ObservationRequest::RuntimeStatus { account_id: None })
                    .unwrap(),
                Arc::new(Projections::default()),
            )
            .unwrap_err();
        assert_eq!(error.code, RuntimeErrorCode::RuntimeClosed);
        assert!(
            NativeDeviceLease::try_acquire(directory.path(), DeviceLeaseMode::Exclusive)
                .unwrap()
                .is_some()
        );
    }

    #[tokio::test]
    async fn maintenance_excludes_normal_open_before_any_sqlite_creation() {
        use super::super::device_lease::{DeviceLeaseMode, NativeDeviceLease};
        let directory = tempfile::tempdir().unwrap();
        let maintenance =
            NativeDeviceLease::try_acquire(directory.path(), DeviceLeaseMode::Exclusive)
                .unwrap()
                .unwrap();
        assert!(matches!(
            NativeRuntime::open(directory.path(), config()).await,
            Err(RuntimeError {
                code: RuntimeErrorCode::StorageUnavailable,
                ..
            })
        ));
        assert!(!directory.path().join("replica.sqlite").exists());
        drop(maintenance);
        let native = NativeRuntime::open(directory.path(), config())
            .await
            .unwrap();
        assert!(
            NativeDeviceLease::try_acquire(directory.path(), DeviceLeaseMode::Exclusive)
                .unwrap()
                .is_none()
        );
        native.shutdown().await.unwrap();
        assert!(
            NativeDeviceLease::try_acquire(directory.path(), DeviceLeaseMode::Exclusive)
                .unwrap()
                .is_some()
        );
    }

    #[tokio::test]
    async fn real_sqlite_owner_survives_renderer_detach_and_reopens_after_shutdown() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("runtime");
        let native = NativeRuntime::open(&path, config()).await.unwrap();
        let first = native.connection();
        first.close();

        let second = native.connection();
        let projections = Arc::new(Projections::default());
        second
            .observe(
                "catalog".into(),
                r#"{"type":"runtimeStatus","accountId":null}"#,
                projections.clone(),
            )
            .unwrap();
        {
            let projections = projections.0.lock().unwrap();
            let Some(RuntimeProjection::RuntimeStatus(status)) = projections.last() else {
                panic!("Native composition must publish the Core Account catalog");
            };
            assert!(status.accounts.is_empty());
            assert!(!status.closed);
        }
        drop(second);
        native.shutdown().await.unwrap();
        native.shutdown().await.unwrap();
        let error = native
            .connection()
            .observe(
                "after-shutdown".into(),
                r#"{"type":"runtimeStatus","accountId":null}"#,
                Arc::new(Projections::default()),
            )
            .unwrap_err();
        assert_eq!(error.code, RuntimeErrorCode::RuntimeClosed);
        drop(native);

        let reopened = NativeRuntime::open(&path, config()).await.unwrap();
        let projections = Arc::new(Projections::default());
        reopened
            .connection()
            .observe(
                "reopened".into(),
                r#"{"type":"runtimeStatus","accountId":null}"#,
                projections.clone(),
            )
            .unwrap();
        {
            let projections = projections.0.lock().unwrap();
            let Some(RuntimeProjection::RuntimeStatus(status)) = projections.last() else {
                panic!("Reopened native composition must publish its catalog");
            };
            assert!(status.accounts.is_empty());
            assert!(!status.closed);
        }
        reopened.shutdown().await.unwrap();
    }
}
