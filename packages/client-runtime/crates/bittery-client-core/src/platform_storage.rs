use crate::{protocol::Incarnation, AccountId, RuntimeError, RuntimeErrorCode};
use async_trait::async_trait;
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use std::{collections::HashSet, sync::Arc};
use zeroize::{Zeroize, ZeroizeOnDrop, Zeroizing};

const KEY_PREFIX: &str = "bittery:runtime:platform-storage";
const DOCUMENT_VERSION: u32 = 1;

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

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(
    feature = "platform-storage-contract-schema",
    derive(schemars::JsonSchema)
)]
#[serde(rename_all = "camelCase")]
enum PlatformStorageArea {
    DevicePlain,
    DeviceSecret,
    SessionSecret,
}

#[derive(Clone, Debug, PartialEq, Eq)]
enum PlatformStorageValue {
    DeviceCatalog,
    AccountMetadata(AccountId, Incarnation),
    DeviceKey,
    AccountQuickUnlock(AccountId, Incarnation),
    CurrentSessionCredentials(AccountId, Incarnation),
}

impl PlatformStorageValue {
    fn area(&self) -> PlatformStorageArea {
        match self {
            Self::DeviceCatalog | Self::AccountMetadata(..) => PlatformStorageArea::DevicePlain,
            Self::DeviceKey | Self::AccountQuickUnlock(..) => PlatformStorageArea::DeviceSecret,
            Self::CurrentSessionCredentials(..) => PlatformStorageArea::SessionSecret,
        }
    }

    fn key(&self) -> Result<String, RuntimeError> {
        match self {
            Self::DeviceCatalog => Ok(format!("{KEY_PREFIX}:device-catalog")),
            Self::DeviceKey => Ok(format!("{KEY_PREFIX}:device-key")),
            Self::AccountMetadata(account_id, incarnation) => {
                account_key(account_id, incarnation, "metadata")
            }
            Self::AccountQuickUnlock(account_id, incarnation) => {
                account_key(account_id, incarnation, "quick-unlock")
            }
            Self::CurrentSessionCredentials(account_id, incarnation) => {
                account_key(account_id, incarnation, "current-session")
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
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct PendingAccountInstallIntent {
    pub(crate) incarnation: Incarnation,
    #[serde(deserialize_with = "required_option::deserialize")]
    pub(crate) expected_active_incarnation: Option<Incarnation>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct DeviceCatalogAccount {
    pub(crate) account_id: AccountId,
    #[serde(deserialize_with = "required_option::deserialize")]
    pub(crate) active_incarnation: Option<Incarnation>,
    #[serde(deserialize_with = "required_option::deserialize")]
    pub(crate) pending_install: Option<PendingAccountInstallIntent>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct DeviceCatalogDocument {
    version: u32,
    pub(crate) accounts: Vec<DeviceCatalogAccount>,
}

impl DeviceCatalogDocument {
    pub(crate) fn new(accounts: Vec<DeviceCatalogAccount>) -> Result<Self, RuntimeError> {
        let document = Self {
            version: DOCUMENT_VERSION,
            accounts,
        };
        document.validate()?;
        Ok(document)
    }

    fn validate(&self) -> Result<(), RuntimeError> {
        require_version(self.version, "Device catalog")?;
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

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct VerifiedTravelModePolicy {
    pub(crate) enabled: bool,
    pub(crate) hidden_vault_ids: Vec<String>,
    pub(crate) server_enabled_at_ms: Option<u64>,
    pub(crate) server_updated_at_ms: Option<u64>,
    pub(crate) verified_at_ms: u64,
}

impl VerifiedTravelModePolicy {
    fn validate(&self) -> Result<(), RuntimeError> {
        let mut vault_ids = HashSet::new();
        for vault_id in &self.hidden_vault_ids {
            require_non_empty(vault_id, "verified Travel Mode hidden Vault identity")?;
            if !vault_ids.insert(vault_id.as_str()) {
                return Err(platform_storage_invariant(
                    "verified Travel Mode policy contains a duplicate hidden Vault identity",
                ));
            }
        }
        Ok(())
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
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
    pub(crate) biometric_enabled: bool,
    pub(crate) insecure_transport_confirmed: bool,
    pub(crate) pinned_kdf_profile: bittery_crypto_core::KdfProfile,
    pub(crate) verified_travel_mode: Option<VerifiedTravelModePolicy>,
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
            biometric_enabled,
            insecure_transport_confirmed,
            pinned_kdf_profile,
            verified_travel_mode,
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
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct DeviceKeyDocument {
    #[zeroize(skip)]
    version: u32,
    pub(crate) key_bytes: [u8; 32],
}

impl DeviceKeyDocument {
    pub(crate) fn new(key_bytes: [u8; 32]) -> Self {
        Self {
            version: DOCUMENT_VERSION,
            key_bytes,
        }
    }

    fn validate(&self) -> Result<(), RuntimeError> {
        require_version(self.version, "Device key")
    }
}

#[derive(Clone, Serialize, Deserialize, Zeroize, ZeroizeOnDrop)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct QuickUnlockDocument {
    #[zeroize(skip)]
    version: u32,
    #[zeroize(skip)]
    pub(crate) account_id: AccountId,
    #[zeroize(skip)]
    pub(crate) incarnation: Incarnation,
    #[zeroize(skip)]
    pub(crate) encrypted_master_unlock_key: bittery_crypto_core::EncryptedData,
    pub(crate) secret_key: String,
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
            secret_key,
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
}

#[derive(Clone, PartialEq, Serialize, Deserialize, Zeroize, ZeroizeOnDrop)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct CurrentSessionDocument {
    #[zeroize(skip)]
    version: u32,
    #[zeroize(skip)]
    pub(crate) account_id: AccountId,
    #[zeroize(skip)]
    pub(crate) incarnation: Incarnation,
    pub(crate) token: String,
    #[zeroize(skip)]
    pub(crate) session_id: Option<String>,
    #[zeroize(skip)]
    pub(crate) expires_at_ms: u64,
    #[zeroize(skip)]
    pub(crate) server_expires_at_ms: Option<u64>,
    #[zeroize(skip)]
    pub(crate) vault_keys: Vec<crate::server_contract::AuthVaultKeyResponse>,
    #[zeroize(skip)]
    pub(crate) encrypted_private_key: String,
}

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
            version: DOCUMENT_VERSION,
            account_id,
            incarnation,
            token,
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

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize, Zeroize, ZeroizeOnDrop)]
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
enum PlatformStorageRequest {
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
        value: String,
    },
    Delete {
        #[zeroize(skip)]
        area: PlatformStorageArea,
        #[zeroize(skip)]
        key: String,
    },
}

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize, Zeroize, ZeroizeOnDrop)]
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
enum PlatformStorageResponse {
    Value {
        #[serde(deserialize_with = "required_option::deserialize")]
        value: Option<String>,
    },
    #[zeroize(skip)]
    Done,
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
pub(crate) struct PlatformStorage {
    executor: Arc<dyn SerializedPlatformStorageExecutor>,
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
    pub(crate) fn new(executor: Arc<dyn SerializedPlatformStorageExecutor>) -> Self {
        Self { executor }
    }

    pub(crate) fn unavailable() -> Self {
        Self::new(Arc::new(UnavailablePlatformStorageExecutor))
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
        self.load_document(
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
        .await
    }

    pub(crate) async fn store_current_session(
        &self,
        document: &CurrentSessionDocument,
    ) -> Result<(), RuntimeError> {
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
        let document: T = serde_json::from_str(&serialized)
            .map_err(|_| platform_storage_invariant("platform storage document is invalid"))?;
        validate(&document)?;
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
        let area = target.area();
        let key = target.key()?;
        let serialized = serialize_sensitive_json(
            document,
            "platform storage document could not be serialized",
        )?;
        self.expect_done(PlatformStorageRequest::Set {
            area,
            key,
            value: serialized,
        })
        .await
    }

    async fn get(
        &self,
        target: PlatformStorageValue,
    ) -> Result<Option<Zeroizing<String>>, RuntimeError> {
        let mut response = self
            .invoke(PlatformStorageRequest::Get {
                area: target.area(),
                key: target.key()?,
            })
            .await?;
        match &mut response {
            PlatformStorageResponse::Value { value } => Ok(value.take().map(Zeroizing::new)),
            PlatformStorageResponse::Done => Err(platform_storage_invariant(
                "platform storage returned Done for Get",
            )),
        }
    }

    async fn delete(&self, target: PlatformStorageValue) -> Result<(), RuntimeError> {
        self.expect_done(PlatformStorageRequest::Delete {
            area: target.area(),
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
        }
    }

    async fn invoke(
        &self,
        request: PlatformStorageRequest,
    ) -> Result<PlatformStorageResponse, RuntimeError> {
        let request_json = Zeroizing::new(serialize_sensitive_json(
            &request,
            "platform storage request could not be serialized",
        )?);
        let response_json = self.executor.invoke(request_json).await?;
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

    fn account(value: &str) -> AccountId {
        AccountId::from(value)
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

    #[test]
    fn sensitive_documents_zeroize_only_their_plaintext_secrets() {
        fn assert_zeroize_on_drop<T: ZeroizeOnDrop>() {}

        assert_zeroize_on_drop::<DeviceKeyDocument>();
        assert_zeroize_on_drop::<QuickUnlockDocument>();
        assert_zeroize_on_drop::<CurrentSessionDocument>();
        assert_zeroize_on_drop::<PlatformStorageRequest>();
        assert_zeroize_on_drop::<PlatformStorageResponse>();

        let mut device_key = DeviceKeyDocument::new([7; 32]).clone();
        device_key.zeroize();
        assert_eq!(device_key.key_bytes, [0; 32]);

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
        ];

        assert_eq!(values.len(), 5);
        for (value, expected_area) in values {
            assert_eq!(value.area(), expected_area);
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
    fn verified_travel_mode_policy_is_generation_bound_and_fail_closed() {
        let policy = VerifiedTravelModePolicy {
            enabled: true,
            hidden_vault_ids: vec!["vault-a".into(), "vault-b".into()],
            server_enabled_at_ms: Some(100),
            server_updated_at_ms: Some(200),
            verified_at_ms: 300,
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
                server_enabled_at_ms: None,
                server_updated_at_ms: None,
                verified_at_ms: 300,
            });
            assert!(invalid.validate().is_err());
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
            pending_install: Some(PendingAccountInstallIntent {
                incarnation: incarnation("new-generation"),
                expected_active_incarnation: Some(incarnation("old-generation")),
            }),
        }])
        .expect("catalog staging state must be valid");

        let encoded = serde_json::to_value(catalog).expect("catalog must serialize");
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
            pending_install: Some(PendingAccountInstallIntent {
                incarnation: incarnation("new-generation"),
                expected_active_incarnation: Some(incarnation("another-generation")),
            }),
        }])
        .is_err());
        assert!(DeviceCatalogDocument::new(vec![DeviceCatalogAccount {
            account_id: account("account"),
            active_incarnation: Some(incarnation("same-generation")),
            pending_install: Some(PendingAccountInstallIntent {
                incarnation: incarnation("same-generation"),
                expected_active_incarnation: Some(incarnation("same-generation")),
            }),
        }])
        .is_err());
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
                    value: Some(serde_json::to_string(&expected).expect("metadata must serialize")),
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
                    value: Some(invalid.to_string()),
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
            r#"{"type":"get","area":"devicePlain","key":"opaque","extra":true}"#
        )
        .is_err());
        assert!(serde_json::from_str::<PlatformStorageRequest>(
            r#"{"type":"get","area":"memory","key":"opaque"}"#
        )
        .is_err());
        assert!(serde_json::from_str::<PlatformStorageResponse>(r#"{"type":"value"}"#).is_err());
    }
}
