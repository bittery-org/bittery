use super::*;
use rusqlite::{params, Connection, OptionalExtension};
use std::path::Path;

const SCHEMA: &str = r#"
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
    #[cfg(test)]
    failure: Option<(SqliteVaultImageFailure, usize)>,
}
impl SqliteVaultImageArtifactStore {
    pub fn open(path: impl AsRef<Path>) -> Result<Self, RuntimeError> {
        let connection = Connection::open(path).map_err(sqlite_error)?;
        connection
            .execute_batch("PRAGMA foreign_keys=ON;")
            .map_err(sqlite_error)?;
        connection.execute_batch(SCHEMA).map_err(sqlite_error)?;
        Ok(Self {
            connection: Mutex::new(connection),
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
        connection.query_row("SELECT vault_id,byte_length,content_type,sha256 FROM vault_image_artifacts WHERE account_id=?1 AND operation_id=?2 AND published=1",params![scope.account_id().as_str(),scope.operation_id()],|row|Ok((row.get::<_,String>(0)?,row.get::<_,i64>(1)?,row.get::<_,String>(2)?,row.get::<_,String>(3)?))).optional().map_err(sqlite_error)?.map(|(vault,length,content,digest)|VaultImageArtifactMetadata::new(scope.clone(),vault,u64::try_from(length).map_err(|_|invariant("Vault image SQLite length is invalid"))?,content,digest)).transpose()
    }
}

#[async_trait]
impl VaultImageArtifactPort for SqliteVaultImageArtifactStore {
    async fn begin(&self, scope: &VaultImageArtifactScope) -> Result<(), RuntimeError> {
        #[cfg(test)]
        self.fail(SqliteVaultImageFailure::Begin, 1)?;
        let mut connection = self
            .connection
            .lock()
            .expect("Vault image SQLite lock poisoned");
        let transaction = connection.transaction().map_err(sqlite_error)?;
        transaction.execute("INSERT OR IGNORE INTO vault_image_artifacts(account_id,operation_id) VALUES(?1,?2)",params![scope.account_id().as_str(),scope.operation_id()]).map_err(sqlite_error)?;
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
        let published:Option<i64>=transaction.query_row("SELECT published FROM vault_image_artifacts WHERE account_id=?1 AND operation_id=?2",params![scope.account_id().as_str(),scope.operation_id()],|row|row.get(0)).optional().map_err(sqlite_error)?;
        if published.is_none() {
            return Err(invariant("Vault image artifact was not begun"));
        }
        if published == Some(1) {
            return Err(invariant("Published Vault image artifact is immutable"));
        }
        let existing:Option<Vec<u8>>=transaction.query_row("SELECT plaintext FROM vault_image_artifact_chunks WHERE account_id=?1 AND operation_id=?2 AND chunk_index=?3",params![scope.account_id().as_str(),scope.operation_id(),index],|row|row.get(0)).optional().map_err(sqlite_error)?;
        if let Some(existing) = existing {
            let existing = Zeroizing::new(existing);
            return if existing.as_slice() == bytes {
                Ok(VaultImageChunkWrite::AlreadyStored)
            } else {
                Err(invariant("Vault image artifact chunk conflicts"))
            };
        }
        let count:i64=transaction.query_row("SELECT COUNT(*) FROM vault_image_artifact_chunks WHERE account_id=?1 AND operation_id=?2",params![scope.account_id().as_str(),scope.operation_id()],|row|row.get(0)).map_err(sqlite_error)?;
        if count != i64::from(index) {
            return Err(invariant("Vault image chunks must be contiguous"));
        }
        transaction.execute("INSERT INTO vault_image_artifact_chunks(account_id,operation_id,chunk_index,plaintext) VALUES(?1,?2,?3,?4)",params![scope.account_id().as_str(),scope.operation_id(),index,bytes]).map_err(sqlite_error)?;
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
        let mut statement=transaction.prepare("SELECT plaintext FROM vault_image_artifact_chunks WHERE account_id=?1 AND operation_id=?2 ORDER BY chunk_index").map_err(sqlite_error)?;
        let chunks = statement
            .query_map(
                params![metadata.account_id().as_str(), metadata.operation_id()],
                |row| row.get::<_, Vec<u8>>(0).map(Zeroizing::new),
            )
            .map_err(sqlite_error)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(sqlite_error)?;
        drop(statement);
        verify_chunks(metadata, &chunks)?;
        let changed=transaction.execute("UPDATE vault_image_artifacts SET vault_id=?3,byte_length=?4,content_type=?5,sha256=?6,published=1 WHERE account_id=?1 AND operation_id=?2 AND published=0",params![metadata.account_id().as_str(),metadata.operation_id(),metadata.vault_id(),i64::try_from(metadata.byte_length()).map_err(|_|invariant("Vault image length is invalid"))?,metadata.content_type(),metadata.sha256()]).map_err(sqlite_error)?;
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
        let loaded: Option<Vec<u8>> = connection.query_row("SELECT plaintext FROM vault_image_artifact_chunks WHERE account_id=?1 AND operation_id=?2 AND chunk_index=?3",params![metadata.account_id().as_str(),metadata.operation_id(),index],|row|row.get(0)).optional().map_err(sqlite_error)?;
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
        Ok(())
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
        Ok(())
    }
    async fn wipe(&self) -> Result<(), RuntimeError> {
        #[cfg(test)]
        self.fail(SqliteVaultImageFailure::Wipe, 1)?;
        let mut connection = self
            .connection
            .lock()
            .expect("Vault image SQLite lock poisoned");
        let transaction = connection.transaction().map_err(sqlite_error)?;
        transaction
            .execute("DELETE FROM vault_image_artifacts", [])
            .map_err(sqlite_error)?;
        #[cfg(test)]
        self.fail(SqliteVaultImageFailure::Wipe, 2)?;
        transaction.commit().map_err(sqlite_error)?;
        Ok(())
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
        Ok(())
    }
}
fn sqlite_error(_: rusqlite::Error) -> RuntimeError {
    invariant("Vault image SQLite persistence failed")
}
