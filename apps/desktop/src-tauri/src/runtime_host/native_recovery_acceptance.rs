//! Opt-in acceptance through the actual native Core, encrypted archive, and SQLite adapters.
//! The Server fixture supplies authority; this module injects only recoverable physical loss.

use super::{
    super::device_lease::{DeviceLeaseMode, NativeDeviceLease},
    NativeRuntime,
};
use bittery_client_core::{
    AccountId, RecoveryClassification, RecoveryStorageState, RequestCancellation, RuntimeRequest,
    RuntimeResponse,
};
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use std::{fs::File, io::Write, path::Path};
use zeroize::{Zeroize, ZeroizeOnDrop, Zeroizing};

const ARCHIVE: &str = "native-recovery.btrrec";
const WITNESS: &str = "acceptance-recovery-witness.json";

#[derive(PartialEq, Eq, Serialize, Deserialize, Zeroize, ZeroizeOnDrop)]
struct PhysicalRow {
    store: i64,
    record_id: String,
    payload: String,
}
#[derive(Serialize, Deserialize, Zeroize, ZeroizeOnDrop)]
struct Witness {
    revision: u64,
    operation_id: String,
    rows: Vec<PhysicalRow>,
    artifacts: Vec<PhysicalArtifact>,
}
#[derive(PartialEq, Eq, Serialize, Deserialize, Zeroize, ZeroizeOnDrop)]
struct PhysicalChunk {
    index: i64,
    sha256: String,
    ciphertext: Vec<u8>,
}
#[derive(PartialEq, Eq, Serialize, Deserialize, Zeroize, ZeroizeOnDrop)]
struct PhysicalArtifact {
    artifact_id: String,
    attachment_id: String,
    sha256: String,
    byte_length: i64,
    chunk_count: i64,
    generation: Option<String>,
    chunks: Vec<PhysicalChunk>,
}
fn artifacts(
    directory: &Path,
    account_id: &AccountId,
    operation_id: &str,
) -> Result<Vec<PhysicalArtifact>, String> {
    let connection = Connection::open(directory.join("attachments.sqlite"))
        .map_err(|_| "Cannot open actual Attachment artifacts for recovery witness")?;
    let mut statement = connection.prepare(
        "SELECT artifact_id,attachment_id,ciphertext_sha256,byte_length,chunk_count,physical_generation FROM attachment_move_artifacts WHERE account_id=?1 AND operation_id=?2 AND publication_state=2 ORDER BY artifact_id",
    ).map_err(|_| "Cannot query actual published Move artifacts")?;
    let metadata = statement
        .query_map(params![account_id.as_str(), operation_id], |row| {
            Ok(PhysicalArtifact {
                artifact_id: row.get(0)?,
                attachment_id: row.get(1)?,
                sha256: row.get(2)?,
                byte_length: row.get(3)?,
                chunk_count: row.get(4)?,
                generation: row.get(5)?,
                chunks: Vec::new(),
            })
        })
        .map_err(|_| "Cannot read published Move artifact metadata")?;
    let mut output = Vec::new();
    for metadata in metadata {
        let mut artifact = metadata.map_err(|_| "Invalid published artifact metadata")?;
        let (sql, parameters) = if let Some(generation) = &artifact.generation {
            ("SELECT chunk_index,ciphertext_sha256,ciphertext FROM attachment_move_provisional_chunks WHERE account_id=?1 AND operation_id=?2 AND attachment_id=?3 AND generation=?4 ORDER BY chunk_index",
             vec![account_id.as_str(), operation_id, artifact.attachment_id.as_str(), generation.as_str()])
        } else {
            ("SELECT chunk_index,ciphertext_sha256,ciphertext FROM attachment_move_artifact_chunks WHERE account_id=?1 AND artifact_id=?2 ORDER BY chunk_index",
             vec![account_id.as_str(), artifact.artifact_id.as_str()])
        };
        artifact.chunks = connection
            .prepare(sql)
            .and_then(|mut statement| {
                statement
                    .query_map(rusqlite::params_from_iter(parameters), |row| {
                        Ok(PhysicalChunk {
                            index: row.get(0)?,
                            sha256: row.get(1)?,
                            ciphertext: row.get(2)?,
                        })
                    })?
                    .collect()
            })
            .map_err(|_| "Cannot capture actual published ciphertext chunks")?;
        output.push(artifact);
    }
    Ok(output)
}
fn account(directory: &Path) -> Result<AccountId, String> {
    std::fs::read_to_string(directory.join("acceptance-account-id"))
        .map(AccountId::from)
        .map_err(|_| "Cannot read isolated Account identity".into())
}
fn exclusive(directory: &Path) -> Result<NativeDeviceLease, String> {
    NativeDeviceLease::try_acquire(directory, DeviceLeaseMode::Exclusive)
        .map_err(|_| "Cannot acquire acceptance maintenance gate")?
        .ok_or_else(|| "Recovery did not release its native maintenance gate".into())
}
fn rows(connection: &Connection, account_id: &AccountId) -> Result<Vec<PhysicalRow>, String> {
    connection
        .prepare("SELECT store, record_id, payload_json FROM replica_rows WHERE account_id = ?1 ORDER BY store, record_id")
        .and_then(|mut statement| {
            statement.query_map([account_id.as_str()], |row| Ok(PhysicalRow {
                store: row.get(0)?, record_id: row.get(1)?, payload: row.get(2)?,
            }))?.collect()
        })
        .map_err(|_| "Cannot capture actual SQLite Replica rows".into())
}
async fn request(
    native: &NativeRuntime,
    request: RuntimeRequest,
) -> Result<RuntimeResponse, String> {
    native
        .core
        .request(request, RequestCancellation::new())
        .await
        .map_err(|error| format!("Native recovery request failed: {:?}", error.code))
}

pub(super) async fn export_locked_and_damage(
    native: &NativeRuntime,
    directory: &Path,
    password: &str,
) -> Result<(), String> {
    let account_id = account(directory)?;
    let capability = native
        .recovery_files
        .grant_sink(
            account_id.clone(),
            tempfile::tempfile_in(directory).map_err(|_| "Cannot select isolated recovery sink")?,
            directory.join(ARCHIVE),
        )
        .map_err(|_| "Cannot grant native recovery sink")?;
    let result = request(
        native,
        RuntimeRequest::ExportAccountRecovery {
            account_id: account_id.clone(),
            password: password.into(),
            sink_capability_id: capability.clone(),
        },
    )
    .await;
    native
        .recovery_files
        .release(&capability)
        .map_err(|_| "Cannot release recovery sink")?;
    let RuntimeResponse::RecoveryExported {
        account_id: exported_account,
        classification,
        byte_length,
    } = result?
    else {
        return Err("Expected real encrypted RecoveryExported response".into());
    };
    if exported_account != account_id || classification != RecoveryClassification::Complete {
        if let Ok(RuntimeResponse::RecoveryDiagnosed { diagnostics }) = request(
            native,
            RuntimeRequest::InspectRecovery {
                account_id: Some(account_id.clone()),
            },
        )
        .await
        {
            for entry in diagnostics
                .accounts
                .iter()
                .filter(|entry| entry.account_id == account_id)
            {
                eprintln!(
                    "Incomplete native export: classification={classification:?}, schema={:?}, state={:?}, operations={:?}, receipts={:?}, missing_artifacts={:?}, can_repair={}",
                    diagnostics.schema, entry.state, entry.operation_count, entry.receipt_count,
                    entry.missing_artifacts, entry.can_repair
                );
            }
        }
        return Err("Locked native export did not preserve complete accepted work".into());
    }
    let archive = Zeroizing::new(
        std::fs::read(directory.join(ARCHIVE))
            .map_err(|_| "Cannot read committed encrypted archive")?,
    );
    if archive.len() as u64 != byte_length || !archive.starts_with(b"BTRREC01") {
        return Err(
            "Native recovery output did not preserve the existing encrypted V1 format".into(),
        );
    }
    // Core has closed normal work and left maintenance. The physical fault cannot race a live owner.
    let _gate = exclusive(directory)?;
    let connection = Connection::open(directory.join("replica.sqlite"))
        .map_err(|_| "Cannot open isolated Replica for physical recovery fault")?;
    let original = rows(&connection, &account_id)?;
    let operation_id = std::fs::read_to_string(directory.join("acceptance-move-operation-id"))
        .map_err(|_| "Cannot read actual accepted Move identity")?;
    let published = artifacts(directory, &account_id, &operation_id)?;
    if published.is_empty()
        || published.iter().any(|artifact| {
            artifact.chunks.len() < 2
                || artifact.chunk_count != artifact.chunks.len() as i64
                || artifact.byte_length <= 0
                || artifact
                    .chunks
                    .iter()
                    .any(|chunk| chunk.ciphertext.is_empty())
        })
    {
        return Err(
            "Encrypted recovery fixture has no actual nonempty published Move artifact".into(),
        );
    }
    // Core accepts preparations in store8, then promotes to an immutable store1 Operation.
    if !original
        .iter()
        .any(|row| matches!(row.store, 1 | 8) && row.record_id == operation_id)
    {
        return Err(
            "Encrypted recovery fixture has no actual accepted Move preparation or Operation row"
                .into(),
        );
    }
    let damaged_id = original
        .iter()
        .find(|row| row.store == 7)
        .ok_or("Recovery fixture has no authoritative Item to damage")?
        .record_id
        .clone();
    let revision: String = connection
        .query_row(
            "SELECT replica_revision FROM replica_heads WHERE account_id = ?1",
            [account_id.as_str()],
            |row| row.get(0),
        )
        .map_err(|_| "Cannot read native Replica revision")?;
    let witness = Witness {
        revision: revision
            .parse()
            .map_err(|_| "Invalid native Replica revision")?,
        operation_id,
        rows: original,
        artifacts: published,
    };
    let bytes = Zeroizing::new(
        serde_json::to_vec(&witness).map_err(|_| "Cannot encode protected recovery witness")?,
    );
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options
        .open(directory.join(WITNESS))
        .map_err(|_| "Cannot create protected recovery witness")?;
    file.write_all(&bytes)
        .and_then(|()| file.sync_all())
        .map_err(|_| "Cannot persist recovery witness")?;
    let changed = connection.execute(
        "UPDATE replica_rows SET payload_json = 'malformed acceptance fault' WHERE account_id = ?1 AND store = 7 AND record_id = ?2",
        params![account_id.as_str(), damaged_id],
    ).map_err(|_| "Cannot inject isolated physical authority damage")?;
    if changed != 1 {
        return Err("Recovery fault did not target exactly one existing authoritative Item".into());
    }
    let artifact = &witness.artifacts[0];
    let artifacts_connection = Connection::open(directory.join("attachments.sqlite"))
        .map_err(|_| "Cannot open isolated ciphertext for recovery fault")?;
    let changed = if let Some(generation) = &artifact.generation {
        artifacts_connection.execute(
            "DELETE FROM attachment_move_provisional_chunks WHERE account_id=?1 AND operation_id=?2 AND attachment_id=?3 AND generation=?4 AND chunk_index=?5",
            params![account_id.as_str(), witness.operation_id, artifact.attachment_id, generation, artifact.chunks[0].index],
        )
    } else {
        artifacts_connection.execute(
            "DELETE FROM attachment_move_artifact_chunks WHERE account_id=?1 AND artifact_id=?2 AND chunk_index=?3",
            params![account_id.as_str(), artifact.artifact_id, artifact.chunks[0].index],
        )
    }.map_err(|_| "Cannot inject isolated published ciphertext loss")?;
    if changed != 1 {
        return Err("Recovery fault did not remove exactly one witnessed ciphertext chunk".into());
    }
    super::protected_image_acceptance::damage(&account_id, directory)?;
    eprintln!("Locked native encrypted export preserved actual accepted Move and published ciphertext; one derived SQLite row and one ciphertext chunk damaged under exclusive maintenance");
    Ok(())
}

pub(super) async fn repair_selected_archive(
    native: &NativeRuntime,
    directory: &Path,
    password: &str,
) -> Result<(), String> {
    let account_id = account(directory)?;
    let bytes = Zeroizing::new(
        std::fs::read(directory.join(WITNESS))
            .map_err(|_| "Cannot read protected recovery witness")?,
    );
    let witness: Witness =
        serde_json::from_slice(&bytes).map_err(|_| "Invalid protected recovery witness")?;
    let RuntimeResponse::RecoveryDiagnosed { diagnostics } = request(
        native,
        RuntimeRequest::InspectRecovery {
            account_id: Some(account_id.clone()),
        },
    )
    .await?
    else {
        return Err("Expected actual native recovery diagnostics".into());
    };
    if !diagnostics.accounts.iter().any(|entry| {
        entry.account_id == account_id
            && entry.can_repair
            && entry.state == RecoveryStorageState::Corrupt
            && entry.missing_artifacts != Some(0)
    }) {
        return Err(
            "Fresh native owner did not diagnose recoverable authority and required artifact loss"
                .into(),
        );
    }
    let capability = native
        .recovery_files
        .grant_source(
            account_id.clone(),
            File::open(directory.join(ARCHIVE))
                .map_err(|_| "Cannot select actual encrypted archive")?,
        )
        .map_err(|_| "Cannot grant native recovery source")?;
    let result = request(
        native,
        RuntimeRequest::RepairAccountRecovery {
            account_id: account_id.clone(),
            password: password.into(),
            source_capability_id: capability.clone(),
        },
    )
    .await;
    native
        .recovery_files
        .release(&capability)
        .map_err(|_| "Cannot release recovery source")?;
    let RuntimeResponse::RecoveryRepaired {
        account_id: repaired_account,
        replica_revision,
    } = result?
    else {
        return Err("Expected real guarded RecoveryRepaired response".into());
    };
    if repaired_account != account_id || replica_revision <= witness.revision {
        return Err("Guarded native repair did not advance the same Account revision".into());
    }
    let _gate = exclusive(directory)?;
    let connection = Connection::open(directory.join("replica.sqlite"))
        .map_err(|_| "Cannot verify repaired native Replica")?;
    let repaired = rows(&connection, &account_id)?;
    if repaired != witness.rows
        || !repaired
            .iter()
            .any(|row| matches!(row.store, 1 | 8) && row.record_id == witness.operation_id)
    {
        return Err("Native encrypted repair did not preserve every original Replica row and accepted Move byte".into());
    }
    if artifacts(directory, &account_id, &witness.operation_id)? != witness.artifacts {
        return Err(
            "Encrypted repair did not restore exact published ciphertext metadata and bytes".into(),
        );
    }
    super::protected_image_acceptance::verify_repaired(&account_id, directory)?;
    eprintln!("New native process repaired actual encrypted archive; every Replica row and missing published ciphertext chunk restored byte-for-byte");
    Ok(())
}

pub(super) fn verify_reopened_artifacts(directory: &Path) -> Result<(), String> {
    let account_id = account(directory)?;
    let bytes = Zeroizing::new(
        std::fs::read(directory.join(WITNESS))
            .map_err(|_| "Cannot reopen protected recovery witness")?,
    );
    let witness: Witness =
        serde_json::from_slice(&bytes).map_err(|_| "Invalid reopened recovery witness")?;
    if artifacts(directory, &account_id, &witness.operation_id)? != witness.artifacts {
        return Err("Fresh native owner did not retain repaired published ciphertext bytes".into());
    }
    super::protected_image_acceptance::verify_reopened(&account_id, directory)?;
    eprintln!("Fresh native owner retained exact restored published ciphertext before reconnect");
    Ok(())
}

pub(super) async fn rebootstrap_after_convergence(
    native: &NativeRuntime,
    directory: &Path,
) -> Result<(), String> {
    use super::tests::snapshot;
    use bittery_client_core::{ObservationRequest, OperationResolution, RuntimeProjection};
    let account_id = account(directory)?;
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(60);
    loop {
        let RuntimeProjection::Operations(operations) = snapshot(
            &native.core,
            ObservationRequest::Operations {
                account_id: account_id.clone(),
            },
        )?
        else {
            return Err("Expected Operations before native Rebootstrap".into());
        };
        if operations
            .operations
            .iter()
            .all(|operation| operation.resolution != OperationResolution::Pending)
        {
            break;
        }
        if tokio::time::Instant::now() >= deadline {
            return Err("Accepted work did not settle before native Rebootstrap acceptance".into());
        }
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    }
    // Rebootstrap is a recovery action, not a healthy-account cache reset. Retire the normal
    // owner first, then reproduce derived corruption without altering any accepted records.
    let RuntimeResponse::RecoveryDiagnosed { .. } = request(
        native,
        RuntimeRequest::InspectRecovery {
            account_id: Some(account_id.clone()),
        },
    )
    .await?
    else {
        return Err("Expected recovery retirement before Rebootstrap fault".into());
    };
    let (accepted, revision) = {
        let _gate = exclusive(directory)?;
        let connection = Connection::open(directory.join("replica.sqlite"))
            .map_err(|_| "Cannot open isolated Rebootstrap fault boundary")?;
        let mut original = rows(&connection, &account_id)?;
        if original.iter().any(|row| row.store == 8) {
            return Err("Native Rebootstrap fixture still has accepted Move preparation".into());
        }
        let damaged = original
            .iter()
            .find(|row| row.store == 7)
            .ok_or("Native Rebootstrap fixture has no authoritative Item")?
            .record_id
            .clone();
        let revision: String = connection
            .query_row(
                "SELECT replica_revision FROM replica_heads WHERE account_id=?1",
                [account_id.as_str()],
                |row| row.get(0),
            )
            .map_err(|_| "Cannot read pre-Rebootstrap revision")?;
        let changed = connection.execute(
            "UPDATE replica_rows SET payload_json='malformed rebootstrap acceptance fault' WHERE account_id=?1 AND store=7 AND record_id=?2",
            params![account_id.as_str(), damaged],
        ).map_err(|_| "Cannot inject isolated Rebootstrap authority fault")?;
        if changed != 1 {
            return Err("Rebootstrap fault did not target exactly one authority row".into());
        }
        // The same fixed native store mapping used by Core RecoveryCoverage: accepted overlays,
        // Operations, receipts, Move preparations, and protected Share capabilities survive.
        original.retain(|row| matches!(row.store, 0 | 1 | 2 | 8 | 9));
        (
            original,
            revision
                .parse::<u64>()
                .map_err(|_| "Invalid pre-Rebootstrap revision")?,
        )
    };
    let RuntimeResponse::RecoveryRepaired {
        account_id: repaired,
        replica_revision,
    } = request(
        native,
        RuntimeRequest::RebootstrapAccountRecovery {
            account_id: account_id.clone(),
        },
    )
    .await?
    else {
        return Err("Expected actual native Rebootstrap recovery response".into());
    };
    if repaired != account_id || replica_revision <= revision {
        return Err("Native Rebootstrap did not advance the same Account revision".into());
    }
    let _gate = exclusive(directory)?;
    let connection = Connection::open(directory.join("replica.sqlite"))
        .map_err(|_| "Cannot inspect actual Rebootstrap publication")?;
    if rows(&connection, &account_id)? != accepted {
        return Err("Native Rebootstrap did not clear derived authority while retaining exact accepted rows".into());
    }
    eprintln!("Actual native Rebootstrap cleared damaged derived authority and preserved exact accepted records after pending work settled");
    Ok(())
}

pub(super) async fn verify_rebootstrap_reopen(
    native: &NativeRuntime,
    directory: &Path,
    password: &str,
    target_vault_id: &str,
) -> Result<(), String> {
    use super::tests::{check_access, sample_acceptance_items};
    use bittery_client_core::{AccountAccessState, ItemProjectionStatus};
    let account_id = account(directory)?;
    let item_id = std::fs::read_to_string(directory.join("acceptance-move-item-id"))
        .map_err(|_| "Cannot read converged Item identity after Rebootstrap")?;
    check_access(native, &account_id, AccountAccessState::Locked)?;
    request(
        native,
        RuntimeRequest::QuickUnlock {
            account_id: account_id.clone(),
            master_password: password.into(),
        },
    )
    .await?;
    check_access(native, &account_id, AccountAccessState::Unlocked)?;
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(60);
    loop {
        let Some(items) =
            sample_acceptance_items(native, &account_id, "Recovery Rebootstrap Item wait")?
        else {
            if tokio::time::Instant::now() >= deadline {
                return Err(
                    "Recovery Rebootstrap Item wait timed out with Unverified Travel enforcement"
                        .into(),
                );
            }
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
            continue;
        };
        if items.items.iter().any(|item| {
            item.item_id == item_id
                && item.vault_id == target_vault_id
                && item.status == ItemProjectionStatus::Authoritative
        }) {
            break;
        }
        if tokio::time::Instant::now() >= deadline {
            return Err(
                "Native Rebootstrap reopen did not restore real Server target-Vault authority"
                    .into(),
            );
        }
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    }
    eprintln!("Fresh native process reopened locked after Rebootstrap, Quick Unlocked, and restored the moved Item from real Server authority");
    Ok(())
}
