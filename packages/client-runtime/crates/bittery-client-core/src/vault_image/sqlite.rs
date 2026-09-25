use super::*;
use rusqlite::{params, Connection, OptionalExtension};
use std::path::Path;

pub(crate) const RAW_SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS vault_image_artifacts (
 account_id TEXT NOT NULL, operation_id TEXT NOT NULL, vault_id TEXT,
 byte_length INTEGER, content_type TEXT, sha256 TEXT, published INTEGER NOT NULL DEFAULT 0,
 PRIMARY KEY(account_id, operation_id)
);
CREATE TABLE IF NOT EXISTS vault_image_artifact_chunks (
 account_id TEXT NOT NULL, operation_id TEXT NOT NULL, chunk_index INTEGER NOT NULL,
 plaintext BLOB NOT NULL, PRIMARY KEY(account_id, operation_id, chunk_index),
 FOREIGN KEY(account_id, operation_id) REFERENCES vault_image_artifacts(account_id, operation_id) ON DELETE CASCADE
);
"#;

// The original plaintext column and raw generation retain their original meaning. Protected
// publications have a distinct identity and authenticated, versioned protection metadata.
pub(crate) const SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS vault_image_artifacts (
 account_id TEXT NOT NULL, operation_id TEXT NOT NULL, publication_id TEXT NOT NULL DEFAULT '',
 vault_id TEXT, byte_length INTEGER, content_type TEXT, sha256 TEXT,
 protection_json TEXT, published INTEGER NOT NULL DEFAULT 0,
 PRIMARY KEY(account_id, operation_id, publication_id)
);
CREATE TABLE IF NOT EXISTS vault_image_artifact_chunks (
 account_id TEXT NOT NULL, operation_id TEXT NOT NULL, publication_id TEXT NOT NULL DEFAULT '',
 chunk_index INTEGER NOT NULL, plaintext BLOB NOT NULL,
 PRIMARY KEY(account_id, operation_id, publication_id, chunk_index),
 FOREIGN KEY(account_id, operation_id, publication_id) REFERENCES vault_image_artifacts(account_id, operation_id, publication_id) ON DELETE CASCADE
);
"#;
const PROTECTION_METADATA_BYTES: usize = 8192;

/// Read-only physical recovery admission; Core validates raw and protected record semantics.
pub(crate) fn recovery_schema(
    connection: &Connection,
) -> Result<u32, crate::RecoveryUnavailableReason> {
    if crate::sqlite_schema::validate(connection, RAW_SCHEMA).is_ok() {
        return Ok(1);
    }
    crate::sqlite_schema::validate(connection, SCHEMA)?;
    Ok(2)
}

#[cfg(test)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum SqliteVaultImageFailure {
    Begin,
    WriteChunk,
    Publish,
    Delete,
    DeleteAccount,
    Wipe,
    Sweep,
}
pub struct SqliteVaultImageArtifactStore {
    connection: Mutex<Connection>,
    inventory_nonce: String,
    #[cfg(test)]
    failure: Option<(SqliteVaultImageFailure, usize)>,
}
impl SqliteVaultImageArtifactStore {
    pub fn open(path: impl AsRef<Path>) -> Result<Self, RuntimeError> {
        let mut connection = Connection::open(path).map_err(sqlite_error)?;
        crate::sqlite_schema::admit_unversioned(&connection, SCHEMA, &[RAW_SCHEMA]).map_err(
            |_| {
                RuntimeError::new(
                    RuntimeErrorCode::StorageUnavailable,
                    "Vault image artifact schema is unsupported",
                )
            },
        )?;
        connection
            .execute_batch(
                "PRAGMA foreign_keys=ON; PRAGMA secure_delete=ON; PRAGMA journal_size_limit=0;",
            )
            .map_err(sqlite_error)?;
        if crate::sqlite_schema::validate(&connection, RAW_SCHEMA).is_ok() {
            // Preserve raw rows and bytes in one transaction. No intermediate schema is admitted.
            let transaction = connection.transaction().map_err(sqlite_error)?;
            transaction
                .execute_batch(
                    "ALTER TABLE vault_image_artifact_chunks RENAME TO old_image_chunks;
                ALTER TABLE vault_image_artifacts RENAME TO old_image_artifacts;",
                )
                .map_err(sqlite_error)?;
            transaction.execute_batch(SCHEMA).map_err(sqlite_error)?;
            transaction.execute_batch("INSERT INTO vault_image_artifacts(account_id,operation_id,vault_id,byte_length,content_type,sha256,published)
                SELECT account_id,operation_id,vault_id,byte_length,content_type,sha256,published FROM old_image_artifacts;
                INSERT INTO vault_image_artifact_chunks(account_id,operation_id,chunk_index,plaintext)
                SELECT account_id,operation_id,chunk_index,plaintext FROM old_image_chunks;
                DROP TABLE old_image_chunks;
                DROP TABLE old_image_artifacts;").map_err(sqlite_error)?;
            transaction.commit().map_err(sqlite_error)?;
        } else {
            connection.execute_batch(SCHEMA).map_err(sqlite_error)?;
        }
        Ok(Self {
            connection: Mutex::new(connection),
            inventory_nonce: bittery_crypto_core::generate_uuid(),
            #[cfg(test)]
            failure: None,
        })
    }
    #[cfg(test)]
    pub(crate) fn open_failing(
        path: impl AsRef<Path>,
        operation: SqliteVaultImageFailure,
        boundary: usize,
    ) -> Result<Self, RuntimeError> {
        let mut store = Self::open(path)?;
        store.failure = Some((operation, boundary));
        Ok(store)
    }
    #[cfg(test)]
    fn fail(
        &self,
        operation: SqliteVaultImageFailure,
        boundary: usize,
    ) -> Result<(), RuntimeError> {
        if self.failure == Some((operation, boundary)) {
            Err(invariant("Injected Vault image SQLite failure"))
        } else {
            Ok(())
        }
    }
    fn metadata(
        &self,
        scope: &VaultImageArtifactScope,
    ) -> Result<Option<VaultImageArtifactMetadata>, RuntimeError> {
        let connection = self
            .connection
            .lock()
            .expect("Vault image SQLite lock poisoned");
        let row = connection.query_row(
            "SELECT vault_id,byte_length,content_type,sha256,protection_json FROM vault_image_artifacts WHERE account_id=?1 AND operation_id=?2 AND publication_id=?3 AND published=1",
            params![scope.account_id().as_str(), scope.operation_id(), scope.publication_id().unwrap_or("")],
            |row| {
                // Bound serialized metadata before allocating it from a corrupt physical row.
                let protection = row.get_ref(4)?;
                let protection = match protection {
                    rusqlite::types::ValueRef::Null => None,
                    rusqlite::types::ValueRef::Text(bytes) if bytes.len() <= PROTECTION_METADATA_BYTES => Some(bytes.to_vec()),
                    _ => return Err(rusqlite::Error::InvalidQuery),
                };
                Ok((row.get::<_,String>(0)?,row.get::<_,i64>(1)?,row.get::<_,String>(2)?,row.get::<_,String>(3)?,protection))
            }).optional().map_err(sqlite_error)?;
        row.map(|(vault, length, content, digest, protection)| {
            let raw = VaultImageArtifactMetadata::new(
                VaultImageArtifactScope::new(scope.account_id().clone(), scope.operation_id())?,
                vault,
                u64::try_from(length)
                    .map_err(|_| invariant("Vault image SQLite length is invalid"))?,
                content,
                digest,
            )?;
            let metadata = match protection {
                Some(bytes) => raw.with_protection(
                    serde_json::from_slice(&bytes)
                        .map_err(|_| invariant("Vault image protection metadata is invalid"))?,
                )?,
                None => raw,
            };
            if metadata.scope() != scope {
                return Err(invariant("Vault image publication identity conflicts"));
            }
            Ok(metadata)
        })
        .transpose()
    }
}

#[async_trait]
impl VaultImageArtifactPort for SqliteVaultImageArtifactStore {
    async fn inventory_page(
        &self,
        cursor: Option<&str>,
    ) -> Result<VaultImageInventoryPage, RuntimeError> {
        let after = inventory::decode_cursor(&self.inventory_nonce, cursor)?;
        let mut connection = self
            .connection
            .lock()
            .expect("Vault image SQLite lock poisoned");
        let transaction = connection.transaction().map_err(sqlite_error)?;
        let identity: i32 = transaction
            .pragma_query_value(None, "application_id", |row| row.get(0))
            .map_err(sqlite_error)?;
        let version: i32 = transaction
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .map_err(sqlite_error)?;
        if identity != 0 || version != 0 {
            return Err(inventory::invalid(
                "Vault image inventory schema is unsupported",
            ));
        }
        // The existing normal constructor upgrades known raw files before exposing this owner.
        // Inventory itself only validates the current layout and never migrates or stamps it.
        crate::sqlite_schema::validate(&transaction, SCHEMA)
            .map_err(|_| inventory::invalid("Vault image inventory schema is unsupported"))?;
        let mut page = inventory::PageBuilder::new(&self.inventory_nonce, after.as_ref());
        // Both physical tables are independent evidence. A metadata join, Account filter, or
        // published-only scan would omit orphan chunks, raw images, and incomplete generations.
        for (chunks, query) in [
            (
                false,
                "SELECT account_id, operation_id, publication_id FROM vault_image_artifacts ORDER BY account_id COLLATE BINARY, operation_id COLLATE BINARY, publication_id COLLATE BINARY",
            ),
            (
                true,
                "SELECT account_id, operation_id, publication_id, chunk_index FROM vault_image_artifact_chunks ORDER BY account_id COLLATE BINARY, operation_id COLLATE BINARY, publication_id COLLATE BINARY, chunk_index",
            ),
        ] {
            let mut statement = transaction.prepare(query).map_err(sqlite_error)?;
            let mut rows = statement.query([]).map_err(sqlite_error)?;
            while let Some(row) = rows.next().map_err(sqlite_error)? {
                // Check raw types before applying the continuation, including skipped prefixes.
                let account_id = inventory_text(row, 0, false)?.into();
                let operation_id = inventory_text(row, 1, false)?;
                let publication_id = inventory_text(row, 2, true)?;
                let key = if chunks {
                    VaultImagePhysicalKey::Chunk {
                        account_id,
                        operation_id,
                        publication_id,
                        chunk_index: inventory_chunk_index(row, 3)?,
                    }
                } else {
                    VaultImagePhysicalKey::Metadata {
                        account_id,
                        operation_id,
                        publication_id,
                    }
                };
                if !page.push(key)? {
                    return page.finish(true);
                }
            }
        }
        page.finish(false)
    }

    async fn read_generation(
        &self,
        family: &VaultImageArtifactScope,
        after_publication_id: Option<&str>,
    ) -> Result<Option<VaultImageArtifactGeneration>, RuntimeError> {
        if let Some(after) = after_publication_id.filter(|value| !value.is_empty()) {
            validate_identity(after, "Image publication cursor")?;
        }
        let publication: Option<String> = {
            let connection = self
                .connection
                .lock()
                .expect("Vault image SQLite lock poisoned");
            connection.query_row("SELECT publication_id,published FROM vault_image_artifacts WHERE account_id=?1 AND operation_id=?2 AND (?3 IS NULL OR publication_id>?3) ORDER BY publication_id LIMIT 1",
                params![family.account_id().as_str(),family.operation_id(),after_publication_id],|row| {
                    if !matches!(row.get::<_,i64>(1)?,0|1) {return Err(rusqlite::Error::InvalidQuery);}
                    let raw = row.get_ref(0)?.as_str()?;
                    if raw.len()>128 { return Err(rusqlite::Error::InvalidQuery); }
                    Ok(raw.to_owned())
                }).optional().map_err(sqlite_error)?
        };
        publication
            .map(|publication| {
                let raw = VaultImageArtifactScope::new(
                    family.account_id().clone(),
                    family.operation_id(),
                )?;
                let scope = if publication.is_empty() {
                    raw
                } else {
                    raw.for_publication(&publication)?
                };
                let metadata = self.metadata(&scope)?;
                Ok(VaultImageArtifactGeneration { scope, metadata })
            })
            .transpose()
    }

    async fn delete_generation(&self, scope: &VaultImageArtifactScope) -> Result<(), RuntimeError> {
        let mut connection = self
            .connection
            .lock()
            .expect("Vault image SQLite lock poisoned");
        let transaction = connection.transaction().map_err(sqlite_error)?;
        transaction.execute("DELETE FROM vault_image_artifacts WHERE account_id=?1 AND operation_id=?2 AND publication_id=?3",params![scope.account_id().as_str(),scope.operation_id(),scope.publication_id().unwrap_or("")]).map_err(sqlite_error)?;
        transaction.commit().map_err(sqlite_error)?;
        finalize_deletion(&connection)
    }

    async fn begin(&self, scope: &VaultImageArtifactScope) -> Result<(), RuntimeError> {
        #[cfg(test)]
        self.fail(SqliteVaultImageFailure::Begin, 1)?;
        let mut connection = self
            .connection
            .lock()
            .expect("Vault image SQLite lock poisoned");
        let transaction = connection.transaction().map_err(sqlite_error)?;
        transaction.execute("INSERT OR IGNORE INTO vault_image_artifacts(account_id,operation_id,publication_id) VALUES(?1,?2,?3)",params![scope.account_id().as_str(),scope.operation_id(),scope.publication_id().unwrap_or("")]).map_err(sqlite_error)?;
        #[cfg(test)]
        self.fail(SqliteVaultImageFailure::Begin, 2)?;
        transaction.commit().map_err(sqlite_error)?;
        Ok(())
    }
    async fn write_chunk(
        &self,
        scope: &VaultImageArtifactScope,
        index: u32,
        bytes: &[u8],
    ) -> Result<VaultImageChunkWrite, RuntimeError> {
        if bytes.is_empty() || bytes.len() > VAULT_IMAGE_CHUNK_BYTES {
            return Err(invariant("Vault image artifact chunk is invalid"));
        }
        #[cfg(test)]
        self.fail(SqliteVaultImageFailure::WriteChunk, 1)?;
        let mut connection = self
            .connection
            .lock()
            .expect("Vault image SQLite lock poisoned");
        let transaction = connection.transaction().map_err(sqlite_error)?;
        let published:Option<i64>=transaction.query_row("SELECT published FROM vault_image_artifacts WHERE account_id=?1 AND operation_id=?2 AND publication_id=?3",params![scope.account_id().as_str(),scope.operation_id(),scope.publication_id().unwrap_or("")],|row|row.get(0)).optional().map_err(sqlite_error)?;
        if published.is_none() {
            return Err(invariant("Vault image artifact was not begun"));
        }
        if published == Some(1) {
            return Err(invariant("Published Vault image artifact is immutable"));
        }
        let existing:Option<Vec<u8>>=transaction.query_row("SELECT plaintext FROM vault_image_artifact_chunks WHERE account_id=?1 AND operation_id=?2 AND publication_id=?3 AND chunk_index=?4",params![scope.account_id().as_str(),scope.operation_id(),scope.publication_id().unwrap_or(""),index],|row|bounded_chunk(row,0)).optional().map_err(sqlite_error)?;
        if let Some(existing) = existing {
            let existing = Zeroizing::new(existing);
            return if existing.as_slice() == bytes {
                Ok(VaultImageChunkWrite::AlreadyStored)
            } else {
                Err(invariant("Vault image artifact chunk conflicts"))
            };
        }
        let count:i64=transaction.query_row("SELECT COUNT(*) FROM vault_image_artifact_chunks WHERE account_id=?1 AND operation_id=?2 AND publication_id=?3",params![scope.account_id().as_str(),scope.operation_id(),scope.publication_id().unwrap_or("")],|row|row.get(0)).map_err(sqlite_error)?;
        if count != i64::from(index) {
            return Err(invariant("Vault image chunks must be contiguous"));
        }
        transaction.execute("INSERT INTO vault_image_artifact_chunks(account_id,operation_id,publication_id,chunk_index,plaintext) VALUES(?1,?2,?3,?4,?5)",params![scope.account_id().as_str(),scope.operation_id(),scope.publication_id().unwrap_or(""),index,bytes]).map_err(sqlite_error)?;
        #[cfg(test)]
        self.fail(SqliteVaultImageFailure::WriteChunk, 2)?;
        transaction.commit().map_err(sqlite_error)?;
        Ok(VaultImageChunkWrite::Stored)
    }
    async fn publish(
        &self,
        metadata: &VaultImageArtifactMetadata,
    ) -> Result<VaultImagePublication, RuntimeError> {
        #[cfg(test)]
        self.fail(SqliteVaultImageFailure::Publish, 1)?;
        if let Some(existing) = self.metadata(metadata.scope())? {
            return if existing == *metadata {
                Ok(VaultImagePublication::AlreadyPublished)
            } else {
                Err(invariant("Vault image artifact publication conflicts"))
            };
        }
        let mut connection = self
            .connection
            .lock()
            .expect("Vault image SQLite lock poisoned");
        let transaction = connection.transaction().map_err(sqlite_error)?;
        let mut statement=transaction.prepare("SELECT plaintext FROM vault_image_artifact_chunks WHERE account_id=?1 AND operation_id=?2 AND publication_id=?3 ORDER BY chunk_index LIMIT ?4").map_err(sqlite_error)?;
        let maximum_chunks = metadata
            .byte_length()
            .div_ceil(if metadata.protection().is_some() {
                protected::PROTECTED_IMAGE_PLAINTEXT_CHUNK_BYTES as u64
            } else {
                VAULT_IMAGE_CHUNK_BYTES as u64
            });
        let chunks = statement
            .query_map(
                params![
                    metadata.account_id().as_str(),
                    metadata.operation_id(),
                    metadata.scope().publication_id().unwrap_or(""),
                    maximum_chunks as i64 + 1
                ],
                |row| bounded_chunk(row, 0).map(Zeroizing::new),
            )
            .map_err(sqlite_error)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(sqlite_error)?;
        drop(statement);
        verify_chunks(metadata, &chunks)?;
        let protection = metadata
            .protection()
            .map(serde_json::to_string)
            .transpose()
            .map_err(|_| invariant("Vault image protection metadata is invalid"))?;
        if protection
            .as_ref()
            .is_some_and(|value| value.len() > PROTECTION_METADATA_BYTES)
        {
            return Err(invariant("Vault image protection metadata is too large"));
        }
        let changed=transaction.execute("UPDATE vault_image_artifacts SET vault_id=?4,byte_length=?5,content_type=?6,sha256=?7,protection_json=?8,published=1 WHERE account_id=?1 AND operation_id=?2 AND publication_id=?3 AND published=0",params![metadata.account_id().as_str(),metadata.operation_id(),metadata.scope().publication_id().unwrap_or(""),metadata.vault_id(),i64::try_from(metadata.byte_length()).map_err(|_|invariant("Vault image length is invalid"))?,metadata.content_type(),metadata.sha256(),protection]).map_err(sqlite_error)?;
        #[cfg(test)]
        self.fail(SqliteVaultImageFailure::Publish, 2)?;
        if changed != 1 {
            return Err(invariant("Vault image artifact was not begun"));
        }
        transaction.commit().map_err(sqlite_error)?;
        Ok(VaultImagePublication::Published)
    }
    async fn read_chunk(
        &self,
        metadata: &VaultImageArtifactMetadata,
        index: u32,
    ) -> Result<Option<Vec<u8>>, RuntimeError> {
        match self.metadata(metadata.scope())? {
            None => return Ok(None),
            Some(existing) if existing != *metadata => {
                return Err(invariant("Vault image artifact metadata conflicts"));
            }
            Some(_) => {}
        }
        let connection = self
            .connection
            .lock()
            .expect("Vault image SQLite lock poisoned");
        let loaded: Option<Vec<u8>> = connection.query_row("SELECT plaintext FROM vault_image_artifact_chunks WHERE account_id=?1 AND operation_id=?2 AND publication_id=?3 AND chunk_index=?4",params![metadata.account_id().as_str(),metadata.operation_id(),metadata.scope().publication_id().unwrap_or(""),index],|row|bounded_chunk(row,0)).optional().map_err(sqlite_error)?;
        Ok(loaded.map(|bytes| {
            let mut owned = Zeroizing::new(bytes);
            std::mem::take(&mut *owned)
        }))
    }
    async fn delete(&self, scope: &VaultImageArtifactScope) -> Result<(), RuntimeError> {
        #[cfg(test)]
        self.fail(SqliteVaultImageFailure::Delete, 1)?;
        let mut connection = self
            .connection
            .lock()
            .expect("Vault image SQLite lock poisoned");
        let transaction = connection.transaction().map_err(sqlite_error)?;
        transaction
            .execute(
                "DELETE FROM vault_image_artifacts WHERE account_id=?1 AND operation_id=?2",
                params![scope.account_id().as_str(), scope.operation_id()],
            )
            .map_err(sqlite_error)?;
        #[cfg(test)]
        self.fail(SqliteVaultImageFailure::Delete, 2)?;
        transaction.commit().map_err(sqlite_error)?;
        finalize_deletion(&connection)
    }
    async fn delete_account(&self, account_id: &AccountId) -> Result<(), RuntimeError> {
        #[cfg(test)]
        self.fail(SqliteVaultImageFailure::DeleteAccount, 1)?;
        let mut connection = self
            .connection
            .lock()
            .expect("Vault image SQLite lock poisoned");
        let transaction = connection.transaction().map_err(sqlite_error)?;
        transaction
            .execute(
                "DELETE FROM vault_image_artifacts WHERE account_id=?1",
                params![account_id.as_str()],
            )
            .map_err(sqlite_error)?;
        #[cfg(test)]
        self.fail(SqliteVaultImageFailure::DeleteAccount, 2)?;
        transaction.commit().map_err(sqlite_error)?;
        finalize_deletion(&connection)
    }
    async fn wipe(&self) -> Result<(), RuntimeError> {
        #[cfg(test)]
        self.fail(SqliteVaultImageFailure::Wipe, 1)?;
        let mut connection = self
            .connection
            .lock()
            .expect("Vault image SQLite lock poisoned");
        let transaction = connection.transaction().map_err(sqlite_error)?;
        // Explicit Device Wipe must also remove chunks whose parent was lost or malformed.
        transaction
            .execute("DELETE FROM vault_image_artifact_chunks", [])
            .map_err(sqlite_error)?;
        transaction
            .execute("DELETE FROM vault_image_artifacts", [])
            .map_err(sqlite_error)?;
        #[cfg(test)]
        self.fail(SqliteVaultImageFailure::Wipe, 2)?;
        transaction.commit().map_err(sqlite_error)?;
        finalize_deletion(&connection)
    }
    async fn sweep_orphans(
        &self,
        account_id: &AccountId,
        refs: &HashSet<String>,
    ) -> Result<(), RuntimeError> {
        #[cfg(test)]
        self.fail(SqliteVaultImageFailure::Sweep, 1)?;
        let mut connection = self
            .connection
            .lock()
            .expect("Vault image SQLite lock poisoned");
        let transaction = connection.transaction().map_err(sqlite_error)?;
        let mut statement = transaction
            .prepare("SELECT operation_id FROM vault_image_artifacts WHERE account_id=?1")
            .map_err(sqlite_error)?;
        let ids = statement
            .query_map([account_id.as_str()], |row| row.get::<_, String>(0))
            .map_err(sqlite_error)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(sqlite_error)?;
        drop(statement);
        for id in ids {
            if !refs.contains(&id) {
                transaction
                    .execute(
                        "DELETE FROM vault_image_artifacts WHERE account_id=?1 AND operation_id=?2",
                        params![account_id.as_str(), id],
                    )
                    .map_err(sqlite_error)?;
            }
        }
        #[cfg(test)]
        self.fail(SqliteVaultImageFailure::Sweep, 2)?;
        transaction.commit().map_err(sqlite_error)?;
        finalize_deletion(&connection)
    }
}

/// Old raw writers may have left bytes in free pages or earlier WAL frames. Row absence alone
/// cannot acknowledge deletion: every retry repeats this finalization, including after a previous
/// DELETE committed. Core retains the existing cleanup duty until this primitive succeeds.
fn finalize_deletion(connection: &Connection) -> Result<(), RuntimeError> {
    let unavailable = || {
        RuntimeError::new(
            RuntimeErrorCode::StorageUnavailable,
            "Vault image deletion finalization is unavailable",
        )
    };
    connection
        .execute_batch("VACUUM;")
        .map_err(|_| unavailable())?;
    let (busy, frames, checkpointed): (i64, i64, i64) = connection
        .query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |row| {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?))
        })
        .map_err(|_| unavailable())?;
    // A non-WAL database returns (0,-1,-1). TRUNCATE returns (0,0,0) only after all readers
    // release the old WAL. A busy result is a failure, not successful partial reclamation.
    if !matches!((busy, frames, checkpointed), (0, 0, 0) | (0, -1, -1)) {
        return Err(unavailable());
    }
    Ok(())
}

fn inventory_text(
    row: &rusqlite::Row<'_>,
    index: usize,
    allow_empty: bool,
) -> Result<String, RuntimeError> {
    match row.get_ref(index).map_err(sqlite_error)? {
        rusqlite::types::ValueRef::Text(bytes) => {
            Ok(inventory::validate_text(bytes, allow_empty)?.to_owned())
        }
        _ => Err(inventory::invalid(
            "Vault image inventory key has an invalid type",
        )),
    }
}

fn inventory_chunk_index(row: &rusqlite::Row<'_>, index: usize) -> Result<u32, RuntimeError> {
    match row.get_ref(index).map_err(sqlite_error)? {
        rusqlite::types::ValueRef::Integer(value) => u32::try_from(value)
            .map_err(|_| inventory::invalid("Vault image inventory chunk index is invalid")),
        _ => Err(inventory::invalid(
            "Vault image inventory chunk index has an invalid type",
        )),
    }
}

fn sqlite_error(_: rusqlite::Error) -> RuntimeError {
    invariant("Vault image SQLite persistence failed")
}

/// SQLite lends the physical bytes so a corrupt length can be refused before allocation.
fn bounded_chunk(row: &rusqlite::Row<'_>, index: usize) -> rusqlite::Result<Vec<u8>> {
    match row.get_ref(index)? {
        rusqlite::types::ValueRef::Blob(bytes)
            if !bytes.is_empty() && bytes.len() <= VAULT_IMAGE_CHUNK_BYTES =>
        {
            Ok(bytes.to_vec())
        }
        _ => Err(rusqlite::Error::InvalidQuery),
    }
}
