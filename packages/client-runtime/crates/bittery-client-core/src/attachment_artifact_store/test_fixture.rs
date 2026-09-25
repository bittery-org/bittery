//! Shared authenticated ciphertext fixture; excluded from production bindings.
use bittery_crypto_core::{
    attachment_move::{
        AttachmentBlobScope, AttachmentEnvelopeScanner, AttachmentMoveTranscryptor,
        AttachmentPublicationIdentity, AttachmentPublicationProof,
    },
    encrypt_with_aad, AadContext,
};

#[cfg(feature = "binding-test-harness")]
#[doc(hidden)]
pub async fn sweep_attachment_artifact_recovery_test_history(
    store: &dyn super::AttachmentArtifactStore,
    scope: super::ProvisionalAttachmentArtifactScope,
    retain_pending: bool,
) -> Result<usize, crate::RuntimeError> {
    // The hosted fixture closes its only writer's page before constructing this fresh owner.
    // It supplies a Pending scope without inventing a published owner or a Replica checkpoint.
    let response = store
        .invoke(super::AttachmentArtifactStoreRequest::SweepOrphans {
            boundary: super::ExclusiveStartupBoundary::proven_by_runtime_startup(),
            account_id: scope.account_id().clone(),
            live: Vec::new(),
            pending: if retain_pending {
                vec![scope]
            } else {
                Vec::new()
            },
        })
        .await?;
    match response {
        super::AttachmentArtifactStoreResponse::OrphansSwept { deleted } => Ok(deleted),
        _ => Err(super::artifact_error(
            "Recovery fixture sweep returned an unexpected response",
        )),
    }
}

#[cfg(feature = "binding-test-harness")]
#[doc(hidden)]
pub async fn seed_attachment_artifact_recovery_test_history(
    store: &dyn super::ProvisionalAttachmentArtifactStore,
    scope: super::ProvisionalAttachmentArtifactScope,
) -> Result<
    (
        super::AttachmentArtifactOwner,
        super::ProvisionalAttachmentArtifactRecovery,
    ),
    crate::RuntimeError,
> {
    use super::{
        artifact_error, ProvisionalAttachmentArtifactRecovery,
        ProvisionalAttachmentArtifactStoreRequest as Request,
        ProvisionalAttachmentArtifactStoreResponse as Response,
        ProvisionalAttachmentArtifactWriter, ARTIFACT_CHUNK_BYTES,
    };

    let (bytes, proof) = authenticated_target_for(
        &"authenticated recovery ciphertext ".repeat(20_000),
        scope.account_id().as_str(),
        "user-1",
        scope.operation_id(),
        scope.attachment_id(),
    );
    let Response::Begun(writer) = store
        .invoke_provisional(Request::Begin {
            writer: ProvisionalAttachmentArtifactWriter::new(scope.clone()),
        })
        .await?
    else {
        return Err(artifact_error("Recovery fixture already owns a generation"));
    };
    let recovery = ProvisionalAttachmentArtifactRecovery::new(scope, writer.generation())?;
    for (index, chunk) in bytes.chunks(ARTIFACT_CHUNK_BYTES).enumerate() {
        let Response::ChunkWritten(_) = store
            .invoke_provisional(Request::WriteChunk {
                writer: writer.clone(),
                chunk_index: u32::try_from(index)
                    .map_err(|_| artifact_error("Recovery fixture has too many chunks"))?,
                bytes: chunk.to_vec(),
            })
            .await?
        else {
            return Err(artifact_error("Recovery fixture chunk was not retained"));
        };
    }
    let Response::Finalized(owner) = store
        .invoke_provisional(Request::Finalize {
            writer,
            publication_proof: proof,
        })
        .await?
    else {
        return Err(artifact_error("Recovery fixture did not finalize"));
    };
    Ok((owner, recovery))
}

pub(crate) fn authenticated_target_for(
    plaintext: &str,
    account_id: &str,
    user_id: &str,
    operation_id: &str,
    attachment_id: &str,
) -> (Vec<u8>, AttachmentPublicationProof) {
    authenticated_target_for_vaults(
        plaintext,
        account_id,
        user_id,
        operation_id,
        attachment_id,
        "vault-source",
        "vault-target",
    )
}

pub(crate) fn authenticated_target_for_vaults(
    plaintext: &str,
    account_id: &str,
    user_id: &str,
    operation_id: &str,
    attachment_id: &str,
    source_vault: &str,
    target_vault: &str,
) -> (Vec<u8>, AttachmentPublicationProof) {
    let source_key = [31_u8; 32];
    let target_key = [47_u8; 32];
    let source_context = AadContext {
        vault_id: source_vault.into(),
        entity_id: attachment_id.into(),
        entity_type: "attachment_blob".into(),
        version: 1,
        user_id: user_id.into(),
    };
    let source =
        serde_json::to_vec(&encrypt_with_aad(plaintext, &source_key, &source_context).unwrap())
            .unwrap();
    let mut scanner = AttachmentEnvelopeScanner::new();
    for chunk in source.chunks(8_191) {
        scanner.push(chunk).unwrap();
    }
    let mut transcryptor = AttachmentMoveTranscryptor::new(
        scanner.finish().unwrap(),
        source_key,
        AttachmentBlobScope::new(source_vault.into(), attachment_id.into(), user_id.into()),
        target_key,
        AttachmentBlobScope::new(target_vault.into(), attachment_id.into(), user_id.into()),
        AttachmentPublicationIdentity::new(
            account_id.into(),
            user_id.into(),
            operation_id.into(),
            attachment_id.into(),
        )
        .unwrap(),
    )
    .unwrap();
    let mut target = Vec::new();
    for chunk in source.chunks(7_919) {
        target.extend(transcryptor.push(chunk).unwrap());
    }
    let finished = transcryptor.finish().unwrap();
    target.extend(finished.final_chunk);
    (target, finished.publication_proof)
}
