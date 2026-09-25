//! Trusted startup configuration and closed legacy-source primitives.
//!
//! The executor owns the live exclusive profile capability. It may begin a snapshot only while
//! that capability remains valid; a persisted capture identity is never a replacement for it.
//! These controls are not renderer Runtime requests and carry no general storage paths.

mod cleanup;
mod manifest;
mod reset;
pub use reset::{
    ProfileLegacyResetScope, ProfileResetFamilyScope, ProfileResetFileBinding,
    ProfileResetPreparedResult, ProfileResetResult, ProfileResetSnapshot,
};

pub use cleanup::{
    ProfileSourceCleanupReopenResult, ProfileSourceCleanupReopenStep, ProfileSourceCleanupSnapshot,
    ProfileSourceDeleteResult,
};
pub use manifest::{ProfileSourceEvidenceDigest, ProfileSourceManifestDigest};

use crate::{
    wire::{decimal_u64, map_only_serde},
    AccountId, RuntimeError, RuntimeErrorCode,
};
use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use zeroize::Zeroizing;

pub const PROFILE_SOURCE_CONTROL_BYTES: usize = 262_144;
pub const PROFILE_SOURCE_BINARY_BYTES: usize = 262_144;
pub const PROFILE_SOURCE_IDENTITY_BYTES: usize = 4096;
pub const PROFILE_SOURCE_CURSOR_BYTES: usize = 98_304;
pub const PROFILE_SOURCE_MANIFEST_VERSION: u8 = 1;

#[cfg_attr(
    feature = "profile-admission-contract-schema",
    derive(schemars::JsonSchema)
)]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum LegacyProfileFormat {
    DesktopLegacyV1,
    ExtensionLegacyV1,
}

#[cfg_attr(
    feature = "profile-admission-contract-schema",
    derive(schemars::JsonSchema)
)]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ProfileSourceFamily {
    DesktopStore,
    DesktopSyncStore,
    DesktopCredentials,
    ExtensionLocal,
    ExtensionSession,
    ExtensionRecords,
}

#[cfg_attr(
    feature = "profile-admission-contract-schema",
    derive(schemars::JsonSchema)
)]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ProfileSourcePresence {
    Missing,
    Present,
}

#[cfg_attr(
    feature = "profile-admission-contract-schema",
    derive(schemars::JsonSchema)
)]
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(
    feature = "profile-admission-contract-schema",
    schemars(rename = "ProfileSourceFamilyInventory")
)]
#[serde(remote = "Self")]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProfileSourceFamilyInventory {
    pub family: ProfileSourceFamily,
    pub presence: ProfileSourcePresence,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(
        feature = "profile-admission-contract-schema",
        schemars(schema_with = "optional_identity_schema")
    )]
    pub file_identity: Option<String>,
}

#[cfg_attr(
    feature = "profile-admission-contract-schema",
    derive(schemars::JsonSchema)
)]
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(
    feature = "profile-admission-contract-schema",
    schemars(rename = "ProfileSourceSnapshot")
)]
#[serde(remote = "Self")]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProfileSourceSnapshot {
    pub format: LegacyProfileFormat,
    #[cfg_attr(feature = "profile-admission-contract-schema", schemars(length(min = 1, max = PROFILE_SOURCE_IDENTITY_BYTES)))]
    pub snapshot_handle: String,
    #[cfg_attr(feature = "profile-admission-contract-schema", schemars(length(min = 1, max = PROFILE_SOURCE_IDENTITY_BYTES)))]
    pub profile_identity: String,
    #[cfg_attr(feature = "profile-admission-contract-schema", schemars(length(min = 1, max = PROFILE_SOURCE_IDENTITY_BYTES)))]
    pub capture_id: String,
    #[cfg_attr(
        feature = "profile-admission-contract-schema",
        schemars(length(min = 3, max = 3))
    )]
    pub families: Vec<ProfileSourceFamilyInventory>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(
        feature = "profile-admission-contract-schema",
        schemars(schema_with = "optional_identity_schema")
    )]
    pub session_instance: Option<String>,
}

#[cfg_attr(
    feature = "profile-admission-contract-schema",
    derive(schemars::JsonSchema)
)]
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(
    feature = "profile-admission-contract-schema",
    schemars(rename = "ProfileSnapshotCloseSelector")
)]
#[serde(remote = "Self")]
#[serde(tag = "type", rename_all = "camelCase", deny_unknown_fields)]
pub enum ProfileSnapshotCloseSelector {
    Exact {
        #[cfg_attr(feature = "profile-admission-contract-schema", schemars(length(min = 1, max = PROFILE_SOURCE_IDENTITY_BYTES)))]
        handle: String,
    },
    // Internally tagged unit variants ignore unknown fields in Serde; empty structs reject them.
    CurrentCapability {},
}

#[cfg_attr(
    feature = "profile-admission-contract-schema",
    derive(schemars::JsonSchema)
)]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ProfileGlobalCredentialField {
    DeviceKey,
}

#[cfg_attr(
    feature = "profile-admission-contract-schema",
    derive(schemars::JsonSchema)
)]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ProfileAccountCredentialField {
    SecretKey,
    SessionData,
    JwtToken,
    VaultKeys,
    EncryptedPrivateKey,
}

#[cfg_attr(
    feature = "profile-admission-contract-schema",
    derive(schemars::JsonSchema)
)]
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(
    feature = "profile-admission-contract-schema",
    schemars(rename = "ProfileSourceSelector")
)]
#[serde(remote = "Self")]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum ProfileSourceSelector {
    WholeFile {},
    GlobalCredential {
        field: ProfileGlobalCredentialField,
    },
    AccountCredential {
        #[cfg_attr(feature = "profile-admission-contract-schema", schemars(with = "String", length(min = 1, max = PROFILE_SOURCE_IDENTITY_BYTES)))]
        account_id: AccountId,
        field: ProfileAccountCredentialField,
    },
}

impl ProfileSourceSelector {
    pub fn validate_for(&self, family: ProfileSourceFamily) -> Result<(), RuntimeError> {
        match (self, family) {
            (
                Self::WholeFile {},
                ProfileSourceFamily::DesktopStore | ProfileSourceFamily::DesktopSyncStore,
            )
            | (Self::GlobalCredential { .. }, ProfileSourceFamily::DesktopCredentials) => Ok(()),
            (
                Self::AccountCredential { account_id, .. },
                ProfileSourceFamily::DesktopCredentials,
            ) => require_bounded_text(account_id.as_str(), PROFILE_SOURCE_IDENTITY_BYTES),
            _ => Err(invalid_source_page(
                "Profile source selector is unsupported for its family",
            )),
        }
    }
}

#[cfg_attr(
    feature = "profile-admission-contract-schema",
    derive(schemars::JsonSchema)
)]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ProfileSourceStringEncoding {
    Utf8,
    Utf16Le,
}

#[cfg_attr(
    feature = "profile-admission-contract-schema",
    derive(schemars::JsonSchema)
)]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ProfileSourceValueKind {
    Null,
    Boolean,
    Number,
    Array,
    Object,
    OtherUnsupported,
}

#[cfg_attr(
    feature = "profile-admission-contract-schema",
    derive(schemars::JsonSchema)
)]
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(
    feature = "profile-admission-contract-schema",
    schemars(rename = "ProfileSourceObservation")
)]
#[serde(remote = "Self")]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum ProfileSourceObservation {
    Missing {},
    FileBytes {
        #[serde(with = "decimal_u64")]
        #[cfg_attr(
            feature = "profile-admission-contract-schema",
            schemars(schema_with = "decimal_u64::json_schema")
        )]
        length: u64,
    },
    StoredString {
        encoding: ProfileSourceStringEncoding,
        #[serde(with = "decimal_u64")]
        #[cfg_attr(
            feature = "profile-admission-contract-schema",
            schemars(schema_with = "decimal_u64::json_schema")
        )]
        length: u64,
    },
    PresentUnsupported {
        value_kind: ProfileSourceValueKind,
    },
}

#[cfg_attr(
    feature = "profile-admission-contract-schema",
    derive(schemars::JsonSchema)
)]
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(
    feature = "profile-admission-contract-schema",
    schemars(rename = "ProfileSourceManifestHeader")
)]
#[serde(remote = "Self")]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProfileSourceManifestHeader {
    #[cfg_attr(
        feature = "profile-admission-contract-schema",
        schemars(schema_with = "manifest_version_schema")
    )]
    pub version: u8,
    pub format: LegacyProfileFormat,
    #[cfg_attr(feature = "profile-admission-contract-schema", schemars(length(min = 1, max = PROFILE_SOURCE_IDENTITY_BYTES)))]
    pub profile_identity: String,
    #[cfg_attr(feature = "profile-admission-contract-schema", schemars(length(min = 1, max = PROFILE_SOURCE_IDENTITY_BYTES)))]
    pub recorded_capture_id: String,
    #[serde(with = "decimal_u64")]
    #[cfg_attr(
        feature = "profile-admission-contract-schema",
        schemars(schema_with = "decimal_u64::json_schema")
    )]
    pub entry_count: u64,
    #[cfg_attr(
        feature = "profile-admission-contract-schema",
        schemars(schema_with = "sha256_schema")
    )]
    pub entries_sha256: String,
}

impl ProfileSourceManifestHeader {
    pub fn validate(&self) -> Result<(), RuntimeError> {
        if self.version != PROFILE_SOURCE_MANIFEST_VERSION {
            return Err(invalid_source_page(
                "Profile source manifest version is unsupported",
            ));
        }
        require_bounded_text(&self.profile_identity, PROFILE_SOURCE_IDENTITY_BYTES)?;
        require_bounded_text(&self.recorded_capture_id, PROFILE_SOURCE_IDENTITY_BYTES)?;
        manifest::validate_sha256(&self.entries_sha256)
    }

    pub fn digest(&self) -> Result<ProfileSourceManifestDigest, RuntimeError> {
        self.validate()?;
        ProfileSourceManifestDigest::new(self.format, &self.profile_identity, self.entry_count)
    }

    pub fn verify_digest(&self, digest: ProfileSourceManifestDigest) -> Result<bool, RuntimeError> {
        self.validate()?;
        Ok(digest.finish()? == self.entries_sha256)
    }
}

#[cfg_attr(
    feature = "profile-admission-contract-schema",
    derive(schemars::JsonSchema)
)]
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(
    feature = "profile-admission-contract-schema",
    schemars(rename = "ProfileSourceManifestEntry")
)]
#[serde(remote = "Self")]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProfileSourceManifestEntry {
    #[cfg_attr(
        feature = "profile-admission-contract-schema",
        schemars(schema_with = "manifest_version_schema")
    )]
    pub version: u8,
    pub family: ProfileSourceFamily,
    pub selector: ProfileSourceSelector,
    pub observation: ProfileSourceObservation,
    #[serde(deserialize_with = "required_identity_option")]
    #[cfg_attr(
        feature = "profile-admission-contract-schema",
        schemars(schema_with = "optional_identity_schema")
    )]
    pub file_identity: Option<String>,
    #[cfg_attr(
        feature = "profile-admission-contract-schema",
        schemars(schema_with = "sha256_schema")
    )]
    pub evidence_sha256: String,
}

impl ProfileSourceManifestEntry {
    pub fn from_evidence(
        format: LegacyProfileFormat,
        family: ProfileSourceFamily,
        selector: ProfileSourceSelector,
        observation: ProfileSourceObservation,
        file_identity: Option<String>,
        payload: &[u8],
    ) -> Result<Self, RuntimeError> {
        let evidence_sha256 = manifest::evidence_sha256(
            format,
            family,
            &selector,
            &observation,
            file_identity.as_deref(),
            payload,
        )?;
        Ok(Self {
            version: PROFILE_SOURCE_MANIFEST_VERSION,
            family,
            selector,
            observation,
            file_identity,
            evidence_sha256,
        })
    }

    pub fn evidence_digest(
        &self,
        format: LegacyProfileFormat,
    ) -> Result<ProfileSourceEvidenceDigest, RuntimeError> {
        self.validate_digest_fields()?;
        ProfileSourceEvidenceDigest::new(
            format,
            self.family,
            &self.selector,
            &self.observation,
            self.file_identity.as_deref(),
        )
    }

    pub fn verify_evidence(
        &self,
        format: LegacyProfileFormat,
        payload: &[u8],
    ) -> Result<bool, RuntimeError> {
        let mut digest = self.evidence_digest(format)?;
        digest.update(payload)?;
        Ok(digest.finish()? == self.evidence_sha256)
    }

    pub fn validate_digest_fields(&self) -> Result<(), RuntimeError> {
        if self.version != PROFILE_SOURCE_MANIFEST_VERSION {
            return Err(invalid_source_page(
                "Profile source manifest version is unsupported",
            ));
        }
        manifest::validate_evidence_identity(
            self.family,
            &self.selector,
            &self.observation,
            self.file_identity.as_deref(),
        )?;
        manifest::validate_sha256(&self.evidence_sha256)
    }

    pub fn validate_for_format(&self, format: LegacyProfileFormat) -> Result<(), RuntimeError> {
        self.validate_digest_fields()?;
        manifest::validate_family_for_format(format, self.family)
    }
}

#[cfg_attr(
    feature = "profile-admission-contract-schema",
    derive(schemars::JsonSchema)
)]
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(
    feature = "profile-admission-contract-schema",
    schemars(rename = "ProfileSourceReopenStep")
)]
#[serde(remote = "Self")]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum ProfileSourceReopenStep {
    Start {
        #[cfg_attr(feature = "profile-admission-contract-schema", schemars(length(min = 1, max = PROFILE_SOURCE_IDENTITY_BYTES)))]
        verification_attempt_id: String,
        header: ProfileSourceManifestHeader,
    },
    Entry {
        #[cfg_attr(feature = "profile-admission-contract-schema", schemars(length(min = 1, max = PROFILE_SOURCE_CURSOR_BYTES)))]
        verification_cursor: String,
        #[serde(with = "decimal_u64")]
        #[cfg_attr(
            feature = "profile-admission-contract-schema",
            schemars(schema_with = "decimal_u64::json_schema")
        )]
        index: u64,
        expected_entry: ProfileSourceManifestEntry,
    },
    Finish {
        #[cfg_attr(feature = "profile-admission-contract-schema", schemars(length(min = 1, max = PROFILE_SOURCE_CURSOR_BYTES)))]
        verification_cursor: String,
    },
}

#[cfg_attr(
    feature = "profile-admission-contract-schema",
    derive(schemars::JsonSchema)
)]
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(
    feature = "profile-admission-contract-schema",
    schemars(rename = "ProfileSourceVerifyStep")
)]
#[serde(remote = "Self")]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum ProfileSourceVerifyStep {
    Start {
        #[cfg_attr(feature = "profile-admission-contract-schema", schemars(length(min = 1, max = PROFILE_SOURCE_IDENTITY_BYTES)))]
        verification_attempt_id: String,
        #[cfg_attr(feature = "profile-admission-contract-schema", schemars(length(min = 1, max = PROFILE_SOURCE_IDENTITY_BYTES)))]
        snapshot_handle: String,
        header: ProfileSourceManifestHeader,
    },
    Entry {
        #[cfg_attr(feature = "profile-admission-contract-schema", schemars(length(min = 1, max = PROFILE_SOURCE_CURSOR_BYTES)))]
        verification_cursor: String,
        #[serde(with = "decimal_u64")]
        #[cfg_attr(
            feature = "profile-admission-contract-schema",
            schemars(schema_with = "decimal_u64::json_schema")
        )]
        index: u64,
        expected_entry: ProfileSourceManifestEntry,
    },
    Finish {
        #[cfg_attr(feature = "profile-admission-contract-schema", schemars(length(min = 1, max = PROFILE_SOURCE_CURSOR_BYTES)))]
        verification_cursor: String,
    },
}

#[cfg_attr(
    feature = "profile-admission-contract-schema",
    derive(schemars::JsonSchema)
)]
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(
    feature = "profile-admission-contract-schema",
    schemars(rename = "ProfileSourceVerificationResult")
)]
#[serde(remote = "Self")]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum ProfileSourceVerificationResult {
    Started {
        #[cfg_attr(feature = "profile-admission-contract-schema", schemars(length(min = 1, max = PROFILE_SOURCE_CURSOR_BYTES)))]
        verification_cursor: String,
        #[serde(with = "decimal_u64")]
        #[cfg_attr(
            feature = "profile-admission-contract-schema",
            schemars(schema_with = "decimal_u64::json_schema")
        )]
        next_index: u64,
    },
    Matched {
        #[cfg_attr(feature = "profile-admission-contract-schema", schemars(length(min = 1, max = PROFILE_SOURCE_CURSOR_BYTES)))]
        verification_cursor: String,
        #[serde(with = "decimal_u64")]
        #[cfg_attr(
            feature = "profile-admission-contract-schema",
            schemars(schema_with = "decimal_u64::json_schema")
        )]
        next_index: u64,
    },
    Changed {},
    Unavailable {},
    Reopened {
        snapshot: ProfileSourceSnapshot,
    },
    Unchanged {
        #[cfg_attr(feature = "profile-admission-contract-schema", schemars(length(min = 1, max = PROFILE_SOURCE_IDENTITY_BYTES)))]
        snapshot_handle: String,
    },
}

#[cfg_attr(
    feature = "profile-admission-contract-schema",
    derive(schemars::JsonSchema)
)]
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(
    feature = "profile-admission-contract-schema",
    schemars(rename = "ProfileSourceContinuation")
)]
#[serde(remote = "Self")]
#[serde(tag = "type", rename_all = "camelCase", deny_unknown_fields)]
pub enum ProfileSourceContinuation {
    More {
        #[cfg_attr(feature = "profile-admission-contract-schema", schemars(length(min = 1, max = PROFILE_SOURCE_CURSOR_BYTES)))]
        cursor: String,
    },
    End {},
}

/// Raw content stays in the separately owned binary result, never in control JSON.
#[cfg_attr(
    feature = "profile-admission-contract-schema",
    derive(schemars::JsonSchema)
)]
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(
    feature = "profile-admission-contract-schema",
    schemars(rename = "ProfileSourcePage")
)]
#[serde(remote = "Self")]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProfileSourcePage {
    #[cfg_attr(feature = "profile-admission-contract-schema", schemars(length(min = 1, max = PROFILE_SOURCE_IDENTITY_BYTES)))]
    pub snapshot_handle: String,
    pub family: ProfileSourceFamily,
    pub selector: ProfileSourceSelector,
    pub observation: ProfileSourceObservation,
    #[serde(with = "decimal_u64")]
    #[cfg_attr(
        feature = "profile-admission-contract-schema",
        schemars(schema_with = "decimal_u64::json_schema")
    )]
    pub offset: u64,
    #[serde(with = "decimal_u64")]
    #[cfg_attr(
        feature = "profile-admission-contract-schema",
        schemars(schema_with = "decimal_u64::json_schema")
    )]
    pub byte_length: u64,
    pub continuation: ProfileSourceContinuation,
}

impl ProfileSourcePage {
    /// The caller retains prior progress; this validation owns no cursor or reader state.
    pub fn validate_for(
        &self,
        snapshot_handle: &str,
        family: ProfileSourceFamily,
        selector: &ProfileSourceSelector,
        expected_offset: u64,
        previous_observation: Option<&ProfileSourceObservation>,
        binary: Option<&[u8]>,
    ) -> Result<(), RuntimeError> {
        require_bounded_text(&self.snapshot_handle, PROFILE_SOURCE_IDENTITY_BYTES)?;
        self.selector.validate_for(self.family)?;
        if self.snapshot_handle != snapshot_handle
            || self.family != family
            || &self.selector != selector
            || self.offset != expected_offset
            || previous_observation.is_some_and(|previous| previous != &self.observation)
        {
            return Err(invalid_source_page(
                "Profile source page does not match its read scope",
            ));
        }
        if let ProfileSourceContinuation::More { cursor } = &self.continuation {
            require_bounded_text(cursor, PROFILE_SOURCE_CURSOR_BYTES)?;
        }
        let total = match (&self.selector, &self.observation) {
            (_, ProfileSourceObservation::Missing {}) => None,
            (
                ProfileSourceSelector::WholeFile {},
                ProfileSourceObservation::FileBytes { length },
            ) => Some(*length),
            (
                ProfileSourceSelector::GlobalCredential { .. }
                | ProfileSourceSelector::AccountCredential { .. },
                ProfileSourceObservation::StoredString { length, .. },
            ) => Some(*length),
            (
                ProfileSourceSelector::GlobalCredential { .. }
                | ProfileSourceSelector::AccountCredential { .. },
                ProfileSourceObservation::PresentUnsupported { .. },
            ) => None,
            _ => {
                return Err(invalid_source_page(
                    "Profile source observation does not match its selector",
                ));
            }
        };
        let Some(total) = total else {
            if binary.is_some()
                || self.offset != 0
                || self.byte_length != 0
                || !matches!(self.continuation, ProfileSourceContinuation::End {})
            {
                return Err(invalid_source_page(
                    "Profile source absent or unsupported value carries content",
                ));
            }
            return Ok(());
        };
        let bytes = binary
            .ok_or_else(|| invalid_source_page("Profile source content has no binary buffer"))?;
        if bytes.len() > PROFILE_SOURCE_BINARY_BYTES || self.byte_length != bytes.len() as u64 {
            return Err(invalid_source_page(
                "Profile source binary length is invalid",
            ));
        }
        let end = self
            .offset
            .checked_add(self.byte_length)
            .ok_or_else(|| invalid_source_page("Profile source page offset overflows"))?;
        if end > total || (self.byte_length == 0 && (total != 0 || self.offset != 0)) {
            return Err(invalid_source_page(
                "Profile source page does not make bounded progress",
            ));
        }
        if matches!(self.continuation, ProfileSourceContinuation::End {}) != (end == total) {
            return Err(invalid_source_page(
                "Profile source continuation contradicts its total length",
            ));
        }
        Ok(())
    }
}

fn require_bounded_text(value: &str, maximum: usize) -> Result<(), RuntimeError> {
    if value.is_empty() || value.len() > maximum {
        return Err(invalid_source_page(
            "Profile source identity or cursor is outside its bound",
        ));
    }
    Ok(())
}

fn invalid_source_page(message: &'static str) -> RuntimeError {
    RuntimeError::new(RuntimeErrorCode::InvariantViolation, message)
}

fn required_cursor<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<String>, D::Error> {
    Option::<String>::deserialize(deserializer)
}

fn required_identity_option<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<String>, D::Error> {
    Option::<String>::deserialize(deserializer)
}

#[cfg(feature = "profile-admission-contract-schema")]
fn cursor_schema(_: &mut schemars::SchemaGenerator) -> schemars::Schema {
    schemars::json_schema!({"type":["string","null"],"minLength":1,"maxLength":PROFILE_SOURCE_CURSOR_BYTES})
}

#[cfg(feature = "profile-admission-contract-schema")]
fn optional_identity_schema(_: &mut schemars::SchemaGenerator) -> schemars::Schema {
    schemars::json_schema!({"type":["string","null"],"minLength":1,"maxLength":PROFILE_SOURCE_IDENTITY_BYTES})
}

#[cfg(feature = "profile-admission-contract-schema")]
fn manifest_version_schema(_: &mut schemars::SchemaGenerator) -> schemars::Schema {
    schemars::json_schema!({"type":"integer","const":PROFILE_SOURCE_MANIFEST_VERSION})
}

#[cfg(feature = "profile-admission-contract-schema")]
fn sha256_schema(_: &mut schemars::SchemaGenerator) -> schemars::Schema {
    schemars::json_schema!({"type":"string","pattern":"^[0-9a-f]{64}$"})
}

#[cfg_attr(
    feature = "profile-admission-contract-schema",
    derive(schemars::JsonSchema)
)]
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(
    feature = "profile-admission-contract-schema",
    schemars(rename = "ProfileAdmissionRequest")
)]
#[serde(remote = "Self")]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum ProfileAdmissionRequest {
    PrepareLegacyProfileReset {
        #[cfg_attr(feature = "profile-admission-contract-schema", schemars(length(min = 1, max = PROFILE_SOURCE_IDENTITY_BYTES)))]
        wipe_id: String,
        format: LegacyProfileFormat,
        #[serde(deserialize_with = "reset::required_scope")]
        #[cfg_attr(
            feature = "profile-admission-contract-schema",
            schemars(schema_with = "reset::scope_schema")
        )]
        expected_scope: Option<ProfileLegacyResetScope>,
    },
    ResetLegacySourceFamily {
        #[cfg_attr(feature = "profile-admission-contract-schema", schemars(length(min = 1, max = PROFILE_SOURCE_IDENTITY_BYTES)))]
        reset_handle: String,
        #[cfg_attr(feature = "profile-admission-contract-schema", schemars(length(min = 1, max = PROFILE_SOURCE_IDENTITY_BYTES)))]
        wipe_id: String,
        family: ProfileSourceFamily,
    },
    BeginSourceSnapshot {
        format: LegacyProfileFormat,
    },
    ReadSourcePage {
        #[cfg_attr(feature = "profile-admission-contract-schema", schemars(length(min = 1, max = PROFILE_SOURCE_IDENTITY_BYTES)))]
        snapshot_handle: String,
        family: ProfileSourceFamily,
        selector: ProfileSourceSelector,
        #[serde(deserialize_with = "required_cursor")]
        #[cfg_attr(
            feature = "profile-admission-contract-schema",
            schemars(schema_with = "cursor_schema")
        )]
        cursor: Option<String>,
    },
    CloseSourceSnapshot {
        selector: ProfileSnapshotCloseSelector,
    },
    ReopenSourceSnapshot {
        step: ProfileSourceReopenStep,
    },
    VerifySourceSnapshot {
        step: ProfileSourceVerifyStep,
    },
    ReopenSourceForCleanup {
        step: ProfileSourceCleanupReopenStep,
    },
    DeleteCapturedSource {
        #[cfg_attr(feature = "profile-admission-contract-schema", schemars(length(min = 1, max = PROFILE_SOURCE_IDENTITY_BYTES)))]
        snapshot_handle: String,
        #[cfg_attr(feature = "profile-admission-contract-schema", schemars(length(min = 1, max = PROFILE_SOURCE_IDENTITY_BYTES)))]
        admission_id: String,
        #[serde(with = "decimal_u64")]
        #[cfg_attr(
            feature = "profile-admission-contract-schema",
            schemars(schema_with = "decimal_u64::json_schema")
        )]
        index: u64,
        expected_entry: ProfileSourceManifestEntry,
    },
}

impl ProfileAdmissionRequest {
    pub fn validate(&self) -> Result<(), RuntimeError> {
        match self {
            Self::PrepareLegacyProfileReset {
                wipe_id,
                format,
                expected_scope,
            } => {
                require_bounded_text(wipe_id, PROFILE_SOURCE_IDENTITY_BYTES)?;
                if *format != LegacyProfileFormat::DesktopLegacyV1 {
                    return Err(invalid_source_page("Profile reset format is unsupported"));
                }
                if let Some(scope) = expected_scope {
                    scope.validate()?;
                    if scope.format != *format {
                        return Err(invalid_source_page("Profile reset scope format disagrees"));
                    }
                }
                Ok(())
            }
            Self::ResetLegacySourceFamily {
                reset_handle,
                wipe_id,
                family,
            } => {
                require_bounded_text(reset_handle, PROFILE_SOURCE_IDENTITY_BYTES)?;
                require_bounded_text(wipe_id, PROFILE_SOURCE_IDENTITY_BYTES)?;
                if !matches!(
                    family,
                    ProfileSourceFamily::DesktopStore
                        | ProfileSourceFamily::DesktopSyncStore
                        | ProfileSourceFamily::DesktopCredentials
                ) {
                    return Err(invalid_source_page("Profile reset family is unsupported"));
                }
                Ok(())
            }
            Self::BeginSourceSnapshot { .. }
            | Self::CloseSourceSnapshot {
                selector: ProfileSnapshotCloseSelector::CurrentCapability {},
            } => Ok(()),
            Self::CloseSourceSnapshot {
                selector: ProfileSnapshotCloseSelector::Exact { handle },
            } => require_bounded_text(handle, PROFILE_SOURCE_IDENTITY_BYTES),
            Self::ReadSourcePage {
                snapshot_handle,
                family,
                selector,
                cursor,
            } => {
                require_bounded_text(snapshot_handle, PROFILE_SOURCE_IDENTITY_BYTES)?;
                selector.validate_for(*family)?;
                if let Some(cursor) = cursor {
                    require_bounded_text(cursor, PROFILE_SOURCE_CURSOR_BYTES)?;
                }
                Ok(())
            }
            Self::ReopenSourceSnapshot { step } => validate_reopen_step(step),
            Self::VerifySourceSnapshot { step } => validate_verify_step(step),
            Self::ReopenSourceForCleanup { step } => step.validate(),
            Self::DeleteCapturedSource {
                snapshot_handle,
                admission_id,
                expected_entry,
                ..
            } => {
                require_bounded_text(snapshot_handle, PROFILE_SOURCE_IDENTITY_BYTES)?;
                require_bounded_text(admission_id, PROFILE_SOURCE_IDENTITY_BYTES)?;
                expected_entry.validate_digest_fields()?;
                if matches!(
                    expected_entry.observation,
                    ProfileSourceObservation::Missing {}
                ) {
                    return Err(invalid_source_page(
                        "Missing source evidence cannot authorize deletion",
                    ));
                }
                Ok(())
            }
        }
    }
}

fn validate_reopen_step(step: &ProfileSourceReopenStep) -> Result<(), RuntimeError> {
    match step {
        ProfileSourceReopenStep::Start {
            verification_attempt_id,
            header,
        } => {
            require_bounded_text(verification_attempt_id, PROFILE_SOURCE_IDENTITY_BYTES)?;
            header.validate()
        }
        ProfileSourceReopenStep::Entry {
            verification_cursor,
            expected_entry,
            ..
        } => {
            require_bounded_text(verification_cursor, PROFILE_SOURCE_CURSOR_BYTES)?;
            expected_entry.validate_digest_fields()
        }
        ProfileSourceReopenStep::Finish {
            verification_cursor,
        } => require_bounded_text(verification_cursor, PROFILE_SOURCE_CURSOR_BYTES),
    }
}

fn validate_verify_step(step: &ProfileSourceVerifyStep) -> Result<(), RuntimeError> {
    match step {
        ProfileSourceVerifyStep::Start {
            verification_attempt_id,
            snapshot_handle,
            header,
        } => {
            require_bounded_text(verification_attempt_id, PROFILE_SOURCE_IDENTITY_BYTES)?;
            require_bounded_text(snapshot_handle, PROFILE_SOURCE_IDENTITY_BYTES)?;
            header.validate()
        }
        ProfileSourceVerifyStep::Entry {
            verification_cursor,
            expected_entry,
            ..
        } => {
            require_bounded_text(verification_cursor, PROFILE_SOURCE_CURSOR_BYTES)?;
            expected_entry.validate_digest_fields()
        }
        ProfileSourceVerifyStep::Finish {
            verification_cursor,
        } => require_bounded_text(verification_cursor, PROFILE_SOURCE_CURSOR_BYTES),
    }
}

#[cfg_attr(
    feature = "profile-admission-contract-schema",
    derive(schemars::JsonSchema)
)]
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(
    feature = "profile-admission-contract-schema",
    schemars(rename = "ProfileAdmissionResponse")
)]
#[serde(remote = "Self")]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum ProfileAdmissionResponse {
    ProfileResetPrepared {
        result: ProfileResetPreparedResult,
    },
    ProfileResetFamilyResult {
        #[cfg_attr(feature = "profile-admission-contract-schema", schemars(length(min = 1, max = PROFILE_SOURCE_IDENTITY_BYTES)))]
        reset_handle: String,
        #[cfg_attr(feature = "profile-admission-contract-schema", schemars(length(min = 1, max = PROFILE_SOURCE_IDENTITY_BYTES)))]
        wipe_id: String,
        family: ProfileSourceFamily,
        result: ProfileResetResult,
    },
    SourceSnapshot {
        snapshot: ProfileSourceSnapshot,
    },
    SourcePage(ProfileSourcePage),
    SourceSnapshotVerification {
        result: ProfileSourceVerificationResult,
    },
    SourceCleanupReopen {
        result: ProfileSourceCleanupReopenResult,
    },
    SourceCleanupResult {
        #[cfg_attr(feature = "profile-admission-contract-schema", schemars(length(min = 1, max = PROFILE_SOURCE_IDENTITY_BYTES)))]
        snapshot_handle: String,
        #[cfg_attr(feature = "profile-admission-contract-schema", schemars(length(min = 1, max = PROFILE_SOURCE_IDENTITY_BYTES)))]
        admission_id: String,
        #[serde(with = "decimal_u64")]
        #[cfg_attr(
            feature = "profile-admission-contract-schema",
            schemars(schema_with = "decimal_u64::json_schema")
        )]
        index: u64,
        result: ProfileSourceDeleteResult,
    },
    // A malformed acknowledgement must not clear the pending cleanup duty.
    SourceSnapshotClosed {},
}

map_only_serde!(
    ProfileSourceFamilyInventory,
    ProfileSourceSnapshot,
    ProfileSnapshotCloseSelector,
    ProfileSourceSelector,
    ProfileSourceObservation,
    ProfileSourceManifestHeader,
    ProfileSourceManifestEntry,
    ProfileSourceReopenStep,
    ProfileSourceVerifyStep,
    ProfileSourceVerificationResult,
    ProfileSourceContinuation,
    ProfileSourcePage,
    ProfileAdmissionRequest,
    ProfileAdmissionResponse,
);

#[cfg(feature = "profile-admission-contract-schema")]
#[doc(hidden)]
pub fn profile_admission_contract_schema() -> schemars::Schema {
    #[derive(schemars::JsonSchema)]
    #[allow(dead_code)]
    struct ProfileAdmissionContract {
        request: ProfileAdmissionRequest,
        response: ProfileAdmissionResponse,
    }
    let mut settings = schemars::generate::SchemaSettings::draft2020_12();
    settings.contract = schemars::generate::Contract::Serialize;
    settings
        .into_generator()
        .into_root_schema_for::<ProfileAdmissionContract>()
}

#[cfg(not(target_arch = "wasm32"))]
#[async_trait]
pub trait SerializedProfileAdmissionExecutor: Send + Sync {
    async fn invoke(
        &self,
        request_json: Zeroizing<String>,
    ) -> Result<(Zeroizing<String>, Option<Zeroizing<Vec<u8>>>), RuntimeError>;
}

#[cfg(target_arch = "wasm32")]
#[async_trait(?Send)]
pub trait SerializedProfileAdmissionExecutor {
    async fn invoke(
        &self,
        request_json: Zeroizing<String>,
    ) -> Result<(Zeroizing<String>, Option<Zeroizing<Vec<u8>>>), RuntimeError>;
}

#[derive(Clone)]
pub enum ProfileAdmissionSource {
    CoreOnly,
    /// Trusted composition declares that this legacy format applies even when its exclusive
    /// physical capability cannot be acquired. Provider failure never proves an empty profile.
    LegacyUnavailable {
        format: LegacyProfileFormat,
    },
    Legacy {
        format: LegacyProfileFormat,
        executor: Arc<dyn SerializedProfileAdmissionExecutor>,
    },
}

#[derive(Default)]
pub(crate) struct ProfileAdmissionStartup {
    pub(crate) source: Option<ProfileAdmissionSource>,
    pub(crate) started: bool,
    pub(crate) cleanup_snapshot: Option<ProfileSnapshotCloseSelector>,
    // After ownership commits, source deletion can remain retryable without gating Core work.
    // Ordinary captured readers retain the stronger before-publication drain requirement.
    pub(crate) cleanup_only: bool,
}
