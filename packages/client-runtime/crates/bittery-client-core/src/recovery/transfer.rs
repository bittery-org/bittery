use super::archive::{encode_prefix, EntryHeader, MAX_RECORD_BYTES};
use super::control::{
    RecoveryControlRequest as Request, RecoveryControlResponse as Response, RecoveryRecord,
    RecoveryUnavailableReason, SerializedRecoveryExecutor,
};
use super::limits::exceeded;
use crate::RecoveryBound;
use crate::{
    AccountId, RecoveryClassification, RequestCancellation, RuntimeError, RuntimeErrorCode,
};
use bittery_crypto_core::replica_recovery::{RecoveryEncryptor, RECOVERY_CHUNK_BYTES};
use std::{collections::HashSet, sync::Arc};
use zeroize::{Zeroize, Zeroizing};

pub(crate) struct RecoveryPort {
    executor: Arc<dyn SerializedRecoveryExecutor>,
    platform_storage: Option<crate::platform_storage::PlatformStorage>,
    physical_schemas: std::sync::Mutex<Option<super::control::RecoveryPhysicalSchemas>>,
    pub recovery_id: String,
    pub cancellation: RequestCancellation,
}
impl RecoveryPort {
    pub fn new(
        executor: Arc<dyn SerializedRecoveryExecutor>,
        recovery_id: String,
        cancellation: RequestCancellation,
    ) -> Self {
        Self {
            executor,
            platform_storage: None,
            physical_schemas: std::sync::Mutex::new(None),
            recovery_id,
            cancellation,
        }
    }
    pub(crate) fn with_platform_storage(
        mut self,
        storage: crate::platform_storage::PlatformStorage,
    ) -> Self {
        self.platform_storage = Some(storage);
        self
    }
    pub(super) async fn image_device_key(
        &self,
    ) -> Result<crate::platform_storage::DeviceKeyDocument, RuntimeError> {
        if self.cancellation.is_cancelled() {
            return Err(cancelled());
        }
        let storage = self
            .platform_storage
            .as_ref()
            .ok_or_else(|| unavailable(RecoveryUnavailableReason::StorageUnavailable))?;
        let key = storage
            .load_device_key()
            .await?
            .ok_or_else(|| unavailable(RecoveryUnavailableReason::StorageUnavailable))?;
        if self.cancellation.is_cancelled() {
            return Err(cancelled());
        }
        Ok(key)
    }
    pub(crate) fn record_physical_schemas(
        &self,
        schemas: super::control::RecoveryPhysicalSchemas,
    ) -> bool {
        if schemas.replica_version == 0
            || schemas.attachment_artifacts_version == 0
            || schemas.vault_images_version == 0
        {
            return false;
        }
        *self
            .physical_schemas
            .lock()
            .expect("Recovery provenance lock poisoned") = Some(schemas);
        true
    }
    pub(crate) fn physical_schemas(
        &self,
    ) -> Result<super::control::RecoveryPhysicalSchemas, RuntimeError> {
        self.physical_schemas
            .lock()
            .expect("Recovery provenance lock poisoned")
            .ok_or_else(invalid)
    }
    #[cfg(test)]
    pub(crate) fn new_test(
        executor: Arc<dyn SerializedRecoveryExecutor>,
        recovery_id: String,
        cancellation: RequestCancellation,
    ) -> Self {
        let port = Self::new(executor, recovery_id, cancellation);
        assert!(port.record_physical_schemas(super::control::TEST_PHYSICAL_SCHEMAS));
        port
    }
    pub fn cancel(&self) {
        self.cancellation.cancel();
        self.executor.cancel(&self.recovery_id);
    }
    pub async fn invoke(
        &self,
        request: Request,
        bytes: Option<Vec<u8>>,
    ) -> Result<(Response, Option<Zeroizing<Vec<u8>>>), RuntimeError> {
        let (response, bytes) = self.call(request, bytes, true).await?;
        if let Response::LimitExceeded { bound } = response {
            return Err(exceeded(bound));
        }
        if let Response::Unavailable { reason } = response {
            return Err(unavailable(reason));
        }
        Ok((response, bytes))
    }
    pub async fn invoke_cleanup(
        &self,
        request: Request,
        bytes: Option<Vec<u8>>,
    ) -> Result<(Response, Option<Zeroizing<Vec<u8>>>), RuntimeError> {
        let (response, bytes) = self.call(request, bytes, false).await?;
        if let Response::LimitExceeded { bound } = response {
            return Err(exceeded(bound));
        }
        if let Response::Unavailable { reason } = response {
            return Err(unavailable(reason));
        }
        Ok((response, bytes))
    }
    pub(crate) async fn invoke_raw(
        &self,
        request: Request,
        bytes: Option<Vec<u8>>,
    ) -> Result<(Response, Option<Zeroizing<Vec<u8>>>), RuntimeError> {
        self.call(request, bytes, true).await
    }
    async fn call(
        &self,
        request: Request,
        mut bytes: Option<Vec<u8>>,
        observe_cancellation: bool,
    ) -> Result<(Response, Option<Zeroizing<Vec<u8>>>), RuntimeError> {
        if (observe_cancellation && self.cancellation.is_cancelled())
            || bytes
                .as_ref()
                .is_some_and(|bytes| bytes.len() > RECOVERY_CHUNK_BYTES)
        {
            if let Some(bytes) = &mut bytes {
                bytes.zeroize();
            }
            return Err(if self.cancellation.is_cancelled() {
                cancelled()
            } else {
                exceeded(RecoveryBound::ChunkBytes)
            });
        }
        let json = serde_json::to_string(&request).map_err(|_| invalid())?;
        let mut lease = InvocationLease {
            executor: self.executor.as_ref(),
            recovery_id: &self.recovery_id,
            armed: true,
        };
        let invocation = self.executor.invoke(json, bytes);
        tokio::pin!(invocation);
        let result = tokio::select! {
            biased;
            _=self.cancellation.cancelled(),if observe_cancellation=>{self.executor.cancel(&self.recovery_id);invocation.await}
            result=&mut invocation=>result,
        };
        lease.armed = false;
        let (json, bytes) = result?;
        let bytes = bytes.map(Zeroizing::new);
        if json.len() > super::limits::RECOVERY_CONTROL_BYTES {
            return Err(exceeded(RecoveryBound::ControlBytes));
        }
        if bytes
            .as_ref()
            .is_some_and(|bytes| bytes.len() > RECOVERY_CHUNK_BYTES)
        {
            return Err(exceeded(RecoveryBound::ChunkBytes));
        }
        let response: Response = serde_json::from_str(&json).map_err(|_| invalid())?;
        // A committed repair is durable truth even if cancellation raced its acknowledgement.
        if observe_cancellation
            && self.cancellation.is_cancelled()
            && !matches!(response, Response::Repaired)
        {
            return Err(cancelled());
        }
        Ok((response, bytes))
    }
}
struct InvocationLease<'a> {
    executor: &'a dyn SerializedRecoveryExecutor,
    recovery_id: &'a str,
    armed: bool,
}
impl Drop for InvocationLease<'_> {
    fn drop(&mut self) {
        if self.armed {
            self.executor.cancel(self.recovery_id);
        }
    }
}
pub(crate) fn unavailable(reason: RecoveryUnavailableReason) -> RuntimeError {
    RuntimeError::new(
        match reason {
            RecoveryUnavailableReason::Cancelled => RuntimeErrorCode::Cancelled,
            RecoveryUnavailableReason::Quota => RuntimeErrorCode::QuotaExceeded,
            RecoveryUnavailableReason::Corrupt => RuntimeErrorCode::InvariantViolation,
            _ => RuntimeErrorCode::StorageUnavailable,
        },
        "Recovery storage is unavailable",
    )
}
pub(super) fn invalid() -> RuntimeError {
    RuntimeError::new(
        RuntimeErrorCode::InvariantViolation,
        "Recovery input or physical response is invalid",
    )
}
fn cancelled() -> RuntimeError {
    RuntimeError::new(RuntimeErrorCode::Cancelled, "Recovery was cancelled")
}

struct EnvelopeSink<'a> {
    port: &'a RecoveryPort,
    account_id: &'a AccountId,
    capability_id: &'a str,
    encryptor: Option<RecoveryEncryptor>,
    pending: Zeroizing<Vec<u8>>,
    byte_length: u64,
    plaintext_length: u64,
    record_count: usize,
}
impl<'a> EnvelopeSink<'a> {
    async fn new(
        port: &'a RecoveryPort,
        account_id: &'a AccountId,
        capability_id: &'a str,
        password: &str,
    ) -> Result<Self, RuntimeError> {
        let encryptor = RecoveryEncryptor::new(password).map_err(|_| invalid())?;
        let header = encryptor.header().to_vec();
        let mut sink = Self {
            port,
            account_id,
            capability_id,
            encryptor: Some(encryptor),
            pending: Zeroizing::new(Vec::with_capacity(RECOVERY_CHUNK_BYTES)),
            byte_length: 0,
            plaintext_length: 0,
            record_count: 0,
        };
        sink.write_encrypted(&header).await?;
        Ok(sink)
    }
    async fn write_encrypted(&mut self, bytes: &[u8]) -> Result<(), RuntimeError> {
        for chunk in bytes.chunks(RECOVERY_CHUNK_BYTES) {
            let (response, binary) = self
                .port
                .invoke(
                    Request::SinkWrite {
                        recovery_id: self.port.recovery_id.clone(),
                        account_id: self.account_id.as_str().to_owned(),
                        capability_id: self.capability_id.to_owned(),
                    },
                    Some(chunk.to_vec()),
                )
                .await?;
            if !matches!(response, Response::SinkWritten) || binary.is_some() {
                return Err(invalid());
            }
            self.byte_length = self
                .byte_length
                .checked_add(chunk.len() as u64)
                .ok_or_else(invalid)?;
        }
        Ok(())
    }
    async fn push(&mut self, mut bytes: &[u8]) -> Result<(), RuntimeError> {
        self.plaintext_length = self
            .plaintext_length
            .checked_add(bytes.len() as u64)
            .ok_or_else(|| exceeded(RecoveryBound::ArchiveBytes))?;
        if self.plaintext_length
            > bittery_crypto_core::replica_recovery::RECOVERY_MAX_PLAINTEXT_BYTES
        {
            return Err(exceeded(RecoveryBound::ArchiveBytes));
        }
        while !bytes.is_empty() {
            let length = (RECOVERY_CHUNK_BYTES - self.pending.len()).min(bytes.len());
            self.pending.extend_from_slice(&bytes[..length]);
            bytes = &bytes[length..];
            if self.pending.len() == RECOVERY_CHUNK_BYTES {
                let frame = self
                    .encryptor
                    .as_mut()
                    .ok_or_else(invalid)?
                    .seal_chunk(&self.pending)
                    .map_err(|_| invalid())?;
                self.pending.zeroize();
                // Vec::zeroize clears its length while retaining the fixed plaintext allocation.
                self.write_encrypted(&frame).await?;
            }
        }
        Ok(())
    }
    async fn record(&mut self, header: EntryHeader, body: &[u8]) -> Result<(), RuntimeError> {
        if self.record_count >= super::archive::MAX_RECORDS {
            return Err(exceeded(RecoveryBound::RecordCount));
        }
        self.record_count += 1;
        self.push(&encode_prefix(&header, body.len())?).await?;
        self.push(body).await
    }
    async fn finish(mut self) -> Result<u64, RuntimeError> {
        if !self.pending.is_empty() {
            let frame = self
                .encryptor
                .as_mut()
                .ok_or_else(invalid)?
                .seal_chunk(&self.pending)
                .map_err(|_| invalid())?;
            self.pending.zeroize();
            self.write_encrypted(&frame).await?;
        }
        let terminal = self
            .encryptor
            .take()
            .ok_or_else(invalid)?
            .finish()
            .map_err(|_| invalid())?;
        self.write_encrypted(&terminal).await?;
        let (response, binary) = self
            .port
            .invoke(
                Request::SinkCommit {
                    recovery_id: self.port.recovery_id.clone(),
                    account_id: self.account_id.as_str().to_owned(),
                    capability_id: self.capability_id.to_owned(),
                },
                None,
            )
            .await?;
        if !matches!(response, Response::SinkCommitted) || binary.is_some() {
            return Err(invalid());
        }
        Ok(self.byte_length)
    }
}

#[cfg(test)]
pub(crate) async fn export_evidence(
    port: &RecoveryPort,
    account_id: &AccountId,
    server_url: String,
    user_id: String,
    password: &str,
    capability_id: &str,
) -> Result<u64, RuntimeError> {
    let snapshot = super::capture::capture(port, account_id).await?;
    export_snapshot(
        port,
        account_id,
        Some(server_url),
        Some(user_id),
        password,
        capability_id,
        &snapshot,
    )
    .await
    .map(|(length, _)| length)
}
pub(super) fn archive_record(
    record: RecoveryRecord,
    binary: Option<Zeroizing<Vec<u8>>>,
) -> Result<(EntryHeader, Zeroizing<Vec<u8>>), RuntimeError> {
    if record.has_binary() != binary.is_some() {
        return Err(invalid());
    }
    let (header, text) = match record {
        RecoveryRecord::RawReplicaHead {
            account_id,
            payload_json,
        } => (EntryHeader::ReplicaHead { account_id }, Some(payload_json)),
        RecoveryRecord::RawReplicaRow {
            account_id,
            store,
            record_id,
            payload_json,
        } => (
            EntryHeader::ReplicaRow {
                account_id,
                store,
                record_id,
            },
            Some(payload_json),
        ),
        RecoveryRecord::ArtifactMetadata {
            account_id,
            artifact_id,
            metadata_json,
        } => (
            EntryHeader::ArtifactMetadata {
                account_id,
                artifact_id,
            },
            Some(metadata_json),
        ),
        RecoveryRecord::ArtifactChunk {
            account_id,
            artifact_id,
            chunk_index,
            chunk_sha256,
        } => (
            EntryHeader::ArtifactChunk {
                account_id,
                artifact_id,
                chunk_index,
                chunk_sha256,
            },
            None,
        ),
        RecoveryRecord::ProvisionalMetadata {
            account_id,
            operation_id,
            attachment_id,
            generation,
            metadata_json,
        } => (
            EntryHeader::ProvisionalMetadata {
                account_id,
                operation_id,
                attachment_id,
                generation,
            },
            Some(metadata_json),
        ),
        RecoveryRecord::ProvisionalChunk {
            account_id,
            operation_id,
            attachment_id,
            generation,
            chunk_index,
            chunk_sha256,
        } => (
            EntryHeader::ProvisionalChunk {
                account_id,
                operation_id,
                attachment_id,
                generation,
                chunk_index,
                chunk_sha256,
            },
            None,
        ),
        RecoveryRecord::VaultImageMetadata {
            account_id,
            operation_id,
            metadata_json,
        } => (
            EntryHeader::VaultImageMetadata {
                account_id,
                operation_id,
            },
            Some(metadata_json),
        ),
        RecoveryRecord::VaultImageChunk {
            account_id,
            operation_id,
            chunk_index,
        } => (
            EntryHeader::VaultImageChunk {
                account_id,
                operation_id,
                chunk_index,
            },
            None,
        ),
        RecoveryRecord::ProtectedVaultImageMetadata {
            account_id,
            operation_id,
            publication_id,
            metadata_json,
        } => (
            EntryHeader::ProtectedVaultImageMetadata {
                account_id,
                operation_id,
                publication_id,
            },
            Some(metadata_json),
        ),
        RecoveryRecord::ProtectedVaultImageChunk {
            account_id,
            operation_id,
            publication_id,
            chunk_index,
        } => (
            EntryHeader::ProtectedVaultImageChunk {
                account_id,
                operation_id,
                publication_id,
                chunk_index,
            },
            None,
        ),
    };
    let body = match text {
        Some(text) => Zeroizing::new(text.into_bytes()),
        None => binary.ok_or_else(invalid)?,
    };
    if body.len() > MAX_RECORD_BYTES {
        return Err(exceeded(RecoveryBound::RecordBytes));
    }
    Ok((header, body))
}

/// A repeatable immutable input grant. Framing is authenticated before records are yielded, but
/// callers must finish the whole reader (including actual source EOF) before trusting its proof.
pub(crate) struct ArchiveReader<'a> {
    port: &'a RecoveryPort,
    account_id: &'a AccountId,
    capability_id: &'a str,
    source: Zeroizing<Vec<u8>>,
    position: usize,
    source_ended: bool,
    decryptor: bittery_crypto_core::replica_recovery::RecoveryDecryptor,
    decoder: super::archive::RecordDecoder,
    records: std::collections::VecDeque<super::archive::DecodedRecord>,
    finished: bool,
    ciphertext_hash: sha2::Sha256,
    plaintext_length: u64,
}
impl<'a> ArchiveReader<'a> {
    pub(crate) async fn open(
        port: &'a RecoveryPort,
        account_id: &'a AccountId,
        capability_id: &'a str,
        password: &str,
    ) -> Result<Self, RuntimeError> {
        use sha2::Digest;
        let (response, binary) = port
            .invoke(
                Request::SourceRewind {
                    recovery_id: port.recovery_id.clone(),
                    account_id: account_id.as_str().into(),
                    capability_id: capability_id.into(),
                },
                None,
            )
            .await?;
        if !matches!(response, Response::SourceRewound) || binary.is_some() {
            return Err(invalid());
        }
        let mut source = SourcePrefix {
            port,
            account_id,
            capability_id,
            bytes: Zeroizing::new(Vec::new()),
        };
        let mut hash = sha2::Sha256::new();
        source.fill().await?;
        hash.update(source.bytes.as_slice());
        let header_length = bittery_crypto_core::replica_recovery::RECOVERY_HEADER_BYTES;
        // Source reads may return any nonempty bounded chunk, including a split header.
        let mut header = Vec::with_capacity(header_length);
        let mut position = 0;
        while header.len() < header_length {
            let take = (header_length - header.len()).min(source.bytes.len() - position);
            header.extend_from_slice(&source.bytes[position..position + take]);
            position += take;
            if header.len() == header_length {
                break;
            }
            source.fill().await?;
            hash.update(source.bytes.as_slice());
            position = 0;
        }
        let decryptor =
            bittery_crypto_core::replica_recovery::RecoveryDecryptor::new(password, &header)
                .map_err(|_| invalid())?;
        Ok(Self {
            port,
            account_id,
            capability_id,
            source: source.bytes,
            position,
            source_ended: false,
            decryptor,
            decoder: super::archive::RecordDecoder::default(),
            records: std::collections::VecDeque::new(),
            finished: false,
            ciphertext_hash: hash,
            plaintext_length: 0,
        })
    }
    async fn read_bytes(
        &mut self,
        count: usize,
    ) -> Result<Option<Zeroizing<Vec<u8>>>, RuntimeError> {
        use sha2::Digest;
        let mut result = Zeroizing::new(Vec::with_capacity(count));
        while result.len() < count {
            if self.position == self.source.len() {
                if self.source_ended {
                    return if result.is_empty() {
                        Ok(None)
                    } else {
                        Err(invalid())
                    };
                }
                let (response, binary) = self
                    .port
                    .invoke(
                        Request::SourceRead {
                            recovery_id: self.port.recovery_id.clone(),
                            account_id: self.account_id.as_str().into(),
                            capability_id: self.capability_id.into(),
                            max_bytes: RECOVERY_CHUNK_BYTES as u32,
                        },
                        None,
                    )
                    .await?;
                match (response, binary) {
                    (Response::SourceChunk, Some(bytes)) if !bytes.is_empty() => {
                        self.ciphertext_hash.update(bytes.as_slice());
                        self.source = bytes;
                        self.position = 0;
                    }
                    (Response::SourceEnded, None) => {
                        self.source_ended = true;
                        continue;
                    }
                    _ => return Err(invalid()),
                }
            }
            let take = (count - result.len()).min(self.source.len() - self.position);
            result.extend_from_slice(&self.source[self.position..self.position + take]);
            self.position += take;
        }
        Ok(Some(result))
    }
    pub(crate) async fn next(
        &mut self,
    ) -> Result<Option<super::archive::DecodedRecord>, RuntimeError> {
        loop {
            if let Some(record) = self.records.pop_front() {
                return Ok(Some(record));
            }
            if self.finished {
                return Ok(None);
            }
            let prefix = self.read_bytes(9).await?.ok_or_else(invalid)?;
            let ciphertext_length =
                u32::from_be_bytes(prefix[..4].try_into().map_err(|_| invalid())?) as usize;
            if ciphertext_length > RECOVERY_CHUNK_BYTES + 16 {
                return Err(exceeded(RecoveryBound::ChunkBytes));
            }
            if ciphertext_length < 16 {
                return Err(invalid());
            }
            if prefix[4] == 0 {
                self.plaintext_length = self
                    .plaintext_length
                    .checked_add((ciphertext_length - 16) as u64)
                    .ok_or_else(|| exceeded(RecoveryBound::ArchiveBytes))?;
                if self.plaintext_length
                    > bittery_crypto_core::replica_recovery::RECOVERY_MAX_PLAINTEXT_BYTES
                {
                    return Err(exceeded(RecoveryBound::ArchiveBytes));
                }
            }
            let ciphertext = self
                .read_bytes(ciphertext_length)
                .await?
                .ok_or_else(invalid)?;
            let mut frame = Vec::with_capacity(9 + ciphertext_length);
            frame.extend_from_slice(&prefix);
            frame.extend_from_slice(&ciphertext);
            match self.decryptor.open_frame(&frame).map_err(|_| invalid())? {
                Some(plaintext) => self.records.extend(self.decoder.push(&plaintext)?),
                None => {
                    if !self.decryptor.finished() || self.read_bytes(1).await?.is_some() {
                        return Err(invalid());
                    }
                    std::mem::take(&mut self.decoder).finish()?;
                    self.finished = true;
                }
            }
        }
    }
    pub(crate) fn source_fingerprint(&self) -> Result<[u8; 32], RuntimeError> {
        use sha2::Digest;
        if !self.finished || !self.source_ended || !self.records.is_empty() {
            return Err(invalid());
        }
        Ok(self.ciphertext_hash.clone().finalize().into())
    }
}
struct SourcePrefix<'a> {
    port: &'a RecoveryPort,
    account_id: &'a AccountId,
    capability_id: &'a str,
    bytes: Zeroizing<Vec<u8>>,
}
impl SourcePrefix<'_> {
    async fn fill(&mut self) -> Result<(), RuntimeError> {
        let (response, binary) = self
            .port
            .invoke(
                Request::SourceRead {
                    recovery_id: self.port.recovery_id.clone(),
                    account_id: self.account_id.as_str().into(),
                    capability_id: self.capability_id.into(),
                    max_bytes: RECOVERY_CHUNK_BYTES as u32,
                },
                None,
            )
            .await?;
        match (response, binary) {
            (Response::SourceChunk, Some(bytes)) if !bytes.is_empty() => {
                self.bytes = bytes;
                Ok(())
            }
            _ => Err(invalid()),
        }
    }
}

pub(crate) struct PhysicalReader<'a> {
    port: &'a RecoveryPort,
    account_id: &'a AccountId,
    cursor: Option<String>,
    seen: HashSet<String>,
    ended: bool,
    record_keys: HashSet<String>,
    summary_bytes: usize,
}
impl<'a> PhysicalReader<'a> {
    pub(crate) fn new(port: &'a RecoveryPort, account_id: &'a AccountId) -> Self {
        Self {
            port,
            account_id,
            cursor: None,
            seen: HashSet::new(),
            ended: false,
            record_keys: HashSet::new(),
            summary_bytes: 0,
        }
    }
    pub(crate) async fn next(
        &mut self,
    ) -> Result<Option<super::archive::DecodedRecord>, RuntimeError> {
        if self.ended {
            return Ok(None);
        }
        let (response, bytes) = self
            .port
            .invoke(
                Request::ReadEntry {
                    recovery_id: self.port.recovery_id.clone(),
                    account_id: self.account_id.as_str().to_owned(),
                    cursor: self.cursor.take(),
                },
                None,
            )
            .await?;
        match response {
            Response::End if bytes.is_none() => {
                self.ended = true;
                Ok(None)
            }
            Response::Entry {
                cursor,
                next_cursor,
                record,
            } => {
                self.summary_bytes = self
                    .summary_bytes
                    .checked_add(cursor.len())
                    .ok_or_else(|| exceeded(RecoveryBound::SummaryBytes))?;
                if cursor.len() > 1024
                    || next_cursor
                        .as_ref()
                        .is_some_and(|cursor| cursor.len() > 1024)
                {
                    return Err(exceeded(RecoveryBound::CursorBytes));
                }
                if self.summary_bytes > 16 * 1024 * 1024 {
                    return Err(exceeded(RecoveryBound::SummaryBytes));
                }
                if self.seen.len() >= super::archive::MAX_RECORDS {
                    return Err(exceeded(RecoveryBound::RecordCount));
                }
                if record.account_id() != self.account_id.as_str()
                    || cursor.is_empty()
                    || !self.seen.insert(cursor)
                    || next_cursor
                        .as_ref()
                        .is_some_and(|next| next.is_empty() || self.seen.contains(next))
                {
                    return Err(invalid());
                }
                self.ended = next_cursor.is_none();
                self.cursor = next_cursor;
                let (header, body) = archive_record(record, bytes)?;
                let key = super::artifacts::record_key(&header)?;
                self.summary_bytes = self
                    .summary_bytes
                    .checked_add(key.len())
                    .ok_or_else(|| exceeded(RecoveryBound::SummaryBytes))?;
                if self.summary_bytes > 16 * 1024 * 1024 {
                    return Err(exceeded(RecoveryBound::SummaryBytes));
                }
                if !self.record_keys.insert(key) {
                    return Err(invalid());
                }
                Ok(Some(super::archive::DecodedRecord { header, body }))
            }
            _ => Err(invalid()),
        }
    }
}

pub(crate) async fn export_snapshot(
    port: &RecoveryPort,
    account_id: &AccountId,
    server_url: Option<String>,
    user_id: Option<String>,
    password: &str,
    capability_id: &str,
    snapshot: &super::capture::Snapshot,
) -> Result<(u64, RecoveryClassification), RuntimeError> {
    use sha2::Digest;
    let identity_available = server_url.is_some() && user_id.is_some();
    let mut findings = snapshot.findings.clone();
    let device_key =
        super::protected_images::export_device_key(port, snapshot, &mut findings).await?;
    let key_findings = findings.clone().finish()?.iter().any(|finding| {
        matches!(
            finding,
            super::report::RecoveryFinding::UnavailableVaultImageKey { .. }
        )
    });
    let complete = snapshot.complete && identity_available && !key_findings;
    let classification = if complete {
        RecoveryClassification::Complete
    } else {
        RecoveryClassification::Partial
    };
    let result = async {
        if !identity_available {
            findings.push(super::report::RecoveryFinding::IdentityUnavailable);
        }
        let mut export_read_complete = true;
        let mut sink = EnvelopeSink::new(port, account_id, capability_id, password).await?;
        sink.record(
            EntryHeader::Manifest {
                version: if snapshot.artifacts.has_protected_images() {
                    2
                } else {
                    1
                },
                account_id: account_id.as_str().into(),
                server_url,
                user_id,
                classification,
            },
            &[],
        )
        .await?;
        let row_index: std::collections::HashMap<_, _> = snapshot
            .proof
            .as_ref()
            .map(|proof| {
                proof
                    .rows
                    .iter()
                    .map(|row| ((row.store, row.record_id.as_str()), row))
                    .collect()
            })
            .unwrap_or_default();
        let mut reader = PhysicalReader::new(port, account_id);
        let mut count = 0usize;
        let mut row_count = 0usize;
        let mut artifact_count = 0usize;
        let mut saw_head = false;
        loop {
            let record = match reader.next().await {
                Ok(Some(record)) => record,
                Ok(None) => break,
                Err(error)
                    if !complete
                        && count > 0
                        && !matches!(
                            error.code,
                            RuntimeErrorCode::Cancelled | RuntimeErrorCode::SizeRejected
                        ) =>
                {
                    export_read_complete = false;
                    findings.push(super::report::RecoveryFinding::ReadFailure {
                        phase: super::report::ReadPhase::Export,
                        code: error.code,
                    });
                    break;
                }
                Err(error) => return Err(error),
            };
            if complete {
                match &record.header {
                    EntryHeader::ReplicaHead { .. } => {
                        if saw_head
                            || snapshot.head_json.as_deref().map(str::as_bytes)
                                != Some(record.body.as_slice())
                        {
                            return Err(invalid());
                        }
                        saw_head = true;
                    }
                    EntryHeader::ReplicaRow {
                        store, record_id, ..
                    } => {
                        let expected = row_index
                            .get(&(*store, record_id.as_str()))
                            .ok_or_else(invalid)?;
                        if expected.payload_sha256
                            != <[u8; 32]>::from(sha2::Sha256::digest(record.body.as_slice()))
                        {
                            return Err(invalid());
                        }
                        row_count += 1;
                    }
                    _ => {
                        if !snapshot
                            .selection
                            .as_ref()
                            .ok_or_else(invalid)?
                            .includes(&record.header)
                        {
                            continue;
                        }
                        let key = super::artifacts::record_key(&record.header)?;
                        let mut hash = sha2::Sha256::new();
                        hash.update(key.as_bytes());
                        hash.update(record.body.as_slice());
                        if snapshot.artifacts.record_hashes.get(&key)
                            != Some(&<[u8; 32]>::from(hash.finalize()))
                        {
                            return Err(invalid());
                        }
                        artifact_count += 1;
                    }
                }
            }
            let portable = match (&record.header, &device_key) {
                (
                    EntryHeader::ProtectedVaultImageMetadata {
                        operation_id,
                        publication_id,
                        ..
                    },
                    Some(key),
                ) if snapshot
                    .selection
                    .as_ref()
                    .is_some_and(|selection| selection.includes(&record.header)) =>
                {
                    let metadata = snapshot
                        .artifacts
                        .image_metadata(operation_id, publication_id)
                        .ok_or_else(invalid)?;
                    match super::protected_images::portable_key(snapshot, metadata, key) {
                        Ok(key) => Some((
                            EntryHeader::ProtectedVaultImageKey {
                                account_id: account_id.as_str().into(),
                                operation_id: operation_id.clone(),
                                publication_id: publication_id.clone(),
                            },
                            Zeroizing::new(serde_json::to_vec(&key).map_err(|_| invalid())?),
                        )),
                        Err(_) if !complete => None,
                        Err(error) => return Err(error),
                    }
                }
                _ => None,
            };
            sink.record(record.header, &record.body).await?;
            count += 1;
            if let Some((header, key)) = portable {
                sink.record(header, &key).await?;
                count += 1;
            }
        }
        if count == 0 {
            return Err(invalid());
        }
        if complete {
            let proof = snapshot.proof.as_ref().ok_or_else(invalid)?;
            let selection = snapshot.selection.as_ref().ok_or_else(invalid)?;
            let expected_artifacts = snapshot
                .artifacts
                .record_hashes
                .keys()
                .filter(|key| {
                    serde_json::from_str::<EntryHeader>(key)
                        .is_ok_and(|header| selection.includes(&header))
                })
                .count();
            if !saw_head || row_count != proof.rows.len() || artifact_count != expected_artifacts {
                return Err(invalid());
            }
        }
        let report = super::report::RecoveryReport {
            version: 1,
            physical_schemas: port.physical_schemas()?,
            source_read_complete: snapshot.read_complete,
            export_read_complete,
            accepted_work_validated: snapshot.read_complete && snapshot.proof.is_some(),
            artifact_dependencies_validated: snapshot.read_complete
                && snapshot.selection.is_some()
                && !key_findings,
            exported_record_count: u32::try_from(count).map_err(|_| invalid())?,
            findings: findings.finish()?,
        };
        if complete && !report.proves_complete(report.exported_record_count) {
            return Err(invalid());
        }
        sink.record(EntryHeader::Report, &report.encode()?).await?;
        sink.finish().await
    }
    .await;
    match result {
        Ok(length) => Ok((length, classification)),
        Err(error) => {
            let _ = port
                .invoke_cleanup(
                    Request::SinkDiscard {
                        recovery_id: port.recovery_id.clone(),
                        account_id: account_id.as_str().into(),
                        capability_id: capability_id.into(),
                    },
                    None,
                )
                .await;
            Err(error)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::super::archive::RecordDecoder;
    use super::*;
    use bittery_crypto_core::replica_recovery::{RecoveryDecryptor, RECOVERY_HEADER_BYTES};
    use std::sync::Mutex;

    struct EvidenceExecutor {
        records: Vec<(RecoveryRecord, Option<Vec<u8>>)>,
        ciphertext: Mutex<Vec<u8>>,
        writes: Mutex<Vec<usize>>,
        committed: Mutex<bool>,
        discarded: Mutex<bool>,
        source_position: Mutex<usize>,
        fail_at_eof: std::sync::atomic::AtomicBool,
    }
    #[async_trait::async_trait]
    impl SerializedRecoveryExecutor for EvidenceExecutor {
        async fn invoke(
            &self,
            json: String,
            binary: Option<Vec<u8>>,
        ) -> Result<(String, Option<Vec<u8>>), RuntimeError> {
            let request: Request = serde_json::from_str(&json).unwrap();
            let (response, bytes) = match request {
                Request::ReadEntry { cursor, .. } => {
                    let index: usize = cursor.map(|value| value.parse().unwrap()).unwrap_or(0);
                    let (record, binary) = self.records[index].clone();
                    (
                        Response::Entry {
                            cursor: index.to_string(),
                            next_cursor: (index + 1 < self.records.len())
                                .then(|| (index + 1).to_string()),
                            record,
                        },
                        binary,
                    )
                }
                Request::SinkWrite { .. } => {
                    let binary = binary.unwrap();
                    self.writes.lock().unwrap().push(binary.len());
                    self.ciphertext.lock().unwrap().extend(binary);
                    (Response::SinkWritten, None)
                }
                Request::SourceRewind { .. } => {
                    *self.source_position.lock().unwrap() = 0;
                    (Response::SourceRewound, None)
                }
                Request::SourceRead { .. } => {
                    let bytes = self.ciphertext.lock().unwrap();
                    let mut position = self.source_position.lock().unwrap();
                    if *position == bytes.len() {
                        if self.fail_at_eof.load(std::sync::atomic::Ordering::SeqCst) {
                            return Err(RuntimeError::new(
                                RuntimeErrorCode::SourceFailure,
                                "source failed after terminal",
                            ));
                        }
                        (Response::SourceEnded, None)
                    } else {
                        let end = (*position + 17).min(bytes.len());
                        let chunk = bytes[*position..end].to_vec();
                        *position = end;
                        (Response::SourceChunk, Some(chunk))
                    }
                }
                Request::SinkCommit { .. } => {
                    *self.committed.lock().unwrap() = true;
                    (Response::SinkCommitted, None)
                }
                Request::SinkDiscard { .. } => {
                    *self.discarded.lock().unwrap() = true;
                    self.ciphertext.lock().unwrap().clear();
                    (Response::SinkDiscarded, None)
                }
                _ => panic!("unexpected recovery action"),
            };
            Ok((serde_json::to_string(&response).unwrap(), bytes))
        }
    }
    fn executor(records: Vec<(RecoveryRecord, Option<Vec<u8>>)>) -> Arc<EvidenceExecutor> {
        Arc::new(EvidenceExecutor {
            records,
            ciphertext: Mutex::new(Vec::new()),
            writes: Mutex::new(Vec::new()),
            committed: Mutex::new(false),
            discarded: Mutex::new(false),
            source_position: Mutex::new(0),
            fail_at_eof: std::sync::atomic::AtomicBool::new(false),
        })
    }
    fn decode(bytes: &[u8], password: &str) -> Vec<super::super::archive::DecodedRecord> {
        let mut envelope =
            RecoveryDecryptor::new(password, &bytes[..RECOVERY_HEADER_BYTES]).unwrap();
        let mut records = RecordDecoder::default();
        let mut result = Vec::new();
        let mut position = RECOVERY_HEADER_BYTES;
        while position < bytes.len() {
            let length =
                u32::from_be_bytes(bytes[position..position + 4].try_into().unwrap()) as usize + 9;
            if let Some(plaintext) = envelope
                .open_frame(&bytes[position..position + length])
                .unwrap()
            {
                result.extend(records.push(&plaintext).unwrap());
            }
            position += length;
        }
        assert!(envelope.finished());
        assert_eq!(position, bytes.len());
        records.finish().unwrap();
        result
    }
    #[tokio::test]
    async fn failed_domain_evidence_export_preserves_operation_and_plaintext_image_inside_protection(
    ) {
        let account_id = AccountId::from("account-a");
        let operation =
            r#"{"operationId":"accepted-before-failure","request":{"body":[255,0,34]}}"#;
        let image = vec![0x76; RECOVERY_CHUNK_BYTES];
        let records = vec![
            (
                RecoveryRecord::RawReplicaHead {
                    account_id: "account-a".into(),
                    payload_json: "corrupt domain head retained verbatim".into(),
                },
                None,
            ),
            (
                RecoveryRecord::RawReplicaRow {
                    account_id: "account-a".into(),
                    store: crate::replica::persistence_contract::ReplicaStore::Operations,
                    record_id: "accepted-before-failure".into(),
                    payload_json: operation.into(),
                },
                None,
            ),
            (
                RecoveryRecord::VaultImageChunk {
                    account_id: "account-a".into(),
                    operation_id: "accepted-before-failure".into(),
                    chunk_index: 0,
                },
                Some(image.clone()),
            ),
        ];
        let executor = executor(records.clone());
        let port = RecoveryPort::new_test(
            executor.clone(),
            "recovery".into(),
            RequestCancellation::default(),
        );
        let password = Zeroizing::new("separate archive password".to_owned());
        let length = export_evidence(
            &port,
            &account_id,
            "https://server.test".into(),
            "server-user".into(),
            &password,
            "sink",
        )
        .await
        .unwrap();
        let encrypted = executor.ciphertext.lock().unwrap().clone();
        assert_eq!(length, encrypted.len() as u64);
        assert!(!encrypted
            .windows(operation.len())
            .any(|window| window == operation.as_bytes()));
        assert!(!encrypted.windows(64).any(|window| window == &image[..64]));
        assert!(executor
            .writes
            .lock()
            .unwrap()
            .iter()
            .all(|length| *length <= RECOVERY_CHUNK_BYTES));
        let decoded = decode(&encrypted, &password);
        assert_eq!(decoded.len(), 5);
        assert!(matches!(decoded[4].header, EntryHeader::Report));
        let report = super::super::report::RecoveryReport::decode(&decoded[4].body).unwrap();
        assert_eq!(report.exported_record_count, 3);
        assert!(!report.accepted_work_validated);
        assert!(!report.findings.is_empty());
        assert!(matches!(
            decoded[0].header,
            EntryHeader::Manifest {
                classification: RecoveryClassification::Partial,
                ..
            }
        ));
        assert_eq!(decoded[2].body.as_slice(), operation.as_bytes());
        assert_eq!(decoded[3].body.as_slice(), image);
        assert!(executor.records == records);
        assert!(*executor.committed.lock().unwrap());
        assert!(!*executor.discarded.lock().unwrap());
    }
    #[tokio::test]
    async fn authenticated_reader_requires_actual_eof_and_identical_repeatable_source() {
        let executor = executor(vec![(
            RecoveryRecord::RawReplicaHead {
                account_id: "account-a".into(),
                payload_json: "original evidence".into(),
            },
            None,
        )]);
        let port = RecoveryPort::new_test(
            executor.clone(),
            "recovery".into(),
            RequestCancellation::default(),
        );
        let account = AccountId::from("account-a");
        let password = "separate archive password";
        export_evidence(
            &port,
            &account,
            "https://server.test".into(),
            "user".into(),
            password,
            "sink",
        )
        .await
        .unwrap();
        let mut fingerprints = Vec::new();
        for _ in 0..2 {
            let mut reader = ArchiveReader::open(&port, &account, "source", password)
                .await
                .unwrap();
            assert!(reader.source_fingerprint().is_err());
            let mut count = 0;
            while let Some(record) = reader.next().await.unwrap() {
                count += 1;
                if count == 2 {
                    assert_eq!(record.body.as_slice(), b"original evidence");
                } else if count == 3 {
                    assert!(matches!(record.header, EntryHeader::Report));
                    let report =
                        super::super::report::RecoveryReport::decode(&record.body).unwrap();
                    assert_eq!(report.exported_record_count, 1);
                    assert!(!report.accepted_work_validated);
                }
            }
            assert_eq!(count, 3);
            fingerprints.push(reader.source_fingerprint().unwrap());
        }
        assert_eq!(fingerprints[0], fingerprints[1]);
        executor
            .fail_at_eof
            .store(true, std::sync::atomic::Ordering::SeqCst);
        let mut reader = ArchiveReader::open(&port, &account, "source", password)
            .await
            .unwrap();
        assert!(reader.next().await.unwrap().is_some());
        assert!(reader.next().await.unwrap().is_some());
        assert!(matches!(
            reader.next().await.unwrap().unwrap().header,
            EntryHeader::Report
        ));
        assert_eq!(
            reader.next().await.err().unwrap().code,
            RuntimeErrorCode::SourceFailure
        );
        assert!(reader.source_fingerprint().is_err());
        executor
            .fail_at_eof
            .store(false, std::sync::atomic::Ordering::SeqCst);
        executor.ciphertext.lock().unwrap().push(0);
        let mut reader = ArchiveReader::open(&port, &account, "source", password)
            .await
            .unwrap();
        assert!(reader.next().await.unwrap().is_some());
        assert!(reader.next().await.unwrap().is_some());
        assert!(matches!(
            reader.next().await.unwrap().unwrap().header,
            EntryHeader::Report
        ));
        assert!(reader.next().await.is_err());
        assert!(reader.source_fingerprint().is_err());
    }

    #[tokio::test]
    async fn mixed_account_evidence_discards_sink_without_exposing_foreign_record() {
        let executor = executor(vec![(
            RecoveryRecord::RawReplicaHead {
                account_id: "other".into(),
                payload_json: "foreign".into(),
            },
            None,
        )]);
        let port = RecoveryPort::new_test(
            executor.clone(),
            "recovery".into(),
            RequestCancellation::default(),
        );
        assert!(export_evidence(
            &port,
            &AccountId::from("account-a"),
            "https://server.test".into(),
            "user".into(),
            "separate archive password",
            "sink"
        )
        .await
        .is_err());
        assert!(*executor.discarded.lock().unwrap());
        assert!(!*executor.committed.lock().unwrap());
        assert!(executor.ciphertext.lock().unwrap().is_empty());
    }
}
