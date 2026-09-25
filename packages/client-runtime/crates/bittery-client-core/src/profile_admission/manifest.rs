use super::{
    require_bounded_text, LegacyProfileFormat, ProfileSourceFamily, ProfileSourceObservation,
    ProfileSourceSelector, PROFILE_SOURCE_IDENTITY_BYTES,
};
use crate::{wire::decimal_u64, RuntimeError, RuntimeErrorCode};
use serde::Serialize;
use sha2::{Digest, Sha256};

const ENTRY_VERSION: u8 = 1;
const ENTRY_DOMAIN: &[u8] = b"bittery.profile-admission.entry.v1\0";
const MANIFEST_DOMAIN: &[u8] = b"bittery.profile-admission.manifest.v1\0";

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct EntryIdentity<'a> {
    version: u8,
    format: LegacyProfileFormat,
    family: ProfileSourceFamily,
    selector: &'a ProfileSourceSelector,
    observation: &'a ProfileSourceObservation,
    file_identity: Option<&'a str>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ManifestIdentity<'a> {
    version: u8,
    format: LegacyProfileFormat,
    profile_identity: &'a str,
    #[serde(with = "decimal_u64")]
    entry_count: u64,
}

/// Incremental canonical manifest digest. It retains no source payload or complete entry list.
pub struct ProfileSourceManifestDigest {
    state: Sha256,
    format: LegacyProfileFormat,
    entry_count: u64,
    next_index: u64,
}

/// Incremental digest of one exact source observation. The caller can feed bounded file pages
/// without retaining the complete file in memory.
pub struct ProfileSourceEvidenceDigest {
    state: Sha256,
    expected_length: u64,
    observed_length: u64,
}

impl ProfileSourceEvidenceDigest {
    pub fn new(
        format: LegacyProfileFormat,
        family: ProfileSourceFamily,
        selector: &ProfileSourceSelector,
        observation: &ProfileSourceObservation,
        file_identity: Option<&str>,
    ) -> Result<Self, RuntimeError> {
        validate_family_for_format(format, family)?;
        let expected_length =
            validate_evidence_identity(family, selector, observation, file_identity)?;
        let identity = canonical_json(&EntryIdentity {
            version: ENTRY_VERSION,
            format,
            family,
            selector,
            observation,
            file_identity,
        })?;
        let mut state = Sha256::new();
        state.update(ENTRY_DOMAIN);
        update_length_prefixed(&mut state, &identity)?;
        state.update(expected_length.to_be_bytes());
        Ok(Self {
            state,
            expected_length,
            observed_length: 0,
        })
    }

    pub fn update(&mut self, chunk: &[u8]) -> Result<(), RuntimeError> {
        let chunk_length = u64::try_from(chunk.len())
            .map_err(|_| invalid_manifest("Profile source evidence length overflows"))?;
        let observed_length = self
            .observed_length
            .checked_add(chunk_length)
            .ok_or_else(|| invalid_manifest("Profile source evidence length overflows"))?;
        if observed_length > self.expected_length {
            return Err(invalid_manifest(
                "Profile source evidence exceeds its observed length",
            ));
        }
        self.state.update(chunk);
        self.observed_length = observed_length;
        Ok(())
    }

    pub fn finish(self) -> Result<String, RuntimeError> {
        if self.observed_length != self.expected_length {
            return Err(invalid_manifest(
                "Profile source evidence is shorter than its observed length",
            ));
        }
        Ok(encode_sha256(self.state.finalize().into()))
    }
}

pub(super) fn validate_family_for_format(
    format: LegacyProfileFormat,
    family: ProfileSourceFamily,
) -> Result<(), RuntimeError> {
    let matches = match format {
        LegacyProfileFormat::DesktopLegacyV1 => matches!(
            family,
            ProfileSourceFamily::DesktopStore
                | ProfileSourceFamily::DesktopSyncStore
                | ProfileSourceFamily::DesktopCredentials
        ),
        LegacyProfileFormat::ExtensionLegacyV1 => matches!(
            family,
            ProfileSourceFamily::ExtensionLocal
                | ProfileSourceFamily::ExtensionSession
                | ProfileSourceFamily::ExtensionRecords
        ),
    };
    if matches {
        Ok(())
    } else {
        Err(invalid_manifest(
            "Profile source manifest family does not match its format",
        ))
    }
}

impl ProfileSourceManifestDigest {
    pub fn new(
        format: LegacyProfileFormat,
        profile_identity: &str,
        entry_count: u64,
    ) -> Result<Self, RuntimeError> {
        require_bounded_text(profile_identity, PROFILE_SOURCE_IDENTITY_BYTES)?;
        let identity = canonical_json(&ManifestIdentity {
            version: ENTRY_VERSION,
            format,
            profile_identity,
            entry_count,
        })?;
        let mut state = Sha256::new();
        state.update(MANIFEST_DOMAIN);
        update_length_prefixed(&mut state, &identity)?;
        Ok(Self {
            state,
            format,
            entry_count,
            next_index: 0,
        })
    }

    pub fn append(
        &mut self,
        entry: &super::ProfileSourceManifestEntry,
    ) -> Result<(), RuntimeError> {
        if self.next_index >= self.entry_count {
            return Err(invalid_manifest(
                "Profile source manifest has too many entries",
            ));
        }
        entry.validate_for_format(self.format)?;
        let digest = decode_sha256(&entry.evidence_sha256)?;
        self.state.update(self.next_index.to_be_bytes());
        self.state.update(digest);
        self.next_index += 1;
        Ok(())
    }

    pub fn next_index(&self) -> u64 {
        self.next_index
    }

    pub fn finish(self) -> Result<String, RuntimeError> {
        if self.next_index != self.entry_count {
            return Err(invalid_manifest(
                "Profile source manifest entry count is incomplete",
            ));
        }
        Ok(encode_sha256(self.state.finalize().into()))
    }
}

pub(super) fn evidence_sha256(
    format: LegacyProfileFormat,
    family: ProfileSourceFamily,
    selector: &ProfileSourceSelector,
    observation: &ProfileSourceObservation,
    file_identity: Option<&str>,
    payload: &[u8],
) -> Result<String, RuntimeError> {
    let mut digest =
        ProfileSourceEvidenceDigest::new(format, family, selector, observation, file_identity)?;
    digest.update(payload)?;
    digest.finish()
}

pub(super) fn validate_evidence_identity(
    family: ProfileSourceFamily,
    selector: &ProfileSourceSelector,
    observation: &ProfileSourceObservation,
    file_identity: Option<&str>,
) -> Result<u64, RuntimeError> {
    selector.validate_for(family)?;
    if let Some(file_identity) = file_identity {
        require_bounded_text(file_identity, PROFILE_SOURCE_IDENTITY_BYTES)?;
    }
    match (selector, observation, file_identity) {
        (
            ProfileSourceSelector::WholeFile {},
            ProfileSourceObservation::FileBytes { length },
            Some(_),
        ) => Ok(*length),
        (ProfileSourceSelector::WholeFile {}, ProfileSourceObservation::Missing {}, None)
        | (
            ProfileSourceSelector::GlobalCredential { .. }
            | ProfileSourceSelector::AccountCredential { .. },
            ProfileSourceObservation::Missing {},
            None,
        ) => Ok(0),
        (
            ProfileSourceSelector::GlobalCredential { .. }
            | ProfileSourceSelector::AccountCredential { .. },
            ProfileSourceObservation::StoredString { length, .. },
            None,
        ) => Ok(*length),
        _ => Err(invalid_manifest(
            "Profile source manifest evidence has incompatible fields",
        )),
    }
}

pub(super) fn validate_sha256(value: &str) -> Result<(), RuntimeError> {
    decode_sha256(value).map(|_| ())
}

fn update_length_prefixed(state: &mut Sha256, bytes: &[u8]) -> Result<(), RuntimeError> {
    let length = u64::try_from(bytes.len())
        .map_err(|_| invalid_manifest("Profile source manifest framing length overflows"))?;
    state.update(length.to_be_bytes());
    state.update(bytes);
    Ok(())
}

fn canonical_json(value: &impl Serialize) -> Result<Vec<u8>, RuntimeError> {
    serde_json::to_vec(value)
        .map_err(|_| invalid_manifest("Profile source manifest identity cannot be serialized"))
}

fn decode_sha256(value: &str) -> Result<[u8; 32], RuntimeError> {
    if value.len() != 64 {
        return Err(invalid_manifest(
            "Profile source manifest digest is not lowercase SHA-256",
        ));
    }
    let mut decoded = [0_u8; 32];
    for (index, pair) in value.as_bytes().chunks_exact(2).enumerate() {
        decoded[index] = (decode_nibble(pair[0])? << 4) | decode_nibble(pair[1])?;
    }
    Ok(decoded)
}

fn decode_nibble(value: u8) -> Result<u8, RuntimeError> {
    match value {
        b'0'..=b'9' => Ok(value - b'0'),
        b'a'..=b'f' => Ok(value - b'a' + 10),
        _ => Err(invalid_manifest(
            "Profile source manifest digest is not lowercase SHA-256",
        )),
    }
}

fn encode_sha256(value: [u8; 32]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut encoded = String::with_capacity(64);
    for byte in value {
        encoded.push(char::from(HEX[usize::from(byte >> 4)]));
        encoded.push(char::from(HEX[usize::from(byte & 0x0f)]));
    }
    encoded
}

fn invalid_manifest(message: &'static str) -> RuntimeError {
    RuntimeError::new(RuntimeErrorCode::InvariantViolation, message)
}
