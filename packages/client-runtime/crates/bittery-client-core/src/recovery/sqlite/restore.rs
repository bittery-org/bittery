//! Immutable native artifact installation. Core has already verified archive selection and hashes.
//! This translates the existing physical record contract, never changes a conflicting stored row.
use super::super::artifacts::{ArtifactMetadata, ImageMetadata, ProvisionalMetadata};
use super::*;
use rusqlite::TransactionBehavior;

pub(super) fn add(
    path: &Path,
    account: &str,
    record: &Record,
    binary: Option<&[u8]>,
    cancellation: &crate::RequestCancellation,
) -> Result<Reply, RuntimeError> {
    if record.account_id() != account || account.is_empty() || account.len() > ID_BYTES {
        return Err(corrupt());
    }
    let chunk = matches!(
        record,
        Record::ArtifactChunk { .. }
            | Record::ProvisionalChunk { .. }
            | Record::VaultImageChunk { .. }
            | Record::ProtectedVaultImageChunk { .. }
    );
    if chunk != binary.is_some()
        || binary.is_some_and(|value| value.is_empty() || value.len() > CHUNK_BYTES)
    {
        return Err(corrupt());
    }
    if cancellation.is_cancelled() {
        return Ok(Reply::Unavailable {
            reason: RecoveryUnavailableReason::Cancelled,
        });
    }
    let mut connection = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_WRITE)
        .map_err(storage_error)?;
    let image = matches!(
        record,
        Record::VaultImageMetadata { .. }
            | Record::VaultImageChunk { .. }
            | Record::ProtectedVaultImageMetadata { .. }
            | Record::ProtectedVaultImageChunk { .. }
    );
    let image_schema = if image {
        crate::vault_image::sqlite::recovery_schema(&connection)
            .map_err(|_| storage_error("unsupported"))?
    } else {
        crate::attachment_artifact_store::sqlite::validate_recovery_schema(&connection)
            .map_err(|_| storage_error("unsupported"))?;
        0
    };
    connection
        .execute_batch("PRAGMA foreign_keys=ON")
        .map_err(storage_error)?;
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(storage_error)?;
    match record {
        Record::ArtifactMetadata {
            artifact_id,
            metadata_json,
            ..
        } => {
            let metadata: ArtifactMetadata = parse(metadata_json)?;
            if metadata.account_id != account || metadata.artifact_id != *artifact_id {
                return Err(corrupt());
            }
            let state = match metadata.publication_state.as_str() {
                "incomplete" => 0,
                "verifying" => 1,
                "published" => 2,
                _ => return Err(corrupt()),
            };
            insert_same(
                &transaction,
                "attachment_move_artifacts",
                &["account_id", "artifact_id"],
                &[
                    "operation_id",
                    "attachment_id",
                    "ciphertext_sha256",
                    "byte_length",
                    "chunk_count",
                    "publication_state",
                    "physical_generation",
                ],
                vec![
                    text_value(account),
                    text_value(artifact_id),
                    metadata.operation_id.into(),
                    metadata.attachment_id.into(),
                    metadata.ciphertext_sha256.into(),
                    number(metadata.byte_length)?,
                    metadata.chunk_count.into(),
                    state.into(),
                    optional(metadata.physical_generation),
                ],
            )?;
        }
        Record::ArtifactChunk {
            artifact_id,
            chunk_index,
            chunk_sha256,
            ..
        } => {
            insert_same(
                &transaction,
                "attachment_move_artifact_chunks",
                &["account_id", "artifact_id", "chunk_index"],
                &["ciphertext", "ciphertext_sha256"],
                vec![
                    text_value(account),
                    text_value(artifact_id),
                    (*chunk_index).into(),
                    binary.unwrap().to_vec().into(),
                    text_value(chunk_sha256),
                ],
            )?;
        }
        Record::ProvisionalMetadata {
            operation_id,
            attachment_id,
            generation,
            metadata_json,
            ..
        } => {
            let metadata: ProvisionalMetadata = parse(metadata_json)?;
            if metadata.account_id != account
                || metadata.operation_id != *operation_id
                || metadata.attachment_id != *attachment_id
                || metadata.generation != *generation
            {
                return Err(corrupt());
            }
            let length = metadata
                .byte_length
                .as_deref()
                .map(|value| value.parse::<u64>().map_err(|_| corrupt()))
                .transpose()?
                .map(number)
                .transpose()?
                .unwrap_or(Value::Null);
            if !metadata.current {
                // Historical metadata has no own native row: its immutable published mapping is
                // the durable representation. Foreign histories without that mapping cannot fit.
                let matching: bool = transaction.query_row("SELECT EXISTS(SELECT 1 FROM attachment_move_artifacts WHERE account_id=?1 AND artifact_id=?2 AND operation_id=?3 AND attachment_id=?4 AND physical_generation=?5 AND publication_state=2 AND ciphertext_sha256=?6 AND byte_length=?7 AND chunk_count=?8)",params![account,metadata.artifact_id,operation_id,attachment_id,generation,metadata.ciphertext_sha256,length,metadata.chunk_count],|row|row.get(0)).map_err(storage_error)?;
                if !matching || metadata.publication_state != 2 {
                    return Ok(Reply::Unavailable {
                        reason: RecoveryUnavailableReason::Unsupported,
                    });
                }
                let current: bool = transaction.query_row("SELECT EXISTS(SELECT 1 FROM attachment_move_provisional_artifacts WHERE account_id=?1 AND operation_id=?2 AND attachment_id=?3 AND generation=?4)",params![account,operation_id,attachment_id,generation],|row|row.get(0)).map_err(storage_error)?;
                if current {
                    return Err(corrupt());
                }
            } else {
                insert_same(
                    &transaction,
                    "attachment_move_provisional_artifacts",
                    &["account_id", "operation_id", "attachment_id"],
                    &[
                        "generation",
                        "publication_state",
                        "ciphertext_sha256",
                        "byte_length",
                    ],
                    vec![
                        text_value(account),
                        text_value(operation_id),
                        text_value(attachment_id),
                        text_value(generation),
                        metadata.publication_state.into(),
                        optional(metadata.ciphertext_sha256),
                        length,
                    ],
                )?;
            }
        }
        Record::ProvisionalChunk {
            operation_id,
            attachment_id,
            generation,
            chunk_index,
            chunk_sha256,
            ..
        } => {
            insert_same(
                &transaction,
                "attachment_move_provisional_chunks",
                &[
                    "account_id",
                    "operation_id",
                    "attachment_id",
                    "generation",
                    "chunk_index",
                ],
                &["ciphertext", "ciphertext_sha256"],
                vec![
                    text_value(account),
                    text_value(operation_id),
                    text_value(attachment_id),
                    text_value(generation),
                    (*chunk_index).into(),
                    binary.unwrap().to_vec().into(),
                    text_value(chunk_sha256),
                ],
            )?;
        }
        Record::VaultImageMetadata {
            operation_id,
            metadata_json,
            ..
        }
        | Record::ProtectedVaultImageMetadata {
            operation_id,
            metadata_json,
            ..
        } => {
            let metadata: ImageMetadata = parse(metadata_json)?;
            let publication = image_publication(record)?;
            if metadata.account_id != account
                || metadata.operation_id != *operation_id
                || metadata.publication_id.as_deref() != publication
                || metadata.protection.is_some() != publication.is_some()
            {
                return Err(corrupt());
            }
            let mut keys = vec!["account_id", "operation_id"];
            let mut values = vec![text_value(account), text_value(operation_id)];
            if image_schema == 2 {
                keys.push("publication_id");
                values.push(text_value(publication.unwrap_or("")));
            } else if publication.is_some() {
                return Err(storage_error("unsupported"));
            }
            let mut columns = vec![
                "vault_id",
                "byte_length",
                "content_type",
                "sha256",
                "published",
            ];
            values.extend([
                metadata.vault_id.into(),
                number(metadata.byte_length)?,
                metadata.content_type.into(),
                metadata.sha256.into(),
                i64::from(metadata.published).into(),
            ]);
            if image_schema == 2 {
                columns.push("protection_json");
                values.push(optional(
                    metadata
                        .protection
                        .map(|protection| serde_json::to_string(&protection).map_err(|_| corrupt()))
                        .transpose()?,
                ));
            }
            insert_same(
                &transaction,
                "vault_image_artifacts",
                &keys,
                &columns,
                values,
            )?;
        }
        Record::VaultImageChunk {
            operation_id,
            chunk_index,
            ..
        }
        | Record::ProtectedVaultImageChunk {
            operation_id,
            chunk_index,
            ..
        } => {
            let publication = image_publication(record)?;
            let mut keys = vec!["account_id", "operation_id"];
            let mut values = vec![text_value(account), text_value(operation_id)];
            if image_schema == 2 {
                keys.push("publication_id");
                values.push(text_value(publication.unwrap_or("")));
            } else if publication.is_some() {
                return Err(storage_error("unsupported"));
            }
            keys.push("chunk_index");
            values.extend([(*chunk_index).into(), binary.unwrap().to_vec().into()]);
            insert_same(
                &transaction,
                "vault_image_artifact_chunks",
                &keys,
                &["plaintext"],
                values,
            )?;
        }
        _ => return Err(corrupt()),
    }
    if cancellation.is_cancelled() {
        return Ok(Reply::Unavailable {
            reason: RecoveryUnavailableReason::Cancelled,
        });
    }
    transaction.commit().map_err(storage_error)?;
    Ok(Reply::ArtifactAdded)
}

fn image_publication(record: &Record) -> Result<Option<&str>, RuntimeError> {
    match record {
        Record::ProtectedVaultImageMetadata { publication_id, .. }
        | Record::ProtectedVaultImageChunk { publication_id, .. } => {
            if publication_id.is_empty() || publication_id.len() > ID_BYTES {
                return Err(corrupt());
            }
            Ok(Some(publication_id))
        }
        _ => Ok(None),
    }
}

fn parse<T: serde::de::DeserializeOwned>(text: &str) -> Result<T, RuntimeError> {
    if text.len() > RECORD_BYTES {
        return Err(super::super::limits::exceeded(RecoveryBound::RecordBytes));
    }
    serde_json::from_str(text).map_err(|_| corrupt())
}
fn text_value(value: &str) -> Value {
    Value::Text(value.to_owned())
}
fn optional(value: Option<String>) -> Value {
    value.map(Value::Text).unwrap_or(Value::Null)
}
fn number(value: u64) -> Result<Value, RuntimeError> {
    i64::try_from(value)
        .map(Value::Integer)
        .map_err(|_| corrupt())
}

/// All identifiers below come from the fixed calls above. Values are always SQL parameters.
fn insert_same(
    connection: &Connection,
    table: &str,
    keys: &[&str],
    columns: &[&str],
    values: Vec<Value>,
) -> Result<(), RuntimeError> {
    let names: Vec<_> = keys.iter().chain(columns).copied().collect();
    let predicate = keys
        .iter()
        .map(|key| format!("{key}=?"))
        .collect::<Vec<_>>()
        .join(" AND ");
    let query = format!("SELECT {} FROM {table} WHERE {predicate}", names.join(","));
    let existing = connection
        .query_row(
            &query,
            params_from_iter(values[..keys.len()].iter()),
            |row| {
                // Compare borrowed SQLite values: a conflicting corrupt blob/text must not be allocated.
                for (index, value) in values.iter().enumerate() {
                    if row.get_ref(index)? != rusqlite::types::ValueRef::from(value) {
                        return Ok(false);
                    }
                }
                Ok(true)
            },
        )
        .optional()
        .map_err(storage_error)?;
    if let Some(same) = existing {
        return if same { Ok(()) } else { Err(corrupt()) };
    }
    let placeholders = vec!["?"; names.len()].join(",");
    connection
        .execute(
            &format!(
                "INSERT INTO {table}({}) VALUES({placeholders})",
                names.join(",")
            ),
            params_from_iter(values.iter()),
        )
        .map_err(storage_error)?;
    Ok(())
}
