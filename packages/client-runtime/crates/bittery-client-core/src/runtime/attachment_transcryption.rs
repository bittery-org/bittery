//! Bounded Attachment envelope scanning, transcryption, and artifact publication.
//!
//! Callers own source authorization, cryptographic scope selection, and durable workflow state.
//! A writer becomes a canonical artifact only after the second pass authenticates the source.

use crate::{
    attachment_artifact_store::{
        AttachmentArtifactOwner, ProvisionalAttachmentArtifactStore,
        ProvisionalAttachmentArtifactStoreRequest, ProvisionalAttachmentArtifactStoreResponse,
        ProvisionalAttachmentArtifactWriter, ARTIFACT_CHUNK_BYTES,
    },
    RuntimeError,
};
use async_trait::async_trait;
use bittery_crypto_core::attachment_move::{
    AttachmentBlobScope, AttachmentEnvelopeScan, AttachmentEnvelopeScanner,
    AttachmentMoveTranscryptor, AttachmentPublicationIdentity,
};
use zeroize::Zeroizing;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum DownloadPass {
    Scan,
    Transcrypt,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum PreparationTransportError {
    Transient,
    Busy,
    StaleAuthority,
    Invariant,
}

#[cfg(not(target_arch = "wasm32"))]
#[async_trait]
pub(crate) trait SourceDownload: Send {
    async fn next_chunk(&mut self) -> Result<Option<Vec<u8>>, PreparationTransportError>;
}

#[cfg(target_arch = "wasm32")]
#[async_trait(?Send)]
pub(crate) trait SourceDownload {
    async fn next_chunk(&mut self) -> Result<Option<Vec<u8>>, PreparationTransportError>;
}

#[cfg(not(target_arch = "wasm32"))]
#[async_trait]
pub(crate) trait SourceOpen: Send {
    type Error: Send;

    async fn open(&mut self, pass: DownloadPass) -> Result<Box<dyn SourceDownload>, Self::Error>;
}

#[cfg(target_arch = "wasm32")]
#[async_trait(?Send)]
pub(crate) trait SourceOpen {
    type Error;

    async fn open(&mut self, pass: DownloadPass) -> Result<Box<dyn SourceDownload>, Self::Error>;
}

pub(crate) struct TranscryptionMaterial {
    pub source_key: Zeroizing<[u8; 32]>,
    pub target_key: Zeroizing<[u8; 32]>,
    pub source_scope: AttachmentBlobScope,
    pub target_scope: AttachmentBlobScope,
    pub identity: AttachmentPublicationIdentity,
}

pub(crate) enum TranscryptionError<E> {
    Source(E),
    Transport(PreparationTransportError),
    InvalidInput,
    Artifact(RuntimeError),
    Invariant,
}

pub(crate) async fn scan_source<S: SourceOpen>(
    source: &mut S,
) -> Result<AttachmentEnvelopeScan, TranscryptionError<S::Error>> {
    let mut first = source
        .open(DownloadPass::Scan)
        .await
        .map_err(TranscryptionError::Source)?;
    let mut scanner = AttachmentEnvelopeScanner::new();
    while let Some(chunk) = first
        .next_chunk()
        .await
        .map_err(TranscryptionError::Transport)?
    {
        scanner
            .push(&chunk)
            .map_err(|_| TranscryptionError::InvalidInput)?;
    }
    scanner
        .finish()
        .map_err(|_| TranscryptionError::InvalidInput)
}

pub(crate) async fn transcrypt_source<S: SourceOpen>(
    source: &mut S,
    scan: AttachmentEnvelopeScan,
    material: TranscryptionMaterial,
    writer: ProvisionalAttachmentArtifactWriter,
    store: &dyn ProvisionalAttachmentArtifactStore,
) -> Result<AttachmentArtifactOwner, TranscryptionError<S::Error>> {
    let TranscryptionMaterial {
        source_key,
        target_key,
        source_scope,
        target_scope,
        identity,
    } = material;
    let mut transcryptor = AttachmentMoveTranscryptor::new(
        scan,
        *source_key,
        source_scope,
        *target_key,
        target_scope,
        identity,
    )
    .map_err(|_| TranscryptionError::InvalidInput)?;
    let mut second = source
        .open(DownloadPass::Transcrypt)
        .await
        .map_err(TranscryptionError::Source)?;
    let mut chunks = ArtifactChunker::default();
    while let Some(chunk) = second
        .next_chunk()
        .await
        .map_err(TranscryptionError::Transport)?
    {
        let output = transcryptor
            .push(&chunk)
            .map_err(|_| TranscryptionError::InvalidInput)?;
        chunks.push(&writer, &output, store).await?;
    }
    let finished = transcryptor
        .finish()
        .map_err(|_| TranscryptionError::InvalidInput)?;
    chunks.push(&writer, &finished.final_chunk, store).await?;
    chunks.finish(&writer, store).await?;
    match store
        .invoke_provisional(ProvisionalAttachmentArtifactStoreRequest::Finalize {
            writer,
            publication_proof: finished.publication_proof,
        })
        .await
        .map_err(TranscryptionError::Artifact)?
    {
        ProvisionalAttachmentArtifactStoreResponse::Finalized(owner) => Ok(owner),
        _ => Err(TranscryptionError::Invariant),
    }
}

#[derive(Default)]
struct ArtifactChunker {
    pending: Vec<u8>,
    next_index: u32,
}

impl ArtifactChunker {
    async fn push<E>(
        &mut self,
        writer: &ProvisionalAttachmentArtifactWriter,
        mut bytes: &[u8],
        store: &dyn ProvisionalAttachmentArtifactStore,
    ) -> Result<(), TranscryptionError<E>> {
        while !bytes.is_empty() {
            let take = (ARTIFACT_CHUNK_BYTES - self.pending.len()).min(bytes.len());
            self.pending.extend_from_slice(&bytes[..take]);
            bytes = &bytes[take..];
            if self.pending.len() == ARTIFACT_CHUNK_BYTES {
                self.flush(writer, store).await?;
            }
        }
        Ok(())
    }

    async fn finish<E>(
        &mut self,
        writer: &ProvisionalAttachmentArtifactWriter,
        store: &dyn ProvisionalAttachmentArtifactStore,
    ) -> Result<(), TranscryptionError<E>> {
        if !self.pending.is_empty() {
            self.flush(writer, store).await?;
        }
        Ok(())
    }

    async fn flush<E>(
        &mut self,
        writer: &ProvisionalAttachmentArtifactWriter,
        store: &dyn ProvisionalAttachmentArtifactStore,
    ) -> Result<(), TranscryptionError<E>> {
        let bytes = std::mem::take(&mut self.pending);
        let response = store
            .invoke_provisional(ProvisionalAttachmentArtifactStoreRequest::WriteChunk {
                writer: writer.clone(),
                chunk_index: self.next_index,
                bytes,
            })
            .await
            .map_err(TranscryptionError::Artifact)?;
        if !matches!(
            response,
            ProvisionalAttachmentArtifactStoreResponse::ChunkWritten(_)
        ) {
            return Err(TranscryptionError::Invariant);
        }
        self.next_index = self
            .next_index
            .checked_add(1)
            .ok_or(TranscryptionError::Invariant)?;
        Ok(())
    }
}
