//! Explicit whole-profile reset scopes are independent of old Account/catalog decoding.
use super::*;

#[cfg_attr(
    feature = "profile-admission-contract-schema",
    derive(schemars::JsonSchema)
)]
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(
    feature = "profile-admission-contract-schema",
    schemars(rename = "ProfileResetFileBinding")
)]
#[serde(
    remote = "Self",
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum ProfileResetFileBinding {
    Absent {},
    Present {
        #[cfg_attr(feature = "profile-admission-contract-schema", schemars(length(min = 1, max = PROFILE_SOURCE_IDENTITY_BYTES)))]
        file_identity: String,
    },
    NotFile {},
}

#[cfg_attr(
    feature = "profile-admission-contract-schema",
    derive(schemars::JsonSchema)
)]
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(
    feature = "profile-admission-contract-schema",
    schemars(rename = "ProfileResetFamilyScope")
)]
#[serde(remote = "Self", rename_all = "camelCase", deny_unknown_fields)]
pub struct ProfileResetFamilyScope {
    pub family: ProfileSourceFamily,
    #[cfg_attr(feature = "profile-admission-contract-schema", schemars(length(min = 1, max = PROFILE_SOURCE_IDENTITY_BYTES)))]
    pub namespace_identity: String,
    #[cfg_attr(
        feature = "profile-admission-contract-schema",
        schemars(schema_with = "manifest_version_schema")
    )]
    pub selector_plan_version: u8,
    pub file: ProfileResetFileBinding,
}

#[cfg_attr(
    feature = "profile-admission-contract-schema",
    derive(schemars::JsonSchema)
)]
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(
    feature = "profile-admission-contract-schema",
    schemars(rename = "ProfileLegacyResetScope")
)]
#[serde(remote = "Self", rename_all = "camelCase", deny_unknown_fields)]
pub struct ProfileLegacyResetScope {
    #[cfg_attr(
        feature = "profile-admission-contract-schema",
        schemars(schema_with = "manifest_version_schema")
    )]
    pub version: u8,
    pub format: LegacyProfileFormat,
    #[cfg_attr(feature = "profile-admission-contract-schema", schemars(length(min = 1, max = PROFILE_SOURCE_IDENTITY_BYTES)))]
    pub profile_identity: String,
    #[cfg_attr(
        feature = "profile-admission-contract-schema",
        schemars(length(min = 3, max = 3))
    )]
    pub families: Vec<ProfileResetFamilyScope>,
}
impl ProfileLegacyResetScope {
    pub fn validate(&self) -> Result<(), RuntimeError> {
        require_bounded_text(&self.profile_identity, PROFILE_SOURCE_IDENTITY_BYTES)?;
        if self.version != 1
            || self.format != LegacyProfileFormat::DesktopLegacyV1
            || self.families.len() != 3
        {
            return Err(invalid_source_page("Profile reset scope is unsupported"));
        }
        for (scope, expected) in self.families.iter().zip([
            ProfileSourceFamily::DesktopStore,
            ProfileSourceFamily::DesktopSyncStore,
            ProfileSourceFamily::DesktopCredentials,
        ]) {
            require_bounded_text(&scope.namespace_identity, PROFILE_SOURCE_IDENTITY_BYTES)?;
            if scope.family != expected || scope.selector_plan_version != 1 {
                return Err(invalid_source_page(
                    "Profile reset family scope is inconsistent",
                ));
            }
            match (&scope.file, expected) {
                (ProfileResetFileBinding::NotFile {}, ProfileSourceFamily::DesktopCredentials) => {}
                (
                    ProfileResetFileBinding::Absent {},
                    ProfileSourceFamily::DesktopStore | ProfileSourceFamily::DesktopSyncStore,
                ) => {}
                (
                    ProfileResetFileBinding::Present { file_identity },
                    ProfileSourceFamily::DesktopStore | ProfileSourceFamily::DesktopSyncStore,
                ) => require_bounded_text(file_identity, PROFILE_SOURCE_IDENTITY_BYTES)?,
                _ => {
                    return Err(invalid_source_page(
                        "Profile reset file identity is inconsistent",
                    ));
                }
            }
        }
        if self.families.iter().enumerate().any(|(index, scope)| {
            self.families[..index]
                .iter()
                .any(|previous| previous.namespace_identity == scope.namespace_identity)
        }) {
            return Err(invalid_source_page(
                "Profile reset namespaces are ambiguous",
            ));
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
    schemars(rename = "ProfileResetSnapshot")
)]
#[serde(remote = "Self", rename_all = "camelCase", deny_unknown_fields)]
pub struct ProfileResetSnapshot {
    #[cfg_attr(feature = "profile-admission-contract-schema", schemars(length(min = 1, max = PROFILE_SOURCE_IDENTITY_BYTES)))]
    pub reset_handle: String,
    #[cfg_attr(feature = "profile-admission-contract-schema", schemars(length(min = 1, max = PROFILE_SOURCE_IDENTITY_BYTES)))]
    pub wipe_id: String,
    pub scope: ProfileLegacyResetScope,
}
impl ProfileResetSnapshot {
    pub fn validate(&self) -> Result<(), RuntimeError> {
        require_bounded_text(&self.reset_handle, PROFILE_SOURCE_IDENTITY_BYTES)?;
        require_bounded_text(&self.wipe_id, PROFILE_SOURCE_IDENTITY_BYTES)?;
        self.scope.validate()
    }
}

#[cfg_attr(
    feature = "profile-admission-contract-schema",
    derive(schemars::JsonSchema)
)]
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(
    feature = "profile-admission-contract-schema",
    schemars(rename = "ProfileResetPreparedResult")
)]
#[serde(
    remote = "Self",
    tag = "type",
    rename_all = "camelCase",
    deny_unknown_fields
)]
pub enum ProfileResetPreparedResult {
    Prepared { snapshot: ProfileResetSnapshot },
    Changed {},
    Unavailable {},
}

#[cfg_attr(
    feature = "profile-admission-contract-schema",
    derive(schemars::JsonSchema)
)]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(
    feature = "profile-admission-contract-schema",
    schemars(rename = "ProfileResetResult")
)]
#[serde(
    remote = "Self",
    tag = "type",
    rename_all = "camelCase",
    deny_unknown_fields
)]
pub enum ProfileResetResult {
    Reset {},
    AlreadyAbsent {},
    Changed {},
    Unavailable {},
}
map_only_serde!(
    ProfileResetFileBinding,
    ProfileResetFamilyScope,
    ProfileLegacyResetScope,
    ProfileResetSnapshot,
    ProfileResetPreparedResult,
    ProfileResetResult
);

pub(super) fn required_scope<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<ProfileLegacyResetScope>, D::Error> {
    Option::<ProfileLegacyResetScope>::deserialize(deserializer)
}
#[cfg(feature = "profile-admission-contract-schema")]
pub(super) fn scope_schema(generator: &mut schemars::SchemaGenerator) -> schemars::Schema {
    let scope = generator.subschema_for::<ProfileLegacyResetScope>();
    schemars::json_schema!({"anyOf":[scope,{"type":"null"}]})
}
