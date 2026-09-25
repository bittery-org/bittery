use super::{invalid, Object};
use crate::{
    protocol::Incarnation,
    replica::{
        legacy_sync_source_id, validate_authority_page, AuthorityAttachmentRecord,
        AuthorityItemRecord, AuthorityVaultRecord, AuthorityVaultRole, AuthorityVaultType,
        LegacyAdmissionBootstrap, LegacyAdmissionOrigin, LegacyAdmissionRefreshReason,
        LegacyCheckpointEvidence, LegacyCreateFailureCode, LegacyItemCacheBaseline,
        LegacyItemCacheMetadata, LegacyOperationDisposition, OperationRecord, ReplicaItemRecord,
        SyncCursor,
    },
    server_contract::{
        AuthVaultKeyResponse, ItemCategory, VaultAttachmentResponse, VaultRole, VaultType,
    },
    AccountId, RuntimeError, SecretString,
};
use serde::{Deserialize, Deserializer};
use std::collections::{BTreeMap, HashMap, HashSet};

const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

pub(super) struct AccountIdentity<'a> {
    pub account_id: &'a str,
    pub user_id: &'a str,
    pub email: &'a str,
    pub normalized_server_url: &'a str,
    pub insecure_transport_confirmed: bool,
}

pub(super) struct DecodedCache {
    account_id: AccountId,
    user_id: String,
    normalized_server_url: String,
    source_active_generation: Option<String>,
    state_key: String,
    items_key_prefix: String,
    vaults_key_prefix: String,
    items_primed: bool,
    vaults_primed: bool,
    metadata: Option<LegacyItemCacheMetadata>,
    source_id: String,
    sync_baseline: LegacyCheckpointEvidence,
    last_sync_cursor: LegacyCheckpointEvidence,
    vaults: Vec<CachedVault>,
    items: Vec<CachedItem>,
}

pub(in crate::runtime::profile_admission) struct CapturedCreateFailure {
    item: AuthorityItemRecord,
    operation_id: String,
    code: LegacyCreateFailureCode,
}

impl CapturedCreateFailure {
    pub(in crate::runtime::profile_admission) fn operation_id(&self) -> &str {
        &self.operation_id
    }

    pub(in crate::runtime::profile_admission) fn bind(
        &self,
        operation: &mut OperationRecord,
    ) -> Result<ReplicaItemRecord, RuntimeError> {
        let evidence = operation
            .legacy_admission
            .as_mut()
            .ok_or_else(|| invalid("Failed cached Item has no legacy command"))?;
        if operation.operation_id != self.operation_id
            || evidence.disposition != LegacyOperationDisposition::LegacyFailed
        {
            return Err(invalid("Failed cached Item does not match a failed Create"));
        }
        evidence.captured_failure_code = Some(self.code);
        let evidence = operation
            .legacy_admission
            .as_ref()
            .expect("checked evidence");
        let overlay = evidence.create_overlay(operation)?;
        // Date.toISOString() always emits milliseconds; Core's canonical RFC3339 may omit them.
        // Require the exact producer spelling before mapping into the canonical overlay.
        let seconds = overlay
            .created_at
            .trim_end_matches('Z')
            .split('.')
            .next()
            .expect("canonical timestamp");
        let source_timestamp =
            format!("{seconds}.{:03}Z", evidence.source_command.timestamp % 1000);
        let expected = AuthorityItemRecord {
            id: overlay.item_id.clone(),
            vault_id: overlay.vault_id.clone(),
            category: overlay.category.clone(),
            favorite: overlay.favorite,
            encrypted_data: overlay.encrypted_data.clone(),
            encryption_iv: overlay.encryption_iv.clone(),
            encryption_algorithm: overlay.encryption_algorithm.clone(),
            version: overlay.version,
            encryption_version: overlay.encryption_version,
            encrypted_by_user_id: overlay.encrypted_by_user_id.clone(),
            last_modified_by: overlay.encrypted_by_user_id.clone(),
            created_at: source_timestamp.clone(),
            updated_at: source_timestamp,
            deleted_at: overlay.deleted_at.clone(),
            attachments: overlay.attachments.clone(),
        };
        if self.item != expected {
            return Err(invalid(
                "Failed cached Item differs from its original Create projection",
            ));
        }
        evidence.validate(&overlay.account_id, operation, Some(&overlay))?;
        Ok(overlay)
    }
}

pub(super) struct BoundCache {
    pub(super) bootstrap: LegacyAdmissionBootstrap,
    pub(super) failures: Vec<CapturedCreateFailure>,
}

impl DecodedCache {
    pub(super) fn bind(
        self,
        incarnation: Incarnation,
        manifest_entries_sha256: String,
        vault_keys: Option<&[AuthVaultKeyResponse]>,
        hidden_vault_ids: &[String],
    ) -> Result<BoundCache, RuntimeError> {
        let mut items = Vec::new();
        let mut failures = Vec::new();
        for mut cached in self.items {
            let failure = cached.optimistic_failure.take();
            let item = cached.authority()?;
            validate_authority_page(&[], std::slice::from_ref(&item))?;
            if let Some(failure) = failure {
                if failure.operation_id.is_empty() {
                    return Err(invalid(
                        "Failed cached Item has an empty Operation identity",
                    ));
                }
                failures.push(CapturedCreateFailure {
                    item,
                    operation_id: failure.operation_id,
                    code: failure.code,
                });
            } else {
                items.push(item);
            }
        }
        validate_authority_page(&[], &items)?;
        let source_vault_ids = self
            .vaults
            .iter()
            .map(|vault| vault.id.as_str())
            .collect::<HashSet<_>>();
        if items
            .iter()
            .chain(failures.iter().map(|failure| &failure.item))
            .any(|item| !source_vault_ids.contains(item.vault_id.as_str()))
        {
            return Err(invalid(
                "Legacy Desktop cached Item references a missing Vault",
            ));
        }
        items.retain(|item| !hidden_vault_ids.contains(&item.vault_id));
        let keys = vault_keys.unwrap_or_default();
        let by_id = keys
            .iter()
            .map(|key| (key.vault_id.as_str(), key))
            .collect::<HashMap<_, _>>();
        if by_id.len() != keys.len() {
            return Err(invalid("Legacy Desktop Vault keys are duplicated"));
        }
        let mut vaults = Vec::with_capacity(self.vaults.len());
        for cached in self.vaults {
            if hidden_vault_ids.contains(&cached.id) {
                continue;
            }
            let key = by_id
                .get(cached.id.as_str())
                .ok_or_else(|| invalid("Legacy Desktop cached Vault has no retained Vault key"))?;
            if cached.name != key.vault_name
                || cached.vault_type != key.vault_type
                || cached.icon != key.vault_icon
                || cached.image_url != key.vault_image_url
            {
                return Err(invalid(
                    "Legacy Desktop cached Vault disagrees with retained Vault key",
                ));
            }
            vaults.push(AuthorityVaultRecord {
                id: cached.id,
                name: cached.name,
                vault_type: match cached.vault_type {
                    VaultType::Personal => AuthorityVaultType::Personal,
                    VaultType::Team => AuthorityVaultType::Team,
                },
                icon: cached.icon,
                image_url: cached.image_url,
                encrypted_vault_key: key.encrypted_vault_key.clone(),
                key_version: None,
                role: match key.role {
                    VaultRole::Owner => AuthorityVaultRole::Owner,
                    VaultRole::Admin => AuthorityVaultRole::Admin,
                    VaultRole::Member => AuthorityVaultRole::Member,
                    VaultRole::ReadOnly => AuthorityVaultRole::ReadOnly,
                },
            });
        }
        let origin = LegacyAdmissionOrigin {
            manifest_entries_sha256,
            account_id: self.account_id,
            user_id: self.user_id,
            incarnation,
            normalized_server_url: self.normalized_server_url,
            source_active_generation: self.source_active_generation,
            state_key: self.state_key,
            items_key_prefix: self.items_key_prefix,
            vaults_key_prefix: self.vaults_key_prefix,
            items_primed: self.items_primed,
            vaults_primed: self.vaults_primed,
            metadata: self.metadata,
            source_id: self.source_id,
            sync_baseline: self.sync_baseline,
            last_sync_cursor: self.last_sync_cursor,
            refresh_reason: (!failures.is_empty())
                .then_some(LegacyAdmissionRefreshReason::CapturedFailedCreate),
        };
        let cursor = admitted_cursor(&origin);
        Ok(BoundCache {
            bootstrap: LegacyAdmissionBootstrap {
                origin,
                cursor,
                vaults,
                items,
            },
            failures,
        })
    }
}

fn admitted_cursor(origin: &LegacyAdmissionOrigin) -> SyncCursor {
    if origin.refresh_reason.is_some() {
        return SyncCursor::Cold;
    }
    let Some(metadata) = &origin.metadata else {
        return SyncCursor::Cold;
    };
    let Some(cache) = &metadata.sync_baseline else {
        return SyncCursor::Cold;
    };
    if cache.normalized_server_url != origin.normalized_server_url {
        return SyncCursor::Cold;
    }
    let sync = checkpoint_cursor(&origin.sync_baseline);
    if sync.as_ref() != Some(&cache.cursor) {
        return SyncCursor::Cold;
    }
    if let Some(last) = checkpoint_cursor(&origin.last_sync_cursor) {
        if last != cache.cursor {
            return SyncCursor::Cold;
        }
    }
    cache.cursor.clone()
}

fn checkpoint_cursor(value: &LegacyCheckpointEvidence) -> Option<SyncCursor> {
    match value {
        LegacyCheckpointEvidence::Missing {} => None,
        LegacyCheckpointEvidence::CapturedEmpty {} => Some(SyncCursor::CapturedEmpty),
        LegacyCheckpointEvidence::CapturedValue { id } => {
            Some(SyncCursor::CapturedValue { id: id.clone() })
        }
    }
}

#[derive(serde::Serialize, Deserialize)]
#[serde(remote = "Self", rename_all = "camelCase", deny_unknown_fields)]
struct NativeCacheView {
    v: u32,
    items_key_prefix: String,
    vaults_key_prefix: String,
}

#[derive(serde::Serialize, Deserialize)]
#[serde(remote = "Self", rename_all = "camelCase", deny_unknown_fields)]
struct CacheState {
    v: u32,
    items_primed: bool,
    vaults_primed: bool,
    #[serde(deserialize_with = "required_nullable")]
    metadata: Option<CacheMetadata>,
    #[serde(deserialize_with = "required_nullable")]
    active_generation: Option<String>,
    native_view: NativeCacheView,
}

#[derive(serde::Serialize, Deserialize)]
#[serde(remote = "Self", rename_all = "camelCase", deny_unknown_fields)]
struct CacheMetadata {
    last_full_sync_at: u64,
    item_count: u64,
    cache_version: u64,
    #[serde(default, deserialize_with = "present")]
    sync_baseline: Option<CacheBaseline>,
}

#[derive(serde::Serialize, Deserialize)]
#[serde(remote = "Self", rename_all = "camelCase", deny_unknown_fields)]
struct CacheBaseline {
    server_url: String,
    #[serde(deserialize_with = "required_nullable")]
    cursor_id: Option<String>,
}

#[derive(serde::Serialize, Deserialize)]
#[serde(remote = "Self", rename_all = "camelCase", deny_unknown_fields)]
struct SyncBaseline {
    initialized: bool,
    #[serde(deserialize_with = "required_nullable")]
    cursor: Option<StoredCursor>,
}

#[derive(serde::Serialize, Deserialize)]
#[serde(remote = "Self", deny_unknown_fields)]
struct StoredCursor {
    id: String,
}

#[derive(serde::Serialize, Deserialize)]
#[serde(remote = "Self", rename_all = "camelCase", deny_unknown_fields)]
struct CachedVault {
    id: String,
    name: String,
    #[serde(rename = "type")]
    vault_type: VaultType,
    #[serde(deserialize_with = "required_nullable")]
    icon: Option<String>,
    #[serde(deserialize_with = "required_nullable")]
    image_url: Option<String>,
    #[serde(default, deserialize_with = "present")]
    account_id: Option<String>,
    #[serde(default, deserialize_with = "present")]
    account_email: Option<String>,
    #[serde(default, deserialize_with = "present")]
    server_url: Option<String>,
}

#[derive(serde::Serialize, Deserialize)]
#[serde(remote = "Self", rename_all = "camelCase", deny_unknown_fields)]
struct OptimisticFailure {
    operation_id: String,
    code: LegacyCreateFailureCode,
}

#[derive(serde::Serialize, Deserialize)]
#[serde(remote = "Self", rename_all = "camelCase", deny_unknown_fields)]
struct CachedItem {
    id: String,
    vault_id: String,
    category: ItemCategory,
    favorite: bool,
    encrypted_data: String,
    encryption_iv: String,
    encryption_algorithm: String,
    version: i32,
    encryption_version: i32,
    encrypted_by_user_id: String,
    last_modified_by: String,
    created_at: String,
    updated_at: String,
    #[serde(deserialize_with = "required_nullable")]
    deleted_at: Option<String>,
    #[serde(default, deserialize_with = "present")]
    attachments: Option<Vec<Object<VaultAttachmentResponse>>>,
    #[serde(default, deserialize_with = "present")]
    account_id: Option<String>,
    #[serde(default, deserialize_with = "present")]
    account_email: Option<String>,
    #[serde(default, deserialize_with = "present")]
    server_url: Option<String>,
    #[serde(default, deserialize_with = "present")]
    optimistic_failure: Option<OptimisticFailure>,
}

impl CachedItem {
    fn authority(self) -> Result<AuthorityItemRecord, RuntimeError> {
        let attachments = self
            .attachments
            .unwrap_or_default()
            .into_iter()
            .map(|Object(value)| {
                if value.id.is_empty()
                    || value.item_id != self.id
                    || value.vault_id != self.vault_id
                    || value.envelope_version <= 0
                    || value.file_size < 0
                {
                    return Err(invalid(
                        "Legacy Desktop cached Attachment identity is malformed",
                    ));
                }
                Ok(AuthorityAttachmentRecord {
                    id: value.id,
                    item_id: value.item_id,
                    vault_id: value.vault_id,
                    storage_key: value.storage_key,
                    encrypted_name: value.encrypted_name,
                    encryption_iv: value.encryption_iv,
                    encryption_algorithm: value.encryption_algorithm,
                    encrypted_attachment_key: value.encrypted_attachment_key,
                    attachment_key_iv: value.attachment_key_iv,
                    attachment_key_algorithm: value.attachment_key_algorithm,
                    encrypted_content_type: value.encrypted_content_type,
                    encrypted_content_type_iv: value.encrypted_content_type_iv,
                    envelope_version: value.envelope_version,
                    file_size: value.file_size,
                    uploaded_by: value.uploaded_by,
                    created_at: value.created_at,
                })
            })
            .collect::<Result<Vec<_>, _>>()?;
        Ok(AuthorityItemRecord {
            id: self.id,
            vault_id: self.vault_id,
            category: self.category.into(),
            favorite: self.favorite,
            encrypted_data: self.encrypted_data,
            encryption_iv: self.encryption_iv,
            encryption_algorithm: self.encryption_algorithm,
            version: self.version,
            encryption_version: self.encryption_version,
            encrypted_by_user_id: self.encrypted_by_user_id,
            last_modified_by: self.last_modified_by,
            created_at: self.created_at,
            updated_at: self.updated_at,
            deleted_at: self.deleted_at,
            attachments,
        })
    }
}

crate::wire::map_only_serde!(
    NativeCacheView,
    CacheState,
    CacheMetadata,
    CacheBaseline,
    SyncBaseline,
    StoredCursor,
    CachedVault,
    CachedItem,
    OptimisticFailure,
);

fn required_nullable<'de, D, T>(decoder: D) -> Result<Option<T>, D::Error>
where
    D: Deserializer<'de>,
    T: Deserialize<'de>,
{
    Option::<T>::deserialize(decoder)
}

fn present<'de, D, T>(decoder: D) -> Result<Option<T>, D::Error>
where
    D: Deserializer<'de>,
    T: Deserialize<'de>,
{
    T::deserialize(decoder).map(Some)
}

fn json<T: for<'de> Deserialize<'de>>(
    value: &str,
    message: &'static str,
) -> Result<T, RuntimeError> {
    serde_json::from_str(value).map_err(|_| invalid(message))
}

fn encode_component(value: &str) -> String {
    let mut encoded = String::new();
    for byte in value.bytes() {
        if byte.is_ascii_alphanumeric()
            || matches!(
                byte,
                b'-' | b'_' | b'.' | b'!' | b'~' | b'*' | b'\'' | b'(' | b')'
            )
        {
            encoded.push(char::from(byte));
        } else {
            use std::fmt::Write;
            write!(&mut encoded, "%{byte:02X}").expect("writing to String cannot fail");
        }
    }
    encoded
}

fn checkpoint(
    values: &mut BTreeMap<String, SecretString>,
    key: String,
    baseline: bool,
) -> Result<LegacyCheckpointEvidence, RuntimeError> {
    let Some(raw) = values.remove(&key) else {
        return Ok(LegacyCheckpointEvidence::Missing {});
    };
    if baseline {
        let value: SyncBaseline = json(&raw, "Legacy Desktop Sync baseline is malformed")?;
        if !value.initialized {
            return Err(invalid("Legacy Desktop Sync baseline is malformed"));
        }
        Ok(match value.cursor {
            None => LegacyCheckpointEvidence::CapturedEmpty {},
            Some(cursor) if !cursor.id.is_empty() => {
                LegacyCheckpointEvidence::CapturedValue { id: cursor.id }
            }
            _ => return Err(invalid("Legacy Desktop Sync baseline is malformed")),
        })
    } else {
        let value: StoredCursor = json(&raw, "Legacy Desktop Sync Cursor is malformed")?;
        if value.id.is_empty() {
            return Err(invalid("Legacy Desktop Sync Cursor is malformed"));
        }
        Ok(LegacyCheckpointEvidence::CapturedValue { id: value.id })
    }
}

// Account and record IDs are opaque, so every possible stage-key ownership must be considered.
// Only the producer's generation token is colon-free. The record ID is the entire suffix.
fn stage_partitions(key: &str) -> Vec<(&str, &str, &'static str, &str)> {
    let Some(suffix) = key.strip_prefix("record:item-cache-stage:") else {
        return Vec::new();
    };
    let mut partitions = Vec::new();
    for (account_end, _) in suffix.match_indices(':') {
        let account = &suffix[..account_end];
        let Some((generation, tail)) = suffix[account_end + 1..].split_once(':') else {
            continue;
        };
        if account.is_empty() || generation.is_empty() {
            continue;
        }
        for kind in ["items", "vaults", "item-baseline", "vault-baseline"] {
            if let Some(id) = tail
                .strip_prefix(kind)
                .and_then(|rest| rest.strip_prefix(':'))
            {
                if !id.is_empty() {
                    partitions.push((account, generation, kind, id));
                }
            }
        }
    }
    partitions
}

pub(super) fn decode<F>(
    normalize_server: F,
    store: &mut BTreeMap<String, SecretString>,
    sync: &mut BTreeMap<String, SecretString>,
    accounts: &[AccountIdentity<'_>],
) -> Result<BTreeMap<String, DecodedCache>, RuntimeError>
where
    F: Fn(&str, bool) -> Result<String, RuntimeError>,
{
    let mut decoded = BTreeMap::new();
    let mut consumed_prefixes = HashSet::new();
    let captured_stage_keys = store
        .keys()
        .filter(|key| key.starts_with("record:item-cache-stage:"))
        .cloned()
        .collect::<Vec<_>>();
    // Keep only this bounded capture's validated original active bytes. SecretString erases the
    // temporary copy when decoding ends; no stage row becomes authority or durable metadata.
    let mut active_raw = BTreeMap::<String, (SecretString, String, bool)>::new();
    // Opaque Account IDs may contain `:`. Consume the longest Account identity first so one
    // valid collection prefix cannot capture a more specific Account's records.
    let mut ordered_accounts = accounts.iter().collect::<Vec<_>>();
    ordered_accounts.sort_by(|left, right| {
        right
            .account_id
            .len()
            .cmp(&left.account_id.len())
            .then_with(|| left.account_id.as_bytes().cmp(right.account_id.as_bytes()))
    });
    for account in ordered_accounts {
        let state_key = format!("record:{}:meta:meta", account.account_id);
        let Some(raw_state) = store.remove(&state_key) else {
            continue;
        };
        let state: CacheState = json(&raw_state, "Legacy Desktop ItemCache state is malformed")?;
        if state.v != 2 || state.native_view.v != 1 {
            return Err(invalid("Legacy Desktop ItemCache version is unsupported"));
        }
        if state
            .active_generation
            .as_ref()
            .is_some_and(|generation| generation.is_empty())
        {
            return Err(invalid("Legacy Desktop ItemCache generation is malformed"));
        }
        let (items_prefix, vaults_prefix) = match &state.active_generation {
            Some(generation) => (
                format!(
                    "record:item-cache-stage:{}:{generation}:items:",
                    account.account_id
                ),
                format!(
                    "record:item-cache-stage:{}:{generation}:vaults:",
                    account.account_id
                ),
            ),
            None => (
                format!("record:{}:items:", account.account_id),
                format!("record:{}:vaults:", account.account_id),
            ),
        };
        if state.native_view.items_key_prefix != items_prefix
            || state.native_view.vaults_key_prefix != vaults_prefix
            || !consumed_prefixes.insert(items_prefix.clone())
            || !consumed_prefixes.insert(vaults_prefix.clone())
        {
            return Err(invalid(
                "Legacy Desktop ItemCache native view is inconsistent",
            ));
        }
        let mut items = Vec::new();
        let mut vaults = Vec::new();
        let keys = store.keys().cloned().collect::<Vec<_>>();
        for key in keys {
            let (prefix, kind) = if key.starts_with(&items_prefix) {
                (&items_prefix, "item")
            } else if key.starts_with(&vaults_prefix) {
                (&vaults_prefix, "vault")
            } else {
                continue;
            };
            let record_id = key
                .strip_prefix(prefix)
                .filter(|id| !id.is_empty())
                .ok_or_else(|| invalid("Legacy Desktop ItemCache record key is malformed"))?;
            let raw = store
                .remove(&key)
                .expect("captured ItemCache key remains until consumed");
            if kind == "item" {
                let value: CachedItem = json(&raw, "Legacy Desktop cached Item is malformed")?;
                if value.id != record_id
                    || value.id.is_empty()
                    || value.vault_id.is_empty()
                    || value.version <= 0
                    || value.encryption_version <= 0
                    || value
                        .account_id
                        .as_deref()
                        .is_some_and(|id| id != account.account_id)
                    || value
                        .account_email
                        .as_deref()
                        .is_some_and(|email| email != account.email)
                    || value
                        .server_url
                        .as_deref()
                        .map(|url| {
                            normalize_server(url, account.insecure_transport_confirmed)
                                .map(|normalized| normalized != account.normalized_server_url)
                        })
                        .transpose()?
                        .unwrap_or(false)
                {
                    return Err(invalid(
                        "Legacy Desktop cached Item identity is inconsistent",
                    ));
                }
                active_raw.insert(
                    key,
                    (
                        SecretString::from(raw.as_ref().to_owned()),
                        account.account_id.to_owned(),
                        value.account_id.as_deref() == Some(account.account_id),
                    ),
                );
                items.push(value);
            } else {
                let value: CachedVault = json(&raw, "Legacy Desktop cached Vault is malformed")?;
                if value.id != record_id
                    || value.id.is_empty()
                    || value
                        .account_id
                        .as_deref()
                        .is_some_and(|id| id != account.account_id)
                    || value
                        .account_email
                        .as_deref()
                        .is_some_and(|email| email != account.email)
                    || value
                        .server_url
                        .as_deref()
                        .map(|url| {
                            normalize_server(url, account.insecure_transport_confirmed)
                                .map(|normalized| normalized != account.normalized_server_url)
                        })
                        .transpose()?
                        .unwrap_or(false)
                {
                    return Err(invalid(
                        "Legacy Desktop cached Vault identity is inconsistent",
                    ));
                }
                active_raw.insert(
                    key,
                    (
                        SecretString::from(raw.as_ref().to_owned()),
                        account.account_id.to_owned(),
                        value.account_id.as_deref() == Some(account.account_id),
                    ),
                );
                vaults.push(value);
            }
        }
        items.sort_by(|left, right| left.id.as_bytes().cmp(right.id.as_bytes()));
        vaults.sort_by(|left, right| left.id.as_bytes().cmp(right.id.as_bytes()));
        if items.windows(2).any(|pair| pair[0].id == pair[1].id)
            || vaults.windows(2).any(|pair| pair[0].id == pair[1].id)
        {
            return Err(invalid("Legacy Desktop ItemCache identity is duplicated"));
        }
        let metadata = state
            .metadata
            .map(|metadata| {
                if metadata.last_full_sync_at > MAX_SAFE_INTEGER
                    || metadata.item_count > MAX_SAFE_INTEGER
                    || metadata.cache_version > MAX_SAFE_INTEGER
                {
                    return Err(invalid("Legacy Desktop ItemCache metadata is malformed"));
                }
                let sync_baseline = metadata
                    .sync_baseline
                    .map(|baseline| {
                        let normalized_server_url = normalize_server(
                            &baseline.server_url,
                            account.insecure_transport_confirmed,
                        )?;
                        if normalized_server_url != account.normalized_server_url
                            || baseline.cursor_id.as_ref().is_some_and(String::is_empty)
                        {
                            return Err(invalid(
                                "Legacy Desktop ItemCache baseline identity is inconsistent",
                            ));
                        }
                        Ok(LegacyItemCacheBaseline {
                            server_url: baseline.server_url,
                            normalized_server_url,
                            cursor: match baseline.cursor_id {
                                None => SyncCursor::CapturedEmpty,
                                Some(id) => SyncCursor::CapturedValue { id },
                            },
                        })
                    })
                    .transpose()?;
                Ok(LegacyItemCacheMetadata {
                    last_full_sync_at: metadata.last_full_sync_at,
                    item_count: metadata.item_count,
                    cache_version: metadata.cache_version,
                    sync_baseline,
                })
            })
            .transpose()?;
        let source_id = legacy_sync_source_id(account.account_id, account.normalized_server_url);
        let prefix = format!("sync_source_{}:", encode_component(&source_id));
        let sync_baseline = checkpoint(sync, format!("{prefix}syncBaselineV1"), true)?;
        let last_sync_cursor = checkpoint(sync, format!("{prefix}lastSyncCursor"), false)?;
        decoded.insert(
            account.account_id.to_owned(),
            DecodedCache {
                account_id: AccountId::from(account.account_id.to_owned()),
                user_id: account.user_id.to_owned(),
                normalized_server_url: account.normalized_server_url.to_owned(),
                source_active_generation: state.active_generation,
                state_key,
                items_key_prefix: items_prefix,
                vaults_key_prefix: vaults_prefix,
                items_primed: state.items_primed,
                vaults_primed: state.vaults_primed,
                metadata,
                source_id,
                sync_baseline,
                last_sync_cursor,
                vaults,
                items,
            },
        );
    }
    if !captured_stage_keys.is_empty() {
        let mut pending_generations = BTreeMap::<String, String>::new();
        let mut proven_duplicates = Vec::new();
        for key in captured_stage_keys {
            let partitions = stage_partitions(&key);
            if let Some(raw_stage) = store.get(&key) {
                if partitions.len() != 1 {
                    return Err(invalid("Legacy Desktop staged ItemCache key is ambiguous"));
                }
                let (account_id, generation, kind, record_id) = partitions[0];
                let cache = decoded
                    .get(account_id)
                    .ok_or_else(|| invalid("Legacy Desktop staged ItemCache Account is unknown"))?;
                if cache.source_active_generation.as_deref() == Some(generation)
                    || key.starts_with(&cache.items_key_prefix)
                    || key.starts_with(&cache.vaults_key_prefix)
                {
                    return Err(invalid(
                        "Legacy Desktop staged ItemCache overlaps active authority",
                    ));
                }
                let active_prefix = if kind == "items" || kind == "item-baseline" {
                    &cache.items_key_prefix
                } else {
                    &cache.vaults_key_prefix
                };
                let active_key = format!("{active_prefix}{record_id}");
                let Some((raw_active, owner, explicitly_scoped)) = active_raw.get(&active_key)
                else {
                    return Err(invalid(
                        "Legacy Desktop staged ItemCache has no active counterpart",
                    ));
                };
                if owner != account_id
                    || !explicitly_scoped
                    || raw_stage.as_ref() != raw_active.as_ref()
                {
                    return Err(invalid(
                        "Legacy Desktop staged ItemCache differs from active authority",
                    ));
                }
                if let Some(previous) =
                    pending_generations.insert(account_id.to_owned(), generation.to_owned())
                {
                    if previous != generation {
                        return Err(invalid(
                            "Legacy Desktop ItemCache has multiple staged generations",
                        ));
                    }
                }
                proven_duplicates.push(key);
            } else if let Some((_, owner, _)) = active_raw.get(&key) {
                // Active-prefix consumption cannot hide a second syntactic stage owner.
                let cache = decoded
                    .get(owner)
                    .expect("validated active Account was decoded");
                // A null-generation Account can have an older plain active prefix that starts
                // with `record:item-cache-stage:`. Keep its already-validated active-only row
                // when the physical key has no valid stage interpretation at all.
                if partitions.is_empty() && cache.source_active_generation.is_none() {
                    continue;
                }
                let kind = if key.starts_with(&cache.items_key_prefix) {
                    "items"
                } else {
                    "vaults"
                };
                if partitions.len() != 1
                    || partitions[0].0 != owner
                    || cache.source_active_generation.as_deref() != Some(partitions[0].1)
                    || partitions[0].2 != kind
                {
                    return Err(invalid(
                        "Legacy Desktop staged ItemCache overlaps active authority",
                    ));
                }
            } else if !partitions.is_empty() {
                // State-key consumption is not authority to hide a syntactic stage row either.
                return Err(invalid(
                    "Legacy Desktop staged ItemCache overlaps accepted Account state",
                ));
            }
        }
        for key in proven_duplicates {
            store.remove(&key);
        }
    }
    Ok(decoded)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn strings(values: &[(&str, String)]) -> BTreeMap<String, SecretString> {
        values
            .iter()
            .map(|(key, value)| ((*key).to_owned(), SecretString::from(value.clone())))
            .collect()
    }

    #[test]
    fn exact_null_generation_and_matching_checkpoint_decode() {
        let state = serde_json::json!({
            "v": 2,
            "itemsPrimed": true,
            "vaultsPrimed": true,
            "metadata": {
                "lastFullSyncAt": 1,
                "itemCount": 0,
                "cacheVersion": 1,
                "syncBaseline": { "serverUrl": "https://example.test/", "cursorId": "evt-1" }
            },
            "activeGeneration": null,
            "nativeView": {
                "v": 1,
                "itemsKeyPrefix": "record:acct:items:",
                "vaultsKeyPrefix": "record:acct:vaults:"
            }
        })
        .to_string();
        let source = legacy_sync_source_id("acct", "https://example.test");
        let sync_prefix = format!("sync_source_{}:", encode_component(&source));
        let mut store = strings(&[("record:acct:meta:meta", state)]);
        let mut sync = strings(&[
            (
                &format!("{sync_prefix}syncBaselineV1"),
                r#"{"initialized":true,"cursor":{"id":"evt-1"}}"#.into(),
            ),
            (
                &format!("{sync_prefix}lastSyncCursor"),
                r#"{"id":"evt-1"}"#.into(),
            ),
        ]);
        let decoded = decode(
            |value, _| Ok(value.trim_end_matches('/').to_owned()),
            &mut store,
            &mut sync,
            &[AccountIdentity {
                account_id: "acct",
                user_id: "user",
                email: "person@example.test",
                normalized_server_url: "https://example.test",
                insecure_transport_confirmed: false,
            }],
        )
        .expect("strict cache should decode");
        let plan = decoded
            .into_values()
            .next()
            .unwrap()
            .bind(
                Incarnation::from("inc".to_owned()),
                "ab".repeat(32),
                Some(&[]),
                &[],
            )
            .expect("empty cache does not need Vault keys");
        assert_eq!(
            plan.bootstrap.cursor,
            SyncCursor::CapturedValue { id: "evt-1".into() }
        );
        assert!(plan.bootstrap.origin.source_active_generation.is_none());
        assert!(store.is_empty());
        assert!(sync.is_empty());
    }

    #[test]
    fn mismatched_native_view_and_unknown_cache_shapes_fail_closed() {
        let state = serde_json::json!({
            "v": 2, "itemsPrimed": false, "vaultsPrimed": false, "metadata": null,
            "activeGeneration": "g", "nativeView": { "v": 1,
                "itemsKeyPrefix": "record:acct:items:", "vaultsKeyPrefix": "record:acct:vaults:" }
        })
        .to_string();
        let mut store = strings(&[("record:acct:meta:meta", state)]);
        assert!(decode(
            |value, _| Ok(value.trim_end_matches('/').to_owned()),
            &mut store,
            &mut BTreeMap::new(),
            &[AccountIdentity {
                account_id: "acct",
                user_id: "user",
                email: "person@example.test",
                normalized_server_url: "https://example.test",
                insecure_transport_confirmed: false
            }]
        )
        .is_err());
    }
}

#[cfg(test)]
#[path = "cache_duplicate_tests.rs"]
mod duplicate_tests;
