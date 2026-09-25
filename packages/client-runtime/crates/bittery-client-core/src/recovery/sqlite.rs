//! Native physical recovery access. Archive interpretation and repair policy stay in Core's
//! existing recovery pipeline; this adapter only preserves fixed SQLite records.

use super::control::{
    RecoveryControlResponse as Reply, RecoveryPhysicalSchemas, RecoveryRecord as Record,
    RecoveryUnavailableReason,
};
use crate::{RecoveryBound, RuntimeError, RuntimeErrorCode};
use rusqlite::{
    params, params_from_iter, types::Value, Connection, OpenFlags, OptionalExtension, Row,
};
use std::path::{Path, PathBuf};

use crate::sqlite_schema::validate as validate_schema;

mod records;
mod repair;
mod restore;

use super::limits::{MAX_RECORD_BYTES as RECORD_BYTES, RECOVERY_CHUNK_BYTES as CHUNK_BYTES};
const ID_BYTES: usize = 4096;
type Answer = (Reply, Option<Vec<u8>>);

/// Fixed existing SQLite storage family, opened only after the host acquires exclusive device
/// maintenance and Core has retired normal work. Opening never creates, migrates or repairs files.
/// The handle must be dropped before releasing that exclusive host lease.
pub struct SqliteRecoveryStorage {
    databases: [Connection; 3],
    replica_path: PathBuf,
    artifact_paths: [PathBuf; 2],
    vault_images_version: u32,
    repair: Option<repair::RepairStage>,
    accounts: Cursor,
    records: Cursor,
}

#[derive(Default)]
struct Cursor {
    table: usize,
    key: Vec<Value>,
    account: Option<String>,
    next: Option<String>,
    generation: u64,
    sequence: u64,
}
impl Cursor {
    fn begin(&mut self, account: Option<&str>, supplied: Option<&str>) -> Result<(), RuntimeError> {
        if let Some(supplied) = supplied {
            if supplied.len() > ID_BYTES
                || self.next.as_deref() != Some(supplied)
                || self.account.as_deref() != account
            {
                return Err(corrupt());
            }
        } else {
            self.table = 0;
            self.key.clear();
            self.account = account.map(str::to_owned);
            self.next = None;
            self.generation = self.generation.checked_add(1).ok_or_else(corrupt)?;
            self.sequence = 0;
        }
        Ok(())
    }
    fn advance(
        &mut self,
        key: Vec<Value>,
        supplied: Option<&str>,
    ) -> Result<(String, String), RuntimeError> {
        let current = supplied
            .map(str::to_owned)
            .unwrap_or_else(|| format!("{}:0", self.generation));
        self.sequence = self.sequence.checked_add(1).ok_or_else(corrupt)?;
        let next = format!("{}:{}", self.generation, self.sequence);
        self.next = Some(next.clone());
        self.key = key;
        Ok((current, next))
    }
    fn next_table(&mut self) {
        self.table += 1;
        self.key.clear();
    }
}

struct Table {
    database: usize,
    name: &'static str,
    keys: &'static [&'static str],
}
const TABLES: &[Table] = &[
    Table {
        database: 0,
        name: "replica_heads",
        keys: &["account_id"],
    },
    Table {
        database: 0,
        name: "replica_rows",
        keys: &["store", "record_id"],
    },
    Table {
        database: 1,
        name: "attachment_move_artifacts",
        keys: &["artifact_id"],
    },
    Table {
        database: 1,
        name: "attachment_move_artifact_chunks",
        keys: &["artifact_id", "chunk_index"],
    },
    Table {
        database: 1,
        name: "attachment_move_provisional_artifacts",
        keys: &[
            "operation_id",
            "attachment_id",
            "generation",
            "source_artifact_id",
        ],
    },
    Table {
        database: 1,
        name: "attachment_move_provisional_chunks",
        keys: &["operation_id", "attachment_id", "generation", "chunk_index"],
    },
    Table {
        database: 2,
        name: "vault_image_artifacts",
        keys: &["operation_id", "publication_id"],
    },
    Table {
        database: 2,
        name: "vault_image_artifact_chunks",
        keys: &["operation_id", "publication_id", "chunk_index"],
    },
];

// A newer current writer does not own old published generations. Their durable published mapping
// retains all metadata needed to describe their physical chunks without inventing a new table.
const PROVISIONAL_RECORDS: &str = r#"(
 SELECT p.account_id,p.operation_id,p.attachment_id,p.generation,p.publication_state,
        p.ciphertext_sha256,p.byte_length,1 AS current,'' AS source_artifact_id
 FROM attachment_move_provisional_artifacts p
 UNION ALL
 SELECT a.account_id,a.operation_id,a.attachment_id,a.physical_generation AS generation,
        2 AS publication_state,a.ciphertext_sha256,a.byte_length,0 AS current,a.artifact_id AS source_artifact_id
 FROM attachment_move_artifacts a
 WHERE a.publication_state=2 AND a.physical_generation IS NOT NULL
 AND NOT EXISTS(SELECT 1 FROM attachment_move_provisional_artifacts p
                WHERE p.account_id=a.account_id AND p.operation_id=a.operation_id
                AND p.attachment_id=a.attachment_id AND p.generation=a.physical_generation)
)"#;

impl SqliteRecoveryStorage {
    pub fn add_artifact(
        &mut self,
        account_id: &str,
        record: &Record,
        binary: Option<&[u8]>,
        cancellation: &crate::RequestCancellation,
    ) -> Result<Reply, RuntimeError> {
        let image = matches!(
            record,
            Record::VaultImageMetadata { .. }
                | Record::VaultImageChunk { .. }
                | Record::ProtectedVaultImageMetadata { .. }
                | Record::ProtectedVaultImageChunk { .. }
        );
        restore::add(
            &self.artifact_paths[usize::from(image)],
            account_id,
            record,
            binary,
            cancellation,
        )
    }

    pub fn execute_repair(
        &mut self,
        request: &super::control::RecoveryControlRequest,
        binary: Option<&[u8]>,
        cancellation: &crate::RequestCancellation,
    ) -> Result<Reply, RuntimeError> {
        use super::control::RecoveryControlRequest as Request;
        if cancellation.is_cancelled() && !matches!(request, Request::DiscardRepairStage { .. }) {
            return Err(RuntimeError::new(
                RuntimeErrorCode::Cancelled,
                "Recovery cancelled",
            ));
        }
        if let Request::BeginRepairStage {
            recovery_id,
            account_id,
        } = request
        {
            if binary.is_some() {
                return Err(corrupt());
            }
            self.repair = Some(repair::RepairStage::begin(
                &self.replica_path,
                recovery_id,
                account_id,
            )?);
            return Ok(Reply::RepairStageBegun);
        }
        let result =
            self.repair
                .as_mut()
                .ok_or_else(corrupt)?
                .execute(request, binary, cancellation)?;
        if matches!(result, Reply::Repaired | Reply::RepairStageDiscarded) {
            self.repair = None;
        }
        Ok(result)
    }

    pub fn open(
        replica: impl AsRef<Path>,
        attachments: impl AsRef<Path>,
        images: impl AsRef<Path>,
    ) -> Result<Self, RecoveryUnavailableReason> {
        let replica_path_owned = replica.as_ref().to_path_buf();
        let artifact_paths = [
            attachments.as_ref().to_path_buf(),
            images.as_ref().to_path_buf(),
        ];
        let open = |path: &Path| {
            Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)
                .map_err(|_| RecoveryUnavailableReason::StorageUnavailable)
        };
        let databases = [
            open(replica.as_ref())?,
            open(attachments.as_ref())?,
            open(images.as_ref())?,
        ];
        let replica = &databases[0];
        let identity: i32 = replica
            .pragma_query_value(None, "application_id", |row| row.get(0))
            .map_err(|_| RecoveryUnavailableReason::StorageUnavailable)?;
        let version: i32 = replica
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .map_err(|_| RecoveryUnavailableReason::StorageUnavailable)?;
        if identity != crate::replica::sqlite::APPLICATION_ID
            || version != crate::replica::sqlite::PHYSICAL_VERSION
        {
            return Err(RecoveryUnavailableReason::UnsupportedSchema);
        }
        validate_schema(replica, &crate::replica::sqlite::MIGRATION_1.join("\n"))?;
        crate::attachment_artifact_store::sqlite::validate_recovery_schema(&databases[1])?;
        let vault_images_version = crate::vault_image::sqlite::recovery_schema(&databases[2])?;
        // The two artifact engines have historically used exact unversioned schemas. Report the
        // native adapter's known layout generation rather than pretending these are Web versions.
        for database in &databases[1..] {
            let version: i32 = database
                .pragma_query_value(None, "user_version", |row| row.get(0))
                .map_err(|_| RecoveryUnavailableReason::StorageUnavailable)?;
            let identity: i32 = database
                .pragma_query_value(None, "application_id", |row| row.get(0))
                .map_err(|_| RecoveryUnavailableReason::StorageUnavailable)?;
            if version != 0 || identity != 0 {
                return Err(RecoveryUnavailableReason::UnsupportedSchema);
            }
        }
        Ok(Self {
            databases,
            replica_path: replica_path_owned,
            artifact_paths,
            vault_images_version,
            repair: None,
            accounts: Cursor::default(),
            records: Cursor::default(),
        })
    }

    pub fn physical_schemas(&self) -> RecoveryPhysicalSchemas {
        RecoveryPhysicalSchemas {
            replica_version: crate::replica::sqlite::PHYSICAL_VERSION as u32,
            attachment_artifacts_version: 1,
            vault_images_version: self.vault_images_version,
        }
    }

    /// Physical identities include Accounts represented only by retained artifact bytes.
    pub fn list_accounts(&mut self, cursor: Option<&str>) -> Result<Answer, RuntimeError> {
        self.accounts.begin(None, cursor)?;
        while let Some(table) = TABLES.get(self.accounts.table) {
            let connection = &self.databases[table.database];
            let after = self.accounts.key.first();
            let query = format!(
                "SELECT account_id FROM {} {} GROUP BY account_id ORDER BY account_id LIMIT 1",
                table.name,
                if after.is_some() {
                    "WHERE account_id > ?1"
                } else {
                    ""
                }
            );
            let account = connection
                .query_row(&query, params_from_iter(after), |row| {
                    bounded_text(row, "account_id", ID_BYTES)
                })
                .optional()
                .map_err(storage_error)?
                .transpose()?;
            if let Some(account_id) = account {
                if account_id.is_empty() {
                    return Err(corrupt());
                }
                let (cursor, next) = self
                    .accounts
                    .advance(vec![Value::Text(account_id.clone())], cursor)?;
                return Ok((
                    Reply::AccountEntry {
                        account_id,
                        cursor,
                        next_cursor: Some(next),
                    },
                    None,
                ));
            }
            self.accounts.next_table();
        }
        self.accounts.next = None;
        Ok((Reply::End, None))
    }

    /// One fixed physical row; a cursor is valid only for its immediately preceding Account scan.
    pub fn read_entry(
        &mut self,
        account_id: &str,
        cursor: Option<&str>,
    ) -> Result<Answer, RuntimeError> {
        if account_id.is_empty() || account_id.len() > ID_BYTES {
            return Err(corrupt());
        }
        self.records.begin(Some(account_id), cursor)?;
        while let Some(table) = TABLES.get(self.records.table) {
            let connection = &self.databases[table.database];
            let keys = table.keys.join(",");
            let after = if self.records.key.is_empty() {
                String::new()
            } else {
                format!(
                    "AND ({keys}) > ({})",
                    (2..2 + table.keys.len())
                        .map(|number| format!("?{number}"))
                        .collect::<Vec<_>>()
                        .join(",")
                )
            };
            let source = if self.records.table == 4 {
                PROVISIONAL_RECORDS
            } else if self.vault_images_version == 1 && self.records.table == 6 {
                "(SELECT *, '' AS publication_id, NULL AS protection_json FROM vault_image_artifacts)"
            } else if self.vault_images_version == 1 && self.records.table == 7 {
                "(SELECT *, '' AS publication_id FROM vault_image_artifact_chunks)"
            } else {
                table.name
            };
            let query = format!(
                "SELECT * FROM {} WHERE account_id=?1 {after} ORDER BY {keys} LIMIT 1",
                source
            );
            let values = std::iter::once(Value::Text(account_id.to_owned()))
                .chain(self.records.key.iter().cloned());
            let mut statement = connection.prepare(&query).map_err(storage_error)?;
            let mut rows = statement
                .query(params_from_iter(values))
                .map_err(storage_error)?;
            if let Some(row) = rows.next().map_err(storage_error)? {
                let mut key = Vec::with_capacity(table.keys.len());
                for column in table.keys {
                    key.push(bounded_value(row, column)?);
                }
                let (record, binary) =
                    records::map_record(connection, self.records.table, account_id, row)?;
                let (cursor, next) = self.records.advance(key, cursor)?;
                return Ok((
                    Reply::Entry {
                        cursor,
                        next_cursor: Some(next),
                        record,
                    },
                    binary,
                ));
            }
            self.records.next_table();
        }
        self.records.next = None;
        Ok((Reply::End, None))
    }
}

fn bounded_value(row: &Row<'_>, column: &str) -> Result<Value, RuntimeError> {
    let value = row.get_ref(column).map_err(storage_error)?;
    match value {
        rusqlite::types::ValueRef::Text(bytes) if bytes.len() <= ID_BYTES => Ok(Value::Text(
            std::str::from_utf8(bytes)
                .map_err(|_| corrupt())?
                .to_owned(),
        )),
        rusqlite::types::ValueRef::Integer(value) => Ok(Value::Integer(value)),
        _ => Err(corrupt()),
    }
}
fn bounded_text(
    row: &Row<'_>,
    column: &str,
    bound: usize,
) -> rusqlite::Result<Result<String, RuntimeError>> {
    Ok(match row.get_ref(column)? {
        rusqlite::types::ValueRef::Text(bytes) if bytes.len() <= bound => {
            std::str::from_utf8(bytes)
                .map(str::to_owned)
                .map_err(|_| corrupt())
        }
        rusqlite::types::ValueRef::Text(_) => {
            Err(super::limits::exceeded(RecoveryBound::RecordBytes))
        }
        _ => Err(corrupt()),
    })
}
fn text(row: &Row<'_>, column: &str) -> Result<String, RuntimeError> {
    bounded_text(row, column, RECORD_BYTES).map_err(storage_error)?
}
fn integer(row: &Row<'_>, column: &str) -> Result<u64, RuntimeError> {
    u64::try_from(row.get::<_, i64>(column).map_err(storage_error)?).map_err(|_| corrupt())
}
fn optional_text(row: &Row<'_>, column: &str) -> Result<Option<String>, RuntimeError> {
    if matches!(
        row.get_ref(column).map_err(storage_error)?,
        rusqlite::types::ValueRef::Null
    ) {
        Ok(None)
    } else {
        text(row, column).map(Some)
    }
}
fn binary(row: &Row<'_>, column: &str) -> Result<Vec<u8>, RuntimeError> {
    match row.get_ref(column).map_err(storage_error)? {
        rusqlite::types::ValueRef::Blob(bytes) if bytes.len() > CHUNK_BYTES => {
            Err(super::limits::exceeded(RecoveryBound::ChunkBytes))
        }
        rusqlite::types::ValueRef::Blob(bytes) if !bytes.is_empty() => Ok(bytes.to_vec()),
        _ => Err(corrupt()),
    }
}

fn storage_error(_: impl std::fmt::Display) -> RuntimeError {
    RuntimeError::new(
        RuntimeErrorCode::StorageUnavailable,
        "SQLite recovery storage is unavailable",
    )
}
fn corrupt() -> RuntimeError {
    RuntimeError::new(
        RuntimeErrorCode::InvariantViolation,
        "SQLite recovery record is malformed",
    )
}

#[cfg(test)]
mod tests;
