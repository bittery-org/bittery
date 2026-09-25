use crate::{
    protocol::Incarnation, wire::map_only_serde, AccountId, RuntimeError, RuntimeErrorCode,
};
use async_trait::async_trait;
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use std::{collections::HashSet, sync::Arc};
use zeroize::{Zeroize, ZeroizeOnDrop, Zeroizing};

mod admission_cleanup;
mod legacy_session_evidence;
pub(crate) mod profile_admission;
mod profile_reset;

pub(crate) use legacy_session_evidence::{
    LegacySessionEvidenceDocument, LegacySessionEvidenceMaterial,
};

const KEY_PREFIX: &str = "bittery:runtime:platform-storage";
const DOCUMENT_VERSION: u32 = 1;
const INVENTORY_KEY_BYTES: usize = 4096;
const INVENTORY_PAGE_KEYS: usize = 128;
const INVENTORY_CONTROL_BYTES: usize = 262_144;
const INVENTORY_CURSOR_BYTES: usize = 96 * 1024;

mod required_option {
    use serde::{Deserialize, Deserializer};

    pub fn deserialize<'de, D, T>(deserializer: D) -> Result<Option<T>, D::Error>
    where
        D: Deserializer<'de>,
        T: Deserialize<'de>,
    {
        Option::<T>::deserialize(deserializer)
    }
}

/// Some external wire structs are also used as fields in persisted documents. Their generated
/// Serde implementations accept positional sequences, so require the actual JSON object boundary
/// here while retaining their one typed field definition and duplicate-field checks.
struct Object<T>(T);

impl<'de, T: Deserialize<'de>> Deserialize<'de> for Object<T> {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct ObjectVisitor<T>(std::marker::PhantomData<T>);

        impl<'de, T: Deserialize<'de>> serde::de::Visitor<'de> for ObjectVisitor<T> {
            type Value = Object<T>;

            fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                formatter.write_str("a typed JSON object")
            }

            fn visit_map<A: serde::de::MapAccess<'de>>(
                self,
                map: A,
            ) -> Result<Self::Value, A::Error> {
                T::deserialize(serde::de::value::MapAccessDeserializer::new(map)).map(Object)
            }
        }

        deserializer.deserialize_map(ObjectVisitor(std::marker::PhantomData))
    }
}

fn deserialize_object<'de, D, T>(deserializer: D) -> Result<T, D::Error>
where
    D: serde::Deserializer<'de>,
    T: Deserialize<'de>,
{
    Object::<T>::deserialize(deserializer).map(|value| value.0)
}

fn deserialize_object_vec<'de, D, T>(deserializer: D) -> Result<Vec<T>, D::Error>
where
    D: serde::Deserializer<'de>,
    T: Deserialize<'de>,
{
    Vec::<Object<T>>::deserialize(deserializer)
        .map(|values| values.into_iter().map(|value| value.0).collect())
}

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize, Zeroize)]
#[serde(transparent)]
pub struct SecretString(Zeroizing<String>);

impl SecretString {
    fn new(value: String) -> Self {
        Self(Zeroizing::new(value))
    }

    fn into_zeroizing(mut self) -> Zeroizing<String> {
        Zeroizing::new(std::mem::take(&mut *self.0))
    }
}

impl std::ops::Deref for SecretString {
    type Target = str;

    fn deref(&self) -> &Self::Target {
        self.0.as_str()
    }
}

impl AsRef<str> for SecretString {
    fn as_ref(&self) -> &str {
        self
    }
}

impl From<String> for SecretString {
    fn from(value: String) -> Self {
        Self::new(value)
    }
}

impl From<&str> for SecretString {
    fn from(value: &str) -> Self {
        Self::new(value.to_owned())
    }
}

impl ZeroizeOnDrop for SecretString {}

impl Drop for SecretString {
    fn drop(&mut self) {
        self.zeroize();
        #[cfg(test)]
        SECRET_STRING_DROPS_AFTER_ZEROIZE.with(|drops| drops.set(drops.get() + 1));
    }
}

#[derive(Clone, PartialEq, Eq, Zeroize)]
pub(crate) struct SecretBytes32(Zeroizing<[u8; 32]>);

impl SecretBytes32 {
    fn new(value: [u8; 32]) -> Self {
        Self(Zeroizing::new(value))
    }
}

impl std::ops::Deref for SecretBytes32 {
    type Target = [u8; 32];

    fn deref(&self) -> &Self::Target {
        &self.0
    }
}

impl Serialize for SecretBytes32 {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        serializer.collect_seq(self.0.iter())
    }
}

impl ZeroizeOnDrop for SecretBytes32 {}

impl Drop for SecretBytes32 {
    fn drop(&mut self) {
        self.zeroize();
        #[cfg(test)]
        if self.0.iter().all(|byte| *byte == 0) {
            SECRET_BYTES_DROPS_AFTER_ZEROIZE.with(|drops| drops.set(drops.get() + 1));
        }
    }
}

#[cfg(test)]
thread_local! {
    static SECRET_STRING_DROPS_AFTER_ZEROIZE: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
    static SECRET_BYTES_DROPS_AFTER_ZEROIZE: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
}

#[cfg(test)]
fn take_secret_drop_observations() -> (usize, usize) {
    let strings = SECRET_STRING_DROPS_AFTER_ZEROIZE.with(|drops| drops.replace(0));
    let bytes = SECRET_BYTES_DROPS_AFTER_ZEROIZE.with(|drops| drops.replace(0));
    (strings, bytes)
}

impl<'de> Deserialize<'de> for SecretBytes32 {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        struct SecretBytesVisitor;

        impl<'de> serde::de::Visitor<'de> for SecretBytesVisitor {
            type Value = SecretBytes32;

            fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                formatter.write_str("an array of exactly 32 bytes")
            }

            fn visit_seq<A>(self, mut sequence: A) -> Result<Self::Value, A::Error>
            where
                A: serde::de::SeqAccess<'de>,
            {
                let mut bytes = Zeroizing::new([0_u8; 32]);
                let mut length = 0;
                while let Some(byte) = sequence.next_element::<u8>()? {
                    if length == bytes.len() {
                        return Err(serde::de::Error::invalid_length(length + 1, &self));
                    }
                    bytes[length] = byte;
                    length += 1;
                }
                if length != bytes.len() {
                    return Err(serde::de::Error::invalid_length(length, &self));
                }
                Ok(SecretBytes32(bytes))
            }
        }

        deserializer.deserialize_seq(SecretBytesVisitor)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(
    feature = "platform-storage-contract-schema",
    derive(schemars::JsonSchema)
)]
#[serde(rename_all = "camelCase")]
pub enum PlatformStorageArea {
    DevicePlain,
    DeviceSecret,
    SessionSecret,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(
    feature = "platform-storage-contract-schema",
    derive(schemars::JsonSchema)
)]
#[serde(rename_all = "camelCase")]
pub enum PlatformStorageInventoryFamily {
    PlatformStorage,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(
    feature = "platform-storage-contract-schema",
    derive(schemars::JsonSchema)
)]
#[cfg_attr(
    feature = "platform-storage-contract-schema",
    schemars(rename = "PlatformStorageInventoryContinuation")
)]
#[serde(remote = "Self")]
#[serde(tag = "type", rename_all = "camelCase", deny_unknown_fields)]
pub enum PlatformStorageInventoryContinuation {
    More {
        #[cfg_attr(
            feature = "platform-storage-contract-schema",
            schemars(length(min = 1, max = 98304))
        )]
        cursor: String,
    },
    // An empty struct makes Serde reject extra fields; an internally tagged unit ignores them.
    End {},
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(
    feature = "platform-storage-contract-schema",
    derive(schemars::JsonSchema)
)]
#[cfg_attr(
    feature = "platform-storage-contract-schema",
    schemars(rename = "PlatformStorageKeysPage")
)]
#[serde(remote = "Self")]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PlatformStorageKeysPage {
    #[cfg_attr(
        feature = "platform-storage-contract-schema",
        schemars(schema_with = "inventory_version_schema")
    )]
    pub version: u32,
    pub family: PlatformStorageInventoryFamily,
    #[cfg_attr(
        feature = "platform-storage-contract-schema",
        schemars(length(min = 1, max = 3))
    )]
    pub backing_areas: Vec<PlatformStorageArea>,
    #[cfg_attr(
        feature = "platform-storage-contract-schema",
        schemars(schema_with = "inventory_keys_schema")
    )]
    pub keys: Vec<String>,
    pub continuation: PlatformStorageInventoryContinuation,
}

map_only_serde!(
    PlatformStorageInventoryContinuation,
    PlatformStorageKeysPage
);

#[cfg(feature = "platform-storage-contract-schema")]
fn inventory_version_schema(_: &mut schemars::SchemaGenerator) -> schemars::Schema {
    schemars::json_schema!({ "type": "integer", "const": 1 })
}

#[cfg(feature = "platform-storage-contract-schema")]
fn inventory_keys_schema(_: &mut schemars::SchemaGenerator) -> schemars::Schema {
    schemars::json_schema!({
        "type": "array", "maxItems": 128,
        "items": { "type": "string", "minLength": 1, "maxLength": 4096 }
    })
}

#[cfg(feature = "platform-storage-contract-schema")]
fn inventory_cursor_schema(_: &mut schemars::SchemaGenerator) -> schemars::Schema {
    schemars::json_schema!({
        "anyOf": [
            { "type": "null" },
            { "type": "string", "minLength": 1, "maxLength": 98304 }
        ]
    })
}

impl PlatformStorageKeysPage {
    #[doc(hidden)]
    pub const MAX_KEY_BYTES: usize = INVENTORY_KEY_BYTES;
    #[doc(hidden)]
    pub const MAX_PAGE_KEYS: usize = INVENTORY_PAGE_KEYS;
    #[doc(hidden)]
    pub const MAX_CONTROL_BYTES: usize = INVENTORY_CONTROL_BYTES;
    #[doc(hidden)]
    pub const MAX_CURSOR_BYTES: usize = INVENTORY_CURSOR_BYTES;

    fn validate(&self) -> Result<(), RuntimeError> {
        fn area_order(area: PlatformStorageArea) -> u8 {
            match area {
                PlatformStorageArea::DevicePlain => 0,
                PlatformStorageArea::DeviceSecret => 1,
                PlatformStorageArea::SessionSecret => 2,
            }
        }
        if self.version != 1
            || self.backing_areas.is_empty()
            || self.backing_areas.len() > 3
            || self
                .backing_areas
                .windows(2)
                .any(|areas| area_order(areas[0]) >= area_order(areas[1]))
        {
            return Err(platform_storage_invariant(
                "platform storage inventory page is invalid",
            ));
        }
        if self.keys.len() > INVENTORY_PAGE_KEYS
            || self.keys.iter().any(|key| key.len() > INVENTORY_KEY_BYTES)
        {
            return Err(inventory_bound());
        }
        if self.keys.iter().any(String::is_empty)
            || self
                .keys
                .windows(2)
                .any(|keys| keys[0].as_bytes() >= keys[1].as_bytes())
        {
            return Err(platform_storage_invariant(
                "platform storage inventory keys do not advance",
            ));
        }
        if let PlatformStorageInventoryContinuation::More { cursor } = &self.continuation {
            validate_inventory_cursor(Some(cursor))?;
            if self.keys.is_empty() {
                return Err(platform_storage_invariant(
                    "platform storage inventory continuation has no keys",
                ));
            }
        }
        Ok(())
    }

    /// Trusted adapters validate key topology here; the transport also bounds serialized bytes.
    #[doc(hidden)]
    pub fn validate_for(
        &self,
        area: PlatformStorageArea,
        prefix: &str,
    ) -> Result<(), RuntimeError> {
        self.validate()?;
        if !self.backing_areas.contains(&area)
            || self.keys.iter().any(|key| !key.starts_with(prefix))
        {
            return Err(platform_storage_invariant(
                "platform storage inventory escaped its requested scope",
            ));
        }
        Ok(())
    }
}

fn validate_inventory_cursor(cursor: Option<&str>) -> Result<(), RuntimeError> {
    if cursor.is_some_and(str::is_empty) {
        return Err(platform_storage_invariant(
            "platform storage inventory cursor is empty",
        ));
    }
    if cursor.is_some_and(|cursor| cursor.len() > INVENTORY_CURSOR_BYTES) {
        return Err(inventory_bound());
    }
    Ok(())
}

fn validate_inventory_request(prefix: &str, cursor: Option<&str>) -> Result<(), RuntimeError> {
    if prefix.is_empty() {
        return Err(platform_storage_invariant(
            "platform storage inventory prefix is empty",
        ));
    }
    if prefix.len() > INVENTORY_KEY_BYTES {
        return Err(inventory_bound());
    }
    validate_inventory_cursor(cursor)
}

fn validate_inventory_control_bytes(bytes: usize) -> Result<(), RuntimeError> {
    if bytes > INVENTORY_CONTROL_BYTES {
        return Err(inventory_bound());
    }
    Ok(())
}

fn inventory_bound() -> RuntimeError {
    RuntimeError::new(
        RuntimeErrorCode::SizeRejected,
        "platform storage inventory exceeds its control bound",
    )
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum PlatformStorageValue {
    DeviceCatalog,
    LocalSecurity,
    AccountLocalSecurity(AccountId),
    AccountMetadata(AccountId, Incarnation),
    VerifiedRecipientKeys(AccountId, Incarnation),
    DeviceKey,
    AccountQuickUnlock(AccountId, Incarnation),
    CurrentSessionCredentials(AccountId, Incarnation),
    LegacySessionEvidence(AccountId, Incarnation),
}

impl PlatformStorageValue {
    fn area(&self, session_survives_restart: bool) -> PlatformStorageArea {
        match self {
            Self::DeviceCatalog
            | Self::LocalSecurity
            | Self::AccountLocalSecurity(..)
            | Self::VerifiedRecipientKeys(..)
            | Self::AccountMetadata(..) => PlatformStorageArea::DevicePlain,
            Self::DeviceKey | Self::AccountQuickUnlock(..) => PlatformStorageArea::DeviceSecret,
            Self::CurrentSessionCredentials(..) | Self::LegacySessionEvidence(..)
                if session_survives_restart =>
            {
                PlatformStorageArea::DeviceSecret
            }
            Self::CurrentSessionCredentials(..) | Self::LegacySessionEvidence(..) => {
                PlatformStorageArea::SessionSecret
            }
        }
    }

    fn key(&self) -> Result<String, RuntimeError> {
        match self {
            Self::DeviceCatalog => Ok(format!("{KEY_PREFIX}:device-catalog")),
            Self::LocalSecurity => Ok(format!("{KEY_PREFIX}:local-security")),
            Self::DeviceKey => Ok(format!("{KEY_PREFIX}:device-key")),
            Self::AccountLocalSecurity(account_id) => {
                Ok(format!("{}local-security", account_prefix(account_id)?))
            }
            Self::AccountMetadata(account_id, incarnation) => {
                account_key(account_id, incarnation, "metadata")
            }
            Self::VerifiedRecipientKeys(account_id, incarnation) => {
                account_key(account_id, incarnation, "verified-recipient-keys")
            }
            Self::AccountQuickUnlock(account_id, incarnation) => {
                account_key(account_id, incarnation, "quick-unlock")
            }
            Self::CurrentSessionCredentials(account_id, incarnation) => {
                account_key(account_id, incarnation, "current-session")
            }
            Self::LegacySessionEvidence(account_id, incarnation) => {
                account_key(account_id, incarnation, "legacy-session-evidence")
            }
        }
    }
}

fn account_key(
    account_id: &AccountId,
    incarnation: &Incarnation,
    document: &str,
) -> Result<String, RuntimeError> {
    require_account_id(account_id)?;
    require_incarnation(incarnation)?;
    let identity = account_id.as_str();
    let generation = incarnation.as_str();
    Ok(format!(
        "{KEY_PREFIX}:account:{}:{identity}:incarnation:{}:{generation}:{document}",
        identity.len(),
        generation.len()
    ))
}

fn account_prefix(account_id: &AccountId) -> Result<String, RuntimeError> {
    require_account_id(account_id)?;
    let identity = account_id.as_str();
    Ok(format!(
        "{KEY_PREFIX}:account:{}:{identity}:",
        identity.len()
    ))
}

fn runtime_namespace_prefix() -> String {
    format!("{KEY_PREFIX}:")
}

fn require_account_id(account_id: &AccountId) -> Result<(), RuntimeError> {
    if account_id.as_str().is_empty() {
        return Err(platform_storage_invariant(
            "platform storage Account identity is empty",
        ));
    }
    Ok(())
}

fn require_incarnation(incarnation: &Incarnation) -> Result<(), RuntimeError> {
    if incarnation.as_str().is_empty() {
        return Err(platform_storage_invariant(
            "platform storage Account incarnation is empty",
        ));
    }
    Ok(())
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(remote = "Self", rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct PendingAccountInstallIntent {
    pub(crate) incarnation: Incarnation,
    #[serde(deserialize_with = "required_option::deserialize")]
    pub(crate) expected_active_incarnation: Option<Incarnation>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum AccountRetirementPurpose {
    Remove,
    Replace,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(remote = "Self", rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct PendingAccountRetirementIntent {
    pub(crate) incarnation: Incarnation,
    pub(crate) purpose: AccountRetirementPurpose,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(remote = "Self", rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct DeviceCatalogAccount {
    pub(crate) account_id: AccountId,
    #[serde(deserialize_with = "required_option::deserialize")]
    pub(crate) active_incarnation: Option<Incarnation>,
    #[serde(deserialize_with = "required_option::deserialize")]
    pub(crate) pending_install: Option<PendingAccountInstallIntent>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) pending_retirement: Option<PendingAccountRetirementIntent>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(remote = "Self", rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct DeviceCatalogDocument {
    version: u32,
    pub(crate) accounts: Vec<DeviceCatalogAccount>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "profile_admission::deserialize_present"
    )]
    profile_admission: Option<profile_admission::ProfileAdmissionRecord>,
}

map_only_serde!(
    PendingAccountInstallIntent,
    PendingAccountRetirementIntent,
    DeviceCatalogAccount,
    DeviceCatalogDocument,
);

impl DeviceCatalogDocument {
    pub(crate) fn new(accounts: Vec<DeviceCatalogAccount>) -> Result<Self, RuntimeError> {
        let document = Self {
            version: DOCUMENT_VERSION,
            accounts,
            profile_admission: None,
        };
        document.validate()?;
        Ok(document)
    }

    pub(crate) fn with_accounts(
        &self,
        accounts: Vec<DeviceCatalogAccount>,
    ) -> Result<Self, RuntimeError> {
        let document = Self {
            version: self.version,
            accounts,
            profile_admission: self.profile_admission.clone(),
        };
        document.validate()?;
        Ok(document)
    }

    pub(crate) fn admission_record(&self) -> Option<&profile_admission::ProfileAdmissionRecord> {
        self.profile_admission.as_ref()
    }

    pub(crate) fn with_admission(
        &self,
        record: profile_admission::ProfileAdmissionRecord,
        accounts: Vec<DeviceCatalogAccount>,
    ) -> Result<Self, RuntimeError> {
        let document = Self {
            version: self.version,
            accounts,
            profile_admission: Some(record),
        };
        document.validate()?;
        Ok(document)
    }

    pub(crate) fn profile_reset_wiping(&self) -> bool {
        self.admission_record().is_some_and(|record| {
            record.reset_phase() == Some(profile_admission::ResetPhase::Wiping)
        })
    }
    pub(crate) fn profile_reset_wiped(&self) -> bool {
        self.admission_record().is_some_and(|record| {
            record.reset_phase() == Some(profile_admission::ResetPhase::Wiped)
        })
    }
    pub(crate) fn profile_admission_pending(&self) -> bool {
        self.profile_admission.as_ref().is_some_and(|record| {
            matches!(
                record.phase(),
                Some(
                    profile_admission::ImportPhase::Preparing
                        | profile_admission::ImportPhase::Aborting
                        | profile_admission::ImportPhase::Aborted
                )
            )
        })
    }

    pub(crate) fn profile_admission_committed(&self) -> bool {
        self.profile_admission
            .as_ref()
            .is_some_and(|record| record.phase() == Some(profile_admission::ImportPhase::Committed))
    }

    pub(crate) fn profile_admission_complete(&self) -> bool {
        self.profile_admission
            .as_ref()
            .is_some_and(|record| record.is_complete())
    }

    fn validate(&self) -> Result<(), RuntimeError> {
        require_version(self.version, "Device catalog")?;
        if let Some(record) = &self.profile_admission {
            record.validate(&self.accounts)?;
        }
        let mut identities = HashSet::new();
        for account in &self.accounts {
            require_account_id(&account.account_id)?;
            if !identities.insert(account.account_id.as_str()) {
                return Err(platform_storage_invariant(
                    "Device catalog contains a duplicate Account identity",
                ));
            }
            if let Some(active) = &account.active_incarnation {
                require_incarnation(active)?;
            }
            if let Some(retirement) = &account.pending_retirement {
                require_incarnation(&retirement.incarnation)?;
                if account.active_incarnation.as_ref() != Some(&retirement.incarnation)
                    || account.pending_install.is_some()
                {
                    return Err(platform_storage_invariant(
                        "pending Account retirement must bind only its active incarnation",
                    ));
                }
            }
            if let Some(pending) = &account.pending_install {
                require_incarnation(&pending.incarnation)?;
                if pending.expected_active_incarnation != account.active_incarnation {
                    return Err(platform_storage_invariant(
                        "pending Account installation expects another active incarnation",
                    ));
                }
                if account.active_incarnation.as_ref() == Some(&pending.incarnation) {
                    return Err(platform_storage_invariant(
                        "pending Account installation must use a new incarnation",
                    ));
                }
            }
            if account.active_incarnation.is_none() && account.pending_install.is_none() {
                return Err(platform_storage_invariant(
                    "Device catalog Account has no active or pending incarnation",
                ));
            }
        }
        Ok(())
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(remote = "Self", rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct VerifiedTravelModePolicy {
    pub(crate) enabled: bool,
    pub(crate) hidden_vault_ids: Vec<String>,
    pub(crate) server_enabled_at_ms: Option<u64>,
    pub(crate) server_updated_at_ms: Option<u64>,
    #[serde(deserialize_with = "crate::wire::required_nullable")]
    pub(crate) verified_at_ms: Option<u64>,
}

impl VerifiedTravelModePolicy {
    pub(crate) fn validate(&self) -> Result<(), RuntimeError> {
        validate_travel_hidden_vault_ids(&self.hidden_vault_ids)?;
        if self.enabled != self.server_enabled_at_ms.is_some() {
            return Err(platform_storage_invariant(
                "verified Travel Mode activation timestamp is inconsistent",
            ));
        }
        Ok(())
    }
}

/// The Server response, durable document and transient retirement proof share one selection bound.
pub(crate) fn validate_travel_hidden_vault_ids(ids: &[String]) -> Result<(), RuntimeError> {
    if ids.len() > 100 {
        return Err(platform_storage_invariant(
            "verified Travel Mode selection exceeds the Vault bound",
        ));
    }
    let mut vault_ids = HashSet::new();
    for vault_id in ids {
        require_non_empty(vault_id, "verified Travel Mode hidden Vault identity")?;
        if !vault_ids.insert(vault_id.as_str()) {
            return Err(platform_storage_invariant(
                "verified Travel Mode policy contains a duplicate hidden Vault identity",
            ));
        }
    }
    Ok(())
}

/// Account-scoped local preference; it survives credential generation replacement.
#[derive(Clone, Serialize, Deserialize)]
#[serde(remote = "Self", rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AccountLocalSecurityDocument {
    version: u32,
    pub(crate) inactivity_timeout_ms: i64,
}

impl AccountLocalSecurityDocument {
    pub(crate) fn new(inactivity_timeout_ms: i64) -> Self {
        Self {
            version: DOCUMENT_VERSION,
            inactivity_timeout_ms,
        }
    }
}

/// Device-wide local access policy. This document contains no authentication material.
#[derive(Clone, Serialize, Deserialize)]
#[serde(remote = "Self", rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct LocalSecurityDocument {
    version: u32,
    pub(crate) master_password_reentry_period_ms: i64,
}
impl LocalSecurityDocument {
    pub(crate) fn new(period_ms: i64) -> Self {
        Self {
            version: DOCUMENT_VERSION,
            master_password_reentry_period_ms: period_ms,
        }
    }
}

/// Retained source observations are never prompt grace or current enrollment authority.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(remote = "Self", rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct LegacyDesktopAccountEvidence {
    pub(crate) account_biometric_enabled: bool,
    #[serde(deserialize_with = "required_option::deserialize")]
    pub(crate) session_biometric_enabled: Option<bool>,
    #[serde(deserialize_with = "required_option::deserialize")]
    pub(crate) last_biometric_auth: Option<i64>,
    #[serde(deserialize_with = "required_option::deserialize")]
    pub(crate) background_timestamp: Option<i64>,
}

map_only_serde!(LegacyDesktopAccountEvidence);

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(remote = "Self", rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AccountMetadataDocument {
    version: u32,
    pub(crate) account_id: AccountId,
    pub(crate) incarnation: Incarnation,
    pub(crate) user_id: String,
    pub(crate) email: String,
    pub(crate) name: String,
    pub(crate) normalized_server_url: String,
    pub(crate) team_name: Option<String>,
    pub(crate) team_avatar_url: Option<String>,
    pub(crate) secret_key_hint: String,
    pub(crate) added_at_ms: u64,
    pub(crate) last_active_at_ms: u64,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub(crate) native_only: bool,
    pub(crate) biometric_enabled: bool,
    pub(crate) insecure_transport_confirmed: bool,
    #[serde(deserialize_with = "deserialize_object")]
    pub(crate) pinned_kdf_profile: bittery_crypto_core::KdfProfile,
    pub(crate) verified_travel_mode: Option<VerifiedTravelModePolicy>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "profile_admission::deserialize_present"
    )]
    pub(crate) legacy_desktop_evidence: Option<LegacyDesktopAccountEvidence>,
}

impl AccountMetadataDocument {
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn new(
        account_id: AccountId,
        incarnation: Incarnation,
        user_id: String,
        email: String,
        name: String,
        normalized_server_url: String,
        team_name: Option<String>,
        team_avatar_url: Option<String>,
        secret_key_hint: String,
        added_at_ms: u64,
        last_active_at_ms: u64,
        biometric_enabled: bool,
        insecure_transport_confirmed: bool,
        pinned_kdf_profile: bittery_crypto_core::KdfProfile,
        verified_travel_mode: Option<VerifiedTravelModePolicy>,
    ) -> Result<Self, RuntimeError> {
        let document = Self {
            version: DOCUMENT_VERSION,
            account_id,
            incarnation,
            user_id,
            email,
            name,
            normalized_server_url,
            team_name,
            team_avatar_url,
            secret_key_hint,
            added_at_ms,
            last_active_at_ms,
            native_only: false,
            biometric_enabled,
            insecure_transport_confirmed,
            pinned_kdf_profile,
            verified_travel_mode,
            legacy_desktop_evidence: None,
        };
        document.validate()?;
        Ok(document)
    }

    fn validate(&self) -> Result<(), RuntimeError> {
        require_version(self.version, "Account metadata")?;
        require_account_id(&self.account_id)?;
        require_incarnation(&self.incarnation)?;
        require_non_empty(&self.user_id, "Account metadata User identity")?;
        require_non_empty(&self.normalized_server_url, "Account metadata Server URL")?;
        bittery_crypto_core::validate_kdf_profile(&self.pinned_kdf_profile, None).map_err(
            |_| platform_storage_invariant("pinned KDF profile is outside the supported policy"),
        )?;
        if let Some(policy) = &self.verified_travel_mode {
            policy.validate()?;
        }
        Ok(())
    }
}

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize, Zeroize, ZeroizeOnDrop)]
#[serde(remote = "Self", rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct DeviceKeyDocument {
    #[zeroize(skip)]
    version: u32,
    pub(crate) key_bytes: SecretBytes32,
}

impl DeviceKeyDocument {
    pub(crate) fn new(key_bytes: [u8; 32]) -> Self {
        Self {
            version: DOCUMENT_VERSION,
            key_bytes: SecretBytes32::new(key_bytes),
        }
    }

    fn validate(&self) -> Result<(), RuntimeError> {
        require_version(self.version, "Device key")
    }
}

#[derive(Clone, Serialize, Deserialize, Zeroize, ZeroizeOnDrop)]
#[serde(remote = "Self", rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct QuickUnlockDocument {
    #[zeroize(skip)]
    version: u32,
    #[zeroize(skip)]
    pub(crate) account_id: AccountId,
    #[zeroize(skip)]
    pub(crate) incarnation: Incarnation,
    #[zeroize(skip)]
    #[serde(deserialize_with = "deserialize_object")]
    pub(crate) encrypted_master_unlock_key: bittery_crypto_core::EncryptedData,
    pub(crate) secret_key: SecretString,
    #[zeroize(skip)]
    pub(crate) created_at_ms: u64,
    #[zeroize(skip)]
    pub(crate) last_master_password_entry_ms: Option<u64>,
    #[zeroize(skip)]
    pub(crate) biometric_enabled: bool,
}

impl QuickUnlockDocument {
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn new(
        account_id: AccountId,
        incarnation: Incarnation,
        encrypted_master_unlock_key: bittery_crypto_core::EncryptedData,
        secret_key: String,
        created_at_ms: u64,
        last_master_password_entry_ms: Option<u64>,
        biometric_enabled: bool,
    ) -> Result<Self, RuntimeError> {
        let document = Self {
            version: DOCUMENT_VERSION,
            account_id,
            incarnation,
            encrypted_master_unlock_key,
            secret_key: SecretString::new(secret_key),
            created_at_ms,
            last_master_password_entry_ms,
            biometric_enabled,
        };
        document.validate()?;
        Ok(document)
    }

    fn validate(&self) -> Result<(), RuntimeError> {
        require_version(self.version, "Quick-unlock")?;
        require_account_id(&self.account_id)?;
        require_incarnation(&self.incarnation)?;
        require_non_empty(
            &self.encrypted_master_unlock_key.ciphertext,
            "encrypted master unlock key ciphertext",
        )?;
        require_non_empty(
            &self.encrypted_master_unlock_key.iv,
            "encrypted master unlock key IV",
        )?;
        if self.encrypted_master_unlock_key.algorithm != "AES-GCM-AAD-V1" {
            return Err(platform_storage_invariant(
                "encrypted master unlock key algorithm is unsupported",
            ));
        }
        if !bittery_crypto_core::validate_secret_key(&self.secret_key) {
            return Err(platform_storage_invariant("stored Secret Key is invalid"));
        }
        Ok(())
    }

    /// Consumes the secret-bearing document so password-entry evidence cannot be updated through a
    /// stale clone while another generation is being installed.
    pub(crate) fn record_master_password_entry(
        mut self,
        entered_at_ms: u64,
    ) -> Result<Self, RuntimeError> {
        self.last_master_password_entry_ms = Some(entered_at_ms);
        self.validate()?;
        Ok(self)
    }
}

#[derive(Clone, Default, PartialEq, Eq)]
pub(crate) enum SessionProvenance {
    #[default]
    Independent,
    Borrowed {
        grant_id: String,
    },
}

/// Test-only lifetime evidence carries no credentials and never changes document equality.
#[cfg(test)]
#[derive(Clone, Default)]
struct SessionLifetimeWitness {
    _lease: Option<Arc<()>>,
}
#[cfg(test)]
impl PartialEq for SessionLifetimeWitness {
    fn eq(&self, _other: &Self) -> bool {
        true
    }
}

#[derive(Clone, PartialEq, Serialize, Deserialize, Zeroize, ZeroizeOnDrop)]
#[serde(remote = "Self", rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct CurrentSessionDocument {
    #[cfg(test)]
    #[serde(skip)]
    #[zeroize(skip)]
    lifetime_witness: SessionLifetimeWitness,
    /// Runtime-only authority. Deserialization never grants borrowed authority, and persistence
    /// rejects it before serialization can erase this marker.
    #[serde(skip)]
    #[zeroize(skip)]
    pub(crate) provenance: SessionProvenance,
    #[zeroize(skip)]
    version: u32,
    #[zeroize(skip)]
    pub(crate) account_id: AccountId,
    #[zeroize(skip)]
    pub(crate) incarnation: Incarnation,
    pub(crate) token: SecretString,
    #[zeroize(skip)]
    pub(crate) session_id: Option<String>,
    #[zeroize(skip)]
    pub(crate) expires_at_ms: u64,
    #[zeroize(skip)]
    pub(crate) server_expires_at_ms: Option<u64>,
    #[zeroize(skip)]
    #[serde(deserialize_with = "deserialize_object_vec")]
    pub(crate) vault_keys: Vec<crate::server_contract::AuthVaultKeyResponse>,
    #[zeroize(skip)]
    pub(crate) encrypted_private_key: String,
}

map_only_serde!(
    VerifiedTravelModePolicy,
    AccountLocalSecurityDocument,
    LocalSecurityDocument,
    AccountMetadataDocument,
    DeviceKeyDocument,
    QuickUnlockDocument,
    CurrentSessionDocument,
);

impl CurrentSessionDocument {
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn new(
        account_id: AccountId,
        incarnation: Incarnation,
        token: String,
        session_id: Option<String>,
        expires_at_ms: u64,
        server_expires_at_ms: Option<u64>,
        vault_keys: Vec<crate::server_contract::AuthVaultKeyResponse>,
        encrypted_private_key: String,
    ) -> Result<Self, RuntimeError> {
        let document = Self {
            #[cfg(test)]
            lifetime_witness: SessionLifetimeWitness::default(),
            version: DOCUMENT_VERSION,
            account_id,
            incarnation,
            token: SecretString::new(token),
            provenance: SessionProvenance::Independent,
            session_id,
            expires_at_ms,
            server_expires_at_ms,
            vault_keys,
            encrypted_private_key,
        };
        document.validate()?;
        Ok(document)
    }

    fn validate(&self) -> Result<(), RuntimeError> {
        require_version(self.version, "Current Session")?;
        require_account_id(&self.account_id)?;
        require_incarnation(&self.incarnation)?;
        require_non_empty(&self.token, "Current Session token")?;
        require_non_empty(
            &self.encrypted_private_key,
            "Current Session encrypted private key",
        )?;
        let mut vault_ids = HashSet::new();
        for vault_key in &self.vault_keys {
            require_non_empty(&vault_key.vault_id, "Current Session Vault identity")?;
            require_non_empty(
                &vault_key.encrypted_vault_key,
                "Current Session encrypted Vault key",
            )?;
            if !vault_ids.insert(vault_key.vault_id.as_str()) {
                return Err(platform_storage_invariant(
                    "Current Session contains a duplicate Vault key",
                ));
            }
        }
        Ok(())
    }
}

fn require_version(version: u32, document: &str) -> Result<(), RuntimeError> {
    if version != DOCUMENT_VERSION {
        return Err(platform_storage_invariant(format!(
            "{document} document version is unsupported"
        )));
    }
    Ok(())
}

fn require_non_empty(value: &str, field: &str) -> Result<(), RuntimeError> {
    if value.is_empty() {
        return Err(platform_storage_invariant(format!("{field} is empty")));
    }
    Ok(())
}

fn serialize_sensitive_json<T>(
    value: &T,
    failure_message: &'static str,
) -> Result<String, RuntimeError>
where
    T: Serialize,
{
    let mut bytes = Zeroizing::new(Vec::new());
    serde_json::to_writer(&mut *bytes, value)
        .map_err(|_| platform_storage_invariant(failure_message))?;
    String::from_utf8(std::mem::take(&mut *bytes)).map_err(|error| {
        let mut bytes = error.into_bytes();
        bytes.zeroize();
        platform_storage_invariant(failure_message)
    })
}

#[derive(Clone, PartialEq, Eq, Serialize, Zeroize, ZeroizeOnDrop)]
#[cfg_attr(
    feature = "platform-storage-contract-schema",
    derive(schemars::JsonSchema)
)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum PlatformStorageRequest {
    ListKeys {
        #[zeroize(skip)]
        area: PlatformStorageArea,
        #[zeroize(skip)]
        #[cfg_attr(
            feature = "platform-storage-contract-schema",
            schemars(length(min = 1, max = 4096))
        )]
        prefix: String,
        #[zeroize(skip)]
        #[serde(deserialize_with = "required_option::deserialize")]
        #[cfg_attr(
            feature = "platform-storage-contract-schema",
            schemars(schema_with = "inventory_cursor_schema")
        )]
        cursor: Option<String>,
    },
    Get {
        #[zeroize(skip)]
        area: PlatformStorageArea,
        #[zeroize(skip)]
        key: String,
    },
    Set {
        #[zeroize(skip)]
        area: PlatformStorageArea,
        #[zeroize(skip)]
        key: String,
        #[cfg_attr(
            feature = "platform-storage-contract-schema",
            schemars(with = "String")
        )]
        value: SecretString,
    },
    Delete {
        #[zeroize(skip)]
        area: PlatformStorageArea,
        #[zeroize(skip)]
        key: String,
    },
    DeleteIfUnchanged {
        #[zeroize(skip)]
        area: PlatformStorageArea,
        #[zeroize(skip)]
        key: String,
        #[cfg_attr(
            feature = "platform-storage-contract-schema",
            schemars(with = "String")
        )]
        expected_value: SecretString,
    },
    DeletePrefix {
        #[zeroize(skip)]
        area: PlatformStorageArea,
        #[zeroize(skip)]
        #[cfg_attr(
            feature = "platform-storage-contract-schema",
            schemars(length(min = 1))
        )]
        prefix: String,
        #[zeroize(skip)]
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[cfg_attr(
            feature = "platform-storage-contract-schema",
            schemars(with = "String", length(min = 1))
        )]
        preserve_key: Option<String>,
    },
}

impl<'de> Deserialize<'de> for PlatformStorageRequest {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        struct RequestVisitor;

        impl<'de> serde::de::Visitor<'de> for RequestVisitor {
            type Value = PlatformStorageRequest;

            fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                formatter.write_str("a platform-storage request")
            }

            fn visit_map<A>(self, mut map: A) -> Result<Self::Value, A::Error>
            where
                A: serde::de::MapAccess<'de>,
            {
                let mut request_type = None;
                let mut area = None;
                let mut key = None;
                let mut prefix = None;
                let mut preserve_key: Option<String> = None;
                let mut cursor: Option<Option<String>> = None;
                let mut value = None;
                let mut value_present = false;
                let mut expected_value = None;
                let mut unknown_field = None;

                while let Some(field) = map.next_key::<String>()? {
                    match field.as_str() {
                        "type" => read_buffered_field(&mut map, &mut request_type, "type")?,
                        "area" => read_buffered_field(&mut map, &mut area, "area")?,
                        "key" => read_buffered_field(&mut map, &mut key, "key")?,
                        "prefix" => read_buffered_field(&mut map, &mut prefix, "prefix")?,
                        "preserveKey" => {
                            read_typed_field(&mut map, &mut preserve_key, "preserveKey")?
                        }
                        "cursor" => read_typed_field(&mut map, &mut cursor, "cursor")?,
                        "value" => {
                            if value_present {
                                return Err(serde::de::Error::duplicate_field("value"));
                            }
                            value_present = true;
                            value = Some(map.next_value::<SecretString>()?);
                        }
                        "expectedValue" => {
                            read_typed_field(&mut map, &mut expected_value, "expectedValue")?
                        }
                        _ => {
                            map.next_value::<serde::de::IgnoredAny>()?;
                            unknown_field.get_or_insert(field);
                        }
                    }
                }

                if let Some(field) = unknown_field {
                    return Err(serde::de::Error::custom(format!(
                        "unknown field `{field}` in platform-storage request"
                    )));
                }

                let request_type: String = decode_buffered_field(request_type, "type")?;
                let area = decode_buffered_field(area, "area")?;
                if expected_value.is_some() && request_type != "deleteIfUnchanged" {
                    return Err(serde::de::Error::custom(
                        "unexpected guarded deletion value in platform-storage request",
                    ));
                }
                match request_type.as_str() {
                    "listKeys" if !value_present && key.is_none() && preserve_key.is_none() => {
                        let prefix: String = decode_buffered_field(prefix, "prefix")?;
                        let cursor =
                            cursor.ok_or_else(|| serde::de::Error::missing_field("cursor"))?;
                        validate_inventory_request(&prefix, cursor.as_deref()).map_err(|_| {
                            serde::de::Error::custom("invalid platform-storage inventory control")
                        })?;
                        Ok(PlatformStorageRequest::ListKeys {
                            area,
                            prefix,
                            cursor,
                        })
                    }
                    "get"
                        if !value_present
                            && prefix.is_none()
                            && cursor.is_none()
                            && preserve_key.is_none() =>
                    {
                        Ok(PlatformStorageRequest::Get {
                            area,
                            key: decode_buffered_field(key, "key")?,
                        })
                    }
                    "set" if prefix.is_none() && cursor.is_none() && preserve_key.is_none() => {
                        Ok(PlatformStorageRequest::Set {
                            area,
                            key: decode_buffered_field(key, "key")?,
                            value: value.ok_or_else(|| serde::de::Error::missing_field("value"))?,
                        })
                    }
                    "delete"
                        if !value_present
                            && prefix.is_none()
                            && cursor.is_none()
                            && preserve_key.is_none() =>
                    {
                        Ok(PlatformStorageRequest::Delete {
                            area,
                            key: decode_buffered_field(key, "key")?,
                        })
                    }
                    "deleteIfUnchanged"
                        if !value_present
                            && prefix.is_none()
                            && cursor.is_none()
                            && preserve_key.is_none() =>
                    {
                        Ok(PlatformStorageRequest::DeleteIfUnchanged {
                            area,
                            key: decode_buffered_field(key, "key")?,
                            expected_value: expected_value
                                .ok_or_else(|| serde::de::Error::missing_field("expectedValue"))?,
                        })
                    }
                    "deletePrefix" if !value_present && key.is_none() && cursor.is_none() => {
                        let prefix: String = decode_buffered_field(prefix, "prefix")?;
                        if prefix.is_empty() || preserve_key.as_ref().is_some_and(String::is_empty)
                        {
                            return Err(serde::de::Error::custom(
                                "platform-storage deletion prefix or preservation key is empty",
                            ));
                        }
                        Ok(PlatformStorageRequest::DeletePrefix {
                            area,
                            prefix,
                            preserve_key,
                        })
                    }
                    "get" | "delete" | "deleteIfUnchanged" => Err(serde::de::Error::custom(
                        format!("invalid fields in platform-storage {request_type} request"),
                    )),
                    "deletePrefix" => Err(serde::de::Error::custom(
                        "invalid fields in platform-storage deletePrefix request",
                    )),
                    "set" => Err(serde::de::Error::custom(
                        "invalid fields in platform-storage set request",
                    )),
                    "listKeys" => Err(serde::de::Error::custom(
                        "invalid fields in platform-storage listKeys request",
                    )),
                    _ => Err(serde::de::Error::unknown_variant(
                        &request_type,
                        &[
                            "get",
                            "set",
                            "delete",
                            "deleteIfUnchanged",
                            "deletePrefix",
                            "listKeys",
                        ],
                    )),
                }
            }
        }

        deserializer.deserialize_map(RequestVisitor)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(
    feature = "platform-storage-contract-schema",
    derive(schemars::JsonSchema)
)]
#[serde(rename_all = "camelCase")]
pub enum PlatformStorageDeleteResult {
    Deleted,
    AlreadyAbsent,
    Conflict,
}

#[derive(Clone, PartialEq, Eq, Serialize, Zeroize, ZeroizeOnDrop)]
#[cfg_attr(
    feature = "platform-storage-contract-schema",
    derive(schemars::JsonSchema)
)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum PlatformStorageResponse {
    #[zeroize(skip)]
    KeysPage(PlatformStorageKeysPage),
    Value {
        #[serde(deserialize_with = "required_option::deserialize")]
        #[cfg_attr(
            feature = "platform-storage-contract-schema",
            schemars(with = "Option<String>")
        )]
        value: Option<SecretString>,
    },
    DeleteResult {
        #[zeroize(skip)]
        result: PlatformStorageDeleteResult,
    },
    #[zeroize(skip)]
    Done,
}

impl<'de> Deserialize<'de> for PlatformStorageResponse {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        struct ResponseVisitor;

        impl<'de> serde::de::Visitor<'de> for ResponseVisitor {
            type Value = PlatformStorageResponse;

            fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                formatter.write_str("a platform-storage response")
            }

            fn visit_map<A>(self, mut map: A) -> Result<Self::Value, A::Error>
            where
                A: serde::de::MapAccess<'de>,
            {
                let mut response_type = None;
                let mut value = None;
                let mut value_present = false;
                let mut version = None;
                let mut family = None;
                let mut backing_areas = None;
                let mut keys = None;
                let mut continuation = None;
                let mut result = None;
                let mut unknown_field = None;

                while let Some(field) = map.next_key::<String>()? {
                    match field.as_str() {
                        "type" => read_buffered_field(&mut map, &mut response_type, "type")?,
                        "version" => read_typed_field(&mut map, &mut version, "version")?,
                        "family" => read_typed_field(&mut map, &mut family, "family")?,
                        "backingAreas" => {
                            read_typed_field(&mut map, &mut backing_areas, "backingAreas")?
                        }
                        "keys" => read_typed_field(&mut map, &mut keys, "keys")?,
                        "continuation" => {
                            read_typed_field(&mut map, &mut continuation, "continuation")?
                        }
                        "result" => read_typed_field(&mut map, &mut result, "result")?,
                        "value" => {
                            if value_present {
                                return Err(serde::de::Error::duplicate_field("value"));
                            }
                            value_present = true;
                            value = Some(map.next_value::<Option<SecretString>>()?);
                        }
                        _ => {
                            map.next_value::<serde::de::IgnoredAny>()?;
                            unknown_field.get_or_insert(field);
                        }
                    }
                }

                if let Some(field) = unknown_field {
                    return Err(serde::de::Error::custom(format!(
                        "unknown field `{field}` in platform-storage response"
                    )));
                }

                let response_type: String = decode_buffered_field(response_type, "type")?;
                if result.is_some() && response_type != "deleteResult" {
                    return Err(serde::de::Error::custom(
                        "unexpected deletion result in platform-storage response",
                    ));
                }
                let inventory_fields_present = version.is_some()
                    || family.is_some()
                    || backing_areas.is_some()
                    || keys.is_some()
                    || continuation.is_some();
                match response_type.as_str() {
                    "keysPage" if !value_present => {
                        let page = PlatformStorageKeysPage {
                            version: version
                                .ok_or_else(|| serde::de::Error::missing_field("version"))?,
                            family: family
                                .ok_or_else(|| serde::de::Error::missing_field("family"))?,
                            backing_areas: backing_areas
                                .ok_or_else(|| serde::de::Error::missing_field("backingAreas"))?,
                            keys: keys.ok_or_else(|| serde::de::Error::missing_field("keys"))?,
                            continuation: continuation
                                .ok_or_else(|| serde::de::Error::missing_field("continuation"))?,
                        };
                        page.validate().map_err(|_| {
                            serde::de::Error::custom("invalid platform-storage inventory page")
                        })?;
                        Ok(PlatformStorageResponse::KeysPage(page))
                    }
                    "value" if !inventory_fields_present => Ok(PlatformStorageResponse::Value {
                        value: value.ok_or_else(|| serde::de::Error::missing_field("value"))?,
                    }),
                    "done" if !value_present && !inventory_fields_present => {
                        Ok(PlatformStorageResponse::Done)
                    }
                    "deleteResult" if !value_present && !inventory_fields_present => {
                        Ok(PlatformStorageResponse::DeleteResult {
                            result: result
                                .ok_or_else(|| serde::de::Error::missing_field("result"))?,
                        })
                    }
                    "done" if value_present => Err(serde::de::Error::custom(
                        "unknown field `value` in platform-storage done response",
                    )),
                    "done" => Err(serde::de::Error::custom(
                        "invalid fields in platform-storage done response",
                    )),
                    "value" => Err(serde::de::Error::custom(
                        "invalid fields in platform-storage value response",
                    )),
                    "keysPage" => Err(serde::de::Error::custom(
                        "invalid fields in platform-storage keysPage response",
                    )),
                    "deleteResult" => Err(serde::de::Error::custom(
                        "invalid fields in platform-storage deleteResult response",
                    )),
                    _ => Err(serde::de::Error::unknown_variant(
                        &response_type,
                        &["value", "done", "keysPage", "deleteResult"],
                    )),
                }
            }
        }

        deserializer.deserialize_map(ResponseVisitor)
    }
}

// Read nested controls directly so duplicate fields reach their typed serde visitors intact.
fn read_typed_field<'de, A, T>(
    map: &mut A,
    slot: &mut Option<T>,
    field: &'static str,
) -> Result<(), A::Error>
where
    A: serde::de::MapAccess<'de>,
    T: Deserialize<'de>,
{
    if slot.is_some() {
        return Err(serde::de::Error::duplicate_field(field));
    }
    *slot = Some(map.next_value()?);
    Ok(())
}

fn read_buffered_field<'de, A>(
    map: &mut A,
    slot: &mut Option<serde_json::Value>,
    field: &'static str,
) -> Result<(), A::Error>
where
    A: serde::de::MapAccess<'de>,
{
    if slot.is_some() {
        return Err(serde::de::Error::duplicate_field(field));
    }
    *slot = Some(map.next_value()?);
    Ok(())
}

fn decode_buffered_field<T, E>(
    value: Option<serde_json::Value>,
    field: &'static str,
) -> Result<T, E>
where
    T: DeserializeOwned,
    E: serde::de::Error,
{
    serde_json::from_value(value.ok_or_else(|| E::missing_field(field))?).map_err(E::custom)
}

#[cfg(feature = "platform-storage-contract-schema")]
#[derive(schemars::JsonSchema)]
#[allow(dead_code)]
struct PlatformStorageContract {
    request: PlatformStorageRequest,
    response: PlatformStorageResponse,
}

#[cfg(feature = "platform-storage-contract-schema")]
#[doc(hidden)]
pub fn platform_storage_contract_schema() -> schemars::Schema {
    let mut settings = schemars::generate::SchemaSettings::draft2020_12();
    settings.contract = schemars::generate::Contract::Serialize;
    settings
        .into_generator()
        .into_root_schema_for::<PlatformStorageContract>()
}

#[cfg(not(target_arch = "wasm32"))]
#[async_trait]
#[doc(hidden)]
pub trait SerializedPlatformStorageExecutor: Send + Sync {
    async fn invoke(
        &self,
        request_json: Zeroizing<String>,
    ) -> Result<Zeroizing<String>, RuntimeError>;
}

#[cfg(target_arch = "wasm32")]
#[async_trait(?Send)]
#[doc(hidden)]
pub trait SerializedPlatformStorageExecutor {
    async fn invoke(
        &self,
        request_json: Zeroizing<String>,
    ) -> Result<Zeroizing<String>, RuntimeError>;
}

/// Rust-owned document policy over one serialized primitive host seam.
#[derive(Clone)]
pub(crate) struct PlatformStorage {
    executor: Arc<dyn SerializedPlatformStorageExecutor>,
    session_survives_restart: bool,
    #[cfg(test)]
    session_lifetime_witness: Arc<std::sync::Mutex<Option<SessionLifetimeRegistration>>>,
}

#[cfg(test)]
struct SessionLifetimeRegistration {
    account_id: AccountId,
    incarnation: Incarnation,
    vault_id: String,
    lifetime: std::sync::Weak<()>,
}

struct UnavailablePlatformStorageExecutor;

#[cfg_attr(target_arch = "wasm32", async_trait(?Send))]
#[cfg_attr(not(target_arch = "wasm32"), async_trait)]
impl SerializedPlatformStorageExecutor for UnavailablePlatformStorageExecutor {
    async fn invoke(
        &self,
        _request_json: Zeroizing<String>,
    ) -> Result<Zeroizing<String>, RuntimeError> {
        Err(platform_storage_invariant(
            "this Runtime has no production platform storage executor",
        ))
    }
}

impl PlatformStorage {
    pub(crate) fn physical_location(
        &self,
        value: &PlatformStorageValue,
    ) -> Result<(PlatformStorageArea, String), RuntimeError> {
        Ok((value.area(self.session_survives_restart), value.key()?))
    }

    pub(crate) fn new(executor: Arc<dyn SerializedPlatformStorageExecutor>) -> Self {
        Self {
            executor,
            #[cfg(test)]
            session_lifetime_witness: Arc::default(),
            session_survives_restart: false,
        }
    }

    pub(crate) fn for_platform(
        executor: Arc<dyn SerializedPlatformStorageExecutor>,
        platform: crate::ClientPlatform,
    ) -> Self {
        // This is the existing storage tier lifetime rule. The primitive host never
        // reinterprets SessionSecret, and native restart retains no new login credential.
        Self {
            executor,
            #[cfg(test)]
            session_lifetime_witness: Arc::default(),
            session_survives_restart: matches!(
                platform,
                crate::ClientPlatform::Desktop | crate::ClientPlatform::Mobile
            ),
        }
    }

    pub(crate) fn unavailable() -> Self {
        Self::new(Arc::new(UnavailablePlatformStorageExecutor))
    }

    /// Keys-only evidence for one admission pass. The caller owns cross-page and area-partition
    /// checks; ordinary document selectors and their prescribed storage areas stay unchanged.
    pub(crate) async fn list_keys(
        &self,
        area: PlatformStorageArea,
        cursor: Option<String>,
    ) -> Result<PlatformStorageKeysPage, RuntimeError> {
        let prefix = runtime_namespace_prefix();
        let response = self
            .invoke(PlatformStorageRequest::ListKeys {
                area,
                prefix: prefix.clone(),
                cursor,
            })
            .await?;
        let PlatformStorageResponse::KeysPage(page) = &response else {
            return Err(platform_storage_invariant(
                "platform storage returned a non-inventory response for ListKeys",
            ));
        };
        page.validate_for(area, &prefix)?;
        Ok(page.clone())
    }

    pub(crate) async fn load_inactivity_timeout(
        &self,
        account_id: &AccountId,
    ) -> Result<i64, RuntimeError> {
        self.load_account_local_security(account_id)
            .await
            .map(|document| document.map_or(600_000, |value| value.inactivity_timeout_ms))
    }

    pub(crate) async fn load_account_local_security(
        &self,
        account_id: &AccountId,
    ) -> Result<Option<AccountLocalSecurityDocument>, RuntimeError> {
        self.load_document(
            PlatformStorageValue::AccountLocalSecurity(account_id.clone()),
            |value: &AccountLocalSecurityDocument| {
                require_version(value.version, "Account local security")
            },
        )
        .await
    }

    pub(crate) async fn store_inactivity_timeout(
        &self,
        account_id: &AccountId,
        timeout_ms: i64,
    ) -> Result<(), RuntimeError> {
        self.store_document(
            PlatformStorageValue::AccountLocalSecurity(account_id.clone()),
            &AccountLocalSecurityDocument::new(timeout_ms),
        )
        .await
    }

    pub(crate) async fn load_local_security(
        &self,
    ) -> Result<Option<LocalSecurityDocument>, RuntimeError> {
        self.load_document(
            PlatformStorageValue::LocalSecurity,
            |value: &LocalSecurityDocument| require_version(value.version, "Local security"),
        )
        .await
    }

    pub(crate) async fn store_local_security(&self, period_ms: i64) -> Result<(), RuntimeError> {
        self.store_document(
            PlatformStorageValue::LocalSecurity,
            &LocalSecurityDocument::new(period_ms),
        )
        .await
    }

    pub(crate) async fn load_device_catalog(
        &self,
    ) -> Result<Option<DeviceCatalogDocument>, RuntimeError> {
        self.load_document(
            PlatformStorageValue::DeviceCatalog,
            |value: &DeviceCatalogDocument| value.validate(),
        )
        .await
    }

    pub(crate) async fn store_device_catalog(
        &self,
        document: &DeviceCatalogDocument,
    ) -> Result<(), RuntimeError> {
        document.validate()?;
        self.store_document(PlatformStorageValue::DeviceCatalog, document)
            .await
    }

    pub(crate) async fn remove_device_catalog(&self) -> Result<(), RuntimeError> {
        self.delete(PlatformStorageValue::DeviceCatalog).await
    }

    /// Removes every persisted incarnation for one explicit Account from every storage area.
    pub(crate) async fn delete_account_namespace(
        &self,
        account_id: &AccountId,
    ) -> Result<(), RuntimeError> {
        let prefix = account_prefix(account_id)?;
        for area in [
            PlatformStorageArea::DevicePlain,
            PlatformStorageArea::DeviceSecret,
            PlatformStorageArea::SessionSecret,
        ] {
            self.expect_done(PlatformStorageRequest::DeletePrefix {
                area,
                prefix: prefix.clone(),
                preserve_key: None,
            })
            .await?;
        }
        Ok(())
    }

    /// Removes only the Runtime-owned namespace, including Device documents and orphaned Accounts.
    pub(crate) async fn wipe_runtime_namespace(&self) -> Result<(), RuntimeError> {
        let prefix = runtime_namespace_prefix();
        for area in [
            PlatformStorageArea::DevicePlain,
            PlatformStorageArea::DeviceSecret,
            PlatformStorageArea::SessionSecret,
        ] {
            self.expect_done(PlatformStorageRequest::DeletePrefix {
                area,
                prefix: prefix.clone(),
                preserve_key: None,
            })
            .await?;
        }
        Ok(())
    }

    pub(crate) async fn load_account_metadata(
        &self,
        account_id: &AccountId,
        incarnation: &Incarnation,
    ) -> Result<Option<AccountMetadataDocument>, RuntimeError> {
        require_account_id(account_id)?;
        require_incarnation(incarnation)?;
        let expected = account_id.clone();
        let expected_incarnation = incarnation.clone();
        self.load_document(
            PlatformStorageValue::AccountMetadata(account_id.clone(), incarnation.clone()),
            move |value: &AccountMetadataDocument| {
                value.validate()?;
                require_matching_account(&expected, &value.account_id, "Account metadata")?;
                require_matching_incarnation(
                    &expected_incarnation,
                    &value.incarnation,
                    "Account metadata",
                )
            },
        )
        .await
    }

    pub(crate) async fn load_verified_recipient_keys(
        &self,
        metadata: &AccountMetadataDocument,
    ) -> Result<crate::recipient_keys::VerifiedRecipientKeys, RuntimeError> {
        let document = self
            .load_document(
                PlatformStorageValue::VerifiedRecipientKeys(
                    metadata.account_id.clone(),
                    metadata.incarnation.clone(),
                ),
                |value: &crate::recipient_keys::VerifiedRecipientKeys| {
                    value.validate(
                        &metadata.account_id,
                        &metadata.incarnation,
                        &metadata.normalized_server_url,
                        &metadata.user_id,
                    )
                },
            )
            .await
            .map_err(|error| {
                if error.code == RuntimeErrorCode::InvariantViolation {
                    RuntimeError::new(
                        RuntimeErrorCode::StorageUnavailable,
                        "Recipient verification storage is invalid",
                    )
                } else {
                    error
                }
            })?;
        Ok(document.unwrap_or_else(|| {
            crate::recipient_keys::VerifiedRecipientKeys::new(
                metadata.account_id.clone(),
                metadata.incarnation.clone(),
                metadata.normalized_server_url.clone(),
                metadata.user_id.clone(),
            )
        }))
    }

    pub(crate) async fn store_verified_recipient_keys(
        &self,
        document: &crate::recipient_keys::VerifiedRecipientKeys,
    ) -> Result<(), RuntimeError> {
        self.store_document(
            PlatformStorageValue::VerifiedRecipientKeys(
                document.account_id.clone(),
                document.incarnation.clone(),
            ),
            document,
        )
        .await
    }

    pub(crate) async fn load_account_metadata_for_authentication(
        &self,
        account_id: &AccountId,
        incarnation: &Incarnation,
    ) -> Result<Option<AccountMetadataDocument>, RuntimeError> {
        require_account_id(account_id)?;
        require_incarnation(incarnation)?;
        let expected = account_id.clone();
        let expected_incarnation = incarnation.clone();
        self.load_authentication_document(
            PlatformStorageValue::AccountMetadata(account_id.clone(), incarnation.clone()),
            move |value: &AccountMetadataDocument| {
                value.validate()?;
                require_matching_account(&expected, &value.account_id, "Account metadata")?;
                require_matching_incarnation(
                    &expected_incarnation,
                    &value.incarnation,
                    "Account metadata",
                )
            },
        )
        .await
    }

    pub(crate) async fn store_account_metadata(
        &self,
        document: &AccountMetadataDocument,
    ) -> Result<(), RuntimeError> {
        document.validate()?;
        self.store_document(
            PlatformStorageValue::AccountMetadata(
                document.account_id.clone(),
                document.incarnation.clone(),
            ),
            document,
        )
        .await
    }

    pub(crate) async fn remove_account_metadata(
        &self,
        account_id: &AccountId,
        incarnation: &Incarnation,
    ) -> Result<(), RuntimeError> {
        self.delete(PlatformStorageValue::AccountMetadata(
            account_id.clone(),
            incarnation.clone(),
        ))
        .await
    }

    pub(crate) async fn load_device_key(&self) -> Result<Option<DeviceKeyDocument>, RuntimeError> {
        self.load_document(
            PlatformStorageValue::DeviceKey,
            |value: &DeviceKeyDocument| value.validate(),
        )
        .await
    }

    pub(crate) async fn load_device_key_for_authentication(
        &self,
    ) -> Result<Option<DeviceKeyDocument>, RuntimeError> {
        self.load_authentication_document(
            PlatformStorageValue::DeviceKey,
            |value: &DeviceKeyDocument| value.validate(),
        )
        .await
    }

    pub(crate) async fn store_device_key(
        &self,
        document: &DeviceKeyDocument,
    ) -> Result<(), RuntimeError> {
        document.validate()?;
        self.store_document(PlatformStorageValue::DeviceKey, document)
            .await
    }

    pub(crate) async fn remove_device_key(&self) -> Result<(), RuntimeError> {
        self.delete(PlatformStorageValue::DeviceKey).await
    }

    pub(crate) async fn load_quick_unlock(
        &self,
        account_id: &AccountId,
        incarnation: &Incarnation,
    ) -> Result<Option<QuickUnlockDocument>, RuntimeError> {
        require_account_id(account_id)?;
        require_incarnation(incarnation)?;
        let expected = account_id.clone();
        let expected_incarnation = incarnation.clone();
        self.load_document(
            PlatformStorageValue::AccountQuickUnlock(account_id.clone(), incarnation.clone()),
            move |value: &QuickUnlockDocument| {
                value.validate()?;
                require_matching_account(&expected, &value.account_id, "Quick-unlock")?;
                require_matching_incarnation(
                    &expected_incarnation,
                    &value.incarnation,
                    "Quick-unlock",
                )
            },
        )
        .await
    }

    pub(crate) async fn load_quick_unlock_for_authentication(
        &self,
        account_id: &AccountId,
        incarnation: &Incarnation,
    ) -> Result<Option<QuickUnlockDocument>, RuntimeError> {
        require_account_id(account_id)?;
        require_incarnation(incarnation)?;
        let expected = account_id.clone();
        let expected_incarnation = incarnation.clone();
        self.load_authentication_document(
            PlatformStorageValue::AccountQuickUnlock(account_id.clone(), incarnation.clone()),
            move |value: &QuickUnlockDocument| {
                value.validate()?;
                require_matching_account(&expected, &value.account_id, "Quick-unlock")?;
                require_matching_incarnation(
                    &expected_incarnation,
                    &value.incarnation,
                    "Quick-unlock",
                )
            },
        )
        .await
    }

    pub(crate) async fn store_quick_unlock(
        &self,
        document: &QuickUnlockDocument,
    ) -> Result<(), RuntimeError> {
        document.validate()?;
        self.store_document(
            PlatformStorageValue::AccountQuickUnlock(
                document.account_id.clone(),
                document.incarnation.clone(),
            ),
            document,
        )
        .await
    }

    pub(crate) async fn remove_quick_unlock(
        &self,
        account_id: &AccountId,
        incarnation: &Incarnation,
    ) -> Result<(), RuntimeError> {
        self.delete(PlatformStorageValue::AccountQuickUnlock(
            account_id.clone(),
            incarnation.clone(),
        ))
        .await
    }

    pub(crate) async fn load_current_session(
        &self,
        account_id: &AccountId,
        incarnation: &Incarnation,
    ) -> Result<Option<CurrentSessionDocument>, RuntimeError> {
        require_account_id(account_id)?;
        require_incarnation(incarnation)?;
        let expected = account_id.clone();
        let expected_incarnation = incarnation.clone();
        let document = self
            .load_document(
                PlatformStorageValue::CurrentSessionCredentials(
                    account_id.clone(),
                    incarnation.clone(),
                ),
                move |value: &CurrentSessionDocument| {
                    value.validate()?;
                    require_matching_account(&expected, &value.account_id, "Current Session")?;
                    require_matching_incarnation(
                        &expected_incarnation,
                        &value.incarnation,
                        "Current Session",
                    )
                },
            )
            .await?;
        #[cfg(test)]
        let document = {
            let mut document = document;
            let registration = self.session_lifetime_witness.lock().unwrap();
            if let (Some(document), Some(registration)) = (&mut document, registration.as_ref()) {
                if document.account_id == registration.account_id
                    && document.incarnation == registration.incarnation
                    && document
                        .vault_keys
                        .iter()
                        .any(|key| key.vault_id == registration.vault_id)
                {
                    document.lifetime_witness._lease = registration.lifetime.upgrade();
                }
            }
            document
        };
        Ok(document)
    }

    /// Observe decoded Session snapshots for one fixture cohort, without a global registry.
    #[cfg(test)]
    pub(crate) fn observe_session_lifetime_for_test(
        &self,
        account_id: AccountId,
        incarnation: Incarnation,
        vault_id: String,
        lifetime: &Arc<()>,
    ) {
        *self.session_lifetime_witness.lock().unwrap() = Some(SessionLifetimeRegistration {
            account_id,
            incarnation,
            vault_id,
            lifetime: Arc::downgrade(lifetime),
        });
    }

    pub(crate) async fn store_current_session(
        &self,
        document: &CurrentSessionDocument,
    ) -> Result<(), RuntimeError> {
        if document.provenance != SessionProvenance::Independent {
            return Err(platform_storage_invariant(
                "Borrowed Session authority cannot enter platform storage",
            ));
        }
        document.validate()?;
        self.store_document(
            PlatformStorageValue::CurrentSessionCredentials(
                document.account_id.clone(),
                document.incarnation.clone(),
            ),
            document,
        )
        .await
    }

    pub(crate) async fn remove_current_session(
        &self,
        account_id: &AccountId,
        incarnation: &Incarnation,
    ) -> Result<(), RuntimeError> {
        self.delete(PlatformStorageValue::CurrentSessionCredentials(
            account_id.clone(),
            incarnation.clone(),
        ))
        .await
    }

    pub(crate) async fn load_legacy_session_evidence(
        &self,
        account_id: &AccountId,
        incarnation: &Incarnation,
    ) -> Result<Option<LegacySessionEvidenceDocument>, RuntimeError> {
        require_account_id(account_id)?;
        require_incarnation(incarnation)?;
        let expected = account_id.clone();
        let expected_incarnation = incarnation.clone();
        self.load_document(
            PlatformStorageValue::LegacySessionEvidence(account_id.clone(), incarnation.clone()),
            move |value: &LegacySessionEvidenceDocument| {
                value.validate()?;
                require_matching_account(&expected, &value.account_id, "Legacy Session evidence")?;
                require_matching_incarnation(
                    &expected_incarnation,
                    &value.incarnation,
                    "Legacy Session evidence",
                )
            },
        )
        .await
    }

    pub(crate) async fn store_legacy_session_evidence(
        &self,
        document: &LegacySessionEvidenceDocument,
    ) -> Result<(), RuntimeError> {
        document.validate()?;
        self.store_document(
            PlatformStorageValue::LegacySessionEvidence(
                document.account_id.clone(),
                document.incarnation.clone(),
            ),
            document,
        )
        .await
    }

    pub(crate) async fn remove_legacy_session_evidence(
        &self,
        account_id: &AccountId,
        incarnation: &Incarnation,
    ) -> Result<(), RuntimeError> {
        require_account_id(account_id)?;
        require_incarnation(incarnation)?;
        self.delete(PlatformStorageValue::LegacySessionEvidence(
            account_id.clone(),
            incarnation.clone(),
        ))
        .await
    }

    async fn load_document<T>(
        &self,
        target: PlatformStorageValue,
        validate: impl FnOnce(&T) -> Result<(), RuntimeError>,
    ) -> Result<Option<T>, RuntimeError>
    where
        T: DeserializeOwned,
    {
        let Some(serialized) = self.get(target).await? else {
            return Ok(None);
        };
        let Object(document): Object<T> = serde_json::from_str(&serialized)
            .map_err(|_| platform_storage_invariant("platform storage document is invalid"))?;
        validate(&document)?;
        Ok(Some(document))
    }

    /// Keeps host/executor failures intact while classifying only unusable persisted login material
    /// as a request for Full sign-in.
    async fn load_authentication_document<T>(
        &self,
        target: PlatformStorageValue,
        validate: impl FnOnce(&T) -> Result<(), RuntimeError>,
    ) -> Result<Option<T>, RuntimeError>
    where
        T: DeserializeOwned,
    {
        let Some(serialized) = self.get(target).await? else {
            return Ok(None);
        };
        let Object(document): Object<T> =
            serde_json::from_str(&serialized).map_err(|_| unavailable_quick_unlock_material())?;
        validate(&document).map_err(|_| unavailable_quick_unlock_material())?;
        Ok(Some(document))
    }

    async fn store_document<T>(
        &self,
        target: PlatformStorageValue,
        document: &T,
    ) -> Result<(), RuntimeError>
    where
        T: Serialize,
    {
        let area = target.area(self.session_survives_restart);
        let key = target.key()?;
        let serialized = serialize_sensitive_json(
            document,
            "platform storage document could not be serialized",
        )?;
        self.expect_done(PlatformStorageRequest::Set {
            area,
            key,
            value: SecretString::new(serialized),
        })
        .await
    }

    async fn get(
        &self,
        target: PlatformStorageValue,
    ) -> Result<Option<Zeroizing<String>>, RuntimeError> {
        let mut response = self
            .invoke(PlatformStorageRequest::Get {
                area: target.area(self.session_survives_restart),
                key: target.key()?,
            })
            .await?;
        match &mut response {
            PlatformStorageResponse::Value { value } => {
                Ok(value.take().map(SecretString::into_zeroizing))
            }
            PlatformStorageResponse::Done => Err(platform_storage_invariant(
                "platform storage returned Done for Get",
            )),
            PlatformStorageResponse::KeysPage(_) => Err(platform_storage_invariant(
                "platform storage returned KeysPage for Get",
            )),
            PlatformStorageResponse::DeleteResult { .. } => Err(platform_storage_invariant(
                "platform storage returned DeleteResult for Get",
            )),
        }
    }

    async fn delete(&self, target: PlatformStorageValue) -> Result<(), RuntimeError> {
        self.expect_done(PlatformStorageRequest::Delete {
            area: target.area(self.session_survives_restart),
            key: target.key()?,
        })
        .await
    }

    async fn expect_done(&self, request: PlatformStorageRequest) -> Result<(), RuntimeError> {
        match self.invoke(request).await? {
            PlatformStorageResponse::Done => Ok(()),
            PlatformStorageResponse::Value { .. } => Err(platform_storage_invariant(
                "platform storage returned Value for a write",
            )),
            PlatformStorageResponse::KeysPage(_) => Err(platform_storage_invariant(
                "platform storage returned KeysPage for a write",
            )),
            PlatformStorageResponse::DeleteResult { .. } => Err(platform_storage_invariant(
                "platform storage returned DeleteResult for an unconditional write",
            )),
        }
    }

    async fn invoke(
        &self,
        request: PlatformStorageRequest,
    ) -> Result<PlatformStorageResponse, RuntimeError> {
        let inventory_request =
            if let PlatformStorageRequest::ListKeys { prefix, cursor, .. } = &request {
                validate_inventory_request(prefix, cursor.as_deref())?;
                true
            } else {
                false
            };
        let request_json = Zeroizing::new(serialize_sensitive_json(
            &request,
            "platform storage request could not be serialized",
        )?);
        if inventory_request {
            validate_inventory_control_bytes(request_json.len())?;
        }
        let response_json = self.executor.invoke(request_json).await?;
        if inventory_request {
            validate_inventory_control_bytes(response_json.len())?;
        }
        serde_json::from_str(&response_json).map_err(|_| {
            platform_storage_invariant("platform storage returned an invalid response")
        })
    }
}

fn require_matching_account(
    requested: &AccountId,
    stored: &AccountId,
    document: &str,
) -> Result<(), RuntimeError> {
    if requested != stored {
        return Err(platform_storage_invariant(format!(
            "{document} belongs to another Account"
        )));
    }
    Ok(())
}

fn require_matching_incarnation(
    requested: &Incarnation,
    stored: &Incarnation,
    document: &str,
) -> Result<(), RuntimeError> {
    if requested != stored {
        return Err(platform_storage_invariant(format!(
            "{document} belongs to another Account incarnation"
        )));
    }
    Ok(())
}

fn platform_storage_invariant(message: impl Into<String>) -> RuntimeError {
    RuntimeError::new(RuntimeErrorCode::InvariantViolation, message)
}

fn unavailable_quick_unlock_material() -> RuntimeError {
    RuntimeError::new(
        RuntimeErrorCode::AuthenticationRequired,
        "Stored Quick Unlock material is unavailable",
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    #[derive(Default)]
    struct RecordingExecutor {
        requests: Mutex<Vec<PlatformStorageRequest>>,
        responses: Mutex<Vec<PlatformStorageResponse>>,
    }

    #[derive(Clone, Copy)]
    enum FailingWireBehavior {
        ExecutorError,
        MalformedResponse,
        InvalidDocument,
    }

    struct FailingWireExecutor {
        behavior: FailingWireBehavior,
        saw_secret: Mutex<bool>,
    }

    struct PrefixStorageExecutor {
        values: Mutex<Vec<(PlatformStorageArea, String, String)>>,
        fail_once_in: Mutex<Option<PlatformStorageArea>>,
    }

    impl PrefixStorageExecutor {
        fn new(values: Vec<(PlatformStorageArea, String, String)>) -> Self {
            Self {
                values: Mutex::new(values),
                fail_once_in: Mutex::new(None),
            }
        }

        fn fail_once_in(&self, area: PlatformStorageArea) {
            *self.fail_once_in.lock().expect("failure lock poisoned") = Some(area);
        }

        fn keys(&self) -> Vec<(PlatformStorageArea, String)> {
            self.values
                .lock()
                .expect("values lock poisoned")
                .iter()
                .map(|(area, key, _)| (*area, key.clone()))
                .collect()
        }
    }

    #[async_trait]
    impl SerializedPlatformStorageExecutor for FailingWireExecutor {
        async fn invoke(
            &self,
            request_json: Zeroizing<String>,
        ) -> Result<Zeroizing<String>, RuntimeError> {
            *self.saw_secret.lock().expect("wire observation poisoned") =
                request_json.contains("session-token");
            match self.behavior {
                FailingWireBehavior::ExecutorError => {
                    Err(platform_storage_invariant("injected executor failure"))
                }
                FailingWireBehavior::MalformedResponse => Ok(Zeroizing::new(
                    r#"{"type":"value","value":"session-token"#.into(),
                )),
                FailingWireBehavior::InvalidDocument => Ok(Zeroizing::new(
                    serde_json::json!({
                        "type": "value",
                        "value": "{\"token\":\"session-token\"}",
                    })
                    .to_string(),
                )),
            }
        }
    }

    #[async_trait]
    impl SerializedPlatformStorageExecutor for RecordingExecutor {
        async fn invoke(
            &self,
            request_json: Zeroizing<String>,
        ) -> Result<Zeroizing<String>, RuntimeError> {
            let request = serde_json::from_str(&request_json)
                .map_err(|_| platform_storage_invariant("test request was invalid"))?;
            self.requests
                .lock()
                .expect("requests lock poisoned")
                .push(request);
            let response = self
                .responses
                .lock()
                .expect("responses lock poisoned")
                .remove(0);
            serde_json::to_string(&response)
                .map(Zeroizing::new)
                .map_err(|_| platform_storage_invariant("test response could not serialize"))
        }
    }

    #[async_trait]
    impl SerializedPlatformStorageExecutor for PrefixStorageExecutor {
        async fn invoke(
            &self,
            request_json: Zeroizing<String>,
        ) -> Result<Zeroizing<String>, RuntimeError> {
            let request: PlatformStorageRequest = serde_json::from_str(&request_json)
                .map_err(|_| platform_storage_invariant("test request was invalid"))?;
            if let PlatformStorageRequest::Get { area, key } = &request {
                let value = self
                    .values
                    .lock()
                    .unwrap()
                    .iter()
                    .find(|(stored_area, stored_key, _)| stored_area == area && stored_key == key)
                    .map(|(_, _, value)| SecretString::from(value.clone()));
                return Ok(Zeroizing::new(
                    serde_json::to_string(&PlatformStorageResponse::Value { value }).unwrap(),
                ));
            }
            if let PlatformStorageRequest::Set { area, key, value } = &request {
                let mut values = self.values.lock().unwrap();
                values.retain(|(stored_area, stored_key, _)| {
                    stored_area != area || stored_key != key
                });
                values.push((*area, key.clone(), value.to_string()));
                return Ok(Zeroizing::new(r#"{"type":"done"}"#.into()));
            }
            let PlatformStorageRequest::DeletePrefix {
                area,
                prefix,
                preserve_key,
            } = &request
            else {
                return Err(platform_storage_invariant(
                    "test executor accepts get, set and prefix deletion",
                ));
            };
            let mut fail_once = self.fail_once_in.lock().expect("failure lock poisoned");
            if *fail_once == Some(*area) {
                *fail_once = None;
                return Err(platform_storage_invariant(
                    "platform storage primitive failed",
                ));
            }
            drop(fail_once);
            self.values
                .lock()
                .expect("values lock poisoned")
                .retain(|(candidate_area, key, _)| {
                    *candidate_area != *area
                        || !key.starts_with(prefix)
                        || Some(key.as_str()) == preserve_key.as_deref()
                });
            Ok(Zeroizing::new(r#"{"type":"done"}"#.into()))
        }
    }

    fn account(value: &str) -> AccountId {
        AccountId::from(value)
    }

    #[tokio::test]
    async fn verified_recipient_keys_survive_reopen_but_not_removal_or_wipe() {
        let executor = Arc::new(PrefixStorageExecutor::new(vec![]));
        let storage = PlatformStorage::new(executor.clone());
        let identity = metadata("recipient-test", "first");
        let (real, _) = crate::recipient_keys::tests::identities();
        let mut trust = storage
            .load_verified_recipient_keys(&identity)
            .await
            .unwrap();
        trust
            .verify(
                "recipient",
                &real.public_key,
                &bittery_crypto_core::rsa::rsa_public_key_fingerprint(&real.public_key).unwrap(),
            )
            .unwrap();
        storage.store_verified_recipient_keys(&trust).await.unwrap();
        drop(storage);
        let reopened = PlatformStorage::new(executor.clone());
        assert_eq!(
            reopened
                .load_verified_recipient_keys(&identity)
                .await
                .unwrap()
                .approved_key("recipient", real.public_key.clone())
                .unwrap(),
            real.public_key
        );
        for isolated in [
            metadata("other", "first"),
            metadata("recipient-test", "second"),
        ] {
            assert_eq!(
                reopened
                    .load_verified_recipient_keys(&isolated)
                    .await
                    .unwrap()
                    .approved_key("recipient", real.public_key.clone())
                    .unwrap_err()
                    .code,
                RuntimeErrorCode::RecipientKeyUnverified
            );
        }
        let mut other_user = identity.clone();
        other_user.user_id = "other-user".into();
        assert_eq!(
            reopened
                .load_verified_recipient_keys(&other_user)
                .await
                .err()
                .unwrap()
                .code,
            RuntimeErrorCode::StorageUnavailable
        );
        let mut other_server = identity.clone();
        other_server.normalized_server_url = "https://other.example.com".into();
        assert_eq!(
            reopened
                .load_verified_recipient_keys(&other_server)
                .await
                .err()
                .unwrap()
                .code,
            RuntimeErrorCode::StorageUnavailable
        );
        reopened
            .delete_account_namespace(&identity.account_id)
            .await
            .unwrap();
        assert_eq!(
            reopened
                .load_verified_recipient_keys(&identity)
                .await
                .unwrap()
                .approved_key("recipient", real.public_key.clone())
                .unwrap_err()
                .code,
            RuntimeErrorCode::RecipientKeyUnverified
        );
        assert!(executor.keys().is_empty());
        reopened
            .store_verified_recipient_keys(&trust)
            .await
            .unwrap();
        reopened.wipe_runtime_namespace().await.unwrap();
        assert!(executor.keys().is_empty());
        assert_eq!(
            reopened
                .load_verified_recipient_keys(&identity)
                .await
                .unwrap()
                .approved_key("recipient", real.public_key.clone())
                .unwrap_err()
                .code,
            RuntimeErrorCode::RecipientKeyUnverified
        );
    }

    fn incarnation(value: &str) -> Incarnation {
        Incarnation::from(value)
    }

    fn kdf_profile() -> bittery_crypto_core::KdfProfile {
        bittery_crypto_core::KdfProfile {
            schema_version: 1,
            algorithm: "pbkdf2-sha256".into(),
            iterations: 600_000,
        }
    }

    fn metadata(account_id: &str, generation: &str) -> AccountMetadataDocument {
        AccountMetadataDocument::new(
            account(account_id),
            incarnation(generation),
            "user-1".into(),
            "user@example.com".into(),
            "User".into(),
            "https://vault.example.com".into(),
            Some("Team".into()),
            None,
            "A3-TEST".into(),
            10,
            20,
            false,
            false,
            kdf_profile(),
            None,
        )
        .expect("metadata must be valid")
    }

    fn quick_unlock_document() -> QuickUnlockDocument {
        QuickUnlockDocument::new(
            account("account"),
            incarnation("generation"),
            bittery_crypto_core::EncryptedData {
                ciphertext: "ciphertext".into(),
                iv: "iv".into(),
                algorithm: "AES-GCM-AAD-V1".into(),
            },
            "A3-ABCDEF-GHIJKL-MNOPQ-RSTUV-WXYZ2".into(),
            10,
            None,
            false,
        )
        .expect("quick unlock must be valid")
    }

    fn current_session_document() -> CurrentSessionDocument {
        CurrentSessionDocument::new(
            account("account"),
            incarnation("generation"),
            "session-token".into(),
            Some("session-id".into()),
            1_000,
            Some(2_000),
            vec![crate::server_contract::AuthVaultKeyResponse {
                encrypted_vault_key: "encrypted-vault-key".into(),
                role: crate::server_contract::VaultRole::Owner,
                vault_icon: Some("key".into()),
                vault_id: "vault".into(),
                vault_image_url: None,
                vault_name: "Personal".into(),
                vault_type: crate::server_contract::VaultType::Personal,
            }],
            "encrypted-private-key".into(),
        )
        .expect("canonical Current Session must be valid")
    }

    fn legacy_session_evidence_document() -> LegacySessionEvidenceDocument {
        LegacySessionEvidenceDocument::new(
            account("account"),
            incarnation("generation"),
            "a".repeat(64),
            LegacySessionEvidenceMaterial {
                source_session_instance: None,
                created_at_ms: 1_700_000_000_000,
                expires_at: Some(1_209_600_000),
                server_expires_at: None,
                session_id: Some(String::new()),
                token: Some("retained-token".into()),
                vault_keys: None,
                encrypted_private_key: None,
            },
        )
        .expect("canonical legacy Session evidence must be valid")
    }

    fn positional(value: &serde_json::Value, fields: &[&str]) -> serde_json::Value {
        let object = value.as_object().expect("test value must be an object");
        serde_json::Value::Array(
            fields
                .iter()
                .map(|field| object.get(*field).expect("test field must exist").clone())
                .collect(),
        )
    }

    #[test]
    fn persisted_documents_require_objects_at_every_struct_boundary() {
        let device_key = serde_json::to_value(DeviceKeyDocument::new([7; 32])).unwrap();
        let positional_device_key = positional(&device_key, &["version", "keyBytes"]);
        assert!(serde_json::from_value::<DeviceKeyDocument>(positional_device_key).is_err());

        let catalog = serde_json::to_value(
            DeviceCatalogDocument::new(vec![DeviceCatalogAccount {
                account_id: account("account"),
                active_incarnation: None,
                pending_install: Some(PendingAccountInstallIntent {
                    incarnation: incarnation("generation"),
                    expected_active_incarnation: None,
                }),
                pending_retirement: None,
            }])
            .unwrap(),
        )
        .unwrap();
        let mut positional_catalog_account = catalog.clone();
        positional_catalog_account["accounts"][0] = positional(
            &catalog["accounts"][0],
            &["accountId", "activeIncarnation", "pendingInstall"],
        );
        assert!(
            serde_json::from_value::<DeviceCatalogDocument>(positional_catalog_account).is_err()
        );
        let mut positional_pending_install = catalog;
        positional_pending_install["accounts"][0]["pendingInstall"] =
            serde_json::json!(["generation", null]);
        assert!(
            serde_json::from_value::<DeviceCatalogDocument>(positional_pending_install).is_err()
        );

        let quick_unlock = serde_json::to_value(quick_unlock_document()).unwrap();
        let mut positional_envelope = quick_unlock.clone();
        positional_envelope["encryptedMasterUnlockKey"] = positional(
            &quick_unlock["encryptedMasterUnlockKey"],
            &["ciphertext", "iv", "algorithm"],
        );
        assert!(serde_json::from_value::<QuickUnlockDocument>(positional_envelope).is_err());

        let metadata = serde_json::to_value(metadata("account", "generation")).unwrap();
        let mut positional_kdf = metadata.clone();
        positional_kdf["pinnedKdfProfile"] = positional(
            &metadata["pinnedKdfProfile"],
            &["schemaVersion", "algorithm", "iterations"],
        );
        assert!(serde_json::from_value::<AccountMetadataDocument>(positional_kdf).is_err());

        let mut positional_travel = metadata;
        positional_travel["verifiedTravelMode"] = serde_json::json!([false, [], null, null, 10]);
        assert!(serde_json::from_value::<AccountMetadataDocument>(positional_travel).is_err());

        let session = serde_json::to_value(current_session_document()).unwrap();
        let mut positional_vault_key = session.clone();
        positional_vault_key["vaultKeys"][0] = positional(
            &session["vaultKeys"][0],
            &[
                "encryptedVaultKey",
                "role",
                "vaultIcon",
                "vaultId",
                "vaultImageUrl",
                "vaultName",
                "vaultType",
            ],
        );
        assert!(serde_json::from_value::<CurrentSessionDocument>(positional_vault_key).is_err());

        // The array itself remains the intended representation for fixed key bytes and Vault-key
        // collections when their elements retain their object shape.
        assert!(serde_json::from_value::<DeviceKeyDocument>(device_key).is_ok());
        assert!(serde_json::from_value::<CurrentSessionDocument>(session).is_ok());
    }

    #[test]
    fn persisted_nested_objects_still_reject_duplicate_fields() {
        assert!(serde_json::from_str::<QuickUnlockDocument>(
            r#"{"version":1,"accountId":"account","incarnation":"generation","encryptedMasterUnlockKey":{"ciphertext":"first","ciphertext":"second","iv":"iv","algorithm":"AES-GCM-AAD-V1"},"secretKey":"A3-ABCDEF-GHIJKL-MNOPQ-RSTUV-WXYZ2","createdAtMs":10,"lastMasterPasswordEntryMs":null,"biometricEnabled":false}"#,
        )
        .is_err());
        assert!(serde_json::from_str::<AccountMetadataDocument>(
            r#"{"version":1,"accountId":"account","incarnation":"generation","userId":"user","email":"user@example.com","name":"User","normalizedServerUrl":"https://example.test","teamName":null,"teamAvatarUrl":null,"secretKeyHint":"A3-TEST","addedAtMs":10,"lastActiveAtMs":20,"biometricEnabled":false,"insecureTransportConfirmed":false,"pinnedKdfProfile":{"schemaVersion":1,"algorithm":"pbkdf2-sha256","algorithm":"pbkdf2-sha512","iterations":600000},"verifiedTravelMode":null}"#,
        )
        .is_err());
    }

    #[tokio::test]
    async fn borrowed_session_cannot_enter_any_platform_storage_tier() {
        let executor = Arc::new(RecordingExecutor {
            responses: Mutex::new(vec![PlatformStorageResponse::Done]),
            ..RecordingExecutor::default()
        });
        let storage = PlatformStorage::new(executor.clone());
        let mut borrowed = current_session_document();
        borrowed.provenance = SessionProvenance::Borrowed {
            grant_id: "grant".into(),
        };
        let cloned = borrowed.clone();
        assert!(matches!(
            cloned.provenance,
            SessionProvenance::Borrowed { .. }
        ));
        let error = storage
            .store_current_session(&cloned)
            .await
            .expect_err("borrowed Session must be refused before host storage");
        assert_eq!(error.code, RuntimeErrorCode::InvariantViolation);
        assert!(executor.requests.lock().unwrap().is_empty());
    }

    #[test]
    fn session_provenance_is_not_a_new_persisted_format_or_serialized_authority() {
        let original = current_session_document();
        let mut borrowed = original.clone();
        borrowed.provenance = SessionProvenance::Borrowed {
            grant_id: "grant".into(),
        };
        let encoded = serde_json::to_string(&borrowed).unwrap();
        assert_eq!(encoded, serde_json::to_string(&original).unwrap());
        let decoded: CurrentSessionDocument = serde_json::from_str(&encoded).unwrap();
        assert!(matches!(decoded.provenance, SessionProvenance::Independent));
        assert!(!encoded.contains("grant"));
    }

    #[tokio::test]
    async fn current_session_lifetime_is_routed_by_core_for_each_platform() {
        for (platform, expected_area) in [
            (
                crate::ClientPlatform::Web,
                PlatformStorageArea::SessionSecret,
            ),
            (
                crate::ClientPlatform::Extension,
                PlatformStorageArea::SessionSecret,
            ),
            (
                crate::ClientPlatform::Desktop,
                PlatformStorageArea::DeviceSecret,
            ),
            (
                crate::ClientPlatform::Mobile,
                PlatformStorageArea::DeviceSecret,
            ),
        ] {
            let document = current_session_document();
            let executor = Arc::new(RecordingExecutor {
                requests: Mutex::new(Vec::new()),
                responses: Mutex::new(vec![
                    PlatformStorageResponse::Done,
                    PlatformStorageResponse::Value {
                        value: Some(serde_json::to_string(&document).unwrap().into()),
                    },
                    PlatformStorageResponse::Done,
                ]),
            });
            let storage = PlatformStorage::for_platform(executor.clone(), platform);
            storage.store_current_session(&document).await.unwrap();
            let restored = storage
                .load_current_session(&account("account"), &incarnation("generation"))
                .await
                .unwrap()
                .unwrap();
            assert_eq!(restored.token.as_ref(), "session-token");
            storage
                .remove_current_session(&account("account"), &incarnation("generation"))
                .await
                .unwrap();
            for request in executor.requests.lock().unwrap().iter() {
                let area = match request {
                    PlatformStorageRequest::Get { area, .. }
                    | PlatformStorageRequest::Set { area, .. }
                    | PlatformStorageRequest::Delete { area, .. } => *area,
                    _ => panic!("unexpected capability request"),
                };
                assert_eq!(area, expected_area, "{platform:?}");
            }
        }
    }

    #[tokio::test]
    async fn legacy_session_evidence_uses_session_lifetime_without_authentication_fallback() {
        for (platform, expected_area) in [
            (
                crate::ClientPlatform::Extension,
                PlatformStorageArea::SessionSecret,
            ),
            (
                crate::ClientPlatform::Desktop,
                PlatformStorageArea::DeviceSecret,
            ),
        ] {
            let document = legacy_session_evidence_document();
            let executor = Arc::new(RecordingExecutor {
                requests: Mutex::new(Vec::new()),
                responses: Mutex::new(vec![
                    PlatformStorageResponse::Done,
                    PlatformStorageResponse::Value {
                        value: Some(serde_json::to_string(&document).unwrap().into()),
                    },
                    PlatformStorageResponse::Done,
                ]),
            });
            let storage = PlatformStorage::for_platform(executor.clone(), platform);
            storage
                .store_legacy_session_evidence(&document)
                .await
                .unwrap();
            let restored = storage
                .load_legacy_session_evidence(&account("account"), &incarnation("generation"))
                .await
                .unwrap()
                .unwrap();
            assert!(restored == document);
            storage
                .remove_legacy_session_evidence(&account("account"), &incarnation("generation"))
                .await
                .unwrap();
            for request in executor.requests.lock().unwrap().iter() {
                let (area, key) = match request {
                    PlatformStorageRequest::Get { area, key }
                    | PlatformStorageRequest::Set { area, key, .. }
                    | PlatformStorageRequest::Delete { area, key } => (*area, key),
                    _ => panic!("unexpected capability request"),
                };
                assert_eq!(area, expected_area, "{platform:?}");
                assert!(key.ends_with(":legacy-session-evidence"));
            }
        }

        let document = legacy_session_evidence_document();
        let target = PlatformStorageValue::LegacySessionEvidence(
            account("account"),
            incarnation("generation"),
        );
        let executor = Arc::new(PrefixStorageExecutor::new(vec![(
            PlatformStorageArea::SessionSecret,
            target.key().unwrap(),
            serde_json::to_string(&document).unwrap(),
        )]));
        let storage = PlatformStorage::new(executor.clone());
        assert!(storage
            .load_current_session(&account("account"), &incarnation("generation"))
            .await
            .unwrap()
            .is_none());
        assert_eq!(executor.keys().len(), 1);
    }

    #[test]
    fn sensitive_documents_zeroize_only_their_plaintext_secrets() {
        fn assert_zeroize_on_drop<T: ZeroizeOnDrop>() {}

        assert_zeroize_on_drop::<SecretString>();
        assert_zeroize_on_drop::<SecretBytes32>();
        assert_zeroize_on_drop::<DeviceKeyDocument>();
        assert_zeroize_on_drop::<QuickUnlockDocument>();
        assert_zeroize_on_drop::<CurrentSessionDocument>();
        assert_zeroize_on_drop::<LegacySessionEvidenceDocument>();
        assert_zeroize_on_drop::<PlatformStorageRequest>();
        assert_zeroize_on_drop::<PlatformStorageResponse>();

        let mut device_key = DeviceKeyDocument::new([7; 32]).clone();
        device_key.zeroize();
        assert_eq!(*device_key.key_bytes, [0; 32]);

        let mut quick_unlock = quick_unlock_document().clone();
        quick_unlock.zeroize();
        assert!(quick_unlock.secret_key.is_empty());
        assert_eq!(
            quick_unlock.encrypted_master_unlock_key.ciphertext,
            "ciphertext"
        );
        assert_eq!(quick_unlock.account_id, account("account"));

        let mut current_session = current_session_document().clone();
        current_session.zeroize();
        assert!(current_session.token.is_empty());
        assert_eq!(
            current_session.encrypted_private_key,
            "encrypted-private-key"
        );
        assert_eq!(current_session.session_id.as_deref(), Some("session-id"));

        let mut request = PlatformStorageRequest::Set {
            area: PlatformStorageArea::SessionSecret,
            key: "session-key".into(),
            value: "session-token".into(),
        };
        request.zeroize();
        let PlatformStorageRequest::Set { key, value, .. } = &request else {
            panic!("Set request changed variant while zeroizing");
        };
        assert_eq!(key, "session-key");
        assert!(value.is_empty());

        let mut response = PlatformStorageResponse::Value {
            value: Some("session-token".into()),
        };
        response.zeroize();
        let PlatformStorageResponse::Value { value } = &response else {
            panic!("Value response changed variant while zeroizing");
        };
        assert!(value.is_none());
    }

    #[test]
    fn decoded_secret_fields_zeroize_when_a_later_field_makes_deserialization_fail() {
        // This observes wrapper Drop after zeroize. Rust cannot promise that an allocator or the
        // compiler never retains inaccessible copies outside the wrapper's owned allocation.
        let _ = take_secret_drop_observations();
        assert!(serde_json::from_str::<PlatformStorageRequest>(
            r#"{"type":"set","area":"sessionSecret","key":"session","value":"request-secret","unexpected":true}"#,
        )
        .is_err());
        assert_eq!(take_secret_drop_observations(), (1, 0));

        assert!(serde_json::from_str::<PlatformStorageResponse>(
            r#"{"type":"value","value":"response-secret","unexpected":true}"#,
        )
        .is_err());
        assert_eq!(take_secret_drop_observations(), (1, 0));

        assert!(serde_json::from_str::<QuickUnlockDocument>(
            r#"{"version":1,"accountId":"account","incarnation":"generation","encryptedMasterUnlockKey":{"ciphertext":"ciphertext","iv":"iv","algorithm":"AES-GCM-AAD-V1"},"secretKey":"A3-ABCDEF-GHIJKL-MNOPQ-RSTUV-WXYZ2","unexpected":true}"#,
        )
        .is_err());
        assert_eq!(take_secret_drop_observations(), (1, 0));

        assert!(serde_json::from_str::<CurrentSessionDocument>(
            r#"{"version":1,"accountId":"account","incarnation":"generation","token":"session-token","unexpected":true}"#,
        )
        .is_err());
        assert_eq!(take_secret_drop_observations(), (1, 0));

        let raw_device_key = format!(
            r#"{{"version":1,"keyBytes":[{}],"unexpected":true}}"#,
            ["7"; 32].join(",")
        );
        assert!(serde_json::from_str::<DeviceKeyDocument>(&raw_device_key).is_err());
        assert_eq!(take_secret_drop_observations(), (0, 1));
    }

    #[test]
    fn secret_wire_fields_bypass_no_tagged_envelope_error_path() {
        // Escapes force serde_json to allocate the decoded plaintext instead of borrowing the
        // zeroizing input buffer. Field validation is deliberately deferred until `value` has
        // entered SecretString, so source order cannot bypass its Drop protection.
        let _ = take_secret_drop_observations();
        for request in [
            r#"{"unexpected":true,"type":"set","area":"sessionSecret","key":"session","value":"{\"token\":\"request-secret\"}"}"#,
            r#"{"type":"set","area":7,"key":"session","value":"{\"token\":\"request-secret\"}"}"#,
            r#"{"type":"set","area":"sessionSecret","key":[],"value":"{\"token\":\"request-secret\"}"}"#,
            r#"{"type":"set","area":"sessionSecret","key":"session","value":"{\"token\":\"request-secret\"}","type":"set"}"#,
            r#"{"type":"set","area":"sessionSecret","key":"session","value":"{\"token\":\"request-secret\"}","#,
        ] {
            assert!(serde_json::from_str::<PlatformStorageRequest>(request).is_err());
            assert_eq!(take_secret_drop_observations(), (1, 0));
        }

        for response in [
            r#"{"unexpected":true,"type":"value","value":"{\"token\":\"response-secret\"}"}"#,
            r#"{"type":7,"value":"{\"token\":\"response-secret\"}"}"#,
            r#"{"type":"value","value":"{\"token\":\"response-secret\"}","type":"value"}"#,
            r#"{"type":"value","value":"{\"token\":\"response-secret\"}","#,
        ] {
            assert!(serde_json::from_str::<PlatformStorageResponse>(response).is_err());
            assert_eq!(take_secret_drop_observations(), (1, 0));
        }
    }

    #[test]
    fn guarded_deletion_wire_is_closed_and_expected_bytes_are_zeroizing() {
        let encoded = r#"{"type":"deleteIfUnchanged","area":"deviceSecret","key":"owned","expectedValue":"{\"token\":\"original\"}"}"#;
        let request: PlatformStorageRequest = serde_json::from_str(encoded).unwrap();
        assert_eq!(serde_json::to_string(&request).unwrap(), encoded);
        drop(request);
        let _ = take_secret_drop_observations();
        for malformed in [
            encoded.replace("\"deviceSecret\"", "7"),
            encoded.replace("\"key\":\"owned\"", "\"unexpected\":true"),
            encoded.replace("\"type\":\"deleteIfUnchanged\"", "\"type\":\"delete\""),
            encoded.replace(
                "\"key\":\"owned\"",
                "\"key\":\"owned\",\"value\":\"another\"",
            ),
        ] {
            assert!(serde_json::from_str::<PlatformStorageRequest>(&malformed).is_err());
            assert!(take_secret_drop_observations().0 >= 1);
        }
        for malformed in [
            r#"{"type":"deleteIfUnchanged","area":"deviceSecret","key":"owned"}"#,
            r#"{"type":"deleteIfUnchanged","area":"deviceSecret","key":"owned","expectedValue":null}"#,
            r#"{"type":"deleteIfUnchanged","area":"deviceSecret","key":"owned","expectedValue":"a","expectedValue":"b"}"#,
        ] {
            assert!(serde_json::from_str::<PlatformStorageRequest>(malformed).is_err());
        }
        for result in ["deleted", "alreadyAbsent", "conflict"] {
            let encoded = format!(r#"{{"type":"deleteResult","result":"{result}"}}"#);
            let decoded: PlatformStorageResponse = serde_json::from_str(&encoded).unwrap();
            assert_eq!(serde_json::to_string(&decoded).unwrap(), encoded);
        }
        for malformed in [
            r#"{"type":"deleteResult"}"#,
            r#"{"type":"deleteResult","result":null}"#,
            r#"{"type":"deleteResult","result":"unknown"}"#,
            r#"{"type":"deleteResult","result":"deleted","result":"conflict"}"#,
            r#"{"type":"deleteResult","result":"deleted","value":null}"#,
            r#"{"type":"done","result":"deleted"}"#,
        ] {
            assert!(serde_json::from_str::<PlatformStorageResponse>(malformed).is_err());
        }
    }

    #[test]
    fn decoded_secret_fields_zeroize_when_a_later_required_field_is_missing() {
        let _ = take_secret_drop_observations();
        assert!(serde_json::from_str::<QuickUnlockDocument>(
            r#"{"version":1,"accountId":"account","incarnation":"generation","encryptedMasterUnlockKey":{"ciphertext":"ciphertext","iv":"iv","algorithm":"AES-GCM-AAD-V1"},"secretKey":"A3-ABCDEF-GHIJKL-MNOPQ-RSTUV-WXYZ2"}"#,
        )
        .is_err());
        assert_eq!(take_secret_drop_observations(), (1, 0));

        assert!(serde_json::from_str::<CurrentSessionDocument>(
            r#"{"version":1,"accountId":"account","incarnation":"generation","token":"session-token"}"#,
        )
        .is_err());
        assert_eq!(take_secret_drop_observations(), (1, 0));
    }

    #[tokio::test]
    async fn secret_wire_buffers_are_owned_by_zeroizing_types_on_every_error_path() {
        for behavior in [
            FailingWireBehavior::ExecutorError,
            FailingWireBehavior::MalformedResponse,
            FailingWireBehavior::InvalidDocument,
        ] {
            let executor = Arc::new(FailingWireExecutor {
                behavior,
                saw_secret: Mutex::new(false),
            });
            let storage = PlatformStorage::new(executor.clone());
            let result = match executor.behavior {
                FailingWireBehavior::ExecutorError => storage
                    .store_current_session(&current_session_document())
                    .await
                    .map(|_| None),
                FailingWireBehavior::MalformedResponse | FailingWireBehavior::InvalidDocument => {
                    storage
                        .load_current_session(&account("account"), &incarnation("generation"))
                        .await
                }
            };

            assert!(result.is_err());
            if matches!(executor.behavior, FailingWireBehavior::ExecutorError) {
                assert!(*executor
                    .saw_secret
                    .lock()
                    .expect("wire observation poisoned"));
            }
        }
    }

    #[test]
    fn sensitive_document_json_shapes_are_unchanged_across_roundtrips() {
        let device_key = serde_json::json!({
            "version": 1,
            "keyBytes": vec![7; 32],
        });
        let quick_unlock = serde_json::json!({
            "version": 1,
            "accountId": "account",
            "incarnation": "generation",
            "encryptedMasterUnlockKey": {
                "ciphertext": "ciphertext",
                "iv": "iv",
                "algorithm": "AES-GCM-AAD-V1",
            },
            "secretKey": "A3-ABCDEF-GHIJKL-MNOPQ-RSTUV-WXYZ2",
            "createdAtMs": 10,
            "lastMasterPasswordEntryMs": null,
            "biometricEnabled": false,
        });
        let current_session = serde_json::json!({
            "version": 1,
            "accountId": "account",
            "incarnation": "generation",
            "token": "session-token",
            "sessionId": "session-id",
            "expiresAtMs": 1_000,
            "serverExpiresAtMs": 2_000,
            "vaultKeys": [{
                "encryptedVaultKey": "encrypted-vault-key",
                "role": "owner",
                "vaultIcon": "key",
                "vaultId": "vault",
                "vaultImageUrl": null,
                "vaultName": "Personal",
                "vaultType": "personal",
            }],
            "encryptedPrivateKey": "encrypted-private-key",
        });

        let decoded_device_key: DeviceKeyDocument =
            serde_json::from_value(device_key.clone()).expect("Device key shape must decode");
        let decoded_quick_unlock: QuickUnlockDocument =
            serde_json::from_value(quick_unlock.clone()).expect("Quick-unlock shape must decode");
        let decoded_current_session: CurrentSessionDocument =
            serde_json::from_value(current_session.clone()).expect("Session shape must decode");

        assert_eq!(
            serde_json::to_value(&decoded_device_key).expect("Device key must encode"),
            device_key
        );
        assert_eq!(
            serde_json::to_value(&decoded_quick_unlock).expect("Quick-unlock must encode"),
            quick_unlock
        );
        assert_eq!(
            serde_json::to_value(&decoded_current_session).expect("Session must encode"),
            current_session
        );
    }

    #[test]
    fn classification_is_complete_and_keeps_forbidden_authentication_inputs_unrepresentable() {
        let values = [
            (
                PlatformStorageValue::DeviceCatalog,
                PlatformStorageArea::DevicePlain,
            ),
            (
                PlatformStorageValue::AccountMetadata(
                    account("account"),
                    incarnation("generation"),
                ),
                PlatformStorageArea::DevicePlain,
            ),
            (
                PlatformStorageValue::DeviceKey,
                PlatformStorageArea::DeviceSecret,
            ),
            (
                PlatformStorageValue::AccountQuickUnlock(
                    account("account"),
                    incarnation("generation"),
                ),
                PlatformStorageArea::DeviceSecret,
            ),
            (
                PlatformStorageValue::CurrentSessionCredentials(
                    account("account"),
                    incarnation("generation"),
                ),
                PlatformStorageArea::SessionSecret,
            ),
            (
                PlatformStorageValue::LegacySessionEvidence(
                    account("account"),
                    incarnation("generation"),
                ),
                PlatformStorageArea::SessionSecret,
            ),
        ];

        assert_eq!(values.len(), 6);
        for (value, expected_area) in values {
            assert_eq!(value.area(false), expected_area);
        }

        let quick_unlock = quick_unlock_document();
        let fields = serde_json::to_value(quick_unlock).expect("document must serialize");
        assert!(fields.get("masterPassword").is_none());
        assert!(fields.get("rawMasterUnlockKey").is_none());
        assert!(fields.get("encryptedMasterUnlockKey").is_some());
    }

    #[test]
    fn typed_secret_material_uses_the_unchanged_crypto_validators() {
        let device_key = DeviceKeyDocument::new([7; 32]);
        let encoded = serde_json::to_value(&device_key).expect("Device key must serialize");
        assert_eq!(encoded["version"], DOCUMENT_VERSION);
        assert_eq!(
            encoded["keyBytes"]
                .as_array()
                .expect("Device key must be a byte array")
                .len(),
            32
        );
        assert!(
            serde_json::from_value::<DeviceKeyDocument>(serde_json::json!({
                "version": 1,
                "keyBytes": vec![7; 31]
            }))
            .is_err()
        );
        assert!(
            serde_json::from_value::<DeviceKeyDocument>(serde_json::json!({
                "version": 1,
                "keyBytes": "master-password-shaped-string"
            }))
            .is_err()
        );

        let invalid_secret_key = QuickUnlockDocument::new(
            account("account"),
            incarnation("generation"),
            bittery_crypto_core::EncryptedData {
                ciphertext: "ciphertext".into(),
                iv: "iv".into(),
                algorithm: "AES-GCM-AAD-V1".into(),
            },
            "not-a-Secret-Key".into(),
            10,
            None,
            false,
        );
        assert!(invalid_secret_key.is_err());

        let invalid_envelope = QuickUnlockDocument::new(
            account("account"),
            incarnation("generation"),
            bittery_crypto_core::EncryptedData {
                ciphertext: "ciphertext".into(),
                iv: "iv".into(),
                algorithm: "AES-GCM".into(),
            },
            "A3-ABCDEF-GHIJKL-MNOPQ-RSTUV-WXYZ2".into(),
            10,
            None,
            false,
        );
        assert!(invalid_envelope.is_err());

        let mut invalid_kdf = metadata("account", "generation");
        invalid_kdf.pinned_kdf_profile.iterations = 1;
        assert!(invalid_kdf.validate().is_err());
    }

    #[test]
    fn current_session_uses_the_canonical_generated_vault_key_shape() {
        let document = current_session_document();

        let encoded = serde_json::to_value(document).expect("Current Session must serialize");
        assert_eq!(encoded["vaultKeys"][0]["role"], "owner");
        assert_eq!(encoded["vaultKeys"][0]["vaultType"], "personal");
        assert_eq!(
            encoded["vaultKeys"][0]["encryptedVaultKey"],
            "encrypted-vault-key"
        );
    }

    #[test]
    fn retained_travel_receipt_is_required_nullable_without_changing_existing_values() {
        for receipt in [serde_json::Value::Null, serde_json::json!(300)] {
            let encoded = serde_json::json!({
                "enabled":false,"hiddenVaultIds":[],"serverEnabledAtMs":null,
                "serverUpdatedAtMs":null,"verifiedAtMs":receipt
            });
            let policy: VerifiedTravelModePolicy = serde_json::from_value(encoded.clone()).unwrap();
            policy.validate().unwrap();
            assert_eq!(serde_json::to_value(policy).unwrap(), encoded);
            let mut missing = encoded;
            missing.as_object_mut().unwrap().remove("verifiedAtMs");
            assert!(serde_json::from_value::<VerifiedTravelModePolicy>(missing).is_err());
        }
    }

    #[test]
    fn verified_travel_mode_policy_is_generation_bound_and_fail_closed() {
        let policy = VerifiedTravelModePolicy {
            enabled: true,
            hidden_vault_ids: vec!["vault-a".into(), "vault-b".into()],
            server_enabled_at_ms: Some(100),
            server_updated_at_ms: Some(200),
            verified_at_ms: Some(300),
        };
        let mut document = metadata("account", "generation");
        document.verified_travel_mode = Some(policy);
        document.validate().expect("verified policy must be valid");
        let encoded = serde_json::to_value(document).expect("metadata must serialize");
        assert_eq!(
            encoded["verifiedTravelMode"]["hiddenVaultIds"],
            serde_json::json!(["vault-a", "vault-b"])
        );
        assert_eq!(encoded["verifiedTravelMode"]["verifiedAtMs"], 300);

        for hidden_vault_ids in [vec!["".into()], vec!["vault-a".into(), "vault-a".into()]] {
            let mut invalid = metadata("account", "generation");
            invalid.verified_travel_mode = Some(VerifiedTravelModePolicy {
                enabled: true,
                hidden_vault_ids,
                server_enabled_at_ms: Some(100),
                server_updated_at_ms: None,
                verified_at_ms: Some(300),
            });
            assert!(invalid.validate().is_err());
        }
    }

    #[tokio::test]
    async fn retained_travel_policy_requires_consistent_activation_but_accepts_legacy_update_time()
    {
        for (enabled, enabled_at, accepted) in [
            (true, Some(100), true),
            (false, None, true),
            (true, None, false),
            (false, Some(100), false),
        ] {
            let mut document = metadata("account", "generation");
            document.verified_travel_mode = Some(VerifiedTravelModePolicy {
                enabled,
                hidden_vault_ids: vec!["vault-a".into()],
                server_enabled_at_ms: enabled_at,
                // Older valid documents need no fabricated Server update timestamp.
                server_updated_at_ms: None,
                verified_at_ms: Some(300),
            });
            let mut encoded = serde_json::to_value(&document).unwrap();
            if accepted {
                encoded["verifiedTravelMode"]
                    .as_object_mut()
                    .unwrap()
                    .remove("serverUpdatedAtMs");
            }
            let executor = Arc::new(RecordingExecutor::default());
            executor
                .responses
                .lock()
                .unwrap()
                .push(PlatformStorageResponse::Value {
                    value: Some(encoded.to_string().into()),
                });
            let storage = PlatformStorage::new(executor);
            let loaded = storage
                .load_account_metadata(&account("account"), &incarnation("generation"))
                .await;
            if accepted {
                assert_eq!(loaded.unwrap(), Some(document));
            } else {
                assert_eq!(
                    loaded
                        .expect_err("inconsistent retained Travel policy must fail closed")
                        .code,
                    RuntimeErrorCode::InvariantViolation,
                );
            }
        }
    }

    #[test]
    fn account_keys_are_stable_and_collision_safe() {
        let first =
            PlatformStorageValue::AccountMetadata(account("a:b"), incarnation("generation"));
        let second = PlatformStorageValue::AccountMetadata(account("a"), incarnation("generation"));
        let third =
            PlatformStorageValue::AccountQuickUnlock(account("a:b"), incarnation("generation"));
        let unicode =
            PlatformStorageValue::AccountMetadata(account("ä"), incarnation("generation"));
        let next_generation =
            PlatformStorageValue::AccountMetadata(account("a:b"), incarnation("generation:2"));

        assert_eq!(first.key().expect("key"), first.key().expect("key"));
        assert_ne!(first.key().expect("key"), second.key().expect("key"));
        assert_ne!(first.key().expect("key"), third.key().expect("key"));
        assert_ne!(second.key().expect("key"), unicode.key().expect("key"));
        assert_ne!(
            first.key().expect("key"),
            next_generation.key().expect("key")
        );
        assert!(first
            .key()
            .expect("key")
            .contains("account:3:a:b:incarnation:10:generation:metadata"));
    }

    #[test]
    fn catalog_represents_active_and_pending_install_generations() {
        let catalog = DeviceCatalogDocument::new(vec![DeviceCatalogAccount {
            account_id: account("account"),
            active_incarnation: Some(incarnation("old-generation")),
            pending_retirement: None,
            pending_install: Some(PendingAccountInstallIntent {
                incarnation: incarnation("new-generation"),
                expected_active_incarnation: Some(incarnation("old-generation")),
            }),
        }])
        .expect("catalog staging state must be valid");

        let encoded = serde_json::to_value(catalog).expect("catalog must serialize");
        assert!(
            encoded["accounts"][0].get("pendingRetirement").is_none(),
            "old catalog documents retain their exact field set"
        );
        assert_eq!(
            encoded["accounts"][0]["activeIncarnation"],
            "old-generation"
        );
        assert_eq!(
            encoded["accounts"][0]["pendingInstall"]["incarnation"],
            "new-generation"
        );
        assert_eq!(
            encoded["accounts"][0]["pendingInstall"]["expectedActiveIncarnation"],
            "old-generation"
        );

        assert!(DeviceCatalogDocument::new(vec![DeviceCatalogAccount {
            account_id: account("account"),
            active_incarnation: Some(incarnation("old-generation")),
            pending_retirement: None,
            pending_install: Some(PendingAccountInstallIntent {
                incarnation: incarnation("new-generation"),
                expected_active_incarnation: Some(incarnation("another-generation")),
            }),
        }])
        .is_err());
        assert!(DeviceCatalogDocument::new(vec![DeviceCatalogAccount {
            account_id: account("account"),
            active_incarnation: Some(incarnation("same-generation")),
            pending_retirement: None,
            pending_install: Some(PendingAccountInstallIntent {
                incarnation: incarnation("same-generation"),
                expected_active_incarnation: Some(incarnation("same-generation")),
            }),
        }])
        .is_err());
    }

    #[test]
    fn catalog_retirement_requires_its_exact_active_incarnation_and_closed_purpose() {
        let mut entry = DeviceCatalogAccount {
            account_id: account("account"),
            active_incarnation: Some(incarnation("active")),
            pending_install: None,
            pending_retirement: Some(PendingAccountRetirementIntent {
                incarnation: incarnation("active"),
                purpose: AccountRetirementPurpose::Remove,
            }),
        };
        for purpose in [
            AccountRetirementPurpose::Remove,
            AccountRetirementPurpose::Replace,
        ] {
            entry.pending_retirement.as_mut().unwrap().purpose = purpose;
            let catalog = DeviceCatalogDocument::new(vec![entry.clone()]).unwrap();
            let encoded = serde_json::to_value(&catalog).unwrap();
            assert_eq!(
                serde_json::from_value::<DeviceCatalogDocument>(encoded.clone()).unwrap(),
                catalog
            );
            let mut unknown = encoded;
            unknown["accounts"][0]["pendingRetirement"]["purpose"] = serde_json::json!("clearKeys");
            assert!(serde_json::from_value::<DeviceCatalogDocument>(unknown).is_err());
        }
        entry.pending_install = Some(PendingAccountInstallIntent {
            incarnation: incarnation("next"),
            expected_active_incarnation: entry.active_incarnation.clone(),
        });
        assert!(DeviceCatalogDocument::new(vec![entry.clone()]).is_err());
        entry.pending_install = None;
        for retired in ["", "different"] {
            entry.pending_retirement.as_mut().unwrap().incarnation = incarnation(retired);
            assert!(DeviceCatalogDocument::new(vec![entry.clone()]).is_err());
        }
    }

    #[tokio::test]
    async fn empty_account_ids_fail_before_any_host_invocation() {
        let executor = Arc::new(RecordingExecutor::default());
        let storage = PlatformStorage::new(executor.clone());

        let error = storage
            .load_account_metadata(&account(""), &incarnation("generation"))
            .await
            .expect_err("empty Account identity must fail");

        assert_eq!(error.code, RuntimeErrorCode::InvariantViolation);
        assert!(executor
            .requests
            .lock()
            .expect("requests lock poisoned")
            .is_empty());
        let error = storage
            .load_account_metadata(&account("account"), &incarnation(""))
            .await
            .expect_err("empty Account incarnation must fail");
        assert_eq!(error.code, RuntimeErrorCode::InvariantViolation);
        assert!(executor
            .requests
            .lock()
            .expect("requests lock poisoned")
            .is_empty());
        assert!(DeviceCatalogDocument::new(vec![DeviceCatalogAccount {
            account_id: account(""),
            active_incarnation: Some(incarnation("generation")),
            pending_retirement: None,
            pending_install: None,
        }])
        .is_err());
    }

    #[tokio::test]
    async fn typed_documents_round_trip_through_only_primitive_host_requests() {
        let executor = Arc::new(RecordingExecutor::default());
        let expected = metadata("account", "generation");
        executor
            .responses
            .lock()
            .expect("responses lock poisoned")
            .extend([
                PlatformStorageResponse::Done,
                PlatformStorageResponse::Value {
                    value: Some(
                        serde_json::to_string(&expected)
                            .expect("metadata must serialize")
                            .into(),
                    ),
                },
                PlatformStorageResponse::Done,
            ]);
        let storage = PlatformStorage::new(executor.clone());

        storage
            .store_account_metadata(&expected)
            .await
            .expect("store must succeed");
        assert_eq!(
            storage
                .load_account_metadata(&account("account"), &incarnation("generation"))
                .await
                .expect("load must succeed"),
            Some(expected.clone())
        );
        storage
            .remove_current_session(&account("account"), &incarnation("generation"))
            .await
            .expect("delete must succeed");

        let requests = executor.requests.lock().expect("requests lock poisoned");
        assert!(matches!(requests[0], PlatformStorageRequest::Set { .. }));
        assert!(matches!(requests[1], PlatformStorageRequest::Get { .. }));
        assert!(matches!(requests[2], PlatformStorageRequest::Delete { .. }));
    }

    #[tokio::test]
    async fn account_and_device_deletion_use_only_rust_owned_length_delimited_prefixes() {
        let executor = Arc::new(RecordingExecutor::default());
        executor
            .responses
            .lock()
            .expect("responses lock poisoned")
            .extend(std::iter::repeat_n(PlatformStorageResponse::Done, 6));
        let storage = PlatformStorage::new(executor.clone());

        storage
            .delete_account_namespace(&account("a:b"))
            .await
            .expect("Account namespace deletion must succeed");
        storage
            .wipe_runtime_namespace()
            .await
            .expect("Runtime namespace wipe must succeed");

        let requests = executor.requests.lock().expect("requests lock poisoned");
        let areas = [
            PlatformStorageArea::DevicePlain,
            PlatformStorageArea::DeviceSecret,
            PlatformStorageArea::SessionSecret,
        ];
        for (request, expected_area) in requests[..3].iter().zip(areas) {
            let PlatformStorageRequest::DeletePrefix {
                area,
                prefix,
                preserve_key,
            } = request
            else {
                panic!("expected Account prefix deletion");
            };
            assert_eq!(*area, expected_area);
            assert!(preserve_key.is_none());
            assert_eq!(prefix, "bittery:runtime:platform-storage:account:3:a:b:");
        }
        for (request, expected_area) in requests[3..].iter().zip(areas) {
            let PlatformStorageRequest::DeletePrefix {
                area,
                prefix,
                preserve_key,
            } = request
            else {
                panic!("expected Device prefix deletion");
            };
            assert_eq!(*area, expected_area);
            assert!(preserve_key.is_none());
            assert_eq!(prefix, "bittery:runtime:platform-storage:");
        }
    }

    #[tokio::test]
    async fn account_and_device_prefix_deletion_retry_partial_area_failure_without_collisions() {
        let target = account("a");
        let collision = account("a:");
        let unicode = account("ä");
        let unicode_collision = account("ä:");
        let target_incarnation = incarnation("first");
        let second_incarnation = incarnation("second");
        let collision_incarnation = incarnation("collision");
        let target_metadata =
            PlatformStorageValue::AccountMetadata(target.clone(), target_incarnation.clone())
                .key()
                .unwrap();
        let target_second_metadata =
            PlatformStorageValue::AccountMetadata(target.clone(), second_incarnation.clone())
                .key()
                .unwrap();
        let target_quick_unlock =
            PlatformStorageValue::AccountQuickUnlock(target.clone(), target_incarnation.clone())
                .key()
                .unwrap();
        let target_session = PlatformStorageValue::CurrentSessionCredentials(
            target.clone(),
            target_incarnation.clone(),
        )
        .key()
        .unwrap();
        let collision_metadata =
            PlatformStorageValue::AccountMetadata(collision, collision_incarnation)
                .key()
                .unwrap();
        let unicode_metadata =
            PlatformStorageValue::AccountMetadata(unicode.clone(), incarnation("unicode"))
                .key()
                .unwrap();
        let unicode_collision_metadata = PlatformStorageValue::AccountMetadata(
            unicode_collision,
            incarnation("unicode-collision"),
        )
        .key()
        .unwrap();
        assert_eq!(
            account_prefix(&unicode).unwrap(),
            "bittery:runtime:platform-storage:account:2:ä:"
        );
        let executor = Arc::new(PrefixStorageExecutor::new(vec![
            (
                PlatformStorageArea::DevicePlain,
                target_metadata.clone(),
                "target-metadata".into(),
            ),
            (
                PlatformStorageArea::DevicePlain,
                target_second_metadata.clone(),
                "target-second-metadata".into(),
            ),
            (
                PlatformStorageArea::DeviceSecret,
                target_quick_unlock.clone(),
                "target-quick-unlock".into(),
            ),
            (
                PlatformStorageArea::SessionSecret,
                target_session.clone(),
                "target-session".into(),
            ),
            (
                PlatformStorageArea::DevicePlain,
                collision_metadata.clone(),
                "collision".into(),
            ),
            (
                PlatformStorageArea::DevicePlain,
                unicode_metadata.clone(),
                "unicode".into(),
            ),
            (
                PlatformStorageArea::DevicePlain,
                unicode_collision_metadata.clone(),
                "unicode-collision".into(),
            ),
            (
                PlatformStorageArea::DevicePlain,
                "unrelated-host-key".into(),
                "unrelated".into(),
            ),
        ]));
        let storage = PlatformStorage::new(executor.clone());
        executor.fail_once_in(PlatformStorageArea::DeviceSecret);

        let error = storage
            .delete_account_namespace(&target)
            .await
            .expect_err("the injected second-area failure must surface");
        assert_eq!(error.code, RuntimeErrorCode::InvariantViolation);
        assert_eq!(error.message, "platform storage primitive failed");
        let after_failure = executor.keys();
        assert!(!after_failure.iter().any(|(_, key)| key == &target_metadata));
        assert!(!after_failure
            .iter()
            .any(|(_, key)| key == &target_second_metadata));
        assert!(after_failure
            .iter()
            .any(|(_, key)| key == &target_quick_unlock));
        assert!(after_failure.iter().any(|(_, key)| key == &target_session));

        storage
            .delete_account_namespace(&target)
            .await
            .expect("retry must converge");
        storage
            .delete_account_namespace(&target)
            .await
            .expect("repeated deletion must remain idempotent");
        let after_retry = executor.keys();
        assert!(!after_retry.iter().any(|(_, key)| {
            key == &target_metadata
                || key == &target_second_metadata
                || key == &target_quick_unlock
                || key == &target_session
        }));
        assert!(after_retry
            .iter()
            .any(|(_, key)| key == &collision_metadata));
        assert!(after_retry.iter().any(|(_, key)| key == &unicode_metadata));
        assert!(after_retry
            .iter()
            .any(|(_, key)| key == &unicode_collision_metadata));
        assert!(after_retry
            .iter()
            .any(|(_, key)| key == "unrelated-host-key"));

        storage
            .delete_account_namespace(&unicode)
            .await
            .expect("Unicode Account deletion must succeed");
        let after_unicode = executor.keys();
        assert!(!after_unicode
            .iter()
            .any(|(_, key)| key == &unicode_metadata));
        assert!(after_unicode
            .iter()
            .any(|(_, key)| key == &unicode_collision_metadata));

        executor
            .values
            .lock()
            .expect("values lock poisoned")
            .extend([
                (
                    PlatformStorageArea::DevicePlain,
                    PlatformStorageValue::DeviceCatalog.key().unwrap(),
                    "catalog".into(),
                ),
                (
                    PlatformStorageArea::DeviceSecret,
                    PlatformStorageValue::DeviceKey.key().unwrap(),
                    "device-key".into(),
                ),
                (
                    PlatformStorageArea::SessionSecret,
                    format!("{}orphan", runtime_namespace_prefix()),
                    "orphan".into(),
                ),
            ]);
        executor.fail_once_in(PlatformStorageArea::SessionSecret);
        storage
            .wipe_runtime_namespace()
            .await
            .expect_err("the injected final-area failure must surface");
        storage
            .wipe_runtime_namespace()
            .await
            .expect("Device wipe retry must converge");
        storage
            .wipe_runtime_namespace()
            .await
            .expect("repeated Device wipe must remain idempotent");
        assert_eq!(
            executor.keys(),
            vec![(
                PlatformStorageArea::DevicePlain,
                "unrelated-host-key".into()
            )]
        );
    }

    #[tokio::test]
    async fn load_rejects_unknown_fields_versions_and_cross_account_documents() {
        for invalid in [
            {
                let mut value = serde_json::to_value(metadata("account", "generation"))
                    .expect("metadata must serialize");
                value["unexpected"] = serde_json::json!(true);
                value
            },
            {
                let mut value = serde_json::to_value(metadata("account", "generation"))
                    .expect("metadata must serialize");
                value["version"] = serde_json::json!(2);
                value
            },
            serde_json::to_value(metadata("another-account", "generation"))
                .expect("metadata must serialize"),
            serde_json::to_value(metadata("account", "another-generation"))
                .expect("metadata must serialize"),
        ] {
            let executor = Arc::new(RecordingExecutor::default());
            executor
                .responses
                .lock()
                .expect("responses lock poisoned")
                .push(PlatformStorageResponse::Value {
                    value: Some(invalid.to_string().into()),
                });
            let storage = PlatformStorage::new(executor);

            let error = storage
                .load_account_metadata(&account("account"), &incarnation("generation"))
                .await
                .expect_err("invalid document must fail closed");
            assert_eq!(error.code, RuntimeErrorCode::InvariantViolation);
        }
    }

    #[test]
    fn wire_contract_rejects_unknown_or_missing_fields() {
        assert!(serde_json::from_str::<PlatformStorageRequest>(
            r#"{"type":"deletePrefix","area":"deviceSecret","prefix":"runtime:"}"#
        )
        .is_ok());
        assert!(serde_json::from_str::<PlatformStorageRequest>(
            r#"{"type":"get","area":"devicePlain","key":"opaque","extra":true}"#
        )
        .is_err());
        assert!(serde_json::from_str::<PlatformStorageRequest>(
            r#"{"type":"get","area":"memory","key":"opaque"}"#
        )
        .is_err());
        for invalid in [
            r#"{"type":"deletePrefix","area":"devicePlain"}"#,
            r#"{"type":"deletePrefix","area":"devicePlain","prefix":""}"#,
            r#"{"type":"deletePrefix","area":"devicePlain","prefix":"runtime:","key":"opaque"}"#,
            r#"{"type":"deletePrefix","area":"devicePlain","prefix":"runtime:","value":"secret"}"#,
        ] {
            assert!(serde_json::from_str::<PlatformStorageRequest>(invalid).is_err());
        }
        assert!(serde_json::from_str::<PlatformStorageResponse>(r#"{"type":"value"}"#).is_err());
    }
}
