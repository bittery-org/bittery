//! Fixed encrypted Attachment metadata for one accepted cross-Account Move.

use super::move_error;
use crate::{
    replica::{
        AuthorityAttachmentRecord, CrossAccountMoveAttachmentCheckpoint,
        CrossAccountMoveAttachmentProgress, PreparedMoveAttachment,
    },
    RuntimeError,
};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use bittery_crypto_core::{
    decrypt_with_aad, encrypt_with_aad, generate_encryption_key, generate_uuid, AadContext,
    EncryptedData,
};
use zeroize::Zeroizing;

pub(super) fn prepare_checkpoint(
    source: &AuthorityAttachmentRecord,
    target_vault_id: &str,
    target_user_id: &str,
    source_vault_key: &[u8],
    target_vault_key: &[u8],
) -> Result<CrossAccountMoveAttachmentCheckpoint, RuntimeError> {
    if source.file_size < 0 {
        return Err(move_error("Source Attachment size is invalid"));
    }
    let source_key = source_key(source, source_vault_key)?;
    let name = Zeroizing::new(
        decrypt_with_aad(
            &EncryptedData {
                ciphertext: source.encrypted_name.clone(),
                iv: source.encryption_iv.clone(),
                algorithm: source.encryption_algorithm.clone(),
            },
            source_key.as_slice(),
            &scope(
                &source.vault_id,
                &source.id,
                &source.uploaded_by,
                "attachment_name",
                1,
            ),
        )
        .map_err(|_| move_error("Source Attachment name could not be opened"))?,
    );
    let content_type = Zeroizing::new(
        decrypt_with_aad(
            &EncryptedData {
                ciphertext: source.encrypted_content_type.clone(),
                iv: source.encrypted_content_type_iv.clone(),
                algorithm: source.encryption_algorithm.clone(),
            },
            source_key.as_slice(),
            &scope(
                &source.vault_id,
                &source.id,
                &source.uploaded_by,
                "attachment_content_type",
                1,
            ),
        )
        .map_err(|_| move_error("Source Attachment content type could not be opened"))?,
    );
    let target_attachment_id = generate_uuid();
    let target_key = Zeroizing::new(generate_encryption_key());
    let target_scope = |kind| {
        scope(
            target_vault_id,
            &target_attachment_id,
            target_user_id,
            kind,
            1,
        )
    };
    let encoded_target_key = Zeroizing::new(BASE64.encode(target_key.as_slice()));
    let wrapped_key = encrypt_with_aad(
        &encoded_target_key,
        target_vault_key,
        &target_scope("attachment_key"),
    )
    .map_err(|_| move_error("Target Attachment key could not be wrapped"))?;
    let encrypted_name = encrypt_with_aad(
        &name,
        target_key.as_slice(),
        &target_scope("attachment_name"),
    )
    .map_err(|_| move_error("Target Attachment name could not be encrypted"))?;
    let encrypted_content_type = encrypt_with_aad(
        &content_type,
        target_key.as_slice(),
        &target_scope("attachment_content_type"),
    )
    .map_err(|_| move_error("Target Attachment content type could not be encrypted"))?;
    Ok(CrossAccountMoveAttachmentCheckpoint {
        source_attachment_id: source.id.clone(),
        target_attachment_id,
        target_metadata: PreparedMoveAttachment {
            encrypted_name: encrypted_name.ciphertext,
            encryption_iv: encrypted_name.iv,
            encryption_algorithm: encrypted_name.algorithm,
            encrypted_attachment_key: wrapped_key.ciphertext,
            attachment_key_iv: wrapped_key.iv,
            attachment_key_algorithm: wrapped_key.algorithm,
            encrypted_content_type: encrypted_content_type.ciphertext,
            encrypted_content_type_iv: encrypted_content_type.iv,
        },
        progress: CrossAccountMoveAttachmentProgress::Pending,
    })
}

pub(super) fn source_key(
    source: &AuthorityAttachmentRecord,
    vault_key: &[u8],
) -> Result<Zeroizing<[u8; 32]>, RuntimeError> {
    let version = u64::try_from(source.envelope_version)
        .ok()
        .filter(|version| *version > 0)
        .ok_or_else(|| move_error("Source Attachment envelope version is invalid"))?;
    open_key(
        EncryptedData {
            ciphertext: source.encrypted_attachment_key.clone(),
            iv: source.attachment_key_iv.clone(),
            algorithm: source.attachment_key_algorithm.clone(),
        },
        vault_key,
        scope(
            &source.vault_id,
            &source.id,
            &source.uploaded_by,
            "attachment_key",
            version,
        ),
    )
}

pub(super) fn target_key(
    checkpoint: &CrossAccountMoveAttachmentCheckpoint,
    target_vault_id: &str,
    target_user_id: &str,
    vault_key: &[u8],
) -> Result<Zeroizing<[u8; 32]>, RuntimeError> {
    let metadata = &checkpoint.target_metadata;
    open_key(
        EncryptedData {
            ciphertext: metadata.encrypted_attachment_key.clone(),
            iv: metadata.attachment_key_iv.clone(),
            algorithm: metadata.attachment_key_algorithm.clone(),
        },
        vault_key,
        scope(
            target_vault_id,
            &checkpoint.target_attachment_id,
            target_user_id,
            "attachment_key",
            1,
        ),
    )
}

fn open_key(
    encrypted: EncryptedData,
    vault_key: &[u8],
    scope: AadContext,
) -> Result<Zeroizing<[u8; 32]>, RuntimeError> {
    let encoded = Zeroizing::new(
        decrypt_with_aad(&encrypted, vault_key, &scope)
            .map_err(|_| move_error("Attachment key could not be opened"))?,
    );
    let decoded = Zeroizing::new(
        BASE64
            .decode(encoded.as_bytes())
            .map_err(|_| move_error("Attachment key encoding is invalid"))?,
    );
    Ok(Zeroizing::new(
        <[u8; 32]>::try_from(decoded.as_slice())
            .map_err(|_| move_error("Attachment key has the wrong length"))?,
    ))
}

fn scope(
    vault_id: &str,
    attachment_id: &str,
    user_id: &str,
    kind: &str,
    version: u64,
) -> AadContext {
    AadContext {
        vault_id: vault_id.into(),
        entity_id: attachment_id.into(),
        entity_type: kind.into(),
        version,
        user_id: user_id.into(),
    }
}
