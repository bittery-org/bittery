//! Versioned password-protected Replica recovery stream. No Account or Runtime policy lives here.
//!
//! V1 header: `BTRREC01` (fixes PBKDF2-SHA256/AES-256-GCM), iteration u32,
//! salt[32], nonce prefix[8], chunk-size u32. All integers are big-endian.
//! Frames: ciphertext-and-tag length u32, kind u8 (data=0, terminal=1),
//! sequence u32, ciphertext and GCM tag. The encrypted terminal contains the
//! preceding data-frame count u32 and total data plaintext length u64.
//! Callers must require a terminal and transport EOF before using completion;
//! decoded prefixes are provisional. Caller-owned password/source buffers
//! must be zeroized by the caller; this module owns its key and working buffers.

use crate::{system_rng, CryptoError};
use aes_gcm::{
    aead::{AeadInOut, KeyInit},
    Aes256Gcm, Nonce,
};
use pbkdf2::pbkdf2_hmac;
use rand::Rng;
use sha2::Sha256;
use zeroize::{Zeroize, Zeroizing};

pub const RECOVERY_CHUNK_BYTES: usize = 256 * 1024;
pub const RECOVERY_HEADER_BYTES: usize = 56;
pub const RECOVERY_MAX_PLAINTEXT_BYTES: u64 = 1024 * 1024 * 1024;
pub const RECOVERY_FRAME_PREFIX_BYTES: usize = 9;
pub const RECOVERY_MAX_FRAME_BYTES: usize = RECOVERY_FRAME_PREFIX_BYTES + RECOVERY_CHUNK_BYTES + 16;
const MAGIC: &[u8; 8] = b"BTRREC01";
const DOMAIN: &[u8] = b"bittery.replica-recovery.v1\0";
const ITERATIONS: u32 = 600_000;

fn invalid() -> CryptoError {
    CryptoError::InvalidInput("Invalid or unsupported Replica recovery stream".into())
}
fn authentication_failed() -> CryptoError {
    CryptoError::Decryption("Replica recovery stream authentication failed".into())
}
fn key(
    password: &str,
    header: &[u8; RECOVERY_HEADER_BYTES],
) -> Result<Zeroizing<[u8; 32]>, CryptoError> {
    if !(16..=1024).contains(&password.len()) || &header[..8] != MAGIC {
        return Err(invalid());
    }
    let iterations = u32::from_be_bytes(header[8..12].try_into().map_err(|_| invalid())?);
    let chunk_size = u32::from_be_bytes(header[52..56].try_into().map_err(|_| invalid())?);
    if !(ITERATIONS..=1_200_000).contains(&iterations) || chunk_size != RECOVERY_CHUNK_BYTES as u32
    {
        return Err(invalid());
    }
    let mut salt = DOMAIN.to_vec();
    salt.extend_from_slice(&header[12..44]);
    let mut output = Zeroizing::new([0u8; 32]);
    pbkdf2_hmac::<Sha256>(password.as_bytes(), &salt, iterations, &mut *output);
    Ok(output)
}
fn nonce(header: &[u8; RECOVERY_HEADER_BYTES], sequence: u32) -> [u8; 12] {
    let mut result = [0; 12];
    result[..8].copy_from_slice(&header[44..52]);
    result[8..].copy_from_slice(&sequence.to_be_bytes());
    result
}
fn aad(header: &[u8; RECOVERY_HEADER_BYTES], kind: u8, sequence: u32) -> Vec<u8> {
    let mut result = DOMAIN.to_vec();
    result.extend_from_slice(header);
    result.push(kind);
    result.extend_from_slice(&sequence.to_be_bytes());
    result
}

/// A fresh salt, derived key and nonce namespace belong to one export. Deliberately not Clone.
pub struct RecoveryEncryptor {
    header: [u8; RECOVERY_HEADER_BYTES],
    key: Zeroizing<[u8; 32]>,
    sequence: u32,
    bytes: u64,
    short_chunk: bool,
    failed: bool,
}
impl RecoveryEncryptor {
    pub fn new(password: &str) -> Result<Self, CryptoError> {
        let mut header = [0; RECOVERY_HEADER_BYTES];
        header[..8].copy_from_slice(MAGIC);
        header[8..12].copy_from_slice(&ITERATIONS.to_be_bytes());
        system_rng().fill_bytes(&mut header[12..52]);
        header[52..56].copy_from_slice(&(RECOVERY_CHUNK_BYTES as u32).to_be_bytes());
        let key = key(password, &header)?;
        Ok(Self {
            header,
            key,
            sequence: 0,
            bytes: 0,
            short_chunk: false,
            failed: false,
        })
    }
    pub fn header(&self) -> &[u8; RECOVERY_HEADER_BYTES] {
        &self.header
    }
    /// Full chunks followed by at most one short chunk; an error retires this export.
    /// The caller owns and must zeroize its borrowed password and plaintext buffers.
    pub fn seal_chunk(&mut self, plaintext: &[u8]) -> Result<Vec<u8>, CryptoError> {
        let result = self.seal_data(plaintext);
        if result.is_err() {
            self.failed = true;
            self.key.zeroize();
        }
        result
    }
    fn seal_data(&mut self, plaintext: &[u8]) -> Result<Vec<u8>, CryptoError> {
        if self.failed
            || plaintext.is_empty()
            || plaintext.len() > RECOVERY_CHUNK_BYTES
            || self.short_chunk
        {
            return Err(invalid());
        }
        let total = self
            .bytes
            .checked_add(plaintext.len() as u64)
            .ok_or_else(invalid)?;
        if total > RECOVERY_MAX_PLAINTEXT_BYTES {
            return Err(invalid());
        }
        let next_sequence = self.sequence.checked_add(1).ok_or_else(invalid)?;
        let frame = self.seal(0, plaintext)?;
        self.sequence = next_sequence;
        self.bytes = total;
        self.short_chunk = plaintext.len() < RECOVERY_CHUNK_BYTES;
        Ok(frame)
    }
    pub fn finish(self) -> Result<Vec<u8>, CryptoError> {
        if self.failed {
            return Err(invalid());
        }
        let mut terminal = [0u8; 12];
        terminal[..4].copy_from_slice(&self.sequence.to_be_bytes());
        terminal[4..].copy_from_slice(&self.bytes.to_be_bytes());
        self.seal(1, &terminal)
    }
    fn seal(&self, kind: u8, plaintext: &[u8]) -> Result<Vec<u8>, CryptoError> {
        let cipher = Aes256Gcm::new_from_slice(self.key.as_ref()).map_err(|_| invalid())?;
        // Allocate the tag capacity before copying plaintext, so growth cannot leave an
        // unzeroized plaintext allocation behind on encryption failure.
        let mut ciphertext = Zeroizing::new(Vec::with_capacity(plaintext.len() + 16));
        ciphertext.extend_from_slice(plaintext);
        cipher
            .encrypt_in_place(
                &Nonce::from(nonce(&self.header, self.sequence)),
                &aad(&self.header, kind, self.sequence),
                &mut *ciphertext,
            )
            .map_err(|_| authentication_failed())?;
        let mut frame = Vec::with_capacity(RECOVERY_FRAME_PREFIX_BYTES + ciphertext.len());
        frame.extend_from_slice(&(ciphertext.len() as u32).to_be_bytes());
        frame.push(kind);
        frame.extend_from_slice(&self.sequence.to_be_bytes());
        frame.extend_from_slice(&ciphertext);
        Ok(frame)
    }
}

/// Decoder errors poison the stream; authenticated prefixes never establish complete recovery.
pub struct RecoveryDecryptor {
    header: [u8; RECOVERY_HEADER_BYTES],
    key: Zeroizing<[u8; 32]>,
    sequence: u32,
    bytes: u64,
    short_chunk: bool,
    finished: bool,
    failed: bool,
}
impl RecoveryDecryptor {
    pub fn new(password: &str, header: &[u8]) -> Result<Self, CryptoError> {
        let header = header.try_into().map_err(|_| invalid())?;
        let key = key(password, &header)?;
        Ok(Self {
            header,
            key,
            sequence: 0,
            bytes: 0,
            short_chunk: false,
            finished: false,
            failed: false,
        })
    }
    pub fn finished(&self) -> bool {
        self.finished && !self.failed
    }
    pub fn open_frame(&mut self, frame: &[u8]) -> Result<Option<Zeroizing<Vec<u8>>>, CryptoError> {
        let result = self.open(frame);
        if result.is_err() {
            self.failed = true;
        }
        if self.failed || self.finished {
            self.key.zeroize();
        }
        result
    }
    fn open(&mut self, frame: &[u8]) -> Result<Option<Zeroizing<Vec<u8>>>, CryptoError> {
        if self.failed
            || self.finished
            || frame.len() < RECOVERY_FRAME_PREFIX_BYTES + 16
            || frame.len() > RECOVERY_MAX_FRAME_BYTES
        {
            return Err(authentication_failed());
        }
        let length = u32::from_be_bytes(frame[..4].try_into().map_err(|_| invalid())?) as usize;
        let kind = frame[4];
        let sequence = u32::from_be_bytes(frame[5..9].try_into().map_err(|_| invalid())?);
        if length != frame.len() - RECOVERY_FRAME_PREFIX_BYTES
            || sequence != self.sequence
            || kind > 1
            || (kind == 0 && self.short_chunk)
        {
            return Err(authentication_failed());
        }
        let cipher = Aes256Gcm::new_from_slice(self.key.as_ref()).map_err(|_| invalid())?;
        let mut plaintext = Zeroizing::new(frame[RECOVERY_FRAME_PREFIX_BYTES..].to_vec());
        cipher
            .decrypt_in_place(
                &Nonce::from(nonce(&self.header, sequence)),
                &aad(&self.header, kind, sequence),
                &mut *plaintext,
            )
            .map_err(|_| authentication_failed())?;
        if kind == 1 {
            if plaintext.len() != 12
                || plaintext[..4] != self.sequence.to_be_bytes()
                || plaintext[4..] != self.bytes.to_be_bytes()
            {
                return Err(authentication_failed());
            }
            self.finished = true;
            return Ok(None);
        }
        let total = self
            .bytes
            .checked_add(plaintext.len() as u64)
            .ok_or_else(invalid)?;
        if plaintext.is_empty()
            || plaintext.len() > RECOVERY_CHUNK_BYTES
            || total > RECOVERY_MAX_PLAINTEXT_BYTES
        {
            return Err(authentication_failed());
        }
        self.bytes = total;
        self.sequence = self.sequence.checked_add(1).ok_or_else(invalid)?;
        self.short_chunk = plaintext.len() < RECOVERY_CHUNK_BYTES;
        Ok(Some(plaintext))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recovery_stream_authenticates_terminal_and_preserves_binary_bytes() {
        let mut writer = RecoveryEncryptor::new("separate recovery password").unwrap();
        let header = *writer.header();
        let bytes = vec![0xa5; RECOVERY_CHUNK_BYTES];
        let first = writer.seal_chunk(&bytes).unwrap();
        let last = writer.seal_chunk(b"private image bytes").unwrap();
        let terminal = writer.finish().unwrap();
        let mut reader = RecoveryDecryptor::new("separate recovery password", &header).unwrap();
        assert_eq!(&*reader.open_frame(&first).unwrap().unwrap(), &bytes);
        assert_eq!(
            &*reader.open_frame(&last).unwrap().unwrap(),
            b"private image bytes"
        );
        assert!(!reader.finished());
        assert!(reader.open_frame(&terminal).unwrap().is_none());
        assert!(reader.finished());
        assert!(reader.open_frame(&terminal).is_err());
        assert!(!first.windows(32).any(|v| v == &bytes[..32]));
    }

    #[test]
    fn recovery_stream_refuses_password_tampering_reordering_and_truncation() {
        let mut writer = RecoveryEncryptor::new("separate recovery password").unwrap();
        let header = *writer.header();
        let first = writer.seal_chunk(&vec![1; RECOVERY_CHUNK_BYTES]).unwrap();
        let second = writer.seal_chunk(b"image").unwrap();
        let terminal = writer.finish().unwrap();
        let mut wrong = RecoveryDecryptor::new("different recovery password", &header).unwrap();
        assert!(wrong.open_frame(&first).is_err());
        let mut reordered = RecoveryDecryptor::new("separate recovery password", &header).unwrap();
        assert!(reordered.open_frame(&second).is_err());
        let mut damaged = first.clone();
        *damaged.last_mut().unwrap() ^= 1;
        let mut reader = RecoveryDecryptor::new("separate recovery password", &header).unwrap();
        assert!(reader.open_frame(&damaged).is_err());
        assert!(!reader.finished());
        assert!(
            reader.open_frame(&first).is_err(),
            "authentication failure poisons decoder"
        );
        let mut truncated = RecoveryDecryptor::new("separate recovery password", &header).unwrap();
        assert!(truncated.open_frame(&first[..first.len() - 1]).is_err());
        let mut omitted = RecoveryDecryptor::new("separate recovery password", &header).unwrap();
        omitted.open_frame(&first).unwrap();
        assert!(omitted.open_frame(&terminal).is_err());
    }

    #[test]
    fn recovery_stream_bounds_are_checked_before_kdf_or_allocation() {
        assert!(RecoveryEncryptor::new("short").is_err());
        assert!(RecoveryEncryptor::new(&"p".repeat(1025)).is_err());
        let mut header = [0u8; RECOVERY_HEADER_BYTES];
        assert!(RecoveryDecryptor::new("separate recovery password", &header).is_err());
        header[..8].copy_from_slice(b"BTRREC01");
        header[8..12].copy_from_slice(&u32::MAX.to_be_bytes());
        header[52..56].copy_from_slice(&(RECOVERY_CHUNK_BYTES as u32).to_be_bytes());
        assert!(RecoveryDecryptor::new("separate recovery password", &header).is_err());
        let mut writer = RecoveryEncryptor::new("separate recovery password").unwrap();
        assert!(writer
            .seal_chunk(&vec![0; RECOVERY_CHUNK_BYTES + 1])
            .is_err());
    }

    #[test]
    fn recovery_encoder_error_cannot_finalize_an_accepted_prefix() {
        let mut writer = RecoveryEncryptor::new("separate recovery password").unwrap();
        writer.seal_chunk(b"accepted prefix").unwrap();
        assert!(writer.seal_chunk(b"unexpected continuation").is_err());
        assert!(writer.key.iter().all(|byte| *byte == 0));
        assert!(
            writer.finish().is_err(),
            "a refused suffix must not produce a complete archive"
        );
    }

    #[test]
    fn recovery_decoder_retires_key_on_completion_and_failure() {
        let writer = RecoveryEncryptor::new("separate recovery password").unwrap();
        let header = *writer.header();
        let terminal = writer.finish().unwrap();
        let mut complete = RecoveryDecryptor::new("separate recovery password", &header).unwrap();
        complete.open_frame(&terminal).unwrap();
        assert!(complete.finished());
        assert!(complete.key.iter().all(|byte| *byte == 0));
        let mut failed = RecoveryDecryptor::new("separate recovery password", &header).unwrap();
        assert!(failed.open_frame(&[]).is_err());
        assert!(failed.key.iter().all(|byte| *byte == 0));
        assert!(failed.open_frame(&terminal).is_err());
    }

    // Framing tests bypass only the expensive KDF. The independent format vector
    // below fixes the actual KDF and encoder bytes, without a production test API.
    fn framing_writer() -> RecoveryEncryptor {
        let mut header = [0; RECOVERY_HEADER_BYTES];
        header[..8].copy_from_slice(MAGIC);
        header[8..12].copy_from_slice(&ITERATIONS.to_be_bytes());
        header[52..56].copy_from_slice(&(RECOVERY_CHUNK_BYTES as u32).to_be_bytes());
        RecoveryEncryptor {
            header,
            key: Zeroizing::new([0x42; 32]),
            sequence: 0,
            bytes: 0,
            short_chunk: false,
            failed: false,
        }
    }
    fn framing_reader() -> RecoveryDecryptor {
        let writer = framing_writer();
        RecoveryDecryptor {
            header: writer.header,
            key: writer.key,
            sequence: 0,
            bytes: 0,
            short_chunk: false,
            finished: false,
            failed: false,
        }
    }

    #[test]
    fn recovery_every_header_and_frame_byte_is_bound_to_authentication() {
        let mut writer = framing_writer();
        let frame = writer.seal_chunk(b"secret image payload").unwrap();
        let terminal = writer.finish().unwrap();
        for offset in 0..RECOVERY_HEADER_BYTES {
            let mut reader = framing_reader();
            reader.header[offset] ^= 1;
            assert!(reader.open_frame(&frame).is_err(), "header byte {offset}");
        }
        for (valid, terminal_frame) in [(&frame, false), (&terminal, true)] {
            for offset in 0..valid.len() {
                let mut reader = framing_reader();
                if terminal_frame {
                    reader.open_frame(&frame).unwrap();
                }
                let mut damaged = valid.clone();
                damaged[offset] ^= 1;
                assert!(reader.open_frame(&damaged).is_err(), "frame byte {offset}");
                assert!(!reader.finished());
                assert!(
                    reader.open_frame(valid).is_err(),
                    "failure cannot be retried"
                );
            }
        }
    }

    #[test]
    fn recovery_rejects_every_truncation_trailing_byte_duplicate_and_extra_data() {
        let mut writer = framing_writer();
        let frame = writer.seal_chunk(b"one record").unwrap();
        let terminal = writer.finish().unwrap();
        for end in 0..frame.len() {
            assert!(framing_reader().open_frame(&frame[..end]).is_err());
        }
        for end in 0..terminal.len() {
            let mut reader = framing_reader();
            reader.open_frame(&frame).unwrap();
            assert!(!reader.finished(), "EOF after a valid prefix is incomplete");
            assert!(reader.open_frame(&terminal[..end]).is_err());
        }
        let mut reader = framing_reader();
        reader.open_frame(&frame).unwrap();
        assert!(
            reader.open_frame(&frame).is_err(),
            "duplicate data sequence"
        );
        let mut reader = framing_reader();
        reader.open_frame(&frame).unwrap();
        let mut trailing = terminal.clone();
        trailing.push(0);
        assert!(reader.open_frame(&trailing).is_err());
        let mut reader = framing_reader();
        reader.open_frame(&frame).unwrap();
        reader.open_frame(&terminal).unwrap();
        assert!(reader.finished());
        assert!(reader.open_frame(&frame).is_err());
        assert!(!reader.finished(), "trailing frames invalidate completion");
    }

    #[test]
    fn recovery_valid_tags_cannot_bypass_terminal_counts_or_chunk_canonicality() {
        for body in [vec![], vec![0; 11], vec![0; 13], vec![1; 12]] {
            let writer = framing_writer();
            let terminal = writer.seal(1, &body).unwrap();
            assert!(framing_reader().open_frame(&terminal).is_err());
        }
        for bad_count in [true, false] {
            let mut writer = framing_writer();
            let frame = writer.seal_chunk(b"image").unwrap();
            let mut body = [0; 12];
            body[..4].copy_from_slice(&(if bad_count { 2_u32 } else { 1 }).to_be_bytes());
            body[4..].copy_from_slice(&(if bad_count { 5_u64 } else { 6 }).to_be_bytes());
            let terminal = writer.seal(1, &body).unwrap();
            let mut reader = framing_reader();
            reader.open_frame(&frame).unwrap();
            assert!(reader.open_frame(&terminal).is_err());
        }
        let mut writer = framing_writer();
        assert!(framing_reader()
            .open_frame(&writer.seal(0, &[]).unwrap())
            .is_err());
        let first = writer.seal_chunk(b"short").unwrap();
        // An authenticated sender still cannot insert data after the final short chunk.
        let second = writer.seal(0, b"suffix").unwrap();
        let mut reader = framing_reader();
        reader.open_frame(&first).unwrap();
        assert!(reader.open_frame(&second).is_err());
    }

    #[test]
    fn recovery_plaintext_limit_and_sequence_exhaustion_refuse_without_large_allocations() {
        let mut writer = framing_writer();
        writer.bytes = RECOVERY_MAX_PLAINTEXT_BYTES - RECOVERY_CHUNK_BYTES as u64;
        let mut reader = framing_reader();
        reader.bytes = writer.bytes;
        let last = writer
            .seal_chunk(&vec![0x7f; RECOVERY_CHUNK_BYTES])
            .unwrap();
        assert_eq!(last.len(), RECOVERY_MAX_FRAME_BYTES);
        reader.open_frame(&last).unwrap();
        assert_eq!(reader.bytes, RECOVERY_MAX_PLAINTEXT_BYTES);
        let overflow = writer.seal(0, b"x").unwrap();
        assert!(reader.open_frame(&overflow).is_err());
        assert!(writer.seal_chunk(b"x").is_err());
        assert!(writer.finish().is_err());
        assert!(framing_reader()
            .open_frame(&vec![0; RECOVERY_MAX_FRAME_BYTES + 1])
            .is_err());
        let mut writer = framing_writer();
        writer.sequence = u32::MAX;
        assert!(writer.seal_chunk(b"x").is_err());
        assert!(writer.finish().is_err());
    }

    #[test]
    fn recovery_encoder_matches_independent_node_vector() {
        let header: [u8; RECOVERY_HEADER_BYTES] = hex::decode("4254525245433031000927c0000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f202122232425262700040000").unwrap().try_into().unwrap();
        let mut writer = RecoveryEncryptor {
            header,
            key: key("independent vector password", &header).unwrap(),
            sequence: 0,
            bytes: 0,
            short_chunk: false,
            failed: false,
        };
        assert_eq!(hex::encode(writer.seal_chunk(b"encrypted recovery vector bytes").unwrap()), "0000002f0000000000be1fd89a4ea4af938a453846f0bcb9306706bd71e8423e6ba15c8cffdc75f4f6ace0f0486b637531197db5a976f8ac");
        assert_eq!(
            hex::encode(writer.finish().unwrap()),
            "0000001c0100000001619f9612016e8a11ec17c0575f1a7d9a3c655a80390008e056a63c02"
        );
    }

    #[test]
    fn recovery_password_is_exact_utf8_and_each_export_has_fresh_salt_and_nonce() {
        let composed = "twelve chars: é";
        let decomposed = "twelve chars: e\u{301}";
        let first = RecoveryEncryptor::new(composed).unwrap();
        let second = RecoveryEncryptor::new(composed).unwrap();
        assert_ne!(&first.header()[12..44], &second.header()[12..44]);
        assert_ne!(&first.header()[44..52], &second.header()[44..52]);
        assert_ne!(
            key(composed, first.header()).unwrap(),
            key(decomposed, first.header()).unwrap()
        );
        assert!(
            RecoveryEncryptor::new(&"é".repeat(513)).is_err(),
            "password bound is bytes"
        );
    }

    #[test]
    fn recovery_header_admission_rejects_unsupported_lengths_kdf_and_chunk_size() {
        let header = framing_writer().header;
        for length in [0, RECOVERY_HEADER_BYTES - 1, RECOVERY_HEADER_BYTES + 1] {
            assert!(
                RecoveryDecryptor::new("separate recovery password", &vec![0; length]).is_err()
            );
        }
        for iterations in [0_u32, ITERATIONS - 1, 1_200_001, u32::MAX] {
            let mut invalid_header = header;
            invalid_header[8..12].copy_from_slice(&iterations.to_be_bytes());
            assert!(RecoveryDecryptor::new("separate recovery password", &invalid_header).is_err());
        }
        for size in [0_u32, 1, RECOVERY_CHUNK_BYTES as u32 - 1, u32::MAX] {
            let mut invalid_header = header;
            invalid_header[52..56].copy_from_slice(&size.to_be_bytes());
            assert!(RecoveryDecryptor::new("separate recovery password", &invalid_header).is_err());
        }
    }
}
