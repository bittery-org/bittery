//! Artifact-key translation inside Core's authenticated recovery stream. No image decryption.
use super::*;

#[derive(Serialize, Deserialize)]
#[serde(transparent)]
pub(crate) struct PortableImageKey(KeyPayload);

impl PortableImageKey {
    pub(crate) fn validate_metadata(
        &self,
        expected: &VaultImageArtifactMetadata,
        metadata: &ProtectedImageMetadata,
    ) -> Result<(), RuntimeError> {
        validate_protected_metadata(expected, metadata)?;
        self.validate(
            expected,
            &metadata.binding.identity.user_id,
            &metadata.witness,
        )
    }
    pub(crate) fn validate(
        &self,
        expected: &VaultImageArtifactMetadata,
        user_id: &str,
        witness: &ProtectedImageWitness,
    ) -> Result<(), RuntimeError> {
        validate_key_payload(&self.0, expected, user_id, witness).map(|_| ())
    }
}

pub(crate) fn export_key(
    expected: &VaultImageArtifactMetadata,
    user_id: &str,
    witness: &ProtectedImageWitness,
    metadata: &ProtectedImageMetadata,
    device_key: &[u8],
) -> Result<PortableImageKey, RuntimeError> {
    unwrap_key_payload(expected, user_id, witness, metadata, device_key).map(PortableImageKey)
}

pub(crate) fn rewrap_key(
    expected: &VaultImageArtifactMetadata,
    user_id: &str,
    witness: &ProtectedImageWitness,
    portable: &PortableImageKey,
    device_key: &[u8],
) -> Result<ProtectedImageMetadata, RuntimeError> {
    validate_key_payload(&portable.0, expected, user_id, witness)?;
    Ok(ProtectedImageMetadata {
        witness: witness.clone(),
        binding: portable.0.binding.clone(),
        wrapped_key: wrap_key_payload(&portable.0, device_key)?,
    })
}

/// Reuse an already installed exact wrapper on retry; immutable physical evidence is not overwritten.
pub(crate) fn rewrap_or_reuse_key(
    expected: &VaultImageArtifactMetadata,
    user_id: &str,
    witness: &ProtectedImageWitness,
    portable: &PortableImageKey,
    device_key: &[u8],
    existing: Option<&ProtectedImageMetadata>,
) -> Result<ProtectedImageMetadata, RuntimeError> {
    use subtle::ConstantTimeEq;
    let key = validate_key_payload(&portable.0, expected, user_id, witness)?;
    if let Some(existing) = existing {
        let old = unwrap_key_payload(expected, user_id, witness, existing, device_key)?;
        let old_key = validate_key_payload(&old, expected, user_id, witness)?;
        if !bool::from(key.as_slice().ct_eq(old_key.as_slice())) {
            return Err(invalid());
        }
        return Ok(existing.clone());
    }
    rewrap_key(expected, user_id, witness, portable, device_key)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn portable_key_changes_only_the_device_wrapper_and_preserves_opaque_ciphertext() {
        let fixture = super::super::tests::fixture();
        let portable = export_key(
            &fixture.original,
            "user-a",
            &fixture.metadata.witness,
            &fixture.metadata,
            &[7; 32],
        )
        .unwrap();
        let encoded = Zeroizing::new(serde_json::to_vec(&portable).unwrap());
        assert!(!encoded
            .windows(BASE64.encode([7; 32]).len())
            .any(|window| { window == BASE64.encode([7; 32]).as_bytes() }));
        assert!(!encoded
            .windows(21)
            .any(|window| window == b"private image content"));
        let restored: PortableImageKey = serde_json::from_slice(&encoded).unwrap();
        let replacement = rewrap_key(
            &fixture.original,
            "user-a",
            &fixture.metadata.witness,
            &restored,
            &[8; 32],
        )
        .unwrap();
        assert_eq!(replacement.binding, fixture.metadata.binding);
        assert_eq!(replacement.witness, fixture.metadata.witness);
        assert_ne!(
            replacement.wrapped_key.ciphertext,
            fixture.metadata.wrapped_key.ciphertext
        );
        assert!(read_protected_image(
            &fixture.original,
            "user-a",
            &replacement.witness,
            &replacement,
            &fixture.chunks,
            &[7; 32],
        )
        .is_err());
        assert_eq!(
            read_protected_image(
                &fixture.original,
                "user-a",
                &replacement.witness,
                &replacement,
                &fixture.chunks,
                &[8; 32],
            )
            .unwrap()
            .as_slice(),
            fixture.bytes
        );
    }
}
