//! Explicit catalog-only inspection and private precommit staging retirement.
use crate::platform_storage::profile_admission::ProfileAdmissionRecord;
use crate::{ProfileAdmissionInspectionState, Runtime, RuntimeError, RuntimeResponse};

impl Runtime {
    pub(in crate::runtime) async fn inspect_profile_admission(
        &self,
    ) -> Result<RuntimeResponse, RuntimeError> {
        let _catalog = self.catalog_transition.lock().await;
        self.ensure_not_closed()?;
        let catalog = self.platform_storage.load_device_catalog().await?;
        self.ensure_not_closed()?;
        let state = match catalog
            .as_ref()
            .and_then(|catalog| catalog.admission_record())
        {
            None => ProfileAdmissionInspectionState::NotStarted {},
            Some(ProfileAdmissionRecord::Import {
                admission_id,
                phase,
                ..
            }) => ProfileAdmissionInspectionState::Import {
                admission_id: admission_id.clone(),
                phase: *phase,
            },
            Some(ProfileAdmissionRecord::Reset { wipe_id, phase, .. }) => {
                ProfileAdmissionInspectionState::Reset {
                    wipe_id: wipe_id.clone(),
                    phase: *phase,
                }
            }
        };
        Ok(RuntimeResponse::ProfileAdmissionInspection { state })
    }
}

use super::{census, install};
use crate::platform_storage::{
    profile_admission::{
        AbortAccountField, AbortCleanupTarget, AdmissionProgress, ImportPhase, OriginalDocument,
    },
    DeviceCatalogDocument, PlatformStorageValue,
};
use crate::{PlatformStorageDeleteResult, RequestCancellation, RuntimeErrorCode};
use std::sync::atomic::Ordering;

fn invalid(message: &'static str) -> RuntimeError {
    super::startup_invariant(message)
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
        return Err(invalid("Abort catalog changed or disappeared"));
    }
    runtime.ensure_not_closed()
}
async fn store(runtime: &Runtime, expected: &DeviceCatalogDocument) -> Result<(), RuntimeError> {
    runtime.ensure_not_closed()?;
    let issued = runtime
        .platform_storage
        .store_device_catalog(expected)
        .await;
    runtime.ensure_not_closed()?;
    if runtime
        .platform_storage
        .load_device_catalog()
        .await?
        .as_ref()
        != Some(expected)
    {
        return Err(issued
            .err()
            .unwrap_or_else(|| invalid("Abort catalog write was not established")));
    }
    runtime.ensure_not_closed()
}
fn progress(catalog: &DeviceCatalogDocument) -> Result<&AdmissionProgress, RuntimeError> {
    catalog
        .admission_record()
        .and_then(ProfileAdmissionRecord::progress)
        .ok_or_else(|| invalid("Abort fixed progress is missing"))
}
struct DocumentPlan {
    target: PlatformStorageValue,
    digest: String,
    owned: bool,
}
fn documents(progress: &AdmissionProgress) -> Vec<DocumentPlan> {
    let mut docs = vec![DocumentPlan {
        target: PlatformStorageValue::LocalSecurity,
        digest: progress.device.global_security_sha256.clone(),
        owned: matches!(
            progress.device.original_global_security,
            OriginalDocument::Absent {}
        ),
    }];
    if let Some(digest) = &progress.device.device_key_sha256 {
        docs.push(DocumentPlan {
            target: PlatformStorageValue::DeviceKey,
            digest: digest.clone(),
            owned: matches!(progress.device.original_key, OriginalDocument::Absent {}),
        });
    }
    for account in &progress.accounts {
        let id = &account.account_id;
        let generation = &account.incarnation;
        for (target, digest) in [
            (
                PlatformStorageValue::AccountMetadata(id.clone(), generation.clone()),
                &account.expected.metadata_sha256,
            ),
            (
                PlatformStorageValue::AccountQuickUnlock(id.clone(), generation.clone()),
                &account.expected.quick_unlock_sha256,
            ),
            (
                PlatformStorageValue::AccountLocalSecurity(id.clone()),
                &account.expected.account_security_sha256,
            ),
        ] {
            docs.push(DocumentPlan {
                target,
                digest: digest.clone(),
                owned: true,
            });
        }
        if let Some(digest) = &account.expected.current_session_sha256 {
            docs.push(DocumentPlan {
                target: PlatformStorageValue::CurrentSessionCredentials(
                    id.clone(),
                    generation.clone(),
                ),
                digest: digest.clone(),
                owned: true,
            });
        }
        if let Some(digest) = &account.expected.legacy_session_evidence_sha256 {
            docs.push(DocumentPlan {
                target: PlatformStorageValue::LegacySessionEvidence(id.clone(), generation.clone()),
                digest: digest.clone(),
                owned: true,
            });
        }
    }
    docs
}
fn document_target(
    progress: &AdmissionProgress,
    target: &AbortCleanupTarget,
) -> Result<Option<PlatformStorageValue>, RuntimeError> {
    Ok(Some(match target {
        AbortCleanupTarget::DeviceKey {} => PlatformStorageValue::DeviceKey,
        AbortCleanupTarget::LocalSecurity {} => PlatformStorageValue::LocalSecurity,
        AbortCleanupTarget::Account { index, field } => {
            let account = progress
                .accounts
                .get(
                    usize::try_from(*index)
                        .map_err(|_| invalid("Abort Account index overflows"))?,
                )
                .ok_or_else(|| invalid("Abort Account index is outside mapping"))?;
            let id = account.account_id.clone();
            let generation = account.incarnation.clone();
            match field {
                AbortAccountField::Metadata => {
                    PlatformStorageValue::AccountMetadata(id, generation)
                }
                AbortAccountField::QuickUnlock => {
                    PlatformStorageValue::AccountQuickUnlock(id, generation)
                }
                AbortAccountField::LocalSecurity => PlatformStorageValue::AccountLocalSecurity(id),
                AbortAccountField::CurrentSession => {
                    PlatformStorageValue::CurrentSessionCredentials(id, generation)
                }
                AbortAccountField::LegacySessionEvidence => {
                    PlatformStorageValue::LegacySessionEvidence(id, generation)
                }
                AbortAccountField::Replica => return Ok(None),
            }
        }
    }))
}
fn expected_document_digest<'a>(
    progress: &'a AdmissionProgress,
    target: &AbortCleanupTarget,
) -> Result<&'a str, RuntimeError> {
    let value = match target {
        AbortCleanupTarget::DeviceKey {} => progress.device.device_key_sha256.as_deref(),
        AbortCleanupTarget::LocalSecurity {} => {
            Some(progress.device.global_security_sha256.as_str())
        }
        AbortCleanupTarget::Account { index, field } => {
            let account = progress
                .accounts
                .get(
                    usize::try_from(*index)
                        .map_err(|_| invalid("Abort Account index overflows"))?,
                )
                .ok_or_else(|| invalid("Abort Account index is outside mapping"))?;
            match field {
                AbortAccountField::Metadata => Some(account.expected.metadata_sha256.as_str()),
                AbortAccountField::QuickUnlock => {
                    Some(account.expected.quick_unlock_sha256.as_str())
                }
                AbortAccountField::LocalSecurity => {
                    Some(account.expected.account_security_sha256.as_str())
                }
                AbortAccountField::CurrentSession => {
                    account.expected.current_session_sha256.as_deref()
                }
                AbortAccountField::LegacySessionEvidence => {
                    account.expected.legacy_session_evidence_sha256.as_deref()
                }
                AbortAccountField::Replica => None,
            }
        }
    };
    value.ok_or_else(|| invalid("Abort document is outside its fixed expectations"))
}
async fn preflight(
    runtime: &Runtime,
    catalog: &DeviceCatalogDocument,
    require_absent: bool,
) -> Result<(), RuntimeError> {
    current(runtime, catalog).await?;
    let progress = progress(catalog)?;
    let docs = documents(progress);
    let mut values: Vec<_> = docs
        .iter()
        .map(|document| document.target.clone())
        .collect();
    values.push(PlatformStorageValue::DeviceCatalog);
    census::platform(runtime, &values).await?;
    for document in docs {
        let evidence = runtime
            .platform_storage
            .profile_admission_document_evidence(&document.target)
            .await?;
        match evidence {
            Some(evidence)
                if install::document_bytes_digest(
                    runtime,
                    &document.target,
                    &evidence.canonical,
                )? == document.digest
                    && (!require_absent || !document.owned) => {}
            None if document.owned => {}
            _ => {
                return Err(invalid(
                    "Abort found changed or missing destination evidence",
                ))
            }
        }
    }
    let mut snapshots = Vec::new();
    for account in &progress.accounts {
        if let Some(snapshot) = runtime.replica.load_uncached(&account.account_id).await? {
            if require_absent
                || install::replica_digest(&snapshot)?
                    != (
                        account.expected.row_count,
                        account.expected.rows_sha256.clone(),
                    )
            {
                return Err(invalid("Abort found changed Replica evidence"));
            }
            snapshots.push(snapshot);
        }
    }
    census::replica(runtime, &snapshots).await?;
    runtime
        .require_empty_admission_attachment_artifacts()
        .await?;
    runtime.require_empty_admission_vault_images().await?;
    current(runtime, catalog).await
}

impl Runtime {
    pub(super) async fn verify_aborted_profile_destination(
        &self,
        catalog: &DeviceCatalogDocument,
    ) -> Result<(), RuntimeError> {
        preflight(self, catalog, true).await
    }
    pub(in crate::runtime) async fn abort_profile_admission(
        &self,
        admission_id: &str,
        cancellation: &RequestCancellation,
    ) -> Result<RuntimeResponse, RuntimeError> {
        crate::platform_storage::profile_admission::identity(admission_id)?;
        let _retirement = self.teardown_admission.write().await;
        let _catalog_guard = self.catalog_transition.lock().await;
        self.ensure_not_closed()?;
        if self.ready.load(Ordering::SeqCst) {
            return Err(invalid("An opened Runtime cannot abort profile admission"));
        }
        let mut catalog = self
            .platform_storage
            .load_device_catalog()
            .await?
            .ok_or_else(|| invalid("No admission can be aborted"))?;
        let record = catalog
            .admission_record()
            .ok_or_else(|| invalid("No admission can be aborted"))?;
        if record.admission_id() != Some(admission_id)
            || !matches!(
                record.phase(),
                Some(ImportPhase::Preparing | ImportPhase::Aborting | ImportPhase::Aborted)
            )
        {
            return Err(invalid("Abort does not match an unfinished admission"));
        }
        if record.phase() == Some(ImportPhase::Aborted) {
            preflight(self, &catalog, true).await?;
            return Ok(RuntimeResponse::ProfileAdmissionAborted {
                admission_id: admission_id.to_owned(),
            });
        }
        preflight(self, &catalog, false).await?;
        if record.phase() == Some(ImportPhase::Preparing) {
            if cancellation.is_cancelled() {
                return Err(RuntimeError::new(
                    RuntimeErrorCode::Cancelled,
                    "Admission Abort was cancelled before intent",
                ));
            }
            let mut record = record.clone();
            record.begin_abort()?;
            let next = catalog.with_admission(record, catalog.accounts.clone())?;
            current(self, &catalog).await?;
            store(self, &next).await?;
            catalog = next;
        }
        let targets = progress(&catalog)?.abort_targets();
        for target in targets {
            current(self, &catalog).await?;
            let fixed = progress(&catalog)?;
            let still_pending = fixed
                .abort_remaining
                .as_ref()
                .is_some_and(|remaining| remaining.contains(&target));
            if let Some(value) = document_target(fixed, &target)? {
                if let Some(evidence) = self
                    .platform_storage
                    .profile_admission_document_evidence(&value)
                    .await?
                {
                    if !still_pending {
                        return Err(invalid("Completed Abort destination reappeared"));
                    }
                    if install::document_bytes_digest(self, &value, &evidence.canonical)?
                        != expected_document_digest(fixed, &target)?
                    {
                        return Err(invalid("Abort destination changed before deletion"));
                    }
                    current(self, &catalog).await?;
                    let issued = self
                        .platform_storage
                        .delete_profile_admission_document(&value, evidence.raw)
                        .await;
                    if matches!(issued, Ok(PlatformStorageDeleteResult::Conflict)) {
                        return Err(invalid("Abort destination changed during deletion"));
                    }
                    if self
                        .platform_storage
                        .profile_admission_document_evidence(&value)
                        .await?
                        .is_some()
                    {
                        return Err(issued.err().unwrap_or_else(|| {
                            invalid("Abort destination deletion was not established")
                        }));
                    }
                }
            } else if let AbortCleanupTarget::Account { index, .. } = &target {
                let account = &fixed.accounts[*index as usize];
                if let Some(snapshot) = self.replica.load_uncached(&account.account_id).await? {
                    if !still_pending
                        || install::replica_digest(&snapshot)?
                            != (
                                account.expected.row_count,
                                account.expected.rows_sha256.clone(),
                            )
                    {
                        return Err(invalid("Abort Replica changed before deletion"));
                    }
                    current(self, &catalog).await?;
                    self.replica
                        .delete_profile_admission_snapshot(&snapshot)
                        .await?;
                }
            }
            current(self, &catalog).await?;
            let mut record = catalog
                .admission_record()
                .expect("validated Abort catalog")
                .clone();
            if record.record_abort_absent(&target)? {
                let next = catalog.with_admission(record, catalog.accounts.clone())?;
                store(self, &next).await?;
                catalog = next;
            }
        }
        preflight(self, &catalog, true).await?;
        let mut record = catalog
            .admission_record()
            .expect("validated Abort catalog")
            .clone();
        record.complete_abort()?;
        let next = catalog.with_admission(record, Vec::new())?;
        current(self, &catalog).await?;
        store(self, &next).await?;
        Ok(RuntimeResponse::ProfileAdmissionAborted {
            admission_id: admission_id.to_owned(),
        })
    }
}
