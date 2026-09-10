use sha2::{Digest, Sha256};

pub(crate) const MAX_TRANSFER_CHUNK_BYTES: usize = 256 * 1024;

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

pub(crate) struct UploadIntegrity {
    expected_length: u64,
    expected_sha256: String,
    actual_length: u64,
    hasher: Sha256,
}

impl UploadIntegrity {
    pub(crate) fn new(expected_length: u64, expected_sha256: String) -> Result<Self, &'static str> {
        if expected_sha256.len() != 64
            || !expected_sha256
                .bytes()
                .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
        {
            return Err("Binary transfer upload digest is invalid");
        }
        Ok(Self {
            expected_length,
            expected_sha256,
            actual_length: 0,
            hasher: Sha256::new(),
        })
    }

    pub(crate) fn push(&mut self, bytes: &[u8]) -> Result<(), &'static str> {
        if bytes.is_empty() || bytes.len() > MAX_TRANSFER_CHUNK_BYTES {
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

    pub(crate) fn finish(&self) -> Result<(), &'static str> {
        let actual_sha256 = format!("{:x}", self.hasher.clone().finalize());
        if self.actual_length != self.expected_length || actual_sha256 != self.expected_sha256 {
            return Err("Binary transfer upload does not match ciphertext authority");
        }
        Ok(())
    }
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
