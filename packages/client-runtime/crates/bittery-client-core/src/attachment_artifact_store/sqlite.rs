use super::{
    artifact_error, ArtifactChunkWrite, ArtifactPublication, AttachmentArtifactOwner,
    AttachmentArtifactStore, AttachmentArtifactStoreRequest, AttachmentArtifactStoreResponse,
    ExclusiveStartupBoundary, ProvisionalAttachmentArtifactRecovery,
    ProvisionalAttachmentArtifactScope, ProvisionalAttachmentArtifactStore,
    ProvisionalAttachmentArtifactStoreRequest, ProvisionalAttachmentArtifactStoreResponse,
    ProvisionalAttachmentArtifactWriter, PublishedArtifactChunk, ARTIFACT_CHUNK_BYTES,
};
use crate::{replica::attachment_move_artifact_ref, AccountId, RuntimeError, RuntimeErrorCode};
use async_trait::async_trait;
use bittery_crypto_core::attachment_move::AttachmentPublicationProof;
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
    physical_generation TEXT,
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
CREATE TABLE IF NOT EXISTS attachment_move_provisional_artifacts (
    account_id TEXT NOT NULL,
    operation_id TEXT NOT NULL,
    attachment_id TEXT NOT NULL,
    generation TEXT NOT NULL,
    publication_state INTEGER NOT NULL DEFAULT 0 CHECK (publication_state IN (0, 1, 2)),
    ciphertext_sha256 TEXT,
    byte_length INTEGER,
    CHECK (
        (publication_state = 0 AND ciphertext_sha256 IS NULL AND byte_length IS NULL)
        OR
        (publication_state IN (1, 2) AND ciphertext_sha256 IS NOT NULL AND byte_length > 0)
    ),
    PRIMARY KEY (account_id, operation_id, attachment_id)
);
CREATE TABLE IF NOT EXISTS attachment_move_provisional_chunks (
    account_id TEXT NOT NULL,
    operation_id TEXT NOT NULL,
    attachment_id TEXT NOT NULL,
    generation TEXT NOT NULL,
    chunk_index INTEGER NOT NULL CHECK (chunk_index >= 0),
    ciphertext BLOB NOT NULL,
    ciphertext_sha256 TEXT NOT NULL,
    PRIMARY KEY (account_id, operation_id, attachment_id, generation, chunk_index)
);
"#;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum SqliteFailureOperation {
    WriteChunk,
    Publish,
    BeginProvisional,
    WriteProvisionalChunk,
    SealProvisional,
    VerifyProvisional,
    FinalizeProvisional,
    DeleteAccount,
    SweepOrphans,
}

enum ProvisionalBegin {
    Begun(ProvisionalAttachmentArtifactWriter),
    RecoveryAvailable(ProvisionalAttachmentArtifactRecovery),
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
        ensure_physical_generation_column(&connection)?;
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

    pub(crate) fn begin_provisional(
        &self,
        scope: &ProvisionalAttachmentArtifactScope,
    ) -> Result<ProvisionalAttachmentArtifactWriter, RuntimeError> {
        let writer = ProvisionalAttachmentArtifactWriter::new(scope.clone());
        match self.begin_provisional_writer(&writer)? {
            ProvisionalBegin::Begun(writer) => Ok(writer),
            ProvisionalBegin::RecoveryAvailable(_) => Err(artifact_error(
                "Authenticated provisional recovery is available",
            )),
        }
    }

    fn begin_provisional_writer(
        &self,
        writer: &ProvisionalAttachmentArtifactWriter,
    ) -> Result<ProvisionalBegin, RuntimeError> {
        let mut connection = self.connection()?;
        let transaction = connection.transaction().map_err(sqlite_error)?;
        let mut boundary = 0;
        let current = transaction
            .query_row(
                "SELECT generation, publication_state FROM attachment_move_provisional_artifacts
                 WHERE account_id = ?1 AND operation_id = ?2 AND attachment_id = ?3",
                params![
                    writer.scope.account_id.as_str(),
                    writer.scope.operation_id,
                    writer.scope.attachment_id,
                ],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?)),
            )
            .optional()
            .map_err(sqlite_error)?;
        if let Some((generation, state)) = current
            .as_ref()
            .filter(|(generation, _)| generation.as_str() == writer.generation.as_str())
        {
            transaction.commit().map_err(sqlite_error)?;
            return if *state == 0 {
                Ok(ProvisionalBegin::Begun(writer.clone()))
            } else {
                Ok(ProvisionalBegin::RecoveryAvailable(
                    ProvisionalAttachmentArtifactRecovery::new(
                        writer.scope.clone(),
                        generation.clone(),
                    )?,
                ))
            };
        }
        if let Some((generation, state)) = current {
            if state == 1 {
                transaction.commit().map_err(sqlite_error)?;
                return Ok(ProvisionalBegin::RecoveryAvailable(
                    ProvisionalAttachmentArtifactRecovery::new(writer.scope.clone(), generation)?,
                ));
            } else if state == 0 {
                transaction
                    .execute(
                        "DELETE FROM attachment_move_provisional_chunks
                         WHERE account_id = ?1 AND operation_id = ?2 AND attachment_id = ?3
                           AND generation = ?4",
                        params![
                            writer.scope.account_id.as_str(),
                            writer.scope.operation_id,
                            writer.scope.attachment_id,
                            generation,
                        ],
                    )
                    .map_err(sqlite_error)?;
            }
        }
        self.after_write(SqliteFailureOperation::BeginProvisional, &mut boundary)?;
        transaction
            .execute(
                "INSERT INTO attachment_move_provisional_artifacts (
                    account_id, operation_id, attachment_id, generation,
                    publication_state, ciphertext_sha256, byte_length
                 ) VALUES (?1, ?2, ?3, ?4, 0, NULL, NULL)
                 ON CONFLICT(account_id, operation_id, attachment_id) DO UPDATE SET
                    generation = excluded.generation,
                    publication_state = 0,
                    ciphertext_sha256 = NULL,
                    byte_length = NULL",
                params![
                    writer.scope.account_id.as_str(),
                    writer.scope.operation_id,
                    writer.scope.attachment_id,
                    writer.generation,
                ],
            )
            .map_err(sqlite_error)?;
        self.after_write(SqliteFailureOperation::BeginProvisional, &mut boundary)?;
        transaction.commit().map_err(sqlite_error)?;
        Ok(ProvisionalBegin::Begun(writer.clone()))
    }

    pub(crate) fn write_provisional_chunk(
        &self,
        writer: &ProvisionalAttachmentArtifactWriter,
        chunk_index: u32,
        bytes: &[u8],
    ) -> Result<ArtifactChunkWrite, RuntimeError> {
        if bytes.is_empty() || bytes.len() > ARTIFACT_CHUNK_BYTES {
            return Err(artifact_error(
                "Provisional Attachment artifact chunk length is invalid",
            ));
        }
        let chunk_sha256 = format!("{:x}", Sha256::digest(bytes));
        let mut connection = self.connection()?;
        let transaction = connection.transaction().map_err(sqlite_error)?;
        require_current_provisional_writer(&transaction, writer, false)?;
        let existing = transaction
            .query_row(
                "SELECT rowid, LENGTH(ciphertext), ciphertext_sha256
                 FROM attachment_move_provisional_chunks
                 WHERE account_id = ?1 AND operation_id = ?2 AND attachment_id = ?3
                   AND generation = ?4 AND chunk_index = ?5",
                params![
                    writer.scope.account_id.as_str(),
                    writer.scope.operation_id,
                    writer.scope.attachment_id,
                    writer.generation,
                    i64::from(chunk_index),
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
            let durable = read_exact_provisional_chunk_blob(&transaction, &existing, bytes.len())?;
            if durable != bytes {
                return Err(artifact_error(
                    "Provisional Attachment artifact chunk conflicts with durable ciphertext",
                ));
            }
            transaction.commit().map_err(sqlite_error)?;
            return Ok(ArtifactChunkWrite::AlreadyStored);
        }
        transaction
            .execute(
                "INSERT INTO attachment_move_provisional_chunks (
                    account_id, operation_id, attachment_id, generation,
                    chunk_index, ciphertext, ciphertext_sha256
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                params![
                    writer.scope.account_id.as_str(),
                    writer.scope.operation_id,
                    writer.scope.attachment_id,
                    writer.generation,
                    i64::from(chunk_index),
                    bytes,
                    chunk_sha256,
                ],
            )
            .map_err(sqlite_error)?;
        let mut boundary = 0;
        self.after_write(SqliteFailureOperation::WriteProvisionalChunk, &mut boundary)?;
        transaction.commit().map_err(sqlite_error)?;
        Ok(ArtifactChunkWrite::Stored)
    }

    pub(crate) fn finalize_provisional(
        &self,
        writer: &ProvisionalAttachmentArtifactWriter,
        publication_proof: AttachmentPublicationProof,
    ) -> Result<AttachmentArtifactOwner, RuntimeError> {
        let owner = AttachmentArtifactOwner::from_publication_proof(writer, publication_proof)?;
        let expected = ValidatedOwner::new(&owner)?;
        let mut connection = self.connection()?;

        let transaction = connection.transaction().map_err(sqlite_error)?;
        let state = require_current_provisional_writer(&transaction, writer, true)?;
        if state == 2 {
            verify_completed_provisional_publication(&transaction, writer, &owner, &expected)?;
            transaction.commit().map_err(sqlite_error)?;
            return Ok(owner);
        }
        if state == 0 {
            verify_provisional_shape(&transaction, writer, &expected)?;
            let updated = transaction
                .execute(
                    "UPDATE attachment_move_provisional_artifacts
                     SET publication_state = 1, ciphertext_sha256 = ?1, byte_length = ?2
                     WHERE account_id = ?3 AND operation_id = ?4 AND attachment_id = ?5
                       AND generation = ?6 AND publication_state = 0
                       AND ciphertext_sha256 IS NULL AND byte_length IS NULL",
                    params![
                        owner.artifact.ciphertext_sha256,
                        expected.byte_length_i64,
                        writer.scope.account_id.as_str(),
                        writer.scope.operation_id,
                        writer.scope.attachment_id,
                        writer.generation,
                    ],
                )
                .map_err(sqlite_error)?;
            if updated != 1 {
                return Err(artifact_error(
                    "Provisional Attachment artifact lost its writer while sealing",
                ));
            }
            let mut boundary = 0;
            self.after_write(SqliteFailureOperation::SealProvisional, &mut boundary)?;
        } else {
            verify_sealed_provisional_binding(&transaction, writer, &owner)?;
        }
        transaction.commit().map_err(sqlite_error)?;

        self.complete_sealed_provisional(&mut connection, writer, &owner, &expected)?;
        Ok(owner)
    }

    pub(crate) fn recover_provisional(
        &self,
        scope: &ProvisionalAttachmentArtifactScope,
    ) -> Result<ProvisionalAttachmentArtifactRecovery, RuntimeError> {
        let connection = self.connection()?;
        let generation = connection
            .query_row(
                "SELECT generation FROM attachment_move_provisional_artifacts
                 WHERE account_id = ?1 AND operation_id = ?2 AND attachment_id = ?3
                   AND publication_state IN (1, 2)",
                params![
                    scope.account_id.as_str(),
                    scope.operation_id,
                    scope.attachment_id,
                ],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(sqlite_error)?
            .ok_or_else(|| {
                artifact_error("No authenticated provisional generation is available to recover")
            })?;
        ProvisionalAttachmentArtifactRecovery::new(scope.clone(), generation)
    }

    fn resume_recovered_provisional(
        &self,
        recovery: &ProvisionalAttachmentArtifactRecovery,
    ) -> Result<AttachmentArtifactOwner, RuntimeError> {
        let connection = self.connection()?;
        let exists = connection
            .query_row(
                "SELECT 1 FROM attachment_move_provisional_artifacts
                   WHERE account_id = ?1 AND operation_id = ?2 AND attachment_id = ?3
                     AND generation = ?4 AND publication_state IN (1, 2)
                 UNION ALL
                 SELECT 1 FROM attachment_move_artifacts
                   WHERE account_id = ?1 AND operation_id = ?2 AND attachment_id = ?3
                     AND physical_generation = ?4 AND publication_state = 2
                 LIMIT 1",
                params![
                    recovery.scope.account_id.as_str(),
                    recovery.scope.operation_id,
                    recovery.scope.attachment_id,
                    recovery.generation,
                ],
                |_| Ok(()),
            )
            .optional()
            .map_err(sqlite_error)?
            .is_some();
        if !exists {
            return Err(artifact_error(
                "No matching authenticated provisional generation is available to recover",
            ));
        }
        drop(connection);
        let writer = ProvisionalAttachmentArtifactWriter::from_recovery(recovery);
        self.resume_provisional_finalization(&writer)
    }

    pub(crate) fn resume_provisional_finalization(
        &self,
        writer: &ProvisionalAttachmentArtifactWriter,
    ) -> Result<AttachmentArtifactOwner, RuntimeError> {
        let mut connection = self.connection()?;
        let provisional_binding = connection
            .query_row(
                "SELECT publication_state, ciphertext_sha256, byte_length
                 FROM attachment_move_provisional_artifacts
                 WHERE account_id = ?1 AND operation_id = ?2 AND attachment_id = ?3
                   AND generation = ?4 AND publication_state IN (1, 2)",
                params![
                    writer.scope.account_id.as_str(),
                    writer.scope.operation_id,
                    writer.scope.attachment_id,
                    writer.generation,
                ],
                |row| {
                    Ok((
                        row.get::<_, i64>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, i64>(2)?,
                    ))
                },
            )
            .optional()
            .map_err(sqlite_error)?;
        let (state, ciphertext_sha256, byte_length) = match provisional_binding {
            Some(binding) => binding,
            None => connection
                .query_row(
                    "SELECT 2, ciphertext_sha256, byte_length
                     FROM attachment_move_artifacts
                     WHERE account_id = ?1 AND operation_id = ?2 AND attachment_id = ?3
                       AND physical_generation = ?4 AND publication_state = 2",
                    params![
                        writer.scope.account_id.as_str(),
                        writer.scope.operation_id,
                        writer.scope.attachment_id,
                        writer.generation,
                    ],
                    |row| {
                        Ok((
                            row.get::<_, i64>(0)?,
                            row.get::<_, String>(1)?,
                            row.get::<_, i64>(2)?,
                        ))
                    },
                )
                .optional()
                .map_err(sqlite_error)?
                .ok_or_else(|| {
                    artifact_error(
                        "No authenticated provisional publication is available to resume",
                    )
                })?,
        };
        let byte_length = u64::try_from(byte_length)
            .map_err(|_| artifact_error("Provisional byte length is invalid"))?;
        let artifact = attachment_move_artifact_ref(
            &writer.scope.account_id,
            &writer.scope.operation_id,
            &writer.scope.attachment_id,
            &ciphertext_sha256,
            byte_length,
        )?;
        let owner = AttachmentArtifactOwner::new(
            writer.scope.account_id.clone(),
            writer.scope.operation_id.clone(),
            writer.scope.attachment_id.clone(),
            artifact,
        )?;
        let expected = ValidatedOwner::new(&owner)?;
        if state == 2 {
            verify_completed_provisional_publication(&connection, writer, &owner, &expected)?;
            return Ok(owner);
        }
        self.complete_sealed_provisional(&mut connection, writer, &owner, &expected)?;
        Ok(owner)
    }

    fn complete_sealed_provisional(
        &self,
        connection: &mut Connection,
        writer: &ProvisionalAttachmentArtifactWriter,
        owner: &AttachmentArtifactOwner,
        expected: &ValidatedOwner,
    ) -> Result<(), RuntimeError> {
        verify_provisional_ciphertext(connection, writer, owner, expected)?;
        let mut verify_boundary = 0;
        self.after_write(
            SqliteFailureOperation::VerifyProvisional,
            &mut verify_boundary,
        )?;

        let transaction = connection.transaction().map_err(sqlite_error)?;
        let state = require_current_provisional_writer(&transaction, writer, true)?;
        if state == 2 {
            verify_completed_provisional_publication(&transaction, writer, owner, expected)?;
            transaction.commit().map_err(sqlite_error)?;
            return Ok(());
        }
        verify_sealed_provisional_binding(&transaction, writer, owner)?;
        let existing = transaction
            .query_row(
                "SELECT ciphertext_sha256, byte_length, physical_generation
                 FROM attachment_move_artifacts
                 WHERE account_id = ?1 AND artifact_id = ?2 AND publication_state = 2",
                params![writer.scope.account_id.as_str(), owner.artifact.artifact_id,],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, i64>(1)?,
                        row.get::<_, String>(2)?,
                    ))
                },
            )
            .optional()
            .map_err(sqlite_error)?;
        if let Some(existing) = existing {
            if existing
                != (
                    owner.artifact.ciphertext_sha256.clone(),
                    expected.byte_length_i64,
                    writer.generation.clone(),
                )
            {
                return Err(artifact_error(
                    "Attachment artifact scope already owns different published ciphertext",
                ));
            }
        } else {
            transaction
                .execute(
                    "INSERT INTO attachment_move_artifacts (
                        account_id, artifact_id, operation_id, attachment_id,
                        ciphertext_sha256, byte_length, chunk_count, publication_state,
                        physical_generation
                     ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 2, ?8)",
                    params![
                        owner.account_id.as_str(),
                        owner.artifact.artifact_id,
                        owner.operation_id,
                        owner.attachment_id,
                        owner.artifact.ciphertext_sha256,
                        expected.byte_length_i64,
                        i64::from(expected.chunk_count),
                        writer.generation,
                    ],
                )
                .map_err(sqlite_error)?;
        }
        let mut transition_boundary = 0;
        self.after_write(
            SqliteFailureOperation::FinalizeProvisional,
            &mut transition_boundary,
        )?;
        let completed = transaction
            .execute(
                "UPDATE attachment_move_provisional_artifacts SET publication_state = 2
                 WHERE account_id = ?1 AND operation_id = ?2 AND attachment_id = ?3
                   AND generation = ?4 AND publication_state = 1",
                params![
                    writer.scope.account_id.as_str(),
                    writer.scope.operation_id,
                    writer.scope.attachment_id,
                    writer.generation,
                ],
            )
            .map_err(sqlite_error)?;
        if completed != 1 {
            return Err(artifact_error(
                "Provisional Attachment artifact changed during final publication",
            ));
        }
        self.after_write(
            SqliteFailureOperation::FinalizeProvisional,
            &mut transition_boundary,
        )?;
        transaction.commit().map_err(sqlite_error)?;
        Ok(())
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
        let (descriptor, provisional) = if let Some(generation) = &stored.physical_generation {
            let descriptor = connection
                .query_row(
                    "SELECT rowid, LENGTH(ciphertext), ciphertext_sha256
                     FROM attachment_move_provisional_chunks
                     WHERE account_id = ?1 AND operation_id = ?2 AND attachment_id = ?3
                       AND generation = ?4 AND chunk_index = ?5",
                    params![
                        owner.account_id.as_str(),
                        owner.operation_id,
                        owner.attachment_id,
                        generation,
                        i64::from(chunk_index),
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
            (descriptor, true)
        } else {
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
            (descriptor, false)
        };
        let bytes = if provisional {
            read_exact_provisional_chunk_blob(&connection, &descriptor, expected_length)?
        } else {
            read_exact_chunk_blob(&connection, &descriptor, expected_length)?
        };
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
                "DELETE FROM attachment_move_provisional_chunks WHERE account_id = ?1",
                params![account_id.as_str()],
            )
            .map_err(sqlite_error)?;
        self.after_write(SqliteFailureOperation::DeleteAccount, &mut boundary)?;
        transaction
            .execute(
                "DELETE FROM attachment_move_provisional_artifacts WHERE account_id = ?1",
                params![account_id.as_str()],
            )
            .map_err(sqlite_error)?;
        self.after_write(SqliteFailureOperation::DeleteAccount, &mut boundary)?;
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
        let live_physical_generations = {
            let mut statement = connection
                .prepare(
                    "SELECT artifact_id, operation_id, attachment_id, physical_generation
                     FROM attachment_move_artifacts
                     WHERE account_id = ?1 AND physical_generation IS NOT NULL",
                )
                .map_err(sqlite_error)?;
            let rows = statement
                .query_map(params![account_id.as_str()], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, String>(3)?,
                    ))
                })
                .map_err(sqlite_error)?
                .collect::<Result<Vec<_>, _>>()
                .map_err(sqlite_error)?;
            rows.into_iter()
                .filter(|(artifact_id, _, _, _)| live_ids.contains(artifact_id.as_str()))
                .map(|(_, operation_id, attachment_id, generation)| {
                    (operation_id, attachment_id, generation)
                })
                .collect::<HashSet<_>>()
        };
        let mut deleted = 0;
        let mut write_boundary = 0;
        let provisional = {
            let mut statement = connection
                .prepare(
                    "SELECT operation_id, attachment_id, generation
                       FROM attachment_move_provisional_artifacts WHERE account_id = ?1
                     UNION
                     SELECT operation_id, attachment_id, generation
                       FROM attachment_move_provisional_chunks WHERE account_id = ?1
                     ORDER BY operation_id, attachment_id, generation",
                )
                .map_err(sqlite_error)?;
            let rows = statement
                .query_map(params![account_id.as_str()], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                    ))
                })
                .map_err(sqlite_error)?
                .collect::<Result<Vec<_>, _>>()
                .map_err(sqlite_error)?;
            rows
        };
        for (operation_id, attachment_id, generation) in provisional {
            if live_physical_generations.contains(&(
                operation_id.clone(),
                attachment_id.clone(),
                generation.clone(),
            )) {
                continue;
            }
            let transaction = connection.transaction().map_err(sqlite_error)?;
            transaction
                .execute(
                    "DELETE FROM attachment_move_provisional_chunks
                     WHERE account_id = ?1 AND operation_id = ?2 AND attachment_id = ?3
                       AND generation = ?4",
                    params![account_id.as_str(), operation_id, attachment_id, generation,],
                )
                .map_err(sqlite_error)?;
            transaction
                .execute(
                    "DELETE FROM attachment_move_provisional_artifacts
                     WHERE account_id = ?1 AND operation_id = ?2 AND attachment_id = ?3
                       AND generation = ?4",
                    params![account_id.as_str(), operation_id, attachment_id, generation,],
                )
                .map_err(sqlite_error)?;
            deleted += 1;
            self.after_write(SqliteFailureOperation::SweepOrphans, &mut write_boundary)?;
            transaction.commit().map_err(sqlite_error)?;
        }
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

#[async_trait]
impl ProvisionalAttachmentArtifactStore for SqliteAttachmentArtifactStore {
    async fn invoke_provisional(
        &self,
        request: ProvisionalAttachmentArtifactStoreRequest,
    ) -> Result<ProvisionalAttachmentArtifactStoreResponse, RuntimeError> {
        Ok(match request {
            ProvisionalAttachmentArtifactStoreRequest::Begin { writer } => {
                match self.begin_provisional_writer(&writer)? {
                    ProvisionalBegin::Begun(writer) => {
                        ProvisionalAttachmentArtifactStoreResponse::Begun(writer)
                    }
                    ProvisionalBegin::RecoveryAvailable(recovery) => {
                        ProvisionalAttachmentArtifactStoreResponse::RecoveryAvailable(recovery)
                    }
                }
            }
            ProvisionalAttachmentArtifactStoreRequest::WriteChunk {
                writer,
                chunk_index,
                bytes,
            } => ProvisionalAttachmentArtifactStoreResponse::ChunkWritten(
                self.write_provisional_chunk(&writer, chunk_index, &bytes)?,
            ),
            ProvisionalAttachmentArtifactStoreRequest::Finalize {
                writer,
                publication_proof,
            } => ProvisionalAttachmentArtifactStoreResponse::Finalized(
                self.finalize_provisional(&writer, publication_proof)?,
            ),
            ProvisionalAttachmentArtifactStoreRequest::Recover { scope } => {
                ProvisionalAttachmentArtifactStoreResponse::RecoveryAvailable(
                    self.recover_provisional(&scope)?,
                )
            }
            ProvisionalAttachmentArtifactStoreRequest::ResumeRecovered { recovery } => {
                ProvisionalAttachmentArtifactStoreResponse::Finalized(
                    self.resume_recovered_provisional(&recovery)?,
                )
            }
            ProvisionalAttachmentArtifactStoreRequest::ResumeFinalization { writer } => {
                ProvisionalAttachmentArtifactStoreResponse::Finalized(
                    self.resume_provisional_finalization(&writer)?,
                )
            }
        })
    }
}

fn require_current_provisional_writer(
    transaction: &Transaction<'_>,
    writer: &ProvisionalAttachmentArtifactWriter,
    allow_sealed: bool,
) -> Result<i64, RuntimeError> {
    let state = transaction
        .query_row(
            "SELECT publication_state FROM attachment_move_provisional_artifacts
             WHERE account_id = ?1 AND operation_id = ?2 AND attachment_id = ?3
               AND generation = ?4",
            params![
                writer.scope.account_id.as_str(),
                writer.scope.operation_id,
                writer.scope.attachment_id,
                writer.generation,
            ],
            |row| row.get::<_, i64>(0),
        )
        .optional()
        .map_err(sqlite_error)?
        .ok_or_else(|| artifact_error("Provisional Attachment artifact writer is stale"))?;
    if state != 0 && !(allow_sealed && (state == 1 || state == 2)) {
        return Err(artifact_error(
            "Provisional Attachment artifact writer is no longer writable",
        ));
    }
    Ok(state)
}

fn verify_provisional_shape(
    transaction: &Transaction<'_>,
    writer: &ProvisionalAttachmentArtifactWriter,
    expected: &ValidatedOwner,
) -> Result<(), RuntimeError> {
    let (count, minimum, maximum, total) = transaction
        .query_row(
            "SELECT COUNT(*), MIN(chunk_index), MAX(chunk_index), COALESCE(SUM(LENGTH(ciphertext)), 0)
             FROM attachment_move_provisional_chunks
             WHERE account_id = ?1 AND operation_id = ?2 AND attachment_id = ?3
               AND generation = ?4",
            params![
                writer.scope.account_id.as_str(),
                writer.scope.operation_id,
                writer.scope.attachment_id,
                writer.generation,
            ],
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
        return Err(artifact_error(
            "Provisional Attachment artifact chunks are incomplete",
        ));
    }
    Ok(())
}

fn verify_sealed_provisional_binding(
    transaction: &Transaction<'_>,
    writer: &ProvisionalAttachmentArtifactWriter,
    owner: &AttachmentArtifactOwner,
) -> Result<(), RuntimeError> {
    let stored = transaction
        .query_row(
            "SELECT ciphertext_sha256, byte_length
             FROM attachment_move_provisional_artifacts
             WHERE account_id = ?1 AND operation_id = ?2 AND attachment_id = ?3
               AND generation = ?4 AND publication_state = 1",
            params![
                writer.scope.account_id.as_str(),
                writer.scope.operation_id,
                writer.scope.attachment_id,
                writer.generation,
            ],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?)),
        )
        .optional()
        .map_err(sqlite_error)?
        .ok_or_else(|| artifact_error("Provisional Attachment artifact seal is unavailable"))?;
    let expected_length = i64::try_from(owner.artifact.byte_length)
        .map_err(|_| artifact_error("Attachment artifact byte length exceeds SQLite"))?;
    if stored != (owner.artifact.ciphertext_sha256.clone(), expected_length) {
        return Err(artifact_error(
            "Provisional Attachment artifact seal conflicts with publication authority",
        ));
    }
    Ok(())
}

fn verify_completed_provisional_publication(
    connection: &Connection,
    writer: &ProvisionalAttachmentArtifactWriter,
    owner: &AttachmentArtifactOwner,
    expected: &ValidatedOwner,
) -> Result<(), RuntimeError> {
    let stored = connection
        .query_row(
            "SELECT artifact_id, ciphertext_sha256, byte_length, chunk_count, publication_state,
                    physical_generation
             FROM attachment_move_artifacts
             WHERE account_id = ?1 AND operation_id = ?2 AND attachment_id = ?3
               AND artifact_id = ?4",
            params![
                writer.scope.account_id.as_str(),
                writer.scope.operation_id,
                writer.scope.attachment_id,
                owner.artifact.artifact_id,
            ],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, i64>(2)?,
                    row.get::<_, i64>(3)?,
                    row.get::<_, i64>(4)?,
                    row.get::<_, Option<String>>(5)?,
                ))
            },
        )
        .optional()
        .map_err(sqlite_error)?
        .ok_or_else(|| artifact_error("Completed Attachment artifact publication is missing"))?;
    if stored
        != (
            owner.artifact.artifact_id.clone(),
            owner.artifact.ciphertext_sha256.clone(),
            expected.byte_length_i64,
            i64::from(expected.chunk_count),
            2,
            Some(writer.generation.clone()),
        )
    {
        return Err(artifact_error(
            "Completed Attachment artifact publication conflicts with its writer generation",
        ));
    }
    Ok(())
}

fn verify_provisional_ciphertext(
    connection: &Connection,
    writer: &ProvisionalAttachmentArtifactWriter,
    owner: &AttachmentArtifactOwner,
    expected: &ValidatedOwner,
) -> Result<(), RuntimeError> {
    let mut statement = connection
        .prepare(
            "SELECT rowid, chunk_index, LENGTH(ciphertext), ciphertext_sha256
             FROM attachment_move_provisional_chunks
             WHERE account_id = ?1 AND operation_id = ?2 AND attachment_id = ?3
               AND generation = ?4 ORDER BY chunk_index",
        )
        .map_err(sqlite_error)?;
    let mut rows = statement
        .query(params![
            writer.scope.account_id.as_str(),
            writer.scope.operation_id,
            writer.scope.attachment_id,
            writer.generation,
        ])
        .map_err(sqlite_error)?;
    let mut hasher = Sha256::new();
    let mut total = 0_u64;
    for expected_index in 0..expected.chunk_count {
        let row = rows
            .next()
            .map_err(sqlite_error)?
            .ok_or_else(|| artifact_error("Provisional Attachment artifact is incomplete"))?;
        let descriptor = ChunkBlobDescriptor {
            row_id: row.get(0).map_err(sqlite_error)?,
            byte_length: row.get(2).map_err(sqlite_error)?,
            ciphertext_sha256: row.get(3).map_err(sqlite_error)?,
        };
        let index = row.get::<_, i64>(1).map_err(sqlite_error)?;
        let expected_length = expected.chunk_length(expected_index)?;
        if index != i64::from(expected_index) || descriptor.byte_length != expected_length as i64 {
            return Err(artifact_error(
                "Provisional Attachment artifact chunks are not contiguous and exact",
            ));
        }
        let bytes = read_exact_provisional_chunk_blob(connection, &descriptor, expected_length)?;
        total = total
            .checked_add(bytes.len() as u64)
            .ok_or_else(|| artifact_error("Attachment artifact byte length overflowed"))?;
        hasher.update(bytes);
    }
    if rows.next().map_err(sqlite_error)?.is_some()
        || total != owner.artifact.byte_length
        || format!("{:x}", hasher.finalize()) != owner.artifact.ciphertext_sha256
    {
        return Err(artifact_error(
            "Provisional Attachment artifact bytes do not match publication authority",
        ));
    }
    Ok(())
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
    physical_generation: Option<String>,
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
                    byte_length, chunk_count, publication_state, physical_generation
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
                    byte_length, chunk_count, publication_state, physical_generation
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
        physical_generation: row.get(6)?,
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
    read_exact_blob_from_table(
        connection,
        "attachment_move_artifact_chunks",
        descriptor,
        expected_length,
    )
}

fn read_exact_provisional_chunk_blob(
    connection: &Connection,
    descriptor: &ChunkBlobDescriptor,
    expected_length: usize,
) -> Result<Vec<u8>, RuntimeError> {
    read_exact_blob_from_table(
        connection,
        "attachment_move_provisional_chunks",
        descriptor,
        expected_length,
    )
}

fn read_exact_blob_from_table(
    connection: &Connection,
    table: &'static str,
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
        .blob_open("main", table, "ciphertext", descriptor.row_id, true)
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

fn ensure_physical_generation_column(connection: &Connection) -> Result<(), RuntimeError> {
    let has_column = {
        let mut statement = connection
            .prepare("PRAGMA table_info(attachment_move_artifacts)")
            .map_err(sqlite_error)?;
        let names = statement
            .query_map([], |row| row.get::<_, String>(1))
            .map_err(sqlite_error)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(sqlite_error)?;
        names.iter().any(|name| name == "physical_generation")
    };
    if !has_column {
        connection
            .execute_batch(
                "ALTER TABLE attachment_move_artifacts ADD COLUMN physical_generation TEXT;",
            )
            .map_err(sqlite_error)?;
    }
    Ok(())
}
