pub(crate) fn validate_chunk_index(
    chunk_index: u32,
    chunk_count: u32,
) -> Result<bool, &'static str> {
    if chunk_count == 0 || chunk_index >= chunk_count {
        return Err("Attachment artifact chunk index is out of range");
    }
    Ok(chunk_index == chunk_count - 1)
}

pub(crate) fn validate_received_chunk_length(
    reported_length: usize,
    expected_length: usize,
) -> Result<(), &'static str> {
    if expected_length == 0
        || expected_length > bittery_client_core::ARTIFACT_CHUNK_BYTES
        || reported_length != expected_length
    {
        return Err("Attachment artifact durable chunk length is invalid");
    }
    Ok(())
}

pub(crate) fn copy_validated_chunk(
    reported_length: usize,
    expected_length: usize,
    copy: impl FnOnce() -> Vec<u8>,
) -> Result<Vec<u8>, &'static str> {
    validate_received_chunk_length(reported_length, expected_length)?;
    Ok(copy())
}

pub(crate) fn validate_chunk_digest(
    bytes: &[u8],
    expected_sha256: &str,
) -> Result<(), &'static str> {
    use sha2::{Digest, Sha256};

    if format!("{:x}", Sha256::digest(bytes)) != expected_sha256 {
        return Err("Attachment artifact durable chunk digest is invalid");
    }
    Ok(())
}

pub(crate) fn validate_complete_artifact(
    actual_byte_length: u64,
    expected_byte_length: u64,
    actual_sha256: &str,
    expected_sha256: &str,
) -> Result<(), &'static str> {
    if actual_byte_length != expected_byte_length || actual_sha256 != expected_sha256 {
        return Err("Provisional Attachment artifact bytes do not match publication authority");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{
        copy_validated_chunk, validate_chunk_digest, validate_chunk_index,
        validate_complete_artifact, validate_received_chunk_length,
    };
    use std::cell::Cell;

    #[test]
    fn invalid_maximum_chunk_index_is_rejected_without_overflow() {
        assert!(validate_chunk_index(u32::MAX, 2).is_err());
    }

    #[test]
    fn malformed_and_oversized_host_chunks_are_rejected_before_allocation() {
        assert!(validate_received_chunk_length(0, 17).is_err());
        assert!(validate_received_chunk_length(18, 17).is_err());
        assert!(validate_received_chunk_length(256 * 1024 + 1, 256 * 1024).is_err());
        for reported in [0, 256 * 1024 + 1] {
            let copied = Cell::new(false);
            assert!(copy_validated_chunk(reported, 256 * 1024, || {
                copied.set(true);
                vec![0; reported]
            })
            .is_err());
            assert!(!copied.get());
        }
    }

    #[test]
    fn same_length_ciphertext_mutation_is_rejected_by_rust_policy() {
        let expected = "039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81";
        assert!(validate_chunk_digest(&[1, 2, 3], expected).is_ok());
        assert!(validate_chunk_digest(&[1, 2, 4], expected).is_err());
    }

    #[test]
    fn publication_authority_rejects_missing_length_and_digest_or_different_bytes() {
        let digest = "7e592b7a2d9533c24af5c82a173f3f5d41290375a07dfac281b9b787277a5295";
        assert!(validate_complete_artifact(5, 5, digest, digest).is_ok());
        assert!(validate_complete_artifact(4, 5, digest, digest).is_err());
        assert!(validate_complete_artifact(5, 5, "missing", digest).is_err());
        assert!(validate_complete_artifact(5, 5, digest, "different").is_err());
    }
}
