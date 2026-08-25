use super::{
    artifact_error, ArtifactChunkWrite, ArtifactPublication, AttachmentArtifactOwner,
    AttachmentArtifactStore, AttachmentArtifactStoreRequest, AttachmentArtifactStoreResponse,
    ExclusiveStartupBoundary, PublishedArtifactChunk, ARTIFACT_CHUNK_BYTES,
};
use crate::{replica::attachment_move_artifact_ref, AccountId, RuntimeError, RuntimeErrorCode};
use async_trait::async_trait;
use rusqlite::{params, Connection, OptionalExtension, Transaction};
use sha2::{Digest, Sha256};
#[cfg(test)]
use std::sync::{Arc, Barrier};
use std::{collections::HashSet, io::Read, path::Path, sync::Mutex};

const SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS attachment_move_artifacts (
    account_id TEXT NOT NULL,
    artifact_id TEXT NOT NULL,
    operation_id TEXT NOT NULL,
    attachment_id TEXT NOT NULL,
    ciphertext_sha256 TEXT NOT NULL,
    byte_length INTEGER NOT NULL CHECK (byte_length > 0),
    chunk_count INTEGER NOT NULL CHECK (chunk_count > 0),
    publication_state INTEGER NOT NULL DEFAULT 0 CHECK (publication_state IN (0, 1, 2)),
    PRIMARY KEY (account_id, artifact_id)
);
CREATE TABLE IF NOT EXISTS attachment_move_artifact_chunks (
    account_id TEXT NOT NULL,
    artifact_id TEXT NOT NULL,
    chunk_index INTEGER NOT NULL CHECK (chunk_index >= 0),
    ciphertext BLOB NOT NULL,
    ciphertext_sha256 TEXT NOT NULL,
    PRIMARY KEY (account_id, artifact_id, chunk_index),
    FOREIGN KEY (account_id, artifact_id)
        REFERENCES attachment_move_artifacts(account_id, artifact_id) ON DELETE CASCADE
);
"#;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum SqliteFailureOperation {
    WriteChunk,
    Publish,
    DeleteAccount,
    SweepOrphans,
}

#[derive(Clone, Copy)]
struct InjectedFailure {
    operation: SqliteFailureOperation,
    boundary: usize,
}

/// Native SQLite `BLOB` implementation of the Rust-owned encrypted artifact protocol.
///
/// Each call holds one short transaction. Publication is a separate durable boundary after all
/// chunks have committed, so a restart sees either an incomplete artifact or a completely verified
/// one and never exposes the former to readers.
pub struct SqliteAttachmentArtifactStore {
    connection: Mutex<Connection>,
    injected_failure: Option<InjectedFailure>,
    #[cfg(test)]
    publish_barrier: Option<Arc<Barrier>>,
}

impl SqliteAttachmentArtifactStore {
    pub fn open(path: impl AsRef<Path>) -> Result<Self, RuntimeError> {
        Self::open_with_failure(path, None)
    }

    fn open_with_failure(
        path: impl AsRef<Path>,
        injected_failure: Option<InjectedFailure>,
    ) -> Result<Self, RuntimeError> {
        let connection = Connection::open(path).map_err(sqlite_error)?;
        connection
            .execute_batch("PRAGMA foreign_keys = ON;")
            .map_err(sqlite_error)?;
        connection.execute_batch(SCHEMA).map_err(sqlite_error)?;
        Ok(Self {
            connection: Mutex::new(connection),
            injected_failure,
            #[cfg(test)]
            publish_barrier: None,
        })
    }

    #[cfg(test)]
    pub(crate) fn open_failing_after(
        path: impl AsRef<Path>,
        operation: SqliteFailureOperation,
        boundary: usize,
    ) -> Result<Self, RuntimeError> {
        if boundary == 0 {
            return Err(artifact_error(
                "SQLite artifact failure boundary is invalid",
            ));
        }
        Self::open_with_failure(
            path,
            Some(InjectedFailure {
                operation,
                boundary,
            }),
        )
    }

    #[cfg(test)]
    pub(crate) fn open_with_publish_barrier(
        path: impl AsRef<Path>,
        barrier: Arc<Barrier>,
    ) -> Result<Self, RuntimeError> {
        let mut store = Self::open(path)?;
        store.publish_barrier = Some(barrier);
        Ok(store)
    }

    pub(crate) fn write_chunk(
        &self,
        owner: &AttachmentArtifactOwner,
        chunk_index: u32,
        bytes: &[u8],
    ) -> Result<ArtifactChunkWrite, RuntimeError> {
        let expected = ValidatedOwner::new(owner)?;
        let expected_length = expected.chunk_length(chunk_index)?;
        if bytes.len() != expected_length {
            return Err(artifact_error(
                "Attachment artifact chunk length is invalid",
            ));
        }
        let chunk_sha256 = format!("{:x}", Sha256::digest(bytes));

        let mut connection = self.connection()?;
        let transaction = connection.transaction().map_err(sqlite_error)?;
        let mut boundary = 0;
        transaction
            .execute(
                "INSERT OR IGNORE INTO attachment_move_artifacts (
                    account_id, artifact_id, operation_id, attachment_id,
                    ciphertext_sha256, byte_length, chunk_count, publication_state
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 0)",
                params![
                    owner.account_id.as_str(),
                    owner.artifact.artifact_id,
                    owner.operation_id,
                    owner.attachment_id,
                    owner.artifact.ciphertext_sha256,
                    expected.byte_length_i64,
                    i64::from(expected.chunk_count),
                ],
            )
            .map_err(sqlite_error)?;
        self.after_write(SqliteFailureOperation::WriteChunk, &mut boundary)?;

        let stored = load_metadata(&transaction, owner)?.ok_or_else(|| {
            artifact_error("Attachment artifact metadata disappeared during chunk write")
        })?;
        stored.verify(owner, &expected)?;
        let existing = transaction
            .query_row(
                "SELECT rowid, LENGTH(ciphertext), ciphertext_sha256
                 FROM attachment_move_artifact_chunks
                 WHERE account_id = ?1 AND artifact_id = ?2 AND chunk_index = ?3",
                params![
                    owner.account_id.as_str(),
                    owner.artifact.artifact_id,
                    i64::from(chunk_index)
                ],
                |row| {
                    Ok(ChunkBlobDescriptor {
                        row_id: row.get(0)?,
                        byte_length: row.get(1)?,
                        ciphertext_sha256: row.get(2)?,
                    })
                },
            )
            .optional()
            .map_err(sqlite_error)?;
        if let Some(existing) = existing {
            let existing = read_exact_chunk_blob(&transaction, &existing, expected_length)?;
            if existing != bytes {
                return Err(artifact_error(
                    "Attachment artifact chunk conflicts with durable ciphertext",
                ));
            }
            transaction.commit().map_err(sqlite_error)?;
            return Ok(ArtifactChunkWrite::AlreadyStored);
        }
        if stored.publication_state != PublicationState::Incomplete {
            return Err(artifact_error(
                "Published Attachment artifact is missing a durable chunk",
            ));
        }

        transaction
            .execute(
                "INSERT INTO attachment_move_artifact_chunks (
                    account_id, artifact_id, chunk_index, ciphertext, ciphertext_sha256
                 ) VALUES (?1, ?2, ?3, ?4, ?5)",
                params![
                    owner.account_id.as_str(),
                    owner.artifact.artifact_id,
                    i64::from(chunk_index),
                    bytes,
                    chunk_sha256,
                ],
            )
            .map_err(sqlite_error)?;
        self.after_write(SqliteFailureOperation::WriteChunk, &mut boundary)?;
        transaction.commit().map_err(sqlite_error)?;
        Ok(ArtifactChunkWrite::Stored)
    }

    pub(crate) fn publish(
        &self,
        owner: &AttachmentArtifactOwner,
    ) -> Result<ArtifactPublication, RuntimeError> {
        let expected = ValidatedOwner::new(owner)?;
        let mut connection = self.connection()?;
        let transaction = connection.transaction().map_err(sqlite_error)?;
        let stored = load_metadata(&transaction, owner)?.ok_or_else(|| {
            artifact_error("Attachment artifact cannot publish before its chunks are durable")
        })?;
        stored.verify(owner, &expected)?;
        if stored.publication_state == PublicationState::Published {
            transaction.commit().map_err(sqlite_error)?;
            return Ok(ArtifactPublication::AlreadyPublished);
        }
        let mut boundary = 0;
        if stored.publication_state == PublicationState::Incomplete {
            verify_complete_shape(&transaction, owner, &expected)?;
            let updated = transaction
                .execute(
                    "UPDATE attachment_move_artifacts SET publication_state = 1
                     WHERE account_id = ?1 AND artifact_id = ?2 AND publication_state = 0",
                    params![owner.account_id.as_str(), owner.artifact.artifact_id],
                )
                .map_err(sqlite_error)?;
            if updated != 1 {
                return Err(artifact_error(
                    "Attachment artifact publication lost its durable owner",
                ));
            }
            self.after_write(SqliteFailureOperation::Publish, &mut boundary)?;
        }
        transaction.commit().map_err(sqlite_error)?;

        // The durable `verifying` state makes chunks immutable, so hashing can stream outside a
        // transaction without holding a database snapshot for the size of an Attachment.
        verify_complete_ciphertext(&connection, owner, &expected)?;
        #[cfg(test)]
        if let Some(barrier) = &self.publish_barrier {
            barrier.wait();
        }
        let transaction = connection.transaction().map_err(sqlite_error)?;
        let updated = transaction
            .execute(
                "UPDATE attachment_move_artifacts SET publication_state = 2
                 WHERE account_id = ?1 AND artifact_id = ?2
                   AND operation_id = ?3 AND attachment_id = ?4
                   AND ciphertext_sha256 = ?5 AND byte_length = ?6 AND chunk_count = ?7
                   AND publication_state = 1",
                params![
                    owner.account_id.as_str(),
                    owner.artifact.artifact_id,
                    owner.operation_id,
                    owner.attachment_id,
                    owner.artifact.ciphertext_sha256,
                    expected.byte_length_i64,
                    i64::from(expected.chunk_count),
                ],
            )
            .map_err(sqlite_error)?;
        if updated == 0 {
            let stored = load_metadata(&transaction, owner)?.ok_or_else(|| {
                artifact_error("Attachment artifact disappeared during publication")
            })?;
            stored.verify(owner, &expected)?;
            if stored.publication_state == PublicationState::Published {
                transaction.commit().map_err(sqlite_error)?;
                return Ok(ArtifactPublication::AlreadyPublished);
            }
            return Err(artifact_error(
                "Attachment artifact publication state changed during verification",
            ));
        }
        self.after_write(SqliteFailureOperation::Publish, &mut boundary)?;
        transaction.commit().map_err(sqlite_error)?;
        Ok(ArtifactPublication::Published)
    }

    pub(crate) fn read_chunk(
        &self,
        owner: &AttachmentArtifactOwner,
        chunk_index: u32,
    ) -> Result<PublishedArtifactChunk, RuntimeError> {
        let expected = ValidatedOwner::new(owner)?;
        let expected_length = expected.chunk_length(chunk_index)?;
        let connection = self.connection()?;
        let stored = load_metadata_connection(&connection, owner)?
            .ok_or_else(|| artifact_error("Published Attachment artifact is not available"))?;
        stored.verify(owner, &expected)?;
        if stored.publication_state != PublicationState::Published {
            return Err(artifact_error(
                "Incomplete Attachment artifact is not readable",
            ));
        }
        let descriptor = connection
            .query_row(
                "SELECT rowid, LENGTH(ciphertext), ciphertext_sha256
                 FROM attachment_move_artifact_chunks
                 WHERE account_id = ?1 AND artifact_id = ?2 AND chunk_index = ?3",
                params![
                    owner.account_id.as_str(),
                    owner.artifact.artifact_id,
                    i64::from(chunk_index)
                ],
                |row| {
                    Ok(ChunkBlobDescriptor {
                        row_id: row.get(0)?,
                        byte_length: row.get(1)?,
                        ciphertext_sha256: row.get(2)?,
                    })
                },
            )
            .optional()
            .map_err(sqlite_error)?
            .ok_or_else(|| artifact_error("Published Attachment artifact chunk is missing"))?;
        let bytes = read_exact_chunk_blob(&connection, &descriptor, expected_length)?;
        Ok(PublishedArtifactChunk {
            bytes,
            is_last: chunk_index + 1 == expected.chunk_count,
        })
    }

    pub(crate) fn delete_account(&self, account_id: &AccountId) -> Result<(), RuntimeError> {
        let mut connection = self.connection()?;
        let transaction = connection.transaction().map_err(sqlite_error)?;
        let mut boundary = 0;
        transaction
            .execute(
                "DELETE FROM attachment_move_artifacts WHERE account_id = ?1",
                params![account_id.as_str()],
            )
            .map_err(sqlite_error)?;
        self.after_write(SqliteFailureOperation::DeleteAccount, &mut boundary)?;
        transaction.commit().map_err(sqlite_error)?;
        Ok(())
    }

    pub(crate) fn sweep_orphans(
        &self,
        _boundary: ExclusiveStartupBoundary,
        account_id: &AccountId,
        live: &[AttachmentArtifactOwner],
    ) -> Result<usize, RuntimeError> {
        let mut live_ids = HashSet::with_capacity(live.len());
        for owner in live {
            ValidatedOwner::new(owner)?;
            if &owner.account_id != account_id {
                return Err(artifact_error(
                    "Attachment artifact sweep reference has the wrong Account scope",
                ));
            }
            live_ids.insert(owner.artifact.artifact_id.as_str());
        }

        let mut connection = self.connection()?;
        let artifact_ids = {
            let mut statement = connection
                .prepare(
                    "SELECT artifact_id FROM attachment_move_artifacts
                     WHERE account_id = ?1 ORDER BY artifact_id",
                )
                .map_err(sqlite_error)?;
            let rows = statement
                .query_map(params![account_id.as_str()], |row| row.get::<_, String>(0))
                .map_err(sqlite_error)?
                .collect::<Result<Vec<_>, _>>()
                .map_err(sqlite_error)?;
            rows
        };
        let mut deleted = 0;
        let mut write_boundary = 0;
        for artifact_id in artifact_ids {
            if live_ids.contains(artifact_id.as_str()) {
                continue;
            }
            let transaction = connection.transaction().map_err(sqlite_error)?;
            let affected = transaction
                .execute(
                    "DELETE FROM attachment_move_artifacts
                     WHERE account_id = ?1 AND artifact_id = ?2",
                    params![account_id.as_str(), artifact_id],
                )
                .map_err(sqlite_error)?;
            if affected != 1 {
                return Err(artifact_error(
                    "Attachment artifact sweep lost an orphaned record",
                ));
            }
            deleted += 1;
            self.after_write(SqliteFailureOperation::SweepOrphans, &mut write_boundary)?;
            transaction.commit().map_err(sqlite_error)?;
        }
        Ok(deleted)
    }

    fn connection(&self) -> Result<std::sync::MutexGuard<'_, Connection>, RuntimeError> {
        self.connection
            .lock()
            .map_err(|_| artifact_error("SQLite Attachment artifact connection lock poisoned"))
    }

    fn after_write(
        &self,
        operation: SqliteFailureOperation,
        boundary: &mut usize,
    ) -> Result<(), RuntimeError> {
        *boundary += 1;
        if self
            .injected_failure
            .is_some_and(|failure| failure.operation == operation && failure.boundary == *boundary)
        {
            return Err(artifact_error(
                "injected SQLite Attachment artifact write failure",
            ));
        }
        Ok(())
    }
}

#[async_trait]
impl AttachmentArtifactStore for SqliteAttachmentArtifactStore {
    async fn invoke(
        &self,
        request: AttachmentArtifactStoreRequest,
    ) -> Result<AttachmentArtifactStoreResponse, RuntimeError> {
        Ok(match request {
            AttachmentArtifactStoreRequest::WriteChunk {
                owner,
                chunk_index,
                bytes,
            } => AttachmentArtifactStoreResponse::ChunkWritten(self.write_chunk(
                &owner,
                chunk_index,
                &bytes,
            )?),
            AttachmentArtifactStoreRequest::Publish { owner } => {
                AttachmentArtifactStoreResponse::Published(self.publish(&owner)?)
            }
            AttachmentArtifactStoreRequest::ReadChunk { owner, chunk_index } => {
                AttachmentArtifactStoreResponse::ChunkRead(self.read_chunk(&owner, chunk_index)?)
            }
            AttachmentArtifactStoreRequest::DeleteAccount { account_id } => {
                self.delete_account(&account_id)?;
                AttachmentArtifactStoreResponse::AccountDeleted
            }
            AttachmentArtifactStoreRequest::SweepOrphans {
                boundary,
                account_id,
                live,
            } => AttachmentArtifactStoreResponse::OrphansSwept {
                deleted: self.sweep_orphans(boundary, &account_id, &live)?,
            },
        })
    }
}

struct ValidatedOwner {
    byte_length_i64: i64,
    chunk_count: u32,
}

impl ValidatedOwner {
    fn new(owner: &AttachmentArtifactOwner) -> Result<Self, RuntimeError> {
        let canonical = attachment_move_artifact_ref(
            &owner.account_id,
            &owner.operation_id,
            &owner.attachment_id,
            &owner.artifact.ciphertext_sha256,
            owner.artifact.byte_length,
        )?;
        if canonical != owner.artifact {
            return Err(artifact_error(
                "Attachment artifact reference is not canonical for its Account owner",
            ));
        }
        let byte_length_i64 = i64::try_from(owner.artifact.byte_length)
            .map_err(|_| artifact_error("Attachment artifact byte length exceeds SQLite"))?;
        let chunk_bytes = ARTIFACT_CHUNK_BYTES as u64;
        let chunk_count_u64 = owner
            .artifact
            .byte_length
            .checked_add(chunk_bytes - 1)
            .ok_or_else(|| artifact_error("Attachment artifact chunk count overflowed"))?
            / chunk_bytes;
        let chunk_count = u32::try_from(chunk_count_u64)
            .map_err(|_| artifact_error("Attachment artifact has too many chunks"))?;
        Ok(Self {
            byte_length_i64,
            chunk_count,
        })
    }

    fn chunk_length(&self, chunk_index: u32) -> Result<usize, RuntimeError> {
        if chunk_index >= self.chunk_count {
            return Err(artifact_error(
                "Attachment artifact chunk index is out of range",
            ));
        }
        if chunk_index + 1 < self.chunk_count {
            return Ok(ARTIFACT_CHUNK_BYTES);
        }
        let preceding = u64::from(chunk_index) * ARTIFACT_CHUNK_BYTES as u64;
        usize::try_from(self.byte_length_i64 as u64 - preceding)
            .map_err(|_| artifact_error("Attachment artifact final chunk length is invalid"))
    }
}

struct StoredMetadata {
    operation_id: String,
    attachment_id: String,
    ciphertext_sha256: String,
    byte_length: i64,
    chunk_count: i64,
    publication_state: PublicationState,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum PublicationState {
    Incomplete,
    Verifying,
    Published,
}

impl StoredMetadata {
    fn verify(
        &self,
        owner: &AttachmentArtifactOwner,
        expected: &ValidatedOwner,
    ) -> Result<(), RuntimeError> {
        if self.operation_id != owner.operation_id
            || self.attachment_id != owner.attachment_id
            || self.ciphertext_sha256 != owner.artifact.ciphertext_sha256
            || self.byte_length != expected.byte_length_i64
            || self.chunk_count != i64::from(expected.chunk_count)
        {
            return Err(artifact_error(
                "Attachment artifact durable ownership conflicts with its canonical reference",
            ));
        }
        Ok(())
    }
}

fn load_metadata(
    transaction: &Transaction<'_>,
    owner: &AttachmentArtifactOwner,
) -> Result<Option<StoredMetadata>, RuntimeError> {
    transaction
        .query_row(
            "SELECT operation_id, attachment_id, ciphertext_sha256,
                    byte_length, chunk_count, publication_state
             FROM attachment_move_artifacts WHERE account_id = ?1 AND artifact_id = ?2",
            params![owner.account_id.as_str(), owner.artifact.artifact_id],
            metadata_from_row,
        )
        .optional()
        .map_err(sqlite_error)
}

fn load_metadata_connection(
    connection: &Connection,
    owner: &AttachmentArtifactOwner,
) -> Result<Option<StoredMetadata>, RuntimeError> {
    connection
        .query_row(
            "SELECT operation_id, attachment_id, ciphertext_sha256,
                    byte_length, chunk_count, publication_state
             FROM attachment_move_artifacts WHERE account_id = ?1 AND artifact_id = ?2",
            params![owner.account_id.as_str(), owner.artifact.artifact_id],
            metadata_from_row,
        )
        .optional()
        .map_err(sqlite_error)
}

fn metadata_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<StoredMetadata> {
    let publication_state = match row.get::<_, i64>(5)? {
        0 => PublicationState::Incomplete,
        1 => PublicationState::Verifying,
        2 => PublicationState::Published,
        _ => return Err(rusqlite::Error::InvalidQuery),
    };
    Ok(StoredMetadata {
        operation_id: row.get(0)?,
        attachment_id: row.get(1)?,
        ciphertext_sha256: row.get(2)?,
        byte_length: row.get(3)?,
        chunk_count: row.get(4)?,
        publication_state,
    })
}

fn verify_complete_shape(
    transaction: &Transaction<'_>,
    owner: &AttachmentArtifactOwner,
    expected: &ValidatedOwner,
) -> Result<(), RuntimeError> {
    let (count, minimum, maximum, total) = transaction
        .query_row(
            "SELECT COUNT(*), MIN(chunk_index), MAX(chunk_index), COALESCE(SUM(LENGTH(ciphertext)), 0)
             FROM attachment_move_artifact_chunks WHERE account_id = ?1 AND artifact_id = ?2",
            params![owner.account_id.as_str(), owner.artifact.artifact_id],
            |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, Option<i64>>(1)?,
                    row.get::<_, Option<i64>>(2)?,
                    row.get::<_, i64>(3)?,
                ))
            },
        )
        .map_err(sqlite_error)?;
    if count != i64::from(expected.chunk_count)
        || minimum != Some(0)
        || maximum != Some(i64::from(expected.chunk_count - 1))
        || total != expected.byte_length_i64
    {
        return Err(artifact_error("Attachment artifact chunks are incomplete"));
    }
    Ok(())
}

fn verify_complete_ciphertext(
    connection: &Connection,
    owner: &AttachmentArtifactOwner,
    expected: &ValidatedOwner,
) -> Result<(), RuntimeError> {
    let mut statement = connection
        .prepare(
            "SELECT rowid, chunk_index, LENGTH(ciphertext), ciphertext_sha256
             FROM attachment_move_artifact_chunks
             WHERE account_id = ?1 AND artifact_id = ?2 ORDER BY chunk_index",
        )
        .map_err(sqlite_error)?;
    let mut rows = statement
        .query(params![
            owner.account_id.as_str(),
            owner.artifact.artifact_id
        ])
        .map_err(sqlite_error)?;
    let mut hasher = Sha256::new();
    let mut total = 0_u64;
    for expected_index in 0..expected.chunk_count {
        let row = rows
            .next()
            .map_err(sqlite_error)?
            .ok_or_else(|| artifact_error("Attachment artifact chunks are incomplete"))?;
        let descriptor = ChunkBlobDescriptor {
            row_id: row.get(0).map_err(sqlite_error)?,
            byte_length: row.get(2).map_err(sqlite_error)?,
            ciphertext_sha256: row.get(3).map_err(sqlite_error)?,
        };
        let index = row.get::<_, i64>(1).map_err(sqlite_error)?;
        let expected_length = expected.chunk_length(expected_index)?;
        if index != i64::from(expected_index) || descriptor.byte_length != expected_length as i64 {
            return Err(artifact_error(
                "Attachment artifact chunks are not contiguous and exact",
            ));
        }
        let bytes = read_exact_chunk_blob(connection, &descriptor, expected_length)?;
        total = total
            .checked_add(bytes.len() as u64)
            .ok_or_else(|| artifact_error("Attachment artifact byte length overflowed"))?;
        hasher.update(&bytes);
    }
    if rows.next().map_err(sqlite_error)?.is_some()
        || total != owner.artifact.byte_length
        || format!("{:x}", hasher.finalize()) != owner.artifact.ciphertext_sha256
    {
        return Err(artifact_error(
            "Attachment artifact bytes do not match their immutable reference",
        ));
    }
    Ok(())
}

struct ChunkBlobDescriptor {
    row_id: i64,
    byte_length: i64,
    ciphertext_sha256: String,
}

fn read_exact_chunk_blob(
    connection: &Connection,
    descriptor: &ChunkBlobDescriptor,
    expected_length: usize,
) -> Result<Vec<u8>, RuntimeError> {
    if expected_length > ARTIFACT_CHUNK_BYTES
        || descriptor.byte_length != expected_length as i64
        || descriptor.ciphertext_sha256.len() != 64
        || !descriptor
            .ciphertext_sha256
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err(artifact_error(
            "Attachment artifact durable chunk metadata is invalid",
        ));
    }
    let mut blob = connection
        .blob_open(
            "main",
            "attachment_move_artifact_chunks",
            "ciphertext",
            descriptor.row_id,
            true,
        )
        .map_err(sqlite_error)?;
    if blob.len() != expected_length {
        return Err(artifact_error(
            "Attachment artifact durable chunk length is invalid",
        ));
    }
    let mut bytes = vec![0_u8; expected_length];
    blob.read_exact(&mut bytes).map_err(sqlite_error)?;
    if format!("{:x}", Sha256::digest(&bytes)) != descriptor.ciphertext_sha256 {
        return Err(artifact_error(
            "Attachment artifact durable chunk digest is invalid",
        ));
    }
    Ok(bytes)
}

fn sqlite_error(_error: impl std::fmt::Display) -> RuntimeError {
    RuntimeError::new(
        RuntimeErrorCode::InvariantViolation,
        "SQLite Attachment artifact persistence failed",
    )
}
