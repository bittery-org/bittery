//! Disposable SQLite input rows and one guarded Account install. No accepted-work interpretation.
use super::*;
use crate::{RecoveryControlRequest as Request, ReplicaHead, ReplicaStore};
use rusqlite::TransactionBehavior;
use sha2::{Digest, Sha256};

const STAGE_SCHEMA: &str = r#"
PRAGMA temp_store=FILE;
CREATE TEMP TABLE recovery_expected(store INTEGER NOT NULL,record_id TEXT NOT NULL,payload_sha256 TEXT NOT NULL,PRIMARY KEY(store,record_id));
CREATE TEMP TABLE recovery_rows(store INTEGER NOT NULL,record_id TEXT NOT NULL,byte_length INTEGER NOT NULL,complete INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(store,record_id));
CREATE TEMP TABLE recovery_chunks(store INTEGER NOT NULL,record_id TEXT NOT NULL,chunk_index INTEGER NOT NULL,bytes BLOB NOT NULL,PRIMARY KEY(store,record_id,chunk_index));
"#;
struct Building {
    store: ReplicaStore,
    record_id: String,
    length: usize,
    bytes: usize,
    chunks: u32,
}
pub(super) struct RepairStage {
    connection: Connection,
    recovery_id: String,
    account_id: String,
    building: Option<Building>,
    expected: u32,
    staged: u32,
    total: u64,
}
impl RepairStage {
    pub(super) fn begin(
        path: &Path,
        recovery_id: &str,
        account_id: &str,
    ) -> Result<Self, RuntimeError> {
        if recovery_id.is_empty()
            || account_id.is_empty()
            || recovery_id.len() > ID_BYTES
            || account_id.len() > ID_BYTES
        {
            return Err(corrupt());
        }
        let connection = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_WRITE)
            .map_err(storage_error)?;
        validate_schema(&connection, &crate::replica::sqlite::MIGRATION_1.join("\n"))
            .map_err(|_| storage_error("unsupported"))?;
        connection
            .execute_batch("PRAGMA foreign_keys=ON")
            .map_err(storage_error)?;
        connection
            .execute_batch(STAGE_SCHEMA)
            .map_err(storage_error)?;
        Ok(Self {
            connection,
            recovery_id: recovery_id.into(),
            account_id: account_id.into(),
            building: None,
            expected: 0,
            staged: 0,
            total: 0,
        })
    }
    pub(super) fn execute(
        &mut self,
        request: &Request,
        binary: Option<&[u8]>,
        cancellation: &crate::RequestCancellation,
    ) -> Result<Reply, RuntimeError> {
        let (recovery_id, account_id) = match request {
            Request::StageExpectedRow {
                recovery_id,
                account_id,
                ..
            }
            | Request::StageRowStart {
                recovery_id,
                account_id,
                ..
            }
            | Request::StageRowChunk {
                recovery_id,
                account_id,
            }
            | Request::StageRowEnd {
                recovery_id,
                account_id,
            }
            | Request::CommitRepair {
                recovery_id,
                account_id,
                ..
            }
            | Request::DiscardRepairStage {
                recovery_id,
                account_id,
            } => (recovery_id, account_id),
            _ => return Err(corrupt()),
        };
        if recovery_id != &self.recovery_id
            || account_id != &self.account_id
            || binary.is_some() != matches!(request, Request::StageRowChunk { .. })
        {
            return Err(corrupt());
        }
        match request {
            Request::StageExpectedRow { row, .. } => {
                count_bound(self.expected)?;
                if row.record_id.is_empty()
                    || row.record_id.len() > ID_BYTES
                    || row.payload_sha256.len() != 64
                    || !row
                        .payload_sha256
                        .bytes()
                        .all(|value| value.is_ascii_digit() || (b'a'..=b'f').contains(&value))
                {
                    return Err(corrupt());
                }
                self.connection
                    .execute(
                        "INSERT INTO recovery_expected VALUES(?1,?2,?3)",
                        params![
                            crate::replica::sqlite::encode_store(row.store),
                            row.record_id,
                            row.payload_sha256
                        ],
                    )
                    .map_err(storage_error)?;
                self.expected += 1;
                Ok(Reply::ExpectedRowStaged)
            }
            Request::StageRowStart {
                store,
                record_id,
                payload_byte_length,
                ..
            } => {
                count_bound(self.staged)?;
                if *payload_byte_length as usize > RECORD_BYTES {
                    return Err(super::super::limits::exceeded(RecoveryBound::RecordBytes));
                }
                if self.building.is_some() || record_id.is_empty() || record_id.len() > ID_BYTES {
                    return Err(corrupt());
                }
                self.connection
                    .execute(
                        "INSERT INTO recovery_rows(store,record_id,byte_length) VALUES(?1,?2,?3)",
                        params![
                            crate::replica::sqlite::encode_store(*store),
                            record_id,
                            payload_byte_length
                        ],
                    )
                    .map_err(storage_error)?;
                self.building = Some(Building {
                    store: *store,
                    record_id: record_id.clone(),
                    length: *payload_byte_length as usize,
                    bytes: 0,
                    chunks: 0,
                });
                Ok(Reply::RowStarted)
            }
            Request::StageRowChunk { .. } => {
                let bytes = binary.ok_or_else(corrupt)?;
                if bytes.len() > CHUNK_BYTES {
                    return Err(super::super::limits::exceeded(RecoveryBound::ChunkBytes));
                }
                let building = self.building.as_mut().ok_or_else(corrupt)?;
                if bytes.is_empty() || building.bytes + bytes.len() > building.length {
                    return Err(corrupt());
                }
                let total = self
                    .total
                    .checked_add(bytes.len() as u64)
                    .ok_or_else(corrupt)?;
                if total > bittery_crypto_core::replica_recovery::RECOVERY_MAX_PLAINTEXT_BYTES {
                    return Err(super::super::limits::exceeded(RecoveryBound::ArchiveBytes));
                }
                self.connection
                    .execute(
                        "INSERT INTO recovery_chunks VALUES(?1,?2,?3,?4)",
                        params![
                            crate::replica::sqlite::encode_store(building.store),
                            building.record_id,
                            building.chunks,
                            bytes
                        ],
                    )
                    .map_err(storage_error)?;
                building.bytes += bytes.len();
                building.chunks += 1;
                self.total = total;
                Ok(Reply::RowChunkStaged)
            }
            Request::StageRowEnd { .. } => {
                let building = self.building.as_ref().ok_or_else(corrupt)?;
                if building.bytes != building.length {
                    return Err(corrupt());
                }
                self.connection
                    .execute(
                        "UPDATE recovery_rows SET complete=1 WHERE store=?1 AND record_id=?2",
                        params![
                            crate::replica::sqlite::encode_store(building.store),
                            building.record_id
                        ],
                    )
                    .map_err(storage_error)?;
                self.building = None;
                self.staged += 1;
                Ok(Reply::RowEnded)
            }
            Request::CommitRepair {
                expected_head_json,
                next_head,
                expected_row_count,
                staged_row_count,
                ..
            } => self.commit(
                expected_head_json,
                next_head,
                *expected_row_count,
                *staged_row_count,
                cancellation,
            ),
            Request::DiscardRepairStage { .. } => Ok(Reply::RepairStageDiscarded),
            _ => Err(corrupt()),
        }
    }
    fn commit(
        &mut self,
        expected_head: &str,
        next: &ReplicaHead,
        expected_count: u32,
        staged_count: u32,
        cancellation: &crate::RequestCancellation,
    ) -> Result<Reply, RuntimeError> {
        if self.building.is_some() || self.expected != expected_count || self.staged != staged_count
        {
            return Err(corrupt());
        }
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(storage_error)?;
        let current = transaction
            .query_row(
                "SELECT * FROM replica_heads WHERE account_id=?1",
                [&self.account_id],
                |row| Ok(records::map_record(&transaction, 0, &self.account_id, row)),
            )
            .optional()
            .map_err(storage_error)?
            .transpose()?;
        let Some((Record::RawReplicaHead { payload_json, .. }, None)) = current else {
            return Ok(Reply::Stale);
        };
        if payload_json != expected_head {
            return Ok(Reply::Stale);
        }
        let current: ReplicaHead = serde_json::from_str(&payload_json).map_err(|_| corrupt())?;
        if current.user_id.is_empty()
            || current.incarnation.as_str().is_empty()
            || next.account_id.as_str() != self.account_id
            || next.user_id != current.user_id
            || next.incarnation != current.incarnation
            || next.replica_revision <= current.replica_revision
            || next.lock_epoch <= current.lock_epoch
        {
            return Err(corrupt());
        }
        let mut actual = 0u32;
        {
            let mut statement=transaction.prepare("SELECT r.payload_json,e.payload_sha256 FROM replica_rows r LEFT JOIN recovery_expected e ON e.store=r.store AND e.record_id=r.record_id WHERE r.account_id=?1 ORDER BY r.store,r.record_id").map_err(storage_error)?;
            let mut rows = statement.query([&self.account_id]).map_err(storage_error)?;
            while let Some(row) = rows.next().map_err(storage_error)? {
                check_cancel(cancellation)?;
                let payload =
                    bounded_text(row, "payload_json", RECORD_BYTES).map_err(storage_error)??;
                let digest: Option<String> = row.get("payload_sha256").map_err(storage_error)?;
                if digest.as_deref()
                    != Some(format!("{:x}", Sha256::digest(payload.as_bytes())).as_str())
                {
                    return Ok(Reply::Stale);
                }
                actual = actual.checked_add(1).ok_or_else(corrupt)?;
            }
        }
        if actual != expected_count {
            return Ok(Reply::Stale);
        }
        transaction
            .execute(
                "DELETE FROM replica_rows WHERE account_id=?1",
                [&self.account_id],
            )
            .map_err(storage_error)?;
        let mut installed = 0u32;
        {
            let mut statement=transaction.prepare("SELECT store,record_id,byte_length,complete FROM recovery_rows ORDER BY store,record_id").map_err(storage_error)?;
            let mut rows = statement.query([]).map_err(storage_error)?;
            while let Some(row) = rows.next().map_err(storage_error)? {
                check_cancel(cancellation)?;
                let store: i64 = row.get("store").map_err(storage_error)?;
                crate::replica::sqlite::decode_store(store)?;
                let id = text(row, "record_id")?;
                let length =
                    usize::try_from(integer(row, "byte_length")?).map_err(|_| corrupt())?;
                if length > RECORD_BYTES || integer(row, "complete")? != 1 {
                    return Err(corrupt());
                }
                let mut payload = zeroize::Zeroizing::new(Vec::with_capacity(length));
                let mut chunks=transaction.prepare("SELECT chunk_index,bytes FROM recovery_chunks WHERE store=?1 AND record_id=?2 ORDER BY chunk_index").map_err(storage_error)?;
                let mut chunks = chunks.query(params![store, id]).map_err(storage_error)?;
                let mut index = 0u64;
                while let Some(chunk) = chunks.next().map_err(storage_error)? {
                    check_cancel(cancellation)?;
                    let bytes = zeroize::Zeroizing::new(binary_value(chunk)?);
                    if integer(chunk, "chunk_index")? != index
                        || payload.len() + bytes.len() > length
                    {
                        return Err(corrupt());
                    }
                    payload.extend_from_slice(&bytes);
                    index += 1;
                }
                if payload.len() != length {
                    return Err(corrupt());
                }
                let text = std::str::from_utf8(&payload).map_err(|_| corrupt())?;
                transaction
                    .execute(
                        "INSERT INTO replica_rows VALUES(?1,?2,?3,?4)",
                        params![self.account_id, store, id, text],
                    )
                    .map_err(storage_error)?;
                installed += 1;
            }
        }
        if installed != staged_count {
            return Err(corrupt());
        }
        crate::replica::sqlite::put_head(&transaction, next)?;
        check_cancel(cancellation)?;
        transaction.commit().map_err(storage_error)?;
        Ok(Reply::Repaired)
    }
}
fn binary_value(row: &Row<'_>) -> Result<Vec<u8>, RuntimeError> {
    super::binary(row, "bytes")
}
fn count_bound(count: u32) -> Result<(), RuntimeError> {
    if count as usize >= super::super::archive::MAX_RECORDS {
        Err(super::super::limits::exceeded(RecoveryBound::RecordCount))
    } else {
        Ok(())
    }
}

fn check_cancel(cancellation: &crate::RequestCancellation) -> Result<(), RuntimeError> {
    if cancellation.is_cancelled() {
        Err(RuntimeError::new(
            RuntimeErrorCode::Cancelled,
            "Recovery cancelled",
        ))
    } else {
        Ok(())
    }
}
