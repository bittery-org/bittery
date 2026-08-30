//! Bounded-memory, format-preserving Attachment blob transcryption.
//!
//! Bytes emitted by [`AttachmentMoveTranscryptor::push`] are provisional. They
//! must not be published unless `finish` also returns its opaque proof.

use aes::{
    cipher::{BlockCipherEncrypt, KeyInit},
    Aes256,
};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use ghash::{universal_hash::UniversalHash, GHash};
use rand::Rng;
use sha2::{Digest, Sha256};
use subtle::ConstantTimeEq;
use thiserror::Error;
use zeroize::{Zeroize, Zeroizing};

use crate::system_rng;

pub const ATTACHMENT_ENCRYPTION_ALGORITHM: &str = "AES-GCM-AAD-V1";
pub const MAX_ATTACHMENT_ENVELOPE_INPUT_CHUNK: usize = 256 * 1024;

const IV_LENGTH: usize = 12;
const TAG_LENGTH: usize = 16;
const MAX_TOKEN_LENGTH: usize = 64;
const MAX_AAD_LENGTH: usize = 4096;
const MAX_GCM_TEXT_LENGTH: u64 = (1 << 36) - 32;
const TARGET_PREFIX: &[u8] = br#"{"ciphertext":""#;

#[derive(Debug, Error, Clone, PartialEq, Eq)]
pub enum AttachmentMoveCryptoError {
    #[error("attachment envelope is invalid")]
    InvalidEnvelope,
    #[error("attachment envelope chunk exceeds the bounded input limit")]
    InputChunkTooLarge,
    #[error("attachment key must contain exactly 32 bytes")]
    InvalidKey,
    #[error("attachment scope is too large")]
    ScopeTooLarge,
    #[error("attachment ciphertext authentication failed")]
    AuthenticationFailed,
    #[error("attachment is too large for AES-GCM")]
    AttachmentTooLarge,
    #[error("target nonce would reuse the source key and nonce")]
    NonceReuse,
}

/// Bounded first-pass result. It deliberately carries no ciphertext.
pub struct AttachmentEnvelopeScan {
    source_iv: [u8; IV_LENGTH],
    envelope_hash: [u8; 32],
}

impl AttachmentEnvelopeScan {
    pub fn source_iv(&self) -> &[u8; IV_LENGTH] {
        &self.source_iv
    }

    pub fn algorithm(&self) -> &'static str {
        ATTACHMENT_ENCRYPTION_ALGORITHM
    }
}

pub struct AttachmentEnvelopeScanner {
    parser: Option<EnvelopeParser>,
    envelope_hash: Sha256,
}

/// Bounded-memory second-pass decoder for the unchanged Attachment blob envelope.
///
/// Bytes returned by [`push`](Self::push) are unauthenticated until [`finish`](Self::finish)
/// succeeds. Callers must therefore write them only to an atomic provisional sink.
pub struct AttachmentBlobDecryptor {
    parser: Option<EnvelopeParser>,
    source: Option<GcmStream>,
    source_tag: [u8; TAG_LENGTH],
    source_tag_len: usize,
    scanned_iv: [u8; IV_LENGTH],
    expected_envelope_hash: [u8; 32],
    envelope_hash: Sha256,
    plaintext_base64: PlaintextBase64Decoder,
}

impl AttachmentBlobDecryptor {
    pub fn new(
        scan: AttachmentEnvelopeScan,
        source_key: [u8; 32],
        source_scope: AttachmentBlobScope,
    ) -> Result<Self, AttachmentMoveCryptoError> {
        let source_key = Zeroizing::new(source_key);
        let source_aad = Zeroizing::new(source_scope.aad_bytes()?);
        Ok(Self {
            parser: Some(EnvelopeParser::new()),
            source: Some(GcmStream::new(&source_key, scan.source_iv, &source_aad)?),
            source_tag: [0; TAG_LENGTH],
            source_tag_len: 0,
            scanned_iv: scan.source_iv,
            expected_envelope_hash: scan.envelope_hash,
            envelope_hash: Sha256::new(),
            plaintext_base64: PlaintextBase64Decoder::default(),
        })
    }

    pub fn push(&mut self, bytes: &[u8]) -> Result<Vec<u8>, AttachmentMoveCryptoError> {
        if bytes.len() > MAX_ATTACHMENT_ENVELOPE_INPUT_CHUNK {
            return Err(AttachmentMoveCryptoError::InputChunkTooLarge);
        }
        self.envelope_hash.update(bytes);
        let decoded = self
            .parser
            .as_mut()
            .ok_or(AttachmentMoveCryptoError::InvalidEnvelope)?
            .push(bytes)?;
        let mut output = Vec::with_capacity(decoded.len());
        for byte in decoded {
            if self.source_tag_len < TAG_LENGTH {
                self.source_tag[self.source_tag_len] = byte;
                self.source_tag_len += 1;
                continue;
            }
            let ciphertext = self.source_tag[0];
            self.source_tag.copy_within(1.., 0);
            self.source_tag[TAG_LENGTH - 1] = byte;
            let Some(source) = self.source.as_mut() else {
                output.zeroize();
                return Err(AttachmentMoveCryptoError::InvalidEnvelope);
            };
            let mut encoded_plaintext = match source.decrypt_byte(ciphertext) {
                Ok(value) => value,
                Err(error) => {
                    output.zeroize();
                    return Err(error);
                }
            };
            let result = self.plaintext_base64.push(encoded_plaintext, &mut output);
            encoded_plaintext.zeroize();
            if let Err(error) = result {
                output.zeroize();
                return Err(error);
            }
        }
        Ok(output)
    }

    pub fn finish(mut self) -> Result<Vec<u8>, AttachmentMoveCryptoError> {
        let metadata = self
            .parser
            .take()
            .ok_or(AttachmentMoveCryptoError::InvalidEnvelope)?
            .finish()?;
        let envelope_hash: [u8; 32] = self.envelope_hash.clone().finalize().into();
        if metadata.iv != self.scanned_iv
            || envelope_hash
                .ct_eq(&self.expected_envelope_hash)
                .unwrap_u8()
                != 1
            || self.source_tag_len != TAG_LENGTH
        {
            return Err(AttachmentMoveCryptoError::InvalidEnvelope);
        }
        let actual_tag = Zeroizing::new(
            self.source
                .take()
                .ok_or(AttachmentMoveCryptoError::InvalidEnvelope)?
                .finish()?,
        );
        if actual_tag.ct_eq(&self.source_tag).unwrap_u8() != 1 {
            self.source_tag.zeroize();
            return Err(AttachmentMoveCryptoError::AuthenticationFailed);
        }
        self.source_tag.zeroize();
        self.plaintext_base64.finish()
    }

    fn zeroize_sensitive_state(&mut self) {
        self.source_tag.zeroize();
        self.source_tag_len = 0;
    }
}

impl Drop for AttachmentBlobDecryptor {
    fn drop(&mut self) {
        self.zeroize_sensitive_state();
    }
}

struct PlaintextBase64Decoder {
    inner: Base64Decoder,
}

impl Default for PlaintextBase64Decoder {
    fn default() -> Self {
        Self {
            inner: Base64Decoder::new(),
        }
    }
}

impl PlaintextBase64Decoder {
    fn push(&mut self, byte: u8, output: &mut Vec<u8>) -> Result<(), AttachmentMoveCryptoError> {
        self.inner.push(byte, output)
    }

    fn finish(&mut self) -> Result<Vec<u8>, AttachmentMoveCryptoError> {
        self.inner.finish()?;
        Ok(Vec::new())
    }
}

impl AttachmentEnvelopeScanner {
    pub fn new() -> Self {
        Self {
            parser: Some(EnvelopeParser::new()),
            envelope_hash: Sha256::new(),
        }
    }

    pub fn push(&mut self, bytes: &[u8]) -> Result<(), AttachmentMoveCryptoError> {
        if bytes.len() > MAX_ATTACHMENT_ENVELOPE_INPUT_CHUNK {
            self.parser.take();
            return Err(AttachmentMoveCryptoError::InputChunkTooLarge);
        }
        self.envelope_hash.update(bytes);
        let result = self
            .parser
            .as_mut()
            .ok_or(AttachmentMoveCryptoError::InvalidEnvelope)?
            .push(bytes);
        match result {
            Ok(_) => Ok(()),
            Err(error) => {
                self.parser.take();
                Err(error)
            }
        }
    }

    pub fn finish(mut self) -> Result<AttachmentEnvelopeScan, AttachmentMoveCryptoError> {
        let metadata = self
            .parser
            .take()
            .ok_or(AttachmentMoveCryptoError::InvalidEnvelope)?
            .finish()?;
        Ok(AttachmentEnvelopeScan {
            source_iv: metadata.iv,
            envelope_hash: self.envelope_hash.finalize().into(),
        })
    }

    #[cfg(test)]
    fn buffered_bytes(&self) -> usize {
        self.parser
            .as_ref()
            .map_or(0, EnvelopeParser::buffered_bytes)
    }
}

impl Default for AttachmentEnvelopeScanner {
    fn default() -> Self {
        Self::new()
    }
}

/// Constructs the fixed Attachment blob AAD (`attachment_blob`, version 1).
pub struct AttachmentBlobScope {
    vault_id: String,
    attachment_id: String,
    user_id: String,
}

impl AttachmentBlobScope {
    pub fn new(vault_id: String, attachment_id: String, user_id: String) -> Self {
        Self {
            vault_id,
            attachment_id,
            user_id,
        }
    }

    fn aad_bytes(&self) -> Result<Vec<u8>, AttachmentMoveCryptoError> {
        if self.vault_id.contains('\0')
            || self.attachment_id.contains('\0')
            || self.user_id.contains('\0')
        {
            return Err(AttachmentMoveCryptoError::InvalidEnvelope);
        }
        let length = self
            .vault_id
            .len()
            .checked_add(self.attachment_id.len())
            .and_then(|length| length.checked_add(self.user_id.len()))
            .and_then(|length| length.checked_add(20))
            .ok_or(AttachmentMoveCryptoError::ScopeTooLarge)?;
        if length > MAX_AAD_LENGTH {
            return Err(AttachmentMoveCryptoError::ScopeTooLarge);
        }
        let mut aad = Vec::with_capacity(length);
        aad.extend_from_slice(self.vault_id.as_bytes());
        aad.push(0);
        aad.extend_from_slice(self.attachment_id.as_bytes());
        aad.push(0);
        aad.extend_from_slice(b"attachment_blob");
        aad.push(0);
        aad.extend_from_slice(b"1");
        aad.push(0);
        aad.extend_from_slice(self.user_id.as_bytes());
        Ok(aad)
    }
}

pub struct AttachmentPublicationIdentity {
    account_id: String,
    user_id: String,
    operation_id: String,
    attachment_id: String,
}

impl AttachmentPublicationIdentity {
    pub fn new(
        account_id: String,
        user_id: String,
        operation_id: String,
        attachment_id: String,
    ) -> Result<Self, AttachmentMoveCryptoError> {
        if [&account_id, &user_id, &operation_id, &attachment_id]
            .into_iter()
            .any(|value| value.is_empty() || value.contains('\0'))
        {
            return Err(AttachmentMoveCryptoError::InvalidEnvelope);
        }
        Ok(Self {
            account_id,
            user_id,
            operation_id,
            attachment_id,
        })
    }
}

/// Unforgeable authority granted only after source authentication succeeds.
pub struct AttachmentPublicationProof {
    ciphertext_sha256: String,
    byte_length: u64,
    identity: AttachmentPublicationIdentity,
}

impl AttachmentPublicationProof {
    pub fn ciphertext_sha256(&self) -> &str {
        &self.ciphertext_sha256
    }

    pub fn byte_length(&self) -> u64 {
        self.byte_length
    }

    pub fn account_id(&self) -> &str {
        &self.identity.account_id
    }

    pub fn user_id(&self) -> &str {
        &self.identity.user_id
    }

    pub fn operation_id(&self) -> &str {
        &self.identity.operation_id
    }

    pub fn attachment_id(&self) -> &str {
        &self.identity.attachment_id
    }
}

pub struct AttachmentTranscryptFinish {
    pub final_chunk: Vec<u8>,
    pub publication_proof: AttachmentPublicationProof,
}

/// Bounded-memory writer for the existing Attachment JSON/Base64 AES-GCM envelope.
///
/// Input is raw plaintext bytes. The historical format first Base64-encodes those bytes, encrypts
/// that UTF-8 text, then Base64-encodes the authenticated ciphertext into the JSON envelope.
pub struct AttachmentBlobEncryptor {
    target: Option<GcmStream>,
    plaintext_base64: Base64Encoder,
    ciphertext_base64: Base64Encoder,
    prefix_pending: bool,
    target_iv: [u8; IV_LENGTH],
    envelope_hash: Sha256,
    envelope_length: u64,
    plaintext_length: u64,
}

pub struct AttachmentBlobEncryptFinish {
    pub final_chunk: Vec<u8>,
    pub ciphertext_sha256: String,
    pub byte_length: u64,
    pub plaintext_length: u64,
}

impl AttachmentBlobEncryptor {
    pub fn new(
        key: [u8; 32],
        scope: AttachmentBlobScope,
    ) -> Result<Self, AttachmentMoveCryptoError> {
        let mut rng = system_rng();
        let mut iv = [0_u8; IV_LENGTH];
        rng.fill_bytes(&mut iv);
        Self::new_with_iv(key, scope, iv)
    }

    #[cfg(any(test, feature = "attachment-move-test-vectors"))]
    pub fn new_with_test_iv(
        key: [u8; 32],
        scope: AttachmentBlobScope,
        iv: [u8; IV_LENGTH],
    ) -> Result<Self, AttachmentMoveCryptoError> {
        Self::new_with_iv(key, scope, iv)
    }

    fn new_with_iv(
        key: [u8; 32],
        scope: AttachmentBlobScope,
        target_iv: [u8; IV_LENGTH],
    ) -> Result<Self, AttachmentMoveCryptoError> {
        let key = Zeroizing::new(key);
        let aad = Zeroizing::new(scope.aad_bytes()?);
        Ok(Self {
            target: Some(GcmStream::new(&key, target_iv, &aad)?),
            plaintext_base64: Base64Encoder::new(),
            ciphertext_base64: Base64Encoder::new(),
            prefix_pending: true,
            target_iv,
            envelope_hash: Sha256::new(),
            envelope_length: 0,
            plaintext_length: 0,
        })
    }

    pub fn push(&mut self, plaintext: &[u8]) -> Result<Vec<u8>, AttachmentMoveCryptoError> {
        if plaintext.len() > MAX_ATTACHMENT_ENVELOPE_INPUT_CHUNK {
            return self.fail(AttachmentMoveCryptoError::InputChunkTooLarge);
        }
        self.plaintext_length = self
            .plaintext_length
            .checked_add(plaintext.len() as u64)
            .ok_or(AttachmentMoveCryptoError::AttachmentTooLarge)?;
        let mut encoded_plaintext = Zeroizing::new(Vec::with_capacity(
            plaintext.len().saturating_add(2) / 3 * 4,
        ));
        for byte in plaintext {
            self.plaintext_base64.push(*byte, &mut encoded_plaintext);
        }
        self.encrypt_encoded(&encoded_plaintext)
    }

    pub fn finish(mut self) -> Result<AttachmentBlobEncryptFinish, AttachmentMoveCryptoError> {
        let mut tail_plaintext = Zeroizing::new(Vec::with_capacity(4));
        self.plaintext_base64.finish(&mut tail_plaintext);
        let mut final_chunk = self.encrypt_encoded(&tail_plaintext)?;
        let tag = self
            .target
            .take()
            .ok_or(AttachmentMoveCryptoError::InvalidEnvelope)?
            .finish()?;
        let metadata_offset = final_chunk.len();
        for byte in tag {
            self.ciphertext_base64.push(byte, &mut final_chunk);
        }
        self.ciphertext_base64.finish(&mut final_chunk);
        final_chunk.extend_from_slice(br#"","iv":""#);
        final_chunk.extend_from_slice(BASE64.encode(self.target_iv).as_bytes());
        final_chunk.extend_from_slice(br#"","algorithm":"AES-GCM-AAD-V1"}"#);
        self.note_output(&final_chunk[metadata_offset..])?;
        Ok(AttachmentBlobEncryptFinish {
            final_chunk,
            ciphertext_sha256: hex::encode(self.envelope_hash.clone().finalize()),
            byte_length: self.envelope_length,
            plaintext_length: self.plaintext_length,
        })
    }

    fn encrypt_encoded(
        &mut self,
        encoded_plaintext: &[u8],
    ) -> Result<Vec<u8>, AttachmentMoveCryptoError> {
        let mut output = Vec::with_capacity(encoded_plaintext.len().saturating_add(16));
        if self.prefix_pending {
            output.extend_from_slice(TARGET_PREFIX);
            self.prefix_pending = false;
        }
        for byte in encoded_plaintext {
            let ciphertext = match self.target.as_mut() {
                Some(target) => target.encrypt_byte(*byte)?,
                None => return self.fail(AttachmentMoveCryptoError::InvalidEnvelope),
            };
            self.ciphertext_base64.push(ciphertext, &mut output);
        }
        self.note_output(&output)?;
        Ok(output)
    }

    fn note_output(&mut self, bytes: &[u8]) -> Result<(), AttachmentMoveCryptoError> {
        self.envelope_hash.update(bytes);
        self.envelope_length = self
            .envelope_length
            .checked_add(bytes.len() as u64)
            .ok_or(AttachmentMoveCryptoError::AttachmentTooLarge)?;
        Ok(())
    }

    fn fail<T>(
        &mut self,
        error: AttachmentMoveCryptoError,
    ) -> Result<T, AttachmentMoveCryptoError> {
        self.target.take();
        self.plaintext_base64.zeroize();
        self.ciphertext_base64.zeroize();
        Err(error)
    }
}

impl Drop for AttachmentBlobEncryptor {
    fn drop(&mut self) {
        self.target_iv.zeroize();
        self.plaintext_base64.zeroize();
        self.ciphertext_base64.zeroize();
    }
}

pub struct AttachmentMoveTranscryptor {
    parser: Option<EnvelopeParser>,
    source: Option<GcmStream>,
    target: Option<GcmStream>,
    source_tag: [u8; TAG_LENGTH],
    source_tag_len: usize,
    target_base64: Base64Encoder,
    prefix_pending: bool,
    scanned_iv: [u8; IV_LENGTH],
    target_iv: [u8; IV_LENGTH],
    expected_envelope_hash: [u8; 32],
    envelope_hash: Sha256,
    plaintext_utf8: Utf8Validator,
    target_envelope_hash: Sha256,
    target_envelope_length: u64,
    publication_identity: Option<AttachmentPublicationIdentity>,
}

struct MoveTargetNonce([u8; IV_LENGTH]);

impl MoveTargetNonce {
    fn generate(source_iv: &[u8; IV_LENGTH], source_key: &[u8; 32], target_key: &[u8; 32]) -> Self {
        let mut rng = system_rng();
        Self::generate_with(source_iv, source_key, target_key, |nonce| {
            rng.fill_bytes(nonce);
        })
    }

    fn generate_with(
        source_iv: &[u8; IV_LENGTH],
        source_key: &[u8; 32],
        target_key: &[u8; 32],
        mut fill: impl FnMut(&mut [u8; IV_LENGTH]),
    ) -> Self {
        let same_key = source_key.ct_eq(target_key).unwrap_u8() == 1;
        loop {
            let mut nonce = [0u8; IV_LENGTH];
            fill(&mut nonce);
            if !same_key || nonce.ct_eq(source_iv).unwrap_u8() != 1 {
                return Self(nonce);
            }
            nonce.zeroize();
        }
    }

    #[cfg(any(test, feature = "attachment-move-test-vectors"))]
    fn from_test_bytes(bytes: [u8; IV_LENGTH]) -> Self {
        Self(bytes)
    }
}

impl Drop for MoveTargetNonce {
    fn drop(&mut self) {
        self.0.zeroize();
    }
}

impl AttachmentMoveTranscryptor {
    pub fn new(
        scan: AttachmentEnvelopeScan,
        source_key: [u8; 32],
        source_scope: AttachmentBlobScope,
        target_key: [u8; 32],
        target_scope: AttachmentBlobScope,
        publication_identity: AttachmentPublicationIdentity,
    ) -> Result<Self, AttachmentMoveCryptoError> {
        let target_nonce = MoveTargetNonce::generate(&scan.source_iv, &source_key, &target_key);
        Self::new_with_nonce(
            scan,
            source_key,
            source_scope,
            target_key,
            target_scope,
            publication_identity,
            target_nonce,
        )
    }

    #[cfg(any(test, feature = "attachment-move-test-vectors"))]
    pub fn new_with_test_iv_and_identity(
        scan: AttachmentEnvelopeScan,
        source_key: [u8; 32],
        source_scope: AttachmentBlobScope,
        target_key: [u8; 32],
        target_scope: AttachmentBlobScope,
        publication_identity: AttachmentPublicationIdentity,
        target_iv: [u8; IV_LENGTH],
    ) -> Result<Self, AttachmentMoveCryptoError> {
        if source_key.ct_eq(&target_key).unwrap_u8() == 1
            && scan.source_iv.ct_eq(&target_iv).unwrap_u8() == 1
        {
            return Err(AttachmentMoveCryptoError::NonceReuse);
        }
        Self::new_with_nonce(
            scan,
            source_key,
            source_scope,
            target_key,
            target_scope,
            publication_identity,
            MoveTargetNonce::from_test_bytes(target_iv),
        )
    }

    #[cfg(test)]
    fn new_with_test_iv(
        scan: AttachmentEnvelopeScan,
        source_key: [u8; 32],
        source_scope: AttachmentBlobScope,
        target_key: [u8; 32],
        target_scope: AttachmentBlobScope,
        target_iv: [u8; IV_LENGTH],
    ) -> Result<Self, AttachmentMoveCryptoError> {
        Self::new_with_test_iv_and_identity(
            scan,
            source_key,
            source_scope,
            target_key,
            target_scope,
            AttachmentPublicationIdentity::new(
                "account-test".into(),
                "user-9".into(),
                "operation-test".into(),
                "attachment-7".into(),
            )?,
            target_iv,
        )
    }

    fn new_with_nonce(
        scan: AttachmentEnvelopeScan,
        source_key: [u8; 32],
        source_scope: AttachmentBlobScope,
        target_key: [u8; 32],
        target_scope: AttachmentBlobScope,
        publication_identity: AttachmentPublicationIdentity,
        target_nonce: MoveTargetNonce,
    ) -> Result<Self, AttachmentMoveCryptoError> {
        if publication_identity.user_id != target_scope.user_id
            || publication_identity.attachment_id != target_scope.attachment_id
        {
            return Err(AttachmentMoveCryptoError::InvalidEnvelope);
        }
        let target_iv = target_nonce.0;
        let source_key = Zeroizing::new(source_key);
        let target_key = Zeroizing::new(target_key);
        let source_aad = Zeroizing::new(source_scope.aad_bytes()?);
        let target_aad = Zeroizing::new(target_scope.aad_bytes()?);
        let source = GcmStream::new(&source_key, scan.source_iv, &source_aad)?;
        let target = GcmStream::new(&target_key, target_iv, &target_aad)?;
        Ok(Self {
            parser: Some(EnvelopeParser::new()),
            source: Some(source),
            target: Some(target),
            source_tag: [0; TAG_LENGTH],
            source_tag_len: 0,
            target_base64: Base64Encoder::new(),
            prefix_pending: true,
            scanned_iv: scan.source_iv,
            target_iv,
            expected_envelope_hash: scan.envelope_hash,
            envelope_hash: Sha256::new(),
            plaintext_utf8: Utf8Validator::new(),
            target_envelope_hash: Sha256::new(),
            target_envelope_length: 0,
            publication_identity: Some(publication_identity),
        })
    }

    pub fn push(&mut self, bytes: &[u8]) -> Result<Vec<u8>, AttachmentMoveCryptoError> {
        if bytes.len() > MAX_ATTACHMENT_ENVELOPE_INPUT_CHUNK {
            return self.fail(AttachmentMoveCryptoError::InputChunkTooLarge);
        }
        self.envelope_hash.update(bytes);
        let mut output = Vec::with_capacity(bytes.len() + TARGET_PREFIX.len());
        if self.prefix_pending {
            output.extend_from_slice(TARGET_PREFIX);
            self.prefix_pending = false;
        }
        let decoded = match self
            .parser
            .as_mut()
            .ok_or(AttachmentMoveCryptoError::InvalidEnvelope)?
            .push(bytes)
        {
            Ok(decoded) => decoded,
            Err(error) => return self.fail(error),
        };
        for byte in decoded {
            if self.source_tag_len < TAG_LENGTH {
                self.source_tag[self.source_tag_len] = byte;
                self.source_tag_len += 1;
                continue;
            }
            let source_ciphertext = self.source_tag[0];
            self.source_tag.copy_within(1.., 0);
            self.source_tag[TAG_LENGTH - 1] = byte;
            let mut plaintext = match self.source.as_mut() {
                Some(source) => match source.decrypt_byte(source_ciphertext) {
                    Ok(value) => value,
                    Err(error) => return self.fail(error),
                },
                None => return self.fail(AttachmentMoveCryptoError::InvalidEnvelope),
            };
            self.plaintext_utf8.push(plaintext);
            let target_ciphertext = match self.target.as_mut() {
                Some(target) => match target.encrypt_byte(plaintext) {
                    Ok(value) => value,
                    Err(error) => {
                        plaintext.zeroize();
                        return self.fail(error);
                    }
                },
                None => return self.fail(AttachmentMoveCryptoError::InvalidEnvelope),
            };
            plaintext.zeroize();
            self.target_base64.push(target_ciphertext, &mut output);
        }
        self.target_envelope_hash.update(&output);
        self.target_envelope_length = self
            .target_envelope_length
            .checked_add(output.len() as u64)
            .ok_or(AttachmentMoveCryptoError::AttachmentTooLarge)?;
        Ok(output)
    }

    pub fn finish(mut self) -> Result<AttachmentTranscryptFinish, AttachmentMoveCryptoError> {
        let metadata = self
            .parser
            .take()
            .ok_or(AttachmentMoveCryptoError::InvalidEnvelope)?
            .finish()?;
        let pass_two_hash: [u8; 32] = self.envelope_hash.clone().finalize().into();
        if metadata.iv != self.scanned_iv
            || pass_two_hash
                .ct_eq(&self.expected_envelope_hash)
                .unwrap_u8()
                != 1
            || self.source_tag_len != TAG_LENGTH
        {
            return Err(AttachmentMoveCryptoError::InvalidEnvelope);
        }
        let source_tag = self
            .source
            .take()
            .ok_or(AttachmentMoveCryptoError::InvalidEnvelope)?
            .finish()?;
        if source_tag.ct_eq(&self.source_tag).unwrap_u8() != 1 {
            self.source_tag.zeroize();
            self.target.take();
            return Err(AttachmentMoveCryptoError::AuthenticationFailed);
        }
        self.source_tag.zeroize();
        if !self.plaintext_utf8.is_valid() {
            self.target.take();
            return Err(AttachmentMoveCryptoError::InvalidEnvelope);
        }
        let target_tag = self
            .target
            .take()
            .ok_or(AttachmentMoveCryptoError::InvalidEnvelope)?
            .finish()?;
        let mut final_chunk = Vec::with_capacity(96);
        if self.prefix_pending {
            final_chunk.extend_from_slice(TARGET_PREFIX);
        }
        for byte in target_tag {
            self.target_base64.push(byte, &mut final_chunk);
        }
        self.target_base64.finish(&mut final_chunk);
        final_chunk.extend_from_slice(br#"","iv":""#);
        final_chunk.extend_from_slice(BASE64.encode(self.target_iv).as_bytes());
        final_chunk.extend_from_slice(br#"","algorithm":"AES-GCM-AAD-V1"}"#);
        self.target_envelope_hash.update(&final_chunk);
        self.target_envelope_length = self
            .target_envelope_length
            .checked_add(final_chunk.len() as u64)
            .ok_or(AttachmentMoveCryptoError::AttachmentTooLarge)?;
        Ok(AttachmentTranscryptFinish {
            final_chunk,
            publication_proof: AttachmentPublicationProof {
                ciphertext_sha256: hex::encode(self.target_envelope_hash.clone().finalize()),
                byte_length: self.target_envelope_length,
                identity: self
                    .publication_identity
                    .take()
                    .ok_or(AttachmentMoveCryptoError::InvalidEnvelope)?,
            },
        })
    }

    fn fail<T>(
        &mut self,
        error: AttachmentMoveCryptoError,
    ) -> Result<T, AttachmentMoveCryptoError> {
        self.parser.take();
        self.source.take();
        self.target.take();
        self.source_tag.zeroize();
        self.target_base64.zeroize();
        self.plaintext_utf8.zeroize();
        Err(error)
    }

    #[cfg(test)]
    fn buffered_bytes(&self) -> usize {
        self.parser
            .as_ref()
            .map_or(0, EnvelopeParser::buffered_bytes)
            + self.source_tag_len
            + self.target_base64.len
            + self.plaintext_utf8.len
            + 64
    }
}

impl Drop for AttachmentMoveTranscryptor {
    fn drop(&mut self) {
        self.source_tag.zeroize();
        self.target_iv.zeroize();
        self.scanned_iv.zeroize();
        self.expected_envelope_hash.zeroize();
        self.target_base64.zeroize();
        self.plaintext_utf8.zeroize();
    }
}

struct GcmStream {
    cipher: Aes256,
    ghash: Option<GHash>,
    hash_buffer: [u8; 16],
    hash_len: usize,
    aad_len: u64,
    text_len: u64,
    counter: [u8; 16],
    keystream: [u8; 16],
    keystream_pos: usize,
    tag_mask: [u8; 16],
}

impl GcmStream {
    fn new(
        key: &[u8; 32],
        iv: [u8; IV_LENGTH],
        aad: &[u8],
    ) -> Result<Self, AttachmentMoveCryptoError> {
        let cipher =
            Aes256::new_from_slice(key).map_err(|_| AttachmentMoveCryptoError::InvalidKey)?;
        let mut h = aes::cipher::Block::<Aes256>::default();
        cipher.encrypt_block(&mut h);
        let mut ghash_key =
            ghash::Key::try_from(&h[..]).map_err(|_| AttachmentMoveCryptoError::InvalidKey)?;
        let ghash = GHash::new(&ghash_key);
        ghash_key.zeroize();
        h.zeroize();
        let mut j0 = [0u8; 16];
        j0[..12].copy_from_slice(&iv);
        j0[15] = 1;
        let mut mask = aes::cipher::Block::<Aes256>::from(j0);
        cipher.encrypt_block(&mut mask);
        let tag_mask: [u8; 16] = mask.into();
        let mut counter = j0;
        counter[12..].copy_from_slice(&2u32.to_be_bytes());
        let mut stream = Self {
            cipher,
            ghash: Some(ghash),
            hash_buffer: [0; 16],
            hash_len: 0,
            aad_len: aad.len() as u64,
            text_len: 0,
            counter,
            keystream: [0; 16],
            keystream_pos: 16,
            tag_mask,
        };
        stream.hash_bytes(aad);
        stream.pad_hash();
        Ok(stream)
    }

    fn decrypt_byte(&mut self, ciphertext: u8) -> Result<u8, AttachmentMoveCryptoError> {
        self.note_text_byte()?;
        self.hash_byte(ciphertext);
        Ok(ciphertext ^ self.next_keystream_byte())
    }

    fn encrypt_byte(&mut self, plaintext: u8) -> Result<u8, AttachmentMoveCryptoError> {
        self.note_text_byte()?;
        let ciphertext = plaintext ^ self.next_keystream_byte();
        self.hash_byte(ciphertext);
        Ok(ciphertext)
    }

    fn note_text_byte(&mut self) -> Result<(), AttachmentMoveCryptoError> {
        if self.text_len >= MAX_GCM_TEXT_LENGTH {
            return Err(AttachmentMoveCryptoError::AttachmentTooLarge);
        }
        self.text_len += 1;
        Ok(())
    }

    fn next_keystream_byte(&mut self) -> u8 {
        if self.keystream_pos == 16 {
            let mut block = aes::cipher::Block::<Aes256>::from(self.counter);
            self.cipher.encrypt_block(&mut block);
            self.keystream.copy_from_slice(&block);
            block.zeroize();
            let next = u32::from_be_bytes(self.counter[12..].try_into().expect("fixed counter"))
                .wrapping_add(1);
            self.counter[12..].copy_from_slice(&next.to_be_bytes());
            self.keystream_pos = 0;
        }
        let byte = self.keystream[self.keystream_pos];
        self.keystream_pos += 1;
        byte
    }

    fn hash_bytes(&mut self, bytes: &[u8]) {
        for byte in bytes {
            self.hash_byte(*byte);
        }
    }

    fn hash_byte(&mut self, byte: u8) {
        self.hash_buffer[self.hash_len] = byte;
        self.hash_len += 1;
        if self.hash_len == 16 {
            self.flush_hash_block();
        }
    }

    fn pad_hash(&mut self) {
        if self.hash_len != 0 {
            self.flush_hash_block();
        }
    }

    fn flush_hash_block(&mut self) {
        let block = ghash::Block::from(self.hash_buffer);
        self.ghash
            .as_mut()
            .expect("GHASH exists until finish")
            .update(std::slice::from_ref(&block));
        self.hash_buffer.zeroize();
        self.hash_len = 0;
    }

    fn finish(mut self) -> Result<[u8; 16], AttachmentMoveCryptoError> {
        self.pad_hash();
        let mut lengths = self.length_block()?;
        self.hash_bytes(&lengths);
        lengths.zeroize();
        let hash = self
            .ghash
            .take()
            .expect("GHASH exists until finish")
            .finalize();
        let mut tag = [0u8; 16];
        for index in 0..16 {
            tag[index] = hash[index] ^ self.tag_mask[index];
        }
        Ok(tag)
    }

    fn length_block(&self) -> Result<[u8; 16], AttachmentMoveCryptoError> {
        let aad_bits = self
            .aad_len
            .checked_mul(8)
            .ok_or(AttachmentMoveCryptoError::AttachmentTooLarge)?;
        let text_bits = self
            .text_len
            .checked_mul(8)
            .ok_or(AttachmentMoveCryptoError::AttachmentTooLarge)?;
        let mut lengths = [0u8; 16];
        lengths[..8].copy_from_slice(&aad_bits.to_be_bytes());
        lengths[8..].copy_from_slice(&text_bits.to_be_bytes());
        Ok(lengths)
    }
}

impl Drop for GcmStream {
    fn drop(&mut self) {
        self.hash_buffer.zeroize();
        self.counter.zeroize();
        self.keystream.zeroize();
        self.tag_mask.zeroize();
    }
}

struct Base64Encoder {
    pending: [u8; 3],
    len: usize,
}

struct Utf8Validator {
    pending: [u8; 4],
    len: usize,
    expected: usize,
    invalid: bool,
}

impl Utf8Validator {
    fn new() -> Self {
        Self {
            pending: [0; 4],
            len: 0,
            expected: 0,
            invalid: false,
        }
    }

    fn push(&mut self, byte: u8) {
        if self.len == 0 {
            if byte <= 0x7f {
                return;
            }
            self.expected = match byte {
                0xc2..=0xdf => 2,
                0xe0..=0xef => 3,
                0xf0..=0xf4 => 4,
                _ => {
                    self.invalid = true;
                    return;
                }
            };
        } else if !(0x80..=0xbf).contains(&byte) {
            self.invalid = true;
            self.pending.zeroize();
            self.len = 0;
            self.expected = 0;
            return;
        }
        self.pending[self.len] = byte;
        self.len += 1;
        if self.len == self.expected {
            if std::str::from_utf8(&self.pending[..self.len]).is_err() {
                self.invalid = true;
            }
            self.pending.zeroize();
            self.len = 0;
            self.expected = 0;
        }
    }

    fn is_valid(&self) -> bool {
        !self.invalid && self.len == 0
    }

    fn zeroize(&mut self) {
        self.pending.zeroize();
        self.len = 0;
        self.expected = 0;
        self.invalid = false;
    }
}

impl Base64Encoder {
    fn new() -> Self {
        Self {
            pending: [0; 3],
            len: 0,
        }
    }

    fn push(&mut self, byte: u8, output: &mut Vec<u8>) {
        self.pending[self.len] = byte;
        self.len += 1;
        if self.len == 3 {
            output.extend_from_slice(BASE64.encode(self.pending).as_bytes());
            self.pending.zeroize();
            self.len = 0;
        }
    }

    fn finish(&mut self, output: &mut Vec<u8>) {
        if self.len != 0 {
            output.extend_from_slice(BASE64.encode(&self.pending[..self.len]).as_bytes());
        }
        self.zeroize();
    }

    fn zeroize(&mut self) {
        self.pending.zeroize();
        self.len = 0;
    }
}

struct EnvelopeMetadata {
    iv: [u8; IV_LENGTH],
}

#[derive(Clone, Copy)]
enum Field {
    Ciphertext,
    Iv,
    Algorithm,
}

enum ParserState {
    Start,
    KeyOrEnd,
    Key(StringDecoder),
    Colon(Field),
    ValueStart(Field),
    Value(Field, StringDecoder),
    AfterValue,
    Done,
}

struct EnvelopeParser {
    state: ParserState,
    token: Vec<u8>,
    seen: [bool; 3],
    ciphertext: Base64Decoder,
    iv: Vec<u8>,
    algorithm: Vec<u8>,
}

impl EnvelopeParser {
    fn new() -> Self {
        Self {
            state: ParserState::Start,
            token: Vec::with_capacity(16),
            seen: [false; 3],
            ciphertext: Base64Decoder::new(),
            iv: Vec::with_capacity(24),
            algorithm: Vec::with_capacity(24),
        }
    }

    fn push(&mut self, bytes: &[u8]) -> Result<Vec<u8>, AttachmentMoveCryptoError> {
        let mut decoded = Vec::with_capacity(bytes.len() / 4 * 3 + 3);
        for byte in bytes {
            self.push_byte(*byte, &mut decoded)?;
        }
        Ok(decoded)
    }

    fn push_byte(
        &mut self,
        byte: u8,
        decoded: &mut Vec<u8>,
    ) -> Result<(), AttachmentMoveCryptoError> {
        let state = std::mem::replace(&mut self.state, ParserState::Done);
        self.state = match state {
            ParserState::Start if json_whitespace(byte) => ParserState::Start,
            ParserState::Start if byte == b'{' => ParserState::KeyOrEnd,
            ParserState::KeyOrEnd if json_whitespace(byte) => ParserState::KeyOrEnd,
            ParserState::KeyOrEnd if byte == b'"' => {
                self.token.clear();
                ParserState::Key(StringDecoder::new())
            }
            ParserState::Key(mut decoder) => match decoder.push(byte)? {
                StringEvent::Byte(value) => {
                    self.push_token(value)?;
                    ParserState::Key(decoder)
                }
                StringEvent::Continue => ParserState::Key(decoder),
                StringEvent::End => ParserState::Colon(self.finish_key()?),
            },
            ParserState::Colon(field) if json_whitespace(byte) => ParserState::Colon(field),
            ParserState::Colon(field) if byte == b':' => ParserState::ValueStart(field),
            ParserState::ValueStart(field) if json_whitespace(byte) => {
                ParserState::ValueStart(field)
            }
            ParserState::ValueStart(field) if byte == b'"' => {
                ParserState::Value(field, StringDecoder::new())
            }
            ParserState::Value(field, mut decoder) => match decoder.push(byte)? {
                StringEvent::Byte(value) => {
                    self.push_value(field, value, decoded)?;
                    ParserState::Value(field, decoder)
                }
                StringEvent::Continue => ParserState::Value(field, decoder),
                StringEvent::End => {
                    self.finish_value(field)?;
                    ParserState::AfterValue
                }
            },
            ParserState::AfterValue if json_whitespace(byte) => ParserState::AfterValue,
            ParserState::AfterValue if byte == b',' => ParserState::KeyOrEnd,
            ParserState::AfterValue if byte == b'}' => ParserState::Done,
            ParserState::Done if json_whitespace(byte) => ParserState::Done,
            _ => return Err(AttachmentMoveCryptoError::InvalidEnvelope),
        };
        Ok(())
    }

    fn push_token(&mut self, byte: u8) -> Result<(), AttachmentMoveCryptoError> {
        push_bounded(&mut self.token, byte)
    }

    fn finish_key(&mut self) -> Result<Field, AttachmentMoveCryptoError> {
        let (field, index) = match self.token.as_slice() {
            b"ciphertext" => (Field::Ciphertext, 0),
            b"iv" => (Field::Iv, 1),
            b"algorithm" => (Field::Algorithm, 2),
            _ => return Err(AttachmentMoveCryptoError::InvalidEnvelope),
        };
        self.token.zeroize();
        self.token.clear();
        if std::mem::replace(&mut self.seen[index], true) {
            return Err(AttachmentMoveCryptoError::InvalidEnvelope);
        }
        Ok(field)
    }

    fn push_value(
        &mut self,
        field: Field,
        byte: u8,
        decoded: &mut Vec<u8>,
    ) -> Result<(), AttachmentMoveCryptoError> {
        match field {
            Field::Ciphertext => self.ciphertext.push(byte, decoded),
            Field::Iv => push_bounded(&mut self.iv, byte),
            Field::Algorithm => push_bounded(&mut self.algorithm, byte),
        }
    }

    fn finish_value(&mut self, field: Field) -> Result<(), AttachmentMoveCryptoError> {
        if matches!(field, Field::Ciphertext) {
            self.ciphertext.finish()?;
        }
        Ok(())
    }

    fn finish(self) -> Result<EnvelopeMetadata, AttachmentMoveCryptoError> {
        if !matches!(self.state, ParserState::Done) || self.seen != [true, true, true] {
            return Err(AttachmentMoveCryptoError::InvalidEnvelope);
        }
        if self.algorithm != ATTACHMENT_ENCRYPTION_ALGORITHM.as_bytes()
            || self.ciphertext.decoded_count < TAG_LENGTH as u64
        {
            return Err(AttachmentMoveCryptoError::InvalidEnvelope);
        }
        let iv = BASE64
            .decode(&self.iv)
            .map_err(|_| AttachmentMoveCryptoError::InvalidEnvelope)?;
        if iv.len() != IV_LENGTH || BASE64.encode(&iv).as_bytes() != self.iv {
            return Err(AttachmentMoveCryptoError::InvalidEnvelope);
        }
        let mut fixed_iv = [0; IV_LENGTH];
        fixed_iv.copy_from_slice(&iv);
        Ok(EnvelopeMetadata { iv: fixed_iv })
    }

    #[cfg(test)]
    fn buffered_bytes(&self) -> usize {
        self.token.len() + self.iv.len() + self.algorithm.len() + self.ciphertext.len
    }
}

impl Drop for EnvelopeParser {
    fn drop(&mut self) {
        self.token.zeroize();
        self.iv.zeroize();
        self.algorithm.zeroize();
        self.ciphertext.quartet.zeroize();
    }
}

struct Base64Decoder {
    quartet: [u8; 4],
    len: usize,
    ended: bool,
    decoded_count: u64,
}

impl Base64Decoder {
    fn new() -> Self {
        Self {
            quartet: [0; 4],
            len: 0,
            ended: false,
            decoded_count: 0,
        }
    }

    fn push(&mut self, byte: u8, output: &mut Vec<u8>) -> Result<(), AttachmentMoveCryptoError> {
        if self.ended || !(byte.is_ascii_alphanumeric() || matches!(byte, b'+' | b'/' | b'=')) {
            return Err(AttachmentMoveCryptoError::InvalidEnvelope);
        }
        self.quartet[self.len] = byte;
        self.len += 1;
        if self.len == 4 {
            let decoded = Zeroizing::new(
                BASE64
                    .decode(self.quartet)
                    .map_err(|_| AttachmentMoveCryptoError::InvalidEnvelope)?,
            );
            if BASE64.encode(&decoded).as_bytes() != self.quartet {
                return Err(AttachmentMoveCryptoError::InvalidEnvelope);
            }
            self.ended = self.quartet.contains(&b'=');
            self.decoded_count = self
                .decoded_count
                .checked_add(decoded.len() as u64)
                .ok_or(AttachmentMoveCryptoError::AttachmentTooLarge)?;
            if self.decoded_count > MAX_GCM_TEXT_LENGTH + TAG_LENGTH as u64 {
                return Err(AttachmentMoveCryptoError::AttachmentTooLarge);
            }
            output.extend_from_slice(&decoded);
            self.quartet.zeroize();
            self.len = 0;
        }
        Ok(())
    }

    fn finish(&self) -> Result<(), AttachmentMoveCryptoError> {
        if self.len == 0 {
            Ok(())
        } else {
            Err(AttachmentMoveCryptoError::InvalidEnvelope)
        }
    }
}

impl Drop for Base64Decoder {
    fn drop(&mut self) {
        self.quartet.zeroize();
        self.len = 0;
        self.decoded_count = 0;
    }
}

enum StringEvent {
    Continue,
    Byte(u8),
    End,
}

struct StringDecoder {
    escape: EscapeState,
}

enum EscapeState {
    None,
    Escaped,
    Unicode { value: u16, digits: u8 },
}

impl StringDecoder {
    fn new() -> Self {
        Self {
            escape: EscapeState::None,
        }
    }

    fn push(&mut self, byte: u8) -> Result<StringEvent, AttachmentMoveCryptoError> {
        match self.escape {
            EscapeState::None if byte == b'"' => Ok(StringEvent::End),
            EscapeState::None if byte == b'\\' => {
                self.escape = EscapeState::Escaped;
                Ok(StringEvent::Continue)
            }
            EscapeState::None if (0x20..=0x7f).contains(&byte) => Ok(StringEvent::Byte(byte)),
            EscapeState::None => Err(AttachmentMoveCryptoError::InvalidEnvelope),
            EscapeState::Escaped => {
                self.escape = EscapeState::None;
                match byte {
                    b'"' | b'\\' | b'/' => Ok(StringEvent::Byte(byte)),
                    b'b' => Ok(StringEvent::Byte(0x08)),
                    b'f' => Ok(StringEvent::Byte(0x0c)),
                    b'n' => Ok(StringEvent::Byte(b'\n')),
                    b'r' => Ok(StringEvent::Byte(b'\r')),
                    b't' => Ok(StringEvent::Byte(b'\t')),
                    b'u' => {
                        self.escape = EscapeState::Unicode {
                            value: 0,
                            digits: 0,
                        };
                        Ok(StringEvent::Continue)
                    }
                    _ => Err(AttachmentMoveCryptoError::InvalidEnvelope),
                }
            }
            EscapeState::Unicode { mut value, digits } => {
                let nibble = hex_nibble(byte).ok_or(AttachmentMoveCryptoError::InvalidEnvelope)?;
                value = (value << 4) | u16::from(nibble);
                if digits == 3 {
                    self.escape = EscapeState::None;
                    let decoded = u8::try_from(value)
                        .map_err(|_| AttachmentMoveCryptoError::InvalidEnvelope)?;
                    Ok(StringEvent::Byte(decoded))
                } else {
                    self.escape = EscapeState::Unicode {
                        value,
                        digits: digits + 1,
                    };
                    Ok(StringEvent::Continue)
                }
            }
        }
    }
}

fn push_bounded(buffer: &mut Vec<u8>, byte: u8) -> Result<(), AttachmentMoveCryptoError> {
    if buffer.len() >= MAX_TOKEN_LENGTH {
        return Err(AttachmentMoveCryptoError::InvalidEnvelope);
    }
    buffer.push(byte);
    Ok(())
}

fn json_whitespace(byte: u8) -> bool {
    matches!(byte, b' ' | b'\n' | b'\r' | b'\t')
}

fn hex_nibble(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::{
        AttachmentBlobDecryptor, AttachmentBlobEncryptor, AttachmentBlobScope,
        AttachmentEnvelopeScanner, AttachmentMoveCryptoError, AttachmentMoveTranscryptor,
        AttachmentPublicationIdentity, GcmStream, MoveTargetNonce, ATTACHMENT_ENCRYPTION_ALGORITHM,
        MAX_GCM_TEXT_LENGTH,
    };
    use aes_gcm::{
        aead::{Aead, KeyInit, Payload},
        Aes256Gcm, Nonce,
    };
    use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
    use sha2::Digest;

    const SOURCE_KEY: [u8; 32] = [0x11; 32];
    const TARGET_KEY: [u8; 32] = [0x22; 32];
    const SOURCE_IV: [u8; 12] = [0x33; 12];
    const TARGET_IV: [u8; 12] = [0x44; 12];

    fn scope(vault_id: &str) -> AttachmentBlobScope {
        AttachmentBlobScope::new(
            vault_id.to_owned(),
            "attachment-7".to_owned(),
            "user-9".to_owned(),
        )
    }

    fn aad(vault_id: &str) -> Vec<u8> {
        format!("{vault_id}\0attachment-7\0attachment_blob\01\0user-9").into_bytes()
    }

    fn envelope(plaintext: &[u8], key: &[u8; 32], iv: [u8; 12], vault_id: &str) -> Vec<u8> {
        let ciphertext = Aes256Gcm::new_from_slice(key)
            .unwrap()
            .encrypt(
                &Nonce::from(iv),
                Payload {
                    msg: plaintext,
                    aad: &aad(vault_id),
                },
            )
            .unwrap();
        format!(
            r#"{{"ciphertext":"{}","iv":"{}","algorithm":"AES-GCM-AAD-V1"}}"#,
            BASE64.encode(ciphertext),
            BASE64.encode(iv)
        )
        .into_bytes()
    }

    fn scan_chunks(envelope: &[u8], chunks: &[usize]) -> super::AttachmentEnvelopeScan {
        let mut scanner = AttachmentEnvelopeScanner::new();
        let mut offset = 0;
        for size in chunks {
            let end = (offset + size).min(envelope.len());
            scanner.push(&envelope[offset..end]).unwrap();
            offset = end;
        }
        if offset < envelope.len() {
            scanner.push(&envelope[offset..]).unwrap();
        }
        scanner.finish().unwrap()
    }

    #[test]
    fn streaming_upload_encryption_preserves_the_historical_attachment_envelope() {
        let plaintext = b"raw attachment bytes\0across chunks";
        let expected = envelope(
            BASE64.encode(plaintext).as_bytes(),
            &TARGET_KEY,
            TARGET_IV,
            "vault-target",
        );
        let mut encryptor =
            AttachmentBlobEncryptor::new_with_test_iv(TARGET_KEY, scope("vault-target"), TARGET_IV)
                .unwrap();
        let mut actual = encryptor.push(&plaintext[..5]).unwrap();
        actual.extend(encryptor.push(&plaintext[5..19]).unwrap());
        actual.extend(encryptor.push(&plaintext[19..]).unwrap());
        let finish = encryptor.finish().unwrap();
        actual.extend(finish.final_chunk);

        assert_eq!(actual, expected);
        assert_eq!(finish.plaintext_length, plaintext.len() as u64);
        assert_eq!(finish.byte_length, actual.len() as u64);
        assert_eq!(
            finish.ciphertext_sha256,
            hex::encode(sha2::Sha256::digest(&actual))
        );
    }

    #[test]
    fn attachment_blob_decryptor_streams_raw_bytes_but_authenticates_before_publication() {
        let raw = b"raw attachment bytes, including \0 and \xff";
        let encoded = BASE64.encode(raw);
        let source = envelope(encoded.as_bytes(), &SOURCE_KEY, SOURCE_IV, "vault-a");
        let scan = scan_chunks(&source, &[1, 7, 19]);
        let mut decryptor =
            AttachmentBlobDecryptor::new(scan, SOURCE_KEY, scope("vault-a")).unwrap();
        let mut decoded = Vec::new();
        for chunk in source.chunks(11) {
            decoded.extend(decryptor.push(chunk).unwrap());
        }
        decoded.extend(decryptor.finish().unwrap());
        assert_eq!(decoded, raw);

        let scan = scan_chunks(&source, &[source.len()]);
        let mut corrupted = source.clone();
        let position = br#"{"ciphertext":""#.len() + 5;
        corrupted[position] = if corrupted[position] == b'A' {
            b'B'
        } else {
            b'A'
        };
        let mut decryptor =
            AttachmentBlobDecryptor::new(scan, SOURCE_KEY, scope("vault-a")).unwrap();
        let mut provisional = Vec::new();
        for chunk in corrupted.chunks(13) {
            provisional.extend(decryptor.push(chunk).unwrap_or_default());
        }
        assert!(!provisional.is_empty());
        assert!(matches!(
            decryptor.finish(),
            Err(AttachmentMoveCryptoError::InvalidEnvelope
                | AttachmentMoveCryptoError::AuthenticationFailed)
        ));
    }

    #[test]
    fn attachment_blob_decryptor_drop_cleanup_wipes_retained_authentication_state() {
        let raw = b"plaintext retained only in provisional output";
        let source = envelope(
            BASE64.encode(raw).as_bytes(),
            &SOURCE_KEY,
            SOURCE_IV,
            "vault-a",
        );
        let scan = scan_chunks(&source, &[source.len()]);
        let mut decryptor =
            AttachmentBlobDecryptor::new(scan, SOURCE_KEY, scope("vault-a")).unwrap();
        let prefix = &source[..source.len() - 8];
        let _ = decryptor.push(prefix);
        assert!(decryptor.source_tag.iter().any(|byte| *byte != 0));
        decryptor.zeroize_sensitive_state();
        assert_eq!(decryptor.source_tag, [0; 16]);
        assert_eq!(decryptor.source_tag_len, 0);
    }

    fn transcrypt_chunks(source: &[u8], chunks: &[usize]) -> Vec<u8> {
        let scan = scan_chunks(source, chunks);
        let mut transcryptor = AttachmentMoveTranscryptor::new_with_test_iv(
            scan,
            SOURCE_KEY,
            scope("vault-source"),
            TARGET_KEY,
            scope("vault-target"),
            TARGET_IV,
        )
        .unwrap();
        let mut output = Vec::new();
        let mut offset = 0;
        for size in chunks {
            let end = (offset + size).min(source.len());
            output.extend(transcryptor.push(&source[offset..end]).unwrap());
            offset = end;
        }
        if offset < source.len() {
            output.extend(transcryptor.push(&source[offset..]).unwrap());
        }
        output.extend(transcryptor.finish().unwrap().final_chunk);
        output
    }

    #[test]
    fn publication_proof_owns_the_exact_emitted_bytes_and_explicit_identity() {
        let source = envelope(b"bound output", &SOURCE_KEY, SOURCE_IV, "vault-source");
        let scan = scan_chunks(&source, &[3, 5]);
        let identity = AttachmentPublicationIdentity::new(
            "account-1".into(),
            "user-9".into(),
            "operation-1".into(),
            "attachment-7".into(),
        )
        .unwrap();
        let mut transcryptor = AttachmentMoveTranscryptor::new_with_test_iv_and_identity(
            scan,
            SOURCE_KEY,
            scope("vault-source"),
            TARGET_KEY,
            scope("vault-target"),
            identity,
            TARGET_IV,
        )
        .unwrap();
        let mut output = transcryptor.push(&source).unwrap();
        let finished = transcryptor.finish().unwrap();
        output.extend_from_slice(&finished.final_chunk);

        assert_eq!(
            finished.publication_proof.ciphertext_sha256(),
            hex::encode(sha2::Sha256::digest(&output))
        );
        assert_eq!(
            finished.publication_proof.byte_length(),
            output.len() as u64
        );
        assert_eq!(finished.publication_proof.account_id(), "account-1");
        assert_eq!(finished.publication_proof.user_id(), "user-9");
        assert_eq!(finished.publication_proof.operation_id(), "operation-1");
        assert_eq!(finished.publication_proof.attachment_id(), "attachment-7");
    }

    #[test]
    fn publication_identity_must_match_target_attachment_and_user_scope() {
        let source = envelope(b"scope binding", &SOURCE_KEY, SOURCE_IV, "vault-source");
        for identity in [
            AttachmentPublicationIdentity::new(
                "account-1".into(),
                "other-user".into(),
                "operation-1".into(),
                "attachment-7".into(),
            )
            .unwrap(),
            AttachmentPublicationIdentity::new(
                "account-1".into(),
                "user-9".into(),
                "operation-1".into(),
                "other-attachment".into(),
            )
            .unwrap(),
        ] {
            assert_eq!(
                AttachmentMoveTranscryptor::new_with_test_iv_and_identity(
                    scan_chunks(&source, &[source.len()]),
                    SOURCE_KEY,
                    scope("vault-source"),
                    TARGET_KEY,
                    scope("vault-target"),
                    identity,
                    TARGET_IV,
                )
                .err()
                .unwrap(),
                AttachmentMoveCryptoError::InvalidEnvelope
            );
        }
    }

    #[test]
    fn scanner_accepts_the_existing_closed_attachment_envelope() {
        let envelope = br#"{"ciphertext":"AAAAAAAAAAAAAAAAAAAAAA==","iv":"EBESExQVFhcYGRob","algorithm":"AES-GCM-AAD-V1"}"#;
        let mut scanner = AttachmentEnvelopeScanner::new();
        for byte in envelope {
            scanner.push(std::slice::from_ref(byte)).unwrap();
        }
        let scan = scanner.finish().unwrap();
        assert_eq!(
            scan.source_iv(),
            &[16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27]
        );
        assert_eq!(scan.algorithm(), ATTACHMENT_ENCRYPTION_ALGORITHM);
    }

    #[test]
    fn every_source_byte_split_preserves_the_existing_wire_format() {
        let plaintext = "binary attachment\0with Unicode: 世界 🔐".as_bytes();
        let source = envelope(plaintext, &SOURCE_KEY, SOURCE_IV, "vault-source");
        let expected = envelope(plaintext, &TARGET_KEY, TARGET_IV, "vault-target");

        for split in 0..=source.len() {
            assert_eq!(
                transcrypt_chunks(&source, &[split]),
                expected,
                "split at byte {split}"
            );
        }
    }

    #[test]
    fn large_multichunk_input_keeps_persistent_buffers_bounded() {
        let plaintext = "bounded Unicode payload 世界 🔐\n"
            .repeat(40_000)
            .into_bytes();
        let source = envelope(&plaintext, &SOURCE_KEY, SOURCE_IV, "vault-source");
        let mut scanner = AttachmentEnvelopeScanner::new();
        for chunk in source.chunks(8191) {
            scanner.push(chunk).unwrap();
            assert!(scanner.buffered_bytes() <= 132);
        }
        let scan = scanner.finish().unwrap();
        let mut transcryptor = AttachmentMoveTranscryptor::new_with_test_iv(
            scan,
            SOURCE_KEY,
            scope("vault-source"),
            TARGET_KEY,
            scope("vault-target"),
            TARGET_IV,
        )
        .unwrap();
        let mut output = Vec::new();
        for chunk in source.chunks(8191) {
            output.extend(transcryptor.push(chunk).unwrap());
            assert!(transcryptor.buffered_bytes() <= 216);
        }
        output.extend(transcryptor.finish().unwrap().final_chunk);
        assert_eq!(
            output,
            envelope(&plaintext, &TARGET_KEY, TARGET_IV, "vault-target")
        );
    }

    #[test]
    fn reordered_and_json_escaped_fields_are_accepted_by_both_passes() {
        let canonical = envelope(b"payload", &SOURCE_KEY, SOURCE_IV, "vault-source");
        let parsed: serde_json::Value = serde_json::from_slice(&canonical).unwrap();
        let altered = format!(
            " {{ \"algorithm\" : \"AES-GCM-AAD-V1\", \"iv\":\"{}\", \"cipher\\u0074ext\":\"{}\" }} ",
            parsed["iv"].as_str().unwrap(),
            parsed["ciphertext"].as_str().unwrap().replace('/', "\\/")
        );
        assert_eq!(
            transcrypt_chunks(altered.as_bytes(), &[1, 2, 3, 5, 8]),
            envelope(b"payload", &TARGET_KEY, TARGET_IV, "vault-target")
        );
    }

    #[test]
    fn scanner_rejects_non_closed_or_malformed_envelopes() {
        let cases: &[&[u8]] = &[
            br#"{"ciphertext":"AAAAAAAAAAAAAAAAAAAAAA==","iv":"EBESExQVFhcYGRob"}"#,
            br#"{"ciphertext":"AAAAAAAAAAAAAAAAAAAAAA==","iv":"EBESExQVFhcYGRob","algorithm":"AES-GCM-AAD-V1","extra":"x"}"#,
            br#"{"ciphertext":"AAAAAAAAAAAAAAAAAAAAAA==","ciphertext":"AAAAAAAAAAAAAAAAAAAAAA==","iv":"EBESExQVFhcYGRob","algorithm":"AES-GCM-AAD-V1"}"#,
            br#"{"ciphertext":"not base64!","iv":"EBESExQVFhcYGRob","algorithm":"AES-GCM-AAD-V1"}"#,
            br#"{"ciphertext":"AAAAAAAAAAAAAAAAAAAAAA==","iv":"EBESExQVFhcYGRob","algorithm":"other"}"#,
            br#"{"ciphertext":"AAAAAAAAAAAAAAAAAAAAAA==","iv":"EBESExQVFhcYGRob","algorithm":"AES-GCM-AAD-V1""#,
            b"{\"ciphertext\":\"AAAAAAAAAAAAAAAAAAAAAA==\",\"iv\":\"\xff\",\"algorithm\":\"AES-GCM-AAD-V1\"}",
        ];
        for envelope in cases {
            let mut scanner = AttachmentEnvelopeScanner::new();
            let result = scanner
                .push(envelope)
                .and_then(|()| scanner.finish().map(|_| ()));
            assert!(result.is_err(), "accepted malformed input: {envelope:?}");
        }
    }

    #[test]
    fn corruption_wrong_aad_and_pass_two_metadata_changes_return_no_proof() {
        let source = envelope(b"authenticated", &SOURCE_KEY, SOURCE_IV, "vault-source");
        let mut corrupted = source.clone();
        let ciphertext_start = br#"{"ciphertext":""#.len();
        corrupted[ciphertext_start] = if corrupted[ciphertext_start] == b'A' {
            b'B'
        } else {
            b'A'
        };
        let scan = scan_chunks(&corrupted, &[corrupted.len()]);
        let mut transcryptor = AttachmentMoveTranscryptor::new_with_test_iv(
            scan,
            SOURCE_KEY,
            scope("vault-source"),
            TARGET_KEY,
            scope("vault-target"),
            TARGET_IV,
        )
        .unwrap();
        let _provisional = transcryptor.push(&corrupted).unwrap();
        assert_eq!(
            transcryptor.finish().err().unwrap(),
            AttachmentMoveCryptoError::AuthenticationFailed
        );

        // Even a separately valid, same-length envelope cannot be substituted
        // between the two downloads.
        let alternate = envelope(b"authenticateD", &SOURCE_KEY, SOURCE_IV, "vault-source");
        assert_eq!(alternate.len(), source.len());
        let scan = scan_chunks(&source, &[source.len()]);
        let mut substituted = AttachmentMoveTranscryptor::new_with_test_iv(
            scan,
            SOURCE_KEY,
            scope("vault-source"),
            TARGET_KEY,
            scope("vault-target"),
            TARGET_IV,
        )
        .unwrap();
        let _ = substituted.push(&alternate).unwrap();
        assert_eq!(
            substituted.finish().err().unwrap(),
            AttachmentMoveCryptoError::InvalidEnvelope
        );

        let scan = scan_chunks(&source, &[source.len()]);
        let mut wrong_aad = AttachmentMoveTranscryptor::new_with_test_iv(
            scan,
            SOURCE_KEY,
            scope("wrong-source-vault"),
            TARGET_KEY,
            scope("vault-target"),
            TARGET_IV,
        )
        .unwrap();
        let _ = wrong_aad.push(&source).unwrap();
        assert_eq!(
            wrong_aad.finish().err().unwrap(),
            AttachmentMoveCryptoError::AuthenticationFailed
        );

        let scan = scan_chunks(&source, &[source.len()]);
        let changed_iv = String::from_utf8(source.clone())
            .unwrap()
            .replace(&BASE64.encode(SOURCE_IV), &BASE64.encode([0x55; 12]));
        let mut changed = AttachmentMoveTranscryptor::new_with_test_iv(
            scan,
            SOURCE_KEY,
            scope("vault-source"),
            TARGET_KEY,
            scope("vault-target"),
            TARGET_IV,
        )
        .unwrap();
        let _ = changed.push(changed_iv.as_bytes()).unwrap();
        assert_eq!(
            changed.finish().err().unwrap(),
            AttachmentMoveCryptoError::InvalidEnvelope
        );

        let scan = scan_chunks(&source, &[source.len()]);
        let mut truncated = AttachmentMoveTranscryptor::new_with_test_iv(
            scan,
            SOURCE_KEY,
            scope("vault-source"),
            TARGET_KEY,
            scope("vault-target"),
            TARGET_IV,
        )
        .unwrap();
        let _ = truncated.push(&source[..source.len() - 1]).unwrap();
        assert_eq!(
            truncated.finish().err().unwrap(),
            AttachmentMoveCryptoError::InvalidEnvelope
        );
    }

    #[test]
    fn a_fresh_retry_with_the_same_entropy_is_deterministic() {
        let source = envelope(b"retry me", &SOURCE_KEY, SOURCE_IV, "vault-source");
        assert_eq!(
            transcrypt_chunks(&source, &[2, 7, 11]),
            transcrypt_chunks(&source, &[1, 13, 4, 9])
        );
    }

    #[test]
    fn authenticated_non_utf8_plaintext_never_grants_publication_authority() {
        let source = envelope(&[b'v', 0xff, 0xfe], &SOURCE_KEY, SOURCE_IV, "vault-source");
        let scan = scan_chunks(&source, &[3, 5]);
        let mut transcryptor = AttachmentMoveTranscryptor::new_with_test_iv(
            scan,
            SOURCE_KEY,
            scope("vault-source"),
            TARGET_KEY,
            scope("vault-target"),
            TARGET_IV,
        )
        .unwrap();
        let _provisional = transcryptor.push(&source).unwrap();
        assert_eq!(
            transcryptor.finish().err().unwrap(),
            AttachmentMoveCryptoError::InvalidEnvelope
        );
    }

    #[test]
    fn incomplete_and_invalid_utf8_sequences_never_grant_publication_authority() {
        for plaintext in [&[0xe2, 0x82][..], &[0xe2, 0x28, 0xa1][..]] {
            let source = envelope(plaintext, &SOURCE_KEY, SOURCE_IV, "vault-source");
            let scan = scan_chunks(&source, &[1, 7]);
            let mut transcryptor = AttachmentMoveTranscryptor::new_with_test_iv(
                scan,
                SOURCE_KEY,
                scope("vault-source"),
                TARGET_KEY,
                scope("vault-target"),
                TARGET_IV,
            )
            .unwrap();
            let result = transcryptor
                .push(&source)
                .and_then(|_| transcryptor.finish().map(|_| ()));
            assert_eq!(
                result.err().unwrap(),
                AttachmentMoveCryptoError::InvalidEnvelope
            );
        }
    }

    #[test]
    fn production_construction_owns_target_nonce_generation() {
        let source = envelope(b"nonce ownership", &SOURCE_KEY, SOURCE_IV, "vault-source");
        let run = || {
            let scan = scan_chunks(&source, &[source.len()]);
            let mut transcryptor = AttachmentMoveTranscryptor::new(
                scan,
                SOURCE_KEY,
                scope("vault-source"),
                TARGET_KEY,
                scope("vault-target"),
                AttachmentPublicationIdentity::new(
                    "account-test".into(),
                    "user-9".into(),
                    "operation-test".into(),
                    "attachment-7".into(),
                )
                .unwrap(),
            )
            .unwrap();
            let mut output = transcryptor.push(&source).unwrap();
            output.extend(transcryptor.finish().unwrap().final_chunk);
            output
        };

        assert_ne!(run(), run());
    }

    #[test]
    fn deterministic_test_nonce_rejects_same_key_and_source_iv_reuse() {
        let source = envelope(b"nonce collision", &SOURCE_KEY, SOURCE_IV, "vault-source");
        let scan = scan_chunks(&source, &[source.len()]);
        assert_eq!(
            AttachmentMoveTranscryptor::new_with_test_iv(
                scan,
                SOURCE_KEY,
                scope("vault-source"),
                SOURCE_KEY,
                scope("vault-target"),
                SOURCE_IV,
            )
            .err()
            .unwrap(),
            AttachmentMoveCryptoError::NonceReuse
        );
    }

    #[test]
    fn generated_nonce_retries_a_same_key_and_source_iv_collision() {
        let mut fills = 0;
        let nonce =
            MoveTargetNonce::generate_with(&SOURCE_IV, &SOURCE_KEY, &SOURCE_KEY, |candidate| {
                *candidate = if fills == 0 { SOURCE_IV } else { TARGET_IV };
                fills += 1;
            });

        assert_eq!(fills, 2);
        assert_eq!(nonce.0, TARGET_IV);
    }

    #[test]
    fn gcm_maximum_text_byte_is_accepted_and_next_byte_precedes_counter_reuse() {
        let mut stream = GcmStream::new(&SOURCE_KEY, SOURCE_IV, &aad("vault-source")).unwrap();
        stream.text_len = MAX_GCM_TEXT_LENGTH - 1;
        stream.counter[12..].copy_from_slice(&u32::MAX.to_be_bytes());

        assert!(stream.encrypt_byte(b'x').is_ok());
        let counter_at_limit = stream.counter;
        assert_eq!(
            stream.encrypt_byte(b'y').err().unwrap(),
            AttachmentMoveCryptoError::AttachmentTooLarge
        );
        assert_eq!(stream.counter, counter_at_limit);
        assert_eq!(
            &stream.length_block().unwrap()[8..],
            &(MAX_GCM_TEXT_LENGTH * 8).to_be_bytes()
        );
        stream.text_len = u64::MAX;
        assert_eq!(
            stream.length_block().err().unwrap(),
            AttachmentMoveCryptoError::AttachmentTooLarge
        );
    }
}
