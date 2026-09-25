//! Both explicit repair intents share one staged publication boundary; their proof conditions differ.
use super::{
    archive::{DecodedRecord, EntryHeader},
    artifacts::record_key,
    capture::{Snapshot, SnapshotBuilder},
    control::{
        RecoveryControlRequest as Control, RecoveryControlResponse as Reply, RecoveryExpectedRow,
        RecoveryRecord,
    },
    transfer::{invalid, ArchiveReader, PhysicalReader, RecoveryPort},
};
use crate::replica::{persistence_contract::ReplicaHead, recovery::CoverageProof};
use crate::{AccountId, Incarnation, RecoveryClassification, RuntimeError, RuntimeErrorCode};
use sha2::{Digest, Sha256};
use std::collections::HashMap;

pub(crate) struct RecoveryIdentity {
    pub account_id: AccountId,
    pub incarnation: Incarnation,
    pub user_id: String,
    pub server_url: String,
}
fn current_proof<'a>(
    snapshot: &'a Snapshot,
    identity: &RecoveryIdentity,
) -> Result<&'a CoverageProof, RuntimeError> {
    let proof = snapshot.proof.as_ref().ok_or_else(invalid)?;
    if !snapshot.read_complete
        || proof.head.account_id != identity.account_id
        || proof.head.user_id != identity.user_id
        || proof.head.incarnation != identity.incarnation
    {
        return Err(invalid());
    }
    Ok(proof)
}
fn next_head(
    snapshot: &Snapshot,
    identity: &RecoveryIdentity,
) -> Result<ReplicaHead, RuntimeError> {
    let mut next = current_proof(snapshot, identity)?.head.clone();
    if next.failure.is_some()
        && !snapshot.needs_rebuild()
        && snapshot.selection.is_some()
        && !matches!(
            next.failure,
            Some(RuntimeErrorCode::QuotaExceeded | RuntimeErrorCode::StorageUnavailable)
        )
    {
        return Err(invalid());
    }
    next.replica_revision = next.replica_revision.checked_add(1).ok_or_else(invalid)?;
    next.lock_epoch = next.lock_epoch.checked_add(1).ok_or_else(invalid)?;
    next.failure = None;
    Ok(next)
}
pub(crate) fn can_repair(snapshot: &Snapshot, identity: &RecoveryIdentity) -> bool {
    next_head(snapshot, identity).is_ok()
        && (!snapshot.complete
            || snapshot
                .proof
                .as_ref()
                .is_some_and(|proof| proof.head.failure.is_some()))
}
pub(crate) fn can_rebootstrap(snapshot: &Snapshot, identity: &RecoveryIdentity) -> bool {
    snapshot.selection.is_some() && can_repair(snapshot, identity)
}

pub(crate) async fn repair_bundle(
    port: &RecoveryPort,
    identity: &RecoveryIdentity,
    current: &Snapshot,
    password: &str,
    source_id: &str,
) -> Result<u64, RuntimeError> {
    let result = repair_bundle_inner(port, identity, current, password, source_id).await;
    let _ = port
        .invoke_cleanup(
            Control::SourceClose {
                recovery_id: port.recovery_id.clone(),
                account_id: identity.account_id.as_str().into(),
                capability_id: source_id.into(),
            },
            None,
        )
        .await;
    if result.is_err() {
        discard(port, &identity.account_id).await;
    }
    result
}
async fn repair_bundle_inner(
    port: &RecoveryPort,
    identity: &RecoveryIdentity,
    current: &Snapshot,
    password: &str,
    source_id: &str,
) -> Result<u64, RuntimeError> {
    let current_proof = current_proof(current, identity)?;
    let (candidate, fingerprint) =
        read_bundle(port, identity, current, password, source_id).await?;
    let candidate_proof = candidate.proof.as_ref().ok_or_else(invalid)?;
    if candidate_proof.head.replica_revision > current_proof.head.replica_revision {
        return Err(invalid());
    }
    let candidate_rows: HashMap<_, _> = candidate_proof
        .rows
        .iter()
        .map(|row| ((row.store, row.record_id.as_str()), row))
        .collect();
    // Recovery does not merge or resurrect acknowledged/cleaned-up accepted work.
    if current_proof.pending_vault_retirements != candidate_proof.pending_vault_retirements
        || current_proof.accepted_rows().count() != candidate_proof.accepted_rows().count()
    {
        return Err(invalid());
    }
    for row in current_proof.accepted_rows() {
        if candidate_rows
            .get(&(row.store, row.record_id.as_str()))
            .is_none_or(|candidate| {
                !candidate.accepted || candidate.payload_sha256 != row.payload_sha256
            })
        {
            return Err(invalid());
        }
    }
    if current.complete && current_proof.head.failure.is_none() {
        let identical_rows = current_proof.rows.len() == candidate_proof.rows.len()
            && current_proof.rows.iter().all(|row| {
                candidate_rows
                    .get(&(row.store, row.record_id.as_str()))
                    .is_some_and(|candidate| candidate.payload_sha256 == row.payload_sha256)
            });
        let identical_artifacts = equivalent_hashes(current)? == equivalent_hashes(&candidate)?;
        if identical_rows && identical_artifacts {
            return Ok(current_proof.head.replica_revision);
        }
        return Err(invalid());
    }
    let next = next_head(current, identity)?;
    begin(port, &identity.account_id, current_proof).await?;
    let mut reader = ArchiveReader::open(port, &identity.account_id, source_id, password).await?;
    let mut manifest_seen = false;
    let mut rows = 0u32;
    let mut report = None;
    let mut records = 0u32;
    while let Some(record) = reader.next().await? {
        if report.is_some() {
            return Err(invalid());
        }
        if matches!(record.header, EntryHeader::Report) {
            report = Some(super::report::RecoveryReport::decode(&record.body)?);
            continue;
        }
        if !matches!(record.header, EntryHeader::Manifest { .. }) {
            records = records.checked_add(1).ok_or_else(invalid)?;
        }
        match &record.header {
            EntryHeader::Manifest { .. } => {
                if manifest_seen {
                    return Err(invalid());
                }
                validate_manifest(&record, identity)?;
                manifest_seen = true;
            }
            EntryHeader::ReplicaHead { account_id } => {
                if account_id != identity.account_id.as_str()
                    || candidate.head_json.as_deref().map(str::as_bytes)
                        != Some(record.body.as_slice())
                {
                    return Err(invalid());
                }
            }
            EntryHeader::ReplicaRow {
                account_id,
                store,
                record_id,
            } => {
                if account_id != identity.account_id.as_str()
                    || candidate_rows
                        .get(&(*store, record_id.as_str()))
                        .is_none_or(|row| {
                            row.payload_sha256
                                != <[u8; 32]>::from(Sha256::digest(record.body.as_slice()))
                        })
                {
                    return Err(invalid());
                }
                stage_row(port, &identity.account_id, &record).await?;
                rows = rows.checked_add(1).ok_or_else(invalid)?;
            }
            _ => {
                let key = record_key(&record.header)?;
                let mut hash = Sha256::new();
                hash.update(key.as_bytes());
                hash.update(record.body.as_slice());
                if candidate.artifacts.record_hashes.get(&key)
                    != Some(&<[u8; 32]>::from(hash.finalize()))
                {
                    return Err(invalid());
                }
                match &record.header {
                    EntryHeader::ProtectedVaultImageKey { .. } => {}
                    EntryHeader::ProtectedVaultImageMetadata {
                        operation_id,
                        publication_id,
                        ..
                    } => {
                        let metadata = candidate
                            .artifacts
                            .image_metadata(operation_id, publication_id)
                            .ok_or_else(invalid)?;
                        let installed = DecodedRecord {
                            header: record.header,
                            body: zeroize::Zeroizing::new(
                                serde_json::to_vec(metadata).map_err(|_| invalid())?,
                            ),
                        };
                        add_artifact(port, &identity.account_id, installed).await?;
                    }
                    _ => add_artifact(port, &identity.account_id, record).await?,
                }
            }
        }
    }
    if !manifest_seen
        || report
            .as_ref()
            .is_none_or(|value| !value.proves_complete(records))
        || reader.source_fingerprint()? != fingerprint
        || rows as usize != candidate_proof.rows.len()
    {
        return Err(invalid());
    }
    commit(port, &identity.account_id, current, next, rows).await
}
async fn read_bundle(
    port: &RecoveryPort,
    identity: &RecoveryIdentity,
    current: &Snapshot,
    password: &str,
    source_id: &str,
) -> Result<(Snapshot, [u8; 32]), RuntimeError> {
    let mut reader = ArchiveReader::open(port, &identity.account_id, source_id, password).await?;
    let manifest = reader.next().await?.ok_or_else(invalid)?;
    validate_manifest(&manifest, identity)?;
    let protected_archive = matches!(manifest.header, EntryHeader::Manifest { version: 2, .. });
    let mut builder = SnapshotBuilder::for_archive(identity.account_id.clone());
    let mut device_key = None;
    let mut report = None;
    let mut records = 0u32;
    while let Some(record) = reader.next().await? {
        if report.is_some() {
            return Err(invalid());
        }
        if matches!(record.header, EntryHeader::Report) {
            report = Some(super::report::RecoveryReport::decode(&record.body)?);
        } else {
            if !protected_archive
                && matches!(
                    record.header,
                    EntryHeader::ProtectedVaultImageMetadata { .. }
                        | EntryHeader::ProtectedVaultImageChunk { .. }
                        | EntryHeader::ProtectedVaultImageKey { .. }
                )
            {
                return Err(invalid());
            }
            builder.observe(&record)?;
            if matches!(record.header, EntryHeader::ProtectedVaultImageKey { .. }) {
                if device_key.is_none() {
                    device_key = Some(port.image_device_key().await?);
                }
                builder.translate_image_key(
                    &record,
                    &current.artifacts,
                    &identity.user_id,
                    device_key.as_ref().ok_or_else(invalid)?.key_bytes.as_ref(),
                )?;
            }
            records = records.checked_add(1).ok_or_else(invalid)?;
        }
    }
    if report
        .as_ref()
        .is_none_or(|value| !value.proves_complete(records))
    {
        return Err(invalid());
    }
    let fingerprint = reader.source_fingerprint()?;
    let snapshot = builder.finish(true);
    if !snapshot.complete
        || snapshot
            .proof
            .as_ref()
            .is_none_or(|proof| proof.head.user_id != identity.user_id)
    {
        return Err(invalid());
    }
    // Complete archives carry only the dependencies their accepted records actually own.
    if snapshot.artifacts.record_hashes.len() != selected_hashes(&snapshot)?.len() {
        return Err(invalid());
    }
    Ok((snapshot, fingerprint))
}
fn validate_manifest(
    record: &DecodedRecord,
    identity: &RecoveryIdentity,
) -> Result<(), RuntimeError> {
    match &record.header {
        EntryHeader::Manifest {
            version: 1 | 2,
            account_id,
            server_url: Some(server_url),
            user_id: Some(user_id),
            classification: RecoveryClassification::Complete,
        } if record.body.is_empty()
            && account_id == identity.account_id.as_str()
            && server_url == &identity.server_url
            && user_id == &identity.user_id =>
        {
            Ok(())
        }
        _ => Err(invalid()),
    }
}
fn selected_hashes(snapshot: &Snapshot) -> Result<HashMap<&str, [u8; 32]>, RuntimeError> {
    let selected = snapshot.selection.as_ref().ok_or_else(invalid)?;
    snapshot
        .artifacts
        .record_hashes
        .iter()
        .filter_map(
            |(key, hash)| match serde_json::from_str::<EntryHeader>(key) {
                Ok(header) if selected.includes(&header) => Some(Ok((key.as_str(), *hash))),
                Ok(_) => None,
                Err(_) => Some(Err(invalid())),
            },
        )
        .collect()
}

/// Portable key records and source Device wrappers are transport evidence. Compare the same
/// validated binding/ciphertext and destination wrapper after translation for a lost-commit retry.
fn equivalent_hashes(snapshot: &Snapshot) -> Result<HashMap<String, [u8; 32]>, RuntimeError> {
    let mut result = HashMap::new();
    for (key, hash) in selected_hashes(snapshot)? {
        match serde_json::from_str::<EntryHeader>(key).map_err(|_| invalid())? {
            EntryHeader::ProtectedVaultImageKey { .. } => {}
            EntryHeader::ProtectedVaultImageMetadata {
                operation_id,
                publication_id,
                ..
            } => {
                let metadata = snapshot
                    .artifacts
                    .image_metadata(&operation_id, &publication_id)
                    .ok_or_else(invalid)?;
                let bytes = serde_json::to_vec(metadata).map_err(|_| invalid())?;
                result.insert(key.to_owned(), Sha256::digest(&bytes).into());
            }
            _ => {
                result.insert(key.to_owned(), hash);
            }
        }
    }
    Ok(result)
}

pub(crate) async fn rebootstrap(
    port: &RecoveryPort,
    identity: &RecoveryIdentity,
    current: &Snapshot,
) -> Result<u64, RuntimeError> {
    let result = rebootstrap_inner(port, identity, current).await;
    if result.is_err() {
        discard(port, &identity.account_id).await;
    }
    result
}
async fn rebootstrap_inner(
    port: &RecoveryPort,
    identity: &RecoveryIdentity,
    current: &Snapshot,
) -> Result<u64, RuntimeError> {
    if !can_rebootstrap(current, identity) {
        return Err(invalid());
    }
    let proof = current_proof(current, identity)?;
    let next = next_head(current, identity)?;
    let rows: HashMap<_, _> = proof
        .rows
        .iter()
        .map(|row| ((row.store, row.record_id.as_str()), row))
        .collect();
    begin(port, &identity.account_id, proof).await?;
    let mut reader = PhysicalReader::new(port, &identity.account_id);
    let mut staged = 0u32;
    while let Some(record) = reader.next().await? {
        if let EntryHeader::ReplicaRow {
            store, record_id, ..
        } = &record.header
        {
            let row = rows
                .get(&(*store, record_id.as_str()))
                .ok_or_else(invalid)?;
            if row.payload_sha256 != <[u8; 32]>::from(Sha256::digest(record.body.as_slice())) {
                return Err(invalid());
            }
            if row.accepted {
                stage_row(port, &identity.account_id, &record).await?;
                staged = staged.checked_add(1).ok_or_else(invalid)?;
            }
        }
    }
    if staged as usize != proof.accepted_rows().count() {
        return Err(invalid());
    }
    commit(port, &identity.account_id, current, next, staged).await
}
async fn begin(
    port: &RecoveryPort,
    account: &AccountId,
    proof: &CoverageProof,
) -> Result<(), RuntimeError> {
    expect(
        port,
        Control::BeginRepairStage {
            recovery_id: port.recovery_id.clone(),
            account_id: account.as_str().into(),
        },
        None,
        |reply| matches!(reply, Reply::RepairStageBegun),
    )
    .await?;
    for row in &proof.rows {
        expect(
            port,
            Control::StageExpectedRow {
                recovery_id: port.recovery_id.clone(),
                account_id: account.as_str().into(),
                row: RecoveryExpectedRow {
                    store: row.store,
                    record_id: row.record_id.clone(),
                    payload_sha256: hex(&row.payload_sha256),
                },
            },
            None,
            |reply| matches!(reply, Reply::ExpectedRowStaged),
        )
        .await?;
    }
    Ok(())
}
async fn stage_row(
    port: &RecoveryPort,
    account: &AccountId,
    record: &DecodedRecord,
) -> Result<(), RuntimeError> {
    let EntryHeader::ReplicaRow {
        store, record_id, ..
    } = &record.header
    else {
        return Err(invalid());
    };
    expect(
        port,
        Control::StageRowStart {
            recovery_id: port.recovery_id.clone(),
            account_id: account.as_str().into(),
            store: *store,
            record_id: record_id.clone(),
            payload_byte_length: record.body.len().try_into().map_err(|_| invalid())?,
        },
        None,
        |reply| matches!(reply, Reply::RowStarted),
    )
    .await?;
    for chunk in record.body.chunks(256 * 1024) {
        expect(
            port,
            Control::StageRowChunk {
                recovery_id: port.recovery_id.clone(),
                account_id: account.as_str().into(),
            },
            Some(chunk.to_vec()),
            |reply| matches!(reply, Reply::RowChunkStaged),
        )
        .await?;
    }
    expect(
        port,
        Control::StageRowEnd {
            recovery_id: port.recovery_id.clone(),
            account_id: account.as_str().into(),
        },
        None,
        |reply| matches!(reply, Reply::RowEnded),
    )
    .await
}
async fn commit(
    port: &RecoveryPort,
    account: &AccountId,
    current: &Snapshot,
    next: ReplicaHead,
    staged: u32,
) -> Result<u64, RuntimeError> {
    let revision = next.replica_revision;
    expect(
        port,
        Control::CommitRepair {
            recovery_id: port.recovery_id.clone(),
            account_id: account.as_str().into(),
            expected_head_json: current.head_json.clone().ok_or_else(invalid)?,
            next_head: next,
            staged_row_count: staged,
            expected_row_count: current
                .proof
                .as_ref()
                .ok_or_else(invalid)?
                .rows
                .len()
                .try_into()
                .map_err(|_| invalid())?,
        },
        None,
        |reply| matches!(reply, Reply::Repaired),
    )
    .await?;
    Ok(revision)
}
async fn discard(port: &RecoveryPort, account: &AccountId) {
    let _ = port
        .invoke_cleanup(
            Control::DiscardRepairStage {
                recovery_id: port.recovery_id.clone(),
                account_id: account.as_str().into(),
            },
            None,
        )
        .await;
}
async fn expect(
    port: &RecoveryPort,
    request: Control,
    binary: Option<Vec<u8>>,
    accept: fn(&Reply) -> bool,
) -> Result<(), RuntimeError> {
    let (reply, binary) = port.invoke(request, binary).await?;
    if accept(&reply) && binary.is_none() {
        Ok(())
    } else {
        Err(invalid())
    }
}
fn hex(bytes: &[u8]) -> String {
    use std::fmt::Write;
    let mut output = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        write!(output, "{byte:02x}").expect("String formatting is infallible");
    }
    output
}
async fn add_artifact(
    port: &RecoveryPort,
    account: &AccountId,
    mut entry: DecodedRecord,
) -> Result<(), RuntimeError> {
    let text = |body: &mut zeroize::Zeroizing<Vec<u8>>| {
        String::from_utf8(std::mem::take(&mut **body)).map_err(|_| invalid())
    };
    let (record, binary) = match entry.header {
        EntryHeader::ArtifactMetadata {
            account_id,
            artifact_id,
        } => (
            RecoveryRecord::ArtifactMetadata {
                account_id,
                artifact_id,
                metadata_json: text(&mut entry.body)?,
            },
            None,
        ),
        EntryHeader::ArtifactChunk {
            account_id,
            artifact_id,
            chunk_index,
            chunk_sha256,
        } => (
            RecoveryRecord::ArtifactChunk {
                account_id,
                artifact_id,
                chunk_index,
                chunk_sha256,
            },
            Some(std::mem::take(&mut *entry.body)),
        ),
        EntryHeader::ProvisionalMetadata {
            account_id,
            operation_id,
            attachment_id,
            generation,
        } => (
            RecoveryRecord::ProvisionalMetadata {
                account_id,
                operation_id,
                attachment_id,
                generation,
                metadata_json: text(&mut entry.body)?,
            },
            None,
        ),
        EntryHeader::ProvisionalChunk {
            account_id,
            operation_id,
            attachment_id,
            generation,
            chunk_index,
            chunk_sha256,
        } => (
            RecoveryRecord::ProvisionalChunk {
                account_id,
                operation_id,
                attachment_id,
                generation,
                chunk_index,
                chunk_sha256,
            },
            Some(std::mem::take(&mut *entry.body)),
        ),
        EntryHeader::VaultImageMetadata {
            account_id,
            operation_id,
        } => (
            RecoveryRecord::VaultImageMetadata {
                account_id,
                operation_id,
                metadata_json: text(&mut entry.body)?,
            },
            None,
        ),
        EntryHeader::VaultImageChunk {
            account_id,
            operation_id,
            chunk_index,
        } => (
            RecoveryRecord::VaultImageChunk {
                account_id,
                operation_id,
                chunk_index,
            },
            Some(std::mem::take(&mut *entry.body)),
        ),
        EntryHeader::ProtectedVaultImageMetadata {
            account_id,
            operation_id,
            publication_id,
        } => (
            RecoveryRecord::ProtectedVaultImageMetadata {
                account_id,
                operation_id,
                publication_id,
                metadata_json: text(&mut entry.body)?,
            },
            None,
        ),
        EntryHeader::ProtectedVaultImageChunk {
            account_id,
            operation_id,
            publication_id,
            chunk_index,
        } => (
            RecoveryRecord::ProtectedVaultImageChunk {
                account_id,
                operation_id,
                publication_id,
                chunk_index,
            },
            Some(std::mem::take(&mut *entry.body)),
        ),
        _ => return Err(invalid()),
    };
    if record.account_id() != account.as_str() {
        return Err(invalid());
    }
    expect(
        port,
        Control::AddArtifactEntry {
            recovery_id: port.recovery_id.clone(),
            account_id: account.as_str().into(),
            record,
        },
        binary,
        |reply| matches!(reply, Reply::ArtifactAdded),
    )
    .await
}
