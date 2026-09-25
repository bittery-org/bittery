//! Committed source disposal never supplies values or authority to the new owner.
use super::invoke_source;
use crate::{
    platform_storage::{
        profile_admission::{CleanupDisposition, ImportPhase},
        DeviceCatalogDocument,
    },
    ProfileAdmissionRequest, ProfileAdmissionResponse, ProfileSnapshotCloseSelector,
    ProfileSourceCleanupReopenResult as Reopened, ProfileSourceCleanupReopenStep as Step,
    ProfileSourceCleanupSnapshot, ProfileSourceDeleteResult, Runtime, RuntimeError,
    SerializedProfileAdmissionExecutor, PROFILE_SOURCE_CURSOR_BYTES,
};

fn invalid() -> RuntimeError {
    super::startup_invariant("Committed source cleanup evidence is inconsistent")
}

async fn current(runtime: &Runtime, expected: &DeviceCatalogDocument) -> Result<(), RuntimeError> {
    runtime.ensure_not_closed()?;
    if runtime
        .platform_storage
        .load_device_catalog()
        .await?
        .as_ref()
        != Some(expected)
    {
        return Err(invalid());
    }
    runtime.ensure_not_closed()
}

async fn store(runtime: &Runtime, expected: &DeviceCatalogDocument) -> Result<(), RuntimeError> {
    runtime.ensure_not_closed()?;
    let written = runtime
        .platform_storage
        .store_device_catalog(expected)
        .await;
    runtime.ensure_not_closed()?;
    if runtime
        .platform_storage
        .load_device_catalog()
        .await?
        .as_ref()
        == Some(expected)
    {
        runtime.update_profile_admission_cleanup_status(Some(expected));
        return Ok(());
    }
    Err(written.err().unwrap_or_else(invalid))
}

async fn invoke_reopen(
    runtime: &Runtime,
    executor: &dyn SerializedProfileAdmissionExecutor,
    step: Step,
) -> Result<Reopened, RuntimeError> {
    runtime.ensure_not_closed()?;
    let response = invoke_source(
        executor,
        ProfileAdmissionRequest::ReopenSourceForCleanup { step },
    )
    .await?;
    runtime.ensure_not_closed()?;
    match response {
        ProfileAdmissionResponse::SourceCleanupReopen { result } => Ok(result),
        _ => Err(invalid()),
    }
}
fn cursor(cursor: String) -> Result<String, RuntimeError> {
    if cursor.is_empty() || cursor.len() > PROFILE_SOURCE_CURSOR_BYTES {
        Err(invalid())
    } else {
        Ok(cursor)
    }
}
async fn reopen(
    runtime: &Runtime,
    executor: &dyn SerializedProfileAdmissionExecutor,
    catalog: &DeviceCatalogDocument,
) -> Result<ProfileSourceCleanupSnapshot, RuntimeError> {
    let record = catalog.admission_record().ok_or_else(invalid)?;
    let manifest = &record.progress().ok_or_else(invalid)?.manifest;
    let Reopened::Started {
        verification_cursor,
        next_index: 0,
    } = invoke_reopen(
        runtime,
        executor,
        Step::Start {
            verification_attempt_id: bittery_crypto_core::generate_uuid(),
            admission_id: record.admission_id().ok_or_else(invalid)?.to_owned(),
            header: manifest.header.clone(),
        },
    )
    .await?
    else {
        return Err(invalid());
    };
    let mut verification_cursor = cursor(verification_cursor)?;
    for (index, expected_entry) in manifest.entries.iter().enumerate() {
        let index = u64::try_from(index).map_err(|_| invalid())?;
        let Reopened::Accepted {
            verification_cursor: next,
            next_index,
        } = invoke_reopen(
            runtime,
            executor,
            Step::Entry {
                verification_cursor,
                index,
                expected_entry: expected_entry.clone(),
            },
        )
        .await?
        else {
            return Err(invalid());
        };
        if index.checked_add(1) != Some(next_index) {
            return Err(invalid());
        }
        verification_cursor = cursor(next)?;
    }
    let Reopened::Reopened { snapshot } = invoke_reopen(
        runtime,
        executor,
        Step::Finish {
            verification_cursor,
        },
    )
    .await?
    else {
        return Err(invalid());
    };
    snapshot.validate()?;
    if Some(snapshot.admission_id.as_str()) != record.admission_id()
        || snapshot.format != manifest.header.format
        || snapshot.profile_identity != manifest.header.profile_identity
        || snapshot.capture_id == manifest.header.recorded_capture_id
    {
        return Err(invalid());
    }
    runtime
        .profile_admission
        .lock()
        .expect("profile admission configuration lock poisoned")
        .cleanup_snapshot = Some(ProfileSnapshotCloseSelector::Exact {
        handle: snapshot.snapshot_handle.clone(),
    });
    Ok(snapshot)
}

/// Called under catalog_transition. Parent records CurrentCapability before calling and always drains
/// Close afterwards. Source errors preserve the last confirmed catalog; catalog errors fence open.
pub(super) async fn run(
    runtime: &Runtime,
    executor: &dyn SerializedProfileAdmissionExecutor,
    mut catalog: DeviceCatalogDocument,
) -> Result<DeviceCatalogDocument, RuntimeError> {
    let record = catalog.admission_record().ok_or_else(invalid)?;
    if record.phase() != Some(ImportPhase::Committed) {
        return Err(invalid());
    }
    current(runtime, &catalog).await?;
    let snapshot = match reopen(runtime, executor, &catalog).await {
        Ok(snapshot) => snapshot,
        Err(_) => {
            runtime.ensure_not_closed()?;
            return Ok(catalog);
        }
    };
    let targets: Vec<_> = {
        let progress = catalog
            .admission_record()
            .and_then(|record| record.progress())
            .ok_or_else(invalid)?;
        progress
            .source_cleanup
            .iter()
            .map(|target| {
                let index = usize::try_from(target.manifest_entry_index).map_err(|_| invalid())?;
                Ok((
                    target.manifest_entry_index,
                    progress
                        .manifest
                        .entries
                        .get(index)
                        .ok_or_else(invalid)?
                        .clone(),
                ))
            })
            .collect::<Result<_, RuntimeError>>()?
    };
    let mut all_absent = true;
    for (index, expected_entry) in targets {
        current(runtime, &catalog).await?;
        let response = invoke_source(
            executor,
            ProfileAdmissionRequest::DeleteCapturedSource {
                snapshot_handle: snapshot.snapshot_handle.clone(),
                admission_id: snapshot.admission_id.clone(),
                index,
                expected_entry,
            },
        )
        .await;
        runtime.ensure_not_closed()?;
        let Ok(ProfileAdmissionResponse::SourceCleanupResult {
            snapshot_handle,
            admission_id,
            index: observed_index,
            result,
        }) = response
        else {
            return Ok(catalog);
        };
        if snapshot_handle != snapshot.snapshot_handle
            || admission_id != snapshot.admission_id
            || observed_index != index
        {
            return Ok(catalog);
        }
        let disposition = match result {
            ProfileSourceDeleteResult::Deleted {} | ProfileSourceDeleteResult::AlreadyAbsent {} => {
                CleanupDisposition::Absent
            }
            ProfileSourceDeleteResult::Changed {} | ProfileSourceDeleteResult::Unavailable {} => {
                all_absent = false;
                CleanupDisposition::Pending
            }
        };
        // Never overwrite catalog changes that happened while native work was in flight.
        current(runtime, &catalog).await?;
        let mut record = catalog.admission_record().ok_or_else(invalid)?.clone();
        if record.record_cleanup(index, disposition)? {
            let next = catalog
                .clone()
                .with_admission(record, catalog.accounts.clone())?;
            store(runtime, &next).await?;
            catalog = next;
        }
    }
    if all_absent {
        current(runtime, &catalog).await?;
        let mut record = catalog.admission_record().ok_or_else(invalid)?.clone();
        record.complete_cleanup(bittery_crypto_core::generate_uuid())?;
        let complete = catalog
            .clone()
            .with_admission(record, catalog.accounts.clone())?;
        store(runtime, &complete).await?;
        catalog = complete;
    }
    Ok(catalog)
}
