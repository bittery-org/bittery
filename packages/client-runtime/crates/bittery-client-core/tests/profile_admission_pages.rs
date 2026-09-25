#![cfg(not(target_arch = "wasm32"))]

use async_trait::async_trait;
use bittery_client_core::{
    AccountId, AttachmentMoveAccountLease, AttachmentMoveAccountLeasePort, AttachmentMoveDownload,
    AttachmentMoveDownloadRequest, AttachmentMovePreparationFacade, AttachmentMoveTransferError,
    AttachmentMoveTransferPort, AttachmentMoveUpload, AttachmentMoveUploadGrant, AuthClientConfig,
    ClientPlatform, LegacyProfileFormat, ObservationRequest, ObservationSink,
    PlatformStorageInventoryContinuation, PlatformStorageKeysPage, PlatformStorageRequest,
    PlatformStorageResponse, ProfileAdmissionRequest, ProfileAdmissionResponse,
    ProfileAdmissionSource, ProfileSnapshotCloseSelector, ProfileSourceContinuation,
    ProfileSourceFamily, ProfileSourceFamilyInventory, ProfileSourceObservation, ProfileSourcePage,
    ProfileSourcePresence, ProfileSourceSelector, Runtime, RuntimeError, RuntimeErrorCode,
    RuntimeProjection, SerializedHttpExecutor, SerializedPlatformStorageExecutor,
    SerializedProfileAdmissionExecutor, SerializedReplicaExecutor, SqliteAttachmentArtifactStore,
    SqliteReplica, SqliteVaultImageArtifactStore, VaultImageIngressFacade, VaultImageSource,
    VaultImageSourceError, VaultImageSourceGrant, VaultImageSourcePort,
};
use std::{
    path::PathBuf,
    sync::{Arc, Mutex},
};
use zeroize::Zeroizing;

const SNAPSHOT_HANDLE: &str = "paged-desktop-snapshot";

struct TestDirectory(PathBuf);

impl TestDirectory {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!(
            "bittery-profile-pages-{}",
            bittery_crypto_core::generate_uuid()
        ));
        std::fs::create_dir(&path).unwrap();
        Self(path)
    }
}

impl Drop for TestDirectory {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

#[derive(Default)]
struct EmptyPlatform;

const STAGING_UNAVAILABLE: &str = "Source reader fixture has no destination staging";

#[async_trait]
impl SerializedPlatformStorageExecutor for EmptyPlatform {
    async fn invoke(&self, request: Zeroizing<String>) -> Result<Zeroizing<String>, RuntimeError> {
        let response = match serde_json::from_str::<PlatformStorageRequest>(&request).unwrap() {
            PlatformStorageRequest::Get { .. } => PlatformStorageResponse::Value { value: None },
            PlatformStorageRequest::ListKeys { area, .. } => {
                PlatformStorageResponse::KeysPage(PlatformStorageKeysPage {
                    version: 1,
                    family: bittery_client_core::PlatformStorageInventoryFamily::PlatformStorage,
                    backing_areas: vec![area],
                    keys: Vec::new(),
                    continuation: PlatformStorageInventoryContinuation::End {},
                })
            }
            PlatformStorageRequest::Set { .. } => {
                return Err(RuntimeError {
                    code: RuntimeErrorCode::StorageUnavailable,
                    message: STAGING_UNAVAILABLE.into(),
                    recovery_bound: None,
                    team_page_problem: None,
                });
            }
            _ => panic!("admission must not mutate destination platform storage"),
        };
        Ok(Zeroizing::new(serde_json::to_string(&response).unwrap()))
    }
}

struct NoNetwork;

#[async_trait]
impl SerializedHttpExecutor for NoNetwork {
    async fn invoke(&self, _: Zeroizing<String>) -> Result<String, RuntimeError> {
        panic!("profile admission must not use the network")
    }

    fn cancel(&self, _: &str) {}
}

#[async_trait]
impl AttachmentMoveTransferPort for NoNetwork {
    async fn open_source(
        &self,
        _: AttachmentMoveDownloadRequest,
    ) -> Result<Box<dyn AttachmentMoveDownload>, AttachmentMoveTransferError> {
        panic!("profile admission must not download Attachments")
    }

    async fn open_upload(
        &self,
        _: &AccountId,
        _: &str,
        _: &AttachmentMoveUploadGrant,
        _: &bittery_client_core::AttachmentArtifactOwner,
    ) -> Result<Box<dyn AttachmentMoveUpload>, AttachmentMoveTransferError> {
        panic!("profile admission must not upload Attachments")
    }
}

struct LiveLease;

#[async_trait]
impl AttachmentMoveAccountLease for LiveLease {
    fn is_live(&self) -> bool {
        true
    }

    async fn lost(&self) {
        std::future::pending().await
    }
}

struct LiveLeasePort;

#[async_trait]
impl AttachmentMoveAccountLeasePort for LiveLeasePort {
    async fn acquire(
        &self,
        _: &AccountId,
    ) -> Result<Option<Box<dyn AttachmentMoveAccountLease>>, RuntimeError> {
        Ok(Some(Box::new(LiveLease)))
    }
}

struct UnusedVaultImageSource;

#[async_trait]
impl VaultImageSourcePort for UnusedVaultImageSource {
    async fn claim(
        &self,
        _: &VaultImageSourceGrant,
    ) -> Result<Box<dyn VaultImageSource>, VaultImageSourceError> {
        panic!("profile admission must not claim Vault image input")
    }

    async fn retire_account(&self, _: &str, _: &AccountId) -> Result<(), VaultImageSourceError> {
        Ok(())
    }

    async fn complete_account_retirement(
        &self,
        _: &str,
        _: &AccountId,
    ) -> Result<(), VaultImageSourceError> {
        Ok(())
    }

    async fn begin_acceptance(
        &self,
        _: &str,
        _: &AccountId,
        _: &str,
    ) -> Result<(), VaultImageSourceError> {
        panic!("profile admission must not accept Vault image input")
    }

    async fn end_acceptance(
        &self,
        _: &str,
        _: &AccountId,
        _: &str,
    ) -> Result<(), VaultImageSourceError> {
        panic!("profile admission must not release Vault image input")
    }

    async fn retire_vaults(
        &self,
        _: &str,
        _: &AccountId,
        _: &[String],
    ) -> Result<(), VaultImageSourceError> {
        Ok(())
    }

    async fn complete_vault_retirement(
        &self,
        _: &str,
        _: &AccountId,
        _: &[String],
    ) -> Result<(), VaultImageSourceError> {
        Ok(())
    }

    async fn forget_account_vault_retirements(
        &self,
        _: &str,
        _: &AccountId,
    ) -> Result<(), VaultImageSourceError> {
        Ok(())
    }

    async fn retire_runtime(&self, _: &str) -> Result<(), VaultImageSourceError> {
        Ok(())
    }
}

#[derive(Default)]
struct Sink(Mutex<Vec<RuntimeProjection>>);

impl ObservationSink for Sink {
    fn publish(&self, projection: RuntimeProjection) {
        self.0.lock().unwrap().push(projection);
    }
}

#[derive(Clone, Copy, Debug)]
enum PageBehavior {
    Valid,
    MalformedControl,
    DuplicateControl,
    UnknownControl,
    ChangedObservation,
    ShortEnd,
    OverlongBinary,
    OversizedControl,
    OversizedBinary,
    RepeatedCursor,
    LargeAcrossPages,
    EmptyPresentStore,
    MissingStore,
}

struct DesktopPages {
    behavior: PageBehavior,
    requests: Mutex<Vec<ProfileAdmissionRequest>>,
}

impl DesktopPages {
    fn valid() -> Self {
        Self::with_behavior(PageBehavior::Valid)
    }

    fn with_behavior(behavior: PageBehavior) -> Self {
        Self {
            behavior,
            requests: Mutex::new(Vec::new()),
        }
    }
}

#[async_trait]
impl SerializedProfileAdmissionExecutor for DesktopPages {
    async fn invoke(
        &self,
        request: Zeroizing<String>,
    ) -> Result<(Zeroizing<String>, Option<Zeroizing<Vec<u8>>>), RuntimeError> {
        let request: ProfileAdmissionRequest = serde_json::from_str(&request).unwrap();
        self.requests.lock().unwrap().push(request.clone());
        if matches!(
            &request,
            ProfileAdmissionRequest::ReadSourcePage {
                family: ProfileSourceFamily::DesktopStore,
                cursor: None,
                ..
            }
        ) {
            match self.behavior {
                PageBehavior::MalformedControl => {
                    return Ok((Zeroizing::new("{".into()), None));
                }
                PageBehavior::UnknownControl => {
                    return Ok((
                        Zeroizing::new(
                            serde_json::json!({
                                "type":"sourcePage", "snapshotHandle":SNAPSHOT_HANDLE,
                                "family":"desktopStore", "selector":{"type":"wholeFile"},
                                "observation":{"type":"fileBytes", "length":"0"},
                                "offset":"0", "byteLength":"0",
                                "continuation":{"type":"end"}, "unknown":true
                            })
                            .to_string(),
                        ),
                        Some(Zeroizing::new(Vec::new())),
                    ));
                }
                PageBehavior::DuplicateControl => {
                    return Ok((
                        Zeroizing::new(format!(
                            "{{\"type\":\"sourcePage\",\"snapshotHandle\":\"{SNAPSHOT_HANDLE}\",\"family\":\"desktopStore\",\"selector\":{{\"type\":\"wholeFile\"}},\"observation\":{{\"type\":\"fileBytes\",\"length\":\"0\"}},\"offset\":\"0\",\"offset\":\"0\",\"byteLength\":\"0\",\"continuation\":{{\"type\":\"end\"}}}}"
                        )),
                        Some(Zeroizing::new(Vec::new())),
                    ));
                }
                PageBehavior::OversizedControl => {
                    return Ok((
                        Zeroizing::new(
                            "x".repeat(bittery_client_core::PROFILE_SOURCE_CONTROL_BYTES + 1),
                        ),
                        None,
                    ));
                }
                _ => {}
            }
        }
        let (response, binary) = match request {
            ProfileAdmissionRequest::BeginSourceSnapshot { format } => {
                assert_eq!(format, LegacyProfileFormat::DesktopLegacyV1);
                (
                    ProfileAdmissionResponse::SourceSnapshot {
                        snapshot: bittery_client_core::ProfileSourceSnapshot {
                            format,
                            snapshot_handle: SNAPSHOT_HANDLE.into(),
                            profile_identity: "isolated-page-profile".into(),
                            capture_id: "isolated-page-capture".into(),
                            families: vec![
                                ProfileSourceFamilyInventory {
                                    family: ProfileSourceFamily::DesktopStore,
                                    presence: if matches!(self.behavior, PageBehavior::MissingStore)
                                    {
                                        ProfileSourcePresence::Missing
                                    } else {
                                        ProfileSourcePresence::Present
                                    },
                                    file_identity: (!matches!(
                                        self.behavior,
                                        PageBehavior::MissingStore
                                    ))
                                    .then(|| "page-store-file".into()),
                                },
                                ProfileSourceFamilyInventory {
                                    family: ProfileSourceFamily::DesktopSyncStore,
                                    presence: ProfileSourcePresence::Missing,
                                    file_identity: None,
                                },
                                ProfileSourceFamilyInventory {
                                    family: ProfileSourceFamily::DesktopCredentials,
                                    presence: ProfileSourcePresence::Missing,
                                    file_identity: None,
                                },
                            ],
                            session_instance: None,
                        },
                    },
                    None,
                )
            }
            ProfileAdmissionRequest::ReadSourcePage {
                snapshot_handle,
                family,
                selector,
                cursor,
            } => {
                assert_eq!(snapshot_handle, SNAPSHOT_HANDLE);
                if family == ProfileSourceFamily::DesktopCredentials {
                    assert_eq!(
                        selector,
                        ProfileSourceSelector::GlobalCredential {
                            field: bittery_client_core::ProfileGlobalCredentialField::DeviceKey,
                        }
                    );
                    assert!(cursor.is_none());
                    return Ok((
                        Zeroizing::new(
                            serde_json::to_string(&ProfileAdmissionResponse::SourcePage(
                                ProfileSourcePage {
                                    snapshot_handle,
                                    family,
                                    selector,
                                    observation: ProfileSourceObservation::Missing {},
                                    offset: 0,
                                    byte_length: 0,
                                    continuation: ProfileSourceContinuation::End {},
                                },
                            ))
                            .unwrap(),
                        ),
                        None,
                    ));
                }
                assert_eq!(selector, ProfileSourceSelector::WholeFile {});
                match (self.behavior, family, cursor.as_deref()) {
                    (
                        PageBehavior::Valid
                        | PageBehavior::ChangedObservation
                        | PageBehavior::RepeatedCursor,
                        ProfileSourceFamily::DesktopStore,
                        None,
                    ) => (
                        ProfileAdmissionResponse::SourcePage(ProfileSourcePage {
                            snapshot_handle,
                            family,
                            selector,
                            observation: ProfileSourceObservation::FileBytes {
                                length: if matches!(self.behavior, PageBehavior::RepeatedCursor) {
                                    6
                                } else {
                                    4
                                },
                            },
                            offset: 0,
                            byte_length: 2,
                            continuation: ProfileSourceContinuation::More {
                                cursor: "store-tail".into(),
                            },
                        }),
                        Some(Zeroizing::new(b"{}".to_vec())),
                    ),
                    (
                        PageBehavior::Valid | PageBehavior::ChangedObservation,
                        ProfileSourceFamily::DesktopStore,
                        Some("store-tail"),
                    ) => (
                        ProfileAdmissionResponse::SourcePage(ProfileSourcePage {
                            snapshot_handle,
                            family,
                            selector,
                            observation: ProfileSourceObservation::FileBytes {
                                length: if matches!(self.behavior, PageBehavior::ChangedObservation)
                                {
                                    5
                                } else {
                                    4
                                },
                            },
                            offset: 2,
                            byte_length: 2,
                            continuation: ProfileSourceContinuation::End {},
                        }),
                        Some(Zeroizing::new(b"\n\n".to_vec())),
                    ),
                    (
                        PageBehavior::RepeatedCursor,
                        ProfileSourceFamily::DesktopStore,
                        Some("store-tail"),
                    ) => (
                        ProfileAdmissionResponse::SourcePage(ProfileSourcePage {
                            snapshot_handle,
                            family,
                            selector,
                            observation: ProfileSourceObservation::FileBytes { length: 6 },
                            offset: 2,
                            byte_length: 2,
                            continuation: ProfileSourceContinuation::More {
                                cursor: "store-tail".into(),
                            },
                        }),
                        Some(Zeroizing::new(b"\n\n".to_vec())),
                    ),
                    (PageBehavior::ShortEnd, ProfileSourceFamily::DesktopStore, None) => (
                        ProfileAdmissionResponse::SourcePage(ProfileSourcePage {
                            snapshot_handle,
                            family,
                            selector,
                            observation: ProfileSourceObservation::FileBytes { length: 4 },
                            offset: 0,
                            byte_length: 2,
                            continuation: ProfileSourceContinuation::End {},
                        }),
                        Some(Zeroizing::new(b"{}".to_vec())),
                    ),
                    (PageBehavior::OverlongBinary, ProfileSourceFamily::DesktopStore, None) => (
                        ProfileAdmissionResponse::SourcePage(ProfileSourcePage {
                            snapshot_handle,
                            family,
                            selector,
                            observation: ProfileSourceObservation::FileBytes { length: 2 },
                            offset: 0,
                            byte_length: 2,
                            continuation: ProfileSourceContinuation::End {},
                        }),
                        Some(Zeroizing::new(b"{}!".to_vec())),
                    ),
                    (PageBehavior::OversizedBinary, ProfileSourceFamily::DesktopStore, None) => {
                        let length = bittery_client_core::PROFILE_SOURCE_BINARY_BYTES + 1;
                        (
                            ProfileAdmissionResponse::SourcePage(ProfileSourcePage {
                                snapshot_handle,
                                family,
                                selector,
                                observation: ProfileSourceObservation::FileBytes {
                                    length: length as u64,
                                },
                                offset: 0,
                                byte_length: length as u64,
                                continuation: ProfileSourceContinuation::End {},
                            }),
                            Some(Zeroizing::new(vec![0; length])),
                        )
                    }
                    (PageBehavior::LargeAcrossPages, ProfileSourceFamily::DesktopStore, None) => {
                        let length = bittery_client_core::PROFILE_SOURCE_BINARY_BYTES;
                        let mut bytes = Vec::with_capacity(length);
                        bytes.extend_from_slice(b"{}");
                        bytes.resize(length, b' ');
                        (
                            ProfileAdmissionResponse::SourcePage(ProfileSourcePage {
                                snapshot_handle,
                                family,
                                selector,
                                observation: ProfileSourceObservation::FileBytes {
                                    length: length as u64 + 1,
                                },
                                offset: 0,
                                byte_length: length as u64,
                                continuation: ProfileSourceContinuation::More {
                                    cursor: "large-store-tail".into(),
                                },
                            }),
                            Some(Zeroizing::new(bytes)),
                        )
                    }
                    (
                        PageBehavior::LargeAcrossPages,
                        ProfileSourceFamily::DesktopStore,
                        Some("large-store-tail"),
                    ) => (
                        ProfileAdmissionResponse::SourcePage(ProfileSourcePage {
                            snapshot_handle,
                            family,
                            selector,
                            observation: ProfileSourceObservation::FileBytes {
                                length: bittery_client_core::PROFILE_SOURCE_BINARY_BYTES as u64 + 1,
                            },
                            offset: bittery_client_core::PROFILE_SOURCE_BINARY_BYTES as u64,
                            byte_length: 1,
                            continuation: ProfileSourceContinuation::End {},
                        }),
                        Some(Zeroizing::new(vec![b' '])),
                    ),
                    (PageBehavior::EmptyPresentStore, ProfileSourceFamily::DesktopStore, None) => (
                        ProfileAdmissionResponse::SourcePage(ProfileSourcePage {
                            snapshot_handle,
                            family,
                            selector,
                            observation: ProfileSourceObservation::FileBytes { length: 0 },
                            offset: 0,
                            byte_length: 0,
                            continuation: ProfileSourceContinuation::End {},
                        }),
                        Some(Zeroizing::new(Vec::new())),
                    ),
                    (PageBehavior::MissingStore, ProfileSourceFamily::DesktopStore, None) => (
                        ProfileAdmissionResponse::SourcePage(ProfileSourcePage {
                            snapshot_handle,
                            family,
                            selector,
                            observation: ProfileSourceObservation::Missing {},
                            offset: 0,
                            byte_length: 0,
                            continuation: ProfileSourceContinuation::End {},
                        }),
                        None,
                    ),
                    (
                        PageBehavior::Valid
                        | PageBehavior::LargeAcrossPages
                        | PageBehavior::EmptyPresentStore
                        | PageBehavior::MissingStore,
                        ProfileSourceFamily::DesktopSyncStore,
                        None,
                    ) => (
                        ProfileAdmissionResponse::SourcePage(ProfileSourcePage {
                            snapshot_handle,
                            family,
                            selector,
                            observation: ProfileSourceObservation::Missing {},
                            offset: 0,
                            byte_length: 0,
                            continuation: ProfileSourceContinuation::End {},
                        }),
                        None,
                    ),
                    _ => panic!("unexpected page read"),
                }
            }
            ProfileAdmissionRequest::CloseSourceSnapshot { selector } => {
                assert_eq!(
                    selector,
                    ProfileSnapshotCloseSelector::Exact {
                        handle: SNAPSHOT_HANDLE.into()
                    }
                );
                (ProfileAdmissionResponse::SourceSnapshotClosed {}, None)
            }
            ProfileAdmissionRequest::VerifySourceSnapshot { step } => {
                use bittery_client_core::{
                    ProfileSourceVerificationResult as Verification,
                    ProfileSourceVerifyStep as Step,
                };
                let result = match step {
                    Step::Start { header, .. } => {
                        assert_eq!(header.entry_count, 3);
                        Verification::Started {
                            verification_cursor: "verify:0".into(),
                            next_index: 0,
                        }
                    }
                    Step::Entry { index, .. } => Verification::Matched {
                        verification_cursor: format!("verify:{}", index + 1),
                        next_index: index + 1,
                    },
                    Step::Finish { .. } => Verification::Unchanged {
                        snapshot_handle: SNAPSHOT_HANDLE.into(),
                    },
                };
                (
                    ProfileAdmissionResponse::SourceSnapshotVerification { result },
                    None,
                )
            }
            ProfileAdmissionRequest::PrepareLegacyProfileReset { .. }
            | ProfileAdmissionRequest::ResetLegacySourceFamily { .. }
            | ProfileAdmissionRequest::ReopenSourceForCleanup { .. }
            | ProfileAdmissionRequest::DeleteCapturedSource { .. } => {
                panic!("page-only fixture cannot clean up source")
            }
            ProfileAdmissionRequest::ReopenSourceSnapshot { .. } => {
                panic!("Initial source reading must not verify or reopen a snapshot")
            }
        };
        Ok((
            Zeroizing::new(serde_json::to_string(&response).unwrap()),
            binary,
        ))
    }
}

async fn runtime_with_source(
    directory: &TestDirectory,
    source: Arc<dyn SerializedProfileAdmissionExecutor>,
) -> Arc<Runtime> {
    runtime_with_platform_and_source(directory, Arc::new(EmptyPlatform), source).await
}

async fn runtime_with_platform_and_source(
    directory: &TestDirectory,
    platform: Arc<dyn SerializedPlatformStorageExecutor>,
    source: Arc<dyn SerializedProfileAdmissionExecutor>,
) -> Arc<Runtime> {
    let runtime = runtime_with_platform(directory, platform).await;
    runtime
        .set_profile_admission_source(ProfileAdmissionSource::Legacy {
            format: LegacyProfileFormat::DesktopLegacyV1,
            executor: source,
        })
        .await
        .unwrap();
    runtime
}

async fn runtime_with_platform(
    directory: &TestDirectory,
    platform: Arc<dyn SerializedPlatformStorageExecutor>,
) -> Arc<Runtime> {
    let replica: Arc<dyn SerializedReplicaExecutor> =
        Arc::new(SqliteReplica::open(directory.0.join("replica.sqlite")).unwrap());
    runtime_with_platform_and_replica(directory, platform, replica).await
}

async fn runtime_with_platform_and_replica(
    directory: &TestDirectory,
    platform: Arc<dyn SerializedPlatformStorageExecutor>,
    replica: Arc<dyn SerializedReplicaExecutor>,
) -> Arc<Runtime> {
    let network = Arc::new(NoNetwork);
    let attachments = Arc::new(
        SqliteAttachmentArtifactStore::open(directory.0.join("attachments.sqlite")).unwrap(),
    );
    let runtime = Runtime::with_configured_serialized_executors_and_attachment_move_preparation(
        replica,
        platform,
        network.clone(),
        AuthClientConfig::new(
            "profile-pages".into(),
            ClientPlatform::Desktop,
            "0.5.2".into(),
        )
        .unwrap(),
        AttachmentMovePreparationFacade::new(attachments.clone(), attachments, network),
        Arc::new(LiveLeasePort),
    );
    runtime.install_vault_image_ingress(
        VaultImageIngressFacade::new(
            "profile-page-runtime",
            Arc::new(UnusedVaultImageSource),
            Arc::new(
                SqliteVaultImageArtifactStore::open(directory.0.join("vault-images.sqlite"))
                    .unwrap(),
            ),
        )
        .unwrap(),
    );
    runtime
}

#[tokio::test]
async fn runtime_reads_both_desktop_file_families_before_retaining_the_incomplete_fence() {
    let directory = TestDirectory::new();
    let source = Arc::new(DesktopPages::valid());
    let runtime = runtime_with_source(&directory, source.clone()).await;

    let error = runtime
        .open()
        .await
        .expect_err("valid source pages must reach the fixture destination refusal");
    let requests_after_open = source.requests.lock().unwrap().clone();
    let sink = Arc::new(Sink::default());
    let observation = runtime.observe(
        ObservationRequest::RuntimeStatus { account_id: None },
        sink.clone(),
    );
    runtime.close().await;

    assert_eq!(error.code, RuntimeErrorCode::StorageUnavailable);
    assert_eq!(error.message, STAGING_UNAVAILABLE);
    assert_eq!(
        requests_after_open
            .iter()
            .filter(|request| !matches!(
                request,
                ProfileAdmissionRequest::VerifySourceSnapshot { .. }
            ))
            .cloned()
            .collect::<Vec<_>>(),
        vec![
            ProfileAdmissionRequest::BeginSourceSnapshot {
                format: LegacyProfileFormat::DesktopLegacyV1,
            },
            ProfileAdmissionRequest::ReadSourcePage {
                snapshot_handle: SNAPSHOT_HANDLE.into(),
                family: ProfileSourceFamily::DesktopStore,
                selector: ProfileSourceSelector::WholeFile {},
                cursor: None,
            },
            ProfileAdmissionRequest::ReadSourcePage {
                snapshot_handle: SNAPSHOT_HANDLE.into(),
                family: ProfileSourceFamily::DesktopStore,
                selector: ProfileSourceSelector::WholeFile {},
                cursor: Some("store-tail".into()),
            },
            ProfileAdmissionRequest::ReadSourcePage {
                snapshot_handle: SNAPSHOT_HANDLE.into(),
                family: ProfileSourceFamily::DesktopSyncStore,
                selector: ProfileSourceSelector::WholeFile {},
                cursor: None,
            },
            ProfileAdmissionRequest::ReadSourcePage {
                snapshot_handle: SNAPSHOT_HANDLE.into(),
                family: ProfileSourceFamily::DesktopCredentials,
                selector: ProfileSourceSelector::GlobalCredential {
                    field: bittery_client_core::ProfileGlobalCredentialField::DeviceKey,
                },
                cursor: None,
            },
            ProfileAdmissionRequest::CloseSourceSnapshot {
                selector: ProfileSnapshotCloseSelector::Exact {
                    handle: SNAPSHOT_HANDLE.into(),
                },
            },
        ]
    );
    assert!(observation.is_err());
    assert!(sink.0.lock().unwrap().is_empty());
    assert_eq!(
        *source.requests.lock().unwrap(),
        requests_after_open,
        "Runtime close must not repeat cleanup after the refusal already released the reader"
    );
}

async fn refused_page(behavior: PageBehavior) -> (RuntimeError, Vec<ProfileAdmissionRequest>) {
    let directory = TestDirectory::new();
    let source = Arc::new(DesktopPages::with_behavior(behavior));
    let runtime = runtime_with_source(&directory, source.clone()).await;
    let error = runtime
        .open()
        .await
        .expect_err("an invalid source page must keep admission fenced");
    let sink = Arc::new(Sink::default());
    assert!(runtime
        .observe(
            ObservationRequest::RuntimeStatus { account_id: None },
            sink.clone(),
        )
        .is_err());
    assert!(sink.0.lock().unwrap().is_empty());
    runtime.close().await;
    let requests = source.requests.lock().unwrap().clone();
    assert!(matches!(
        requests.last(),
        Some(ProfileAdmissionRequest::CloseSourceSnapshot {
            selector: ProfileSnapshotCloseSelector::Exact { handle }
        }) if handle == SNAPSHOT_HANDLE
    ));
    (error, requests)
}

#[tokio::test]
async fn malformed_unknown_or_independently_oversized_page_results_are_refused() {
    for (behavior, message) in [
        (
            PageBehavior::MalformedControl,
            "Profile source response is malformed",
        ),
        (
            PageBehavior::UnknownControl,
            "Profile source response is malformed",
        ),
        (
            PageBehavior::DuplicateControl,
            "Profile source response is malformed",
        ),
        (
            PageBehavior::OversizedControl,
            "Profile source response exceeds its control bound",
        ),
        (
            PageBehavior::OversizedBinary,
            "Profile source response exceeds its binary bound",
        ),
    ] {
        let (error, _) = refused_page(behavior).await;
        assert_eq!(
            error.code,
            RuntimeErrorCode::InvariantViolation,
            "{behavior:?}"
        );
        assert_eq!(error.message, message, "{behavior:?}");
    }
}

#[tokio::test]
async fn changed_short_overlong_or_repeated_cursor_pages_are_refused() {
    for behavior in [
        PageBehavior::ChangedObservation,
        PageBehavior::ShortEnd,
        PageBehavior::OverlongBinary,
        PageBehavior::RepeatedCursor,
    ] {
        let (error, _) = refused_page(behavior).await;
        assert_eq!(
            error.code,
            RuntimeErrorCode::InvariantViolation,
            "{behavior:?}"
        );
    }
}

#[tokio::test]
async fn aggregate_source_larger_than_one_page_has_no_whole_profile_quota() {
    let directory = TestDirectory::new();
    let source = Arc::new(DesktopPages::with_behavior(PageBehavior::LargeAcrossPages));
    let runtime = runtime_with_source(&directory, source.clone()).await;
    let error = runtime.open().await.expect_err(
        "a valid aggregate larger than the response limit reaches the incomplete admission fence",
    );
    runtime.close().await;

    assert_eq!(error.message, STAGING_UNAVAILABLE);
    assert!(source.requests.lock().unwrap().iter().any(|request| {
        matches!(request, ProfileAdmissionRequest::ReadSourcePage {
            family: ProfileSourceFamily::DesktopStore,
            cursor: Some(cursor), ..
        } if cursor == "large-store-tail")
    }));
}

#[tokio::test]
async fn present_empty_file_and_missing_file_remain_distinct() {
    let (empty, _) = refused_page(PageBehavior::EmptyPresentStore).await;
    let (missing, _) = refused_page(PageBehavior::MissingStore).await;

    assert_eq!(empty.message, "Legacy Desktop store is malformed");
    assert_eq!(missing.message, STAGING_UNAVAILABLE);
}

#[path = "profile_admission_pages/desktop.rs"]
mod desktop;

#[path = "profile_admission_pages/import.rs"]
mod import;

#[path = "profile_admission_pages/cleanup.rs"]
mod cleanup;

#[path = "profile_admission_pages/reset.rs"]
mod reset;

#[path = "profile_admission_pages/abort.rs"]
mod abort;
