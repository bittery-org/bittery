use super::*;
use crate::{
    LegacyProfileFormat, ProfileAdmissionRequest, ProfileAdmissionResponse, ProfileAdmissionSource,
    ProfileSnapshotCloseSelector, ProfileSourceFamily, ProfileSourceSnapshot,
    SerializedProfileAdmissionExecutor, PROFILE_SOURCE_BINARY_BYTES, PROFILE_SOURCE_CONTROL_BYTES,
    PROFILE_SOURCE_IDENTITY_BYTES,
};
use zeroize::Zeroizing;

mod abort;
mod census;
mod cleanup;
mod desktop;
mod install;
mod reset;
mod source;
mod verification;

impl Runtime {
    /// Trusted composition chooses the source once, before the first open attempt.
    #[doc(hidden)]
    pub async fn set_profile_admission_source(
        &self,
        source: crate::ProfileAdmissionSource,
    ) -> Result<(), RuntimeError> {
        let _catalog = self.catalog_transition.lock().await;
        self.ensure_not_closed()?;
        let mut admission = self
            .profile_admission
            .lock()
            .expect("profile admission configuration lock poisoned");
        if admission.started || admission.source.is_some() || self.ready.load(Ordering::SeqCst) {
            return Err(startup_invariant(
                "Profile admission source must be configured once before open",
            ));
        }
        admission.source = Some(source);
        Ok(())
    }

    pub(super) fn start_profile_admission_open(&self) -> ProfileAdmissionSource {
        let mut admission = self
            .profile_admission
            .lock()
            .expect("profile admission configuration lock poisoned");
        // Seal composition before the first fallible read, including an ordinary CoreOnly open.
        admission.started = true;
        admission
            .source
            .get_or_insert(ProfileAdmissionSource::CoreOnly)
            .clone()
    }

    pub(super) async fn admit_profile_before_open(
        &self,
        catalog: Option<DeviceCatalogDocument>,
        source: ProfileAdmissionSource,
    ) -> Result<Option<DeviceCatalogDocument>, RuntimeError> {
        if catalog
            .as_ref()
            .is_some_and(DeviceCatalogDocument::profile_reset_wiping)
        {
            return Err(RuntimeError::new(
                RuntimeErrorCode::StorageUnavailable,
                "Profile reset must finish before startup",
            ));
        }
        if catalog
            .as_ref()
            .and_then(DeviceCatalogDocument::admission_record)
            .is_some_and(|record| {
                record.phase()
                    == Some(crate::platform_storage::profile_admission::ImportPhase::Aborting)
            })
        {
            return Err(startup_invariant(
                "Profile admission Abort must finish before startup",
            ));
        }
        let (format, executor) = match source {
            ProfileAdmissionSource::CoreOnly => return Ok(catalog),
            ProfileAdmissionSource::LegacyUnavailable { .. } => {
                if catalog.as_ref().is_some_and(|catalog| {
                    catalog.profile_admission_complete()
                        || catalog.profile_reset_wiped()
                        || catalog.profile_admission_committed()
                }) {
                    return Ok(catalog);
                }
                return Err(RuntimeError::new(
                    RuntimeErrorCode::StorageUnavailable,
                    "Legacy profile admission requires its source provider before startup",
                ));
            }
            ProfileAdmissionSource::Legacy { format, executor } => (format, executor),
        };
        let authoritative = catalog.as_ref().is_some_and(|catalog| {
            catalog.profile_admission_complete()
                || catalog.profile_reset_wiped()
                || catalog.profile_admission_committed()
        });
        let cleanup_only = self
            .profile_admission
            .lock()
            .expect("profile admission configuration lock poisoned")
            .cleanup_only;
        if let Err(error) = self.reconcile_profile_source_cleanup().await {
            if authoritative && cleanup_only {
                // A detached cleanup operation has no destination or import authority. Keep its
                // Close duty, skip another cleanup attempt, and publish the committed Core owner.
                return Ok(catalog);
            }
            return Err(error);
        }
        self.ensure_not_closed()?;
        if catalog.as_ref().is_some_and(|catalog| {
            catalog.profile_admission_complete() || catalog.profile_reset_wiped()
        }) {
            return Ok(catalog);
        }
        if catalog
            .as_ref()
            .is_some_and(DeviceCatalogDocument::profile_admission_committed)
        {
            return self
                .cleanup_committed_profile(
                    catalog.expect("checked Committed catalog"),
                    executor.as_ref(),
                )
                .await
                .map(Some);
        }
        if let Some(catalog) = catalog.as_ref().filter(|catalog| {
            catalog.admission_record().is_some_and(|record| {
                record.phase()
                    == Some(crate::platform_storage::profile_admission::ImportPhase::Aborted)
            })
        }) {
            self.verify_aborted_profile_destination(catalog).await?;
        }
        let recorded = catalog
            .as_ref()
            .and_then(DeviceCatalogDocument::admission_record)
            .filter(|record| {
                record.phase()
                    == Some(crate::platform_storage::profile_admission::ImportPhase::Preparing)
            })
            .and_then(crate::platform_storage::profile_admission::ProfileAdmissionRecord::progress)
            .map(|progress| source::Manifest {
                header: progress.manifest.header.clone(),
                entries: progress.manifest.entries.clone(),
            });
        if recorded
            .as_ref()
            .is_some_and(|manifest| manifest.header.format != format)
        {
            return Err(startup_invariant(
                "Recorded admission requires another profile source format",
            ));
        }
        // Issued physical work can outlive this future. Record cleanup before invoking Begin/Reopen,
        // including when its response is lost, malformed or never delivered to Core.
        self.record_profile_source_cleanup(false);
        let result: Result<Option<DeviceCatalogDocument>, RuntimeError> = async {
            let snapshot = if let Some(manifest) = &recorded {
                verification::reopen(self, executor.as_ref(), manifest).await?
            } else {
                let response = invoke_source(
                    executor.as_ref(),
                    ProfileAdmissionRequest::BeginSourceSnapshot { format },
                )
                .await?;
                let ProfileAdmissionResponse::SourceSnapshot { snapshot } = response else {
                    return Err(startup_invariant("Profile source did not begin a snapshot"));
                };
                snapshot
            };
            validate_source_snapshot(&snapshot, format)?;
            self.profile_admission
                .lock()
                .expect("profile admission configuration lock poisoned")
                .cleanup_snapshot = Some(ProfileSnapshotCloseSelector::Exact {
                handle: snapshot.snapshot_handle.clone(),
            });
            self.ensure_not_closed()?;
            if recorded.is_none() {
                self.require_empty_admission_replica().await?;
                use crate::platform_storage::PlatformStorageValue;
                census::platform(
                    self,
                    &[
                        PlatformStorageValue::DeviceCatalog,
                        PlatformStorageValue::DeviceKey,
                        PlatformStorageValue::LocalSecurity,
                    ],
                )
                .await?;
            }
            self.require_empty_admission_attachment_artifacts().await?;
            self.require_empty_admission_vault_images().await?;
            if format != LegacyProfileFormat::DesktopLegacyV1 {
                return Err(RuntimeError::new(
                    RuntimeErrorCode::StorageUnavailable,
                    "Legacy profile admission is incomplete",
                ));
            }
            let sources = source::read_desktop_sources(self, executor.as_ref(), &snapshot).await?;
            let decoded = desktop::decode(self, executor.as_ref(), &snapshot, sources).await?;
            let manifest = recorded.unwrap_or_else(|| source::Manifest {
                header: decoded.manifest.header.clone(),
                entries: decoded.manifest.entries.clone(),
            });
            verification::verify(self, executor.as_ref(), &snapshot, &manifest).await?;
            let mut prepared = install::prepare(self, catalog, decoded).await?;
            let allowed_platform = prepared.allowed_platform_values();
            let expected_snapshots = prepared.expected_snapshots();
            census::platform(self, &allowed_platform).await?;
            census::replica(self, &expected_snapshots).await?;
            install::stage(self, &mut prepared).await?;
            verification::verify(self, executor.as_ref(), &snapshot, &manifest).await?;
            census::platform(self, &allowed_platform).await?;
            census::replica(self, &expected_snapshots).await?;
            self.require_empty_admission_attachment_artifacts().await?;
            self.require_empty_admission_vault_images().await?;
            install::commit(self, &mut prepared).await.map(Some)
        }
        .await;
        // Closing releases temporary source readers only; it neither mutates source evidence nor
        // relinquishes the executor's exclusive profile ownership.
        let closed = self.reconcile_profile_source_cleanup().await;
        let catalog = match result {
            Err(error) => return Err(error),
            Ok(catalog) => {
                closed?;
                catalog
            }
        };
        match catalog {
            Some(catalog) if catalog.profile_admission_committed() => self
                .cleanup_committed_profile(catalog, executor.as_ref())
                .await
                .map(Some),
            catalog => Ok(catalog),
        }
    }

    fn record_profile_source_cleanup(&self, cleanup_only: bool) {
        let mut admission = self
            .profile_admission
            .lock()
            .expect("profile admission configuration lock poisoned");
        admission.cleanup_snapshot = Some(ProfileSnapshotCloseSelector::CurrentCapability {});
        admission.cleanup_only = cleanup_only;
    }

    async fn cleanup_committed_profile(
        &self,
        catalog: DeviceCatalogDocument,
        executor: &dyn SerializedProfileAdmissionExecutor,
    ) -> Result<DeviceCatalogDocument, RuntimeError> {
        self.ensure_not_closed()?;
        // Issued cleanup can outlive a dropped open future just like capture. Unlike capture,
        // this slot holds only nonsecret target evidence and can never authorize import.
        self.record_profile_source_cleanup(true);
        let result = cleanup::run(self, executor, catalog).await;
        let _closed = self.reconcile_profile_source_cleanup().await;
        // Failed cleanup-only Close remains owned for shutdown/next open without retiring the
        // committed Account. Catalog ambiguity still fences startup through `result`.
        self.ensure_not_closed()?;
        result
    }

    // Called only while holding catalog_transition, including during shutdown. A failed or lost
    // acknowledgement keeps the executor and cleanup duty available for the next attempt.
    async fn reconcile_profile_source_cleanup(&self) -> Result<(), RuntimeError> {
        let (executor, selector) = {
            let admission = self
                .profile_admission
                .lock()
                .expect("profile admission configuration lock poisoned");
            let Some(selector) = admission.cleanup_snapshot.as_ref() else {
                return Ok(());
            };
            let Some(ProfileAdmissionSource::Legacy { executor, .. }) = admission.source.as_ref()
            else {
                return Err(startup_invariant(
                    "Profile source cleanup lost its executor",
                ));
            };
            (Arc::clone(executor), selector.clone())
        };
        if !matches!(
            invoke_source(
                executor.as_ref(),
                ProfileAdmissionRequest::CloseSourceSnapshot { selector }
            )
            .await?,
            ProfileAdmissionResponse::SourceSnapshotClosed {}
        ) {
            return Err(startup_invariant(
                "Profile source did not close its snapshot",
            ));
        }
        let mut admission = self
            .profile_admission
            .lock()
            .expect("profile admission configuration lock poisoned");
        admission.cleanup_snapshot = None;
        admission.cleanup_only = false;
        Ok(())
    }

    pub(super) async fn close_profile_admission_source(&self) {
        let mut failures = 0_u32;
        while self.reconcile_profile_source_cleanup().await.is_err() {
            self.device_timer.sleep_ms(10_u64 << failures.min(7)).await;
            failures = failures.saturating_add(1);
        }
    }

    async fn require_empty_admission_replica(&self) -> Result<(), RuntimeError> {
        census::replica(self, &[]).await.map(|_| ())
    }

    async fn require_empty_admission_attachment_artifacts(&self) -> Result<(), RuntimeError> {
        use crate::{
            AttachmentArtifactInventoryContinuation, AttachmentArtifactStoreRequest,
            AttachmentArtifactStoreResponse,
        };

        let artifacts = self
            .attachment_move_lifecycle
            .lock()
            .expect("Attachment Move lifecycle lock poisoned")
            .as_ref()
            .map(|lifecycle| lifecycle.artifacts())
            .ok_or_else(|| {
                RuntimeError::new(
                    RuntimeErrorCode::StorageUnavailable,
                    "Profile admission requires Attachment artifact inventory",
                )
            })?;
        let response = artifacts
            .invoke(AttachmentArtifactStoreRequest::Inventory { cursor: None })
            .await?;
        self.ensure_not_closed()?;
        let AttachmentArtifactStoreResponse::InventoryPage(page) = response else {
            return Err(startup_invariant(
                "Profile Attachment artifacts did not return inventory",
            ));
        };
        page.validate()?;
        if !page.entries.is_empty() {
            return Err(startup_invariant(
                "Profile admission found unexplained destination Attachment artifacts",
            ));
        }
        match page.continuation {
            AttachmentArtifactInventoryContinuation::End {} => Ok(()),
            AttachmentArtifactInventoryContinuation::More { .. } => Err(startup_invariant(
                "Profile Attachment artifact inventory did not make progress",
            )),
        }
    }

    async fn require_empty_admission_vault_images(&self) -> Result<(), RuntimeError> {
        let images = self
            .vault_image_ingress
            .lock()
            .expect("Vault image ingress lock poisoned")
            .clone()
            .ok_or_else(|| {
                RuntimeError::new(
                    RuntimeErrorCode::StorageUnavailable,
                    "Profile admission requires Vault image artifact inventory",
                )
            })?;
        let page = images.inventory_page(None).await?;
        self.ensure_not_closed()?;
        page.validate()?;
        if !page.entries.is_empty() {
            return Err(startup_invariant(
                "Profile admission found unexplained destination Vault image artifacts",
            ));
        }
        match page.continuation {
            crate::VaultImageInventoryContinuation::End {} => Ok(()),
            crate::VaultImageInventoryContinuation::More { .. } => Err(startup_invariant(
                "Profile Vault image inventory did not make progress",
            )),
        }
    }
}

async fn invoke_source(
    executor: &dyn SerializedProfileAdmissionExecutor,
    request: ProfileAdmissionRequest,
) -> Result<ProfileAdmissionResponse, RuntimeError> {
    let (response, binary) = invoke_source_with_binary(executor, request).await?;
    // Snapshot lifecycle and proof steps carry control only. Even an empty binary makes a reply invalid;
    // in particular, it cannot acknowledge release of the retained source reader.
    if binary.is_some() {
        return Err(startup_invariant(
            "Profile source control response contains unexpected binary",
        ));
    }
    Ok(response)
}

async fn invoke_source_with_binary(
    executor: &dyn SerializedProfileAdmissionExecutor,
    request: ProfileAdmissionRequest,
) -> Result<(ProfileAdmissionResponse, Option<Zeroizing<Vec<u8>>>), RuntimeError> {
    request.validate()?;
    let request = Zeroizing::new(
        serde_json::to_string(&request)
            .map_err(|_| startup_invariant("Profile source request could not serialize"))?,
    );
    if request.len() > PROFILE_SOURCE_CONTROL_BYTES {
        return Err(startup_invariant(
            "Profile source request exceeds its control bound",
        ));
    }
    let (response, binary) = executor.invoke(request).await?;
    if response.len() > PROFILE_SOURCE_CONTROL_BYTES {
        return Err(startup_invariant(
            "Profile source response exceeds its control bound",
        ));
    }
    if binary
        .as_ref()
        .is_some_and(|bytes| bytes.len() > PROFILE_SOURCE_BINARY_BYTES)
    {
        return Err(startup_invariant(
            "Profile source response exceeds its binary bound",
        ));
    }
    let response = serde_json::from_str(&response)
        .map_err(|_| startup_invariant("Profile source response is malformed"))?;
    Ok((response, binary))
}

fn validate_source_snapshot(
    snapshot: &ProfileSourceSnapshot,
    format: LegacyProfileFormat,
) -> Result<(), RuntimeError> {
    if snapshot.format != format
        || [
            &snapshot.snapshot_handle,
            &snapshot.profile_identity,
            &snapshot.capture_id,
        ]
        .iter()
        .any(|identity| identity.is_empty() || identity.len() > PROFILE_SOURCE_IDENTITY_BYTES)
    {
        return Err(startup_invariant(
            "Profile source snapshot identity is invalid",
        ));
    }
    let families = match format {
        LegacyProfileFormat::DesktopLegacyV1 => {
            if snapshot.session_instance.is_some() {
                return Err(startup_invariant(
                    "Desktop profile source has a browser Session instance",
                ));
            }
            [
                ProfileSourceFamily::DesktopStore,
                ProfileSourceFamily::DesktopSyncStore,
                ProfileSourceFamily::DesktopCredentials,
            ]
        }
        LegacyProfileFormat::ExtensionLegacyV1 => {
            if !snapshot.session_instance.as_ref().is_some_and(|identity| {
                !identity.is_empty() && identity.len() <= PROFILE_SOURCE_IDENTITY_BYTES
            }) {
                return Err(startup_invariant(
                    "Extension profile source has no valid Session instance",
                ));
            }
            [
                ProfileSourceFamily::ExtensionLocal,
                ProfileSourceFamily::ExtensionSession,
                ProfileSourceFamily::ExtensionRecords,
            ]
        }
    };
    if snapshot.families.len() != families.len()
        || families.iter().any(|expected| {
            snapshot
                .families
                .iter()
                .filter(|found| found.family == *expected)
                .count()
                != 1
        })
    {
        return Err(startup_invariant(
            "Profile source snapshot has incomplete or unexpected families",
        ));
    }
    for inventory in &snapshot.families {
        let needs_file_identity = matches!(
            inventory.family,
            ProfileSourceFamily::DesktopStore | ProfileSourceFamily::DesktopSyncStore
        ) && inventory.presence == crate::ProfileSourcePresence::Present;
        if needs_file_identity != inventory.file_identity.is_some()
            || inventory.file_identity.as_ref().is_some_and(|identity| {
                identity.is_empty() || identity.len() > PROFILE_SOURCE_IDENTITY_BYTES
            })
        {
            return Err(startup_invariant("Profile source file identity is invalid"));
        }
    }
    Ok(())
}
