//! Wipe fixes an independent namespace scope before replacing unreadable admission evidence.
use super::{census, invoke_source};
use crate::{
    platform_storage::{
        profile_admission::{ProfileAdmissionRecord, ProfileResetScope, ResetPhase},
        DeviceCatalogDocument, PlatformStorageValue,
    },
    ProfileAdmissionRequest, ProfileAdmissionResponse, ProfileAdmissionSource,
    ProfileResetPreparedResult, ProfileResetResult, ProfileResetSnapshot,
    ProfileSnapshotCloseSelector, Runtime, RuntimeError, RuntimeErrorCode,
    SerializedProfileAdmissionExecutor,
};
use std::sync::Arc;

pub(in crate::runtime) struct PreparedProfileReset {
    catalog: DeviceCatalogDocument,
    executor: Option<Arc<dyn SerializedProfileAdmissionExecutor>>,
    snapshot: Option<ProfileResetSnapshot>,
}
fn invalid() -> RuntimeError {
    super::startup_invariant("Profile reset scope or journal is inconsistent")
}
fn unavailable() -> RuntimeError {
    RuntimeError::new(
        RuntimeErrorCode::StorageUnavailable,
        "Profile reset requires its matching source provider",
    )
}
async fn current(runtime: &Runtime, catalog: &DeviceCatalogDocument) -> Result<(), RuntimeError> {
    runtime.ensure_not_closed()?;
    if runtime
        .platform_storage
        .load_device_catalog()
        .await?
        .as_ref()
        != Some(catalog)
    {
        return Err(invalid());
    }
    runtime.ensure_not_closed()
}
async fn store(runtime: &Runtime, catalog: &DeviceCatalogDocument) -> Result<(), RuntimeError> {
    runtime.ensure_not_closed()?;
    let written = runtime.platform_storage.store_device_catalog(catalog).await;
    runtime.ensure_not_closed()?;
    if runtime
        .platform_storage
        .load_device_catalog()
        .await?
        .as_ref()
        == Some(catalog)
    {
        runtime.update_profile_admission_cleanup_status(Some(catalog));
        return Ok(());
    }
    Err(written.err().unwrap_or_else(invalid))
}
impl Runtime {
    /// Caller owns the Device retirement, catalog and Account execution fences.
    pub(in crate::runtime) async fn prepare_device_profile_reset(
        &self,
    ) -> Result<Option<PreparedProfileReset>, RuntimeError> {
        let result = self.prepare_device_profile_reset_inner().await;
        if result.is_err() {
            let _ = self.reconcile_profile_source_cleanup().await;
        }
        result
    }
    async fn prepare_device_profile_reset_inner(
        &self,
    ) -> Result<Option<PreparedProfileReset>, RuntimeError> {
        self.ensure_not_closed()?;
        let source = self.start_profile_admission_open();
        let old = self.platform_storage.load_device_catalog().await;
        let old_catalog = old.as_ref().ok().and_then(|catalog| catalog.as_ref());
        let record = old_catalog.and_then(DeviceCatalogDocument::admission_record);
        if matches!(source, ProfileAdmissionSource::CoreOnly) && old.is_ok() && record.is_none() {
            return Ok(None);
        }
        let resuming =
            record.is_some_and(|record| record.reset_phase() == Some(ResetPhase::Wiping));
        let wipe_id = if resuming {
            record
                .and_then(ProfileAdmissionRecord::wipe_id)
                .ok_or_else(invalid)?
                .to_owned()
        } else {
            bittery_crypto_core::generate_uuid()
        };
        let (scope, executor, snapshot) = match source {
            ProfileAdmissionSource::LegacyUnavailable { .. } => return Err(unavailable()),
            ProfileAdmissionSource::CoreOnly => {
                if record.is_some_and(|record| {
                    !matches!(
                        record.reset_scope(),
                        Some(ProfileResetScope::CoreOnly { .. })
                    )
                }) {
                    return Err(unavailable());
                }
                (
                    ProfileResetScope::CoreOnly {
                        namespace_version: 1,
                    },
                    None,
                    None,
                )
            }
            ProfileAdmissionSource::Legacy { format, executor } => {
                self.reconcile_profile_source_cleanup().await?;
                let expected = if resuming {
                    match record.and_then(ProfileAdmissionRecord::reset_scope) {
                        Some(ProfileResetScope::LegacyProfile { scope }) => Some(scope.clone()),
                        _ => return Err(invalid()),
                    }
                } else {
                    None
                };
                self.record_profile_source_cleanup(true);
                let response = invoke_source(
                    executor.as_ref(),
                    ProfileAdmissionRequest::PrepareLegacyProfileReset {
                        wipe_id: wipe_id.clone(),
                        format,
                        expected_scope: expected.clone(),
                    },
                )
                .await?;
                self.ensure_not_closed()?;
                let ProfileAdmissionResponse::ProfileResetPrepared {
                    result: ProfileResetPreparedResult::Prepared { snapshot },
                } = response
                else {
                    return Err(unavailable());
                };
                snapshot.validate()?;
                if snapshot.wipe_id != wipe_id
                    || snapshot.scope.format != format
                    || expected
                        .as_ref()
                        .is_some_and(|expected| expected != &snapshot.scope)
                {
                    return Err(invalid());
                }
                // A fresh explicit Wipe can fix new file objects, never another profile/namespace.
                if let Some(record) = record {
                    match record {
                        ProfileAdmissionRecord::Import { source, .. }
                            if source.format != format
                                || source.profile_identity != snapshot.scope.profile_identity =>
                        {
                            return Err(invalid());
                        }
                        ProfileAdmissionRecord::Reset {
                            scope: ProfileResetScope::LegacyProfile { scope },
                            ..
                        } if scope.format != format
                            || scope.profile_identity != snapshot.scope.profile_identity
                            || scope.families.iter().zip(&snapshot.scope.families).any(
                                |(old, new)| {
                                    old.family != new.family
                                        || old.namespace_identity != new.namespace_identity
                                        || old.selector_plan_version != new.selector_plan_version
                                },
                            ) =>
                        {
                            return Err(invalid());
                        }
                        _ => {}
                    }
                }
                self.profile_admission
                    .lock()
                    .expect("profile admission configuration lock poisoned")
                    .cleanup_snapshot = Some(ProfileSnapshotCloseSelector::Exact {
                    handle: snapshot.reset_handle.clone(),
                });
                (
                    ProfileResetScope::LegacyProfile {
                        scope: snapshot.scope.clone(),
                    },
                    Some(executor),
                    Some(snapshot),
                )
            }
        };
        let catalog = if resuming {
            let catalog = old_catalog.ok_or_else(invalid)?.clone();
            if catalog
                .admission_record()
                .and_then(ProfileAdmissionRecord::reset_scope)
                != Some(&scope)
            {
                return Err(invalid());
            }
            current(self, &catalog).await?;
            catalog
        } else {
            let record = ProfileAdmissionRecord::resetting(wipe_id, scope)?;
            let catalog =
                DeviceCatalogDocument::new(Vec::new())?.with_admission(record, Vec::new())?;
            store(self, &catalog).await?;
            catalog
        };
        Ok(Some(PreparedProfileReset {
            catalog,
            executor,
            snapshot,
        }))
    }

    pub(in crate::runtime) async fn reset_profile_sources(
        &self,
        prepared: &mut PreparedProfileReset,
    ) -> Result<(), RuntimeError> {
        let result = self.reset_profile_sources_inner(prepared).await;
        let closed = if prepared.executor.is_some() {
            self.reconcile_profile_source_cleanup().await
        } else {
            Ok(())
        };
        self.ensure_not_closed()?;
        result.and(closed)
    }
    async fn reset_profile_sources_inner(
        &self,
        prepared: &mut PreparedProfileReset,
    ) -> Result<(), RuntimeError> {
        let (Some(executor), Some(snapshot)) = (&prepared.executor, &prepared.snapshot) else {
            return current(self, &prepared.catalog).await;
        };
        let mut complete = true;
        for scope in &snapshot.scope.families {
            current(self, &prepared.catalog).await?;
            let response = invoke_source(
                executor.as_ref(),
                ProfileAdmissionRequest::ResetLegacySourceFamily {
                    reset_handle: snapshot.reset_handle.clone(),
                    wipe_id: snapshot.wipe_id.clone(),
                    family: scope.family,
                },
            )
            .await?;
            self.ensure_not_closed()?;
            let ProfileAdmissionResponse::ProfileResetFamilyResult {
                reset_handle,
                wipe_id,
                family,
                result,
            } = response
            else {
                return Err(invalid());
            };
            if reset_handle != snapshot.reset_handle
                || wipe_id != snapshot.wipe_id
                || family != scope.family
            {
                return Err(invalid());
            }
            let absent = matches!(
                result,
                ProfileResetResult::Reset {} | ProfileResetResult::AlreadyAbsent {}
            );
            complete &= absent;
            current(self, &prepared.catalog).await?;
            let mut record = prepared
                .catalog
                .admission_record()
                .ok_or_else(invalid)?
                .clone();
            if record.record_reset_family(family, absent)? {
                let next = prepared.catalog.with_admission(record, Vec::new())?;
                store(self, &next).await?;
                prepared.catalog = next;
            }
        }
        if complete {
            Ok(())
        } else {
            Err(unavailable())
        }
    }

    pub(in crate::runtime) async fn validate_profile_reset_journal(
        &self,
        prepared: &PreparedProfileReset,
    ) -> Result<(), RuntimeError> {
        current(self, &prepared.catalog).await
    }

    pub(in crate::runtime) async fn finish_profile_reset(
        &self,
        prepared: &mut PreparedProfileReset,
    ) -> Result<(), RuntimeError> {
        current(self, &prepared.catalog).await?;
        census::platform(self, &[PlatformStorageValue::DeviceCatalog]).await?;
        self.require_empty_admission_replica().await?;
        self.require_empty_admission_attachment_artifacts().await?;
        self.require_empty_admission_vault_images().await?;
        current(self, &prepared.catalog).await?;
        let mut record = prepared
            .catalog
            .admission_record()
            .ok_or_else(invalid)?
            .clone();
        record.complete_reset()?;
        let complete = prepared.catalog.with_admission(record, Vec::new())?;
        store(self, &complete).await?;
        prepared.catalog = complete;
        Ok(())
    }
}
