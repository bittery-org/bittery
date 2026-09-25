use sha2::{Digest, Sha256};

pub(crate) use bittery_client_core::{
    AttachmentUploadIntegrity as UploadIntegrity, ARTIFACT_CHUNK_BYTES as MAX_TRANSFER_CHUNK_BYTES,
};

pub(crate) fn copy_validated_download_chunk(
    reported_length: u32,
    max_chunk_bytes: usize,
    reported_sha256: &str,
    host_length: usize,
    copy: impl FnOnce() -> Vec<u8>,
) -> Result<Vec<u8>, &'static str> {
    let reported_length =
        usize::try_from(reported_length).map_err(|_| "Binary transfer chunk length is invalid")?;
    if reported_length == 0
        || reported_length > MAX_TRANSFER_CHUNK_BYTES
        || reported_length > max_chunk_bytes
        || host_length != reported_length
    {
        return Err("Binary transfer chunk length is invalid");
    }
    let bytes = copy();
    validate_sha256(&bytes, reported_sha256)?;
    Ok(bytes)
}

pub(crate) fn validate_sha256(bytes: &[u8], expected: &str) -> Result<(), &'static str> {
    if format!("{:x}", Sha256::digest(bytes)) != expected {
        return Err("Binary transfer chunk digest is invalid");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{copy_validated_download_chunk, UploadIntegrity, MAX_TRANSFER_CHUNK_BYTES};
    use std::cell::Cell;

    #[test]
    fn rejects_host_bounds_before_copying_into_rust() {
        for (reported, maximum, host) in [
            (0, 3, 0),
            (4, 3, 4),
            (4, MAX_TRANSFER_CHUNK_BYTES, 3),
            (
                (MAX_TRANSFER_CHUNK_BYTES + 1) as u32,
                MAX_TRANSFER_CHUNK_BYTES,
                0,
            ),
        ] {
            let copied = Cell::new(false);
            assert!(
                copy_validated_download_chunk(reported, maximum, "unused", host, || {
                    copied.set(true);
                    vec![0; host]
                })
                .is_err()
            );
            assert!(!copied.get());
        }
    }

    #[test]
    fn same_length_upload_digest_mismatch_is_rejected() {
        let expected = "039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81";
        let mut valid = UploadIntegrity::new(3, expected.into()).unwrap();
        valid.push(&[1, 2, 3]).unwrap();
        assert!(valid.finish().is_ok());

        let mut corrupted = UploadIntegrity::new(3, expected.into()).unwrap();
        corrupted.push(&[1, 2, 4]).unwrap();
        assert!(corrupted.finish().is_err());
    }

    #[test]
    fn upload_length_is_bounded_incrementally() {
        let empty = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
        let mut integrity = UploadIntegrity::new(1, empty.into()).unwrap();
        assert!(integrity.push(&[1, 2]).is_err());
    }
}
