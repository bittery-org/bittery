//! Bounded plaintext record framing inside the authenticated recovery envelope.
use super::limits::exceeded;
use crate::RecoveryBound;

use crate::replica::persistence_contract::ReplicaStore;
use crate::{RecoveryClassification, RuntimeError, RuntimeErrorCode};
use bittery_crypto_core::replica_recovery::RECOVERY_CHUNK_BYTES;
use serde::{Deserialize, Serialize};
use zeroize::{Zeroize, Zeroizing};

pub(super) use super::limits::MAX_RECORD_BYTES;
const MAX_HEADER_BYTES: usize = 64 * 1024;
pub(super) const MAX_RECORDS: usize = 100_000;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub(crate) enum EntryHeader {
    Manifest {
        version: u32,
        account_id: String,
        server_url: Option<String>,
        user_id: Option<String>,
        classification: RecoveryClassification,
    },
    Report,
    ReplicaHead {
        account_id: String,
    },
    ReplicaRow {
        account_id: String,
        store: ReplicaStore,
        record_id: String,
    },
    ArtifactMetadata {
        account_id: String,
        artifact_id: String,
    },
    ArtifactChunk {
        account_id: String,
        artifact_id: String,
        chunk_index: u32,
        chunk_sha256: String,
    },
    ProvisionalMetadata {
        account_id: String,
        operation_id: String,
        attachment_id: String,
        generation: String,
    },
    ProvisionalChunk {
        account_id: String,
        operation_id: String,
        attachment_id: String,
        generation: String,
        chunk_index: u32,
        chunk_sha256: String,
    },
    VaultImageMetadata {
        account_id: String,
        operation_id: String,
    },
    VaultImageChunk {
        account_id: String,
        operation_id: String,
        chunk_index: u32,
    },
    ProtectedVaultImageMetadata {
        account_id: String,
        operation_id: String,
        publication_id: String,
    },
    ProtectedVaultImageChunk {
        account_id: String,
        operation_id: String,
        publication_id: String,
        chunk_index: u32,
    },
    ProtectedVaultImageKey {
        account_id: String,
        operation_id: String,
        publication_id: String,
    },
}

pub(crate) struct DecodedRecord {
    pub header: EntryHeader,
    pub body: Zeroizing<Vec<u8>>,
}

fn invalid() -> RuntimeError {
    RuntimeError::new(
        RuntimeErrorCode::InvariantViolation,
        "Recovery record is invalid or exceeds its resource bound",
    )
}

pub(super) fn encode_prefix(
    header: &EntryHeader,
    body_length: usize,
) -> Result<Vec<u8>, RuntimeError> {
    if body_length > MAX_RECORD_BYTES {
        return Err(exceeded(RecoveryBound::RecordBytes));
    }
    let encoded = serde_json::to_vec(header).map_err(|_| invalid())?;
    if encoded.len() > MAX_HEADER_BYTES {
        return Err(exceeded(RecoveryBound::RecordBytes));
    }
    let mut prefix = Vec::with_capacity(8 + encoded.len());
    prefix.extend_from_slice(&(encoded.len() as u32).to_be_bytes());
    prefix.extend_from_slice(&(body_length as u32).to_be_bytes());
    prefix.extend_from_slice(&encoded);
    Ok(prefix)
}

#[derive(Default)]
pub(super) struct RecordDecoder {
    prefix: Vec<u8>,
    header_bytes: Vec<u8>,
    header: Option<EntryHeader>,
    body: Zeroizing<Vec<u8>>,
    lengths: Option<(usize, usize)>,
    records: usize,
    failed: bool,
}
impl RecordDecoder {
    pub(super) fn push(&mut self, input: &[u8]) -> Result<Vec<DecodedRecord>, RuntimeError> {
        if input.len() > RECOVERY_CHUNK_BYTES {
            self.failed = true;
            self.body.zeroize();
            return Err(exceeded(RecoveryBound::ChunkBytes));
        }
        if self.failed {
            self.failed = true;
            self.body.zeroize();
            return Err(invalid());
        }
        match self.decode(input) {
            Ok(records) => Ok(records),
            Err(error) => {
                self.failed = true;
                self.body.zeroize();
                Err(error)
            }
        }
    }
    fn decode(&mut self, mut input: &[u8]) -> Result<Vec<DecodedRecord>, RuntimeError> {
        let mut output = Vec::new();
        while !input.is_empty()
            || self
                .lengths
                .is_some_and(|(_, body)| self.header.is_some() && self.body.len() == body)
        {
            if self.lengths.is_none() {
                let take = (8 - self.prefix.len()).min(input.len());
                self.prefix.extend_from_slice(&input[..take]);
                input = &input[take..];
                if self.prefix.len() < 8 {
                    break;
                }
                let header = u32::from_be_bytes(self.prefix[..4].try_into().map_err(|_| invalid())?)
                    as usize;
                let body = u32::from_be_bytes(self.prefix[4..].try_into().map_err(|_| invalid())?)
                    as usize;
                if header == 0 {
                    return Err(invalid());
                }
                if header > MAX_HEADER_BYTES || body > MAX_RECORD_BYTES {
                    return Err(exceeded(RecoveryBound::RecordBytes));
                }
                if self.records >= MAX_RECORDS {
                    return Err(exceeded(RecoveryBound::RecordCount));
                }
                self.lengths = Some((header, body));
            }
            let (header_length, body_length) = self.lengths.ok_or_else(invalid)?;
            if self.header.is_none() {
                let take = (header_length - self.header_bytes.len()).min(input.len());
                self.header_bytes.extend_from_slice(&input[..take]);
                input = &input[take..];
                if self.header_bytes.len() < header_length {
                    break;
                }
                self.header =
                    Some(serde_json::from_slice(&self.header_bytes).map_err(|_| invalid())?);
                if matches!(self.header, Some(EntryHeader::Report))
                    && body_length > super::report::MAX_REPORT_BYTES
                {
                    return Err(exceeded(RecoveryBound::ReportBytes));
                }
                if matches!(
                    self.header,
                    Some(
                        EntryHeader::ProtectedVaultImageMetadata { .. }
                            | EntryHeader::ProtectedVaultImageKey { .. }
                    )
                ) && body_length > 8192
                {
                    return Err(exceeded(RecoveryBound::RecordBytes));
                }
                // Allocate only after checking the record-specific bound, before copying plaintext.
                self.body = Zeroizing::new(Vec::with_capacity(body_length));
            }
            let take = (body_length - self.body.len()).min(input.len());
            self.body.extend_from_slice(&input[..take]);
            input = &input[take..];
            if self.body.len() < body_length {
                break;
            }
            output.push(DecodedRecord {
                header: self.header.take().ok_or_else(invalid)?,
                body: std::mem::take(&mut self.body),
            });
            self.records += 1;
            self.prefix.clear();
            self.header_bytes.clear();
            self.lengths = None;
        }
        Ok(output)
    }
    pub(super) fn finish(self) -> Result<(), RuntimeError> {
        if self.failed || !self.prefix.is_empty() || self.lengths.is_some() {
            return Err(invalid());
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recovery_record_decoder_handles_arbitrary_envelope_chunk_boundaries() {
        let header = EntryHeader::ReplicaRow {
            account_id: "account".into(),
            store: ReplicaStore::Operations,
            record_id: "operation".into(),
        };
        let body = br#"{"body":[0,255],"literal":"\\\""}"#;
        let prefix = encode_prefix(&header, body.len()).unwrap();
        let mut decoder = RecordDecoder::default();
        let mut records = Vec::new();
        for byte in prefix.iter().chain(body) {
            records.extend(decoder.push(&[*byte]).unwrap());
        }
        decoder.finish().unwrap();
        assert_eq!(records.len(), 1);
        assert_eq!(records[0].header, header);
        assert_eq!(records[0].body.as_slice(), body);
    }

    #[test]
    fn recovery_record_decoder_refuses_allocation_beyond_bound_before_reading_payload() {
        let mut decoder = RecordDecoder::default();
        let mut bytes = 1_u32.to_be_bytes().to_vec();
        bytes.extend_from_slice(&((MAX_RECORD_BYTES + 1) as u32).to_be_bytes());
        assert!(decoder.push(&bytes).is_err());
        assert!(decoder.push(&[]).is_err());
    }

    #[test]
    fn recovery_record_decoder_oversized_input_retires_and_clears_partial_plaintext() {
        let header = EntryHeader::VaultImageChunk {
            account_id: "a".into(),
            operation_id: "o".into(),
            chunk_index: 0,
        };
        let mut input = encode_prefix(&header, 1024).unwrap();
        input.extend_from_slice(b"private image prefix");
        let mut decoder = RecordDecoder::default();
        assert!(decoder.push(&input).unwrap().is_empty());
        assert!(!decoder.body.is_empty());
        assert!(decoder.push(&vec![0; RECOVERY_CHUNK_BYTES + 1]).is_err());
        assert!(decoder.body.is_empty());
        assert!(decoder.finish().is_err());
    }

    #[test]
    fn recovery_record_decoder_rejects_truncated_and_unknown_headers() {
        let mut decoder = RecordDecoder::default();
        assert!(decoder.push(&[0, 0, 0]).unwrap().is_empty());
        assert!(decoder.finish().is_err());
        let header = br#"{"type":"replicaHead","accountId":"a","extra":true}"#;
        let mut input = (header.len() as u32).to_be_bytes().to_vec();
        input.extend_from_slice(&0_u32.to_be_bytes());
        input.extend_from_slice(header);
        assert!(RecordDecoder::default().push(&input).is_err());
    }
}
