use super::*;
use serde_json::json;

pub(super) fn map_record(
    connection: &Connection,
    table: usize,
    account: &str,
    row: &Row<'_>,
) -> Result<(Record, Option<Vec<u8>>), RuntimeError> {
    if text(row, "account_id")? != account {
        return Err(corrupt());
    }
    let account_id = account.to_owned();
    let index = || {
        integer(row, "chunk_index").and_then(|value| u32::try_from(value).map_err(|_| corrupt()))
    };
    let metadata = |value: serde_json::Value| -> Result<String, RuntimeError> {
        let value = serde_json::to_string(&value).map_err(storage_error)?;
        if value.len() > RECORD_BYTES {
            return Err(super::super::limits::exceeded(RecoveryBound::RecordBytes));
        }
        Ok(value)
    };
    Ok(match table {
        0 => {
            let failure = optional_text(row, "failure_json")?
                .map(|value| {
                    serde_json::from_str::<serde_json::Value>(&value)
                        .unwrap_or_else(|_| json!(value))
                })
                .unwrap_or(serde_json::Value::Null);
            let payload_json = metadata(
                json!({ "accountId": account, "userId": text(row, "user_id")?, "incarnation": text(row,"incarnation")?, "replicaRevision": text(row,"replica_revision")?, "lockEpoch": text(row,"lock_epoch")?, "failure": failure }),
            )?;
            (
                Record::RawReplicaHead {
                    account_id,
                    payload_json,
                },
                None,
            )
        }
        1 => (
            Record::RawReplicaRow {
                account_id,
                store: crate::replica::sqlite::decode_store(
                    row.get("store").map_err(storage_error)?,
                )?,
                record_id: text(row, "record_id")?,
                payload_json: text(row, "payload_json")?,
            },
            None,
        ),
        2 => {
            let artifact_id = text(row, "artifact_id")?;
            let operation_id = text(row, "operation_id")?;
            let attachment_id = text(row, "attachment_id")?;
            let generation = optional_text(row, "physical_generation")?;
            let count: u32 = if let Some(generation) = &generation {
                connection.query_row("SELECT COUNT(*) FROM attachment_move_provisional_chunks WHERE account_id=?1 AND operation_id=?2 AND attachment_id=?3 AND generation=?4",params![account,operation_id,attachment_id,generation],|row|row.get(0)).map_err(storage_error)?
            } else {
                connection.query_row("SELECT COUNT(*) FROM attachment_move_artifact_chunks WHERE account_id=?1 AND artifact_id=?2",params![account,artifact_id],|row|row.get(0)).map_err(storage_error)?
            };
            let state = match integer(row, "publication_state")? {
                0 => "incomplete",
                1 => "verifying",
                2 => "published",
                _ => return Err(corrupt()),
            };
            let metadata_json = metadata(
                json!({"accountId":account,"artifactId":artifact_id,"operationId":operation_id,"attachmentId":attachment_id,"ciphertextSha256":text(row,"ciphertext_sha256")?,"byteLength":integer(row,"byte_length")?.to_string(),"chunkCount":integer(row,"chunk_count")?,"publicationState":state,"durableChunkCount":count,"physicalGeneration":generation}),
            )?;
            (
                Record::ArtifactMetadata {
                    account_id,
                    artifact_id,
                    metadata_json,
                },
                None,
            )
        }
        3 => (
            Record::ArtifactChunk {
                account_id,
                artifact_id: text(row, "artifact_id")?,
                chunk_index: index()?,
                chunk_sha256: text(row, "ciphertext_sha256")?,
            },
            Some(binary(row, "ciphertext")?),
        ),
        4 => {
            let operation_id = text(row, "operation_id")?;
            let attachment_id = text(row, "attachment_id")?;
            let generation = text(row, "generation")?;
            let (count,length,minimum,maximum): (u32,i64,Option<u32>,Option<u32>) = connection.query_row("SELECT COUNT(*),COALESCE(SUM(LENGTH(ciphertext)),0),MIN(chunk_index),MAX(chunk_index) FROM attachment_move_provisional_chunks WHERE account_id=?1 AND operation_id=?2 AND attachment_id=?3 AND generation=?4",params![account,operation_id,attachment_id,generation],|row|Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?))).map_err(storage_error)?;
            let state = integer(row, "publication_state")?;
            let digest = optional_text(row, "ciphertext_sha256")?;
            let length_final = row
                .get::<_, Option<i64>>("byte_length")
                .map_err(storage_error)?
                .map(|value| u64::try_from(value).map_err(|_| corrupt()))
                .transpose()?;
            let artifact = match (digest.as_deref(), length_final) {
                (Some(digest), Some(length)) => Some(crate::replica::attachment_move_artifact_ref(
                    &account.to_owned().into(),
                    &operation_id,
                    &attachment_id,
                    digest,
                    length,
                )?),
                (None, None) => None,
                _ => return Err(corrupt()),
            };
            let metadata_json = metadata(
                json!({"accountId":account,"operationId":operation_id,"attachmentId":attachment_id,"generation":generation,"current":integer(row,"current")? == 1,"publicationState":state,"durableChunkCount":count,"durableByteLength":length,"minimumChunkIndex":minimum,"maximumChunkIndex":maximum,"artifactId":artifact.as_ref().map(|value| &value.artifact_id),"ciphertextSha256":digest,"byteLength":length_final.map(|value|value.to_string()),"chunkCount":length_final.map(|value|value.div_ceil(CHUNK_BYTES as u64))}),
            )?;
            (
                Record::ProvisionalMetadata {
                    account_id,
                    operation_id,
                    attachment_id,
                    generation,
                    metadata_json,
                },
                None,
            )
        }
        5 => (
            Record::ProvisionalChunk {
                account_id,
                operation_id: text(row, "operation_id")?,
                attachment_id: text(row, "attachment_id")?,
                generation: text(row, "generation")?,
                chunk_index: index()?,
                chunk_sha256: text(row, "ciphertext_sha256")?,
            },
            Some(binary(row, "ciphertext")?),
        ),
        6 => {
            let operation_id = text(row, "operation_id")?;
            let publication_id = text(row, "publication_id")?;
            let published = match integer(row, "published")? {
                0 => false,
                1 => true,
                _ => return Err(corrupt()),
            };
            // Preserve incomplete native metadata too. Core's existing recovery inventory decides
            // whether it proves an accepted dependency; the adapter must not silently omit it.
            let mut value = json!({"accountId":account,"operationId":operation_id,"vaultId":optional_text(row,"vault_id")?,"byteLength":row.get::<_,Option<i64>>("byte_length").map_err(storage_error)?.map(|value| u64::try_from(value).map_err(|_| corrupt())).transpose()?.map(|value|value.to_string()),"contentType":optional_text(row,"content_type")?,"sha256":optional_text(row,"sha256")?,"published":published});
            if !publication_id.is_empty() {
                value["publicationId"] = json!(publication_id);
                value["protection"] = match optional_text(row, "protection_json")? {
                    Some(raw) => serde_json::from_str(&raw).unwrap_or_else(|_| json!(raw)),
                    None => serde_json::Value::Null,
                };
            } else if optional_text(row, "protection_json")?.is_some() {
                return Err(corrupt());
            }
            let metadata_json = metadata(value)?;
            (
                if publication_id.is_empty() {
                    Record::VaultImageMetadata {
                        account_id,
                        operation_id,
                        metadata_json,
                    }
                } else {
                    Record::ProtectedVaultImageMetadata {
                        account_id,
                        operation_id,
                        publication_id,
                        metadata_json,
                    }
                },
                None,
            )
        }
        7 => {
            let publication_id = text(row, "publication_id")?;
            let operation_id = text(row, "operation_id")?;
            let chunk_index = index()?;
            (
                if publication_id.is_empty() {
                    Record::VaultImageChunk {
                        account_id,
                        operation_id,
                        chunk_index,
                    }
                } else {
                    Record::ProtectedVaultImageChunk {
                        account_id,
                        operation_id,
                        publication_id,
                        chunk_index,
                    }
                },
                Some(binary(row, "plaintext")?),
            )
        }
        _ => return Err(corrupt()),
    })
}
