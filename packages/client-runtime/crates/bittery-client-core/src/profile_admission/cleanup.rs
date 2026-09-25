//! A committed cleanup capability cannot read or prove an import source.
use super::*;

#[cfg_attr(
    feature = "profile-admission-contract-schema",
    derive(schemars::JsonSchema)
)]
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(
    feature = "profile-admission-contract-schema",
    schemars(rename = "ProfileSourceCleanupSnapshot")
)]
#[serde(remote = "Self", rename_all = "camelCase", deny_unknown_fields)]
pub struct ProfileSourceCleanupSnapshot {
    pub format: LegacyProfileFormat,
    #[cfg_attr(feature = "profile-admission-contract-schema", schemars(length(min = 1, max = PROFILE_SOURCE_IDENTITY_BYTES)))]
    pub snapshot_handle: String,
    #[cfg_attr(feature = "profile-admission-contract-schema", schemars(length(min = 1, max = PROFILE_SOURCE_IDENTITY_BYTES)))]
    pub profile_identity: String,
    #[cfg_attr(feature = "profile-admission-contract-schema", schemars(length(min = 1, max = PROFILE_SOURCE_IDENTITY_BYTES)))]
    pub capture_id: String,
    #[cfg_attr(feature = "profile-admission-contract-schema", schemars(length(min = 1, max = PROFILE_SOURCE_IDENTITY_BYTES)))]
    pub admission_id: String,
}

impl ProfileSourceCleanupSnapshot {
    pub fn validate(&self) -> Result<(), RuntimeError> {
        for value in [
            &self.snapshot_handle,
            &self.profile_identity,
            &self.capture_id,
            &self.admission_id,
        ] {
            require_bounded_text(value, PROFILE_SOURCE_IDENTITY_BYTES)?;
        }
        Ok(())
    }
}

#[cfg_attr(
    feature = "profile-admission-contract-schema",
    derive(schemars::JsonSchema)
)]
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(
    feature = "profile-admission-contract-schema",
    schemars(rename = "ProfileSourceCleanupReopenStep")
)]
#[serde(
    remote = "Self",
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum ProfileSourceCleanupReopenStep {
    Start {
        #[cfg_attr(feature = "profile-admission-contract-schema", schemars(length(min = 1, max = PROFILE_SOURCE_IDENTITY_BYTES)))]
        verification_attempt_id: String,
        #[cfg_attr(feature = "profile-admission-contract-schema", schemars(length(min = 1, max = PROFILE_SOURCE_IDENTITY_BYTES)))]
        admission_id: String,
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

impl ProfileSourceCleanupReopenStep {
    pub(super) fn validate(&self) -> Result<(), RuntimeError> {
        match self {
            Self::Start {
                verification_attempt_id,
                admission_id,
                header,
            } => {
                require_bounded_text(verification_attempt_id, PROFILE_SOURCE_IDENTITY_BYTES)?;
                require_bounded_text(admission_id, PROFILE_SOURCE_IDENTITY_BYTES)?;
                header.validate()
            }
            Self::Entry {
                verification_cursor,
                expected_entry,
                ..
            } => {
                require_bounded_text(verification_cursor, PROFILE_SOURCE_CURSOR_BYTES)?;
                expected_entry.validate_digest_fields()
            }
            Self::Finish {
                verification_cursor,
            } => require_bounded_text(verification_cursor, PROFILE_SOURCE_CURSOR_BYTES),
        }
    }
}

#[cfg_attr(
    feature = "profile-admission-contract-schema",
    derive(schemars::JsonSchema)
)]
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(
    feature = "profile-admission-contract-schema",
    schemars(rename = "ProfileSourceCleanupReopenResult")
)]
#[serde(
    remote = "Self",
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum ProfileSourceCleanupReopenResult {
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
    Accepted {
        #[cfg_attr(feature = "profile-admission-contract-schema", schemars(length(min = 1, max = PROFILE_SOURCE_CURSOR_BYTES)))]
        verification_cursor: String,
        #[serde(with = "decimal_u64")]
        #[cfg_attr(
            feature = "profile-admission-contract-schema",
            schemars(schema_with = "decimal_u64::json_schema")
        )]
        next_index: u64,
    },
    Reopened {
        snapshot: ProfileSourceCleanupSnapshot,
    },
    Unavailable {},
}

#[cfg_attr(
    feature = "profile-admission-contract-schema",
    derive(schemars::JsonSchema)
)]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(
    feature = "profile-admission-contract-schema",
    schemars(rename = "ProfileSourceDeleteResult")
)]
#[serde(
    remote = "Self",
    tag = "type",
    rename_all = "camelCase",
    deny_unknown_fields
)]
pub enum ProfileSourceDeleteResult {
    Deleted {},
    AlreadyAbsent {},
    Changed {},
    Unavailable {},
}

map_only_serde!(
    ProfileSourceCleanupSnapshot,
    ProfileSourceCleanupReopenStep,
    ProfileSourceCleanupReopenResult,
    ProfileSourceDeleteResult,
);
