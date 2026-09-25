//! The first locked no-work import uses the existing documents and guarded Replica owner.
use super::{
    desktop::{BoundCommand, BoundDesktopAccount, CommandScope, DecodedDesktop},
    Runtime,
};
use crate::{
    platform_storage::{
        profile_admission::*, AccountLocalSecurityDocument, DeviceCatalogAccount,
        DeviceCatalogDocument, DeviceKeyDocument, LocalSecurityDocument,
        PendingAccountInstallIntent, PlatformStorageValue,
    },
    replica::{
        persistence_contract::{prepare_install, reconstruct_snapshot, snapshot_rows, ReplicaHead},
        BootstrapAuthority, ReplicaSnapshot,
    },
    RuntimeError, RuntimeErrorCode,
};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, HashSet},
    future::Future,
};
use zeroize::Zeroizing;

fn invalid(message: &'static str) -> RuntimeError {
    RuntimeError::new(RuntimeErrorCode::InvariantViolation, message)
}

struct AccountDocuments {
    bound: BoundDesktopAccount,
    security: AccountLocalSecurityDocument,
    snapshot: ReplicaSnapshot,
}

pub(super) struct PreparedAdmission {
    pub(super) catalog: DeviceCatalogDocument,
    original_catalog: Option<DeviceCatalogDocument>,
    accounts: Vec<AccountDocuments>,
    device_key: Option<DeviceKeyDocument>,
    global_security: LocalSecurityDocument,
}

impl PreparedAdmission {
    pub(super) fn allowed_platform_values(&self) -> Vec<PlatformStorageValue> {
        let mut values = vec![
            PlatformStorageValue::DeviceCatalog,
            PlatformStorageValue::LocalSecurity,
        ];
        if self.device_key.is_some() {
            values.push(PlatformStorageValue::DeviceKey);
        }
        for account in &self.accounts {
            let id = &account.bound.metadata.account_id;
            let generation = &account.bound.metadata.incarnation;
            values.extend([
                PlatformStorageValue::AccountMetadata(id.clone(), generation.clone()),
                PlatformStorageValue::AccountQuickUnlock(id.clone(), generation.clone()),
                PlatformStorageValue::AccountLocalSecurity(id.clone()),
            ]);
            if account.bound.current_session.is_some() {
                values.push(PlatformStorageValue::CurrentSessionCredentials(
                    id.clone(),
                    generation.clone(),
                ));
            }
            if account.bound.legacy_session_evidence.is_some() {
                values.push(PlatformStorageValue::LegacySessionEvidence(
                    id.clone(),
                    generation.clone(),
                ));
            }
        }
        values
    }
    pub(super) fn expected_snapshots(&self) -> Vec<ReplicaSnapshot> {
        self.accounts
            .iter()
            .map(|account| account.snapshot.clone())
            .collect()
    }
}

fn frame(state: &mut Sha256, bytes: &[u8]) -> Result<(), RuntimeError> {
    let length =
        u64::try_from(bytes.len()).map_err(|_| invalid("Admission evidence length overflows"))?;
    state.update(length.to_be_bytes());
    state.update(bytes);
    Ok(())
}

fn json_bytes(value: &impl Serialize) -> Result<Zeroizing<Vec<u8>>, RuntimeError> {
    serde_json::to_vec(value)
        .map(Zeroizing::new)
        .map_err(|_| invalid("Admission destination evidence cannot serialize"))
}

pub(super) fn document_digest(
    runtime: &Runtime,
    target: &PlatformStorageValue,
    document: &impl Serialize,
) -> Result<String, RuntimeError> {
    document_bytes_digest(runtime, target, &json_bytes(document)?)
}

pub(super) fn document_bytes_digest(
    runtime: &Runtime,
    target: &PlatformStorageValue,
    document: &[u8],
) -> Result<String, RuntimeError> {
    let mut state = Sha256::new();
    state.update(b"bittery.profile-admission.destination-document.v1\0");
    frame(
        &mut state,
        &json_bytes(&runtime.platform_storage.physical_location(target)?)?,
    )?;
    frame(&mut state, document)?;
    Ok(format!("{:x}", state.finalize()))
}

pub(super) fn replica_digest(snapshot: &ReplicaSnapshot) -> Result<(u64, String), RuntimeError> {
    let head = ReplicaHead {
        account_id: snapshot.account_id.clone(),
        user_id: snapshot.user_id.clone(),
        incarnation: snapshot.incarnation.clone(),
        replica_revision: snapshot.revision,
        lock_epoch: snapshot.lock_epoch,
        failure: snapshot.failure,
    };
    let mut rows = snapshot_rows(snapshot.clone())?;
    rows.sort_by(|a, b| {
        (
            a.key.account_id.as_str().as_bytes(),
            a.store.physical_id(),
            a.key.record_id.as_bytes(),
        )
            .cmp(&(
                b.key.account_id.as_str().as_bytes(),
                b.store.physical_id(),
                b.key.record_id.as_bytes(),
            ))
    });
    let count =
        u64::try_from(rows.len()).map_err(|_| invalid("Admission Replica row count overflows"))?;
    let mut state = Sha256::new();
    state.update(b"bittery.profile-admission.replica.v1\0");
    frame(&mut state, &json_bytes(&head)?)?;
    state.update(count.to_be_bytes());
    for row in rows {
        frame(&mut state, &json_bytes(&row)?)?;
    }
    Ok((count, format!("{:x}", state.finalize())))
}

fn expectations(
    runtime: &Runtime,
    account: &AccountDocuments,
) -> Result<AccountExpectations, RuntimeError> {
    let id = &account.bound.metadata.account_id;
    let generation = &account.bound.metadata.incarnation;
    let (row_count, rows_sha256) = replica_digest(&account.snapshot)?;
    Ok(AccountExpectations {
        metadata_sha256: document_digest(
            runtime,
            &PlatformStorageValue::AccountMetadata(id.clone(), generation.clone()),
            &account.bound.metadata,
        )?,
        quick_unlock_sha256: document_digest(
            runtime,
            &PlatformStorageValue::AccountQuickUnlock(id.clone(), generation.clone()),
            &account.bound.quick_unlock,
        )?,
        current_session_sha256: account
            .bound
            .current_session
            .as_ref()
            .map(|value| {
                document_digest(
                    runtime,
                    &PlatformStorageValue::CurrentSessionCredentials(
                        id.clone(),
                        generation.clone(),
                    ),
                    value,
                )
            })
            .transpose()?,
        legacy_session_evidence_sha256: account
            .bound
            .legacy_session_evidence
            .as_ref()
            .map(|value| {
                document_digest(
                    runtime,
                    &PlatformStorageValue::LegacySessionEvidence(id.clone(), generation.clone()),
                    value,
                )
            })
            .transpose()?,
        account_security_sha256: document_digest(
            runtime,
            &PlatformStorageValue::AccountLocalSecurity(id.clone()),
            &account.security,
        )?,
        replica_revision: account.snapshot.revision,
        row_count,
        rows_sha256,
    })
}

fn original<T: Serialize>(
    runtime: &Runtime,
    target: &PlatformStorageValue,
    actual: Option<T>,
    expected: Option<&T>,
) -> Result<OriginalDocument, RuntimeError> {
    match (actual, expected) {
        (None, _) => Ok(OriginalDocument::Absent {}),
        (Some(actual), Some(expected)) => {
            let sha256 = document_digest(runtime, target, &actual)?;
            if sha256 != document_digest(runtime, target, expected)? {
                return Err(invalid(
                    "Admission found a different original Device document",
                ));
            }
            Ok(OriginalDocument::Matching { sha256 })
        }
        _ => Err(invalid(
            "Admission found an unexplained original Device document",
        )),
    }
}

fn bind_commands(
    accounts: &mut [AccountDocuments],
    admission_id: &str,
) -> Result<(), RuntimeError> {
    let queues = accounts
        .iter_mut()
        .map(|account| std::mem::take(&mut account.bound.legacy_commands))
        .collect::<Vec<_>>();
    let results = {
        let scopes = accounts
            .iter()
            .map(|account| {
                (
                    account.bound.metadata.account_id.as_str().to_owned(),
                    CommandScope {
                        metadata: &account.bound.metadata,
                        authority: account.snapshot.bootstrap.snapshot(),
                    },
                )
            })
            .collect::<BTreeMap<_, _>>();
        let mut results = Vec::new();
        let mut local_ids = HashSet::new();
        let mut wire_ids = HashSet::new();
        for (source_index, queue) in queues.into_iter().enumerate() {
            let source_id = accounts[source_index].bound.metadata.account_id.as_str();
            let source = &scopes[source_id];
            let failures = &accounts[source_index].bound.captured_create_failures;
            let mut bound_failures = HashSet::new();
            for (queue_index, command) in queue.into_iter().enumerate() {
                let queue_index = u64::try_from(queue_index)
                    .map_err(|_| invalid("Legacy command queue index overflowed"))?;
                let mut bound = command.bind_scoped(admission_id, queue_index, source, &scopes)?;
                if let BoundCommand::Operation { operation, overlay } = &mut bound {
                    if let Some(failure) = failures
                        .iter()
                        .find(|failure| failure.operation_id() == operation.operation_id)
                    {
                        if !bound_failures.insert(failure.operation_id()) {
                            return Err(invalid("Captured failed Create identity is duplicated"));
                        }
                        *overlay = Some(failure.bind(operation)?);
                    }
                }
                let mut reserve_local = |id: &str| -> Result<(), RuntimeError> {
                    if !local_ids.insert((source_id.to_owned(), id.to_owned())) {
                        return Err(invalid(
                            "Legacy work identities conflict inside the source Replica",
                        ));
                    }
                    Ok(())
                };
                let mut reserve_wire =
                    |server: &str, user: &str, id: &str| -> Result<(), RuntimeError> {
                        if !wire_ids.insert((server.to_owned(), user.to_owned(), id.to_owned())) {
                            return Err(invalid(
                                "Legacy work reuses a Server User Operation identity",
                            ));
                        }
                        Ok(())
                    };
                match &bound {
                    BoundCommand::Operation { operation, .. } => {
                        reserve_local(&operation.operation_id)?;
                        reserve_wire(
                            &source.metadata.normalized_server_url,
                            &source.metadata.user_id,
                            &operation.operation_id,
                        )?;
                    }
                    BoundCommand::Workflow { record, .. } => {
                        reserve_local(record.operation_id())?;
                        for (index, id) in record
                            .reserved_child_operation_ids()
                            .into_iter()
                            .enumerate()
                        {
                            reserve_local(&id)?;
                            let endpoint = if index == 0 {
                                record.destination_identity()
                            } else {
                                record.source_identity()
                            };
                            reserve_wire(&endpoint.server_url, &endpoint.user_id, &id)?;
                        }
                    }
                }
                results.push((source_index, bound));
            }
            if bound_failures.len() != failures.len() {
                return Err(invalid(
                    "Captured failed Item has no matching failed Create",
                ));
            }
        }
        results
    };
    for (index, bound) in results {
        let snapshot = &mut accounts[index].snapshot;
        match bound {
            BoundCommand::Operation { operation, overlay } => {
                if let Some(overlay) = overlay {
                    if !operation.is_legacy_held() {
                        snapshot
                            .items
                            .retain(|previous| previous.item_id != overlay.item_id);
                        snapshot.items.push(overlay);
                    } else if !snapshot
                        .items
                        .iter()
                        .any(|previous| previous.item_id == overlay.item_id)
                    {
                        snapshot.items.push(overlay);
                    }
                }
                snapshot.operations.push(*operation);
            }
            BoundCommand::Workflow { record, overlay } => {
                snapshot.cross_account_moves.push(*record);
                if let Some(overlay) = overlay {
                    snapshot.items.push(overlay);
                }
            }
        }
    }
    for account in accounts {
        account.bound.captured_create_failures.clear();
        // Canonical reread order is independent of the original queue indices in lineage.
        account
            .snapshot
            .operations
            .sort_by(|left, right| left.operation_id.cmp(&right.operation_id));
        account
            .snapshot
            .cross_account_moves
            .sort_by(|left, right| left.operation_id().cmp(right.operation_id()));
        account
            .snapshot
            .items
            .sort_by(|left, right| left.item_id.cmp(&right.item_id));
    }
    Ok(())
}

pub(super) async fn prepare(
    runtime: &Runtime,
    original_catalog: Option<DeviceCatalogDocument>,
    decoded: DecodedDesktop,
) -> Result<PreparedAdmission, RuntimeError> {
    runtime.ensure_not_closed()?;
    let original_record = original_catalog
        .as_ref()
        .and_then(DeviceCatalogDocument::admission_record);
    if original_record.is_some_and(|record| {
        !matches!(
            record.phase(),
            Some(ImportPhase::Preparing | ImportPhase::Aborted)
        )
    }) {
        return Err(invalid(
            "Admission cannot prepare over another catalog lifecycle",
        ));
    }
    let original_record =
        original_record.filter(|record| record.phase() == Some(ImportPhase::Preparing));
    if original_record.is_none()
        && original_catalog
            .as_ref()
            .is_some_and(|catalog| !catalog.accounts.is_empty())
    {
        return Err(invalid("Admission cannot prepare over installed Accounts"));
    }
    let recorded = original_record.and_then(ProfileAdmissionRecord::progress);
    let admission_id = original_record
        .and_then(ProfileAdmissionRecord::admission_id)
        .map(str::to_owned)
        .unwrap_or_else(bittery_crypto_core::generate_uuid);
    let mut manifest = AdmissionManifest {
        header: decoded.manifest.header,
        entries: decoded.manifest.entries,
    };
    if let Some(recorded) = recorded {
        let mut comparable = manifest.clone();
        comparable.header.recorded_capture_id =
            recorded.manifest.header.recorded_capture_id.clone();
        if comparable != recorded.manifest {
            return Err(invalid(
                "Admission source disagrees with its durable manifest",
            ));
        }
        manifest = comparable;
        if decoded.accounts.len() != recorded.accounts.len()
            || decoded
                .accounts
                .iter()
                .zip(&recorded.accounts)
                .any(|(account, recorded)| account.account_id() != &recorded.account_id)
        {
            return Err(invalid(
                "Admission Account ordering disagrees with its durable mapping",
            ));
        }
    }
    let mut accounts = Vec::new();
    let mut mappings = Vec::new();
    let manifest_entries_sha256 = manifest.header.entries_sha256.clone();
    for (index, account) in decoded.accounts.into_iter().enumerate() {
        let generation = recorded
            .map(|value| value.accounts[index].incarnation.clone())
            .unwrap_or_else(|| bittery_crypto_core::generate_uuid().into());
        let mut bound = account.bind(generation.clone(), manifest_entries_sha256.clone())?;
        let prepared = prepare_install(
            None,
            bound.metadata.account_id.clone(),
            bound.metadata.user_id.clone(),
            generation,
        )?;
        let mut snapshot = reconstruct_snapshot(
            &bound.metadata.account_id,
            Some(prepared.next_head),
            Vec::new(),
        )?
        .ok_or_else(|| invalid("Admission could not prepare an empty Replica"))?;
        if let Some(legacy_cache) = bound.legacy_cache.take() {
            snapshot.bootstrap = BootstrapAuthority::admit_legacy(legacy_cache)?;
        }
        let security =
            AccountLocalSecurityDocument::new(bound.inactivity_timeout_ms.unwrap_or(600_000));
        let documents = AccountDocuments {
            bound,
            security,
            snapshot,
        };
        accounts.push(documents);
    }
    bind_commands(&mut accounts, &admission_id)?;
    for (index, documents) in accounts.iter().enumerate() {
        let expected = expectations(runtime, documents)?;
        let mapping = AdmissionAccount {
            account_id: documents.bound.metadata.account_id.clone(),
            normalized_server_url: documents.bound.metadata.normalized_server_url.clone(),
            user_id: documents.bound.metadata.user_id.clone(),
            incarnation: documents.bound.metadata.incarnation.clone(),
            expected_prior: ExpectedAbsent::Absent,
            session: if documents.bound.current_session.is_some() {
                SessionDisposition::Complete {
                    source_session_instance: None,
                }
            } else if documents
                .bound
                .legacy_session_evidence
                .as_ref()
                .is_some_and(|evidence| evidence.has_fragments())
            {
                SessionDisposition::IncompleteRetained {
                    source_session_instance: None,
                }
            } else {
                SessionDisposition::AbsentAtCapture {}
            },
            expected,
            checkpoint: recorded.map_or(AccountCheckpoint::Unwritten, |value| {
                value.accounts[index].checkpoint
            }),
        };
        if recorded.is_some_and(|value| value.accounts[index] != mapping) {
            return Err(invalid(
                "Admission decoded destination disagrees with its recorded expectations",
            ));
        }
        mappings.push(mapping);
    }
    let global_security = LocalSecurityDocument::new(
        decoded
            .master_password_reentry_period_ms
            .unwrap_or(30 * 24 * 60 * 60 * 1000),
    );
    let global_security_sha256 = document_digest(
        runtime,
        &PlatformStorageValue::LocalSecurity,
        &global_security,
    )?;
    let device_key_sha256 = decoded
        .device_key
        .as_ref()
        .map(|key| document_digest(runtime, &PlatformStorageValue::DeviceKey, key))
        .transpose()?;
    let device = match recorded {
        Some(recorded) => {
            if recorded.device.global_security_sha256 != global_security_sha256
                || recorded.device.device_key_sha256 != device_key_sha256
            {
                return Err(invalid(
                    "Admission Device plan disagrees with its recorded expectations",
                ));
            }
            recorded.device.clone()
        }
        None => AdmissionDevice {
            original_key: original(
                runtime,
                &PlatformStorageValue::DeviceKey,
                runtime.platform_storage.load_device_key().await?,
                decoded.device_key.as_ref(),
            )?,
            device_key_sha256,
            original_global_security: original(
                runtime,
                &PlatformStorageValue::LocalSecurity,
                runtime.platform_storage.load_local_security().await?,
                Some(&global_security),
            )?,
            global_security_sha256,
        },
    };
    let source_cleanup = manifest
        .entries
        .iter()
        .enumerate()
        .filter(|(_, entry)| {
            !matches!(
                entry.observation,
                crate::ProfileSourceObservation::Missing {}
            )
        })
        .map(|(index, _)| SourceCleanup {
            manifest_entry_index: index as u64,
            disposition: CleanupDisposition::Pending,
        })
        .collect();
    let presentation = LegacyPresentation {
        selected_account_id: decoded.selected_account,
        sync_client_id: decoded.sync_client_id,
    };
    let progress = AdmissionProgress {
        manifest,
        accounts: mappings,
        device,
        source_cleanup,
        abort_remaining: None,
    };
    let record = match original_record {
        Some(record) => {
            let mut rebuilt = record.clone();
            let ProfileAdmissionRecord::Import {
                legacy_presentation,
                ..
            } = &mut rebuilt
            else {
                return Err(invalid("Preparing import record is missing"));
            };
            if legacy_presentation.as_ref() != Some(&presentation) {
                return Err(invalid("Admission presentation evidence changed"));
            }
            *rebuilt
                .progress_mut()
                .ok_or_else(|| invalid("Admission progress is missing"))? = progress;
            if &rebuilt != record {
                return Err(invalid(
                    "Admission progress disagrees with its durable record",
                ));
            }
            rebuilt
        }
        None => ProfileAdmissionRecord::preparing(admission_id, progress, presentation),
    };
    let reserved = record
        .progress()
        .unwrap()
        .accounts
        .iter()
        .map(|account| DeviceCatalogAccount {
            account_id: account.account_id.clone(),
            active_incarnation: None,
            pending_retirement: None,
            pending_install: Some(PendingAccountInstallIntent {
                incarnation: account.incarnation.clone(),
                expected_active_incarnation: None,
            }),
        })
        .collect();
    let catalog = original_catalog
        .as_ref()
        .cloned()
        .unwrap_or(DeviceCatalogDocument::new(Vec::new())?)
        .with_admission(record, reserved)?;
    Ok(PreparedAdmission {
        catalog,
        original_catalog,
        accounts,
        device_key: decoded.device_key,
        global_security,
    })
}

async fn store_catalog(
    runtime: &Runtime,
    expected: &DeviceCatalogDocument,
) -> Result<(), RuntimeError> {
    runtime.ensure_not_closed()?;
    let written = runtime
        .platform_storage
        .store_device_catalog(expected)
        .await;
    runtime.ensure_not_closed()?;
    let observed = runtime.platform_storage.load_device_catalog().await?;
    if observed.as_ref() == Some(expected) {
        return Ok(());
    }
    Err(written
        .err()
        .unwrap_or_else(|| invalid("Admission catalog write could not be reconciled exactly")))
}

async fn stage_document<T, R, W, RF, WF>(
    runtime: &Runtime,
    target: PlatformStorageValue,
    expected: &T,
    may_create: bool,
    read: R,
    write: W,
) -> Result<(), RuntimeError>
where
    T: Serialize,
    R: Fn() -> RF,
    W: FnOnce() -> WF,
    RF: Future<Output = Result<Option<T>, RuntimeError>>,
    WF: Future<Output = Result<(), RuntimeError>>,
{
    runtime.ensure_not_closed()?;
    let digest = document_digest(runtime, &target, expected)?;
    if let Some(actual) = read().await? {
        if document_digest(runtime, &target, &actual)? == digest {
            return Ok(());
        }
        return Err(invalid("Admission destination document changed"));
    }
    if !may_create {
        return Err(invalid("Admission original Device document disappeared"));
    }
    runtime.ensure_not_closed()?;
    let written = write().await;
    runtime.ensure_not_closed()?;
    if let Some(actual) = read().await? {
        if document_digest(runtime, &target, &actual)? == digest {
            return Ok(());
        }
    }
    Err(written
        .err()
        .unwrap_or_else(|| invalid("Admission destination write could not be reconciled exactly")))
}

async fn verify_document<T: Serialize>(
    runtime: &Runtime,
    target: PlatformStorageValue,
    actual: Option<T>,
    expected: &T,
) -> Result<(), RuntimeError> {
    runtime.ensure_not_closed()?;
    let actual = actual.ok_or_else(|| invalid("Admission destination document is missing"))?;
    if document_digest(runtime, &target, &actual)? != document_digest(runtime, &target, expected)? {
        return Err(invalid("Admission destination document changed"));
    }
    Ok(())
}

async fn verify_account(runtime: &Runtime, account: &AccountDocuments) -> Result<(), RuntimeError> {
    let storage = &runtime.platform_storage;
    let id = &account.bound.metadata.account_id;
    let generation = &account.bound.metadata.incarnation;
    verify_document(
        runtime,
        PlatformStorageValue::AccountMetadata(id.clone(), generation.clone()),
        storage.load_account_metadata(id, generation).await?,
        &account.bound.metadata,
    )
    .await?;
    verify_document(
        runtime,
        PlatformStorageValue::AccountQuickUnlock(id.clone(), generation.clone()),
        storage.load_quick_unlock(id, generation).await?,
        &account.bound.quick_unlock,
    )
    .await?;
    verify_document(
        runtime,
        PlatformStorageValue::AccountLocalSecurity(id.clone()),
        storage.load_account_local_security(id).await?,
        &account.security,
    )
    .await?;
    let actual = storage.load_current_session(id, generation).await?;
    match (&account.bound.current_session, actual) {
        (Some(expected), actual) => {
            verify_document(
                runtime,
                PlatformStorageValue::CurrentSessionCredentials(id.clone(), generation.clone()),
                actual,
                expected,
            )
            .await?
        }
        (None, None) => {}
        _ => {
            return Err(invalid(
                "Admission found unexpected Current Session credentials",
            ))
        }
    }
    let actual = storage.load_legacy_session_evidence(id, generation).await?;
    match (&account.bound.legacy_session_evidence, actual) {
        (Some(expected), actual) => {
            verify_document(
                runtime,
                PlatformStorageValue::LegacySessionEvidence(id.clone(), generation.clone()),
                actual,
                expected,
            )
            .await?
        }
        (None, None) => {}
        _ => {
            return Err(invalid(
                "Admission found unexpected legacy Session evidence",
            ))
        }
    }
    if runtime.replica.load_uncached(id).await?.as_ref() != Some(&account.snapshot) {
        return Err(invalid(
            "Admission Replica differs from its recorded empty snapshot",
        ));
    }
    Ok(())
}

fn preflight_document<T: Serialize>(
    runtime: &Runtime,
    target: PlatformStorageValue,
    actual: Option<T>,
    expected: Option<&T>,
    required: bool,
) -> Result<(), RuntimeError> {
    match (actual, expected) {
        (Some(actual), Some(expected))
            if document_digest(runtime, &target, &actual)?
                == document_digest(runtime, &target, expected)? =>
        {
            Ok(())
        }
        (None, _) if !required => Ok(()),
        _ => Err(invalid(
            "Admission destination evidence disagrees before staging",
        )),
    }
}

async fn preflight(runtime: &Runtime, prepared: &PreparedAdmission) -> Result<(), RuntimeError> {
    let progress = prepared
        .catalog
        .admission_record()
        .unwrap()
        .progress()
        .unwrap();
    let verified = progress
        .accounts
        .iter()
        .any(|account| account.checkpoint == AccountCheckpoint::Verified);
    let storage = &runtime.platform_storage;
    preflight_document(
        runtime,
        PlatformStorageValue::DeviceKey,
        storage.load_device_key().await?,
        prepared.device_key.as_ref(),
        prepared.device_key.is_some()
            && (verified
                || matches!(
                    progress.device.original_key,
                    OriginalDocument::Matching { .. }
                )),
    )?;
    preflight_document(
        runtime,
        PlatformStorageValue::LocalSecurity,
        storage.load_local_security().await?,
        Some(&prepared.global_security),
        verified
            || matches!(
                progress.device.original_global_security,
                OriginalDocument::Matching { .. }
            ),
    )?;
    for (account, checkpoint) in prepared.accounts.iter().zip(&progress.accounts) {
        runtime.ensure_not_closed()?;
        let required = checkpoint.checkpoint == AccountCheckpoint::Verified;
        let id = &account.bound.metadata.account_id;
        let generation = &account.bound.metadata.incarnation;
        preflight_document(
            runtime,
            PlatformStorageValue::AccountMetadata(id.clone(), generation.clone()),
            storage.load_account_metadata(id, generation).await?,
            Some(&account.bound.metadata),
            required,
        )?;
        preflight_document(
            runtime,
            PlatformStorageValue::AccountQuickUnlock(id.clone(), generation.clone()),
            storage.load_quick_unlock(id, generation).await?,
            Some(&account.bound.quick_unlock),
            required,
        )?;
        preflight_document(
            runtime,
            PlatformStorageValue::AccountLocalSecurity(id.clone()),
            storage.load_account_local_security(id).await?,
            Some(&account.security),
            required,
        )?;
        preflight_document(
            runtime,
            PlatformStorageValue::CurrentSessionCredentials(id.clone(), generation.clone()),
            storage.load_current_session(id, generation).await?,
            account.bound.current_session.as_ref(),
            required && account.bound.current_session.is_some(),
        )?;
        preflight_document(
            runtime,
            PlatformStorageValue::LegacySessionEvidence(id.clone(), generation.clone()),
            storage.load_legacy_session_evidence(id, generation).await?,
            account.bound.legacy_session_evidence.as_ref(),
            required && account.bound.legacy_session_evidence.is_some(),
        )?;
        let actual = runtime.replica.load_uncached(id).await?;
        if actual
            .as_ref()
            .is_some_and(|actual| actual != &account.snapshot)
            || (required && actual.is_none())
        {
            return Err(invalid(
                "Admission Replica evidence disagrees before staging",
            ));
        }
    }
    runtime.ensure_not_closed()
}

pub(super) async fn stage(
    runtime: &Runtime,
    prepared: &mut PreparedAdmission,
) -> Result<(), RuntimeError> {
    runtime.ensure_not_closed()?;
    if runtime.platform_storage.load_device_catalog().await? != prepared.original_catalog {
        return Err(invalid("Admission catalog changed before staging"));
    }
    // Census checks physical tuples. This complete content pass must precede every write so
    // an earlier missing document cannot be recreated before a later conflict is discovered.
    preflight(runtime, prepared).await?;
    if prepared.original_catalog.as_ref() != Some(&prepared.catalog) {
        store_catalog(runtime, &prepared.catalog).await?;
    }
    let device = &prepared
        .catalog
        .admission_record()
        .unwrap()
        .progress()
        .unwrap()
        .device;
    let storage = &runtime.platform_storage;
    let verified = prepared
        .catalog
        .admission_record()
        .unwrap()
        .progress()
        .unwrap()
        .accounts
        .iter()
        .any(|account| account.checkpoint == AccountCheckpoint::Verified);
    if let Some(key) = &prepared.device_key {
        stage_document(
            runtime,
            PlatformStorageValue::DeviceKey,
            key,
            !verified && matches!(device.original_key, OriginalDocument::Absent {}),
            || storage.load_device_key(),
            || storage.store_device_key(key),
        )
        .await?;
    } else if storage.load_device_key().await?.is_some() {
        return Err(invalid("Admission found an unexplained Device key"));
    }
    stage_document(
        runtime,
        PlatformStorageValue::LocalSecurity,
        &prepared.global_security,
        !verified && matches!(device.original_global_security, OriginalDocument::Absent {}),
        || storage.load_local_security(),
        || storage.store_local_security(prepared.global_security.master_password_reentry_period_ms),
    )
    .await?;
    for index in 0..prepared.accounts.len() {
        let account = &prepared.accounts[index];
        if prepared
            .catalog
            .admission_record()
            .unwrap()
            .progress()
            .unwrap()
            .accounts[index]
            .checkpoint
            == AccountCheckpoint::Verified
        {
            verify_account(runtime, account).await?;
            continue;
        }
        let id = &account.bound.metadata.account_id;
        let generation = &account.bound.metadata.incarnation;
        stage_document(
            runtime,
            PlatformStorageValue::AccountMetadata(id.clone(), generation.clone()),
            &account.bound.metadata,
            true,
            || storage.load_account_metadata(id, generation),
            || storage.store_account_metadata(&account.bound.metadata),
        )
        .await?;
        stage_document(
            runtime,
            PlatformStorageValue::AccountQuickUnlock(id.clone(), generation.clone()),
            &account.bound.quick_unlock,
            true,
            || storage.load_quick_unlock(id, generation),
            || storage.store_quick_unlock(&account.bound.quick_unlock),
        )
        .await?;
        stage_document(
            runtime,
            PlatformStorageValue::AccountLocalSecurity(id.clone()),
            &account.security,
            true,
            || storage.load_account_local_security(id),
            || storage.store_inactivity_timeout(id, account.security.inactivity_timeout_ms),
        )
        .await?;
        if let Some(session) = &account.bound.current_session {
            stage_document(
                runtime,
                PlatformStorageValue::CurrentSessionCredentials(id.clone(), generation.clone()),
                session,
                true,
                || storage.load_current_session(id, generation),
                || storage.store_current_session(session),
            )
            .await?;
        } else if storage
            .load_current_session(id, generation)
            .await?
            .is_some()
        {
            return Err(invalid(
                "Admission found unexplained Current Session credentials",
            ));
        }
        if let Some(evidence) = &account.bound.legacy_session_evidence {
            stage_document(
                runtime,
                PlatformStorageValue::LegacySessionEvidence(id.clone(), generation.clone()),
                evidence,
                true,
                || storage.load_legacy_session_evidence(id, generation),
                || storage.store_legacy_session_evidence(evidence),
            )
            .await?;
        } else if storage
            .load_legacy_session_evidence(id, generation)
            .await?
            .is_some()
        {
            return Err(invalid(
                "Admission found unexplained legacy Session evidence",
            ));
        }
        runtime
            .replica
            .stage_profile_admission_snapshot(&account.snapshot)
            .await?;
        verify_account(runtime, account).await?;
        let mut record = prepared.catalog.admission_record().unwrap().clone();
        if record.progress().unwrap().accounts[index].checkpoint == AccountCheckpoint::Unwritten {
            record.progress_mut().unwrap().accounts[index].checkpoint = AccountCheckpoint::Verified;
            record.advance(ImportPhase::Preparing)?;
            let next = prepared
                .catalog
                .with_admission(record, prepared.catalog.accounts.clone())?;
            if runtime
                .platform_storage
                .load_device_catalog()
                .await?
                .as_ref()
                != Some(&prepared.catalog)
            {
                return Err(invalid("Admission catalog changed before its checkpoint"));
            }
            store_catalog(runtime, &next).await?;
            prepared.catalog = next;
        }
    }
    Ok(())
}

pub(super) async fn commit(
    runtime: &Runtime,
    prepared: &mut PreparedAdmission,
) -> Result<DeviceCatalogDocument, RuntimeError> {
    runtime.ensure_not_closed()?;
    if runtime
        .platform_storage
        .load_device_catalog()
        .await?
        .as_ref()
        != Some(&prepared.catalog)
    {
        return Err(invalid("Admission catalog changed before commit"));
    }
    let storage = &runtime.platform_storage;
    if let Some(key) = &prepared.device_key {
        verify_document(
            runtime,
            PlatformStorageValue::DeviceKey,
            storage.load_device_key().await?,
            key,
        )
        .await?;
    } else if storage.load_device_key().await?.is_some() {
        return Err(invalid("Admission found an unexplained Device key"));
    }
    verify_document(
        runtime,
        PlatformStorageValue::LocalSecurity,
        storage.load_local_security().await?,
        &prepared.global_security,
    )
    .await?;
    for account in &prepared.accounts {
        verify_account(runtime, account).await?;
    }
    let mut record = prepared.catalog.admission_record().unwrap().clone();
    record.advance(ImportPhase::Committed)?;
    let accounts = record
        .progress()
        .unwrap()
        .accounts
        .iter()
        .map(|account| DeviceCatalogAccount {
            account_id: account.account_id.clone(),
            active_incarnation: Some(account.incarnation.clone()),
            pending_install: None,
            pending_retirement: None,
        })
        .collect();
    let committed = prepared.catalog.with_admission(record, accounts)?;
    store_catalog(runtime, &committed).await?;
    prepared.catalog = committed.clone();
    Ok(committed)
}
