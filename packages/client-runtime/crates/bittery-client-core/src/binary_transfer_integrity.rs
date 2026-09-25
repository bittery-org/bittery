//! Shared incremental verification of streamed attachment ciphertext.

use crate::ARTIFACT_CHUNK_BYTES;
use sha2::{Digest, Sha256};

pub struct AttachmentUploadIntegrity {
    expected_length: u64,
    expected_sha256: Option<String>,
    actual_length: u64,
    hasher: Sha256,
}

impl AttachmentUploadIntegrity {
    pub fn new(expected_length: u64, expected_sha256: String) -> Result<Self, &'static str> {
        if expected_sha256.len() != 64
            || !expected_sha256
                .bytes()
                .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
        {
            return Err("Binary transfer upload digest is invalid");
        }
        Ok(Self {
            expected_length,
            expected_sha256: Some(expected_sha256),
            actual_length: 0,
            hasher: Sha256::new(),
        })
    }

    /// Foreground upload learns Core's final digest after streaming its ciphertext.
    pub fn for_length(expected_length: u64) -> Self {
        Self {
            expected_length,
            expected_sha256: None,
            actual_length: 0,
            hasher: Sha256::new(),
        }
    }

    pub fn push(&mut self, bytes: &[u8]) -> Result<(), &'static str> {
        if bytes.is_empty() || bytes.len() > ARTIFACT_CHUNK_BYTES {
            return Err("Binary transfer upload chunk length is invalid");
        }
        self.actual_length = self
            .actual_length
            .checked_add(bytes.len() as u64)
            .ok_or("Binary transfer upload length is invalid")?;
        if self.actual_length > self.expected_length {
            return Err("Binary transfer upload length is invalid");
        }
        self.hasher.update(bytes);
        Ok(())
    }

    pub fn finish(&self) -> Result<(), &'static str> {
        self.finish_with_sha256(
            self.expected_sha256
                .as_deref()
                .ok_or("Binary transfer upload digest is missing")?,
        )
    }

    pub fn finish_with_sha256(&self, expected_sha256: &str) -> Result<(), &'static str> {
        let actual_sha256 = format!("{:x}", self.hasher.clone().finalize());
        if self.actual_length != self.expected_length || actual_sha256 != expected_sha256 {
            return Err("Binary transfer upload does not match ciphertext authority");
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn foreground_digest_arriving_after_ciphertext_must_match_actual_bytes() {
        let mut integrity = AttachmentUploadIntegrity::for_length(3);
        integrity.push(&[1, 2, 3]).unwrap();
        assert!(integrity
            .finish_with_sha256("039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81")
            .is_ok());
        assert!(integrity.finish_with_sha256(&"0".repeat(64)).is_err());
        assert!(integrity.finish_with_sha256("invalid").is_err());
        let mut short = AttachmentUploadIntegrity::for_length(4);
        short.push(&[1, 2, 3]).unwrap();
        assert!(short
            .finish_with_sha256("039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81")
            .is_err());
    }
}
